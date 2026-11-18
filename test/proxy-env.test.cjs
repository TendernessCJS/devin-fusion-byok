'use strict';

// R0 structural guardrail for managed agent env under an HTTP proxy (F3/R4).
// When the user configures `http.proxy`, enable() writes NO_PROXY with loopback
// exemptions into the managed devin-cli agent environment so the CLI can still
// reach the local backend and language-server bridge; clearing the proxy
// restores the user's previous value through the receipt flow.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSandboxLoader } = require('./helpers/sandbox.cjs');
const { createSettingsOwner } = require('../src/activation/settings-owner.cjs');
const { compileProxyPolicy } = require('../src/network/proxy-policy.cjs');

const filename = path.resolve(__dirname, '../src/activation/enable.cjs');
const PORT = 39842;

// Minimal installEnable fixture: every relative require that enable() touches
// is stubbed except owned-settings.cjs (it only writes a receipt file inside
// the temp root). No real backend, vscode, or user settings are involved.
function fixture(t, options = {}) {
  const httpConfig = { ...(options.httpConfig || {}) };
  const env = options.env || {};
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-proxy-env-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'storage');
  const extensionPath = path.join(directory, 'extension');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(extensionPath);
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ enabled: true }));

  const updates = [];
  const globals = { agentEnv: { 'devin-cli': { ...env } } };
  const pushed = [];
  const configListeners = [];
  const acpSettings = {
    inspect: key => ({ globalValue: globals[key] }),
    get: () => { throw new Error('Merged workspace settings must not be copied into global settings'); },
    update: async (key, value) => { globals[key] = value; updates.push(key); },
  };
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    workspace: {
      getConfiguration: section => section === 'http'
        ? { get: key => httpConfig[key],
            inspect: key => {
              const value = httpConfig[key];
              // A raw inspect shape may be handed in directly so fixtures can
              // exercise globalLocalValue/workspaceValue; plain values stand
              // for globalValue.
              if (value && typeof value === 'object' && !Array.isArray(value) &&
                  ('globalValue' in value || 'globalLocalValue' in value)) return value;
              return { globalValue: value };
            } }
        : acpSettings,
      onDidChangeConfiguration: listener => { configListeners.push(listener); return { dispose() {} }; },
    },
    extensions: { getExtension: () => options.remote ? null
      : ({ extensionPath: '/native', packageJSON: { main: 'main.js', version: 'test' } }) },
    env: options.remote ? { remoteName: 'ssh-remote' } : {},
    window: { showInformationMessage: () => {}, showWarningMessage: () => {}, showErrorMessage: () => {} },
  };
  const config = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const state = new Map();
  const context = {
    extensionPath,
    subscriptions: [],
    globalState: {
      get: (key, fallback) => state.has(key) ? state.get(key) : fallback,
      update: async (key, value) => value === undefined ? state.delete(key) : state.set(key, value),
    },
  };
  const catalogSync = {
    read: () => ({ models: [], allowedUids: new Set(), allowedMode: 'restricted', status: 'loading' }),
    observeModels: () => {}, observeAllowed: () => {}, refresh: async () => {},
    markUnsupported: () => {}, start: () => {}, stop: () => {},
  };

  // enable.cjs derives the managed env from runtime/port.cjs now, which loads
  // for real here (a leaf module with the same 39842 constant).
  const loader = createSandboxLoader({ filename, overrides: {
    '../runtime/host/ls-injection.cjs': { installLsInjection: async () => ({ dispose: async () => {} }) },
    '../runtime/bridge.cjs': { createLsBridge: async () => ({ port: 4567, close() {} }) },
    '../runtime/host/acp-observer.cjs': { installAcpObserver: () => ({ dispose() {} }) },
    '../runtime/host/proxy.cjs': { pushProxy: async ({ config: proxyConfig }) => {
      const entry = { config: proxyConfig, pendingUpdates: updates.length };
      pushed.push(entry);
      if (options.pushImpl) return options.pushImpl({ config: proxyConfig, call: pushed.length });
      return options.pushProxy ? options.pushProxy({ config: proxyConfig }) : { ok: true, ready: true };
    } },
    './backend-handshake.cjs': { ensureBackend: args => {
      if (options.ensureBackendImpl) return options.ensureBackendImpl(args);
      args.onCompatibleRuntime?.({ version: 'test' });
      return Promise.resolve();
    } },
  } });
  const makeSession = () => loader.module.exports.createRuntimeSession({
    root, extensionPath, subscriptions: context.subscriptions, config, configFile, vscode, context,
    nativeMain: '/native/main.js', log: () => {},
    catalog: () => ({ models: [] }), catalogSync,
    settingsOwner: createSettingsOwner({ root, extensionPath, vscode, globalState: context.globalState,
      isLive: () => true }),
    selection: { saveFusionChoice: async () => {}, reconcilePreference: async () => {}, reconcileSelection: async () => {} },
    continuation: { start: () => {}, suspend: () => {}, resetAutoContinue: () => {}, cancelAutoContinueSession: () => {},
      dispose: () => {}, autoContinueStatus: () => 'unavailable', goalController: () => undefined },
    onPublish: () => {} });
  let session = makeSession();
  t.after(() => loader.assertStubsUsed('proxy-env'));
  return { globals, session: () => session, setHttp: patch => Object.assign(httpConfig, patch), pushed, updates,
    configFile, configListeners,
    fireConfigChange: () => configListeners.forEach(listener => listener({ affectsConfiguration: () => true })),
    renew: async () => { await session.deactivate(); session = makeSession(); } };
}

test('without http.proxy the managed devin-cli env contains only WINDSURF_API_SERVER_URL', async t => {
  const f = fixture(t);
  await f.session().ensureEnabled();
  // The env object is built inside the sandbox realm; copy it across the
  // boundary before comparing against a test-realm literal.
  assert.deepEqual({ ...f.globals.agentEnv['devin-cli'] },
    { WINDSURF_API_SERVER_URL: `http://127.0.0.1:${PORT}` });
});

// R4 must add a loopback exemption when an HTTP proxy is configured: the
// managed env must carry NO_PROXY covering 127.0.0.1, localhost, and ::1 so
// devin-cli traffic to the local backend/bridge never leaves through the
// user's proxy.
test('with http.proxy configured the managed env exempts loopback via NO_PROXY', async t => {
  const f = fixture(t, { httpConfig: { proxy: 'http://127.0.0.1:7897', noProxy: [] } });
  await f.session().ensureEnabled();
  const env = f.globals.agentEnv['devin-cli'];
  assert.equal(env.WINDSURF_API_SERVER_URL, `http://127.0.0.1:${PORT}`);
  const noProxy = String(env.NO_PROXY || '').split(',').map(entry => entry.trim());
  for (const host of ['127.0.0.1', 'localhost', '::1']) assert.ok(noProxy.includes(host));
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost,::1');
});

test('clearing http.proxy restores the previous NO_PROXY value', async t => {
  const f = fixture(t, { httpConfig: { proxy: 'http://127.0.0.1:7897' }, env: { NO_PROXY: 'corp.example' } });
  await f.session().ensureEnabled();
  assert.equal(f.globals.agentEnv['devin-cli'].NO_PROXY, '127.0.0.1,localhost,::1');
  f.setHttp({ proxy: '' });
  await f.renew();
  await f.session().ensureEnabled();
  const env = f.globals.agentEnv['devin-cli'];
  assert.equal(env.NO_PROXY, 'corp.example');
  assert.equal(env.WINDSURF_API_SERVER_URL, `http://127.0.0.1:${PORT}`);
});

test('the first proxy push lands before any managed settings write', async t => {
  const f = fixture(t, { httpConfig: { proxy: 'http://127.0.0.1:7897' } });
  await f.session().ensureEnabled();
  assert.equal(f.pushed.length, 1);
  assert.equal(f.pushed[0].config.httpProxy, 'http://127.0.0.1:7897');
  assert.equal(f.pushed[0].pendingUpdates, 0, 'proxy sync precedes applyEnvironment');
});

test('a failed first proxy push aborts enable before env writes', async t => {
  const f = fixture(t, { pushProxy: async () => ({ ok: false, reason: 'unavailable' }) });
  await assert.rejects(f.session().ensureEnabled(), error => error?.code === 'proxy_unavailable');
  assert.equal(f.updates.length, 0, 'no managed settings were written');
});

test('config changes push each policy, and A→B→A never dedupes the second A', async t => {
  const f = fixture(t, { httpConfig: { proxy: 'http://127.0.0.1:1' } });
  await f.session().ensureEnabled();
  const wait = async count => { for (let i = 0; i < 50 && f.pushed.length < count; i++) await new Promise(r => setTimeout(r, 20)); };
  assert.equal(f.pushed.length, 1);
  f.setHttp({ proxy: 'http://127.0.0.1:2' });
  f.fireConfigChange();
  await wait(2);
  assert.equal(f.pushed.length, 2);
  assert.equal(f.pushed[1].config.httpProxy, 'http://127.0.0.1:2');
  f.setHttp({ proxy: 'http://127.0.0.1:1' });
  f.fireConfigChange();
  await wait(3);
  assert.equal(f.pushed.length, 3, 'the A→B→A sequence re-posts A instead of deduping it');
  assert.equal(f.pushed[2].config.httpProxy, 'http://127.0.0.1:1');
  f.fireConfigChange();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(f.pushed.length, 3, 'an unchanged config event dedupes');
});

// A deferred handshake models the real sequence: compatibleRuntime fires for
// the old instance, and the upgrade promise only resolves when the fresh
// backend is actually serving.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const until = async (check, label) => {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('timed out waiting for ' + label);
};

test('a proxy-ready compatible health releases early, and the new backend forces a second identical push', async t => {
  const gate = deferred();
  let compatibleHealth;
  const f = fixture(t, { ensureBackendImpl: ({ onCompatibleRuntime }) => {
    setImmediate(() => onCompatibleRuntime?.(compatibleHealth));
    return gate.promise;
  } });
  compatibleHealth = { version: 'test', proxyProtocol: 1, proxyReady: true };
  const enabling = f.session().ensureEnabled();
  await until(() => f.pushed.length === 1, 'first push on the old instance');
  // The replacement backend arrives cold: the dedupe key belongs to the old
  // instance, so an identical config still posts again.
  gate.resolve({ version: 'test' });
  await enabling;
  await until(() => f.pushed.length === 2, 'forced re-push onto the new instance');
  assert.equal(f.pushed[1].config.httpProxy, f.pushed[0].config.httpProxy);
});

test('an incompatible-protocol old backend does not release enable() before the upgrade finishes', async t => {
  const gate = deferred();
  const f = fixture(t, { ensureBackendImpl: ({ onCompatibleRuntime }) => {
    setImmediate(() => onCompatibleRuntime?.({ version: 'test', proxyProtocol: 0, proxyReady: false }));
    return gate.promise;
  } });
  const enabling = f.session().ensureEnabled();
  // The old instance keeps serving — nothing is pushed, nothing is written.
  await new Promise(r => setTimeout(r, 100));
  assert.equal(f.pushed.length, 0);
  assert.equal(f.updates.length, 0);
  gate.resolve({ version: 'test' });
  await enabling;
  await until(() => f.pushed.length >= 1, 'first sync after the real backend arrived');
  assert.ok(f.updates.length > 0, 'env writes only after the capable backend is up');
});

test('disable during an in-flight first push writes no env and installs no hooks', async t => {
  const gate = deferred();
  const f = fixture(t, { pushImpl: () => gate.promise });
  const enabling = f.session().ensureEnabled();
  await until(() => f.pushed.length === 1, 'push in flight');
  const disabling = f.session().deactivate();
  gate.resolve({ ok: true, ready: true });
  await disabling;
  await enabling;
  assert.equal(f.updates.length, 0, 'a late success must not write managed settings');
});

test('disable then re-enable never inherits the dedupe key', async t => {
  const f = fixture(t, { httpConfig: { proxy: 'http://127.0.0.1:5' } });
  await f.session().ensureEnabled();
  assert.equal(f.pushed.length, 1);
  await f.session().disable();
  // Re-enable the same session: the dedupe key is cleared at every enable()
  // start, so an identical config still posts to the (possibly new) backend.
  fs.writeFileSync(f.configFile, JSON.stringify({ enabled: true }));
  await f.session().ensureEnabled();
  await until(() => f.pushed.length >= 2, 're-enable pushes the same config again');
});

test('remote windows keep the proxy subscription hot', async t => {
  const f = fixture(t, { remote: true, httpConfig: { proxy: 'http://127.0.0.1:7' } });
  await f.session().ensureEnabled();
  await until(() => f.pushed.length === 1, 'remote first sync');
  f.setHttp({ proxy: 'http://127.0.0.1:8' });
  f.fireConfigChange();
  await until(() => f.pushed.length === 2, 'remote config change pushed');
  assert.equal(f.pushed[1].config.httpProxy, 'http://127.0.0.1:8');
});

test('a real string[] http.noProxy expands item-by-item and never reads the workspace value', async t => {
  const f = fixture(t, { httpConfig: {
    proxy: 'http://127.0.0.1:9',
    noProxy: { globalValue: ['localhost', '127.0.0.1', '::1', 'gf.com.cn'], workspaceValue: ['evil'] },
  } });
  await f.session().ensureEnabled();
  await until(() => f.pushed.length === 1, 'first sync');
  const { config } = f.pushed[0];
  assert.ok(config.noProxy.includes('gf.com.cn'));
  assert.ok(!config.noProxy.includes('evil'), 'workspace values must not leak into the managed policy');
  // The same compiled policy drives routing: gf.com.cn and its subdomains go
  // DIRECT; notgf.com.cn still uses the proxy.
  const { createForwardAgent } = require('../src/runtime/upstream-proxy.cjs');
  const policy = compileProxyPolicy(config);
  assert.equal(createForwardAgent(new URL('https://gf.com.cn/'), policy), null);
  assert.equal(createForwardAgent(new URL('https://api.gf.com.cn/'), policy), null);
  assert.ok(createForwardAgent(new URL('https://notgf.com.cn/'), policy) !== null);
});

test('globalLocalValue wins over globalValue; workspace values stay invisible', async t => {
  const f = fixture(t, { httpConfig: {
    proxy: { globalValue: 'http://global.invalid:1', globalLocalValue: 'http://local.invalid:2',
             workspaceValue: 'http://workspace.invalid:3' },
  } });
  await f.session().ensureEnabled();
  await until(() => f.pushed.length === 1, 'first sync');
  assert.equal(f.pushed[0].config.httpProxy, 'http://local.invalid:2');
});

for (const variant of ['failure', 'success']) {
  test(`a superseded first push resolving ${variant} cannot end enable; the newest sync decides`, async t => {
    const gates = [];
    const backendGate = deferred();
    const f = fixture(t, {
      ensureBackendImpl: ({ onCompatibleRuntime }) => {
        setImmediate(() => onCompatibleRuntime?.({ version: 't', proxyProtocol: 1, proxyReady: true }));
        return backendGate.promise;
      },
      pushImpl: () => { const g = deferred(); gates.push(g); return g.promise; },
    });
    const enabling = f.session().ensureEnabled();
    await until(() => gates.length === 1, 'initial push in flight');
    // The replacement backend lands mid-push: its forced sync supersedes the
    // first POST, so gate 2 only starts after gate 1 settles.
    backendGate.resolve({ version: 't' });
    await new Promise(r => setTimeout(r, 30));
    gates[0].resolve(variant === 'failure' ? { ok: false, reason: 'aborted' } : { ok: true, ready: true });
    await until(() => gates.length === 2, 'the forced second push runs');
    assert.equal(f.updates.length, 0, 'env must wait for the newest sync, not the first verdict');
    gates[1].resolve({ ok: true, ready: true });
    await enabling;
    await until(() => f.updates.length > 0, 'env writes after the newest sync succeeded');
  });
}

test('a late ensureBackend result after disable cannot flip backendStatus', async t => {
  const gate = deferred();
  const f = fixture(t, { ensureBackendImpl: () => gate.promise });
  const enabling = f.session().ensureEnabled();
  await f.session().disable();
  gate.resolve({ version: 't' }); // the late success belongs to the dead generation
  await enabling;
  await new Promise(r => setTimeout(r, 50));
  assert.notEqual(f.session().backendStatus(), 'running');
});

test('a superseded upgrade callback cannot overwrite a newer running generation', async t => {
  const first = deferred();
  const f = fixture(t, { ensureBackendImpl: ({ onCompatibleRuntime }) => {
    if (first.resolved) return first.promise;
    setImmediate(() => onCompatibleRuntime?.({ version: 't', proxyProtocol: 1, proxyReady: true }));
    return first.promise;
  } });
  await f.session().ensureEnabled();
  // Re-enable (new generation) while the first upgrade is still pending.
  const reenable = f.session().ensureEnabled();
  await reenable;
  // The stale upgrade finally resolves; its callback guards on the old
  // generation and must not touch status.
  first.resolve({ version: 't' });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(f.session().backendStatus(), 'running');
});

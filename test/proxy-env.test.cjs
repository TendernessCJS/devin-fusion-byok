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
const { readReceipt, saveReceipt } = require('../src/lifecycle/owned-settings.cjs');
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
    update: async (key, value) => {
      if (key === 'agentPreferences' && options.gatePreference) await options.gatePreference.promise;
      globals[key] = value; updates.push(key);
    },
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
    './remote-support.cjs': {
      discoverRemoteMain: () => null,
      describeError: () => ({ code: 'stub' }),
      probeRemoteSupport: () => Promise.resolve(),
      createRemoteSupport: () => ({
        start() { return Promise.resolve(); },
        stop() {},
        status: () => [],
        capabilities: () => ({ sshForward: true, tunnel: true }),
        ensureCurrentRemoteWindowTunnel() { return Promise.resolve(); },
      }),
    },
    './backend-handshake.cjs': { ensureBackend: args => {
      if (options.ensureBackendImpl) return options.ensureBackendImpl(args);
      args.onCompatibleRuntime?.({ version: 'test' });
      return Promise.resolve();
    } },
  } });
  // The proxy source falls back to the process environment; fixtures pin an
  // empty environment so an ambient HTTP_PROXY in the test shell cannot make a
  // "no proxy configured" case depend on the machine.
  const settingsOwner = createSettingsOwner({ root, extensionPath, vscode, globalState: context.globalState,
    isLive: () => true, env: options.processEnv ?? {} });
  const makeSession = () => loader.module.exports.createRuntimeSession({
    root, extensionPath, subscriptions: context.subscriptions, config, configFile, vscode, context,
    nativeMain: '/native/main.js', log: () => {}, env: options.processEnv ?? {},
    settingsOwner,
    catalog: () => ({ models: [] }), catalogSync,
    selection: { saveFusionChoice: async () => {}, reconcilePreference: async () => {}, reconcileSelection: async () => {} },
    continuation: { start: () => {}, suspend: () => {}, resetAutoContinue: () => {}, cancelAutoContinueSession: () => {},
      dispose: () => {}, autoContinueStatus: () => 'unavailable', goalController: () => undefined },
    onPublish: () => {} });
  let session = makeSession();
  session.prepareHostSupport();
  t.after(() => loader.assertStubsUsed('proxy-env'));
  return { globals, session: () => session, settingsOwner, setHttp: patch => Object.assign(httpConfig, patch), pushed, updates,
    configFile, configListeners,
    fireConfigChange: () => Promise.all(configListeners.map(listener => listener({ affectsConfiguration: () => true }))),
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
test('with http.proxy configured the managed env exempts loopback via both NO_PROXY spellings', async t => {
  const f = fixture(t, { httpConfig: { proxy: 'http://127.0.0.1:7897', noProxy: [] } });
  await f.session().ensureEnabled();
  const env = f.globals.agentEnv['devin-cli'];
  assert.equal(env.WINDSURF_API_SERVER_URL, `http://127.0.0.1:${PORT}`);
  const noProxy = String(env.NO_PROXY || '').split(',').map(entry => entry.trim());
  for (const host of ['127.0.0.1', 'localhost', '::1']) assert.ok(noProxy.includes(host));
  assert.equal(env.no_proxy, env.NO_PROXY, 'both spellings carry the same bypass list');
});

test('a proxy configured outside the extension keeps the user NO_PROXY entry while it is managed', async t => {
  const f = fixture(t, { httpConfig: { proxy: 'http://127.0.0.1:7897' }, env: { NO_PROXY: 'corp.example' } });
  await f.session().ensureEnabled();
  const managed = String(f.globals.agentEnv['devin-cli'].NO_PROXY).split(',').map(entry => entry.trim());
  assert.ok(managed.includes('corp.example'),
    'the entry the user configured is part of the bypass list, not replaced by loopback');
  for (const host of ['127.0.0.1', 'localhost', '::1']) assert.ok(managed.includes(host));
});

test('clearing http.proxy restores the previous NO_PROXY value', async t => {
  const f = fixture(t, { httpConfig: { proxy: 'http://127.0.0.1:7897' }, env: { NO_PROXY: 'corp.example' } });
  await f.session().ensureEnabled();
  f.setHttp({ proxy: '' });
  await f.renew();
  await f.session().ensureEnabled();
  const env = f.globals.agentEnv['devin-cli'];
  assert.equal(env.NO_PROXY, 'corp.example');
  assert.equal(env.no_proxy, undefined, 'the lowercase key the extension wrote is withdrawn again');
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

// --- settings-owner level: receipts, restore and the serialized transaction ---
//
// These drive createSettingsOwner directly: the enable() fixture above proves
// wiring, this one proves the managed-environment bookkeeping (originals,
// receipts and the queue) without a backend or an extension host.

function ownerFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-env-owner-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'storage'), extensionPath = path.join(directory, 'extension');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(extensionPath);
  const httpConfig = { ...(options.http || {}) };
  const settings = JSON.parse(JSON.stringify(options.settings || { agentEnv: { 'devin-cli': {} } }));
  const state = new Map(Object.entries(options.state || {}));
  const writes = [];
  let updateGate = null;
  const acp = {
    inspect: key => ({ globalValue: settings[key] }),
    get: () => { throw new Error('merged settings must never be read'); },
    update: async (key, value) => {
      if (updateGate) await updateGate.promise;
      settings[key] = value; writes.push(key);
    },
  };
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    workspace: {
      getConfiguration: section => section === 'http'
        ? { get: () => undefined, inspect: key => ({ globalValue: httpConfig[key] }) }
        : acp,
    },
  };
  const owner = createSettingsOwner({ root, extensionPath, vscode, isLive: () => true,
    env: options.processEnv ?? {},
    globalState: {
      get: (key, fallback) => state.has(key) ? state.get(key) : fallback,
      update: async (key, value) => { value === undefined ? state.delete(key) : state.set(key, value); },
    } });
  return {
    owner, settings, state, writes, root, extensionPath,
    cli: () => settings.agentEnv['devin-cli'] || {},
    setHttp: patch => Object.assign(httpConfig, patch),
    holdUpdates: () => { updateGate = deferred(); return updateGate; },
    releaseUpdates: () => { updateGate?.resolve(); updateGate = null; },
    receipt: () => readReceipt(root, extensionPath),
  };
}

test('both bypass spellings, the editor array and existing custom entries merge once', async t => {
  const f = ownerFixture(t, {
    http: { proxy: 'http://127.0.0.1:7897', noProxy: ['gf.com.cn', '127.0.0.1'] },
    settings: { agentEnv: { 'devin-cli': { NO_PROXY: 'corp.example,gf.com.cn', no_proxy: 'lower.example' },
      'other-agent': { KEEP: 'other' } } },
  });
  await f.owner.applyEnvironment();
  const cli = f.cli();
  const merged = String(cli.NO_PROXY).split(',').map(entry => entry.trim());
  assert.ok(merged.includes('gf.com.cn'));
  assert.ok(merged.includes('corp.example'));
  assert.ok(merged.includes('lower.example'));
  for (const host of ['127.0.0.1', 'localhost', '::1']) assert.ok(merged.includes(host));
  assert.equal(merged.filter(entry => entry.toLowerCase() === 'gf.com.cn').length, 1, 'case duplicates collapse');
  assert.equal(cli.no_proxy, cli.NO_PROXY);
  assert.deepEqual(f.settings.agentEnv['other-agent'], { KEEP: 'other' },
    'another agent entry is untouched');
  assert.equal(cli.WINDSURF_API_SERVER_URL, `http://127.0.0.1:${PORT}`);
});

test('a shrinking http.noProxy list does not accumulate the domains it dropped', async t => {
  const f = ownerFixture(t, { http: { proxy: 'http://127.0.0.1:7897', noProxy: ['gf.com.cn', 'old.example'] } });
  await f.owner.applyEnvironment();
  assert.ok(String(f.cli().NO_PROXY).includes('old.example'));
  f.setHttp({ noProxy: ['gf.com.cn'] });
  await f.owner.applyEnvironment();
  const managed = String(f.cli().NO_PROXY).split(',').map(entry => entry.trim());
  assert.ok(managed.includes('gf.com.cn'));
  assert.equal(managed.includes('old.example'), false,
    'the second sync rebuilds from the originals, not from the previous managed value');
  f.setHttp({ noProxy: [] });
  await f.owner.applyEnvironment();
  assert.equal(String(f.cli().NO_PROXY).includes('gf.com.cn'), false);
});

test('a legacy globalState-only backup still restores the original value', async t => {
  const f = ownerFixture(t, {
    http: { proxy: 'http://127.0.0.1:7897' },
    settings: { agentEnv: { 'devin-cli': { NO_PROXY: '127.0.0.1,localhost,::1', WINDSURF_API_SERVER_URL: `http://127.0.0.1:${PORT}` } } },
    state: { managedEnv: { NO_PROXY: '127.0.0.1,localhost,::1' }, savedEnv: { NO_PROXY: 'legacy.example' } },
  });
  await f.owner.applyEnvironment();
  assert.ok(String(f.cli().NO_PROXY).includes('legacy.example'), 'the legacy original is part of the bypass list');
  f.setHttp({ proxy: '' });
  await f.owner.applyEnvironment();
  assert.equal(f.cli().NO_PROXY, 'legacy.example');
});

test('a NO_PROXY the user edits during management is what a later restore puts back', async t => {
  const f = ownerFixture(t, { http: { proxy: 'http://127.0.0.1:7897' },
    settings: { agentEnv: { 'devin-cli': { NO_PROXY: 'corp.example' } } } });
  await f.owner.applyEnvironment();
  // The user replaces the managed value while the extension owns the key.
  f.settings.agentEnv['devin-cli'].NO_PROXY = 'user-new.example';
  await f.owner.applyEnvironment();
  assert.ok(String(f.cli().NO_PROXY).includes('user-new.example'));
  await f.owner.restore();
  assert.equal(f.cli().NO_PROXY, 'user-new.example',
    'the value the user typed is the original, not the one it replaced');
});

test('removing the proxy restores both original spellings and leaves other env keys alone', async t => {
  const f = ownerFixture(t, { http: { proxy: 'http://127.0.0.1:7897' },
    settings: { agentEnv: { 'devin-cli': { NO_PROXY: 'corp.example', no_proxy: 'lower.example', KEEP: 'keep' } } } });
  await f.owner.applyEnvironment();
  assert.equal(f.cli().no_proxy, f.cli().NO_PROXY);
  f.setHttp({ proxy: '' });
  await f.owner.applyEnvironment();
  assert.equal(f.cli().NO_PROXY, 'corp.example');
  assert.equal(f.cli().no_proxy, 'lower.example');
  assert.equal(f.cli().KEEP, 'keep');
  assert.equal(f.cli().WINDSURF_API_SERVER_URL, `http://127.0.0.1:${PORT}`);
});

test('a workspace-only proxy is never promoted into the managed environment', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-env-workspace-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'storage'), extensionPath = path.join(directory, 'extension');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(extensionPath);
  const settings = { agentEnv: { 'devin-cli': {} } };
  const writes = [];
  const vscode = { ConfigurationTarget: { Global: 1 },
    workspace: { getConfiguration: section => section === 'http'
      ? { get: () => 'http://workspace.invalid:1',
        inspect: key => ({ globalValue: undefined, workspaceValue: key === 'proxy' ? 'http://workspace.invalid:1' : undefined }) }
      : { inspect: key => ({ globalValue: settings[key] }), update: async (key, value) => { settings[key] = value; writes.push(key); } } } };
  const owner = createSettingsOwner({ root, extensionPath, vscode, isLive: () => true, env: {},
    globalState: { get: (key, fallback) => fallback, update: async () => {} } });
  await owner.applyEnvironment();
  assert.deepEqual({ ...settings.agentEnv['devin-cli'] }, { WINDSURF_API_SERVER_URL: `http://127.0.0.1:${PORT}` },
    'the workspace proxy stays a workspace concern');
});

test('an invalid policy leaves the receipt and the settings untouched', async t => {
  const f = ownerFixture(t, { http: { proxy: 'http://127.0.0.1:7897' },
    settings: { agentEnv: { 'devin-cli': { NO_PROXY: 'corp.example' } } } });
  await f.owner.applyEnvironment();
  const before = JSON.parse(JSON.stringify(f.settings));
  const receiptBefore = JSON.stringify(f.receipt().changes);
  f.setHttp({ proxy: 'socks5://127.0.0.1:9' });
  await assert.rejects(f.owner.applyEnvironment(), error => error.code === 'proxy_unavailable');
  assert.deepEqual(f.settings, before, 'no settings write happened');
  assert.equal(JSON.stringify(f.receipt().changes), receiptBefore, 'the receipt still describes what is live');
});

test('environment-derived proxies are honoured when no setting is configured', async t => {
  const f = ownerFixture(t, { processEnv: { HTTPS_PROXY: 'http://127.0.0.1:7897' } });
  await f.owner.applyEnvironment();
  assert.ok(String(f.cli().NO_PROXY).includes('localhost'), 'an env proxy also needs the loopback bypass');
  assert.equal(f.cli().no_proxy, f.cli().NO_PROXY);
});

test('a queued model write reads its snapshot after the environment transaction commits', async t => {
  const f = ownerFixture(t, { http: { proxy: 'http://127.0.0.1:7897' },
    settings: { agentEnv: { 'devin-cli': {} }, agentPreferences: { 'devin-cli': {} } } });
  const gate = f.holdUpdates();
  const environment = f.owner.applyEnvironment();
  const model = f.owner.saveModel('fusion-dfbyok-pick');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.writes, [], 'both writes wait for the gate');
  gate.resolve();
  await Promise.all([environment, model]);
  assert.deepEqual(f.writes, ['agentEnv', 'agentPreferences'], 'one at a time, in arrival order');
  const paths = f.receipt().changes.map(change => change.path.join('.'));
  assert.ok(paths.includes('devin.acp.agentEnv.devin-cli.NO_PROXY'));
  assert.ok(paths.includes('devin.acp.agentPreferences.devin-cli.model'));
  await f.owner.restore();
  assert.equal(f.cli().NO_PROXY, undefined, 'the environment original is restored');
  assert.equal(f.settings.agentPreferences['devin-cli'].model, undefined, 'and so is the model original');
});

test('a drain cancels a queued write and keeps the value the running one wrote', async t => {
  const f = ownerFixture(t, { http: { proxy: 'http://127.0.0.1:7897' },
    settings: { agentEnv: { 'devin-cli': {} }, agentPreferences: { 'devin-cli': {} } } });
  const gate = f.holdUpdates();
  const environment = f.owner.applyEnvironment();
  await new Promise(resolve => setImmediate(resolve));
  const model = f.owner.saveModel('fusion-dfbyok-late');
  const drained = f.owner.drainWrites();
  gate.resolve();
  await environment;
  await assert.rejects(model, error => error.code === 'cancelled');
  assert.equal(await drained, true);
  assert.equal(f.writes.includes('agentPreferences'), false, 'the queued write never landed');
  assert.equal(f.settings.agentPreferences['devin-cli'].model, undefined);
  f.owner.openWrites();
  await f.owner.saveModel('fusion-dfbyok-after');
  assert.equal(f.settings.agentPreferences['devin-cli'].model, 'fusion-dfbyok-after', 'a post-open write runs');
});

test('a user edit made mid-management is the original on every later restore', async t => {
  const f = ownerFixture(t, { http: { proxy: 'http://127.0.0.1:7897' },
    settings: { agentEnv: { 'devin-cli': { NO_PROXY: 'first.example' } } } });
  await f.owner.applyEnvironment();
  assert.ok(String(f.cli().NO_PROXY).includes('first.example'));
  f.settings.agentEnv['devin-cli'].NO_PROXY = 'second.example';
  await f.owner.applyEnvironment();
  assert.ok(String(f.cli().NO_PROXY).includes('second.example'));
  await f.owner.applyEnvironment();
  f.setHttp({ proxy: '' });
  await f.owner.applyEnvironment();
  assert.equal(f.cli().NO_PROXY, 'second.example', 'the newest user value survives repeated syncs');
  await f.owner.restore();
  assert.equal(f.cli().NO_PROXY, 'second.example');
});

test('without a receipt entry the legacy backup still carries the newest user value', async t => {
  const f = ownerFixture(t, { http: { proxy: 'http://127.0.0.1:7897' },
    settings: { agentEnv: { 'devin-cli': { NO_PROXY: 'first.example' } } } });
  await f.owner.applyEnvironment();
  f.settings.agentEnv['devin-cli'].NO_PROXY = 'second.example';
  await f.owner.applyEnvironment();
  // Drop the receipt record for NO_PROXY: only the globalState backup is left.
  const receipt = f.receipt();
  receipt.changes = receipt.changes.filter(change => change.path[2] !== 'NO_PROXY');
  saveReceipt(receipt);
  f.setHttp({ proxy: '' });
  await f.owner.applyEnvironment();
  assert.equal(f.cli().NO_PROXY, 'second.example',
    'the backup follows the latest explicit user edit, not the first one');
});

test('a receipt original that equals the managed value still wins over the backup', async t => {
  const f = ownerFixture(t, { http: { proxy: 'http://127.0.0.1:7897' },
    settings: { agentEnv: { 'devin-cli': { NO_PROXY: 'loopback-only.example' } } } });
  await f.owner.applyEnvironment();
  const managedValue = f.cli().NO_PROXY;
  // The user's own original happens to equal the managed string; the receipt
  // records that original explicitly.
  const receipt = f.receipt();
  const record = receipt.changes.find(change => change.path[2] === 'NO_PROXY');
  record.original = { exists: true, value: managedValue };
  saveReceipt(receipt);
  f.state.set('savedEnv', { ...f.state.get('savedEnv'), NO_PROXY: 'stale.example' });
  f.setHttp({ proxy: '' });
  await f.owner.applyEnvironment();
  assert.equal(f.cli().NO_PROXY, managedValue,
    'the receipt original is authoritative even when the stale backup differs');
});

// --- proxy hot changes flow into the managed environment ---
test('a hot proxy change rewrites the managed bypass once the backend accepts it', async t => {
  const f = fixture(t, { httpConfig: { proxy: 'http://127.0.0.1:7897', noProxy: ['first.example'] } });
  await f.session().ensureEnabled();
  assert.ok(String(f.globals.agentEnv['devin-cli'].NO_PROXY).includes('first.example'));
  f.setHttp({ noProxy: ['second.example'] });
  await f.fireConfigChange();
  const managed = String(f.globals.agentEnv['devin-cli'].NO_PROXY).split(',');
  assert.ok(managed.includes('second.example'), 'the new bypass is present after the accepted update');
  assert.equal(managed.includes('first.example'), false, 'the dropped domain never accumulates');
  assert.equal(f.globals.agentEnv['devin-cli'].no_proxy, f.globals.agentEnv['devin-cli'].NO_PROXY);
});

test('a hot proxy change the backend rejects leaves the managed environment alone', async t => {
  const f = fixture(t, { httpConfig: { proxy: 'http://127.0.0.1:7897' } });
  await f.session().ensureEnabled();
  const before = JSON.parse(JSON.stringify(f.globals.agentEnv['devin-cli']));
  f.setHttp({ proxy: 'socks5://127.0.0.1:9' });
  await f.fireConfigChange();
  assert.deepEqual({ ...f.globals.agentEnv['devin-cli'] }, before,
    'an unpushable policy never changes the CLI environment');
});

test('a hot policy the backend refuses does not change the managed environment', async t => {
  const f = fixture(t, { httpConfig: { proxy: 'http://127.0.0.1:7897', noProxy: ['kept.example'] },
    pushProxy: ({ config }) => config.httpProxy === 'http://127.0.0.1:7898'
      ? { ok: false, reason: 'invalid' } : { ok: true, ready: true } });
  await f.session().ensureEnabled();
  const before = JSON.parse(JSON.stringify(f.globals.agentEnv['devin-cli']));
  f.setHttp({ proxy: 'http://127.0.0.1:7898', noProxy: ['refused.example'] });
  await f.fireConfigChange();
  assert.equal(f.pushed.length, 2);
  assert.deepEqual({ ...f.globals.agentEnv['devin-cli'] }, before,
    'the environment keeps describing the last policy the backend accepted');
});

test('an accepted policy snapshot wins over a newer policy the backend refuses', async t => {
  // The queue is held open by a preference write so the first environment write
  // is still waiting when the second policy arrives. Without the snapshot the
  // queued write would re-read the newer (refused) config and land B.
  const gate = deferred();
  const f = fixture(t, {
    httpConfig: { proxy: 'http://127.0.0.1:7901', noProxy: ['accepted.example'] },
    gatePreference: gate,
    pushProxy: ({ config }) => config.httpProxy === 'http://127.0.0.1:7902'
      ? { ok: false, reason: 'invalid' } : { ok: true, ready: true },
  });
  await f.session().ensureEnabled();
  const blocker = f.settingsOwner.saveModel('fusion-dfbyok-blocker');
  await new Promise(resolve => setImmediate(resolve));
  f.setHttp({ proxy: 'http://127.0.0.1:7901', noProxy: ['accepted.example'] });
  const accepted = f.fireConfigChange();
  await new Promise(resolve => setImmediate(resolve));
  f.setHttp({ proxy: 'http://127.0.0.1:7902', noProxy: ['refused.example'] });
  const refused = f.fireConfigChange();
  await refused;
  gate.resolve();
  await Promise.all([blocker, accepted]);
  const managed = String(f.globals.agentEnv['devin-cli'].NO_PROXY).split(',');
  assert.ok(managed.includes('accepted.example'), 'the accepted snapshot is what the queue writes');
  assert.equal(managed.includes('refused.example'), false, 'the refused policy never reaches the environment');
});

test('a config edit after the closing sync still applies the accepted snapshot', async t => {
  const gate = deferred();
  const f = fixture(t, { httpConfig: { proxy: 'http://127.0.0.1:7903', noProxy: ['initial.example'] },
    gatePreference: gate });
  // Hold the queue with a preference write so the environment write of the
  // activation is still queued when the config changes underneath it.
  const blocker = f.settingsOwner.saveModel('fusion-dfbyok-blocker');
  await new Promise(resolve => setImmediate(resolve));
  const enabling = f.session().ensureEnabled();
  await until(() => f.pushed.length === 1, 'the activation pushed its policy');
  // The user edits http.noProxy; no event is delivered, so only the queued
  // activation write can be observed.
  f.setHttp({ noProxy: ['edited-after.example'] });
  gate.resolve();
  await Promise.all([blocker, enabling]);
  const managed = String(f.globals.agentEnv['devin-cli'].NO_PROXY).split(',');
  assert.ok(managed.includes('initial.example'));
  assert.equal(managed.includes('edited-after.example'), false,
    'the write uses the snapshot its operation settled on, not a fresh read');
});

test('a remote window also rewrites the managed environment on a hot change', async t => {
  const f = fixture(t, { remote: true, httpConfig: { proxy: 'http://127.0.0.1:7897', noProxy: ['remote-a.example'] } });
  await f.session().ensureEnabled();
  assert.ok(String(f.globals.agentEnv['devin-cli'].NO_PROXY).includes('remote-a.example'));
  f.setHttp({ noProxy: ['remote-b.example'] });
  await f.fireConfigChange();
  assert.ok(String(f.globals.agentEnv['devin-cli'].NO_PROXY).split(',').includes('remote-b.example'), 'the accepted remote bypass reaches the CLI environment');
});

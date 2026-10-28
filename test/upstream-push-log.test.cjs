'use strict';

// The backend's forward target follows the native `codeium.apiServerUrl`, pushed
// by enable.cjs through POST /_runtime/upstream. Both outcomes must be
// observable in the log — a silent success made "did the push happen?"
// unanswerable — and the log must never carry the configured host.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSandboxLoader } = require('./helpers/sandbox.cjs');
const { createManagedSettingsGate } = require('../src/activation/managed-settings.cjs');

const filename = path.resolve(__dirname, '../src/activation/enable.cjs');

// pushConfiguredUpstream is fire-and-forget (`void pushConfiguredUpstream(...)`),
// so the log line lands on a later microtask; drain a few macrotasks first.
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
}

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-upstream-push-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'storage');
  const extensionPath = path.join(directory, 'extension');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(extensionPath);
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ enabled: true }));

  const pushes = [];
  const signals = [];
  const resolvers = [];
  const logs = [];
  const handlers = [];
  const codeium = { apiServerUrl: options.apiServerUrl };
  const globals = { agentEnv: { 'devin-cli': {} } };
  const acpSettings = {
    inspect: key => ({ globalValue: globals[key] }),
    get: () => { throw new Error('Merged workspace settings must not be copied into global settings'); },
    update: async (key, value) => { globals[key] = value; },
  };
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    workspace: {
      getConfiguration: section => section === 'codeium'
        ? { get: key => codeium[key], inspect: key => ({ globalValue: codeium[key] }) }
        : section === 'http' ? { get: () => undefined, inspect: () => undefined } : acpSettings,
      onDidChangeConfiguration: handler => { handlers.push(handler); return { dispose() {} }; },
    },
    extensions: { getExtension: () => ({ extensionPath: '/native', packageJSON: { main: 'main.js', version: 'test' } }) },
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
  const lifecycle = { activationGeneration: 0, activationDisposed: false, connection: undefined };
  const shared = {
    reconcilePreference: async () => {},
    startNativeSync: () => {},
    observeNativeModels: () => {},
    pushToBackend: () => {},
    nativeAllowedUids: new Set(),
    management: undefined,
  };
  const deps = { lifecycle, config, configFile, vscode, context,
    // Log payloads are built inside the vm realm; re-owning them here keeps
    // deepStrictEqual comparisons against test-realm literals meaningful.
    log: (event, data) => logs.push({ event, data: data && typeof data === 'object' ? { ...data } : data }),
    catalog: () => ({ models: [] }), nativeMain: '/native/main.js', root, extensionPath,
    stores: { nativeCatalog: shared, cacheSync: shared, acpObservation: { seq: 0, ownModels: 0 } },
    createPublication: () => ({ observe() {}, changed: () => ({}), status: () => null, dispose() {} }),
    managedSettings: createManagedSettingsGate() };

  const effective = { current: options.effective || { origin: null, source: 'default' } };
  const loader = createSandboxLoader({ filename, overrides: {
    '../runtime/host/upstream.cjs': { pushUpstream: async ({ root: pushedRoot, origin, source, signal }) => {
      pushes.push({ root: pushedRoot, origin, source });
      signals.push(signal);
      if (options.pushImpl) return options.pushImpl({ origin, source, signal, call: pushes.length });
      return options.result || { ok: true, custom: origin != null };
    } },
    './effective-origin.cjs': { resolveEffectiveOriginWhenAvailable: options.deferResolve
      ? args => new Promise((resolve, reject) => { resolvers.push({ args, resolve, reject }); })
      : async () => effective.current },
    '../runtime/host/ls-injection.cjs': { installLsInjection: async () => ({ dispose: async () => {} }) },
    '../runtime/bridge.cjs': { createLsBridge: async () => ({ port: 4567, close() {} }) },
    '../runtime/host/acp-observer.cjs': { installAcpObserver: () => ({ dispose() {} }) },
    './backend-handshake.cjs': { ensureBackend: ({ onCompatibleRuntime }) => {
      onCompatibleRuntime?.({ version: 'test' });
      return Promise.resolve();
    } },
  } });
  loader.module.exports.installEnable({ deps, shared });
  t.after(() => loader.assertStubsUsed('upstream-push-log'));
  return { root, pushes, signals, resolvers, logs, handlers, lifecycle, codeium, shared, settle, effective, configFile,
    pushLogs: () => logs.filter(entry => entry.event === 'upstream-push') };
}

test('the effective LS-arg origin is pushed while a hand-written apiServerUrl is ignored', async t => {
  const f = fixture(t, { apiServerUrl: 'https://ignored.example.com', effective: { origin: 'https://custom.example.com/api', source: 'ls-arg' } });
  await f.shared.ensureEnabled();
  await f.settle();
  assert.deepEqual(f.pushes, [{ root: f.root, origin: 'https://custom.example.com/api', source: 'ls-arg' }]);
  // deepEqual on the whole payload also pins "no host, no origin, no token".
  assert.deepEqual(f.pushLogs(), [{ event: 'upstream-push', data: { ok: true, custom: true, source: 'ls-arg' } }]);
});

test('an unset apiServerUrl pushes null (backend keeps its default upstream)', async t => {
  const f = fixture(t, {});
  await f.shared.ensureEnabled();
  await f.settle();
  assert.equal(f.pushes.length, 1);
  assert.equal(f.pushes[0].origin, null);
  assert.deepEqual(f.pushLogs(), [{ event: 'upstream-push', data: { ok: true, custom: false, source: 'default' } }]);
});

test('a skipped push is logged with its reason', async t => {
  const f = fixture(t, { effective: { origin: 'https://custom.example.com', source: 'portal' }, result: { ok: false, reason: 'unsupported' } });
  await f.shared.ensureEnabled();
  await f.settle();
  assert.deepEqual(f.pushLogs(), [{ event: 'upstream-push', data: { ok: false, reason: 'unsupported', source: 'portal' } }]);
});

test('a failed push logs its detail enum when the backend reports one', async t => {
  const f = fixture(t, { effective: { origin: 'https://custom.example.com', source: 'ls-arg' }, result: { ok: false, reason: 'identity', detail: 'source' } });
  await f.shared.ensureEnabled();
  await f.settle();
  assert.deepEqual(f.pushLogs(), [{ event: 'upstream-push', data: { ok: false, reason: 'identity', detail: 'source', source: 'ls-arg' } }]);
});

test('a later configuration change re-pushes the re-resolved effective origin', async t => {
  const f = fixture(t, {});
  await f.shared.ensureEnabled();
  await f.settle();
  assert.equal(f.pushes.length, 1);
  assert.equal(f.handlers.length, 1);
  f.effective.current = { origin: 'https://custom.example.com', source: 'portal' };
  await f.handlers[0]({ affectsConfiguration: section => section === 'codeium.apiServerUrl' });
  await f.settle();
  assert.deepEqual(f.pushes.map(entry => entry.origin), [null, 'https://custom.example.com']);
  // An unrelated configuration event must not re-push.
  await f.handlers[0]({ affectsConfiguration: () => false });
  await f.settle();
  assert.equal(f.pushes.length, 2);
});

test('a repeated trigger resolving to the same origin sends no second POST', async t => {
  const f = fixture(t, { effective: { origin: 'https://custom.example.com', source: 'ls-arg' } });
  await f.shared.ensureEnabled();
  await f.settle();
  assert.equal(f.pushes.length, 1);
  await f.handlers[0]({ affectsConfiguration: section => section === 'windsurf.portalUrl' });
  await f.settle();
  assert.equal(f.pushes.length, 1, 'the same (origin, source) is deduplicated — no POST, no log');
  assert.equal(f.pushLogs().length, 1);
  f.effective.current = { origin: 'https://other.example.com', source: 'ls-arg' };
  await f.handlers[0]({ affectsConfiguration: section => section === 'windsurf.portalUrl' });
  await f.settle();
  assert.equal(f.pushes.length, 2, 'a changed origin always pushes');
});

async function until(fn, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (fn()) return; await new Promise(resolve => setImmediate(resolve)); }
  throw new Error('timed out waiting for ' + label);
}

test('a superseded resolution publishes nothing and the newer target wins', async t => {
  const f = fixture(t, { deferResolve: true });
  const enabling = f.shared.ensureEnabled();
  await until(() => f.resolvers.length === 1, 'first resolver');
  await enabling;
  assert.equal(f.handlers.length, 1);
  // The handler resolves with the push itself; resolver B is still pending, so
  // this must not be awaited before the deferred is released.
  void f.handlers[0]({ affectsConfiguration: name => name === 'devin.portalUrl' });
  await until(() => f.resolvers.length === 2, 'second resolver');
  f.resolvers[1].resolve({ origin: 'https://new.example.com', source: 'portal' });
  await until(() => f.pushes.length === 1, 'push from the newer resolver');
  assert.deepEqual(f.pushes.map(entry => entry.origin), ['https://new.example.com']);
  f.resolvers[0].resolve({ origin: 'https://old.example.com', source: 'ls-arg' });
  await f.settle();
  assert.equal(f.pushes.length, 1, 'the superseded generation must not publish');
  assert.equal(f.lifecycle.upstreamPushedKey.endsWith('https://new.example.comportal'), true,
    'the dedupe key belongs to the newer generation');
  // Exactly one skip record marks the cancelled resolution — the only push
  // event is the one that actually POSTed.
  assert.deepEqual(f.logs.filter(e => e.event === 'upstream-push-skipped').map(e => e.data.reason), ['superseded']);
  assert.equal(f.pushLogs().length, 1, 'the cancelled resolution logged no push');
});

test('a resolution completing after disable pushes nothing', async t => {
  const f = fixture(t, { deferResolve: true });
  const enabling = f.shared.ensureEnabled();
  await until(() => f.resolvers.length === 1, 'pending resolver');
  await enabling;
  fs.writeFileSync(f.configFile, JSON.stringify({ enabled: false }));
  f.lifecycle.activationGeneration++;
  f.lifecycle.activationDisposed = true;
  f.resolvers[0].resolve({ origin: 'https://stale.example.com', source: 'portal' });
  await f.settle();
  assert.equal(f.pushes.length, 0, 'a resolver that outlives its activation publishes nothing');
  assert.deepEqual(f.logs.filter(e => e.event === 'upstream-push-skipped').map(e => e.data.reason), ['disabled']);
  assert.equal(f.pushLogs().length, 0, 'the cancelled resolution logged no push');
});

test('teardown aborts the signal given to the in-flight push', async t => {
  const { teardown } = require('../src/activation/teardown.cjs');
  const f = fixture(t, {});
  await f.shared.ensureEnabled();
  await until(() => f.pushes.length === 1, 'initial push');
  await teardown(f.lifecycle);
  assert.equal(f.signals[0]?.aborted, true, 'the push received the abort controller torn down with the activation');
});

test('an aborted in-flight push cannot suppress the re-push of the same origin', async t => {
  const A = 'https://a.example.com', B = 'https://b.example.com';
  // Every POST the stub sees is what the backend adopted. B's POST stays in
  // flight until the third trigger aborts it, then fails — a push that
  // reached the backend but never committed the dedupe key.
  const backend = { origin: null };
  const f = fixture(t, { pushImpl: ({ origin, signal, call }) => {
    backend.origin = origin;
    return call === 2
      ? new Promise(resolve => {
          const done = () => resolve({ ok: false, reason: 'unavailable' });
          signal?.aborted ? done() : signal?.addEventListener('abort', done, { once: true });
        })
      : { ok: true, custom: true };
  } });
  f.effective.current = { origin: A, source: 'ls-arg' };
  await f.shared.ensureEnabled();
  await until(() => f.pushes.length === 1 && f.lifecycle.upstreamPushedKey?.endsWith(A + 'ls-arg'),
    'push A committed and its dedupe key is set');
  f.effective.current = { origin: B, source: 'portal' };
  void f.handlers[0]({ affectsConfiguration: name => name === 'devin.portalUrl' });
  await until(() => f.pushes.length === 2, 'push B in flight');
  f.effective.current = { origin: A, source: 'ls-arg' };
  const third = f.handlers[0]({ affectsConfiguration: name => name === 'devin.portalUrl' });
  await third;
  await f.settle();
  assert.deepEqual(f.pushes.map(entry => entry.origin), [A, B, A],
    'the re-push of A must fire after B was aborted mid-flight');
  assert.equal(backend.origin, A, 'the backend ends on the latest committed push');
  assert.equal(f.lifecycle.upstreamPushedKey.endsWith(A + 'ls-arg'), true);
  assert.equal(f.signals[1].aborted, true, 'the in-flight B push saw the abort');
});

for (const [label, failure] of [
  ['a rejected push', () => ({ ok: false, reason: 'rejected' })],
  ['a throwing push', () => { throw new Error('boom'); }],
]) {
  test(`${label} invalidates the dedupe key so the same origin re-pushes`, async t => {
    const A = 'https://a.example.com', B = 'https://b.example.com';
    const backend = { origin: null };
    const f = fixture(t, { pushImpl: ({ origin, call }) => {
      backend.origin = origin; // the POST landed regardless of the verdict
      return call === 2 ? failure() : { ok: true, custom: true };
    } });
    f.effective.current = { origin: A, source: 'ls-arg' };
    await f.shared.ensureEnabled();
    await until(() => f.pushes.length === 1 && f.lifecycle.upstreamPushedKey?.endsWith(A + 'ls-arg'),
      'push A committed and its dedupe key is set');
    f.effective.current = { origin: B, source: 'portal' };
    await f.handlers[0]({ affectsConfiguration: name => name === 'devin.portalUrl' });
    await f.settle();
    assert.equal(f.pushes.length, 2, 'the failed push still issued its POST');
    assert.equal(backend.origin, B, 'the backend adopted B');
    assert.equal(f.lifecycle.upstreamPushedKey, undefined,
      'a failed push leaves the key invalidated — the backend state is uncertain');
    f.effective.current = { origin: A, source: 'ls-arg' };
    await f.handlers[0]({ affectsConfiguration: name => name === 'devin.portalUrl' });
    await f.settle();
    assert.equal(f.pushes.length, 3, 'returning to A must re-push, not dedupe against a stale key');
    assert.equal(backend.origin, A);
    assert.equal(f.lifecycle.upstreamPushedKey.endsWith(A + 'ls-arg'), true);
  });
}

test('publication is cleared by teardown and rebuilt on the next enable', async t => {
  const { teardown } = require('../src/activation/teardown.cjs');
  const f = fixture(t, { effective: { origin: 'https://custom.example.com', source: 'ls-arg' } });
  await f.shared.ensureEnabled();
  await f.settle();
  assert.ok(f.lifecycle.publication, 'enable wires the injected factory');
  f.lifecycle.activationDisposed = true;
  await teardown(f.lifecycle);
  assert.equal(f.lifecycle.publication, undefined, 'teardown disposes and clears the slot');
  f.lifecycle.activationDisposed = false;
  await f.shared.ensureEnabled();
  await f.settle();
  assert.ok(f.lifecycle.publication, 'the next enable rebuilds publication via ??=');
});

// The wait between attempts must be interruptible: an abort that lands inside
// the pause is exactly the superseding trigger, and firing the next attempt
// would push a target whose generation is already dead.
test('an aborted retry wait never starts another request', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-backend-upstream-abort-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ providers: [] }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { pushUpstream } = require('../src/runtime/host/upstream.cjs');
  const controller = new AbortController();
  const calls = [];
  const request = (url) => {
    calls.push(url);
    if (calls.length === 1) setTimeout(() => controller.abort(), 30).unref();
    return Promise.reject(Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' }));
  };
  const result = await pushUpstream({ root, origin: 'http://127.0.0.1:9', port: 1,
    signal: controller.signal, request });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1, 'aborting inside the retry pause must not fire a second attempt');
});

test('a pre-aborted pushUpstream issues no request at all', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-backend-upstream-preabort-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ providers: [] }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { pushUpstream } = require('../src/runtime/host/upstream.cjs');
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await pushUpstream({ root, origin: 'http://127.0.0.1:9', port: 1,
    signal: controller.signal, request: () => { calls++; return Promise.reject(new Error('never')); } });
  assert.equal(result.ok, false);
  assert.equal(calls, 0, 'a dead trigger never touches the transport');
});

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
    managedSettings: createManagedSettingsGate() };

  const loader = createSandboxLoader({ filename, overrides: {
    '../runtime/host/upstream.cjs': { pushUpstream: async ({ root: pushedRoot, origin }) => {
      pushes.push({ root: pushedRoot, origin });
      return options.result || { ok: true, custom: origin != null };
    } },
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
  return { root, pushes, logs, handlers, lifecycle, codeium, shared, settle,
    pushLogs: () => logs.filter(entry => entry.event === 'upstream-push') };
}

test('a configured apiServerUrl is pushed and logged with only the custom flag', async t => {
  const f = fixture(t, { apiServerUrl: 'https://custom.example.com/api' });
  await f.shared.ensureEnabled();
  await f.settle();
  assert.deepEqual(f.pushes, [{ root: f.root, origin: 'https://custom.example.com/api' }]);
  // deepEqual on the whole payload also pins "no host, no origin, no token".
  assert.deepEqual(f.pushLogs(), [{ event: 'upstream-push', data: { ok: true, custom: true } }]);
});

test('an unset apiServerUrl pushes null (backend keeps its default upstream)', async t => {
  const f = fixture(t, {});
  await f.shared.ensureEnabled();
  await f.settle();
  assert.equal(f.pushes.length, 1);
  assert.equal(f.pushes[0].origin, null);
  assert.deepEqual(f.pushLogs(), [{ event: 'upstream-push', data: { ok: true, custom: false } }]);
});

test('a skipped push is logged with its reason', async t => {
  const f = fixture(t, { apiServerUrl: 'https://custom.example.com', result: { ok: false, reason: 'unsupported' } });
  await f.shared.ensureEnabled();
  await f.settle();
  assert.deepEqual(f.pushLogs(), [{ event: 'upstream-push', data: { ok: false, reason: 'unsupported' } }]);
});

test('a failed push logs its detail enum when the backend reports one', async t => {
  const f = fixture(t, { apiServerUrl: 'https://custom.example.com', result: { ok: false, reason: 'identity', detail: 'source' } });
  await f.shared.ensureEnabled();
  await f.settle();
  assert.deepEqual(f.pushLogs(), [{ event: 'upstream-push', data: { ok: false, reason: 'identity', detail: 'source' } }]);
});

test('a later apiServerUrl change re-pushes once the subscription fires', async t => {
  const f = fixture(t, {});
  await f.shared.ensureEnabled();
  await f.settle();
  assert.equal(f.pushes.length, 1);
  assert.equal(f.handlers.length, 1);
  f.codeium.apiServerUrl = 'https://custom.example.com';
  await f.handlers[0]({ affectsConfiguration: section => section === 'codeium.apiServerUrl' });
  await f.settle();
  assert.deepEqual(f.pushes.map(entry => entry.origin), [null, 'https://custom.example.com']);
  // An unrelated configuration event must not re-push.
  await f.handlers[0]({ affectsConfiguration: () => false });
  await f.settle();
  assert.equal(f.pushes.length, 2);
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createSandboxLoader } = require('./helpers/sandbox.cjs');
const { createCatalogSync } = require('../src/activation/catalog-sync.cjs');

// catalogSync-level sibling check (P1): two independently constructed syncs
// keep private catalogs and a dead one publishes nothing. This covers the
// factory itself, not two full runtime sessions — the session-level version
// is the sandboxed createRuntimeSession test below.
const entry = uid => ({ uid, label: uid + ' label', disabled: false, isModelRouter: false, harnessUids: ['h1'] });

function instance() {
  let live = true, disposed = false, gen = 0;
  const published = [];
  const panel = { publish: () => { published.push(1); return Promise.resolve(); }, updateStatusBar: () => {} };
  const sync = createCatalogSync({ root: '/nonexistent', config: () => ({}), log: () => {},
    lifecycleView: {
      isLive: () => live, isDisposed: () => disposed,
      generation: () => gen, isSuperseded: g => g !== gen,
    },
    onChange: () => {
      const p = Promise.resolve(panel.publish()).catch(() => {});
      panel.updateStatusBar();
      return p;
    } });
  return { sync, published, kill: () => { disposed = true; live = false; }, supersede: () => gen++ };
}

test('two catalogSync factories keep private catalogs and dead callbacks stay inert', async () => {
  const a = instance(), b = instance();
  a.sync.observeModels([entry('swe-2-high')]);
  assert.equal(a.sync.read().models.length, 1);
  assert.equal(b.sync.read().models.length, 0, 'each activation owns its own catalog');
  const before = a.published.length;
  assert.ok(before >= 1, 'the observe published through its own panel');
  a.kill();
  a.sync.observeModels([entry('swe-2-max')]);
  await a.sync.refresh();
  assert.equal(a.published.length, before, 'a disposed instance fires no further publishes');
  assert.equal(b.sync.read().models.length, 0, 'the newer instance is untouched');
});

test('the newer catalogSync instance keeps refreshing while the dead one stays inert', async () => {
  const a = instance(), b = instance();
  a.kill();
  b.sync.observeModels([entry('swe-2-high')]);
  assert.equal(b.published.length >= 1, true);
  assert.equal(b.sync.read().models.length, 1);
  assert.equal(a.sync.read().status === 'loading' || a.sync.read().models.length === 0, true);
});

// Two real createRuntimeSession instances from the same sandboxed module:
// session A parks inside a deferred LS injection, deactivate() runs, then the
// stale handle resolves — it must be disposed without ever becoming a
// connection, while session B's own injection completes untouched. Only
// module boundaries are stubbed; sessions run the real enable()/teardown.
test('a superseded session disposes its late injection without touching the live one', async t => {
  let injectionCalls = 0, authInstalls = 0, acpInstalls = 0, catalogStarts = 0, pushes = 0;
  let release, handleB;
  const deferred = new Promise(resolve => { release = resolve; });
  const disposed = { a: 0, b: 0 };
  const loader = createSandboxLoader({
    filename: path.resolve(__dirname, '../src/activation/enable.cjs'),
    overrides: {
      './backend-handshake.cjs': { ensureBackend: ({ onCompatibleRuntime }) => {
        onCompatibleRuntime?.({ version: 'test' });
        return Promise.resolve();
      } },
      '../runtime/host/ls-injection.cjs': { installLsInjection: () => {
        injectionCalls += 1;
        if (injectionCalls === 1) return deferred;
        handleB = { status: { state: 'ready' }, dispose: async () => { disposed.b += 1; } };
        return Promise.resolve(handleB);
      } },
      '../runtime/bridge.cjs': { createLsBridge: async () => ({ port: 4567, close() {} }) },
      '../runtime/host/acp-observer.cjs': { installAcpObserver: () => { acpInstalls += 1; return { dispose() {} }; } },
      '../runtime/host/auth-status.cjs': { installAuthStatusInjection: () => { authInstalls += 1; return { dispose() {} }; } },
      '../runtime/host/upstream.cjs': { pushUpstream: async () => { pushes += 1; return { ok: true }; } },
      './effective-origin.cjs': { resolveEffectiveOriginWhenAvailable: async () => ({ origin: null, source: 'default' }) },
      './native-contract.cjs': { checkNativeContract: async () => ({ ok: true }) },
    },
  });
  t.after(() => loader.assertStubsUsed('runtime-session'));
  const vscode = {
    extensions: { getExtension: () => ({ extensionPath: '/native', packageJSON: { main: 'main.js', version: 'test' } }) },
    workspace: { onDidChangeConfiguration: () => ({ dispose() {} }) },
    window: { showInformationMessage: () => {}, showWarningMessage: () => {}, showErrorMessage: () => {} },
  };
  const catalogSyncStub = () => ({
    read: () => ({ models: [], allowedUids: new Set(), allowedMode: 'restricted', status: 'loading' }),
    observeModels: () => {}, observeAllowed: () => {}, refresh: async () => {},
    markUnsupported: () => {}, start: () => { catalogStarts += 1; }, stop: () => {},
    diagnostics: () => ({}),
  });
  const published = { a: 0, b: 0 };
  const make = publishSlot => loader.module.exports.createRuntimeSession({
    root: '/nonexistent', extensionPath: '/ext', subscriptions: [],
    config: () => ({}), configFile: '/nonexistent/config.json',
    vscode, context: { subscriptions: [] }, nativeMain: '/native/main.js', log: () => {},
    catalog: () => ({ models: [] }), catalogSync: catalogSyncStub(),
    settingsOwner: { openWrites: () => {}, drainWrites: async () => true, applyEnvironment: async () => {},
      saveModel: async () => {}, modelPreference: () => undefined, reconcileSelection: async () => {},
      restore: async () => {} },
    selection: { saveFusionChoice: async () => {}, reconcilePreference: async () => {}, reconcileSelection: async () => {} },
    continuation: { start: () => {}, suspend: () => {}, resetAutoContinue: () => {}, cancelAutoContinueSession: () => {},
      dispose: () => {}, autoContinueStatus: () => 'unavailable', goalController: () => undefined },
    onPublish: () => { published[publishSlot] += 1; return Promise.resolve(); } });
  const a = make('a'), b = make('b');
  t.after(async () => { await b.deactivate(); });
  t.after(async () => { await a.deactivate(); });
  const enablingA = a.ensureEnabled();
  const deadline = Date.now() + 5000;
  while (injectionCalls === 0) {
    if (Date.now() > deadline) throw new Error('session A never reached the injection await');
    await new Promise(resolve => setImmediate(resolve));
  }
  await a.deactivate();
  await b.ensureEnabled();
  assert.strictEqual(b.status(), handleB.status, 'session B is live with its own injection handle');
  const publishedA = published.a, publishedB = published.b;
  const handleA = { status: { state: 'ready' }, dispose: async () => { disposed.a += 1; } };
  release(handleA);
  await enablingA;
  assert.equal(disposed.a, 1, 'the stale injection handle is disposed');
  assert.equal(a.status(), undefined, 'a superseded session never surfaces a connection');
  assert.equal(disposed.b, 0, 'the live session keeps its handle');
  assert.equal(published.a, publishedA, 'the stale session publishes nothing after dispose');
  assert.equal(published.b, publishedB, "session A's late tail triggers no publish on B either");
  assert.strictEqual(b.status(), handleB.status);
  assert.equal(authInstalls, 1, 'only session B installed the auth hook');
  assert.equal(acpInstalls, 1, 'only session B installed the ACP observer');
  assert.equal(catalogStarts, 1, 'only session B started the catalog sync');
  assert.equal(pushes, 1, 'only session B pushed the upstream');
});

test('a runtime session exposes only queries and returns copies', () => {
  const { createRuntimeSession } = require('../src/activation/enable.cjs');
  const session = createRuntimeSession({
    root: '/nonexistent', extensionPath: '/nonexistent', subscriptions: [],
    config: () => ({ enabled: false }), configFile: '/nonexistent/config.json',
    vscode: {}, context: {}, nativeMain: null, log: () => {},
    catalog: () => ({ models: [] }),
    catalogSync: { read: () => ({ models: [], allowedUids: new Set(), allowedMode: 'restricted', status: 'loading' }),
      observeModels: () => {}, observeAllowed: () => {}, refresh: async () => {},
      markUnsupported: () => {}, start: () => {}, stop: () => {} },
    settingsOwner: { openWrites: () => {}, drainWrites: async () => true, applyEnvironment: async () => {},
      saveModel: async () => {}, modelPreference: () => undefined, reconcileSelection: async () => {},
      restore: async () => {} },
    selection: { saveFusionChoice: async () => {}, reconcilePreference: async () => {}, reconcileSelection: async () => {} },
    continuation: { start: () => {}, suspend: () => {}, resetAutoContinue: () => {}, cancelAutoContinueSession: () => {},
      dispose: () => {}, autoContinueStatus: () => 'unavailable', goalController: () => undefined },
    onPublish: () => {} });
  assert.equal(session.isLive(), false, 'a disabled config is never live');
  assert.equal(session.backendStatus(), 'stopped');
  assert.equal(session.status(), undefined);
  assert.equal(session.generation(), 0);
  assert.equal(session.nativeContract(), null);
  const observed = session.acpObservation();
  observed.seq = 99; observed.ownModels = 99;
  assert.deepEqual(session.acpObservation(), { seq: 0, ownModels: 0 },
    'mutating a returned snapshot cannot reach the session state');
});

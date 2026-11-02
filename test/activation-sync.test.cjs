'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSandboxLoader } = require('./helpers/sandbox.cjs');
const { fields, m, s, str } = require('../src/protocol/wire.cjs');
const realCatalog = require('../src/catalog.cjs');
const realCache = require('../src/runtime/host/cli-cache.cjs');

function cacheSyncFixture(t, { refreshResult, picker, models = [{ uid: 'm1' }] } = {}) {
  const logs = [], calls = [], publishCalls = [], executed = [], augOptions = [];
  const result = refreshResult || { checked: 1, refreshed: [], skipped: [], errors: [] };
  const tracker = picker || {
    primed: 0, changedCalls: 0, disposed: 0,
    prime() { this.primed += 1; },
    changed() { this.changedCalls += 1; },
    dispose() { this.disposed += 1; },
  };
  const loader = createSandboxLoader({
    filename: path.resolve(__dirname, '../src/activation/cache-sync.cjs'),
    overrides: {
      '../catalog.cjs': { staleFusionUids: () => new Set(), staleOwnEntries: () => ['dfbyok-stale'],
        ownEntriesSignature: models => 'sig-' + models.length,
        augmentCatalog: (payload, options) => { augOptions.push(options); return payload; } },
      '../runtime/host/cli-cache.cjs': {
        defaultDir: () => '/nonexistent',
        refreshStaleCliCaches: options => { calls.push(options); augOptions.length = 0; return { ...result, callsOptions: options }; },
      },
      '../runtime/host/picker-refresh.cjs': { createPickerRefresh: () => tracker },
    },
  });
  t.after(() => loader.assertStubsUsed('cache-sync fixture'));
  const shared = { cliCacheReport: null, nativeModels: new Map(), acpObservationSeq: 0, acpOwnModels: 0, nativeCatalogStatus: 'ready' };
  const deps = {
    log: (event, data) => logs.push({ event, data }),
    config: () => ({}),
    catalog: () => ({ models, fusions: {}, routes: {} }),
    vscode: { commands: { executeCommand: command => { executed.push(command); return Promise.resolve(); } } },
    context: { subscriptions: [] },
    stores: { nativeCatalog: shared, cacheSync: shared, acpObservation: { seq: 0, ownModels: 0 } },
  };
  const sync = loader.module.exports.installCacheSync({ deps, shared, publish: async () => { publishCalls.push(1); } });
  return { sync, shared, tracker, logs, calls, augOptions, publishCalls, executed, subscriptions: deps.context.subscriptions };
}

test('an empty catalog still runs the check so recognized stale own entries can retire', t => {
  const coverage = { dirState: 'ok', supported: 1, legacy: [], unsupported: [] };
  const f = cacheSyncFixture(t, { models: [], refreshResult: { checked: 1, refreshed: [], skipped: [], errors: [], coverage } });
  const report = f.sync.check();
  assert.equal(f.calls.length, 1, 'the empty-catalog early return used to skip the cleanup pass entirely');
  assert.deepEqual(f.calls[0].expectedUids, []);
  assert.deepEqual(report.coverage, coverage, 'the report carries the directory coverage through to the panel');
});

test('the picker signature tracker is primed and registered without a panel', t => {
  const f = cacheSyncFixture(t);
  assert.equal(f.tracker.primed, 1);
  assert.equal(f.subscriptions.length, 1);
  assert.equal(f.shared.pickerRefresh, f.tracker);
  f.shared.pickerRefresh.dispose();
  assert.equal(f.tracker.disposed, 1);
  assert.deepEqual(f.executed, [], 'cache sync wires no light refresh commands');
});

test('automatic cache checks keep the same report object when the outcome is unchanged', t => {
  const f = cacheSyncFixture(t);
  const first = f.sync.check();
  const second = f.sync.check();
  assert.equal(first, second, 'an unchanged automatic check must return the retained report object');
  assert.equal(f.shared.cliCacheReport, first);
  assert.equal(f.calls.length, 2);
  assert.ok(!f.calls[0].force && !f.calls[1].force);
});

test('a forced check always restamps the report', t => {
  const f = cacheSyncFixture(t);
  const first = f.sync.check();
  const forced = f.sync.check({ force: true });
  assert.notEqual(forced, first, 'force must produce a fresh report object even when the outcome matches');
  assert.equal(f.calls[1].force, true);
});

test('changed() nudges the picker refresh and re-runs the check', t => {
  const f = cacheSyncFixture(t);
  f.sync.changed();
  assert.equal(f.tracker.changedCalls, 1);
  assert.equal(f.calls.length, 1);
});

test('refresh() forces a check and publishes the panel', async t => {
  const f = cacheSyncFixture(t);
  const report = await f.sync.refresh();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].force, true);
  assert.equal(f.publishCalls.length, 1);
  assert.equal(report, f.shared.cliCacheReport);
});

test('a failing cache probe logs and keeps the previous report', t => {
  const f = cacheSyncFixture(t);
  const first = f.sync.check();
  const logs = [];
  const loader = createSandboxLoader({
    filename: path.resolve(__dirname, '../src/activation/cache-sync.cjs'),
    overrides: {
      '../catalog.cjs': { staleFusionUids: () => new Set(), staleOwnEntries: () => [], ownEntriesSignature: () => 'sig',
        augmentCatalog: payload => payload },
      '../runtime/host/cli-cache.cjs': {
        defaultDir: () => '/nonexistent',
        refreshStaleCliCaches: () => { throw Object.assign(new Error('boom'), { code: 'EACCES' }); },
      },
      '../runtime/host/picker-refresh.cjs': { createPickerRefresh: () => f.tracker },
    },
  });
  t.after(() => loader.assertStubsUsed('failing cache-sync fixture'));
  const sync = loader.module.exports.installCacheSync({
    deps: { log: (event, data) => logs.push({ event, data }), config: () => ({}),
      catalog: () => ({ models: [{ uid: 'm1' }], fusions: {}, routes: {} }),
      vscode: { commands: { executeCommand: () => Promise.resolve() } },
      context: { subscriptions: [] },
      stores: { nativeCatalog: f.shared, cacheSync: f.shared, acpObservation: { seq: 0, ownModels: 0 } } },
    shared: f.shared, publish: async () => {},
  });
  assert.equal(sync.check(), first);
  assert.ok(logs.some(line => line.event === 'cli-cache-check-failed' && line.data.code === 'EACCES'));
});

function configSyncFixture(t, { initial = {} } = {}) {
  const logs = [], unwatchCalls = [], watchers = [], preferenceListeners = [];
  const loader = createSandboxLoader({
    filename: path.resolve(__dirname, '../src/activation/config-sync.cjs'),
    overrides: {
      'node:fs': {
        watchFile: (file, options, listener) => { watchers.push({ file, options, listener }); },
        unwatchFile: (file, listener) => { unwatchCalls.push({ file, listener }); },
      },
    },
  });
  t.after(() => loader.assertStubsUsed('config-sync fixture'));
  let current = { enabled: true, ...initial };
  const enabled = [], reconciled = [], preference = [], disabled = [], changedCalls = [], publishCalls = [], resets = [], suspends = [];
  const shared = {
    ensureEnabled: async () => { enabled.push(1); },
    reconcileSelection: async () => { reconciled.push(1); },
    reconcilePreference: () => { preference.push(1); },
    disable: async () => { disabled.push(1); },
  };
  const lifecycle = { activationDisposed: false, resetAutoContinue: () => { resets.push(1); },
    goalController: { suspend: () => { suspends.push(1); } } };
  let prefDisposed = 0;
  const deps = {
    lifecycle, log: (event, data) => logs.push({ event, data }),
    config: () => current, configFile: '/nonexistent/config.json', root: '/nonexistent',
    context: { subscriptions: [] },
    vscode: { workspace: { onDidChangeConfiguration: fn => { preferenceListeners.push(fn); return { dispose() { prefDisposed += 1; } }; } } },
  };
  const sync = loader.module.exports.createConfigSync({ deps, shared,
    changed: () => { changedCalls.push(1); }, publish: () => { publishCalls.push(1); return Promise.resolve(); } });
  return {
    sync, shared, logs, watchers, unwatchCalls, preferenceListeners, subscriptions: deps.context.subscriptions,
    enabled, reconciled, preference, disabled, changedCalls, publishCalls, resets, suspends,
    prefDisposed: () => prefDisposed,
    setConfig: next => { current = next; },
  };
}

test('afterChange routes each mutation type once and always ends with changed()', async t => {
  const f = configSyncFixture(t, { initial: { enabled: false } });
  await f.sync.afterChange('setEnabled');
  assert.equal(f.disabled.length, 1);
  assert.equal(f.changedCalls.length, 1);

  const g = configSyncFixture(t, { initial: { goalEnabled: false } });
  await g.sync.afterChange('setGoalEnabled');
  assert.equal(g.suspends.length, 1);
  assert.equal(g.changedCalls.length, 1);

  const h = configSyncFixture(t);
  await h.sync.afterChange('setAutoContinue');
  assert.equal(h.resets.length, 1);
  assert.equal(h.enabled.length, 0);
  assert.equal(h.changedCalls.length, 1);

  const i = configSyncFixture(t);
  await i.sync.afterChange('setUpdateProxy');
  assert.equal(i.enabled.length, 0);
  assert.equal(i.changedCalls.length, 1);

  const j = configSyncFixture(t);
  await j.sync.afterChange('setProviders');
  assert.equal(j.enabled.length, 1);
  assert.equal(j.reconciled.length, 1);
  assert.equal(j.changedCalls.length, 1);
});

test('start() is idempotent and registers watcher/subscription only after assembly', t => {
  const f = configSyncFixture(t);
  assert.equal(f.watchers.length, 0);
  f.sync.start();
  f.sync.start();
  assert.equal(f.watchers.length, 1, 'a second start must not register another watcher');
  assert.equal(f.preferenceListeners.length, 1);
  assert.equal(f.subscriptions.length, 2);
  f.subscriptions.forEach(subscription => subscription.dispose());
  assert.equal(f.unwatchCalls.length, 1, 'disposing must unwatch the config file');
  assert.equal(f.prefDisposed(), 1);
});

test('the config watcher tears down on disable and resets auto-continue flags once', t => {
  const f = configSyncFixture(t, { initial: { autoContinueOnProviderError: true } });
  f.sync.start();
  f.setConfig({ enabled: false, autoContinueOnProviderError: false });
  f.watchers[0].listener();
  assert.equal(f.disabled.length, 1, 'the watcher routes through the serialized shared disable path');
  assert.equal(f.resets.length, 1, 'a changed auto flag must reset the auto-continue budget');
  assert.equal(f.publishCalls.length, 1);
  f.watchers[0].listener();
  assert.equal(f.resets.length, 1, 'an unchanged flag must not reset again');
  assert.equal(f.publishCalls.length, 2);
});

test('the config watcher ensures enabled state and reconciles preference when enabled', t => {
  const f = configSyncFixture(t);
  f.sync.start();
  f.watchers[0].listener();
  assert.equal(f.enabled.length, 1);
  assert.equal(f.preference.length, 1);
  assert.equal(f.publishCalls.length, 1);
});

test('the preference listener ignores unrelated configuration sections', t => {
  const f = configSyncFixture(t);
  f.sync.start();
  f.preferenceListeners[0]({ affectsConfiguration: () => false });
  assert.equal(f.preference.length, 0);
  f.preferenceListeners[0]({ affectsConfiguration: section => section === 'devin.acp.agentPreferences' });
  assert.equal(f.preference.length, 1);
});

test('the readiness gate switches retirement: loading is additive-only, ready retires', t => {
  const f = cacheSyncFixture(t);
  f.shared.nativeCatalogStatus = 'loading';
  f.sync.check();
  assert.equal(f.calls.at(-1).retire, false, 'a loading native catalog forbids retirement');
  f.calls.at(-1).augment(Buffer.from('x'), '/r', () => {});
  assert.equal(f.augOptions.at(-1).retireOwn, false, 'augment stays additive-only while loading');
  f.shared.nativeCatalogStatus = 'ready';
  f.sync.check();
  assert.equal(f.calls.at(-1).retire, true, 'a ready native catalog allows retirement');
  f.calls.at(-1).augment(Buffer.from('x'), '/r', () => {});
  assert.equal(f.augOptions.at(-1).retireOwn, true, 'augment retires only under authority');
  // unsupported/empty also count as authoritative; unavailable does not.
  for (const [status, expected] of [['unsupported', true], ['empty', true], ['unavailable', false]]) {
    f.shared.nativeCatalogStatus = status;
    f.sync.check();
    assert.equal(f.calls.at(-1).retire, expected, status);
  }
});

test('cli-cache-deferred logs once per non-authoritative spell', t => {
  const f = cacheSyncFixture(t);
  f.shared.nativeCatalogStatus = 'loading';
  f.sync.check(); f.sync.check(); f.sync.check();
  assert.equal(f.logs.filter(line => line.event === 'cli-cache-deferred').length, 1,
    'consecutive deferred checks log only once');
  f.shared.nativeCatalogStatus = 'ready';
  f.sync.check();
  f.shared.nativeCatalogStatus = 'unavailable';
  f.sync.check();
  assert.equal(f.logs.filter(line => line.event === 'cli-cache-deferred').length, 2,
    'a new non-authoritative spell logs again');
});

test('the shape probe runs once per own-entries signature and stamps it after the check', t => {
  const f = cacheSyncFixture(t);
  f.sync.check();
  const probe = f.calls[0].staleProbe;
  assert.deepEqual([...probe(Buffer.alloc(0))], ['dfbyok-stale'],
    'first signature probes own-entry bytes');
  assert.equal(f.shared.ownShapeSignature, 'sig-1', 'the signature is recorded after the run');
  f.sync.check();
  assert.deepEqual([...f.calls[1].staleProbe(Buffer.alloc(0))], [],
    'an unchanged signature skips the byte comparison entirely');
});

for (const [before, after] of [['loading', 'ready'], ['unavailable', 'empty']]) {
  test(`a ${before} -> ${after} transition keeps the signature pending until the authoritative check`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-cache-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const cat = parts => Buffer.concat(parts);
    const configFor = orders => ({ enabled: true, inferenceServerUrl: 'http://127.0.0.1:39842',
      providers: [{ id: 'p', name: 'P', baseUrl: 'https://p.invalid/v1', apiKey: 'k', apiFormat: 'openai',
        models: [
          { id: 'a', label: 'a', efforts: [], contextWindow: 128000, maxOutputTokens: 8192, order: orders[0] },
          { id: 'b', label: 'b', efforts: [], contextWindow: 128000, maxOutputTokens: 8192, order: orders[1] },
        ] }],
      sidekicks: [{ providerId: 'p', model: 'a' }, { providerId: 'p', model: 'b' }] });
    const old = realCatalog.buildCatalog(configFor([0, 1]));
    const current = realCatalog.buildCatalog(configFor([1, 0]));
    const payload = Buffer.concat([...old.models.map(model => m(1, model.raw)),
      m(1, cat([s(1, 'Official'), s(22, 'native-official')]))]).toString('base64');
    const name = 'model_configs_v6.0123456789abcdef.bin';
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({ version: 1, identity_digest: 'd', fetched_at_secs: 1, payload }));
    const bytesBefore = fs.readFileSync(file);
    const shared = { cliCacheReport: null, cliCacheDeferred: false, ownShapeSignature: undefined,
      nativeCatalogStatus: before, nativeModels: new Map() };
    let probeCalls = 0;
    const countedOwnEntries = (data, options) => { probeCalls++; return realCatalog.staleOwnEntries(data, options); };
    const loader = createSandboxLoader({
      filename: path.resolve(__dirname, '../src/activation/cache-sync.cjs'),
      overrides: {
        // staleFusionUids validates `known instanceof Set`, which fails across
        // the sandbox realm boundary — the fusion probe is stubbed; this test
        // only exercises the real own-shape path.
        '../catalog.cjs': { staleFusionUids: () => [], staleOwnEntries: countedOwnEntries,
          ownEntriesSignature: realCatalog.ownEntriesSignature, augmentCatalog: realCatalog.augmentCatalog },
        '../runtime/host/cli-cache.cjs': { defaultDir: () => dir, refreshStaleCliCaches: realCache.refreshStaleCliCaches },
        '../runtime/host/picker-refresh.cjs': { createPickerRefresh: () => ({ prime() {}, changed() {}, dispose() {} }) },
      },
    });
    t.after(() => loader.assertStubsUsed('real cache-sync fixture'));
    const sync = loader.module.exports.installCacheSync({
      deps: { log: () => {}, config: () => ({}), catalog: () => current,
        vscode: { commands: { executeCommand: () => Promise.resolve() } }, context: { subscriptions: [] },
        stores: { nativeCatalog: shared, cacheSync: shared, acpObservation: { seq: 0, ownModels: 0 } } },
      shared, publish: async () => {},
    });
    sync.check();
    assert.equal(shared.ownShapeSignature, undefined, 'a non-authoritative check must not consume the pending signature');
    assert.ok(bytesBefore.equals(fs.readFileSync(file)), 'a non-authoritative check leaves the bytes alone');
    assert.equal(probeCalls, 0, 'a non-authoritative check never runs the shape probe');
    shared.nativeCatalogStatus = after;
    const report = sync.check();
    assert.ok(report.refreshed.includes(name), 'the authoritative check rewrites the drifted payload');
    assert.ok(probeCalls >= 1, 'the first authoritative check probes the shape');
    assert.equal(shared.ownShapeSignature, realCatalog.ownEntriesSignature(current.models));
    const stored = new Map();
    for (const entry of fields(Buffer.from(JSON.parse(fs.readFileSync(file, 'utf8')).payload, 'base64'), 1)) {
      stored.set(str(entry.value, 22), entry.value);
    }
    for (const model of current.models) {
      assert.ok(stored.get(model.uid)?.equals(model.raw), 'stored entry ' + model.uid + ' equals the current emission');
    }
    const calls = probeCalls;
    const again = sync.check();
    assert.deepEqual(again.refreshed, [], 'an unchanged signature never rewrites');
    assert.equal(probeCalls, calls, 'an unchanged signature never probes again');
  });
}

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSandboxLoader } = require('./helpers/sandbox.cjs');
const { fields, m, s, str } = require('../src/protocol/wire.cjs');
const cat = (...parts) => Buffer.concat(parts.flat());
const realCatalog = require('../src/catalog.cjs');
const realCache = require('../src/runtime/host/cli-cache.cjs');

function cacheSyncFixture(t, { refreshResult, models = [{ uid: 'm1' }] } = {}) {
  const logs = [], calls = [], publishCalls = [], executed = [], augOptions = [];
  const result = refreshResult || { checked: 1, refreshed: [], skipped: [], errors: [] };
  const loader = createSandboxLoader({
    filename: path.resolve(__dirname, '../src/activation/cache-sync.cjs'),
    overrides: {
      '../catalog.cjs': { staleFusionUids: () => new Set(), staleOwnEntries: () => ['dfbyok-stale'],
        ownEntriesSignature: models => 'sig-' + models.length, isOwnUid: realCatalog.isOwnUid,
        augmentCatalog: (payload, options) => { augOptions.push(options); return payload; } },
      '../runtime/host/cli-cache.cjs': {
        defaultDir: () => '/nonexistent',
        refreshStaleCliCaches: options => { calls.push(options); augOptions.length = 0; return { ...result, callsOptions: options }; },
      },
    },
  });
  t.after(() => loader.assertStubsUsed('cache-sync fixture'));
  let status = 'ready';
  const sync = loader.module.exports.createCacheSync({
    config: () => ({}),
    catalog: () => ({ models, fusions: {}, routes: {} }),
    readNativeCatalog: () => ({ models: [], allowedUids: new Set(), allowedMode: 'restricted', status }),
    log: (event, data) => logs.push({ event, data }),
    publish: async () => { publishCalls.push(1); },
  });
  return { sync, logs, calls, augOptions, publishCalls, executed, subscriptions: [],
    setStatus: next => { status = next; } };
}

test('an empty catalog still runs the check so recognized stale own entries can retire', t => {
  const coverage = { dirState: 'ok', supported: 1, legacy: [], unsupported: [] };
  const f = cacheSyncFixture(t, { models: [], refreshResult: { checked: 1, refreshed: [], skipped: [], errors: [], coverage } });
  const report = f.sync.check();
  assert.equal(f.calls.length, 1, 'the empty-catalog early return used to skip the cleanup pass entirely');
  assert.deepEqual(f.calls[0].expectedUids, []);
  assert.deepEqual(report.coverage, coverage, 'the report carries the directory coverage through to the panel');
});

test('cache sync wires no picker refresh commands or subscriptions', t => {
  const f = cacheSyncFixture(t);
  assert.equal(f.subscriptions.length, 0);
  assert.deepEqual(f.executed, [], 'cache sync wires no light refresh commands');
});

test('automatic cache checks keep the same report object when the outcome is unchanged', t => {
  const f = cacheSyncFixture(t);
  // The first-ever authoritative check always forces once (the hidden-native
  // signature starts unset); stamp it before comparing two settled checks.
  f.sync.check(); f.calls.length = 0;
  const first = f.sync.check();
  const second = f.sync.check();
  assert.equal(first, second, 'an unchanged automatic check must return the retained report object');
  assert.equal(f.sync.report(), first);
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

test('changed() re-runs the check', t => {
  const f = cacheSyncFixture(t);
  f.sync.changed();
  assert.equal(f.calls.length, 1);
});

test('refresh() forces a check and publishes the panel', async t => {
  const f = cacheSyncFixture(t);
  const report = await f.sync.refresh();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].force, true);
  assert.equal(f.publishCalls.length, 1);
  assert.equal(report, f.sync.report());
});

test('a failing cache probe logs and keeps the previous report', t => {
  const logs = [];
  let fail = false;
  const loader = createSandboxLoader({
    filename: path.resolve(__dirname, '../src/activation/cache-sync.cjs'),
    overrides: {
      '../catalog.cjs': { staleFusionUids: () => new Set(), staleOwnEntries: () => [], ownEntriesSignature: () => 'sig',
        isOwnUid: realCatalog.isOwnUid,
        augmentCatalog: payload => payload },
      '../runtime/host/cli-cache.cjs': {
        defaultDir: () => '/nonexistent',
        refreshStaleCliCaches: () => { if (fail) throw Object.assign(new Error('boom'), { code: 'EACCES' });
          return { checked: 1, refreshed: [], skipped: [], errors: [] }; },
      },
    },
  });
  t.after(() => loader.assertStubsUsed('failing cache-sync fixture'));
  const sync = loader.module.exports.createCacheSync({
    config: () => ({}),
    catalog: () => ({ models: [{ uid: 'm1' }], fusions: {}, routes: {} }),
    readNativeCatalog: () => ({ models: [], allowedUids: new Set(), allowedMode: 'restricted', status: 'ready' }),
    log: (event, data) => logs.push({ event, data }),
    publish: async () => {},
  });
  const first = sync.check();
  fail = true;
  assert.equal(sync.check(), first);
  assert.ok(logs.some(line => line.event === 'cli-cache-check-failed' && line.data.code === 'EACCES'));
});

const settle = async (rounds = 20) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); };
const pending = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

// The config sync has one reconcile entry for both the panel's writes and the
// file watcher: the fixture only needs to project a config and count the
// effects each path produces.
function configSyncFixture(t, fixtureOptions = {}) {
  const { initial = {}, holdEnable, failDisable } = fixtureOptions;
  const fixtureState = { readError: false };
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
  let disposedRuntime = false;
  const enabled = [], reconciled = [], preference = [], disabled = [], changedCalls = [], publishCalls = [], resets = [], suspends = [];
  const runtime = {
    ensureEnabled: async () => { enabled.push(1); if (holdEnable) await holdEnable.promise; },
    disable: async () => { if (failDisable) throw failDisable; disabled.push(1); },
    isDisposed: () => disposedRuntime,
  };
  const selection = {
    reconcileSelection: async () => { reconciled.push(1); },
    reconcilePreference: () => { preference.push(1); return Promise.resolve(); },
  };
  const continuation = { suspend: ({ reason } = {}) => { suspends.push(reason); }, resetAutoContinue: () => { resets.push(1); } };
  let prefDisposed = 0;
  const context = { subscriptions: [] };
  const sync = loader.module.exports.createConfigSync({
    log: (event, data) => logs.push({ event, data }),
    config: () => { if (fixtureState.readError) throw Object.assign(new Error('unreadable'), { code: 'config_unreadable' }); return current; },
    configFile: '/nonexistent/config.json',
    context,
    vscode: { workspace: { onDidChangeConfiguration: fn => { preferenceListeners.push(fn); return { dispose() { prefDisposed += 1; } }; } } },
    runtime, selection, continuation,
    changed: () => { changedCalls.push(1); },
    publish: () => { publishCalls.push(1); return fixtureOptions.publishImpl ? fixtureOptions.publishImpl() : Promise.resolve(); } });
  return {
    sync, logs, watchers, unwatchCalls, preferenceListeners, subscriptions: context.subscriptions,
    enabled, reconciled, preference, disabled, changedCalls, publishCalls, resets, suspends,
    prefDisposed: () => prefDisposed,
    disposeRuntime: () => { disposedRuntime = true; },
    set configReadError(value) { fixtureState.readError = value; },
    setConfig: next => { current = next; },
    fireWatch: () => watchers[0].listener(),
  };
}

test('afterChange reconciles each state change once and ends with changed()', async t => {
  const disabledFixture = configSyncFixture(t, { initial: { enabled: false } });
  await disabledFixture.sync.afterChange('setEnabled');
  assert.equal(disabledFixture.disabled.length, 1);
  assert.equal(disabledFixture.enabled.length, 0);
  assert.equal(disabledFixture.changedCalls.length, 1);

  const goalOff = configSyncFixture(t, { initial: { goalEnabled: false } });
  await goalOff.sync.afterChange('setGoalEnabled');
  assert.deepEqual(goalOff.suspends, ['disabled'], 'a disabled goal is observed and suspended once');
  assert.equal(goalOff.changedCalls.length, 1);

  const auto = configSyncFixture(t, { initial: { autoContinueOnProviderError: true } });
  auto.sync.start();
  auto.setConfig({ enabled: true, autoContinueOnProviderError: false });
  await auto.sync.afterChange('setAutoContinue');
  assert.equal(auto.resets.length, 1, 'a real auto-continue change resets the budget once');

  const providers = configSyncFixture(t);
  await providers.sync.afterChange('setProviders');
  assert.equal(providers.enabled.length, 1);
  assert.equal(providers.reconciled.length, 1);
  assert.equal(providers.preference.length, 1);
  assert.equal(providers.changedCalls.length, 1);
});

test('start() is idempotent and registers one teardown handle for watcher and preference', t => {
  const f = configSyncFixture(t);
  assert.equal(f.watchers.length, 0);
  f.sync.start();
  f.sync.start();
  assert.equal(f.watchers.length, 1, 'a second start must not register another watcher');
  assert.equal(f.preferenceListeners.length, 1);
  assert.equal(f.subscriptions.length, 1, 'watcher and preference listener share one handle');
  f.subscriptions.forEach(subscription => subscription.dispose());
  assert.equal(f.unwatchCalls.length, 1, 'disposing must unwatch the config file');
  assert.equal(f.prefDisposed(), 1, 'and dispose the preference listener');
});

test('the config watcher tears down on disable and resets auto-continue flags once', async t => {
  const f = configSyncFixture(t, { initial: { autoContinueOnProviderError: true } });
  f.sync.start();
  f.setConfig({ enabled: false, autoContinueOnProviderError: false });
  f.fireWatch();
  await settle();
  assert.equal(f.disabled.length, 1, 'the watcher routes through the shared disable path');
  assert.equal(f.resets.length, 1, 'a changed auto flag must reset the auto-continue budget');
  assert.equal(f.publishCalls.length, 1);
  f.fireWatch();
  await settle();
  assert.equal(f.resets.length, 1, 'an unchanged flag must not reset again');
  assert.equal(f.disabled.length, 2, 'every external write still reconciles the disabled state');
  assert.equal(f.publishCalls.length, 2);
});

test('the config watcher ensures enabled state and reconciles the preference when enabled', async t => {
  const f = configSyncFixture(t);
  f.sync.start();
  f.fireWatch();
  await settle();
  assert.equal(f.enabled.length, 1);
  assert.equal(f.reconciled.length, 1);
  assert.equal(f.preference.length, 1);
  assert.equal(f.publishCalls.length, 1);
});

test('the preference listener ignores unrelated configuration sections', async t => {
  const f = configSyncFixture(t);
  f.sync.start();
  f.preferenceListeners[0]({ affectsConfiguration: () => false });
  await settle();
  assert.equal(f.preference.length, 0);
  f.preferenceListeners[0]({ affectsConfiguration: section => section === 'devin.acp.agentPreferences' });
  await settle();
  assert.equal(f.preference.length, 1);
});

test('turning the goal off pauses it immediately even while enabling is still pending', async t => {
  const hold = pending();
  const f = configSyncFixture(t, { initial: { goalEnabled: true }, holdEnable: hold });
  f.sync.start();
  f.setConfig({ enabled: true, goalEnabled: false });
  f.fireWatch();
  await settle();
  assert.deepEqual(f.suspends, ['disabled'], 'the suspension lands before the enable converges');
  assert.equal(f.enabled.length, 1, 'and the enable is still in flight');
  assert.equal(f.changedCalls.length, 0, 'nothing is published while the enable hangs');
  hold.resolve();
  await settle();
  assert.equal(f.changedCalls.length, 1);
});

test('a local write and its watcher echo pause the goal only once', async t => {
  const f = configSyncFixture(t, { initial: { goalEnabled: true } });
  f.sync.start();
  f.setConfig({ enabled: true, goalEnabled: false });
  await f.sync.afterChange('setGoalEnabled');
  f.fireWatch();
  await settle();
  assert.equal(f.suspends.length, 1, 'the duplicate notification sees no state change');
});

test('turning the goal back on neither resumes nor dispatches on its own', async t => {
  const f = configSyncFixture(t, { initial: { goalEnabled: false } });
  f.sync.start();
  f.setConfig({ enabled: true, goalEnabled: true });
  await f.sync.afterChange('setGoalEnabled');
  assert.deepEqual(f.suspends, [], 'a fresh enable is not a suspension');
  assert.deepEqual(f.resets, [], 'the auto-continue budget is untouched');
  assert.equal(f.enabled.length, 1, 'the goal stays a user-driven action');
});

test('a disposed sync abandons the pending job without publishing', async t => {
  const hold = pending();
  const f = configSyncFixture(t, { holdEnable: hold });
  f.sync.start();
  f.fireWatch();
  await settle();
  f.subscriptions.forEach(subscription => subscription.dispose());
  hold.resolve();
  await settle();
  assert.equal(f.reconciled.length, 0, 'no selection work after dispose');
  assert.equal(f.changedCalls.length, 0);
  assert.equal(f.publishCalls.length, 0);
});

test('a disabled session invalidates the enable that was still in flight', async t => {
  const hold = pending();
  const f = configSyncFixture(t, { holdEnable: hold });
  const enabling = f.sync.afterChange('setProviders');
  await settle();
  assert.equal(f.enabled.length, 1);
  f.setConfig({ enabled: false });
  const disabling = f.sync.afterChange('setEnabled');
  hold.resolve();
  await Promise.all([enabling, disabling]);
  assert.equal(f.disabled.length, 1);
  assert.equal(f.reconciled.length, 0, 'the stale enable never reconciles the selection');
  assert.equal(f.publishCalls.length, 1, 'only the disable generation publishes');
});

test('an afterChange failure reaches the panel while the watcher only logs the code', async t => {
  const failure = Object.assign(new Error('boom'), { code: 'operation_failed' });
  const f = configSyncFixture(t, { initial: { enabled: false }, failDisable: failure });
  await assert.rejects(f.sync.afterChange('setEnabled'), error => error.code === 'operation_failed');
  f.sync.start();
  f.fireWatch();
  await settle();
  assert.ok(f.logs.some(line => line.event === 'error' && line.data.code === 'operation_failed'),
    'the watcher reports the safe code instead of throwing');
  assert.equal(f.changedCalls.length, 0, 'a failed job publishes nothing');
});

test('the readiness gate switches retirement: loading is additive-only, ready retires', t => {
  const f = cacheSyncFixture(t);
  f.setStatus('loading');
  f.sync.check();
  assert.equal(f.calls.at(-1).retire, false, 'a loading native catalog forbids retirement');
  f.calls.at(-1).augment(Buffer.from('x'), '/r', () => {});
  assert.equal(f.augOptions.at(-1).retireOwn, false, 'augment stays additive-only while loading');
  f.setStatus('ready');
  f.sync.check();
  assert.equal(f.calls.at(-1).retire, true, 'a ready native catalog allows retirement');
  f.calls.at(-1).augment(Buffer.from('x'), '/r', () => {});
  assert.equal(f.augOptions.at(-1).retireOwn, true, 'augment retires only under authority');
  // unsupported/empty also count as authoritative; unavailable does not.
  for (const [status, expected] of [['unsupported', true], ['empty', true], ['unavailable', false]]) {
    f.setStatus(status);
    f.sync.check();
    assert.equal(f.calls.at(-1).retire, expected, status);
  }
});

test('cli-cache-deferred logs once per non-authoritative spell', t => {
  const f = cacheSyncFixture(t);
  f.setStatus('loading');
  f.sync.check(); f.sync.check(); f.sync.check();
  assert.equal(f.logs.filter(line => line.event === 'cli-cache-deferred').length, 1,
    'consecutive deferred checks log only once');
  f.setStatus('ready');
  f.sync.check();
  f.setStatus('unavailable');
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
  assert.equal(f.sync.diagnostics().ownShapeSignature, 'sig-1', 'the signature is recorded after the run');
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
    let status = before;
    let probeCalls = 0;
    const countedOwnEntries = (data, options) => { probeCalls++; return realCatalog.staleOwnEntries(data, options); };
    const loader = createSandboxLoader({
      filename: path.resolve(__dirname, '../src/activation/cache-sync.cjs'),
      overrides: {
        // staleFusionUids validates `known instanceof Set`, which fails across
        // the sandbox realm boundary — the fusion probe is stubbed; this test
        // only exercises the real own-shape path.
        '../catalog.cjs': { staleFusionUids: () => [], staleOwnEntries: countedOwnEntries,
          ownEntriesSignature: realCatalog.ownEntriesSignature, augmentCatalog: realCatalog.augmentCatalog,
          isOwnUid: realCatalog.isOwnUid },
        '../runtime/host/cli-cache.cjs': { defaultDir: () => dir, refreshStaleCliCaches: realCache.refreshStaleCliCaches },
      },
    });
    t.after(() => loader.assertStubsUsed('real cache-sync fixture'));
    const sync = loader.module.exports.createCacheSync({
      log: () => {}, config: () => ({}), catalog: () => current,
      readNativeCatalog: () => ({ models: [], allowedUids: new Set(), allowedMode: 'restricted', status }),
      publish: async () => {},
    });
    sync.check();
    assert.equal(sync.diagnostics().ownShapeSignature, undefined, 'a non-authoritative check must not consume the pending signature');
    assert.ok(bytesBefore.equals(fs.readFileSync(file)), 'a non-authoritative check leaves the bytes alone');
    assert.equal(probeCalls, 0, 'a non-authoritative check never runs the shape probe');
    status = after;
    const report = sync.check();
    assert.ok(report.refreshed.includes(name), 'the authoritative check rewrites the drifted payload');
    assert.ok(probeCalls >= 1, 'the first authoritative check probes the shape');
    assert.equal(sync.diagnostics().ownShapeSignature, realCatalog.ownEntriesSignature(current.models));
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

// An explicit hiddenNativeModelUids change must rewrite the cache once even
// when the own emission is byte-identical — hidden natives are deleted on
// augment. The signature covers only the configured list: dedupes, reordering
// and observation-derived hiddenFusionUids/allowlist jitter never force.
for (const before of ['loading', 'unavailable']) {
  test(`an explicit hidden-native change forces exactly one authoritative rewrite (${before} start)`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-cache-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const cfg = hidden => ({ enabled: true, inferenceServerUrl: 'http://127.0.0.1:39842',
      providers: [{ id: 'p', name: 'P', baseUrl: 'https://p.invalid/v1', apiKey: 'k', apiFormat: 'openai',
        models: [{ id: 'a', label: 'a', efforts: [], contextWindow: 128000, maxOutputTokens: 8192 }] }],
      hiddenNativeModelUids: hidden });
    const hiddenSet = ['native-hide-me', 'native-hide-also'];
    let live = cfg(hiddenSet);
    let current = realCatalog.buildCatalog(live);
    const nativeEntry = uid => m(1, cat([s(1, uid), s(22, uid)]));
    const payload = Buffer.concat([...current.models.map(model => m(1, model.raw)),
      nativeEntry('native-hide-me'), nativeEntry('native-keep')]).toString('base64');
    const name = 'model_configs_v6.0123456789abcdef.bin';
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({ version: 1, identity_digest: 'd', fetched_at_secs: 1, payload }));
    const calls = [];
    let status = before;
    const loader = createSandboxLoader({
      filename: path.resolve(__dirname, '../src/activation/cache-sync.cjs'),
      overrides: {
        '../catalog.cjs': { staleFusionUids: () => [], staleOwnEntries: realCatalog.staleOwnEntries,
          ownEntriesSignature: realCatalog.ownEntriesSignature, augmentCatalog: realCatalog.augmentCatalog,
          isOwnUid: realCatalog.isOwnUid },
        '../runtime/host/cli-cache.cjs': { defaultDir: () => dir,
          refreshStaleCliCaches: options => { calls.push(options); return realCache.refreshStaleCliCaches(options); } },
      },
    });
    t.after(() => loader.assertStubsUsed('hidden-signature fixture'));
    const sync = loader.module.exports.createCacheSync({
      log: () => {}, config: () => live, catalog: () => current,
      readNativeCatalog: () => ({ models: [], allowedUids: new Set(), allowedMode: 'restricted', status }),
      publish: async () => {},
    });
    const uids = () => fields(Buffer.from(JSON.parse(fs.readFileSync(file, 'utf8')).payload, 'base64'), 1)
      .filter(field => field.wire === 2).map(field => str(field.value, 22));

    sync.check();
    assert.equal(calls[0].force, false, 'a non-authoritative check never forces');
    assert.equal(sync.diagnostics().hiddenNativeSignature, undefined, 'and never consumes the pending signature');
    assert.ok(uids().includes('native-hide-me'), 'nor rewrites the payload');

    status = 'ready';
    sync.check();
    assert.equal(calls[1].force, true, 'the first authoritative check sees the pending hide change');
    assert.ok(!uids().includes('native-hide-me'), 'the hidden native is actually removed');
    assert.ok(uids().includes('native-keep'), 'other natives survive');
    assert.equal(sync.diagnostics().hiddenNativeSignature, JSON.stringify([...hiddenSet].sort()));

    sync.check();
    assert.equal(calls[2].force, false, 'an unchanged signature does not force again');
    // Reordering and duplicates inside the configured list change nothing.
    live = cfg([...hiddenSet].reverse());
    sync.check();
    assert.equal(calls[3].force, false, 'reordered uids do not change the signature');
    live = cfg(['native-hide-also', 'native-hide-me', 'native-hide-me', 'native-hide-also']);
    sync.check();
    assert.equal(calls[4].force, false, 'duplicated uids do not change the signature');
    live = cfg(hiddenSet);
    sync.check();
    assert.equal(calls[5].force, false, 'identical config stays calm');

    // Observation-derived sets are not part of the signature: only the
    // catalog's generated hiddenFusionUids or the allowed list may move.
    current = { ...current, hiddenFusionUids: ['fusion-generated-hidden'] };
    sync.check();
    assert.equal(calls[6].force, false, 'generated hiddenFusionUids never force');
    current = { ...current, hiddenFusionUids: [], nativeAllowedUids: ['native-other'] };
    sync.check();
    assert.equal(calls[7].force, false, 'allowlist drift never forces');

    // Changing the explicit set forces exactly once, then settles.
    live = cfg(['native-hide-me']);
    current = { ...current, hiddenNativeModelUids: ['native-hide-me'] };
    sync.check();
    assert.equal(calls[8].force, true, 'a genuinely different hide set forces once');
    assert.equal(sync.diagnostics().hiddenNativeSignature, JSON.stringify(['native-hide-me']));
    const reportA = sync.check(), reportB = sync.check();
    assert.equal(calls[9].force, false);
    assert.equal(reportA, reportB, 'stable checks keep the same report object — no per-interval churn');
    assert.ok(!JSON.stringify(sync.report()).includes('native-hide'), 'uids never reach the report');
  });
}

test('a disposed-before-start sync registers neither a watcher nor a subscription', t => {
  const f = configSyncFixture(t);
  f.sync.dispose();
  f.sync.start();
  assert.equal(f.watchers.length, 0, 'a disposed sync never arms the file watcher');
  assert.equal(f.preferenceListeners.length, 0);
  assert.equal(f.subscriptions.length, 0);
});

test('a disposed runtime silences every entry without touching the context', async t => {
  const f = configSyncFixture(t);
  f.sync.start();
  f.disposeRuntime();
  await f.sync.afterChange('setProviders');
  f.fireWatch();
  f.preferenceListeners[0]({ affectsConfiguration: section => section === 'devin.acp.agentPreferences' });
  await settle();
  assert.equal(f.enabled.length, 0, 'no enable is started for a disposed runtime');
  assert.equal(f.preference.length, 0);
  assert.equal(f.publishCalls.length, 0);
});

test('an unreadable config rejects afterChange and only logs on the watch path', async t => {
  const f = configSyncFixture(t);
  f.sync.start();
  f.configReadError = true;
  await assert.rejects(f.sync.afterChange('setProviders'), error => error.code === 'config_unreadable');
  f.fireWatch();
  await settle();
  assert.ok(f.logs.some(line => line.event === 'configuration-read-error'),
    'the watcher reports the failed read instead of throwing');
  assert.equal(f.enabled.length, 0);
  assert.equal(f.publishCalls.length, 0);
});

test('a throwing or rejecting publish never turns a committed change into a failure', async t => {
  for (const publish of [() => { throw new Error('sync boom'); }, () => Promise.reject(new Error('async boom'))]) {
    const f = configSyncFixture(t, { publishImpl: publish });
    await f.sync.afterChange('setProviders');
    assert.equal(f.changedCalls.length, 1, 'the change itself completed');
    await settle();
  }
});

// The goal side of the reconcile is verified against the real controller, not a
// spy: an external `goalEnabled=false` must actually pause the run and cancel
// its dispatch, not merely record a call.
const { createGoalController } = require('../src/goal/controller.cjs');
const REPORT_CLI = path.resolve(__dirname, '../src/goal/report.cjs');

function goalSyncFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-goal-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dispatched = [], cancelled = [], sessions = new Map([['session-1', 'idle']]);
  const transport = {
    dispatch(request) { dispatched.push(request); return { ok: true, runId: request.runId }; },
    cancel(sessionId) { cancelled.push(sessionId); return { ok: true }; },
    sessions: () => [...sessions.entries()].map(([sessionId, status]) => ({ sessionId, status })),
    sessionStatus: sessionId => sessions.get(sessionId) || 'unknown',
    setListener() {}, setGoalOwned() {},
  };
  let current = { enabled: true, goalEnabled: true };
  const controller = createGoalController({ root, transport, owner: 'a'.repeat(32),
    scheduler: { setTimeout: () => 1, clearTimeout: () => {} }, reportCliPath: REPORT_CLI,
    isEnabled: () => current.enabled !== false, isTrusted: () => true, log: () => {}, nextRunDelayMs: 0, now: () => 1 });
  t.after(() => controller.dispose());
  const hold = pending();
  // Every reconcile waits on this promise; a test that never releases it would
  // leave the job (and the file's event loop) pending forever.
  t.after(() => hold.resolve());
  const logs = [], changedCalls = [], publishCalls = [], watchers = [], preferenceListeners = [];
  const loader = createSandboxLoader({ filename: path.resolve(__dirname, '../src/activation/config-sync.cjs'),
    overrides: { 'node:fs': {
      watchFile: (file, options, listener) => { watchers.push({ file, options, listener }); },
      unwatchFile: () => {} } } });
  const sync = loader.module.exports.createConfigSync({
    log: (event, data) => logs.push({ event, data }), config: () => current,
    configFile: '/nonexistent/config.json', context: { subscriptions: [] },
    vscode: { workspace: { onDidChangeConfiguration: fn => { preferenceListeners.push(fn); return { dispose() {} }; } } },
    runtime: { ensureEnabled: async () => { await hold.promise; }, disable: async () => {}, isDisposed: () => false },
    selection: { reconcileSelection: async () => {}, reconcilePreference: async () => {} },
    continuation: { suspend: options => controller.suspend(options || {}), resetAutoContinue: () => {} },
    changed: () => { changedCalls.push(1); }, publish: () => { publishCalls.push(1); return Promise.resolve(); } });
  t.after(() => loader.assertStubsUsed('goal sync fixture'));
  return { root, controller, sync, dispatched, cancelled, logs, changedCalls, publishCalls, watchers, hold,
    disposeSync: () => sync.dispose(),
    setConfig: next => { current = next; },
    fireWatch: () => watchers[0].listener(),
    goal: () => controller.snapshot().goals[0] };
}

test('an external goalEnabled=false pauses the real goal run and cancels its dispatch', async t => {
  const f = goalSyncFixture(t);
  f.sync.start();
  f.controller.start({ sessionId: 'session-1', objective: 'finish', criteria: 'tests pass' });
  await settle();
  assert.equal(f.dispatched.length, 1, 'the kickoff dispatched once');
  assert.ok(f.goal().activeRun, 'the run is live');
  f.setConfig({ enabled: true, goalEnabled: false });
  f.fireWatch();
  // No await between the notification and these assertions: the suspension is
  // synchronous, while the enable it races is still held open.
  assert.equal(f.goal().activeRun, null, 'the live run is withdrawn immediately');
  assert.equal(f.goal().status, 'paused');
  assert.deepEqual(f.cancelled, ['session-1'], 'the in-flight dispatch is cancelled exactly once');
  assert.equal(f.changedCalls.length, 0, 'the enable is still pending');
  // A local write plus its watcher echo must not cancel again. The local job is
  // still blocked on the held enable, so it is released below.
  f.setConfig({ enabled: true, goalEnabled: false });
  const local = f.sync.afterChange('setGoalEnabled');
  f.fireWatch();
  await settle();
  assert.deepEqual(f.cancelled, ['session-1'], 'a duplicate notification cancels nothing');
  f.hold.resolve();
  await local;
  await settle();
  assert.equal(f.changedCalls.length, 1, 'only the newest generation publishes');
});

test('re-enabling the goal flag dispatches nothing on its own', async t => {
  const f = goalSyncFixture(t);
  f.sync.start();
  f.setConfig({ enabled: true, goalEnabled: false });
  f.fireWatch();
  await settle();
  assert.equal(f.dispatched.length, 0);
  f.setConfig({ enabled: true, goalEnabled: true });
  f.hold.resolve();
  await f.sync.afterChange('setGoalEnabled');
  await settle();
  assert.equal(f.dispatched.length, 0, 'the user still starts a goal explicitly');
  assert.deepEqual(f.cancelled, [], 'and nothing was cancelled on the way back');
});

test('disposing the goal sync leaves the controller alone and stops the watcher', async t => {
  const f = goalSyncFixture(t);
  f.sync.start();
  f.disposeSync();
  f.setConfig({ enabled: true, goalEnabled: false });
  f.fireWatch();
  await settle();
  assert.deepEqual(f.cancelled, [], 'a disposed sync never reaches the controller');
  assert.equal(f.changedCalls.length, 0);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createManager, publicState, PanelInputError } = require('../src/panel/manager.cjs');
const { buildCatalog } = require('../src/catalog.cjs');

const nativeSidekick = { nativeUid: 'swe-2-max', label: 'SWE-2 Max' };
const OBSERVED_SWE = [
  { uid: 'swe-2-max', label: 'SWE-2 Max', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6', 'swe-1p5'] },
  { uid: 'fusion-lead-a-sidekick-swe-2-max', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 3, name: 'SWE-2 Max' } },
];
const model = (id, overrides = {}) => ({ id, label: id, enabled: true, efforts: [], contextWindow: 200000, maxOutputTokens: 32768, ...overrides });
function fixture() {
  return {
    enabled: true, inferenceServerUrl: 'http://127.0.0.1:39842',
    providers: [
      { id: 'cpa', name: 'CPA', baseUrl: 'https://cpa.invalid/v1', apiFormat: 'openai-responses', apiKey: 'fixture-secret-cpa', enabled: true,
        models: [model('lead', { label: 'CPA · lead' }), model('executor', { label: 'My executor' })] },
      { id: 'other', name: 'Other', baseUrl: 'https://other.invalid/v1', apiFormat: 'openai', apiKey: 'fixture-secret-other', enabled: true,
        models: [model('other-lead')] },
    ],
    sidekicks: [{ providerId: 'cpa', model: 'executor' }, nativeSidekick],
  };
}
function memory(options = {}) {
  let config = structuredClone(options.config || fixture()), selected = '';
  const writes = [], changes = [], selections = [];
  const manager = createManager({
    read: () => structuredClone(config),
    write: next => { config = structuredClone(next); writes.push(structuredClone(next)); },
    discover: options.discover || (async () => { throw new Error('Unexpected discovery'); }),
    afterChange: async type => { changes.push(type); await options.afterChange?.(type); },
    selectFusion: async uid => { selections.push(uid); selected = uid; },
    selectedFusion: () => selected,
    nativeModels: options.nativeModels || (() => []),
    ...(options.nativeCatalogStatus ? { nativeCatalogStatus: options.nativeCatalogStatus } : {}),
    ...(options.refreshCliCaches ? { refreshCliCaches: options.refreshCliCaches } : {}),
    ...(options.cliCacheStatus ? { cliCacheStatus: options.cliCacheStatus } : {}),
  });
  return { manager, writes, changes, selections,
    read: () => structuredClone(config),
    externalChange: edit => { edit(config); },
  };
}
const providerPayload = (overrides = {}) => ({ id: 'cpa', name: 'Updated CPA', baseUrl: 'https://new.invalid/v1/responses', apiFormat: 'openai', apiKey: '', ...overrides });
function assertValidGraph(config, natives = []) {
  const catalog = buildCatalog(config, natives);
  for (const fusion of Object.values(catalog.fusions)) {
    assert.ok(catalog.routes[fusion.leadUid]);
    if (fusion.sidekickNative) assert.ok(Array.isArray(fusion.sidekickHarnessUids) && fusion.sidekickHarnessUids.length > 0);
    else assert.ok(catalog.routes[fusion.sidekickUid]);
  }
  return catalog;
}

test('public state reports the mirrored combination count and carries no preset surface', () => {
  const input = fixture();
  const catalog = buildCatalog(input, OBSERVED_SWE);
  assert.ok(catalog.matrixUids.size > 0 && Object.keys(catalog.fusions).length > 1, 'the matrix mirrors every pairing');
  const state = publicState(input, OBSERVED_SWE, 'unavailable', 'ready');
  assert.equal(state.fusionCount, catalog.matrixUids.size);
  for (const retired of ['fusionPresets', 'presetCandidates', 'migrationPending', 'selectedFusionUid', 'fusionChoices']) {
    assert.equal(Object.hasOwn(state, retired), false, retired + ' is no longer part of the panel state');
  }
  assert.ok(state.roleLists.lead.length > 0, 'the Fusion tab is driven by the role lists');
});

test('public state names the last Fusion combination the card was seen holding', () => {
  const input = fixture();
  const catalog = buildCatalog(input, OBSERVED_SWE);
  const mirroredUid = Object.keys(catalog.fusions)[0];

  assert.equal(publicState(input, OBSERVED_SWE, 'unavailable', 'ready').lastFusion, null,
    'no remembered selection means nothing to report');

  const ours = publicState({ ...input, lastFusionSelection: mirroredUid }, OBSERVED_SWE, 'unavailable', 'ready').lastFusion;
  assert.deepEqual(ours, { uid: mirroredUid, label: catalog.fusions[mirroredUid].label, source: 'mirrored' });

  const official = publicState({ ...input, lastFusionSelection: 'fusion-lead-a-sidekick-swe-2-max' }, OBSERVED_SWE, 'unavailable', 'ready').lastFusion;
  assert.deepEqual(official, { uid: 'fusion-lead-a-sidekick-swe-2-max', label: 'F', source: 'official' });

  const stale = publicState({ ...input, lastFusionSelection: 'fusion-gone-sidekick-gone' }, OBSERVED_SWE, 'unavailable', 'ready').lastFusion;
  assert.deepEqual(stale, { uid: 'fusion-gone-sidekick-gone', label: 'fusion-gone-sidekick-gone', source: 'unresolved' });
});

test('public state carries the last CLI cache report for the settings tab', () => {
  const report = { at: '2026-10-14T00:00:00.000Z', checked: 2, refreshed: ['model_configs_v5.abcd.bin'], skipped: [], errors: [] };
  assert.deepEqual(publicState(fixture(), [], 'unavailable', 'ready', report).cliCache, report);
  assert.equal(publicState(fixture(), [], 'unavailable', 'ready').cliCache, null);
  assert.equal(publicState(fixture(), [], 'unavailable', 'ready', 'nonsense').cliCache, null);
});

test('public panel state exposes multiple providers and combinations without API credentials', async () => {
  const f = memory({ nativeModels: () => OBSERVED_SWE });
  const state = await f.manager.dispatch('ready');
  assert.equal(state.providers.length, 2);
  assert.equal(state.modelCount, 3);
  assert.ok(state.fusionCount > 0, 'the mirrored combinations are counted');
  assert.equal(state.roleLists.sidekick.filter(item => !item.native).length, 3);
  assert.equal(state.providers[0].keyConfigured, true);
  assert.equal(state.providers[0].baseUrl, 'https://cpa.invalid/v1');
  for (const secret of ['fixture-secret-cpa', 'fixture-secret-other', 'apiKey', 'Authorization']) assert.ok(!JSON.stringify(state).includes(secret));
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.changes, []);
  const input = fixture(); input.providers[1].apiKey = '';
  assert.equal(publicState(input).providers[1].keyConfigured, false);
});

test('an unselected native model never enters the combination pool', () => {
  const input = fixture();
  const catalog = buildCatalog(input, OBSERVED_SWE);
  assert.equal(catalog.rolePool.sidekick.some(item => item.ref.nativeUid === 'swe-unselected'), false);
  const selected = { ...input, roleInclusions: { lead: [], sidekick: [{ nativeUid: 'swe-unselected' }] } };
  const withNative = buildCatalog(selected, [...OBSERVED_SWE, { uid: 'swe-unselected', label: 'Unselected', disabled: false, isModelRouter: false, harnessUids: ['h'] }]);
  assert.equal(withNative.rolePool.sidekick.some(item => item.ref.nativeUid === 'swe-unselected'), true);
  assert.ok(Object.values(withNative.fusions).some(fusion => fusion.sidekickUid === 'swe-unselected'));
});

test('editing a provider preserves its models, blank existing key, and every other provider', async () => {
  const f = memory(), before = f.read();
  await f.manager.dispatch('saveProvider', providerPayload());
  const after = f.read();
  assert.deepEqual(after.providers[1], before.providers[1]);
  assert.equal(after.providers[0].id, 'cpa');
  assert.equal(after.providers[0].apiKey, 'fixture-secret-cpa');
  assert.equal(after.providers[0].baseUrl, 'https://new.invalid/v1');
  assert.equal(after.providers[0].apiFormat, 'openai');
  assert.equal(after.providers[0].models[0].label, 'Updated CPA · lead');
  assert.equal(after.providers[0].models[1].label, 'My executor');
  assert.deepEqual(after.sidekicks, before.sidekicks);
  assert.deepEqual(f.changes, ['saveProvider']);
});

test('a replacement key is stored only in private configuration and omitted keys preserve it', async () => {
  const f = memory();
  const state = await f.manager.dispatch('saveProvider', providerPayload({ apiKey: ' replacement-private-key ' }));
  assert.equal(f.read().providers[0].apiKey, 'replacement-private-key');
  assert.ok(!JSON.stringify(state).includes('replacement-private-key'));
  const next = providerPayload(); delete next.apiKey;
  await f.manager.dispatch('saveProvider', next);
  assert.equal(f.read().providers[0].apiKey, 'replacement-private-key');
});

test('adding a supplier never overwrites existing providers and accepts keyless local endpoints', async () => {
  const f = memory(), original = f.read().providers;
  await f.manager.dispatch('saveProvider', providerPayload({ id: undefined, name: 'Local', baseUrl: 'http://127.0.0.1:9123/v1/chat/completions' }));
  await f.manager.dispatch('saveProvider', providerPayload({ id: undefined, name: 'Local', baseUrl: 'https://another.invalid/v1' }));
  const next = f.read().providers;
  assert.deepEqual(next.slice(0, 2), original);
  assert.equal(next.length, 4);
  assert.notEqual(next[2].id, next[3].id);
  assert.match(next[2].id, /^provider-/);
  assert.equal(next[2].baseUrl, 'http://127.0.0.1:9123/v1');
  assert.equal(next[2].apiKey, '');
  assert.deepEqual(next[2].models, []);
});

test('manual models support independent display names, image support, limits, and effort variants', async () => {
  const f = memory();
  await f.manager.dispatch('addModel', { providerId: 'other', model: { id: 'manual-model', label: 'Custom',
    supportsImages: true, contextWindow: 500000, maxOutputTokens: 32000, efforts: ['low', 'high', 'high'] } });
  const added = f.read().providers[1].models.find(m => m.id === 'manual-model');
  assert.deepEqual(added, model('manual-model', { label: 'Custom', source: 'manual', supportsImages: true,
    contextWindow: 500000, maxOutputTokens: 32000, efforts: ['low', 'high'] }));
  assert.equal(f.manager.state().modelCount, 5);
  await f.manager.dispatch('addModel', { providerId: 'other', model: { id: 'manual-off', supportsImages: false } });
  assert.equal(f.read().providers[1].models.find(m => m.id === 'manual-off').supportsImages, true);
  const before = f.read();
  await assert.rejects(f.manager.dispatch('addModel', { providerId: 'other', model: { id: 'manual-model' } }), PanelInputError);
  assert.deepEqual(f.read(), before);
});

test('omitted output limits default to 131072 while explicit saved values and low context stay untouched', async () => {
  const f = memory();
  await f.manager.dispatch('addModel', { providerId: 'other', model: { id: 'default-limits' } });
  const added = f.read().providers[1].models.find(m => m.id === 'default-limits');
  assert.equal(added.maxOutputTokens, 131072);
  assert.equal(added.contextWindow, 272000);
  await f.manager.dispatch('addModel', { providerId: 'other', model: { id: 'explicit-32768', maxOutputTokens: 32768 } });
  assert.equal(f.read().providers[1].models.find(m => m.id === 'explicit-32768').maxOutputTokens, 32768);
  const input = fixture();
  input.providers[0].models[0].maxOutputTokens = 32768;
  const existing = memory({ config: input });
  await existing.manager.dispatch('ready');
  assert.equal(existing.read().providers[0].models[0].maxOutputTokens, 32768);
  const missing = fixture();
  missing.providers = [{ id: 'cpa', name: 'CPA', baseUrl: 'https://cpa.invalid/v1', apiFormat: 'openai', apiKey: '', enabled: true, models: [
    { id: 'missing-output', contextWindow: 272000 }, { id: 'low-context', contextWindow: 32000 }, { id: 'explicit-output', contextWindow: 272000, maxOutputTokens: 32768 }] }];
  missing.sidekicks = [];
  const state = publicState(missing);
  const byId = id => state.providers[0].models.find(m => m.id === id);
  assert.equal(byId('missing-output').maxOutputTokens, 131072);
  assert.equal(byId('low-context').maxOutputTokens, 32000);
  assert.equal(byId('explicit-output').maxOutputTokens, 32768);
});

test('model metadata edits preserve stable routing IDs and do not change another provider', async () => {
  const f = memory(), before = f.read(), previousRoutes = Object.keys(buildCatalog(before).routes);
  await f.manager.dispatch('updateModels', { providerId: 'cpa', changes: [{ id: 'lead', label: 'New display name',
    contextWindow: 400000, maxOutputTokens: 64000, supportsImages: true }] });
  const next = f.read();
  assert.deepEqual(Object.keys(buildCatalog(next).routes), previousRoutes);
  assert.deepEqual(next.providers[1], before.providers[1]);
  assert.equal(next.providers[0].models[0].label, 'New display name');
  assert.equal(next.providers[0].models[0].apiKey, undefined);
  await f.manager.dispatch('updateModels', { providerId: 'cpa', changes: [{ id: 'executor', supportsImages: false }] });
  assert.equal(f.read().providers[0].models.find(m => m.id === 'executor').supportsImages, true);
});

for (const action of ['disable-model', 'remove-model', 'disable-provider', 'delete-provider']) test(`${action} leaves a valid Fusion graph`, async () => {
  const input = fixture();
  const f = memory({ config: input });
  if (action === 'disable-model') await f.manager.dispatch('updateModels', { providerId: 'cpa', changes: [{ id: 'executor', enabled: false }] });
  if (action === 'remove-model') await f.manager.dispatch('updateModels', { providerId: 'cpa', removeIds: ['executor'] });
  if (action === 'disable-provider') await f.manager.dispatch('setProviderEnabled', { id: 'cpa', enabled: false });
  if (action === 'delete-provider') await f.manager.dispatch('deleteProvider', { id: 'cpa' });
  const next = f.read();
  const catalog = assertValidGraph(next);
  assert.ok(Object.values(catalog.routes).every(route => route.model !== 'executor'));
  assert.ok(Object.values(catalog.routes).some(route => route.providerId === 'other'));
  assert.ok(Object.values(catalog.fusions).every(fusion => fusion.sidekickNative || catalog.routes[fusion.sidekickUid].model !== 'executor'));
});

test('disabling then re-enabling a provider preserves its keys and configured model list', async () => {
  const f = memory(), previous = f.read().providers[0];
  await f.manager.dispatch('setProviderEnabled', { id: 'cpa', enabled: false });
  assert.equal(f.manager.state().modelCount, 1);
  await f.manager.dispatch('setProviderEnabled', { id: 'cpa', enabled: true });
  assert.equal(f.manager.state().modelCount, 3);
  assert.deepEqual(f.read().providers[0], previous);
});

test('any enabled third-party model may be a Sidekick together with an eligible observed native', async () => {
  const f = memory({ nativeModels: () => OBSERVED_SWE });
  const catalog = assertValidGraph(f.read(), OBSERVED_SWE);
  assert.ok(Object.keys(catalog.fusions).length > 0, 'selected BYOK and native roles are mirrored');
  assert.deepEqual(new Set(catalog.rolePool.sidekick.filter(item => !item.ref.nativeUid).map(item => item.ref.model)),
    new Set(['lead', 'executor', 'other-lead']));
});

test('Sidekick role selection rejects missing, disabled, and unobserved native models without changing config', async () => {
  const input = fixture(); input.providers[1].models[0].enabled = false;
  const f = memory({ config: input }), before = f.read();
  for (const model of [{ providerId: 'missing', model: 'x' }, { providerId: 'cpa', model: 'missing' },
    { providerId: 'other', model: 'other-lead' }, { nativeUid: 'swe-2-medium' }, { nativeUid: 'swe-2-max' }, null, 'x', {}]) {
    await assert.rejects(f.manager.dispatch('setRoleModel', { role: 'sidekick', enabled: true, model }), PanelInputError);
    assert.deepEqual(f.read(), before);
  }
  assert.equal(f.writes.length, 0);
  const state = await f.manager.dispatch('ready');
  assert.ok(state.sidekicks.filter(item => item.providerId).length > 0, 'provider models stay automatic Sidekick candidates');
});

test('fetching candidates never imports or removes models; confirmation adds only selected models', async () => {
  const input = fixture();
  input.providers[0].models = [model('lead', { enabled: false, label: 'Keep this label', efforts: ['high'] }),
    model('gone-import'), model('manual-only', { source: 'manual', label: 'Private deployment' })];
  const f = memory({ config: input, discover: async provider => {
    assert.equal(provider.apiKey, 'fixture-secret-cpa');
    provider.models = [model('lead', { label: 'Provider label' }), model('new-import'), model('not-selected')];
  } });
  const other = f.read().providers[1];
  const initial = f.read();
  const preview = await f.manager.dispatch('refreshModels', { providerId: 'cpa' });
  assert.deepEqual(f.read(), initial);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.changes, []);
  assert.deepEqual(preview.importCandidates.models.map(m => [m.id, m.imported]), [['lead', true], ['new-import', false], ['not-selected', false]]);
  assert.ok(!JSON.stringify(preview).includes('fixture-secret'));
  await f.manager.dispatch('importModels', { providerId: 'cpa', token: preview.importCandidates.token, ids: ['new-import'] });
  const next = f.read();
  assert.deepEqual(next.providers[0].models.map(m => m.id), ['lead', 'gone-import', 'manual-only', 'new-import']);
  assert.deepEqual(next.providers[0].models[0], input.providers[0].models[0]);
  assert.deepEqual(next.providers[0].models[2], input.providers[0].models[2]);
  assert.deepEqual(next.providers[1], other);
  assert.equal(f.manager.state().importCandidates, null);
  assertValidGraph(next);
});

test('refresh applies results to fresh state while preserving concurrent model and unrelated provider edits', async () => {
  const f = memory({ discover: async provider => {
    f.externalChange(current => {
      current.providers[0].models[0].enabled = false;
      current.providers[0].models[0].label = 'Changed in another window';
      current.providers[0].models.push(model('manual-concurrent', { source: 'manual' }));
      current.providers[1].apiKey = 'new-key-in-another-window';
    });
    provider.models = [model('lead'), model('new-import')];
  } });
  await f.manager.dispatch('refreshModels', { providerId: 'cpa' });
  const preview = f.manager.state().importCandidates;
  f.externalChange(current => { current.providers[0].models.push(model('new-import', { label: 'Added concurrently', enabled: false })); });
  await f.manager.dispatch('importModels', { providerId: 'cpa', token: preview.token, ids: ['new-import'] });
  const next = f.read();
  assert.equal(next.providers[0].models[0].enabled, false);
  assert.equal(next.providers[0].models[0].label, 'Changed in another window');
  assert.ok(next.providers[0].models.some(m => m.id === 'manual-concurrent'));
  assert.equal(next.providers[1].apiKey, 'new-key-in-another-window');
  assert.deepEqual(next.sidekicks, fixture().sidekicks);
  assert.equal(next.providers[0].models.filter(m => m.id === 'new-import').length, 1);
  assert.equal(next.providers[0].models.find(m => m.id === 'new-import').label, 'Added concurrently');
  assert.equal(next.providers[0].models.find(m => m.id === 'new-import').enabled, false);
});

for (const field of ['apiKey', 'baseUrl', 'apiFormat']) test(`refresh rejects stale results when another window changes ${field}`, async () => {
  const f = memory({ discover: async provider => {
    provider.models = [model('should-not-commit')];
    f.externalChange(current => { current.providers[0][field] = field === 'apiFormat' ? 'openai' : field === 'baseUrl' ? 'https://changed.invalid/v1' : 'replacement-secret'; });
  } });
  await assert.rejects(f.manager.dispatch('refreshModels', { providerId: 'cpa' }), PanelInputError);
  const next = f.read();
  assert.ok(!next.providers[0].models.some(m => m.id === 'should-not-commit'));
  assert.notEqual(next.providers[0][field], fixture().providers[0][field]);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.changes, []);
});

test('refresh cannot resurrect a provider deleted while discovery is pending', async () => {
  const f = memory({ discover: async provider => {
    provider.models = [model('should-not-commit')];
    f.externalChange(current => { current.providers = current.providers.filter(p => p.id !== 'cpa'); current.sidekicks = [nativeSidekick]; });
  } });
  await assert.rejects(f.manager.dispatch('refreshModels', { providerId: 'cpa' }), PanelInputError);
  assert.deepEqual(f.read().providers.map(p => p.id), ['other']);
  assert.equal(f.writes.length, 0);
});

test('failed or graph-invalid discovery never commits a partially refreshed configuration', async () => {
  for (const discover of [async provider => { provider.models = []; throw new Error('Fixture network failure'); },
    async provider => { provider.models = [model('duplicate'), model('duplicate')]; },
    async provider => { provider.models = [{ id: '' }]; }]) {
    const f = memory({ discover }), before = f.read();
    await assert.rejects(f.manager.dispatch('refreshModels', { providerId: 'cpa' }));
    assert.deepEqual(f.read(), before);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.changes, []);
  }
});

test('a model batch is validated as a whole before any persistent write', async () => {
  const f = memory(), before = f.read();
  await assert.rejects(f.manager.dispatch('updateModels', { providerId: 'cpa', changes: [
    { id: 'lead', label: 'Should not persist' }, { id: 'executor', contextWindow: 1000, maxOutputTokens: 1001 },
  ] }), PanelInputError);
  assert.deepEqual(f.read(), before);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.changes, []);
});

test('Fusion selection validates a currently available combination without writing provider configuration', async () => {
  const input = fixture();
  const f = memory({ config: input }), uid = Object.keys(buildCatalog(f.read()).fusions)[0];
  const state = await f.manager.dispatch('selectFusion', { uid });
  assert.deepEqual(f.selections, [uid]);
  assert.equal(state.enabled, true);
  assert.equal(f.writes.length, 0);
  for (const invalid of ['', 'swe-2-max', '__proto__', 'constructor', 'fusion-dfbyok-missing']) {
    await assert.rejects(f.manager.dispatch('selectFusion', { uid: invalid }), PanelInputError);
  }
  await f.manager.dispatch('setEnabled', { enabled: false });
  await assert.rejects(f.manager.dispatch('selectFusion', { uid }), PanelInputError);
  assert.deepEqual(f.selections, [uid]);
});

test('a disabled or removed Lead cannot remain selectable through a stale Fusion UID', async () => {
  const f = memory({ config: fixture() }), catalog = buildCatalog(f.read());
  const uid = Object.values(catalog.fusions).find(fusion => catalog.routes[fusion.leadUid].model === 'lead').uid;
  await f.manager.dispatch('updateModels', { providerId: 'cpa', changes: [{ id: 'lead', enabled: false }] });
  await assert.rejects(f.manager.dispatch('selectFusion', { uid }), PanelInputError);
  assert.deepEqual(f.selections, []);
});

test('invalid messages and fields fail safely, do not write, and do not poison subsequent queued commands', async () => {
  const f = memory(), before = f.read();
  const invalid = [
    ['unknownAction', {}], ['ready', null], ['ready', []], ['ready', 'string'],
    ['setEnabled', { enabled: 'false' }], ['setProviderEnabled', { id: 'cpa', enabled: 0 }],
    ['saveProvider', providerPayload({ name: ' ' })],
    ['saveProvider', providerPayload({ baseUrl: 'file:///tmp/not-an-api' })],
    ['saveProvider', providerPayload({ baseUrl: 'https://user:password@invalid.example/v1' })],
    ['saveProvider', providerPayload({ baseUrl: 'https://invalid.example/v1?secret=value' })],
    ['saveProvider', providerPayload({ apiFormat: 'arbitrary' })],
    ['saveProvider', providerPayload({ apiKey: 'key\r\nX-Injected: value' })],
    ['saveProvider', providerPayload({ apiKey: 17 })],
    ['updateModels', { providerId: 'cpa', changes: 'invalid' }],
    ['updateModels', { providerId: 'cpa', changes: [null] }],
    ['updateModels', { providerId: 'cpa', changes: [{ id: 'lead', efforts: ['anything'] }] }],
    ['updateModels', { providerId: 'cpa', changes: [{ id: 'lead', supportsImages: 'yes' }] }],
    ['updateModels', { providerId: 'cpa', changes: [{ id: 'lead', maxOutputTokens: -1 }] }],
    ['updateModels', { providerId: 'cpa', changes: [{ id: 'lead', contextWindow: 1.5 }] }],
    ['addModel', { providerId: 'cpa', model: { id: '' } }],
    ['deleteProvider', { id: 'missing' }],
  ];
  for (const [type, payload] of invalid) {
    await assert.rejects(f.manager.dispatch(type, payload), PanelInputError, type);
    assert.deepEqual(f.read(), before, type);
  }
  assert.equal(f.writes.length, 0);
  await f.manager.dispatch('setEnabled', { enabled: false });
  assert.equal(f.manager.state().enabled, false);
  assert.equal(f.writes.length, 1);
});

test('manager serializes asynchronous refreshes before later edits to avoid lost updates', async () => {
  let release, started;
  const begin = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = memory({ discover: async provider => {
    started(); await gate; provider.models = [model('lead'), model('executor'), model('new-import')];
  } });
  const refresh = f.manager.dispatch('refreshModels', { providerId: 'cpa' });
  await begin;
  const edit = f.manager.dispatch('updateModels', { providerId: 'cpa', changes: [{ id: 'lead', enabled: false }] });
  assert.equal(f.writes.length, 0);
  release(); await Promise.all([refresh, edit]);
  assert.equal(f.read().providers[0].models.find(m => m.id === 'lead').enabled, false);
  assert.equal(f.read().providers[0].models.some(m => m.id === 'new-import'), false);
  assert.deepEqual(f.changes, ['updateModels']);
  assert.equal(f.writes.length, 1);
});

test('import requires a current preview and rejects empty, duplicate, invented and cross-provider selections', async () => {
  const f = memory({ discover: async provider => { provider.models = [model('a'), model('b')]; } });
  const initial = f.read();
  await assert.rejects(f.manager.dispatch('importModels', { providerId: 'cpa', token: 'invented', ids: ['a'] }), PanelInputError);
  const { importCandidates: preview } = await f.manager.dispatch('refreshModels', { providerId: 'cpa' });
  for (const ids of [[], ['a', 'a'], ['invented'], [null], 'a']) {
    await assert.rejects(f.manager.dispatch('importModels', { providerId: 'cpa', token: preview.token, ids }), PanelInputError);
  }
  await assert.rejects(f.manager.dispatch('importModels', { providerId: 'other', token: preview.token, ids: ['a'] }), PanelInputError);
  assert.deepEqual(f.read(), initial);
  assert.equal(f.writes.length, 0);
  const second = await f.manager.dispatch('refreshModels', { providerId: 'cpa' });
  await assert.rejects(f.manager.dispatch('importModels', { providerId: 'cpa', token: preview.token, ids: ['a'] }), PanelInputError);
  await f.manager.dispatch('importModels', { providerId: 'cpa', token: second.importCandidates.token, ids: ['b'] });
  assert.deepEqual(f.read().providers[0].models.map(m => m.id), ['lead', 'executor', 'b']);
});

for (const field of ['apiKey', 'baseUrl', 'apiFormat']) test(`import rejects a preview after provider ${field} changes`, async () => {
  const f = memory({ discover: async provider => { provider.models = [model('new')]; } });
  const { importCandidates: preview } = await f.manager.dispatch('refreshModels', { providerId: 'cpa' });
  f.externalChange(current => { current.providers[0][field] = field === 'apiFormat' ? 'openai' : 'changed'; });
  assert.equal(f.manager.state().importCandidates, null);
  await assert.rejects(f.manager.dispatch('importModels', { providerId: 'cpa', token: preview.token, ids: ['new'] }), PanelInputError);
  assert.equal(f.writes.length, 0);
});

const nativeMember = (state, uid) => (state.nativeFamilies || []).flatMap(family => family.members).find(member => member.uid === uid);
const nativeMembers = state => (state.nativeFamilies || []).flatMap(family => family.members);

test('native model hide and restore persist a validated exclusion list with observed status', async () => {
  const observed = [
    { uid: 'swe-2-max', label: 'Official SWE', disabled: false },
    { uid: 'claude-x', label: 'Claude X', disabled: true },
  ];
  const f = memory({ nativeModels: () => observed });
  let state = await f.manager.dispatch('ready');
  assert.deepEqual(nativeMembers(state), [
    { uid: 'claude-x', label: 'Claude X', disabled: true, hidden: false, eligible: false },
    { uid: 'swe-2-max', label: 'Official SWE', disabled: false, hidden: false, eligible: false },
  ], 'families are emitted in vendor order, not observation order');
  state = await f.manager.dispatch('setNativeModelHidden', { uid: 'swe-2-max', hidden: true });
  assert.deepEqual(f.read().hiddenNativeModelUids, ['swe-2-max']);
  assert.equal(nativeMember(state, 'swe-2-max').hidden, true);
  assert.equal(nativeMember(state, 'claude-x').hidden, false);
  assert.deepEqual(f.changes, ['setNativeModelHidden']);
  state = await f.manager.dispatch('setNativeModelHidden', { uid: 'swe-2-max', hidden: false });
  assert.deepEqual(f.read().hiddenNativeModelUids, []);
  assert.equal(nativeMember(state, 'swe-2-max').hidden, false);
});

test('native visibility rejects unobserved, own and malformed uids and non-boolean flags without writes', async () => {
  const observed = [{ uid: 'swe-2-max', label: 'SWE', disabled: false }];
  const f = memory({ nativeModels: () => observed });
  const before = f.read();
  for (const payload of [
    { uid: 'claude-x', hidden: true },
    { uid: 'dfbyok-cpa-lead-x', hidden: true },
    { uid: 'fusion-dfbyok-x', hidden: true },
    { uid: '', hidden: true },
    { uid: 42, hidden: true },
    { uid: 'x'.repeat(300), hidden: true },
    { uid: 'swe-2-max', hidden: 'yes' },
    { uid: 'swe-2-max', hidden: 1 },
    { uid: 'swe-2-max' },
  ]) {
    await assert.rejects(f.manager.dispatch('setNativeModelHidden', payload), PanelInputError, JSON.stringify(payload));
  }
  assert.deepEqual(f.read(), before);
  assert.equal(f.writes.length, 0);
});

test('previously hidden uids stay listed for restore and dedupe or drop invalid config entries', async () => {
  const observed = [{ uid: 'swe-2-max', label: 'SWE', disabled: false }];
  const input = fixture();
  input.hiddenNativeModelUids = ['gone-native', 'gone-native', 42, 'dfbyok-own', '', 'gone-native-2'];
  const f = memory({ config: input, nativeModels: () => observed });
  const state = await f.manager.dispatch('ready');
  assert.deepEqual(nativeMembers(state).filter(entry => entry.hidden).map(entry => entry.uid), ['gone-native', 'gone-native-2']);
  assert.equal(nativeMember(state, 'gone-native').label, 'gone-native');
  assert.ok(!nativeMembers(state).some(entry => entry.uid === 'dfbyok-own'));
  const next = await f.manager.dispatch('setNativeModelHidden', { uid: 'gone-native', hidden: false });
  assert.deepEqual(f.read().hiddenNativeModelUids, ['gone-native-2']);
  assert.equal(nativeMember(next, 'gone-native'), undefined);
  assert.equal(nativeMember(next, 'gone-native-2').hidden, true);
});

test('hiding a native model never touches provider data', async () => {
  const observed = [{ uid: 'swe-2-max', label: 'SWE', disabled: false }];
  const f = memory({ nativeModels: () => observed });
  const before = f.read();
  await f.manager.dispatch('setNativeModelHidden', { uid: 'swe-2-max', hidden: true });
  const next = f.read();
  assert.deepEqual(next.providers, before.providers);
  assert.deepEqual(next.sidekicks, before.sidekicks);
});

test('observed native Sidekick eligibility drives state flags, combinations and role selection', async () => {
  const observed = [
    ...OBSERVED_SWE,
    { uid: 'swe-2-medium', label: 'Medium', disabled: false, isModelRouter: false, harnessUids: ['swe-1p5'] },
    { uid: 'fusion-lead-a-sidekick-swe-2-medium', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 1, name: 'SWE-2 Medium' } },
    { uid: 'swe-disabled', label: 'Off', disabled: true, isModelRouter: false, harnessUids: ['swe-1p6'] },
    { uid: 'swe-router', label: 'Router', disabled: false, isModelRouter: true, harnessUids: ['swe-1p6'] },
    { uid: 'swe-naked', label: 'Naked', disabled: false },
    { uid: 'swe-other-harness', label: 'Other', disabled: false, isModelRouter: false, harnessUids: ['unknown-harness'] },
  ];
  const f = memory({ nativeModels: () => observed });
  const state = await f.manager.dispatch('ready');
  assert.deepEqual(nativeMembers(state).filter(entry => entry.eligible).map(entry => entry.uid).sort(), ['swe-2-max', 'swe-2-medium', 'swe-other-harness']);
  assert.equal(nativeMember(state, 'swe-naked').eligible, false);
  const catalog = assertValidGraph(f.read(), observed);
  assert.ok(Object.keys(catalog.fusions).length > 0, 'selected roles are mirrored');
  const excluded = await f.manager.dispatch('setRoleModel', { role: 'sidekick', enabled: false, model: { nativeUid: 'swe-2-medium' } });
  assert.ok(excluded.fusionCount < state.fusionCount, 'excluding a Sidekick removes its combinations');
  assert.ok(!Object.values(buildCatalog(f.read(), observed).fusions).some(fusion => fusion.sidekickUid === 'swe-2-medium'));
  for (const uid of ['swe-disabled', 'swe-router', 'swe-naked', 'swe-never-seen']) {
    await assert.rejects(f.manager.dispatch('setRoleModel', { role: 'sidekick', enabled: true, model: { nativeUid: uid } }), PanelInputError, uid);
  }
  const included = await f.manager.dispatch('setRoleModel', { role: 'sidekick', enabled: true, model: { nativeUid: 'swe-other-harness' } });
  assert.ok(included.roleLists.sidekick.some(item => item.ref.nativeUid === 'swe-other-harness' && item.selected));
});

test('forgetRoleRef clears a dead native ref only once the catalog is ready', async () => {
  const input = fixture();
  input.roleExclusions = { lead: [], sidekick: [{ nativeUid: 'gone-uid' }] };
  input.roleInclusions = { lead: [{ nativeUid: 'gone-uid' }], sidekick: [] };
  const pending = memory({ config: input, nativeModels: () => OBSERVED_SWE });
  await assert.rejects(pending.manager.dispatch('forgetRoleRef', { role: 'sidekick', model: { nativeUid: 'gone-uid' } }), PanelInputError);
  const f = memory({ config: input, nativeModels: () => OBSERVED_SWE, nativeCatalogStatus: () => 'ready' });
  const state = await f.manager.dispatch('forgetRoleRef', { role: 'sidekick', model: { nativeUid: 'gone-uid' } });
  assert.ok(!state.roleLists.sidekick.some(item => item.ref.nativeUid === 'gone-uid'));
  assert.equal(f.read().roleExclusions, undefined, 'both now-empty exclusion lists are pruned');
  assert.deepEqual(f.read().roleInclusions, { lead: [{ nativeUid: 'gone-uid' }] },
    'the forgotten ref leaves the other role and the inclusion list untouched');
});

test('a hidden observed native is excluded from Sidekick eligibility and selection', async () => {
  const input = fixture();
  input.hiddenNativeModelUids = ['swe-2-max'];
  const f = memory({ config: input, nativeModels: () => OBSERVED_SWE });
  const state = await f.manager.dispatch('ready');
  assert.equal(nativeMember(state, 'swe-2-max').eligible, false);
  const catalog = buildCatalog(f.read(), OBSERVED_SWE);
  assert.equal(Object.values(catalog.fusions).filter(fusion => fusion.sidekickNative).length, 0);
  await f.manager.dispatch('setNativeModelHidden', { uid: 'swe-2-max', hidden: false });
  const restored = await f.manager.dispatch('ready');
  assert.equal(nativeMember(restored, 'swe-2-max').eligible, true);
});

test('officially paired and standalone unlocked natives are offered as Sidekick candidates', async () => {
  const observed = [
    { uid: 'gpt-5-6-luna-high', label: 'GPT-5.6 Luna High Thinking', disabled: false, isModelRouter: false, harnessUids: ['gpt-5p6'] },
    { uid: 'swe-odd', label: 'Odd', disabled: false, isModelRouter: false, harnessUids: ['odd-harness'] },
    { uid: 'fusion-official-sidekick-gpt-5-6-luna-high', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'],
      sidekickDimension: { order: 4, name: 'GPT-5.6 Luna High' } },
  ];
  const f = memory({ nativeModels: () => observed });
  const state = publicState(fixture(), observed);
  assert.equal(nativeMember(state, 'gpt-5-6-luna-high').eligible, true);
  assert.equal(nativeMember(state, 'swe-odd').eligible, true,
    'an unlocked standalone native is eligible for named presets');
  assert.ok(state.sidekicks.some(item => item.nativeUid === 'gpt-5-6-luna-high'));
  const disabled = observed.map(item => item.uid === 'swe-odd' ? { ...item, disabled: true } : item);
  assert.equal(nativeMember(publicState(fixture(), disabled), 'swe-odd').eligible, false);
  const saved = await f.manager.dispatch('setRoleModel', { role: 'sidekick', enabled: true, model: { nativeUid: 'gpt-5-6-luna-high' } });
  assert.ok(saved.roleLists.sidekick.some(item => item.ref.nativeUid === 'gpt-5-6-luna-high' && item.selected));
  assert.ok(Object.values(buildCatalog(f.read(), observed).fusions).some(fusion => fusion.sidekickUid === 'gpt-5-6-luna-high'));
});

test('setUpdateProxy writes, echoes, clears and rejects bad input', async () => {
  const f = memory();
  let state = await f.manager.dispatch('setUpdateProxy', { value: ' http://127.0.0.1:7897 ' });
  assert.equal(state.updateProxy, 'http://127.0.0.1:7897');
  assert.equal(f.read().updateProxy, 'http://127.0.0.1:7897');
  state = await f.manager.dispatch('setUpdateProxy', { value: '' });
  assert.equal(state.updateProxy, '');
  assert.equal('updateProxy' in f.read(), false);
  const writesBefore = f.writes.length;
  for (const value of ['socks5://127.0.0.1:9', 'ftp://127.0.0.1:21', 'not a url', 42, null, undefined]) {
    await assert.rejects(f.manager.dispatch('setUpdateProxy', { value }), PanelInputError);
  }
  assert.equal(f.writes.length, writesBefore, 'rejected input is never written');
  assert.equal('updateProxy' in f.read(), false);
});

test('setUpdateProxy masks credentials and keeps them when the mask is saved back', async () => {
  const f = memory();
  let state = await f.manager.dispatch('setUpdateProxy', { value: 'http://user:s3cret@127.0.0.1:7897' });
  assert.equal(state.updateProxy, 'http://***@127.0.0.1:7897', 'the panel only ever sees the mask');
  assert.equal(f.read().updateProxy, 'http://user:s3cret@127.0.0.1:7897');
  const writesBefore = f.writes.length;
  state = await f.manager.dispatch('setUpdateProxy', { value: 'http://***@127.0.0.1:7897' });
  assert.equal(f.writes.length, writesBefore, 'saving the displayed mask leaves the stored secret untouched');
  assert.equal(f.read().updateProxy, 'http://user:s3cret@127.0.0.1:7897');
  assert.equal(state.updateProxy, 'http://***@127.0.0.1:7897');
  state = await f.manager.dispatch('setUpdateProxy', { value: 'http://other:pw@10.0.0.1:3128' });
  assert.equal(f.read().updateProxy, 'http://other:pw@10.0.0.1:3128', 'a new full URL replaces the credentials');
  assert.equal(state.updateProxy, 'http://***@10.0.0.1:3128');
  await f.manager.dispatch('setUpdateProxy', { value: '' });
  assert.equal('updateProxy' in f.read(), false);
});

test('the panel can ask for a CLI cache refresh and reports the result it got', async () => {
  const calls = [];
  const report = { at: '2026-10-14T12:00:00.000Z', checked: 1, refreshed: ['model_configs_v5.abcd.bin'], skipped: [], errors: [] };
  const f = memory({ refreshCliCaches: async () => { calls.push('refresh'); return report; }, cliCacheStatus: () => report });
  const state = await f.manager.dispatch('refreshCliCaches');
  assert.deepEqual(calls, ['refresh']);
  assert.deepEqual(state.cliCache, report);
});

test('a CLI cache refresh is refused while disabled or unsupported', async () => {
  await assert.rejects(memory().manager.dispatch('refreshCliCaches'), PanelInputError, 'no refresher is wired in');
  const disabled = memory({ config: { ...fixture(), enabled: false }, refreshCliCaches: async () => ({ checked: 1, refreshed: [], skipped: [], errors: [] }) });
  await assert.rejects(disabled.manager.dispatch('refreshCliCaches'), PanelInputError);
});

test('publicState groups observed natives into server families without fusion entries', () => {
  const effort = (order, name) => ({ key: 'Effort', order, name, controlType: 1 });
  const ctx1m = { key: '1M Context', order: 1, name: '', controlType: 2 };
  const thinking = { key: 'Thinking', order: 1, name: '', controlType: 2 };
  const fast = { key: 'Fast Mode', order: 1, name: '', controlType: 2 };
  const glm = [
    { uid: 'glm-5-2', label: 'GLM-5.2 High', fusionMetadata: [effort(1, 'High')] },
    { uid: 'glm-5-2-max', label: 'GLM-5.2 Max', fusionMetadata: [effort(2, 'Max')] },
    { uid: 'glm-5-2-none', label: 'GLM-5.2 No Thinking', fusionMetadata: [effort(0, 'No Thinking')] },
    { uid: 'glm-5-2-1m', label: 'GLM-5.2 High 1M', fusionMetadata: [effort(1, 'High'), ctx1m] },
    { uid: 'glm-5-2-max-1m', label: 'GLM-5.2 Max 1M', fusionMetadata: [effort(2, 'Max'), ctx1m] },
    { uid: 'glm-5-2-none-1m', label: 'GLM-5.2 No Thinking 1M', fusionMetadata: [effort(0, 'No Thinking'), ctx1m] },
  ].map(entry => ({ ...entry, disabled: false, isModelRouter: false, harnessUids: ['h'], familyUid: 'glm-5.2' }));
  const claude = [
    { uid: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { uid: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 Thinking', fusionMetadata: [thinking] },
    { uid: 'claude-opus-4-6-1m', label: 'Claude Opus 4.6 1M', fusionMetadata: [ctx1m] },
    { uid: 'claude-opus-4-6-thinking-1m', label: 'Claude Opus 4.6 Thinking 1M', fusionMetadata: [thinking, ctx1m] },
  ].map(entry => ({ ...entry, disabled: false, isModelRouter: false, harnessUids: ['h'], familyUid: 'claude-opus-4.6' }));
  const observed = [...glm, ...claude,
    { uid: 'swe-1-6-fast', label: 'SWE-1.6 Fast', disabled: false, isModelRouter: false, harnessUids: ['h'], familyUid: 'swe-1.6-fast' },
    { uid: 'claude-x', label: 'Claude X', disabled: false, isModelRouter: false, harnessUids: ['h'], familyUid: '  padded-family  ' },
    { uid: 'solo-a', label: 'Solo A', disabled: false, isModelRouter: false, harnessUids: ['h'] },
    { uid: 'fusion-official-x', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], familyUid: 'fusion-family' },
    { uid: 'dfbyok-provider-a-model', label: 'Own', disabled: false, isModelRouter: false, harnessUids: [] }];
  const input = fixture();
  input.hiddenNativeModelUids = ['glm-5-2-max'];
  const state = publicState(input, observed);
  assert.ok(state.nativeFamilies, 'the panel state exposes families');
  assert.equal(state.nativeModels, undefined, 'the flat list is replaced by the family list');
  assert.ok(!nativeMembers(state).some(member => member.uid.startsWith('fusion-') || member.uid.startsWith('dfbyok-')),
    'combination and own entries never appear in the settings list');

  const glm5 = state.nativeFamilies.find(family => family.id === 'glm-5.2');
  assert.equal(glm5.label, 'GLM-5.2');
  assert.equal(glm5.variants, 6);
  assert.deepEqual(glm5.efforts, ['No Thinking', 'High', 'Max'], 'efforts are deduped and sorted by order');
  assert.deepEqual(glm5.toggles, ['1M Context']);
  assert.equal(glm5.hidden, true, 'one hidden member marks the whole family hidden');
  assert.deepEqual(glm5.members.find(member => member.uid === 'glm-5-2-max').hidden, true);

  const opus = state.nativeFamilies.find(family => family.id === 'claude-opus-4.6');
  assert.equal(opus.label, 'Claude Opus 4.6');
  assert.equal(opus.variants, 4);
  assert.deepEqual(opus.toggles, ['1M Context', 'Thinking'], 'toggles are deduped and name-sorted');

  const fastSwe = state.nativeFamilies.find(family => family.id === 'swe-1.6-fast');
  assert.equal(fastSwe.label, 'SWE-1.6 Fast', 'a single-member family keeps its own label unstripped');
  const solo = state.nativeFamilies.find(family => family.id === 'uid:solo-a');
  assert.equal(solo.label, 'Solo A', 'a missing family uid falls back to a one-member family');
  const padded = state.nativeFamilies.find(family => family.id === 'padded-family');
  assert.equal(padded.label, 'Claude X', 'the observed family uid is used as trimmed');
  const labels = state.nativeFamilies.map(family => family.label);
  assert.equal(new Set(labels).size, labels.length, 'family labels stay unique');

  assert.equal(glm5.vendor, 'Zhipu AI');
  assert.equal(opus.vendor, 'Anthropic');
  assert.equal(fastSwe.vendor, 'Devin');
  assert.equal(solo.vendor, '其他', 'an unrecognized uid falls into the catch-all vendor');
  const vendorRank = id => ['Anthropic', 'OpenAI', 'Google', 'xAI', 'DeepSeek', 'Moonshot', 'Zhipu AI',
    'NVIDIA', 'Mistral', 'Meta', 'Alibaba', 'MiniMax', 'Devin', '其他'].indexOf(state.nativeFamilies.find(family => family.id === id).vendor);
  const ranks = state.nativeFamilies.map(family => vendorRank(family.id));
  assert.deepEqual([...ranks].sort((a, b) => a - b), ranks, 'families are sorted by vendor order');

  const allHidden = state.nativeFamilies.find(family => family.id === 'uid:solo-a').hidden;
  assert.equal(allHidden, false);
});

test('families no picker can select are classified as internal entries', async () => {
  const observed = [
    { uid: 'swe-2-high', label: 'SWE-2 High', disabled: false, isModelRouter: false, harnessUids: ['h'], familyUid: 'swe-2' },
    { uid: 'adaptive', label: 'Adaptive', disabled: false, isModelRouter: true, harnessUids: [] },
    { uid: 'astra-high', label: 'Astra High', disabled: false, isModelRouter: false, harnessUids: [], familyUid: 'astra',
      fusionMetadata: [{ key: 'Effort', order: 1, name: 'High' }] },
    { uid: 'opus-review', label: 'Opus Review', disabled: false, isModelRouter: false, harnessUids: [] },
    { uid: 'private-1', label: 'Private One', disabled: false, isModelRouter: false, harnessUids: [] },
  ];
  const state = publicState(fixture(), observed);
  const byId = id => state.nativeFamilies.find(family => family.id === id);
  assert.equal(byId('swe-2').internal, false, 'a harnessed model is picker-selectable');
  assert.equal(byId('uid:adaptive').internal, true, 'router cards fold into internal — they are routing surfaces, not models');
  assert.equal(byId('astra').internal, false, 'declared fusion dimensions make a sourceless harnessless model selectable');
  assert.equal(byId('uid:opus-review').internal, true, 'no harness, dimensions or router flag means internal');
  assert.equal(byId('uid:private-1').internal, true);
});

test('picker visibility uses kind enum, observation source and the listed flag', async () => {
  const observed = [
    { uid: 'review-a', label: 'Review A', disabled: false, isModelRouter: false, harnessUids: ['h'], kind: 4, sources: ['cli'] },
    { uid: 'route-a', label: 'Route A', disabled: false, isModelRouter: true, harnessUids: [], kind: 6, sources: ['cli'] },
    { uid: 'legacy-listed', label: 'Legacy Listed', disabled: false, isModelRouter: false, harnessUids: [], listed: true, sources: ['entitlement'] },
    { uid: 'legacy-retired', label: 'Legacy Retired', disabled: false, isModelRouter: false, harnessUids: [],
      fusionMetadata: [{ key: 'Effort', order: 1, name: 'High' }], sources: ['entitlement'] },
    { uid: 'command-only', label: 'Command Only', disabled: false, isModelRouter: false, harnessUids: ['h'], sources: ['command'] },
    { uid: 'cli-dim', label: 'Cli Dim', disabled: false, isModelRouter: false, harnessUids: [],
      fusionMetadata: [{ key: 'Effort', order: 1, name: 'High' }], sources: ['cli', 'entitlement'] },
  ];
  const state = publicState(fixture(), observed);
  const byId = id => state.nativeFamilies.find(family => family.id === 'uid:' + id);
  assert.equal(byId('review-a').internal, true, 'kind 4 review rows stay internal even inside a catalog');
  assert.equal(byId('route-a').internal, true, 'kind 6 routing pseudo-entries stay internal');
  assert.equal(byId('legacy-listed').internal, false, 'the listed flag keeps an entitlement-only row visible');
  assert.equal(byId('legacy-retired').internal, true, 'dimensions observed only via entitlement do not make a picker row');
  assert.equal(byId('command-only').internal, true, 'command-catalog-only entries are not in the model picker');
  assert.equal(byId('cli-dim').internal, false, 'a selectable-catalog observation makes a harnessless dimension member visible');
});

test('hiding is family-level: any hidden member marks the whole family hidden', async () => {
  const observed = [
    { uid: 'x-high', label: 'X High', disabled: false, isModelRouter: false, harnessUids: ['h'], familyUid: 'x' },
    { uid: 'x-max', label: 'X Max', disabled: false, isModelRouter: false, harnessUids: ['h'], familyUid: 'x' },
    { uid: 'y', label: 'Y', disabled: false, isModelRouter: false, harnessUids: ['h'], familyUid: 'y' },
  ];
  const f = memory({ nativeModels: () => observed });
  let state = await f.manager.dispatch('setNativeModelHidden', { uids: ['x-high', 'x-max'], hidden: true });
  assert.deepEqual(f.read().hiddenNativeModelUids, ['x-high', 'x-max']);
  const family = state.nativeFamilies.find(item => item.id === 'x');
  assert.equal(family.hidden, true);
  state = await f.manager.dispatch('setNativeModelHidden', { uid: 'x-high', hidden: false });
  assert.deepEqual(f.read().hiddenNativeModelUids, ['x-max']);
  const partial = state.nativeFamilies.find(item => item.id === 'x');
  assert.equal(partial.hidden, true, 'a leftover hidden uid still hides the family');
  state = await f.manager.dispatch('setNativeModelHidden', { uids: ['x-high', 'x-max'], hidden: false });
  assert.deepEqual(f.read().hiddenNativeModelUids, []);
  assert.equal(state.nativeFamilies.find(item => item.id === 'x').hidden, false);
});

test('setNativeModelHidden rejects malformed uid lists without writes', async () => {
  const observed = [{ uid: 'swe-2-max', label: 'SWE', disabled: false }];
  const f = memory({ nativeModels: () => observed });
  const before = f.read();
  for (const payload of [
    { uids: [], hidden: true },
    { uids: Array.from({ length: 257 }, (_, i) => 'u' + i), hidden: true },
    { uids: ['swe-2-max', 'dfbyok-own'], hidden: true },
    { uids: ['swe-2-max', 'not-observed'], hidden: true },
    { uids: [42], hidden: true },
    { uids: ['swe-2-max'], hidden: 'yes' },
  ]) {
    await assert.rejects(f.manager.dispatch('setNativeModelHidden', payload), PanelInputError, JSON.stringify(payload).slice(0, 80));
  }
  assert.deepEqual(f.read(), before);
  assert.equal(f.writes.length, 0);
});

test('saveProvider persists responsesState only when the key is present', async () => {
  const f = memory();
  const state = await f.manager.dispatch('saveProvider', providerPayload({ responsesState: true }));
  assert.equal(f.read().providers[0].responsesState, true, 'true is persisted');
  assert.equal(state.providers[0].responsesState, true, 'publicState exposes it');
  await f.manager.dispatch('saveProvider', providerPayload({ responsesState: false }));
  assert.equal(f.read().providers[0].responsesState, false, 'false is persisted');
});

test('a payload without responsesState keeps the stored value', async () => {
  const f = memory();
  await f.manager.dispatch('saveProvider', providerPayload({ responsesState: true }));
  const next = providerPayload({ name: 'Renamed CPA' });
  assert.equal('responsesState' in next, false, 'the fixture payload omits the key');
  await f.manager.dispatch('saveProvider', next);
  assert.equal(f.read().providers[0].responsesState, true, 'missing key leaves the flag untouched');
});

test('a new provider defaults responsesState off unless the payload sets it', async () => {
  const f = memory();
  await f.manager.dispatch('saveProvider', providerPayload({ id: undefined, name: 'Local', baseUrl: 'https://local.invalid/v1' }));
  assert.equal(f.read().providers.at(-1).responsesState, false);
  await f.manager.dispatch('saveProvider', providerPayload({ id: undefined, name: 'Local2', baseUrl: 'https://local2.invalid/v1', responsesState: true }));
  assert.equal(f.read().providers.at(-1).responsesState, true);
});

test('a non-boolean responsesState is rejected without touching the config', async () => {
  const f = memory();
  await f.manager.dispatch('saveProvider', providerPayload({ responsesState: true }));
  const before = f.read().providers[0];
  await assert.rejects(f.manager.dispatch('saveProvider', providerPayload({ responsesState: 'yes' })), PanelInputError);
  assert.deepEqual(f.read().providers[0], before, 'the failed save changes nothing');
});

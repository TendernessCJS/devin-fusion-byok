'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalog, augmentCatalog } = require('../src/catalog.cjs');

const provider = (id, order, models) => ({ id, name: id, baseUrl: 'https://' + id + '.invalid/v1', apiKey: 'k',
  apiFormat: 'openai', ...(order === undefined ? {} : { order }), models });
const model = (id, order, extra = {}) => ({ id, label: id, contextWindow: 128000, maxOutputTokens: 8192,
  ...(order === undefined ? {} : { order }), ...extra });
const roles = providers => providers.flatMap(provider =>
  (provider.models || []).flatMap(model => [
    { providerId: provider.id, model: model.id }])); // lead & sidekick both included below
const dimOrders = (catalog, key) => {
  const seen = new Map();
  for (const model of catalog.models) {
    if (model.kind !== 'matrix') continue;
    const entry = model.json.modelFamilyMetadata.entries.find(item => item.key === key);
    if (entry && !seen.has(entry.value.name)) seen.set(entry.value.name, entry.value.order);
  }
  return [...seen].sort((a, b) => a[1] - b[1]);
};

test('legacy configs without order emit models in array order', () => {
  const catalog = buildCatalog({
    providers: [provider('pb', undefined, [model('b'), model('a')]), provider('pa', undefined, [model('c')])],
  }, [], null);
  const names = catalog.models.filter(entry => entry.kind === 'model').map(entry => entry.label);
  assert.deepEqual(names, ['pb · b', 'pb · a', 'pa · c']);
});

test('persisted order wins over array order for providers and models', () => {
  const catalog = buildCatalog({
    providers: [
      provider('second', 1, [model('late', 1), model('early', 0)]),
      provider('first', 0, [model('solo', 0)]),
    ],
    sidekicks: [{ providerId: 'second', model: 'late' }, { providerId: 'second', model: 'early' }, { providerId: 'first', model: 'solo' }],
  }, [], null);
  const names = dimOrders(catalog, 'Sidekick').map(([name]) => name);
  assert.deepEqual(names, ['first · solo', 'second · early', 'second · late'],
    'the dropdown follows persisted order even when the array disagrees');
});

test('disabling a middle model keeps every other dimension order identical', () => {
  const base = { providers: [provider('p', 0, [model('a', 0), model('b', 1), model('c', 2)])],
    sidekicks: roles([{ id: 'p', models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }]) };
  const on = buildCatalog(base, [], null);
  const off = buildCatalog({ ...base, providers: [provider('p', 0, [model('a', 0), model('b', 1, { enabled: false }), model('c', 2)])] }, [], null);
  const sideOn = dimOrders(on, 'Sidekick'), sideOff = dimOrders(off, 'Sidekick');
  assert.ok(sideOff.length < sideOn.length, 'the disabled model drops out of the dimension');
  const onByName = new Map(sideOn);
  for (const [name, order] of sideOff) assert.equal(order, onByName.get(name), name + ' keeps its order');
});

test('BYOK orders are unique per dimension and above the native band', () => {
  const catalog = buildCatalog({
    providers: [provider('p', 0, [model('a', 0), model('b', 1)])],
    sidekicks: [{ providerId: 'p', model: 'a' }, { providerId: 'p', model: 'b' }],
  }, [{ uid: 'native-extra', label: 'Native Extra', fusionMetadata: [] }], null);
  const lead = dimOrders(catalog, 'Lead'), side = dimOrders(catalog, 'Sidekick');
  const byok = list => list.filter(([, order]) => order >= 0x20000000);
  const native = list => list.filter(([, order]) => order >= 0x10000000 && order < 0x18000000);
  for (const order of byok(lead).map(([, o]) => o)) assert.ok(order >= 0x20000000);
  assert.equal(new Set(byok(side).map(([, o]) => o)).size, byok(side).length, 'sidekick orders unique');
  assert.equal(new Set(byok(lead).map(([, o]) => o)).size, byok(lead).length, 'lead orders unique');
  for (const [, order] of native(side)) assert.ok(order < 0x20000000, 'native stays below BYOK');
});

test('same-family effort variants stay adjacent and tier-ordered in the Sidekick dimension', () => {
  const catalog = buildCatalog({
    providers: [provider('p', 0, [model('a', 0, { efforts: ['max', 'low', 'high'] }), model('z', 1)])],
    sidekicks: [{ providerId: 'p', model: 'a' }, { providerId: 'p', model: 'z' }],
  }, [], null);
  const side = [...dimOrders(catalog, 'Sidekick')].sort((a, b) => a[1] - b[1]).map(([name]) => name);
  const family = side.filter(name => name.startsWith('p · a'));
  assert.deepEqual(family, ['p · a Low', 'p · a High', 'p · a Max'], 'variants sort by effort tier, not declared order');
  const positions = family.map(name => side.indexOf(name));
  assert.equal(positions[2] - positions[0], 2, 'variants are consecutive');
});

test('byokOrder overflows loudly past provider or model limits', () => {
  // Only the last two entries stay enabled: ranks still cover every entry, so
  // the guard fires while the matrix stays at one pair instead of 4k rows.
  const manyProviders = Array.from({ length: 0x1000 + 1 }, (_, i) =>
    provider('p' + i, i, [model('m', 0, { enabled: i >= 0xfff })]));
  assert.throws(() => buildCatalog({ providers: manyProviders, sidekicks: [{ providerId: 'p4096', model: 'm' }] }, [], null),
    /order_rank_overflow/);
  const manyModels = [provider('p', 0, Array.from({ length: 0x400 + 1 }, (_, i) =>
    model('m' + i, i, { enabled: i >= 0x3ff })))];
  assert.throws(() => buildCatalog({ providers: manyModels, sidekicks: [{ providerId: 'p', model: 'm1024' }] }, [], null),
    /order_rank_overflow/);
});

test('duplicate orders resolve stably by array position and stay unique per dimension', () => {
  const catalog = buildCatalog({
    providers: [provider('p', 0, [model('a', 0), model('b', 0), model('c', 0)])],
    sidekicks: [{ providerId: 'p', model: 'a' }, { providerId: 'p', model: 'b' }, { providerId: 'p', model: 'c' }],
  }, [], null);
  const side = dimOrders(catalog, 'Sidekick').filter(([, order]) => order >= 0x20000000);
  assert.equal(new Set(side.map(([, o]) => o)).size, side.length, 'ranked positions never collide');
  const names = side.sort((a, b) => a[1] - b[1]).map(([name]) => name);
  assert.deepEqual(names, ['p · a', 'p · b', 'p · c'], 'equal orders fall back to array position');
});

test('the persisted order is the single source for both surfaces: array position never wins', () => {
  const { json } = require('./helpers/catalog-fixtures.cjs');
  const sortsBody = { clientModelSorts: [{ name: 'Recommended', groups: [{ groupName: 'Official', modelLabels: ['Official SWE'] }] }],
    clientModelConfigs: [] };
  const mk = providers => buildCatalog({ providers }, [], null);
  const labels = catalog => augmentCatalog(sortsBody, { rpc: 'GetCascadeModelConfigs', format: json, catalog })
    .clientModelSorts.flatMap(sort => sort.groups.flatMap(group => group.modelLabels))
    .filter(label => label.startsWith('p ·'));
  const seq = (catalog, key) => dimOrders(catalog, key).map(([name]) => name);
  const ordered = mk([provider('p', 0, [model('a', 0), model('b', 1)])]);
  const orderSwapped = mk([provider('p', 0, [model('a', 1), model('b', 0)])]);
  const arraySwapped = mk([provider('p', 0, [model('b', 1), model('a', 0)])]);
  // Both surfaces read the same persisted order, so they move together…
  assert.deepEqual(labels(ordered), ['p · a', 'p · b']);
  assert.deepEqual(labels(orderSwapped), ['p · b', 'p · a'],
    'changing the order alone reorders the model list');
  assert.notDeepEqual(dimOrders(ordered, 'Sidekick'), dimOrders(orderSwapped, 'Sidekick'),
    'and reorders the dropdown by the same amount');
  assert.deepEqual(labels(orderSwapped), seq(orderSwapped, 'Sidekick'),
    'the model list and the dropdown show one sequence, not two');
  // …and reordering the array alone must not move either surface.
  assert.deepEqual(labels(arraySwapped), labels(ordered),
    'array position is not an input: only the persisted order decides');
  assert.deepEqual(dimOrders(arraySwapped, 'Sidekick'), dimOrders(ordered, 'Sidekick'));
});

const officialFusion = (uid, label, leadOrder, leadName, sideOrder, sideName) => ({
  uid, label, disabled: false, isModelRouter: true, harnessUids: ['fusion'],
  fusionMetadata: [
    { key: 'Lead', order: leadOrder, name: leadName, controlType: 3 },
    { key: 'Sidekick', order: sideOrder, name: sideName, controlType: 3 }] });
const plainNative = (uid, label) => ({ uid, label, disabled: false, isModelRouter: false, harnessUids: ['fusion'], fusionMetadata: [] });
const officialNatives = () => [
  officialFusion('claude-opus-5-5-max', 'Claude Opus 5.5 Max', 1, 'Claude Opus 5.5', 1, 'SWE-2 Medium'),
  officialFusion('gpt-6-1-sol-max', 'GPT-6.1 Sol Max', 2, 'GPT-6.1 Sol', 2, 'SWE-2 High'),
  plainNative('gpt-6-luna-high', 'GPT-6 Luna High'),
  plainNative('deepseek-v4-1-flash-high', 'DeepSeek V4.1 Flash High'),
];
const nativeInclusions = { lead: [{ nativeUid: 'claude-opus-5-5-max' }, { nativeUid: 'gpt-6-1-sol-max' },
  { nativeUid: 'gpt-6-luna-high' }, { nativeUid: 'deepseek-v4-1-flash-high' }],
  sidekick: [{ nativeUid: 'claude-opus-5-5-max' }, { nativeUid: 'gpt-6-1-sol-max' },
    { nativeUid: 'gpt-6-luna-high' }, { nativeUid: 'deepseek-v4-1-flash-high' }] };
const bands = list => ({
  official: list.filter(([, order]) => order < 0x10000000),
  native: list.filter(([, order]) => order >= 0x10000000 && order < 0x20000000),
  byok: list.filter(([, order]) => order >= 0x20000000),
});

test('native non-Fusion values sit in their own band, entirely below every BYOK value', () => {
  const catalog = buildCatalog({
    roleInclusions: nativeInclusions,
    providers: [provider('p', 0, [model('a', 0)])],
    sidekicks: [{ providerId: 'p', model: 'a' }, { nativeUid: 'gpt-6-luna-high' }],
  }, officialNatives(), null);
  for (const key of ['Lead', 'Sidekick']) {
    const list = dimOrders(catalog, key).sort((a, b) => a[1] - b[1]);
    const { native, byok } = bands(list);
    assert.ok(native.length >= 1, key + ': the non-Fusion native value reaches the dimension');
    assert.ok(byok.length >= 1, key + ': the BYOK value reaches the dimension');
    assert.ok(Math.min(...native.map(([, order]) => order)) >= 0x10000000,
      key + ': the native band starts above every official Fusion order — those are the small integers the '
        + 'official catalog fills in (measured 1..8 for Lead, 1..9 for Sidekick), and buildCatalog rejects a '
        + 'native assignment that does not clear the highest one (order_band_conflict)');
    assert.ok(Math.max(...native.map(([, order]) => order)) < Math.min(...byok.map(([, order]) => order)),
      key + ': every BYOK value follows every native value');
    assert.equal(new Set(list.map(([, order]) => order)).size, list.length, key + ': no two values share an order');
  }
});

test('native non-Fusion orders do not drift when BYOK providers are toggled', () => {
  const natives = officialNatives();
  const build = providers => buildCatalog({ roleInclusions: nativeInclusions, providers,
    sidekicks: [{ providerId: 'p1', model: 'a' }, { nativeUid: 'gpt-6-luna-high' }] }, natives, null);
  const two = build([provider('p1', 0, [model('a', 0)]), provider('p2', 1, [model('b', 0)]), provider('p3', 2, [model('c', 0)])]);
  const one = build([provider('p1', 0, [model('a', 0)]), provider('p2', 1, [model('b', 0, { enabled: false })]),
    provider('p3', 2, [model('c', 0, { enabled: false })])]);
  for (const key of ['Lead', 'Sidekick']) {
    assert.deepEqual(bands(dimOrders(one, key)).native, bands(dimOrders(two, key)).native,
      key + ': native-band values keep their orders when BYOK providers drop out');
  }
  // The order_band_conflict guard itself cannot be reached without changing the
  // exported band constants, so it stays covered by review: assertNativeBand
  // only fires when a native assignment lands on/above BYOK_ORDER_BASE or not
  // above the highest official order.
});

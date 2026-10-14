'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalog, migrateFusionConfig, resolveAssignment, presetUid } = require('../src/catalog.cjs');

const ref = (model, effort = null) => ({ providerId: 'p', model, effort });
const NATIVE_SIDEKICK = { uid: 'swe-2-medium', label: 'SWE-2 Medium', disabled: false, isModelRouter: false, harnessUids: ['swe-2'] };
const config = () => ({
  providers: [{ id: 'p', name: 'Provider', apiKey: 'SECRET', models: [{ id: 'a', efforts: ['low', 'high'] }, { id: 'b' }] }],
});
const withPresets = presets => ({ ...config(), fusionPresets: presets });

test('retired preset keys are removed and their references become role inclusions', () => {
  const input = withPresets([{ id: 'one', name: '日常', lead: ref('a', 'high'), sidekick: { nativeUid: 'swe-2-medium' } }]);
  input.fusionMatrix = true;
  assert.equal(migrateFusionConfig(input, [NATIVE_SIDEKICK]), true);
  assert.deepEqual(Object.keys(input).sort(), ['providers', 'roleInclusions']);
  assert.deepEqual(input.roleInclusions.lead, [ref('a', 'high')]);
  assert.deepEqual(input.roleInclusions.sidekick, [{ nativeUid: 'swe-2-medium' }]);
});

test('migration is idempotent and leaves a clean config untouched', () => {
  const input = withPresets([{ id: 'one', name: '日常', lead: ref('a', 'high'), sidekick: ref('b') }]);
  assert.equal(migrateFusionConfig(input, []), true);
  const migrated = structuredClone(input);
  assert.equal(migrateFusionConfig(input, []), false, 'a migrated config reports no change');
  assert.deepEqual(input, migrated, 'and is not rewritten again');
  assert.equal(migrateFusionConfig(config(), []), false, 'a config without retired keys is left alone');
  assert.deepEqual(migrateFusionConfig(null, []), false);
});

test('only resolvable, unexcluded preset references are promoted', () => {
  const input = withPresets([
    { id: 'live', name: 'Live', lead: ref('a', 'high'), sidekick: ref('b') },
    { id: 'gone', name: 'Gone', lead: ref('missing'), sidekick: ref('b') },
    { id: 'off', name: 'Off', lead: ref('b'), sidekick: ref('a') },
    { id: 'broken', name: 'Broken', lead: null, sidekick: ref('b') },
  ]);
  input.roleExclusions = { lead: [ref('b')], sidekick: [] };
  migrateFusionConfig(input, []);
  assert.deepEqual(input.roleInclusions.lead, [ref('a', 'high')], 'the removed model and the excluded ref are dropped');
  assert.deepEqual(input.roleInclusions.sidekick, [ref('b'), ref('a')], 'each role is migrated independently of the other');
  assert.deepEqual(input.roleExclusions, { lead: [ref('b')], sidekick: [] }, 'exclusions are preserved verbatim');
});

test('existing inclusions survive and duplicate models are not appended', () => {
  const input = withPresets([{ id: 'one', name: 'One', lead: ref('a', 'high'), sidekick: ref('b') }]);
  input.roleInclusions = { lead: [ref('a')], sidekick: [] };
  migrateFusionConfig(input, []);
  // Role selection is per model (refKey ignores effort), so a preset naming one
  // effort variant adds nothing once the model itself is already included.
  assert.deepEqual(input.roleInclusions.lead, [ref('a')]);
  assert.deepEqual(input.roleInclusions.sidekick, [ref('b')]);
  const again = withPresets([{ id: 'one', name: 'One', lead: ref('a', 'high'), sidekick: ref('b') }]);
  again.roleInclusions = { lead: [ref('a', 'high')], sidekick: [ref('b')] };
  migrateFusionConfig(again, []);
  assert.deepEqual(again.roleInclusions, { lead: [ref('a', 'high')], sidekick: [ref('b')] });
  assert.equal(buildCatalog(again, []).matrixUids.size, buildCatalog(input, []).matrixUids.size,
    'both spellings select the same combinations');
});

test('a remembered preset selection becomes the equivalent matrix uid', () => {
  const input = withPresets([{ id: 'one', name: 'One', lead: ref('a', 'high'), sidekick: ref('b') }]);
  input.defaultFusionUid = presetUid('one');
  assert.equal(migrateFusionConfig(input, []), true);
  const catalog = buildCatalog(input, []);
  assert.ok(input.lastFusionSelection.startsWith('fusion-dfbyok-'), 'the remembered uid is a matrix entry');
  assert.ok(catalog.matrixUids.has(input.lastFusionSelection));
  assert.equal(Object.hasOwn(input, 'defaultFusionUid'), false);
  const resolved = resolveAssignment({ modelRouterUid: input.lastFusionSelection }, { json: true }, catalog);
  assert.equal(resolved.assignment.modelUid, Object.keys(catalog.routes)[1], 'the mapped uid still routes the same lead variant');
});

test('a remembered matrix uid survives, an unresolvable one is dropped', () => {
  const live = buildCatalog(config(), []);
  const liveUid = [...live.matrixUids][0];
  const kept = { ...config(), defaultFusionUid: liveUid };
  migrateFusionConfig(kept, []);
  assert.equal(kept.lastFusionSelection, liveUid);
  for (const dead of ['fusion-dfbyok-preset-gone', 'fusion-dfbyok-missing-sidekick-dfbyok-missing', 'not-a-uid', '']) {
    const input = { ...config(), defaultFusionUid: dead };
    migrateFusionConfig(input, []);
    assert.equal(Object.hasOwn(input, 'lastFusionSelection'), false, dead + ' must not be remembered');
    assert.equal(Object.hasOwn(input, 'defaultFusionUid'), false, dead + ' is still removed');
  }
});

test('retired native-sidekick combinations stay selectable after migration', () => {
  const input = withPresets([{ id: 'one', name: 'One', lead: ref('a', 'high'), sidekick: { nativeUid: 'swe-2-medium' } }]);
  input.defaultFusionUid = presetUid('one');
  assert.equal(migrateFusionConfig(input, [NATIVE_SIDEKICK]), true);
  const catalog = buildCatalog(input, [NATIVE_SIDEKICK]);
  const combination = `fusion-${Object.keys(catalog.routes).find(uid => catalog.routes[uid].effort === 'high')}-sidekick-swe-2-medium`;
  assert.ok(catalog.matrixUids.has(combination), 'the migrated inclusion still produces the combination');
  assert.equal(input.lastFusionSelection, combination, 'and it is what the remembered selection points at');
  const sidekick = resolveAssignment({ modelRouterUid: combination, fusionLeadRouterUid: combination }, { json: true }, catalog).assignment;
  assert.deepEqual(sidekick.harnessUids, NATIVE_SIDEKICK.harnessUids);
});

test('a preset-less config keeps its own selection untouched', () => {
  const live = buildCatalog(config(), []);
  const uid = [...live.matrixUids][0];
  const input = { ...config(), fusionMatrix: false };
  migrateFusionConfig(input, []);
  assert.equal(Object.hasOwn(input, 'lastFusionSelection'), false, 'no remembered uid is invented');
  const remembered = { ...config(), defaultFusionUid: uid, lastFusionSelection: uid };
  migrateFusionConfig(remembered, []);
  assert.equal(remembered.lastFusionSelection, uid);
});

test('presets are never recreated from the catalog', () => {
  const input = { ...config(), fusionPresets: [] };
  migrateFusionConfig(input, []);
  assert.equal(Object.hasOwn(input, 'fusionPresets'), false);
  const catalog = buildCatalog(input, []);
  assert.equal(Object.hasOwn(catalog, 'presetStates'), false);
  assert.equal(Object.hasOwn(catalog, 'presetCandidates'), false);
  assert.equal(Object.hasOwn(catalog, 'migrationPending'), false);
  assert.equal(Object.hasOwn(catalog, 'defaultFusionUid'), false);
});

test('an inclusion that is also excluded is dropped as dead weight', () => {
  const input = withPresets([{ id: 'one', name: 'One', lead: ref('a', 'high'), sidekick: ref('b') }]);
  input.roleInclusions = { lead: [ref('a'), ref('b')], sidekick: [] };
  input.roleExclusions = { lead: [ref('b')], sidekick: [ref('b')] };
  migrateFusionConfig(input, []);
  assert.deepEqual(input.roleInclusions.lead, [ref('a')], 'the contradictory ref only survived through roleInclusions');
  assert.deepEqual(input.roleExclusions.lead, [ref('b')], 'the exclusion the user set is untouched');
  // The preset's Sidekick is excluded too, so nothing remains and the empty list
  // is pruned rather than persisted forever.
  assert.equal(Object.hasOwn(input.roleInclusions, 'sidekick'), false, 'emptied role lists are removed');
  assert.equal(buildCatalog(input, []).rolePool.lead.some(item => item.ref.model === 'b'), false);
  assert.equal(buildCatalog(input, []).rolePool.sidekick.some(item => item.ref.model === 'b'), false);
});

test('a preset-led fallback maps onto the emitted representative, not the named variant', () => {
  const input = withPresets([{ id: 'one', name: 'One', lead: ref('a', 'low'), sidekick: ref('b') }]);
  input.defaultFusionUid = presetUid('one');
  migrateFusionConfig(input, []);
  const catalog = buildCatalog(input, []);
  const fusion = catalog.fusions[input.lastFusionSelection];
  assert.ok(fusion, 'the mapped target resolves');
  // Every BYOK Lead variant is emitted, so the effort the preset named is kept.
  assert.equal(catalog.routes[fusion.leadUid].effort, 'low');
  assert.equal(catalog.routes[fusion.sidekickUid].model, 'b');
});

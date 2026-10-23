'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalog, augmentCatalog, resolveAssignment, collectNativeModels, buildRoleLists } = require('../src/catalog.cjs');
const { fields, str, s, v, m } = require('../src/protocol/wire.cjs');
const { cat, proto, json, config, OBSERVED_SWE, catalog, getNested, configs, dimEntry, fam } = require('./helpers/catalog-fixtures.cjs');

const OFFICIAL_EFFORT_ORDERS = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
const OFFICIAL_EFFORT_NAMES = Object.fromEntries(Object.entries(OFFICIAL_EFFORT_ORDERS).map(([tier, order]) => [order,
  { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' }[tier]]));
const nativeLead = (uid, label, fusionMetadata = []) =>
  ({ uid, label, disabled: false, isModelRouter: false, harnessUids: ['h-' + uid], fusionMetadata });
const OFFICIAL_SIDEKICK = nativeLead('swe-2-max', 'SWE-2 Max');
const officialCombo = (leadUid, leadOrder, leadName, effortOrder) =>
  ({ uid: `fusion-${leadUid}-sidekick-swe-2-max`, label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'],
    fusionMetadata: [
      { key: 'Lead', order: leadOrder, name: leadName, controlType: 3 },
      { key: 'Effort', order: effortOrder, name: OFFICIAL_EFFORT_NAMES[effortOrder], controlType: 1 },
      { key: 'Sidekick', order: 3, name: 'SWE-2 Max', controlType: 3 }] });
const officialSeries = (base, leadOrder, leadName) => Object.entries(OFFICIAL_EFFORT_ORDERS).flatMap(([tier, effortOrder]) => {
  const uid = `${base}-${tier}`;
  return [nativeLead(uid, `${leadName} ${OFFICIAL_EFFORT_NAMES[effortOrder]}`), officialCombo(uid, leadOrder, leadName, effortOrder)];
});
const fastSiblings = (base, leadName, tiers, suffix = 'fast') => tiers.map(tier => {
  const name = OFFICIAL_EFFORT_NAMES[OFFICIAL_EFFORT_ORDERS[tier]];
  return nativeLead(`${base}-${tier}-${suffix}`, `${leadName} ${name} Fast`,
    [{ key: 'Effort', order: 0, name, controlType: 1 }, { key: 'Fast Mode', order: 1 }]);
});
test('every provider Lead variant pairs with every selected Sidekick representative', () => {
  assert.equal(Object.keys(catalog.routes).length, 4);
  assert.equal(Object.keys(catalog.fusions).length, 14);
  assert.equal(catalog.models.length, 18);
  assert.equal(catalog.matrixUids.size, 14, 'the cross product minus same-family pairs is mirrored into the official card');
  for (const route of Object.values(catalog.routes)) {
    const combinations = Object.values(catalog.fusions).filter(fusion => fusion.leadUid === route.uid);
    // grok-4.6 offers two effort variants as Sidekick values, so its own leads
    // lose two same-family values while the other leads lose just one.
    assert.equal(combinations.length, route.model === 'grok-4.6' ? 3 : 4);
    assert.deepEqual(new Set(combinations.map(fusion => fusion.sidekickNative)), new Set([false, true]));
    for (const fusion of combinations) {
      assert.equal(fusion.uid, `fusion-${fusion.leadUid}-sidekick-${fusion.sidekickUid}`);
      assert.match(fusion.uid, /^fusion-dfbyok-/);
      const model = catalog.models.find(value => value.uid === fusion.uid);
      assert.equal(model.label, fusion.label);
      assert.match(fusion.label, /^Fusion \(.+ \+ .+\)$/);
      assert.equal(model.kind, 'matrix');
    }
  }
  const serialized = JSON.stringify(catalog);
  assert.ok(!serialized.includes('secret-test-value'));
  assert.ok(!serialized.includes('private.invalid'));
  assert.ok(!serialized.includes('apiKey'));
  assert.ok(!catalog.routes['swe-2-max']);
});

for (const format of [proto, json]) test(`${format.json ? 'JSON' : 'protobuf'} assignments choose exact Lead and Sidekick routes`, () => {
  for (const fusion of Object.values(catalog.fusions)) {
    for (const isSidekick of [false, true]) {
      const input = format.json ? { modelRouterUid: fusion.uid, ...(isSidekick ? { fusionLeadRouterUid: fusion.uid } : {}) }
        : cat(s(2, fusion.uid), isSidekick ? s(6, fusion.uid) : Buffer.alloc(0));
      const output = resolveAssignment(input, format, catalog);
      assert.ok(output);
      const assignment = format.json ? output.assignment : getNested(output, 1);
      const assignedUid = format.json ? assignment.modelUid : str(assignment, 2);
      const harnesses = format.json ? assignment.harnessUids : fields(assignment, 3).map(field => field.value.toString());
      assert.equal(assignedUid, isSidekick ? fusion.sidekickUid : fusion.leadUid);
      assert.deepEqual(harnesses, isSidekick ? ['swe-1p6', 'swe-1p5'] : ['fusion']);
      if (isSidekick && fusion.sidekickNative) assert.equal(assignedUid, 'swe-2-max');
      else assert.ok(catalog.routes[assignedUid]);
      if (format.json) assert.ok(!Object.hasOwn(assignment, 'jwt'));
      else assert.equal(fields(assignment, 1).length, 0);
    }
  }
});

test('official, unknown and ambiguous assignments are not intercepted', () => {
  const uid = Object.keys(catalog.fusions)[0];
  for (const input of [s(2, 'fusion-gpt-official'), s(2, 'fusion-dfbyok-unknown'), s(2, 'swe-2-max'),
    cat(s(2, uid), s(2, uid)), cat(s(2, uid), v(6, 1)), Buffer.from([0x12, 0xff]),
    cat(s(2, uid), s(6, 'fusion-official'))]) assert.equal(resolveAssignment(input, proto, catalog), null);
  for (const input of [{ modelRouterUid: 'fusion-official' }, { modelRouterUid: uid, model_router_uid: 'conflict' },
    { modelRouterUid: uid, fusionLeadRouterUid: 42 }, { modelRouterUid: 42 }]) assert.equal(resolveAssignment(input, json, catalog), null);
  assert.equal(resolveAssignment({ model_router_uid: uid }, json, catalog).assignment.modelUid, catalog.fusions[uid].leadUid);
});

for (const format of [proto, json]) test(`${format.json ? 'JSON' : 'protobuf'} locked official Fusion assignments fall back to the configured combination`, () => {
  const fallback = Object.values(catalog.fusions).find(fusion => fusion.sidekickNative === false);
  const withDefault = { ...catalog, lastFusionSelection: fallback.uid };
  const locked = new Set(['fusion-official-locked']);
  for (const isSidekick of [false, true]) {
    const input = format.json
      ? { modelRouterUid: 'fusion-official-locked', ...(isSidekick ? { fusionLeadRouterUid: 'fusion-official-locked' } : {}) }
      : cat(s(2, 'fusion-official-locked'), isSidekick ? s(6, 'fusion-official-locked') : Buffer.alloc(0));
    const output = resolveAssignment(input, format, withDefault, locked);
    assert.ok(output);
    const assignment = format.json ? output.assignment : getNested(output, 1);
    const assignedUid = format.json ? assignment.modelUid : str(assignment, 2);
    const harnesses = format.json ? assignment.harnessUids : fields(assignment, 3).map(field => field.value.toString());
    assert.equal(assignedUid, isSidekick ? fallback.sidekickUid : fallback.leadUid);
    assert.deepEqual(harnesses, isSidekick ? ['swe-1p6', 'swe-1p5'] : ['fusion']);
    assert.ok(catalog.routes[assignedUid]);
    assert.equal(output.redirectedFrom, 'fusion-official-locked');
    assert.equal(format.json ? JSON.stringify(output).includes('redirectedFrom') : Object.keys(output).includes('redirectedFrom'), false);
  }
});

test('the configured default Fusion wins the locked fallback over other combinations', () => {
  const preferred = Object.values(catalog.fusions).filter(fusion => fusion.sidekickNative === false)[1];
  const output = resolveAssignment(s(2, 'fusion-official-locked'), proto, { ...catalog, lastFusionSelection: preferred.uid }, new Set(['fusion-official-locked']));
  assert.equal(str(getNested(output, 1), 2), preferred.leadUid);
  assert.equal(output.redirectedFrom, 'fusion-official-locked');
});

test('unlocked, unobserved or fallback-less official Fusion assignments still pass through natively', () => {
  const input = s(2, 'fusion-official-locked');
  assert.equal(resolveAssignment(input, proto, catalog, new Set(['fusion-other'])), null);
  assert.equal(resolveAssignment(input, proto, catalog, new Set()), null);
  assert.equal(resolveAssignment(input, proto, catalog), null);
  assert.equal(resolveAssignment(input, proto, catalog, new Set(['fusion-official-locked'])), null);
  const empty = buildCatalog({ providers: [], sidekicks: [] });
  assert.equal(resolveAssignment(input, proto, empty, new Set(['fusion-official-locked'])), null);
  const stale = { ...catalog, lastFusionSelection: 'fusion-dfbyok-removed' };
  assert.equal(resolveAssignment(input, proto, stale, new Set(['fusion-official-locked'])), null);
  const nativeDefault = { ...catalog, lastFusionSelection: Object.values(catalog.fusions).find(fusion => fusion.sidekickNative).uid };
  assert.equal(resolveAssignment(input, proto, nativeDefault, new Set(['fusion-official-locked'])), null);
});

for (const format of [proto, json]) test(`${format.json ? 'JSON' : 'protobuf'} catalog augmentation reports locked official Fusion uids`, () => {
  const lockedNative = format.json
    ? { label: 'Fusion (Locked)', modelUid: 'fusion-official-locked', disabled: true }
    : cat(s(1, 'Fusion (Locked)'), s(22, 'fusion-official-locked'), v(4, 1), m(32, v(1, 1)));
  const openNative = format.json
    ? { label: 'Fusion (Open)', modelUid: 'fusion-official-open', disabled: false }
    : cat(s(1, 'Fusion (Open)'), s(22, 'fusion-official-open'), m(32, v(1, 1)));
  const plain = format.json
    ? { label: 'Official SWE', modelUid: 'swe-2-max', disabled: true }
    : cat(s(1, 'Official SWE'), s(22, 'swe-2-max'), v(4, 1));
  const list = format.json ? { clientModelConfigs: [lockedNative, openNative, plain] }
    : cat(m(1, lockedNative), m(1, openNative), m(1, plain));
  let report;
  const output = augmentCatalog(list, { rpc: 'GetCliModelConfigs', format, catalog,
    onFusionStatus: (locked, seen) => { report = { locked, seen }; } });
  assert.deepEqual(report, { locked: ['fusion-official-locked'], seen: ['fusion-official-locked', 'fusion-official-open'] });
  const entries = format.json ? output.clientModelConfigs : configs(output);
  const uids = entries.map(entry => format.json ? entry.modelUid : str(entry, 22));
  assert.deepEqual(uids, [...catalog.models.map(model => model.uid), 'fusion-official-locked', 'fusion-official-open', 'swe-2-max']);
  assert.equal(entries.length, 3 + catalog.models.length);
});

for (const format of [proto, json]) test(`${format.json ? 'JSON' : 'protobuf'} valid third-party default Fusion becomes the first selectable entry ahead of locked native ones`, () => {
  const preferred = Object.values(catalog.fusions).find(fusion => fusion.sidekickNative === false);
  const withDefault = { ...catalog, lastFusionSelection: preferred.uid };
  const lockedNative = format.json
    ? { label: 'Fusion (Locked)', model_uid: 'fusion-official-locked', disabled: true, disabled_reason: 'pro' }
    : cat(s(1, 'Fusion (Locked)'), s(22, 'fusion-official-locked'), v(4, 1), s(33, 'pro'), m(32, v(1, 1)));
  const openNative = format.json
    ? { label: 'Fusion (Open)', model_uid: 'fusion-official-open', disabled: false }
    : cat(s(1, 'Fusion (Open)'), s(22, 'fusion-official-open'), m(32, v(1, 1)));
  const list = format.json ? { client_model_configs: [lockedNative, openNative] }
    : cat(m(1, lockedNative), m(1, openNative));
  let report;
  const output = augmentCatalog(list, { rpc: 'GetCliModelConfigs', format, catalog: withDefault,
    onFusionStatus: (locked, seen) => { report = { locked, seen }; } });
  const entries = format.json ? output.client_model_configs : configs(output);
  const uids = entries.map(entry => format.json ? entry.modelUid ?? entry.model_uid : str(entry, 22));
  assert.deepEqual(uids, [preferred.uid, ...catalog.models.filter(model => model.uid !== preferred.uid).map(model => model.uid),
    'fusion-official-locked', 'fusion-official-open']);
  assert.equal(new Set(uids).size, uids.length);
  assert.deepEqual(entries.at(-2), lockedNative);
  assert.deepEqual(entries.at(-1), openNative);
  assert.deepEqual(report, { locked: ['fusion-official-locked'], seen: ['fusion-official-locked', 'fusion-official-open'] });
  assert.deepEqual(augmentCatalog(output, { rpc: 'GetCliModelConfigs', format, catalog: withDefault }), output);
});

for (const format of [proto, json]) test(`${format.json ? 'JSON' : 'protobuf'} absent, stale or native-sidekick defaults keep official order and never redirect`, () => {
  const candidates = [catalog,
    { ...catalog, lastFusionSelection: 'fusion-dfbyok-removed' },
    { ...catalog, lastFusionSelection: Object.values(catalog.fusions).find(fusion => fusion.sidekickNative === true).uid },
    { ...catalog, lastFusionSelection: Object.values(catalog.fusions).find(fusion => fusion.sidekickNative === false).uid, routes: {} }];
  const lockedNative = format.json
    ? { label: 'Fusion (Locked)', modelUid: 'fusion-official-locked', disabled: true, disabledReason: 'pro' }
    : cat(s(1, 'Fusion (Locked)'), s(22, 'fusion-official-locked'), v(4, 1), s(33, 'pro'), m(32, v(1, 1)));
  const list = format.json ? { clientModelConfigs: [lockedNative] } : m(1, lockedNative);
  const request = format.json ? { modelRouterUid: 'fusion-official-locked' } : s(2, 'fusion-official-locked');
  for (const candidate of candidates) {
    const output = augmentCatalog(list, { rpc: 'GetCliModelConfigs', format, catalog: candidate });
    const entries = format.json ? output.clientModelConfigs : configs(output);
    const uids = entries.map(entry => format.json ? entry.modelUid : str(entry, 22));
    assert.deepEqual(uids, [...catalog.models.map(model => model.uid), 'fusion-official-locked']);
    assert.equal(resolveAssignment(request, format, candidate, new Set(['fusion-official-locked'])), null);
  }
});

// Integration evidence from the installed native picker. Portable test runs skip
// these checks when Devin is absent; catalog production code never imports it.

test('eligible observed native Sidekicks combine with every imported Lead using their exact harness intersection', () => {
  const input = config();
  const natives = [
    { uid: 'swe-2-max', label: 'SWE-2 Max', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6', 'swe-1p5', 'other-harness'] },
    { uid: 'swe-2-medium', label: 'SWE-2 Medium', disabled: false, isModelRouter: false, harnessUids: ['swe-1p5', 'unrelated'] },
    { uid: 'swe-disabled', label: 'Disabled', disabled: true, isModelRouter: false, harnessUids: ['swe-1p6'] },
    { uid: 'swe-router', label: 'Router', disabled: false, isModelRouter: true, harnessUids: ['swe-1p6'] },
    { uid: 'swe-naked', label: 'Naked', disabled: false, isModelRouter: false },
    { uid: 'swe-incompatible', label: 'Incompatible', disabled: false, isModelRouter: false, harnessUids: ['other-only'] },
    { uid: 'fusion-official', label: 'Fusion', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] },
    { uid: 'dfbyok-own', label: 'Own', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] },
    { uid: 'swe-hidden', label: 'Hidden', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] },
  ];
  const officials = [
    { uid: 'fusion-lead-a-sidekick-swe-2-max', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 3, name: 'SWE-2 Max' } },
    { uid: 'fusion-lead-a-sidekick-swe-2-medium', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 1, name: 'SWE-2 Medium' } },
  ];
  const result = buildCatalog({ ...input, hiddenNativeModelUids: ['swe-hidden'] }, [...natives, ...officials]);
  const nativeSidekicks = result.sidekicks.filter(item => item.native);
  assert.deepEqual(nativeSidekicks.map(item => item.uid).sort(), ['swe-2-max', 'swe-2-medium']);
  const bySidekick = uid => Object.values(result.fusions).find(fusion => fusion.sidekickUid === uid);
  assert.deepEqual(bySidekick('swe-2-max').sidekickHarnessUids, ['swe-1p6', 'swe-1p5', 'other-harness']);
  assert.deepEqual(bySidekick('swe-2-medium').sidekickHarnessUids, ['swe-1p5', 'unrelated']);
  for (const uid of ['swe-disabled', 'swe-router', 'swe-naked', 'swe-incompatible', 'fusion-official', 'dfbyok-own', 'swe-hidden', 'swe-ghost']) {
    assert.equal(bySidekick(uid), undefined, uid + ' must not become a Sidekick');
  }
  for (const route of Object.values(result.routes)) {
    assert.ok(Object.values(result.fusions).some(fusion => fusion.leadUid === route.uid && fusion.sidekickUid === 'swe-2-max'));
    assert.ok(Object.values(result.fusions).some(fusion => fusion.leadUid === route.uid && fusion.sidekickUid === 'swe-2-medium'));
  }
  assert.equal(result.sidekicks.find(item => item.uid === 'swe-2-max').dimension.order, 3);
  assert.equal(result.sidekicks.find(item => item.uid === 'swe-2-medium').dimension.order, 1);
  for (const model of result.models.filter(value => value.kind === 'matrix')) {
    const dims = Object.fromEntries(model.json.modelFamilyMetadata.entries.map(entry => [entry.key, entry.value]));
    assert.ok(dims.Lead?.name && dims.Sidekick?.name, 'matrix entries declare both role dimensions');
    // The two informational dimensions follow the official wire shape exactly:
    // Fast Mode carries only a controlType, Recommended Sidekick only a name.
    // Writing an explicit order 0 there would split them into their own bucket
    // (the picker dedupes values by order) and surface controls the official
    // card never shows.
    assert.deepEqual(dims['Fast Mode'], { controlType: 2 }, 'no Fast Mode capability and no stray order');
    assert.deepEqual(dims['Recommended Sidekick'], { name: dims.Sidekick.name });
  }
  const assignedMax = resolveAssignment(cat(s(2, bySidekick('swe-2-max').uid), s(6, bySidekick('swe-2-max').uid)), proto, result);
  assert.deepEqual(fields(getNested(assignedMax, 1), 3).map(field => field.value.toString()), ['swe-1p6', 'swe-1p5', 'other-harness']);
  assert.equal(str(getNested(assignedMax, 1), 2), 'swe-2-max');
  const assignedMedium = resolveAssignment(cat(s(2, bySidekick('swe-2-medium').uid), s(6, bySidekick('swe-2-medium').uid)), proto, result);
  assert.deepEqual(fields(getNested(assignedMedium, 1), 3).map(field => field.value.toString()), ['swe-1p5', 'unrelated']);
});

test('config alone never grants native capability and unobserved natives fail closed', () => {
  const input = config();
  const unobserved = buildCatalog(input);
  assert.equal(Object.values(unobserved.fusions).filter(fusion => fusion.sidekickNative).length, 0);
  assert.ok(!unobserved.routes['swe-2-max']);
  const partial = buildCatalog(input, [{ uid: 'swe-2-max', label: 'SWE-2 Max', disabled: false, isModelRouter: false, harnessUids: [] }]);
  assert.equal(Object.values(partial.fusions).filter(fusion => fusion.sidekickNative).length, 0, 'metadata-less natives stay ineligible');
  const eligible = buildCatalog(input, OBSERVED_SWE);
  const nativeFusion = Object.values(eligible.fusions).find(fusion => fusion.sidekickNative);
  assert.ok(nativeFusion);
  const stale = { ...eligible, fusions: { [nativeFusion.uid]: { ...nativeFusion, sidekickHarnessUids: [] } } };
  assert.equal(resolveAssignment(cat(s(2, nativeFusion.uid), s(6, nativeFusion.uid)), proto, stale), null,
    'a native assignment without a recorded intersection fails closed');
});

test('team allowlists include native Sidekick combinations only when the native uid is allowed', () => {
  const teamRpc = '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings';
  const nativeFusion = Object.values(catalog.fusions).find(fusion => fusion.sidekickNative);
  const providerFusion = Object.values(catalog.fusions).find(fusion => !fusion.sidekickNative);
  const leadUids = Object.keys(catalog.routes);
  const withoutNative = augmentCatalog(cat(...leadUids.map(uid => s(7, uid))), { rpc: teamRpc, format: proto, catalog });
  const uids = fields(withoutNative, 7).map(field => field.value.toString());
  assert.ok(uids.includes(providerFusion.uid));
  assert.ok(!uids.includes(nativeFusion.uid), 'swe-2-max not allowed -> its combinations stay out');
  const withNative = augmentCatalog(cat(...leadUids.map(uid => s(7, uid)), s(7, 'swe-2-max')), { rpc: teamRpc, format: proto, catalog });
  assert.ok(fields(withNative, 7).map(field => field.value.toString()).includes(nativeFusion.uid));
});

test('malformed or ambiguous disabled and router flags never produce a native Sidekick candidate', () => {
  const harness = cat(s(20, 'swe-1p6'));
  const info = inner => m(23, inner);
  for (const entry of [
    cat(s(1, 'Dup4'), s(22, 'a'), v(4, 1), v(4, 0), info(harness)),
    cat(s(1, 'Wire4'), s(22, 'b'), s(4, 'yes'), info(harness)),
    cat(s(1, 'Two4'), s(22, 'c'), v(4, 2), info(harness)),
    cat(s(1, 'Router2'), s(22, 'd'), info(cat(harness, v(25, 2)))),
  ]) {
    const [record] = collectNativeModels(cat(m(1, entry)), { rpc: 'GetCliModelConfigs', format: proto });
    assert.equal(record.disabled === false && record.isModelRouter === false, false, 'ambiguous record must not read as enabled non-router');
    assert.equal(buildCatalog(config(), [record]).sidekicks.filter(item => item.native).length, 0);
  }
  for (const disabled of ['yes', 1, null, 0, {}]) {
    const [record] = collectNativeModels({ clientModelConfigs: [{ modelUid: 'swe-json', disabled, modelInfo: { harnessUids: ['swe-1p6'], isModelRouter: false } }] },
      { rpc: 'GetCliModelConfigs', format: json });
    assert.equal(record.disabled, true, JSON.stringify(disabled) + ' must fail closed as disabled');
    assert.equal(buildCatalog(config(), [record]).sidekicks.filter(item => item.native).length, 0);
  }
  const officialSidekick = { uid: 'fusion-lead-a-sidekick-swe-json', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 1, name: 'SWE JSON' } };
  for (const entry of [{ modelUid: 'swe-json', disabled: false, modelInfo: { harnessUids: ['swe-1p6'], isModelRouter: false } },
    { modelUid: 'swe-json', modelInfo: { harnessUids: ['swe-1p6'], isModelRouter: false } }]) {
    const [record] = collectNativeModels({ clientModelConfigs: [entry] }, { rpc: 'GetCliModelConfigs', format: json });
    assert.equal(record.disabled, false);
    assert.equal(buildCatalog(config(), [record, officialSidekick]).sidekicks.filter(item => item.native).length, 1);
  }
});

test('official Sidekick bindings give canonical dimension and full harness; conflicts fail closed', () => {
  const natives = [
    { uid: 'swe-2-high', label: 'SWE-2 High', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6', 'swe-1p5'] },
    { uid: 'gpt-5-6-luna-high', label: 'GPT-5.6 Luna High Thinking', disabled: false, isModelRouter: false, harnessUids: ['gpt-5p6'] },
    { uid: 'swe-2-max', label: 'SWE-2 Max', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6', 'swe-1p5'] },
    { uid: 'swe-odd', label: 'Odd', disabled: false, isModelRouter: false, harnessUids: ['odd-harness'] },
  ];
  const officials = [
    { uid: 'fusion-lead-a-sidekick-swe-2-high', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 2, name: 'SWE-2 High' } },
    { uid: 'fusion-lead-b-sidekick-swe-2-high', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 2, name: 'SWE-2 High' } },
    { uid: 'fusion-lead-a-sidekick-gpt-5-6-luna-high', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 4, name: 'GPT-5.6 Luna High' } },
    { uid: 'fusion-lead-a-sidekick-swe-2-max', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 3, name: 'SWE-2 Max' } },
    { uid: 'fusion-lead-a-sidekick-swe-odd', label: 'F', disabled: true, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 9, name: 'Odd' } },
    { uid: 'fusion-sidekick-swe-2-high', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'] },
    { uid: 'fusion-dfbyok-own-sidekick-gpt-5-6-luna-high', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 8, name: 'Ignored Own' } },
  ];
  const result = buildCatalog(config(), [...natives, ...officials]);
  const sidekick = uid => result.sidekicks.find(item => item.uid === uid);
  assert.deepEqual(sidekick('swe-2-high').dimension, { order: 2, name: 'SWE-2 High' });
  assert.deepEqual(sidekick('gpt-5-6-luna-high').dimension, { order: 4, name: 'GPT-5.6 Luna High' });
  assert.deepEqual(sidekick('gpt-5-6-luna-high').harnessUids, ['gpt-5p6'], 'bound + enabled official combo unlocks the declared harness');
  assert.deepEqual(sidekick('swe-2-high').harnessUids, ['swe-1p6', 'swe-1p5']);
  assert.equal(sidekick('swe-odd'), undefined, 'a disabled official pairing does not unlock an unfamiliar harness');
  const models = result.models.filter(model => model.kind === 'matrix');
  const orderOf = uid => result.sidekicks.find(item => item.uid === uid).dimension.order;
  assert.equal(orderOf('swe-2-high'), 2);
  assert.equal(orderOf('gpt-5-6-luna-high'), 4);
  assert.equal(orderOf('swe-2-max'), 3, 'legacy order stays only while no official binding claims it');
  const fusion = Object.values(result.fusions).find(item => item.sidekickUid === 'gpt-5-6-luna-high');
  assert.deepEqual(fusion.sidekickHarnessUids, ['gpt-5p6']);
  const luna = models.find(model => model.uid === fusion.uid);
  assert.equal(sidekick('gpt-5-6-luna-high').dimension.name, 'GPT-5.6 Luna High', 'canonical dimension name remains available for role candidates');
  const lunaDims = Object.fromEntries(luna.json.modelFamilyMetadata.entries.map(entry => [entry.key, entry.value]));
  assert.deepEqual(lunaDims.Sidekick, { order: 4, name: 'GPT-5.6 Luna High', controlType: 3 },
    'the emitted entry reuses the canonical official Sidekick identity instead of inventing one');
  const conflicts = buildCatalog(config(), [...natives,
    { uid: 'fusion-lead-a-sidekick-swe-2-max', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 3, name: 'SWE-2 Max' } },
    { uid: 'fusion-a-sidekick-swe-2-high', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 2, name: 'SWE-2 High' } },
    { uid: 'fusion-b-sidekick-swe-2-high', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 7, name: 'Renamed' } }]);
  const high = conflicts.sidekicks.find(item => item.uid === 'swe-2-high');
  assert.equal(high, undefined, 'conflicting bindings discard the borrowed dimension and candidate');
  const conflicted = buildCatalog(config(), [...natives,
    { uid: 'fusion-lead-a-sidekick-swe-2-max', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 3, name: 'SWE-2 Max' } },
    { uid: 'fusion-a-sidekick-gpt-5-6-luna-high', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 4, name: 'Luna' } },
    { uid: 'fusion-b-sidekick-swe-2-high', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 4, name: 'Squatter' } }]);
  assert.equal(conflicted.sidekicks.find(item => item.uid === 'gpt-5-6-luna-high'), undefined,
    'an order claimed by two natives unlocks neither the dimension nor the unfamiliar harness');
  const claimedThree = buildCatalog(config(), [...natives,
    { uid: 'fusion-lead-a-sidekick-swe-2-max', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 3, name: 'SWE-2 Max' } },
    { uid: 'fusion-a-sidekick-swe-odd', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 3, name: 'Odd' } }]);
  assert.equal(claimedThree.sidekicks.find(item => item.uid === 'swe-2-max'), undefined,
    'contested order 3 drops swe-2-max eligibility');
});

test('Fast Mode dimension parses strictly and FastMode variants never bind', () => {
  const withFast = (fastOrder, extra = '') => cat(s(1, 'F'), s(22, 'fusion-a-sidekick-swe-x'),
    fam(dimEntry(4, 'Luna'), m(2, cat(s(1, 'Fast Mode'), m(2, cat(v(1, fastOrder), s(2, extra), v(3, 2)))))));
  assert.deepEqual(collectNativeModels(cat(m(1, withFast(0))), { rpc: 'GetCliModelConfigs', format: proto })[0].sidekickDimension,
    { order: 4, name: 'Luna', fastModeOrder: 0 });
  assert.deepEqual(collectNativeModels(cat(m(1, withFast(1))), { rpc: 'GetCliModelConfigs', format: proto })[0].sidekickDimension,
    { order: 4, name: 'Luna', fastModeOrder: 1 });
  const noFast = cat(s(1, 'F'), s(22, 'fusion-a-sidekick-swe-x'), fam(dimEntry(4, 'Luna'), m(2, cat(s(1, 'Fast Mode'), m(2, cat(v(1, 0)))))));
  assert.deepEqual(collectNativeModels(cat(m(1, noFast)), { rpc: 'GetCliModelConfigs', format: proto })[0].sidekickDimension,
    { order: 4, name: 'Luna', fastModeOrder: 0 }, 'a nameless Fast Mode entry still counts');
  const natives = [{ uid: 'swe-fast', label: 'F', disabled: false, isModelRouter: false, harnessUids: ['gpt-5p6'] }];
  const bound = buildCatalog(config(), [...natives,
    { uid: 'fusion-a-sidekick-swe-fast', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'],
      sidekickDimension: { order: 4, name: 'F', fastModeOrder: 1 } }]);
  assert.equal(bound.sidekicks.find(item => item.uid === 'swe-fast'), undefined,
    'a Fast Mode variant is excluded from canonical claims even with an exact suffix');
});

test('suffix binding is exact: invented tails never bind the base uid', () => {
  const natives = [{ uid: 'gpt-5-6-luna-high', label: 'L', disabled: false, isModelRouter: false, harnessUids: ['gpt-5p6'] }];
  const invented = buildCatalog(config(), [...natives,
    { uid: 'fusion-a-sidekick-gpt-5-6-luna-high-invented', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'],
      sidekickDimension: { order: 4, name: 'Luna' } }]);
  assert.equal(invented.sidekicks.find(item => item.uid === 'gpt-5-6-luna-high'), undefined,
    'an unknown suffix tail must not grant the base uid unfamiliar-harness eligibility');
});

test('order and uid claim conflicts poison both the uids and the contested orders', () => {
  const natives = ['swe-a', 'swe-b', 'swe-c', 'swe-d', 'swe-2-max'].map(uid =>
    ({ uid, label: uid, disabled: false, isModelRouter: false, harnessUids: uid === 'swe-2-max' ? ['swe-1p6', 'swe-1p5'] : ['odd-' + uid] }));
  const bind = (fusionUid, order, name, disabled = false) =>
    ({ uid: fusionUid, label: 'F', disabled, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order, name } });
  const maxOfficial = bind('fusion-lead-a-sidekick-swe-2-max', 3, 'SWE-2 Max');
  const threeClaimers = buildCatalog(config(), [...natives, maxOfficial,
    bind('fusion-x-sidekick-swe-a', 9, 'A'), bind('fusion-y-sidekick-swe-b', 9, 'B'), bind('fusion-z-sidekick-swe-c', 9, 'C')]);
  for (const uid of ['swe-a', 'swe-b', 'swe-c'])
    assert.equal(threeClaimers.sidekicks.find(item => item.uid === uid), undefined, uid + ' shares a contested order');
  const orderNineLater = buildCatalog(config(), [...natives, maxOfficial,
    bind('fusion-x-sidekick-swe-a', 9, 'A'), bind('fusion-y-sidekick-swe-b', 9, 'B'),
    bind('fusion-w-sidekick-swe-d', 9, 'D')]);
  assert.equal(orderNineLater.sidekicks.find(item => item.uid === 'swe-d'), undefined,
    'a poisoned order never becomes claimable by a later contender');
  const uidConflict = buildCatalog(config(), [...natives, maxOfficial,
    bind('fusion-x-sidekick-swe-a', 9, 'A'), bind('fusion-y-sidekick-swe-a', 11, 'B'),
    bind('fusion-z-sidekick-swe-d', 11, 'B')]);
  assert.equal(uidConflict.sidekicks.find(item => item.uid === 'swe-a'), undefined, 'inconsistent claims conflict the uid');
  assert.equal(uidConflict.sidekicks.find(item => item.uid === 'swe-d'), undefined,
    'an order touched by a conflicting uid poisons unrelated claimers at that order');
  const maxModel = uidConflict.models.find(model => model.kind === 'matrix' && uidConflict.fusions[model.uid].sidekickUid === 'swe-2-max');
  const poisonedThree = buildCatalog(config(), [...natives,
    bind('fusion-x-sidekick-swe-a', 3, 'A'), bind('fusion-y-sidekick-swe-b', 3, 'B')]);
  assert.equal(poisonedThree.sidekicks.find(item => item.uid === 'swe-2-max'), undefined,
    'unpaired swe-2-max cannot join sidekicks without an official pairing');
  assert.ok(maxModel && uidConflict.sidekicks.find(item => item.uid === 'swe-2-max').dimension.order === 3, 'swe-2-max keeps canonical order 3 when officially bound');
});

test('the official Fusion family card mirrors both BYOK members and native pairings', () => {
  const probe = buildCatalog(config(), OBSERVED_SWE);
  const routeUid = (model, effort) => Object.values(probe.routes).find(route => route.model === model && route.effort === effort).uid;
  const leadUid = routeUid('grok-4.6', 'high'), byokLead = routeUid('ws-swe-2-max', null), byokSide = routeUid('some-model', null);
  const mixed = `fusion-${leadUid}-sidekick-swe-2-max`, both = `fusion-${byokLead}-sidekick-${byokSide}`;
  for (const uid of [mixed, both]) {
    const model = probe.models.find(model => model.uid === uid);
    assert.ok(model, uid + ' emitted as a family entry');
    assert.ok(probe.matrixUids.has(uid), uid + ' tracked as own');
    assert.equal(model.json.modelInfo.modelFamilyUid, 'fusion');
    assert.equal(model.json.modelInfo.isModelRouter, true);
    assert.equal(model.json.modelInfo.displayOption, 3);
    const dims = Object.fromEntries(model.json.modelFamilyMetadata.entries.map(entry => [entry.key, entry.value]));
    assert.equal(model.json.modelFamilyMetadata.modelFamilyLabel, 'Fusion');
    assert.deepEqual(dims['Fast Mode'], { controlType: 2 }, 'constant dims match the official shape');
    assert.deepEqual(dims['Recommended Sidekick'], { name: dims.Sidekick.name });
    assert.ok(dims.Lead.name && dims.Sidekick.name, 'member dims present');
  }
  const mixedDims = Object.fromEntries(probe.models.find(model => model.uid === mixed).json.modelFamilyMetadata.entries.map(entry => [entry.key, entry.value]));
  assert.equal(mixedDims.Lead.name, 'CPA · Grok 4.6');
  assert.equal(mixedDims.Effort.name, 'High');
  assert.equal(mixedDims.Sidekick.name, 'SWE-2 Max');
  const bothDims = Object.fromEntries(probe.models.find(model => model.uid === both).json.modelFamilyMetadata.entries.map(entry => [entry.key, entry.value]));
  assert.equal(bothDims.Effort, undefined, 'effortless leads declare no Effort dimension');
  const assign = resolveAssignment({ modelRouterUid: mixed }, json, probe);
  assert.equal(assign.assignment.modelUid, leadUid);
  assert.deepEqual(assign.assignment.harnessUids, ['fusion']);
  const sideAssign = resolveAssignment({ fusionLeadRouterUid: mixed }, json, probe);
  assert.equal(sideAssign.assignment.modelUid, 'swe-2-max');
  assert.deepEqual(sideAssign.assignment.harnessUids, ['swe-1p6', 'swe-1p5']);
  const bothAssign = resolveAssignment({ fusionLeadRouterUid: both }, json, probe);
  assert.equal(bothAssign.assignment.modelUid, byokSide);
  const dropped = buildCatalog({ ...config(), providers: [] }, OBSERVED_SWE);
  assert.equal(dropped.matrixUids.size, 0, 'without a provider nothing is emitted');
  assert.equal(dropped.models.find(model => model.uid === mixed), undefined);
});

test('a model is never emitted as its own Sidekick, matching the official grid', () => {
  for (const fusion of Object.values(catalog.fusions)) {
    const lead = catalog.routes[fusion.leadUid], side = catalog.routes[fusion.sidekickUid];
    if (lead && side) assert.ok(lead.providerId !== side.providerId || lead.model !== side.model,
      `${fusion.uid} pairs a BYOK model with itself`);
  }
});

test('the matrix emits the full lead-by-sidekick cross product so dropdowns stay switchable', () => {
  const probe = buildCatalog(config(), OBSERVED_SWE);
  const matrix = probe.models.filter(model => model.kind === 'matrix');
  const leadUids = [...new Set(matrix.map(model => probe.fusions[model.uid].leadUid))].sort();
  assert.deepEqual(leadUids, probe.rolePool.lead.map(item => item.uid).sort(),
    'every selected Lead variant is a Lead in the matrix');
  const perLead = leadUids.map(lead => matrix.filter(model => probe.fusions[model.uid].leadUid === lead));
  // Per-lead counts differ by family: each lead loses its own family's Sidekick
  // values (grok-4.6 loses two variants, others lose one), like official holes.
  for (const items of perLead) {
    assert.ok(items.length >= 2, 'every Lead keeps at least two Sidekicks, or its dropdown locks');
  }
  assert.equal(probe.matrixUids.size, matrix.length);
  for (const items of perLead) {
    const sides = items.map(model => probe.fusions[model.uid].sidekickUid);
    assert.equal(new Set(sides).size, sides.length, 'a Lead never repeats a Sidekick');
  }
  for (const model of matrix) {
    assert.match(model.uid, /^fusion-.+-sidekick-.+$/);
    assert.ok(probe.matrixUids.has(model.uid));
    assert.ok(probe.fusions[model.uid], 'matrix uid resolves through the fusions table');
    assert.equal(model.json.modelInfo.modelFamilyUid, 'fusion');
    assert.equal(model.json.modelInfo.isModelRouter, true);
    assert.equal(model.json.modelInfo.displayOption, 3);
    const dims = Object.fromEntries(model.json.modelFamilyMetadata.entries.map(entry => [entry.key, entry.value]));
    assert.equal(dims.Lead.controlType, 3);
    assert.equal(dims.Sidekick.controlType, 3);
    assert.deepEqual(dims['Fast Mode'], { controlType: 2 });
    assert.deepEqual(dims['Recommended Sidekick'], { name: dims.Sidekick.name });
    const fusion = probe.fusions[model.uid];
    const leadRoute = probe.routes[fusion.leadUid];
    if (leadRoute?.effort) {
      assert.equal(dims.Effort.controlType, 1, 'effort variants declare the Effort dimension');
      assert.equal(dims.Effort.name, leadRoute.effort === 'high' ? 'High' : 'Medium');
      assert.equal(dims.Effort.order, leadRoute.effort === 'high' ? 3 : 2);
      assert.ok(!dims.Lead.name.endsWith(dims.Effort.name), 'Lead dimension names carry no effort suffix');
    } else if (!fusion.leadNative) {
      assert.equal(dims.Effort, undefined, 'effortless leads declare no Effort dimension');
    }
    assert.match(model.label, /^Fusion \(.+ \+ .+\)$/);
  }
  const labels = matrix.map(model => model.label);
  assert.equal(new Set(labels).size, labels.length, 'effort variants of one pair keep distinct labels');
  const byokVariant = matrix.filter(model => model.json.modelFamilyMetadata.entries.some(entry => entry.key === 'Effort'));
  assert.ok(byokVariant.length >= 2, 'multi-effort leads emit one entry per variant');
});

test('unemitted official-shaped fusion uids resolve by uid split with observed harnesses', () => {
  const probe = buildCatalog(config(), OBSERVED_SWE);
  const byokLead = Object.keys(probe.routes)[0], byokSide = Object.keys(probe.routes)[1];
  // swe-odd is observed and routeable but not a selected Sidekick, so the picker
  // can legitimately offer the pair even though we never emitted it.
  const uid = `fusion-${byokLead}-sidekick-swe-odd`;
  assert.ok(!Object.hasOwn(probe.fusions, uid), 'fixture pair is genuinely un-emitted');
  const assign = resolveAssignment({ modelRouterUid: uid }, json, probe);
  assert.equal(assign.assignment.modelUid, byokLead);
  assert.deepEqual(assign.assignment.harnessUids, ['fusion']);
  const side = resolveAssignment({ fusionLeadRouterUid: uid }, json, probe);
  assert.equal(side.assignment.modelUid, 'swe-odd');
  assert.deepEqual(side.assignment.harnessUids, ['swe-odd-harness']);
  const nativeLead = resolveAssignment({ modelRouterUid: `fusion-swe-2-max-sidekick-${byokSide}` }, json, probe);
  assert.equal(nativeLead.assignment.modelUid, 'swe-2-max');
  assert.ok(nativeLead.assignment.harnessUids.includes('fusion'), 'native lead harness comes from observed records');
  const unknown = resolveAssignment({ modelRouterUid: `fusion-${byokLead}-sidekick-native-never-observed` }, json, probe);
  assert.equal(resolveAssignment({ fusionLeadRouterUid: `fusion-${byokLead}-sidekick-native-never-observed` }, json, probe), null,
    'a never-observed native sidekick fails closed');
  assert.equal(unknown.assignment.modelUid, byokLead, 'the BYOK lead still resolves from routes');
});

test('fast-mode fusion uids are refused outright instead of downgraded', () => {
  const probe = buildCatalog(config(), OBSERVED_SWE);
  const byokLead = Object.keys(probe.routes)[0];
  assert.equal(resolveAssignment({ modelRouterUid: `fusion-${byokLead}-fast-sidekick-swe-2-max` }, json, probe), null);
  assert.equal(resolveAssignment({ fusionLeadRouterUid: `fusion-${byokLead}-fast-sidekick-swe-2-max` }, json, probe), null);
  assert.equal(resolveAssignment({ modelRouterUid: 'fusion--sidekick-swe-2-max' }, json, probe), null);
  assert.equal(resolveAssignment({ modelRouterUid: `fusion-${byokLead}-sidekick-` }, json, probe), null);
});

test('matrix dimension orders are hash-stable across catalog generations', () => {
  const sweX = { uid: 'swe-x', label: 'SWE-X', disabled: false, isModelRouter: false, harnessUids: [] };
  const withX = buildCatalog(config(), [...OBSERVED_SWE, sweX,
    { uid: 'fusion-claude-fable-5-1-medium-sidekick-swe-x', label: 'F', disabled: false, isModelRouter: true,
      harnessUids: ['fusion'], sidekickDimension: { order: 9, name: 'SWE-X' } }]);
  const leadOrders = cat => new Map(cat.models.filter(model => model.kind === 'matrix')
    .map(model => [model.uid, Object.fromEntries(model.json.modelFamilyMetadata.entries.map(entry => [entry.key, entry.value])).Lead]));
  const a = leadOrders(buildCatalog(config(), OBSERVED_SWE));
  const b = leadOrders(withX);
  const byName = map => {
    const names = new Map();
    for (const dim of map.values()) names.set(dim.name, dim.order);
    return names;
  };
  const namesA = byName(a), namesB = byName(b);
  for (const [name, order] of namesA) {
    assert.equal(namesB.get(name), order, `lead dim "${name}" keeps its order when the sidekick pool grows`);
  }
  const orders = [...namesB.values()];
  assert.equal(new Set(orders).size, orders.length, 'custom lead orders never collide');
  for (const order of orders) assert.ok(order >= 0x10000000, 'custom orders stay out of the official range');
});

test('custom dimension values group per provider ranked by name, never by config position', () => {
  const grouped = buildCatalog({
    providers: [
      { id: 'zeta', name: 'Zeta', baseUrl: 'https://zeta.invalid/v1', apiKey: 'k', apiFormat: 'openai',
        models: [
          { id: 'zeta-b', label: 'zeta-b', efforts: ['high', 'max'], contextWindow: 128000, maxOutputTokens: 8192 },
          { id: 'zeta-a', label: 'zeta-a', efforts: ['max'], contextWindow: 128000, maxOutputTokens: 8192 },
        ] },
      { id: 'alpha', name: 'Alpha', baseUrl: 'https://alpha.invalid/v1', apiKey: 'k', apiFormat: 'openai',
        models: [
          { id: 'alpha-b', label: 'alpha-b', efforts: ['max'], contextWindow: 128000, maxOutputTokens: 8192 },
          { id: 'alpha-a', label: 'alpha-a', efforts: ['high'], contextWindow: 128000, maxOutputTokens: 8192 },
        ] },
    ],
    sidekicks: [
      { providerId: 'zeta', model: 'zeta-b' }, { providerId: 'zeta', model: 'zeta-a' },
      { providerId: 'alpha', model: 'alpha-b' }, { providerId: 'alpha', model: 'alpha-a' },
    ],
  }, [], null);
  const dims = key => {
    const seen = new Map();
    for (const model of grouped.models) {
      if (model.kind !== 'matrix') continue;
      const entry = model.json.modelFamilyMetadata.entries.find(item => item.key === key);
      if (entry && !seen.has(entry.value.name)) seen.set(entry.value.name, entry.value.order);
    }
    return [...seen].sort((a, b) => a[1] - b[1]);
  };
  const lead = dims('Lead');
  assert.deepEqual(lead.map(([name]) => name),
    ['Alpha · alpha-a', 'Alpha · alpha-b', 'Zeta · zeta-a', 'Zeta · zeta-b'],
    'providers sort by name and models sort inside the block');
  const side = dims('Sidekick');
  assert.deepEqual(side.map(([name]) => name),
    ['Alpha · alpha-a High', 'Alpha · alpha-b Max', 'Zeta · zeta-a Max', 'Zeta · zeta-b High', 'Zeta · zeta-b Max'],
    'inside a provider, models sort by name and effort tiers by slot order');
  for (const list of [lead, side]) {
    const orders = list.map(([, order]) => order);
    assert.equal(new Set(orders).size, orders.length, 'orders are unique per dimension');
    for (const order of orders) assert.ok(order >= 0x10000000, 'custom orders stay out of the official range');
  }
});

test('lead families without an observed Effort dimension still aggregate by uid tier', () => {
  const roles = buildRoleLists(config(), [
    nativeLead('deepseek-v4-flash-high', 'DeepSeek V4 Flash High'),
    nativeLead('deepseek-v4-flash-max', 'DeepSeek V4 Flash Max'),
    nativeLead('deepseek-v4-pro-high', 'DeepSeek V4 Pro High'),
    nativeLead('deepseek-v4-pro-max', 'DeepSeek V4 Pro Max')]);
  const families = roles.lead.filter(item => item.native);
  const flash = families.filter(item => item.label === 'DeepSeek V4 Flash');
  assert.equal(flash.length, 1, 'the two tiers are one row, not two same-named rows');
  assert.deepEqual(flash[0].memberUids.sort(), ['deepseek-v4-flash-high', 'deepseek-v4-flash-max']);
  const pro = families.filter(item => item.label === 'DeepSeek V4 Pro');
  assert.equal(pro.length, 1);
  assert.deepEqual(pro[0].memberUids.sort(), ['deepseek-v4-pro-high', 'deepseek-v4-pro-max']);
});

test('official Fast Mode siblings join the official family and inherit its dimensions', () => {
  const natives = [OFFICIAL_SIDEKICK, ...officialSeries('claude-x', 7, 'Claude X'),
    ...fastSiblings('claude-x', 'Claude X', ['low', 'medium', 'high', 'xhigh', 'max'])];
  const roles = buildRoleLists(config(), natives);
  const rows = roles.lead.filter(item => item.native && item.label === 'Claude X');
  assert.equal(rows.length, 1, 'fast variants merge into the official row instead of a second same-named row');
  assert.equal(rows[0].memberUids.length, 10, 'five tiers plus their five Fast Mode siblings');
  assert.ok(rows[0].memberUids.includes('claude-x-high-fast'));

  const catalog = buildCatalog(config(), natives);
  const emitted = catalog.models.filter(model => model.kind === 'matrix' && /-fast-sidekick-dfbyok-/.test(model.uid));
  assert.equal(emitted.length, 0,
    'aggregated fast leads stay in the role list but are never emitted — a matrix entry cannot carry the Fast Mode order they would need');
  const nonFast = catalog.models.filter(model => model.kind === 'matrix' && model.uid.startsWith('fusion-claude-x-high-sidekick-'));
  assert.ok(nonFast.length > 0, 'the non-fast twins still pair with BYOK sidekicks');
  for (const model of nonFast) {
    const dims = Object.fromEntries(model.json.modelFamilyMetadata.entries.map(entry => [entry.key, entry.value]));
    assert.deepEqual(dims.Lead, { order: 7, name: 'Claude X', controlType: 3 },
      'a non-fast official lead reuses the official Lead value: ' + model.uid);
    assert.deepEqual(dims.Effort, { order: 3, name: 'High', controlType: 1 }, model.uid);
  }
});

test('a non-fast non-official uid with a tier token joins the official family', () => {
  const natives = [OFFICIAL_SIDEKICK, ...officialSeries('gpt-sol', 4, 'GPT Sol'),
    nativeLead('gpt-sol-none', 'GPT Sol No Thinking',
      [{ key: 'Effort', order: 0, name: 'No Thinking', controlType: 1 }, { key: 'Fast Mode', order: 0 }])];
  const roles = buildRoleLists(config(), natives);
  const official = roles.lead.filter(item => item.native && item.label === 'GPT Sol');
  assert.equal(official.length, 1);
  assert.equal(official[0].memberUids.length, 6, 'the none sibling is an extra Effort value of the official family');
  assert.ok(official[0].memberUids.includes('gpt-sol-none'));

  const catalog = buildCatalog(config(), natives);
  const emitted = catalog.models.filter(model => model.kind === 'matrix' && model.uid.startsWith('fusion-gpt-sol-none-sidekick-dfbyok-'));
  assert.ok(emitted.length > 0, 'the default-selected family emits the extra tier with BYOK sidekicks');
  for (const model of emitted) {
    const dims = Object.fromEntries(model.json.modelFamilyMetadata.entries.map(entry => [entry.key, entry.value]));
    assert.deepEqual(dims.Lead, { order: 4, name: 'GPT Sol', controlType: 3 },
      'the admitted member inherits the official Lead identity: ' + model.uid);
    assert.equal(dims.Effort.name, 'No Thinking', 'its own tier token supplies the Effort name');
    assert.ok(!Object.values(OFFICIAL_EFFORT_ORDERS).includes(dims.Effort.order) &&
      dims.Effort.order > 0x10000000,
      'No Thinking lives outside the official Effort space on a hash order, not on an invented official slot');
  }
});

test('the observed team-settings allowlist gates native role candidates', () => {
  const natives = [
    nativeLead('spark-medium', 'Spark Medium'),
    nativeLead('swe-2-max', 'SWE-2 Max')];
  const nativeUids = list => new Set(list.flatMap(item =>
    item.native ? (item.memberUids || [item.ref.nativeUid]) : []));

  const open = buildRoleLists(config(), natives);
  assert.ok(nativeUids(open.lead).has('spark-medium'), 'without an allowlist every harnessed uid is a candidate');

  const gated = buildRoleLists(config(), natives, new Set(['swe-2-max']));
  assert.ok(!nativeUids(gated.lead).has('spark-medium'),
    'a uid outside the allowlist is a retired leftover — emitting its combos could never register in f7');
  assert.ok(!nativeUids(gated.sidekick).has('spark-medium'));
  assert.ok(nativeUids(gated.lead).has('swe-2-max'));

  assert.ok(nativeUids(buildRoleLists(config(), natives, new Set()).lead).has('spark-medium'),
    'an empty allowlist means "not observed yet" and restricts nothing');

  const gatedCatalog = buildCatalog(config(), natives, new Set(['swe-2-max']));
  assert.equal([...gatedCatalog.matrixUids].filter(uid => uid.includes('spark-medium')).length, 0);
  assert.ok([...gatedCatalog.matrixUids].some(uid => uid.includes('swe-2-max')));
});

test('a scale qualifier joins the same tier family', () => {
  const roles = buildRoleLists(config(), [
    nativeLead('glm-x-high', 'GLM X High', [{ key: 'Effort', order: 1, name: 'High', controlType: 1 }]),
    nativeLead('glm-x-1m', 'GLM X High 1M', [{ key: 'Effort', order: 1, name: 'High', controlType: 1 }]),
    nativeLead('glm-x-max-1m', 'GLM X Max 1M', [{ key: 'Effort', order: 2, name: 'Max', controlType: 1 }]),
    nativeLead('glm-x-none-1m', 'GLM X No Thinking 1M', [{ key: 'Effort', order: 0, name: 'No Thinking', controlType: 1 }])]);
  const scaled = roles.lead.filter(item => item.native && item.label === 'GLM X 1M');
  assert.equal(scaled.length, 1, 'the three 1M variants collapse into a single row');
  assert.deepEqual(scaled[0].memberUids.sort(), ['glm-x-1m', 'glm-x-max-1m', 'glm-x-none-1m']);
  const plain = roles.lead.find(item => item.native && item.label === 'GLM X');
  assert.deepEqual(plain.memberUids, ['glm-x-high'], 'the unscaled sibling keeps its own row');
});

test('every member of a selected family emits the same Lead name with its own Effort', () => {
  const natives = [
    nativeLead('glm-x-1m', 'GLM X High 1M', [{ key: 'Effort', order: 1, name: 'High', controlType: 1 }]),
    nativeLead('glm-x-max-1m', 'GLM X Max 1M', [{ key: 'Effort', order: 2, name: 'Max', controlType: 1 }]),
    nativeLead('glm-x-none-1m', 'GLM X No Thinking 1M', [{ key: 'Effort', order: 0, name: 'No Thinking', controlType: 1 }])];
  const cfg = { ...config(), roleInclusions: { lead: [{ nativeUid: 'glm-x-1m' }] } };
  const catalog = buildCatalog(cfg, natives);
  const emitted = catalog.models.filter(model => model.kind === 'matrix' &&
    /^fusion-glm-x-(1m|max-1m|none-1m)-sidekick-/.test(model.uid));
  assert.ok(emitted.length > 0, 'the included family emits combinations');
  const leadNames = new Set(emitted.map(model =>
    model.json.modelFamilyMetadata.entries.find(entry => entry.key === 'Lead').value.name));
  assert.deepEqual([...leadNames], ['GLM X 1M'], 'all members share the family label as the Lead name');
  for (const model of emitted) {
    const effort = model.json.modelFamilyMetadata.entries.find(entry => entry.key === 'Effort')?.value;
    assert.ok(effort && typeof effort.name === 'string' && Number.isSafeInteger(effort.order),
      'every member carries an Effort value: ' + model.uid);
  }
});

test('a native member emits the official Effort order for a same-named tier', () => {
  // The observed Effort order lives in another space (here High=1); the emitted
  // value must use the official space (High=3) or the picker shows two Highs.
  const natives = [OFFICIAL_SIDEKICK, ...officialSeries('claude-x', 7, 'Claude X'),
    nativeLead('luna-high', 'Luna High', [{ key: 'Effort', order: 1, name: 'High', controlType: 1 }]),
    nativeLead('luna-max', 'Luna Max', [{ key: 'Effort', order: 2, name: 'Max', controlType: 1 }])];
  const cfg = { ...config(), roleInclusions: { lead: [{ nativeUid: 'luna-high' }] } };
  const catalog = buildCatalog(cfg, natives);
  const emitted = catalog.models.filter(model => model.kind === 'matrix' && model.uid.startsWith('fusion-luna-'));
  assert.ok(emitted.length > 0, 'the included family emits');
  for (const model of emitted) {
    const dims = Object.fromEntries(model.json.modelFamilyMetadata.entries.map(entry => [entry.key, entry.value]));
    assert.equal(dims.Effort.order, OFFICIAL_EFFORT_ORDERS[dims.Effort.name.toLowerCase()],
      dims.Effort.name + ' must reuse the official order, not the observed one: ' + model.uid);
  }
});

test('emitted entries never give one dimension name two different orders', () => {
  const catalog = buildCatalog(config(), [OFFICIAL_SIDEKICK, ...officialSeries('claude-x', 7, 'Claude X'),
    ...fastSiblings('claude-x', 'Claude X', ['low', 'medium', 'high', 'xhigh', 'max'])]);
  for (const key of ['Lead', 'Effort', 'Sidekick']) {
    const ordersByName = new Map();
    for (const model of catalog.models) {
      const dims = Object.fromEntries(model.json.modelFamilyMetadata.entries.map(entry => [entry.key, entry.value]));
      const value = dims[key];
      if (!value || typeof value.name !== 'string' || value.order === undefined) continue;
      if (!ordersByName.has(value.name)) ordersByName.set(value.name, new Set());
      ordersByName.get(value.name).add(value.order);
    }
    for (const [name, orders] of ordersByName) {
      assert.equal(orders.size, 1, `${key} "${name}" must keep a single order, got ${[...orders]}`);
    }
  }
});

test('priority-named fast siblings join their effort family too', () => {
  // An official family gains a -priority sibling the same way it gains -fast ones.
  const natives = [OFFICIAL_SIDEKICK, ...officialSeries('claude-x', 7, 'Claude X'),
    ...fastSiblings('claude-x', 'Claude X', ['high'], 'priority')];
  const roles = buildRoleLists(config(), natives);
  const rows = roles.lead.filter(item => item.native && item.label === 'Claude X');
  assert.equal(rows.length, 1, 'the -priority sibling merges into the official row');
  assert.equal(rows[0].memberUids.length, 6);
  assert.ok(rows[0].memberUids.includes('claude-x-high-priority'));

  // A non-official effort series groups its -priority variants identically
  // (the GPT Luna/Terra shape: labels write "Thinking Fast").
  const luna = buildRoleLists(config(), [
    nativeLead('luna-low', 'Luna Low Thinking'), nativeLead('luna-medium', 'Luna Medium Thinking'),
    nativeLead('luna-high', 'Luna High Thinking'),
    ...['low', 'medium', 'high'].map(tier => nativeLead(`luna-${tier}-priority`,
      `Luna ${OFFICIAL_EFFORT_NAMES[OFFICIAL_EFFORT_ORDERS[tier]]} Thinking Fast`, [{ key: 'Fast Mode', order: 1 }]))]);
  const lunaRows = luna.lead.filter(item => item.native && item.label === 'Luna');
  assert.equal(lunaRows.length, 1, 'six variants collapse into a single Luna row');
  assert.equal(lunaRows[0].memberUids.length, 6);
  assert.ok(!/Fast/.test(lunaRows[0].label), 'no Fast marker survives in the family label');
});

test('no emitted matrix entry carries a fast lead uid', () => {
  const natives = [OFFICIAL_SIDEKICK, ...officialSeries('claude-x', 7, 'Claude X'),
    ...fastSiblings('claude-x', 'Claude X', ['low', 'xhigh'], 'fast'),
    ...fastSiblings('claude-x', 'Claude X', ['medium', 'high'], 'priority')];
  const catalog = buildCatalog(config(), natives);
  const fastUids = new Set(natives.filter(entry => (entry.fusionMetadata || [])
    .some(dim => dim.key === 'Fast Mode' && dim.order !== 0)).map(entry => entry.uid));
  assert.equal(fastUids.size, 4, 'fixture covers both fast spellings');
  for (const uid of catalog.matrixUids) {
    const marker = uid.lastIndexOf('-sidekick-');
    const leadUid = uid.slice('fusion-'.length, marker);
    assert.ok(!fastUids.has(leadUid),
      uid + ' must not be emitted — it duplicates its non-fast twin dimension for dimension');
  }
});

test('non-fast official leads still emit alongside the fast-lead filter', () => {
  const catalog = buildCatalog(config(), [OFFICIAL_SIDEKICK, ...officialSeries('claude-x', 7, 'Claude X'),
    ...fastSiblings('claude-x', 'Claude X', ['high'], 'priority')]);
  assert.ok([...catalog.matrixUids].some(uid => uid.startsWith('fusion-claude-x-high-sidekick-dfbyok-')),
    'the non-fast twin keeps pairing with BYOK sidekicks');
  assert.ok(![...catalog.matrixUids].some(uid => uid.includes('-priority-sidekick-')),
    'the priority sibling never emits as a lead');
});

test('officially declared harnessless leads qualify; fast siblings aggregate but never emit', () => {
  // The gpt-6-astra-* shape: the official Fusion card declares them as leads
  // while the native entries carry harnessUids=[] — under Fusion the lead runs
  // on the combination's declared harnesses (['fusion'] plus the lead's own,
  // degrading to bare ['fusion'] for a harnessless lead), so a missing own harness cannot
  // disqualify it (a real catalog carries 40 such combos). Sidekick eligibility
  // still requires a harness, and a harnessless uid with no official claim and
  // no official family base stays out of both pools.
  const astra = (uid, label, fusionMetadata = []) =>
    ({ uid, label, disabled: false, isModelRouter: false, harnessUids: [], fusionMetadata });
  const natives = [OFFICIAL_SIDEKICK,
    astra('gpt-6-astra-low', 'GPT-6 Astra Low', [{ key: 'Effort', order: 1, name: 'Low', controlType: 1 }, { key: 'Fast Mode', order: 0 }]),
    astra('gpt-6-astra-high', 'GPT-6 Astra High', [{ key: 'Effort', order: 3, name: 'High', controlType: 1 }, { key: 'Fast Mode', order: 0 }]),
    astra('gpt-6-astra-low-priority', 'GPT-6 Astra Low Fast', [{ key: 'Effort', order: 1, name: 'Low', controlType: 1 }, { key: 'Fast Mode', order: 1 }]),
    astra('gpt-6-astra-high-priority', 'GPT-6 Astra High Fast', [{ key: 'Effort', order: 3, name: 'High', controlType: 1 }, { key: 'Fast Mode', order: 1 }]),
    astra('orphan-high', 'Orphan High'),
    officialCombo('gpt-6-astra-low', 9, 'GPT-6 Astra', OFFICIAL_EFFORT_ORDERS.low),
    officialCombo('gpt-6-astra-high', 9, 'GPT-6 Astra', OFFICIAL_EFFORT_ORDERS.high)];
  const roles = buildRoleLists(config(), natives);
  const astraRow = roles.lead.find(item => item.native && item.label === 'GPT-6 Astra');
  assert.ok(astraRow, 'a harnessless native with an official Lead declaration is eligible');
  assert.equal(astraRow.official, true);
  assert.equal(astraRow.selected, true, 'an official family stays selected by default');
  assert.deepEqual([...astraRow.memberUids].sort(),
    ['gpt-6-astra-high', 'gpt-6-astra-high-priority', 'gpt-6-astra-low', 'gpt-6-astra-low-priority'],
    'the harnessless -priority siblings aggregate into the same official family row');
  assert.equal(roles.lead.some(item => (item.memberUids || []).includes('orphan-high')), false,
    'a harnessless uid with neither a declaration nor an official family base is no lead');
  const memberUidsOf = item => item.memberUids || [item.ref.nativeUid];
  assert.equal(roles.sidekick.some(item => memberUidsOf(item).includes('orphan-high')), false);
  assert.equal(roles.sidekick.some(item => memberUidsOf(item).some(uid => typeof uid === 'string' && uid.startsWith('gpt-6-astra'))), false,
    'harnessless members never become sidekicks');

  const catalog = buildCatalog(config(), natives);
  const emitted = [...catalog.matrixUids].filter(uid => uid.startsWith('fusion-gpt-6-astra'));
  const leadOf = uid => catalog.fusions[uid].leadUid;
  assert.deepEqual(new Set(emitted.map(leadOf)), new Set(['gpt-6-astra-low', 'gpt-6-astra-high']),
    'both declared tiers emit combinations');
  assert.equal(emitted.filter(uid => uid.includes('-priority-sidekick-')).length, 0,
    'the aggregated fast siblings never emit as leads');
  for (const uid of emitted) {
    assert.deepEqual(catalog.fusions[uid].leadHarnessUids, ['fusion'],
      'the lead harness comes from the combination entry, not the member');
    const assign = resolveAssignment({ modelRouterUid: uid }, json, catalog);
    assert.equal(assign.assignment.modelUid, leadOf(uid));
    assert.deepEqual(assign.assignment.harnessUids, ['fusion']);
  }
});

test('no two emitted matrix entries share the exact same dimension tuple', () => {
  const catalog = buildCatalog(config(), [OFFICIAL_SIDEKICK, ...officialSeries('claude-x', 7, 'Claude X'),
    ...fastSiblings('claude-x', 'Claude X', ['low', 'medium', 'high', 'xhigh', 'max'])]);
  const seen = new Set();
  for (const model of catalog.models.filter(model => model.kind === 'matrix')) {
    const tuple = model.json.modelFamilyMetadata.entries
      .map(entry => entry.key + ':' + (entry.value.order ?? '') + ':' + (entry.value.name ?? '')).join('|');
    assert.ok(!seen.has(tuple), 'duplicate dimension tuple (the Fast twins are indistinguishable without the Fast Mode order): ' + model.uid);
    seen.add(tuple);
  }
});

test('a sidekick uid ending in -fast still pairs and emits', () => {
  const natives = [OFFICIAL_SIDEKICK, nativeLead('swe-fast', 'SWE Fast')];
  const cfg = { ...config(), roleInclusions: { sidekick: [{ nativeUid: 'swe-fast' }] } };
  const catalog = buildCatalog(cfg, natives);
  const marker = uid => uid.slice(uid.lastIndexOf('-sidekick-') + '-sidekick-'.length);
  const emitted = [...catalog.matrixUids].filter(uid => marker(uid) === 'swe-fast');
  assert.ok(emitted.length > 0, 'the -fast filter is lead-side only: a fast sidekick is a legitimate value of its own');
  for (const uid of emitted) assert.equal(uid.slice('fusion-'.length, uid.lastIndexOf('-sidekick-')).endsWith('-fast'), false, uid);
});

test('lead row labels are globally unique after family aggregation', () => {
  const roles = buildRoleLists(config(), [
    OFFICIAL_SIDEKICK, ...officialSeries('gpt-sol', 4, 'GPT Sol'),
    nativeLead('gpt-sol-none', 'GPT Sol No Thinking',
      [{ key: 'Effort', order: 0, name: 'No Thinking', controlType: 1 }, { key: 'Fast Mode', order: 0 }]),
    nativeLead('x-high', 'X High'), nativeLead('x-max', 'X Max'),
    nativeLead('x-none', 'X')]);
  const labels = roles.lead.map(item => item.label);
  assert.equal(new Set(labels).size, labels.length,
    'two rows sharing a label would collapse into one picker row: ' + JSON.stringify(labels.sort()));
});

test('matrix entries declare the native lead harness, matching resolveAssignment', () => {
  const claude = nativeLead('claude-x-high', 'Claude X High', [{ key: 'Effort', order: 1, name: 'High', controlType: 1 }]);
  claude.harnessUids = ['strawberry-pancake'];
  const gpt = nativeLead('gpt-x-high', 'GPT X High', [{ key: 'Effort', order: 1, name: 'High', controlType: 1 }]);
  gpt.harnessUids = ['gpt-5p6-codex', 'gpt-5p6'];
  const cfg = { ...config(), roleInclusions: { lead: [{ nativeUid: 'claude-x-high' }, { nativeUid: 'gpt-x-high' }] } };
  const built = buildCatalog(cfg, [...OBSERVED_SWE, claude, gpt]);
  const matrix = built.models.filter(model => model.kind === 'matrix');

  const claudeCombos = matrix.filter(model => model.uid.startsWith('fusion-claude-x-high-sidekick-'));
  assert.ok(claudeCombos.length >= 2, 'the included lead pairs with every selected sidekick representative');
  for (const model of claudeCombos) {
    assert.deepEqual(model.json.modelInfo.harnessUids, ['fusion', 'strawberry-pancake'], model.uid);
  }
  for (const model of matrix.filter(model => model.uid.startsWith('fusion-gpt-x-high-sidekick-'))) {
    assert.deepEqual(model.json.modelInfo.harnessUids, ['fusion', 'gpt-5p6-codex', 'gpt-5p6'], model.uid);
  }
  // BYOK leads keep the bare fusion router — whichever side they pair with.
  for (const model of matrix.filter(model => model.uid.startsWith('fusion-dfbyok-'))) {
    assert.deepEqual(model.json.modelInfo.harnessUids, ['fusion'], model.uid);
  }
  // Every emitted combination declares exactly what the lead assignment resolves to.
  for (const fusion of Object.values(built.fusions)) {
    const output = resolveAssignment(s(2, fusion.uid), proto, built);
    if (!output) continue;
    const emitted = built.models.find(model => model.uid === fusion.uid);
    assert.ok(emitted, fusion.uid + ' resolves without an emitted entry');
    assert.deepEqual(fields(getNested(output, 1), 3).map(field => field.value.toString()),
      emitted.json.modelInfo.harnessUids, fusion.uid);
  }
  // The proto encoding carries the same list the JSON metadata declares.
  for (const model of matrix) {
    assert.deepEqual(fields(getNested(model.raw, 23), 20).map(field => field.value.toString()),
      model.json.modelInfo.harnessUids, model.uid);
  }
  // Plain provider entries keep the sidekick harness pool.
  assert.deepEqual(built.models.find(model => model.kind === 'model').json.modelInfo.harnessUids, ['swe-1p6', 'swe-1p5']);
});

test('emitted fusion entries always carry fusion and never a sidekick harness', () => {
  for (const uid of catalog.matrixUids) {
    const harnesses = catalog.models.find(model => model.uid === uid).json.modelInfo.harnessUids;
    assert.ok(harnesses.includes('fusion'), `matrix entry ${uid} declares the fusion router`);
    assert.ok(!harnesses.includes('swe-1p6') && !harnesses.includes('swe-1p5'),
      `matrix entry ${uid} must not fall back to the sidekick harness pool`);
  }
});

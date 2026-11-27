'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { buildCatalog, augmentCatalog, resolveAssignment, collectNativeModels } = require('../src/catalog.cjs');
const { fields, str, num, s, v, m } = require('../src/protocol/wire.cjs');
const { cat, proto, json, lsStatus, config, OBSERVED_SWE, catalog, getNested, configs, statusFixture } = require('./helpers/catalog-fixtures.cjs');
const { webappAvailable, loadWebappPicker } = require('./helpers/installed-renderer.cjs');
const { digest } = require('../src/catalog/identity.cjs');

test('stable model identities and independent Lead/Sidekick orders survive reordering and label changes', () => {
  const reordered = config();
  reordered.providers.forEach((provider, index) => {
    provider.order = index;
    provider.models.forEach((model, slot) => { model.order = slot; });
  });
  reordered.providers.reverse();
  reordered.providers.forEach(provider => provider.models.reverse());
  const next = buildCatalog(reordered, OBSERVED_SWE);
  assert.deepEqual(new Set(next.models.map(model => model.uid)), new Set(catalog.models.map(model => model.uid)));
  for (const model of catalog.models.filter(model => model.kind === 'matrix')) {
    const same = next.models.find(value => value.uid === model.uid);
    assert.deepEqual(same.json.modelFamilyMetadata, model.json.modelFamilyMetadata);
    assert.deepEqual(model.json.modelFamilyMetadata.entries.map(entry => entry.key),
      ['Lead', 'Effort', 'Sidekick', 'Fast Mode', 'Recommended Sidekick'].filter(key => key !== 'Effort' || model.json.modelFamilyMetadata.entries.length === 5));
    assert.equal(model.json.modelInfo.modelFamilyUid, 'fusion');
  }
  const renamed = config();
  renamed.providers[0].name = 'Renamed';
  assert.deepEqual(new Set(buildCatalog(renamed, OBSERVED_SWE).models.map(model => model.uid)), new Set(catalog.models.map(model => model.uid)));
});

test('own protobuf metadata matches JSON and advertises required execution harnesses without copying prices', () => {
  for (const model of catalog.models) {
    assert.equal(str(model.raw, 22), model.uid);
    assert.equal(str(model.raw, 1), model.label);
    // Local routing is not an official BYOK entitlement or official price.
    assert.equal(num(model.raw, 13), 0);
    assert.equal(num(model.raw, 18), model.json.maxTokens);
    const info = getNested(model.raw, 23);
    assert.equal(num(info, 13), model.json.modelInfo.maxOutputTokens);
    assert.ok(num(info, 13) <= model.json.maxTokens);
    assert.equal(str(info, 17), model.uid);
    assert.deepEqual(fields(info, 20).map(field => field.value.toString()), model.json.modelInfo.harnessUids);
    assert.equal(num(info, 25), model.kind === 'matrix' ? 1 : 0);
    assert.equal(num(info, 22), model.kind === 'matrix' ? 3 : 0);
    assert.equal(fields(model.raw, 11).length, 0, 'no copied price message');
    assert.equal(fields(model.raw, 12).length, 0, 'no copied user eligibility');
    const family = getNested(model.raw, 30);
    assert.equal(str(family, 1), model.json.modelFamilyMetadata.modelFamilyLabel);
    // Decode preserving absence: the informational dimensions legitimately omit
    // order/name/controlType, so a 0/'' default would hide the official shape.
    const decodeValue = entry => {
      const inner = getNested(entry, 2), optional = number => {
        const found = fields(inner, number)[0];
        return found ? (found.wire === 2 ? found.value.toString('utf8') : found.value) : undefined;
      };
      const value = {};
      for (const [key, number] of [['order', 1], ['name', 2], ['controlType', 3]]) {
        const decoded = optional(number);
        if (decoded !== undefined) value[key] = decoded;
      }
      return value;
    };
    assert.deepEqual(fields(family, 2).map(field => ({ key: str(field.value, 1), value: decodeValue(field.value) })),
      model.json.modelFamilyMetadata.entries);
  }
});

test('duplicate labels are disambiguated and invalid provider identities fail before publishing', () => {
  const input = { providers: [{ id: 'a', name: 'Same', models: [{ id: 'x', label: 'X' }] },
    { id: 'b', name: 'Same', models: [{ id: 'x', label: 'X' }] }] };
  const result = buildCatalog(input);
  assert.equal(new Set(result.models.filter(model => model.kind === 'model').map(model => model.label)).size, 2);
  assert.throws(() => buildCatalog({ providers: [{ id: 'a', models: [{ id: 'x' }, { id: 'x' }] }] }), /Duplicate/);
  assert.throws(() => buildCatalog({ providers: [{ id: 'a', models: [{ id: 'x', efforts: ['HIGH'] }] }] }), /effort/);
});

test('models whose final labels collide stay distinct in the native mapper', () => {
  const built = buildCatalog({ providers: [{ id: 'p', name: 'P', models: [
    { id: 'foo', label: 'Foo', efforts: ['high'] },
    { id: 'foo-high', label: 'Foo High', effortMode: 'none' },
  ] }] }, [], null);
  const own = built.models.filter(model => model.uid.startsWith('dfbyok-') && model.kind === 'model');
  assert.equal(own.length, 2);
  assert.notEqual(own[0].label, own[1].label,
    'the native mapper resolves sort groups by label — a collision drops a uid');
  for (const model of own) assert.match(model.uid, /^dfbyok-p-[a-z0-9-]+-[0-9a-f]{16}$/, 'uid shape unchanged');
  // No collision → no disambiguation suffix.
  const solo = buildCatalog({ providers: [{ id: 'p', name: 'P', models: [
    { id: 'foo', label: 'Foo', efforts: ['high'] }] }] }, [], null);
  const single = solo.models.filter(model => model.kind === 'model');
  assert.equal(single.length, 1);
  assert.equal(single[0].label, 'P · Foo High');
});

test('final-label collisions are renamed family-wide, deterministically and without touching squatters', () => {
  const labels = built => Object.fromEntries(built.models
    .filter(model => model.kind === 'model')
    .map(model => [model.uid, model.label]));
  const families = built => {
    const byFamily = new Map();
    for (const model of built.models.filter(model => model.kind === 'model')) {
      const fam = model.json.modelFamilyMetadata.modelFamilyLabel;
      (byFamily.get(fam) || byFamily.set(fam, []).get(fam)).push(model.uid);
    }
    return byFamily;
  };
  const allFinal = built => built.models.map(model => model.label);

  // Foo with two efforts + Foo High with none: the High variant collides on
  // the final label, so BOTH families move to a keyed suffix — every variant
  // of a family keeps the same familyLabel (one Lead-dimension value).
  const baseModels = [{ id: 'foo', label: 'Foo', efforts: ['low', 'high'] },
    { id: 'foo-high', label: 'Foo High', effortMode: 'none' }];
  const models = order => order.map(i => baseModels[i]);
  const colliding = buildCatalog({ providers: [{ id: 'p', name: 'P', models: models([0, 1]) }] }, [], null);
  const fams = families(colliding);
  assert.equal(fams.size, 2, 'two families, each internally uniform');
  for (const [name, uids] of fams) assert.ok(name.includes('(') && name.includes(')'), 'colliding family renamed: ' + name);
  assert.equal(new Set(allFinal(colliding)).size, allFinal(colliding).length, 'every final label unique');
  const shuffled = buildCatalog({ providers: [{ id: 'p', name: 'P', models: models([1, 0]) }] }, [], null);
  assert.equal(models([1, 0])[0].id, 'foo-high', 'the input order really is reversed');
  assert.deepEqual(labels(shuffled), labels(colliding), 'config order never changes the keyed name');

  // A hand-written label squatting the exact generated name forces a counter
  // suffix — and the squatter itself is never rewritten.
  const digestOfFooHigh = digest(JSON.stringify(['p', 'foo-high'])).slice(0, 8);
  const squatterLabel = `Foo High (${digestOfFooHigh})`;
  const squatted = buildCatalog({ providers: [{ id: 'p', name: 'P', models: [
    { id: 'foo', label: 'Foo', efforts: ['high'] },
    { id: 'foo-high', label: 'Foo High', effortMode: 'none' },
    { id: 'squatter', label: squatterLabel, effortMode: 'none' }] }] }, [], null);
  const squatLabels = Object.values(labels(squatted));
  assert.equal(new Set(squatLabels).size, squatLabels.length, 'labels unique even under a deliberate squat');
  assert.ok(squatLabels.includes('P · ' + squatterLabel), 'the squatting hand-written label is preserved verbatim');
  assert.ok(squatLabels.some(label => label.includes(`${digestOfFooHigh}-`)), 'the displaced family escalates to a counter suffix');

  // Plain + matrix final labels all unique for the old counterexample shape.
  const trio = buildCatalog({ providers: [{ id: 'p', name: 'P', models: [
    { id: 'foo', label: 'Foo', efforts: ['high'] },
    { id: 'foo-high', label: 'Foo High', effortMode: 'none' },
    { id: 'bar', label: 'Foo (foo/high)', efforts: ['high'] }] }] }, [], null);
  const trioLabels = allFinal(trio);
  assert.equal(new Set(trioLabels).size, trioLabels.length, 'plain and matrix labels all unique');
});

test('missing output limits default to 131072 and clamp to the model context window', () => {
  const input = { providers: [{ id: 'load', name: 'Load', models: [
    { id: 'wide', contextWindow: 272000 }, { id: 'narrow', contextWindow: 32000 }, { id: 'explicit', contextWindow: 272000, maxOutputTokens: 32768 }] }] };
  const result = buildCatalog(input);
  const routeFor = id => Object.values(result.routes).find(route => route.model === id);
  assert.equal(routeFor('wide').maxOutputTokens, 131072);
  assert.equal(routeFor('narrow').maxOutputTokens, 32000);
  assert.equal(routeFor('explicit').maxOutputTokens, 32768);
  for (const id of ['wide', 'narrow', 'explicit']) {
    const model = result.models.find(item => item.uid === routeFor(id).uid);
    assert.equal(model.json.modelInfo.maxOutputTokens, routeFor(id).maxOutputTokens);
    assert.equal(num(model.raw, 18), model.json.maxTokens);
  }
  const omittedContext = buildCatalog({ providers: [{ id: 'load', name: 'Load', models: [{ id: 'default-context' }] }] });
  assert.equal(Object.values(omittedContext.routes)[0].maxOutputTokens, 131072);
});

test('explicit inference server override applies to own models and leaves native records byte-identical', () => {
  const input = config();
  input.inferenceServerUrl = 'http://127.0.0.1:39842';
  const overridden = buildCatalog(input, OBSERVED_SWE);
  for (const model of overridden.models) {
    assert.equal(model.json.modelInfo.inferenceServerUrl, input.inferenceServerUrl);
    assert.equal(str(getNested(model.raw, 23), 18), input.inferenceServerUrl);
  }
  // The default inference URL must be the local runtime address: it is the
  // routing target of every BYOK/combination entry, so falling back to the
  // hosted API would silently 404 every BYOK request.
  for (const model of catalog.models) assert.equal(model.json.modelInfo.inferenceServerUrl, require('../src/runtime/port.cjs').BACKEND_URL);
  assert.deepEqual(Object.keys(overridden.routes), Object.keys(catalog.routes));
  const fixture = statusFixture();
  const output = augmentCatalog(fixture.body, { rpc: lsStatus, format: proto, catalog: overridden });
  assert.deepEqual(configs(getNested(output, 1, 33)).at(-1), fixture.native);
  assert.throws(() => buildCatalog({ inferenceServerUrl: 'file:///tmp/unexpected' }), /Invalid inference/);
  assert.throws(() => buildCatalog({ inferenceServerUrl: 'https://user:password@example.invalid' }), /Invalid inference/);
});

test('GetCliModelConfigs preserves defaults, subagent model and unknown field 2 without inventing sorts', () => {
  const native = statusFixture().native;
  const input = cat(m(1, native), s(2, 'future-field-two'), m(3, native), s(4, 'swe-2-max'), v(99, 9));
  const output = augmentCatalog(input, { rpc: '/exa.api_server_pb.ApiServerService/GetCliModelConfigs', format: proto, catalog });
  assert.equal(configs(output).length, 19);
  assert.deepEqual(configs(output).at(-1), native);
  assert.deepEqual(configs(output).slice(0, catalog.models.length), catalog.models.map(model => model.raw));
  for (const number of [2, 3, 4, 99]) assert.deepEqual(fields(output, number)[0].raw, fields(input, number)[0].raw);
  assert.deepEqual(augmentCatalog(output, { rpc: 'GetCliModelConfigs', format: proto, catalog }), output);
  const empty = augmentCatalog(Buffer.alloc(0), { rpc: 'GetCliModelConfigs', format: proto, catalog });
  assert.equal(fields(empty, 2).length, 0);
});

test('refresh replaces own old catalog entries while preserving unrelated sort groups', () => {
  const old = cat(s(1, 'Old custom model'), s(22, 'dfbyok-deleted'));
  const input = cat(m(1, old), m(2, cat(s(1, 'Custom'),
    m(2, cat(s(1, 'Devin Fusion BYOK'), s(2, 'Old custom model'))),
    m(2, cat(s(1, 'Devin Fusion BYOK'), s(2, 'Unrelated official label'))))));
  const output = augmentCatalog(input, { rpc: 'GetCascadeModelConfigs', format: proto, catalog });
  assert.equal(configs(output).length, catalog.models.length);
  const groups = fields(getNested(output, 2), 2);
  assert.equal(groups.length, 2);
  assert.equal(str(groups[0].value, 1), 'Devin Fusion BYOK');
  assert.equal(str(groups[1].value, 2), 'Unrelated official label');
  assert.deepEqual(augmentCatalog(output, { rpc: 'GetCascadeModelConfigs', format: proto, catalog }), output);
});

for (const snake of [false, true]) test(`JSON ${snake ? 'snake' : 'camel'} status preserves official fields and input`, () => {
  const statusKey = snake ? 'user_status' : 'userStatus';
  const listKey = snake ? 'cascade_model_config_data' : 'cascadeModelConfigData';
  const modelsKey = snake ? 'client_model_configs' : 'clientModelConfigs';
  const sortsKey = snake ? 'client_model_sorts' : 'clientModelSorts';
  const native = { label: 'Official SWE', modelUid: 'swe-2-max', opaqueOfficialMetadata: { eligible: false } };
  const input = { responseExtra: 'unchanged', [statusKey]: { account: { quota: 17, signedIn: true },
    [listKey]: { [modelsKey]: [native], [sortsKey]: [{ name: 'Recommended', groups: [{ groupName: 'Official', modelLabels: ['Official SWE'] }], extra: 1 }], extra: 2 } } };
  const snapshot = structuredClone(input);
  const output = augmentCatalog(input, { rpc: lsStatus, format: json, catalog });
  assert.deepEqual(input, snapshot);
  assert.deepEqual(output[statusKey].account, input[statusKey].account);
  assert.equal(output.responseExtra, 'unchanged');
  const list = output[statusKey][listKey];
  assert.deepEqual(list[modelsKey].slice(0, catalog.models.length), catalog.models.map(model => model.json));
  assert.deepEqual(list[modelsKey].at(-1), native);
  assert.equal(list[modelsKey].length, 19);
  assert.equal(list[sortsKey][0].groups.length, 2);
  assert.equal(list[sortsKey][0].groups[0].groupName, 'Devin Fusion BYOK');
  assert.equal(list[sortsKey][0].extra, 1);
  assert.equal(list.extra, 2);
  assert.deepEqual(augmentCatalog(output, { rpc: lsStatus, format: json, catalog }), output);
});

test('JSON CLI only appends models and leaves official defaults and extras intact', () => {
  const input = { clientModelConfigs: [], defaultOverrideModelConfig: { modelUid: 'native-default' },
    subagentDefaultModelUid: 'swe-2-max', extra: { tokenLimit: 17 } };
  const output = augmentCatalog(input, { rpc: 'GetCliModelConfigs', format: json, catalog });
  assert.deepEqual(output.defaultOverrideModelConfig, input.defaultOverrideModelConfig);
  assert.equal(output.subagentDefaultModelUid, 'swe-2-max');
  assert.deepEqual(output.extra, input.extra);
  assert.ok(!Object.hasOwn(output, 'clientModelSorts'));
});

test('the team-settings allowlist reports why it left a payload alone', () => {
  // This path injects through an allowlist rewrite rather than a model list, so
  // it reports through the same channel the other shapes use: silence here made
  // an unreadable payload indistinguishable from one that needed nothing.
  const seat = '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings';
  const codes = [], report = code => codes.push(code);
  const json = cat(v(7, 9), s(99, 'unreadable allowlist'));
  const malformed = { allowedModelUids: [1] };
  assert.equal(augmentCatalog(malformed, { rpc: seat, format: { json: true }, catalog, onSkip: report }), malformed);
  assert.deepEqual(codes, ['shape-unrecognized'], 'non-string allowlist entries are a shape problem');
  const original = Buffer.from(json);
  assert.deepEqual(augmentCatalog(json, { rpc: seat, format: proto, catalog, onSkip: report }), original);
  assert.deepEqual(codes, ['shape-unrecognized', 'transform-failed'], 'an unparsable allowlist reports a failure');
  // An absent or empty allowlist is unrestricted, not a failure: there is
  // genuinely nothing to inject and nothing to warn about.
  for (const unrestricted of [{}, { allowedModelUids: [] }]) {
    assert.deepEqual(augmentCatalog(unrestricted, { rpc: seat, format: { json: true }, catalog, onSkip: report }), unrestricted);
  }
  assert.deepEqual(codes, ['shape-unrecognized', 'transform-failed'], 'unrestricted payloads report nothing');
});

test('unknown RPCs, empty catalogs, missing user status and malformed responses are unchanged', () => {
  const input = statusFixture().body;
  assert.equal(augmentCatalog(input, { rpc: 'GetAccount', format: proto, catalog }), input);
  assert.equal(augmentCatalog(input, { rpc: lsStatus, format: proto, catalog: buildCatalog() }), input);
  // A status payload with no locatable model list is left untouched *and*
  // reported: silence here is what let a shape mismatch look like "nothing to
  // do" while every in-place cache rewrite was a no-op.
  const codes = [];
  const barren = v(1, 1);
  assert.equal(augmentCatalog(barren, { rpc: lsStatus, format: proto, catalog, onSkip: code => codes.push(code) }), barren);
  assert.deepEqual(codes, ['shape-unrecognized']);
  for (const invalid of [Buffer.from([0x0a, 0xff]), cat(m(1, Buffer.alloc(0)), m(1, Buffer.alloc(0))), s(2, 'unrelated')]) {
    assert.equal(augmentCatalog(invalid, { rpc: lsStatus, format: proto, catalog }), invalid);
  }
  for (const invalid of [{}, { userStatus: null }, { userStatus: { cascadeModelConfigData: { clientModelConfigs: 'invalid' } } }]) {
    assert.equal(augmentCatalog(invalid, { rpc: lsStatus, format: json, catalog }), invalid);
  }
});

test('a valid user status without catalog gains only catalog data', () => {
  const output = augmentCatalog(m(1, v(42, 9)), { rpc: lsStatus, format: proto, catalog });
  assert.equal(num(getNested(output, 1), 42), 9);
  assert.equal(configs(getNested(output, 1, 33)).length, 18);
  assert.equal(fields(getNested(output, 1, 33), 2).length, 1);
});

test('installed webapp picker lists every custom Lead and both available Sidekicks', { skip: !webappAvailable }, () => {
  const pick = loadWebappPicker();
  const models = catalog.models.filter(model => model.kind === 'matrix');
  const uids = ['fusion-official', ...models.map(model => model.uid)];
  const result = pick(
    { name: 'Model', options: uids.map(uid => ({ value: uid, name: uid })) },
    { models: uids.map(uid => ({ modelUid: uid, disabled: false })),
      sorts: [{ name: 'Recommended', isDefault: true, groups: [{ name: 'Fusion', modelUids: uids }] }] },
    true);
  // The webapp picker renders catalog∩configOptions under catalog.sorts;
  // anything missing from either side is a miss, not a row.
  assert.equal(result.catalogMisses.length, 0, 'no mirrored uid is dropped as a catalog miss');
  const rendered = new Set(result.models.map(model => model.modelUid));
  for (const model of models) assert.ok(rendered.has(model.uid), model.uid + ' is offered in the installed picker');
  assert.ok(rendered.has('fusion-official'), 'the official Fusion row survives alongside our mirrors');
});

test('installed ACP picker requires own UIDs in session config_options as well as the user status catalog', { skip: !webappAvailable }, () => {
  const pick = loadWebappPicker();
  const models = catalog.models.map(model => ({ modelUid: model.uid, disabled: false }));
  const catalogOf = ms => ({ models: ms, sorts: [{ name: 's', isDefault: true, groups: [{ name: 'g', modelUids: ms.map(m => m.modelUid) }] }] });
  const option = values => ({ name: 'Model', options: values });
  // Catalog presence alone does not render a model — the configOption must
  // advertise the uid too (and vice versa, catalog misses are dropped).
  const officialOnly = pick(option([{ value: 'fusion-official', name: 'Official' }]),
    catalogOf([{ modelUid: 'fusion-official', disabled: false }, ...models]), true);
  assert.equal(officialOnly.models.length, 1);
  // The strict catalog path (non-empty rendered set) is where misses are
  // counted; an option uid absent from the catalog is reported, not rendered.
  const withoutCatalog = pick(option([{ value: 'fusion-official', name: 'Official' }, { value: 'dfbyok-ghost', name: 'x' }]),
    catalogOf([{ modelUid: 'fusion-official', disabled: false }]), true);
  assert.deepEqual(withoutCatalog.catalogMisses, ['dfbyok-ghost']);
  const updatedSession = option([{ value: 'fusion-official' },
    { group: 'BYOK', options: models.map(model => ({ value: model.modelUid, name: model.modelUid })) }]);
  const full = pick(updatedSession, catalogOf([{ modelUid: 'fusion-official', disabled: false }, ...models]), true);
  assert.equal(full.catalogMisses.length, 0);
  assert.equal(full.models.length, catalog.models.length + 1);
});

test('the installed picker selects every canonical native Sidekick on generated combinations', { skip: !webappAvailable }, () => {
  const picker = loadWebappPicker();
  const fixture = JSON.parse(fs.readFileSync(__dirname + '/fixtures/real-picker.json', 'utf8'));
  const protoFamily = family => m(30, cat(s(1, 'Fusion'), ...(family || []).map(dim =>
    m(2, cat(s(1, dim.key), m(2, cat(v(1, dim.order), s(2, dim.name), v(3, dim.controlType ?? 0))))))));
  const entry = record => cat(s(1, record.label), s(22, record.uid), v(4, record.disabled ? 1 : 0),
    m(23, cat(...(record.harnesses || []).map(harness => s(20, harness)), v(25, record.router ? 1 : 0))), protoFamily(record.family),
    ...(record.uid.startsWith('fusion-') ? [m(32, v(1, 1))] : []));
  const records = collectNativeModels(cat(...[...fixture.natives, ...fixture.fusions].map(record => m(1, entry(record)))),
    { rpc: 'GetCliModelConfigs', format: proto });
  const result = buildCatalog(config(), records);
  const pickerModel = model => ({ modelUid: model.uid, label: model.label, disabled: false, familyUid: model.json.modelInfo.modelFamilyUid,
    familyMetadata: Object.fromEntries(model.json.modelFamilyMetadata.entries.map(item => [item.key, { order: item.value.order, name: item.value.name }])) });
  const officialModel = record => ({ modelUid: record.uid, label: record.label, disabled: !!record.disabled, familyUid: 'fusion',
    familyMetadata: Object.fromEntries((record.family || []).map(dim => [dim.key, { order: dim.order, name: dim.name }])) });
  const models = [...fixture.fusions.map(officialModel), ...result.models.filter(model => model.kind === 'matrix').map(pickerModel)];
  const uids = models.map(model => model.modelUid);
  const out = picker({ name: 'Model', options: uids.map(uid => ({ value: uid, name: uid })) },
    { models, sorts: [{ name: 's', isDefault: true, groups: [{ name: 'Fusion', modelUids: uids }] }] }, true);
  assert.equal(out.catalogMisses.length, 0, 'our combinations live inside the installed picker catalog');
  const rendered = new Set(out.models.map(model => model.modelUid));
  for (const uid of ['swe-2-medium', 'swe-2-high', 'gpt-5-6-luna-high', 'gpt-5-6-sol-high', 'glm-5-2']) {
    const variant = models.find(model => result.fusions[model.modelUid]?.sidekickUid === uid);
    assert.ok(variant && rendered.has(variant.modelUid), uid + ' resolves to a selectable mirrored combination');
    assert.ok(variant && !variant.disabled, uid + ' resolves to a selectable mirrored combination');
    assert.equal(resolveAssignment({ fusionLeadRouterUid: variant.modelUid }, json, result).assignment.modelUid, uid);
  }
});

test('matrix entries never leak into the panel model groups in either wire format', () => {
  const probe = buildCatalog(config(), OBSERVED_SWE);
  const matrixLabels = new Set(probe.models.filter(model => model.kind === 'matrix').map(model => model.label));
  assert.ok(matrixLabels.size > 0);
  const input = cat(m(2, cat(s(1, 'Official'), m(2, cat(s(1, 'Official'), s(2, 'Official SWE'))))));
  const output = augmentCatalog(input, { rpc: 'GetCascadeModelConfigs', format: proto, catalog: probe });
  for (const group of fields(getNested(output, 2), 2)) {
    for (const item of fields(group.value, 2)) {
      assert.ok(!matrixLabels.has(item.value.toString('utf8')), 'matrix labels stay out of proto sort groups');
    }
  }
  const jsonInput = { clientModelConfigs: [{ label: 'Official SWE', modelUid: 'swe-2-max' }],
    clientModelSorts: [{ name: 'Recommended', groups: [{ groupName: 'Official', modelLabels: ['Official SWE'] }] }] };
  const jsonOutput = augmentCatalog(jsonInput, { rpc: 'GetCascadeModelConfigs', format: json, catalog: probe });
  const groupLabels = jsonOutput.clientModelSorts.flatMap(sort => sort.groups.flatMap(group => group.modelLabels));
  for (const label of groupLabels) assert.ok(!matrixLabels.has(label), 'matrix labels stay out of JSON sort groups');
  const own = jsonOutput.clientModelSorts[0].groups.find(group => group.groupName === 'Devin Fusion BYOK');
  assert.ok(own && own.modelLabels.length, 'own plain models still land in the panel group');
});

test('informational dimensions omit order so the picker merges them with the official values', () => {
  const matrix = catalog.models.filter(model => model.kind === 'matrix');
  assert.ok(matrix.length);
  for (const model of matrix) {
    const dims = Object.fromEntries(model.json.modelFamilyMetadata.entries.map(entry => [entry.key, entry.value]));
    // The picker dedupes dimension values by `order` and drops every dimension
    // left with fewer than two values, so an explicit order here would put our
    // entries in their own bucket: Fast Mode grew a third option and the
    // informational Recommended Sidekick turned into a real control.
    assert.equal(Object.hasOwn(dims['Recommended Sidekick'], 'order'), false, model.uid);
    if (model.label.endsWith(' · Fast')) {
      // Fast twins carry the official on-shape; the orderless base entries keep
      // the toggle at exactly two unnamed values.
      assert.deepEqual(dims['Fast Mode'], { order: 1, controlType: 2 }, model.uid);
    } else {
      assert.equal(Object.hasOwn(dims['Fast Mode'], 'order'), false, model.uid);
      assert.deepEqual(dims['Fast Mode'], { controlType: 2 });
    }
    assert.deepEqual(dims['Recommended Sidekick'], { name: dims.Sidekick.name });
    // Selectable dimensions keep a real order; that is what makes them work.
    for (const key of ['Lead', 'Sidekick']) assert.equal(Number.isSafeInteger(dims[key].order), true, key + ' on ' + model.uid);
    if (dims.Effort) assert.equal(Number.isSafeInteger(dims.Effort.order), true, 'Effort on ' + model.uid);
  }
});

const fastFixture = () => {
  const input = config();
  input.providers[0].models.push({ id: 'grok-fast', label: 'Grok Fast', efforts: ['medium', 'high'], contextWindow: 500000, maxOutputTokens: 32768 });
  input.providers[0].models[0].fastModel = 'grok-fast';
  return input;
};
const dimsOf = model => Object.fromEntries(model.json.modelFamilyMetadata.entries.map(entry => [entry.key, entry.value]));

test('a configured fastModel emits one Fast Mode twin per base combination', () => {
  const built = buildCatalog(fastFixture(), OBSERVED_SWE);
  const matrix = built.models.filter(model => model.kind === 'matrix');
  const base = matrix.filter(model => !model.label.endsWith(' · Fast'));
  const twins = matrix.filter(model => model.label.endsWith(' · Fast'));
  assert.ok(base.length && twins.length, 'both shapes exist');
  const baseGrokLeads = base.filter(model => built.fusions[model.uid] && !built.fusions[model.uid].leadNative &&
    built.routes[built.fusions[model.uid].leadUid]?.model === 'grok-4.6');
  assert.ok(baseGrokLeads.length, 'grok base combos emit');
  for (const entry of baseGrokLeads) {
    const fusion = built.fusions[entry.uid];
    const twin = twins.find(candidate => built.fusions[candidate.uid]?.sidekickUid === fusion.sidekickUid &&
      candidate.json.modelFamilyMetadata.entries.find(dim => dim.key === 'Effort')?.value?.name ===
        entry.json.modelFamilyMetadata.entries.find(dim => dim.key === 'Effort')?.value?.name);
    assert.ok(twin, 'every base combo has a twin: ' + entry.uid);
    const baseDims = dimsOf(entry), twinDims = dimsOf(twin);
    for (const key of ['Lead', 'Sidekick']) assert.deepEqual(twinDims[key], baseDims[key], key + ' identical on ' + twin.uid);
    if (baseDims.Effort) assert.deepEqual(twinDims.Effort, baseDims.Effort, 'Effort identical');
    assert.deepEqual(twinDims['Fast Mode'], { order: 1, controlType: 2 }, 'the twin carries the on-shape');
    assert.deepEqual(baseDims['Fast Mode'], { controlType: 2 }, 'the base keeps the orderless shape');
    assert.ok(twin.label.endsWith(' · Fast'), 'twin label suffix');
    const twinFusion = built.fusions[twin.uid];
    assert.equal(twinFusion.leadNative, false);
    assert.notEqual(twinFusion.leadUid, fusion.leadUid, 'the twin leads on the fast route');
    assert.ok(twinFusion.leadUid.includes('grok-fast'), 'the twin lead uid is the fast variant route');
    assert.equal(twinFusion.sidekickUid, fusion.sidekickUid, 'same sidekick');
    assert.equal(twin.json.modelInfo.harnessUids.join(','), 'fusion', 'the twin uses the bare fusion router');
  }
  // resolveAssignment parses the twin straight back to the fast route.
  const fastTwin = twins.find(model => model.uid.includes('grok-fast'));
  const baseCombo = baseGrokLeads.find(model => built.fusions[model.uid]?.sidekickUid === built.fusions[fastTwin.uid]?.sidekickUid &&
    model.json.modelFamilyMetadata.entries.find(dim => dim.key === 'Effort')?.value?.name ===
      fastTwin.json.modelFamilyMetadata.entries.find(dim => dim.key === 'Effort')?.value?.name);
  assert.ok(fastTwin.label.startsWith('Fusion (CPA · Grok Fast '), 'the twin label leads with the variant own name: ' + fastTwin.label);
  assert.ok(fastTwin.label.endsWith(' · Fast'), 'the Fast suffix stays');
  assert.ok(baseCombo.label.startsWith('Fusion (CPA · Grok 4.6 '), 'the base combo keeps the base lead name');
  assert.notEqual(fastTwin.label.replace(/ · Fast$/, ''), baseCombo.label, 'the twin and base lead segments differ');
  const twinFusionUid = fastTwin.uid;
  const fusion = built.fusions[twinFusionUid];
  assert.ok(built.routes[fusion.leadUid], 'the fast route exists in the plain route table');
  const { resolveAssignment: resolve } = require('../src/catalog.cjs');
  const resolved = resolve({}, { json: true }, built);
  assert.equal(resolved, null, 'empty assignment resolves nothing');
  const assigned = resolve({ modelRouterUid: twinFusionUid }, { json: true }, built);
  assert.equal(assigned.assignment.modelUid, fusion.leadUid, 'the twin assignment resolves to the fast route uid');
  // The fast target never appears as a role or emits its own combos.
  assert.ok(!built.rolePool.lead.some(item => item.ref.model === 'grok-fast'), 'fast target absent from lead pool');
  assert.ok(built.rolePool.sidekick.some(item => item.ref.model === 'grok-fast'), 'fast target present in the sidekick pool: it is a legal Sidekick value');
  const selfLed = base.filter(model => built.routes[built.fusions[model.uid]?.leadUid]?.model === 'grok-fast');
  assert.equal(selfLed.length, 0, 'no base combo is led by the fast route');
  assert.ok(built.models.some(model => model.uid.includes('grok-fast') && model.kind !== 'matrix'), 'the plain model row stays');
  assert.ok(Object.keys(built.routes).some(uid => uid.includes('grok-fast')), 'its routes stay');
});

test('a fast variant labeled exactly like its base stays visibly distinct on every surface', () => {
  const input = {
    providers: [{ id: 'p', name: 'P', baseUrl: 'https://private.invalid/v1', apiKey: 'secret-test-value', apiFormat: 'openai', models: [
      { id: 'alpha', label: 'Same', efforts: ['medium'], contextWindow: 100000, maxOutputTokens: 1000, fastModel: 'beta' },
      { id: 'beta', label: 'Same', efforts: ['medium'], contextWindow: 100000, maxOutputTokens: 1000 },
      { id: 'gamma', label: 'Same · Fast', efforts: ['medium'], contextWindow: 100000, maxOutputTokens: 1000 },
    ] }],
  };
  const built = buildCatalog(input, OBSERVED_SWE);
  const rows = built.models.filter(model => model.kind !== 'matrix');
  const labels = rows.map(model => model.label);
  assert.equal(new Set(labels).size, labels.length, 'ordinary model row labels unique: ' + labels.join(' | '));
  // A third model literally carrying the generated ` · Fast` name forces the
  // deterministic model-id disambiguator onto the variant.
  const betaRows = rows.filter(model => model.label.includes('(beta)'));
  assert.ok(betaRows.length, 'the colliding variant row carries the model-id disambiguator');
  assert.ok(betaRows.every(model => model.label.startsWith('P · Same · Fast (beta)')), 'variant rows read as the disambiguated fast variant: ' + betaRows[0]?.label);
  assert.ok(rows.some(model => model.label.startsWith('P · Same · Fast Medium') && !model.label.includes('(beta)')),
    'the third model keeps its own literal family label');
  // The Sidekick dimension values of one dropdown must differ in BOTH name and order.
  const sideValues = new Map();
  for (const model of built.models.filter(model => model.kind === 'matrix')) {
    for (const entry of model.json.modelFamilyMetadata.entries) {
      if (entry.key !== 'Sidekick') continue;
      if (!entry.value.name.startsWith('P · Same')) continue;
      sideValues.set(entry.value.name, entry.value.order);
    }
  }
  const names = [...sideValues.keys()];
  assert.ok(names.some(name => name.startsWith('P · Same · Fast (beta)')), 'variant sidekick value carries the disambiguator: ' + names.join(' | '));
  assert.ok(names.some(name => name.startsWith('P · Same · Fast') && !name.includes('(beta)')), 'third-model sidekick value keeps its literal name');
  assert.ok(names.some(name => !name.includes('Fast') && name.startsWith('P · Same')), 'base sidekick value keeps the plain name');
  assert.equal(new Set(sideValues.values()).size, sideValues.size, 'sidekick orders distinct');
  // Twins are located by route/fusion data, not the label: the disambiguated
  // variant label already carries the ` · Fast` marker, so the twin label does
  // not gain a second outer one.
  const fusionLeadModel = model => built.routes[built.fusions[model.uid].leadUid]?.model;
  const twins = built.models.filter(model => model.kind === 'matrix' && fusionLeadModel(model) === 'beta');
  assert.ok(twins.length, 'a fast twin exists for the colliding pair');
  assert.ok(twins.every(model => !/ · Fast$/.test(model.label)), 'no double outer Fast suffix on the twin label: ' + twins[0].label);
  assert.ok(twins.every(model => model.json.modelFamilyMetadata.entries.some(dim => dim.key === 'Fast Mode' && dim.value.order === 1)),
    'the Fast Mode metadata still carries the toggle');
  // All routes stay addressable: base combos resolve to alpha, twins to beta.
  const routesByModel = model => Object.values(built.routes).filter(route => route.model === model).map(route => route.uid);
  for (const id of ['alpha', 'beta', 'gamma']) assert.ok(routesByModel(id).length, `routes exist for ${id}`);
  const { resolveAssignment: resolve } = require('../src/catalog.cjs');
  const assigned = resolve({ modelRouterUid: twins[0].uid }, { json: true }, built);
  assert.equal(built.routes[assigned.assignment.modelUid].model, 'beta', 'the twin resolves to the variant route');
  const baseCombo = built.models.find(model => model.kind === 'matrix' && fusionLeadModel(model) === 'alpha');
  assert.ok(baseCombo, 'the base combo exists');
  const baseAssigned = resolve({ modelRouterUid: baseCombo.uid }, { json: true }, built);
  assert.equal(built.routes[baseAssigned.assignment.modelUid].model, 'alpha', 'the base combo resolves to the base route');
});

test('a naturally fast-named distinct variant keeps the outer twin suffix', () => {
  const input = {
    providers: [{ id: 'p', name: 'P', baseUrl: 'https://private.invalid/v1', apiKey: 'secret-test-value', apiFormat: 'openai', models: [
      { id: 'alpha', label: 'Base', efforts: ['medium'], contextWindow: 100000, maxOutputTokens: 1000, fastModel: 'beta' },
      { id: 'beta', label: 'Custom · Fast', efforts: ['medium'], contextWindow: 100000, maxOutputTokens: 1000 },
    ] }],
  };
  const built = buildCatalog(input, OBSERVED_SWE);
  // `Custom · Fast` is the user's own distinct name — no collision resolution
  // generated the marker — so the twin still carries the outer suffix even
  // though the variant label happens to contain ` · Fast`.
  const twins = built.models.filter(model => model.kind === 'matrix' &&
    built.routes[built.fusions[model.uid].leadUid]?.model === 'beta');
  assert.ok(twins.length, 'twins exist for the pair');
  assert.ok(twins.every(model => model.label.endsWith(' · Fast')), 'the twin keeps the outer suffix: ' + twins[0].label);
  assert.ok(twins.every(model => model.json.modelFamilyMetadata.entries.some(dim => dim.key === 'Fast Mode' && dim.value.order === 1)),
    'the Fast Mode metadata is on');
});

test('a stale fast twin stops resolving once its base leaves the lead candidates', () => {
  const { resolveAssignment: resolve } = require('../src/catalog.cjs');
  const active = buildCatalog(fastFixture(), OBSERVED_SWE);
  const twin = active.models.find(model => model.kind === 'matrix' && model.label.endsWith(' · Fast'));
  assert.ok(twin, 'active pairing emits a twin');
  const activeAssigned = resolve({ modelRouterUid: twin.uid }, { json: true }, active);
  assert.equal(activeAssigned.assignment.modelUid, active.fusions[twin.uid].leadUid, 'active twin resolves to the fast route');
  assert.equal(active.fastTargetLeadActive.get(active.fusions[twin.uid].leadUid), true, 'active fast route marked true');

  // Disable the base: base and twin leave the emitted matrix, but the variant
  // route legitimately stays (a disabled variant keeps its routes).
  const disabled = fastFixture();
  disabled.providers[0].models[0].enabled = false;
  const stale = buildCatalog(disabled, OBSERVED_SWE);
  assert.ok(!stale.models.some(model => model.kind === 'matrix' && builtLeadModel(stale, model) === 'grok-4.6'), 'no base-led combos');
  assert.ok(!stale.models.some(model => model.kind === 'matrix' && model.label.endsWith(' · Fast')), 'no twins emitted');
  function builtLeadModel(built, model) { return built.routes[built.fusions[model.uid]?.leadUid]?.model; }
  const fastRouteUids = Object.values(stale.routes).filter(route => route.model === 'grok-fast').map(route => route.uid);
  assert.ok(fastRouteUids.length, 'the fast route itself still exists');
  for (const uid of fastRouteUids) assert.equal(stale.fastTargetLeadActive.get(uid), false, 'fast route marked inactive: ' + uid);
  // The uid-split fallback rebuilds a fusion shape for the remembered twin uid,
  // but resolution must refuse it: nothing emits this pairing anymore.
  assert.equal(resolve({ modelRouterUid: twin.uid }, { json: true }, stale), null, 'stale twin rejected');
  // The ordinary uid-split fallback is unchanged: an unemitted native pairing
  // with no fast involvement still resolves.
  const fallback = resolve({ modelRouterUid: 'fusion-swe-2-max-sidekick-swe-odd' }, { json: true }, active);
  assert.ok(fallback, 'ordinary uid-split fallback still resolves');
  assert.equal(fallback.assignment.modelUid, 'swe-2-max');
});

test('a fast variant selected as sidekick emits combos under its own label and order', () => {
  const input = fastFixture();
  input.sidekicks = [{ providerId: 'cpa', model: 'grok-fast' }];
  const built = buildCatalog(input, OBSERVED_SWE);
  const sideNames = new Map();
  for (const model of built.models.filter(model => model.kind === 'matrix')) {
    const dim = model.json.modelFamilyMetadata.entries.find(entry => entry.key === 'Sidekick');
    if (dim && /Grok/.test(dim.value?.name || '')) sideNames.set(dim.value.name, dim.value.order);
  }
  assert.ok(sideNames.has('CPA · Grok Fast Medium') && sideNames.has('CPA · Grok Fast High'),
    'the variant emits sidekick values under its own label');
  assert.ok(sideNames.has('CPA · Grok 4.6 Medium'), 'the base values of the merged family emit alongside');
  assert.notEqual(sideNames.get('CPA · Grok Fast Medium'), sideNames.get('CPA · Grok 4.6 Medium'),
    'same-tier base and variant values never share an order: the picker would drop one silently');
  assert.equal(new Set(sideNames.values()).size, sideNames.size, 'every sidekick order is unique');
  const fastSideCombos = built.models.filter(model => model.kind === 'matrix' &&
    model.json.modelFamilyMetadata.entries.some(entry => entry.key === 'Sidekick' && /Grok Fast/.test(entry.value?.name || '')));
  assert.ok(fastSideCombos.length > 0, 'combos led by other models pair with the fast variant sidekick');
  const fusion = built.fusions[fastSideCombos[0].uid];
  assert.ok(built.routes[fusion.sidekickUid]?.model === 'grok-fast', 'the combination routes the sidekick to the variant');
  const selfLed = fastSideCombos.filter(model => built.routes[built.fusions[model.uid]?.leadUid]?.model === 'grok-4.6');
  assert.equal(selfLed.length, 0, 'a merged family never pairs with itself: base lead x fast sidekick stays empty');
});

test('hand-edited chains and duplicate claims collapse to legal pairings', () => {
  const chainInput = config();
  chainInput.providers[0].models = [
    { id: 'a', label: 'A', fastModel: 'b', efforts: ['high'], enabled: true, contextWindow: 100000, maxOutputTokens: 8192 },
    { id: 'b', label: 'B', fastModel: 'c', efforts: ['high'], enabled: true, contextWindow: 100000, maxOutputTokens: 8192 },
    { id: 'c', label: 'C', efforts: ['high'], enabled: true, contextWindow: 100000, maxOutputTokens: 8192 }];
  const chained = buildCatalog(chainInput, OBSERVED_SWE);
  // The void A→B claim frees B to lead normally (its plain base combos are
  // expected); what must not exist is any TWIN led on B's routes.
  const bLedTwins = Object.values(chained.fusions).filter(fusion => chained.routes[fusion.leadUid]?.model === 'b' && fusion.label.endsWith(' · Fast'));
  assert.equal(bLedTwins.length, 0, 'a chain link whose target itself declares a variant emits no twins');
  const bLedBase = Object.values(chained.fusions).filter(fusion => chained.routes[fusion.leadUid]?.model === 'b' && !fusion.label.endsWith(' · Fast'));
  assert.ok(bLedBase.length > 0, 'freed of the void claim, B leads ordinary combos of its own');
  const cTwins = Object.values(chained.fusions).filter(fusion => chained.routes[fusion.leadUid]?.model === 'c' && fusion.label.endsWith(' · Fast'));
  assert.ok(cTwins.length > 0, 'the final link of the chain still twins');
  const rows = chained.models.filter(model => model.kind === 'model');
  const famOf = id => rows.find(row => row.uid.includes('-' + id.slice(0, 8)) || row.label.includes(' ' + id + ' '));
  const aRow = rows.find(row => row.label.startsWith('CPA · A ')), bRow = rows.find(row => row.label.startsWith('CPA · B '));
  assert.notEqual(aRow.json.modelInfo.modelFamilyUid, bRow?.json.modelInfo.modelFamilyUid, 'b never merges into a family of a');

  const dupInput = config();
  dupInput.providers[0].models = [
    { id: 'a', label: 'A', fastModel: 'x', efforts: ['high'], enabled: true, contextWindow: 100000, maxOutputTokens: 8192 },
    { id: 'b', label: 'B', fastModel: 'x', efforts: ['high'], enabled: true, contextWindow: 100000, maxOutputTokens: 8192 },
    { id: 'x', label: 'X', efforts: ['high'], enabled: true, contextWindow: 100000, maxOutputTokens: 8192 }];
  const duped = buildCatalog(dupInput, OBSERVED_SWE);
  const xTwins = Object.values(duped.fusions).filter(fusion => duped.routes[fusion.leadUid]?.model === 'x');
  assert.ok(xTwins.length > 0, 'the first claimant twins');
  const xLedTwins = new Set(xTwins.map(fusion => fusion.leadUid));
  assert.equal(xLedTwins.size, 1, 'one claimant only: the twin lead segment is a single variant route');
  const allXLed = Object.values(duped.fusions).filter(fusion => {
    const leadRoute = duped.routes[fusion.leadUid];
    return leadRoute?.model === 'x' && fusion.uid.includes('dfbyok');
  });
  assert.ok(allXLed.every(fusion => xLedTwins.has(fusion.leadUid)), 'no second claimant emits competing twins');
  const mixed = config();
  mixed.providers[0].models = [
    { id: 'a', label: 'A', fastModel: 'b', efforts: ['high'], enabled: true, contextWindow: 100000, maxOutputTokens: 8192 },
    { id: 'b', label: 'B', fastModel: 'c', efforts: ['high'], enabled: true, contextWindow: 100000, maxOutputTokens: 8192 },
    { id: 'd', label: 'D', fastModel: 'c', efforts: ['high'], enabled: true, contextWindow: 100000, maxOutputTokens: 8192 },
    { id: 'c', label: 'C', efforts: ['high'], enabled: true, contextWindow: 100000, maxOutputTokens: 8192 }];
  buildCatalog(mixed, OBSERVED_SWE);
});

test('an excluded fast variant leaves the sidekicks list while its base stays', () => {
  const input = fastFixture();
  input.roleExclusions = { sidekick: [{ providerId: 'cpa', model: 'grok-fast' }] };
  const built = buildCatalog(input, OBSERVED_SWE);
  const grokRows = built.sidekicks.filter(sidekick => !sidekick.native && /Grok/.test(sidekick.label)).map(sidekick => sidekick.label);
  assert.ok(grokRows.length > 0, 'the base members of the family stay listed');
  assert.ok(grokRows.every(label => !label.includes('Grok Fast')), 'the excluded variant leaves no sidekick rows: ' + grokRows.join(','));
  assert.ok(!built.sidekicks.some(sidekick => sidekick.model === 'grok-fast'), 'no variant row at all');
});

test('fast twins vanish with the variant, the provider or a missing effort', () => {
  const disabledModel = fastFixture();
  disabledModel.providers[0].models.find(model => model.id === 'grok-fast').enabled = false;
  const disabledCatalog = buildCatalog(disabledModel, OBSERVED_SWE);
  assert.ok(disabledCatalog.models.some(model => model.label.endsWith(' · Fast')),
    'a disabled fast variant still emits twins: the Fast toggle must not silently vanish');
  const variantRoute = Object.values(disabledCatalog.routes).find(route => route.model === 'grok-fast');
  assert.ok(variantRoute, 'the disabled variant keeps its routes');
  assert.ok(!disabledCatalog.models.some(model => model.kind === 'model' && model.uid.includes('grok-fast') && !model.label.endsWith(' · Fast')),
    'but the disabled variant emits no model row of its own');
  const disabledProvider = fastFixture();
  disabledProvider.providers[0].enabled = false;
  assert.equal(buildCatalog(disabledProvider, OBSERVED_SWE).models.filter(model => model.label.endsWith(' · Fast')).length, 0,
    'a disabled provider emits no twin');
  // Exact effort matching: the variant lacks the base tier, so nothing twins.
  const tierless = fastFixture();
  tierless.providers[0].models.find(model => model.id === 'grok-fast').efforts = ['low'];
  assert.equal(buildCatalog(tierless, OBSERVED_SWE).models.filter(model => model.label.endsWith(' · Fast')).length, 0,
    'a fast variant without the matching effort emits no twin');
});

test('a tier-matched fast variant merges into the base family with the Fast Mode pair', () => {
  const built = buildCatalog(fastFixture(), OBSERVED_SWE);
  const rows = built.models.filter(model => model.kind === 'model' && model.uid.includes('grok'));
  assert.ok(rows.length >= 4, 'base and variant rows both emit');
  const base = rows.filter(model => model.uid.includes('grok-4')), variant = rows.filter(model => model.uid.includes('grok-fast'));
  assert.ok(base.length && variant.length, 'both sides present');
  for (const a of base) for (const b of variant.filter(v => dimsOf(v).Effort?.name === dimsOf(a).Effort?.name)) {
    assert.equal(a.json.modelInfo.modelFamilyUid, b.json.modelInfo.modelFamilyUid, 'same family uid');
    assert.equal(a.json.modelFamilyMetadata.modelFamilyLabel, b.json.modelFamilyMetadata.modelFamilyLabel, 'same family label');
    assert.notEqual(a.json.label, b.json.label, 'member labels stay distinct: the picker expands lists through a label-to-uid map');
  }
  for (const model of variant) {
    assert.ok(model.label.startsWith('CPA · Grok Fast'), 'the variant keeps its own label: ' + model.label);
    assert.equal(model.hiddenFromSorts, true, 'the variant is routable but out of the list groups');
  }
  for (const model of base) assert.equal(model.hiddenFromSorts, undefined, 'the base stays listed');
  for (const model of base) assert.deepEqual(dimsOf(model)['Fast Mode'], { controlType: 2 }, 'base stays orderless');
  for (const model of variant) assert.deepEqual(dimsOf(model)['Fast Mode'], { order: 1, controlType: 2 }, 'variant carries the on-shape');
  for (const model of [...base, ...variant]) assert.ok(built.routes[model.uid], 'every member keeps its route');
  assert.equal(built.routes[base[0].uid].model, 'grok-4.6');
  assert.equal(built.routes[variant[0].uid].model, 'grok-fast');
});

test('a tier-mismatched or base-disabled pair does not merge families', () => {
  const mismatched = fastFixture();
  mismatched.providers[0].models.find(model => model.id === 'grok-fast').efforts = ['low'];
  const built = buildCatalog(mismatched, OBSERVED_SWE);
  const rows = built.models.filter(model => model.kind === 'model' && model.uid.includes('grok'));
  const familyUids = new Set(rows.map(model => model.json.modelInfo.modelFamilyUid));
  assert.ok(familyUids.size > 1, 'mismatched tiers stay in separate families');
  for (const model of rows) assert.equal(dimsOf(model)['Fast Mode'], undefined, 'no Fast Mode without the merge');
  const disabledBase = fastFixture();
  disabledBase.providers[0].models[0].enabled = false;
  const builtDisabled = buildCatalog(disabledBase, OBSERVED_SWE);
  assert.ok(Object.values(builtDisabled.routes).some(route => route.model === 'grok-fast'), 'the variant keeps its routes');
  const orphanRows = builtDisabled.models.filter(model => model.kind === 'model' && model.uid.includes('grok-fast'));
  assert.ok(orphanRows.length > 0, 'the still-enabled variant emits rows as an ordinary model');
  for (const model of orphanRows) assert.equal(dimsOf(model)['Fast Mode'], undefined, 'but nothing merges while the base is disabled');
});

test('emitted model labels are globally unique and sorts groups exclude fast variants', () => {
  const built = buildCatalog(fastFixture(), OBSERVED_SWE);
  const rows = built.models.filter(model => model.kind === 'model');
  const labels = rows.map(model => model.label);
  assert.equal(new Set(labels).size, labels.length, 'a duplicate label would resolve the whole list row to the latter uid');
  const augmented = augmentCatalog({ clientModelConfigs: [], clientModelSorts: [] }, { rpc: 'GetCascadeModelConfigs', format: json, catalog: built });
  const groups = (augmented.clientModelSorts || []).flatMap(sort => sort.groups || []);
  const sortLabels = groups.flatMap(group => group.modelLabels || group.model_labels || []);
  const variantLabels = new Set(rows.filter(model => model.hiddenFromSorts).map(model => model.label));
  assert.ok(variantLabels.size > 0, 'the fixture has hidden variants');
  assert.ok(sortLabels.length > 0, 'the own group emits labels');
  for (const label of variantLabels) assert.ok(!sortLabels.includes(label), 'variant label stays out of the list groups: ' + label);
  assert.equal(new Set(sortLabels).size, sortLabels.length, 'no label appears twice in the groups');
  for (const model of rows.filter(model => !model.hiddenFromSorts)) assert.ok(sortLabels.includes(model.label), 'listed rows are in the groups');
  // f1 keeps every emitted entry, variants included: they must stay routable.
  const configUids = new Set((augmented.clientModelConfigs || []).map(entry => entry.modelUid || entry.model_uid));
  for (const model of rows) assert.ok(configUids.has(model.uid), 'every row survives in clientModelConfigs: ' + model.uid);
});

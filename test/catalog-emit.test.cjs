'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { buildCatalog, augmentCatalog, resolveAssignment, collectNativeModels } = require('../src/catalog.cjs');
const { fields, str, num, s, v, m } = require('../src/protocol/wire.cjs');
const { cat, proto, json, lsStatus, config, OBSERVED_SWE, catalog, getNested, configs, statusFixture } = require('./helpers/catalog-fixtures.cjs');
const { rendererFile, loadFamilyPicker, loadAcpPicker } = require('./helpers/installed-renderer.cjs');

test('stable model identities and independent Lead/Sidekick orders survive reordering and label changes', () => {
  const reordered = config();
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

test('installed native Fusion grouping includes every custom Lead and both available Sidekicks', { skip: !fs.existsSync(rendererFile) }, () => {
  const renderer = loadFamilyPicker();
  const models = catalog.models.filter(model => model.kind === 'matrix').map(model => ({
    modelUid: model.uid, label: model.label, disabled: false, familyUid: model.json.modelInfo.modelFamilyUid,
    familyMetadata: Object.fromEntries(model.json.modelFamilyMetadata.entries.map(entry => [entry.key, entry.value])),
  }));
  const official = { modelUid: 'fusion-official', label: 'Official', disabled: false, familyUid: 'fusion', familyMetadata: {
    Lead: { order: 1, name: 'Official Lead' }, Effort: { order: 2, name: 'Medium' },
    Sidekick: { order: 1, name: 'SWE-2 Medium' }, 'Fast Mode': { order: 0, name: '' },
    'Recommended Sidekick': { order: 0, name: 'SWE-2 Medium' },
  } };
  const rows = renderer.rows([official, ...models]);
  // Everything we mirror declares familyUid 'fusion', so the picker folds the
  // whole cross product into the single official Fusion row instead of adding
  // rows of its own — that is what makes our models selectable in the native
  // card rather than a parallel catalog the user has to find.
  assert.equal(rows.length, 1);
  const family = rows[0].family;
  assert.equal(family.familyUid, 'fusion');
  assert.equal(family.models.length, models.length + 1, 'every mirrored variant joins the family');
  const values = Object.fromEntries(family.dimensions.map(dim => [dim.name, dim.values.map(value => value.name)]));
  for (const model of models) {
    const meta = model.familyMetadata;
    assert.ok(values.Lead.includes(meta.Lead.name), model.modelUid + ' is offered as a Lead value');
    assert.ok(values.Sidekick.includes(meta.Sidekick.name), model.modelUid + ' is offered as a Sidekick value');
    if (meta.Effort) assert.ok(values.Effort.includes(meta.Effort.name), model.modelUid + ' is offered as an Effort value');
  }
});

test('installed ACP picker requires own UIDs in session config_options as well as the user status catalog', { skip: !fs.existsSync(rendererFile) }, () => {
  const acp = loadAcpPicker();
  const models = catalog.models.map(model => ({ modelUid: model.uid, disabled: false }));
  const oldSession = { options: [{ value: 'fusion-official', name: 'Official' }] };
  assert.equal(acp.filter(oldSession, models).length, 0);
  const updatedSession = { options: [{ group: 'BYOK', options: models.map(model => ({ value: model.modelUid, name: model.modelUid })) }] };
  assert.equal(acp.filter(updatedSession, models).length, catalog.models.length);
});

test('the installed picker selects every canonical native Sidekick on generated combinations', { skip: !fs.existsSync(rendererFile) }, () => {
  const picker = loadFamilyPicker();
  const fixture = JSON.parse(fs.readFileSync(__dirname + '/fixtures/real-picker.json', 'utf8'));
  const protoFamily = family => m(30, cat(s(1, 'Fusion'), ...(family || []).map(dim =>
    m(2, cat(s(1, dim.key), m(2, cat(v(1, dim.order), s(2, dim.name), v(3, dim.controlType ?? 0))))))));
  const entry = record => cat(s(1, record.label), s(22, record.uid), v(4, record.disabled ? 1 : 0),
    m(23, cat(...(record.harnesses || []).map(harness => s(20, harness)), v(25, record.router ? 1 : 0))), protoFamily(record.family));
  const records = collectNativeModels(cat(...[...fixture.natives, ...fixture.fusions].map(record => m(1, entry(record)))),
    { rpc: 'GetCliModelConfigs', format: proto });
  const result = buildCatalog(config(), records);
  const pickerModel = model => ({ modelUid: model.uid, label: model.label, disabled: false, familyUid: model.json.modelInfo.modelFamilyUid,
    familyMetadata: Object.fromEntries(model.json.modelFamilyMetadata.entries.map(item => [item.key, { order: item.value.order, name: item.value.name }])) });
  const officialModel = record => ({ modelUid: record.uid, label: record.label, disabled: !!record.disabled, familyUid: 'fusion',
    familyMetadata: Object.fromEntries((record.family || []).map(dim => [dim.key, { order: dim.order, name: dim.name }])) });
  const models = [...fixture.fusions.map(officialModel), ...result.models.filter(model => model.kind === 'matrix').map(pickerModel)];
  const rows = picker.rows(models);
  assert.equal(rows.length, 1, 'our combinations live inside the official Fusion family');
  const family = rows[0].family;
  for (const uid of ['swe-2-medium', 'swe-2-high', 'gpt-5-6-luna-high', 'gpt-5-6-sol-high', 'glm-5-2']) {
    const variant = family.models.find(model => result.fusions[model.modelUid]?.sidekickUid === uid);
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
    assert.equal(Object.hasOwn(dims['Fast Mode'], 'order'), false, model.uid);
    assert.equal(Object.hasOwn(dims['Recommended Sidekick'], 'order'), false, model.uid);
    assert.deepEqual(dims['Fast Mode'], { controlType: 2 });
    assert.deepEqual(dims['Recommended Sidekick'], { name: dims.Sidekick.name });
    // Selectable dimensions keep a real order; that is what makes them work.
    for (const key of ['Lead', 'Sidekick']) assert.equal(Number.isSafeInteger(dims[key].order), true, key + ' on ' + model.uid);
    if (dims.Effort) assert.equal(Number.isSafeInteger(dims.Effort.order), true, 'Effort on ' + model.uid);
  }
});

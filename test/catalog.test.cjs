'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { buildCatalog, buildRoleLists, augmentCatalog, resolveAssignment, collectNativeModels } = require('../src/catalog.cjs');
const { fields, str, num, s, v, m } = require('../src/protocol/wire.cjs');

const cat = (...parts) => Buffer.concat(parts.flat());
const proto = { json: false, type: 'application/proto', framed: false };
const json = { json: true, type: 'application/json', framed: false };
const lsStatus = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
const seatStatus = '/exa.seat_management_pb.SeatManagementService/GetUserStatus';
function config() {
  return {
    providers: [{ id: 'cpa', name: 'CPA', baseUrl: 'https://private.invalid/v1', apiKey: 'secret-test-value', apiFormat: 'openai',
      models: [
        { id: 'grok-4.6', label: 'Grok 4.6', efforts: ['medium', 'high'], contextWindow: 1000000, maxOutputTokens: 32768 },
        { id: 'ws-swe-2-max', label: 'SWE-2 Max', contextWindow: 200000, maxOutputTokens: 64000 },
      ] }, { id: 'other', name: 'Other', models: [{ id: 'some-model', label: 'Some Model', contextWindow: 32000, maxOutputTokens: 64000 }] }],
    sidekicks: [{ providerId: 'cpa', model: 'ws-swe-2-max' }, { nativeUid: 'swe-2-max', label: 'SWE-2 Max' }],
  };
}
const OBSERVED_SWE = [
  { uid: 'swe-2-max', label: 'SWE-2 Max', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6', 'swe-1p5'] },
  // Routeable but never selected: the picker can still ask for it, so it
  // exercises the uid-split fallback.
  { uid: 'swe-odd', label: 'SWE Odd', disabled: false, isModelRouter: false, harnessUids: ['swe-odd-harness'] },
  { uid: 'fusion-claude-fable-5-1-medium-sidekick-swe-2-max', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 3, name: 'SWE-2 Max' } },
];
const catalog = buildCatalog(config(), OBSERVED_SWE);
const familyEntry = (model, key) => model.json.modelFamilyMetadata.entries.find(entry => entry.key === key).value;
const getNested = (buffer, ...path) => path.reduce((message, number) => fields(message, number)[0].value, buffer);
const configs = buffer => fields(buffer, 1).filter(field => field.wire === 2).map(field => field.value);

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

function statusFixture() {
  const native = cat(s(1, 'Official SWE'), s(22, 'swe-2-max'), m(23, cat(s(17, 'swe-2-max'), s(18, 'https://official.invalid'), s(20, 'swe-1p6'), s(20, 'swe-1p5'))), v(101, 7));
  const sort = name => cat(s(1, name), m(2, cat(s(1, 'Official Group'), s(2, 'Official SWE'), v(90, 4))), v(91, 5));
  const list = cat(m(1, native), m(2, sort('Recommended')), m(2, sort('Alphabetical')), v(88, 6));
  const status = cat(s(1, 'opaque-user-value'), v(27, 33), m(33, list), m(98, cat(v(1, 456))));
  const body = cat(v(9, 4), m(1, status), s(99, 'response-extension'));
  return { native, list, status, body };
}

for (const rpc of [lsStatus, seatStatus]) test(`${rpc} appends namespace entries and preserves account/official fields`, () => {
  const fixture = statusFixture();
  const original = Buffer.from(fixture.body);
  const output = augmentCatalog(fixture.body, { rpc, format: proto, catalog });
  assert.deepEqual(fixture.body, original);
  const status = getNested(output, 1), list = getNested(status, 33);
  assert.deepEqual(configs(list).slice(0, catalog.models.length), catalog.models.map(model => model.raw));
  assert.deepEqual(configs(list).at(-1), fixture.native);
  assert.equal(configs(list).length, 19);
  assert.equal(str(status, 1), 'opaque-user-value');
  assert.deepEqual(fields(status, 98)[0].raw, fields(fixture.status, 98)[0].raw);
  assert.equal(num(status, 27), 33);
  assert.equal(num(list, 88), 6);
  assert.deepEqual(fields(output, 99)[0].raw, fields(fixture.body, 99)[0].raw);
  for (const sort of fields(list, 2)) {
    const groups = fields(sort.value, 2);
    assert.equal(groups.length, 2, 'named presets are retired, so there is no second own group');
    assert.equal(str(groups[0].value, 1), 'Devin Fusion BYOK');
    assert.equal(str(groups[1].value, 1), 'Official Group');
    assert.equal(num(groups[1].value, 90), 4);
    assert.equal(num(sort.value, 91), 5);
  }
  assert.deepEqual(augmentCatalog(output, { rpc, format: proto, catalog }), output);
});

test('the bare UserStatus cache shape is augmented at its own top-level model list', () => {
  // The CLI persists `user_status.<digest>.bin` as the bare `UserStatus`
  // message, not the `GetUserStatusResponse` envelope its RPC returns: field 1
  // is the `pro` boolean and the model list already sits at field 33 of the
  // payload. Field 1's wire type is the discriminator. Assuming the envelope
  // made every in-place cache rewrite return the payload untouched while the
  // refresh still reported success, so the uids a config change dropped were
  // never restored (measured before the fix: 96 of 120 own uids present).
  const fixture = statusFixture();
  const bare = cat(v(1, 1), s(3, 'opaque-user-value'), v(27, 33), m(33, fixture.list), m(98, cat(v(1, 456))));
  const original = Buffer.from(bare);
  const output = augmentCatalog(bare, { rpc: lsStatus, format: proto, catalog });
  assert.deepEqual(bare, original, 'the input buffer is never mutated');
  const list = getNested(output, 33);
  assert.deepEqual(configs(list).slice(0, catalog.models.length), catalog.models.map(model => model.raw));
  assert.deepEqual(configs(list).at(-1), fixture.native, 'official entries survive');
  assert.equal(configs(list).length, 19);
  assert.equal(num(output, 27), 33);
  assert.equal(str(output, 3), 'opaque-user-value');
  assert.deepEqual(fields(output, 98)[0].raw, fields(bare, 98)[0].raw);
  assert.deepEqual(augmentCatalog(output, { rpc: lsStatus, format: proto, catalog }), output);
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
const { rendererFile, loadFamilyPicker, loadAcpPicker } = require('./support/installed-renderer.cjs');
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

test('hidden official uids are removed from proto lists while observation still reports them', () => {
  const withHidden = { ...catalog, hiddenNativeModelUids: ['fusion-official-locked', 'swe-2-max'] };
  const locked = cat(s(1, 'Fusion (Locked)'), s(22, 'fusion-official-locked'), v(4, 1), s(33, 'pro'), m(32, v(1, 1)));
  const sharedHidden = cat(s(1, 'Shared Label'), s(22, 'swe-2-max'));
  const sharedKept = cat(s(1, 'Shared Label'), s(22, 'swe-2-high'));
  const open = cat(s(1, 'Fusion (Open)'), s(22, 'fusion-official-open'), m(32, v(1, 1)));
  const sort = cat(s(1, 'Recommended'), m(2, cat(s(1, 'Official Group'), s(2, 'Fusion (Locked)'), s(2, 'Shared Label'), s(2, 'Fusion (Open)'))));
  const input = cat(m(1, locked), m(1, sharedHidden), m(1, sharedKept), m(1, open), m(2, sort));
  let nativeReport, fusionReport;
  const output = augmentCatalog(input, { rpc: 'GetCascadeModelConfigs', format: proto, catalog: withHidden,
    onNativeModels: entries => { nativeReport = entries; }, onFusionStatus: (lockedUids, seen) => { fusionReport = { lockedUids, seen }; } });
  const entries = configs(output);
  assert.deepEqual(entries.map(entry => str(entry, 22)), [...catalog.models.map(model => model.uid), 'swe-2-high', 'fusion-official-open']);
  assert.deepEqual(nativeReport.map(entry => entry.uid), ['fusion-official-locked', 'swe-2-max', 'swe-2-high', 'fusion-official-open']);
  assert.deepEqual(nativeReport[0], { uid: 'fusion-official-locked', label: 'Fusion (Locked)', disabled: true, harnessUids: [], isModelRouter: false, sources: ['cascade'] });
  assert.deepEqual(nativeReport[2], { uid: 'swe-2-high', label: 'Shared Label', disabled: false, harnessUids: [], isModelRouter: false, sources: ['cascade'] });
  assert.deepEqual(fusionReport, { lockedUids: ['fusion-official-locked'], seen: ['fusion-official-locked', 'fusion-official-open'] });
  const groups = fields(getNested(output, 2), 2);
  assert.equal(groups.length, 2, 'our own group plus the preserved official one');
  assert.equal(str(groups[0].value, 1), 'Devin Fusion BYOK');
  assert.deepEqual(fields(groups[1].value, 2).map(field => field.value.toString()), ['Shared Label', 'Fusion (Open)']);
  assert.deepEqual(augmentCatalog(output, { rpc: 'GetCascadeModelConfigs', format: proto, catalog: withHidden }), output);
});

test('hidden official uids are removed from JSON lists including snake_case aliases', () => {
  const withHidden = { ...catalog, hiddenNativeModelUids: ['fusion-official-locked', 'swe-2-max'] };
  const locked = { label: 'Fusion (Locked)', model_uid: 'fusion-official-locked', disabled: true, disabled_reason: 'pro' };
  const shared = { label: 'Shared Label', model_uid: 'swe-2-max' };
  const kept = { label: 'Shared Label', modelUid: 'swe-2-high' };
  const open = { label: 'Fusion (Open)', modelUid: 'fusion-official-open' };
  const input = { client_model_configs: [locked, shared, kept, open],
    client_model_sorts: [{ name: 'Recommended', groups: [{ group_name: 'Official', model_labels: ['Fusion (Locked)', 'Shared Label', 'Fusion (Open)'] }] }] };
  let report;
  const output = augmentCatalog(input, { rpc: 'GetCascadeModelConfigs', format: json, catalog: withHidden, onNativeModels: entries => { report = entries; } });
  assert.deepEqual(output.client_model_configs.map(entry => entry.modelUid ?? entry.model_uid), [...catalog.models.map(model => model.uid), 'swe-2-high', 'fusion-official-open']);
  assert.deepEqual(report.map(entry => entry.uid), ['fusion-official-locked', 'swe-2-max', 'swe-2-high', 'fusion-official-open']);
  assert.deepEqual(report[0], { uid: 'fusion-official-locked', label: 'Fusion (Locked)', disabled: true, harnessUids: [], isModelRouter: false, sources: ['cascade'] });
  const groups = output.client_model_sorts[0].groups;
  assert.equal(groups.length, 2, 'our own group plus the preserved official one');
  assert.equal(groups[0].groupName, 'Devin Fusion BYOK');
  assert.deepEqual(groups[1].model_labels, ['Shared Label', 'Fusion (Open)']);
  assert.deepEqual(augmentCatalog(output, { rpc: 'GetCascadeModelConfigs', format: json, catalog: withHidden }), output);
});

test('hidden filtering and native observation work with an empty own catalog', () => {
  const bare = { models: [], routes: {}, fusions: {}, sidekicks: [], hiddenNativeModelUids: ['swe-2-max'] };
  const hiddenEntry = cat(s(1, 'Official SWE'), s(22, 'swe-2-max'), v(4, 1));
  const kept = cat(s(1, 'Other'), s(22, 'official-other'));
  const sort = cat(s(1, 'Recommended'), m(2, cat(s(1, 'Official Group'), s(2, 'Official SWE'), s(2, 'Other'))));
  const input = cat(m(1, hiddenEntry), m(1, kept), m(2, sort));
  let report;
  const output = augmentCatalog(input, { rpc: 'GetCascadeModelConfigs', format: proto, catalog: bare, onNativeModels: entries => { report = entries; } });
  assert.deepEqual(configs(output).map(entry => str(entry, 22)), ['official-other']);
  assert.deepEqual(report, [{ uid: 'swe-2-max', label: 'Official SWE', disabled: true, harnessUids: [], isModelRouter: false, sources: ['cascade'] },
    { uid: 'official-other', label: 'Other', disabled: false, harnessUids: [], isModelRouter: false, sources: ['cascade'] }]);
  const groups = fields(getNested(output, 2), 2);
  assert.equal(groups.length, 1, 'no empty own group is emitted for a pure native catalog');
  assert.equal(str(groups[0].value, 1), 'Official Group');
  assert.deepEqual(fields(groups[0].value, 2).map(field => field.value.toString()), ['Other']);
  const again = augmentCatalog(output, { rpc: 'GetCascadeModelConfigs', format: proto, catalog: bare, onNativeModels: entries => { report = entries; } });
  assert.deepEqual(again, output);
  assert.deepEqual(report.map(entry => entry.uid), ['official-other'], 'a second pass observes only what the current payload still contains');
});

test('observation still reports with zero own models and no hidden list', () => {
  const native = statusFixture().native;
  let report;
  const output = augmentCatalog(cat(m(1, native)), { rpc: 'GetCliModelConfigs', format: proto,
    catalog: buildCatalog(), onNativeModels: entries => { report = entries; } });
  assert.deepEqual(configs(output).map(entry => str(entry, 22)), ['swe-2-max']);
  assert.deepEqual(report, [{ uid: 'swe-2-max', label: 'Official SWE', disabled: false, harnessUids: ['swe-1p6', 'swe-1p5'], isModelRouter: false, sources: ['cli'] }]);
});

test('a hidden uid absent from upstream is never injected and a restored uid needs fresh upstream data', () => {
  const bare = { models: [], routes: {}, fusions: {}, sidekicks: [], hiddenNativeModelUids: ['swe-not-upstream', 'swe-2-max'] };
  const native = statusFixture().native;
  const input = cat(m(1, native));
  const hidden = augmentCatalog(input, { rpc: 'GetCliModelConfigs', format: proto, catalog: bare });
  assert.deepEqual(configs(hidden), [], 'hidden upstream entry is removed');
  const restored = augmentCatalog(input, { rpc: 'GetCliModelConfigs', format: proto,
    catalog: { ...bare, hiddenNativeModelUids: ['swe-not-upstream'] } });
  assert.deepEqual(restored, input, 'restoring the uid lets the current upstream entry through again');
  const upstreamWithoutIt = augmentCatalog(Buffer.alloc(0), { rpc: 'GetCliModelConfigs', format: proto, catalog: bare });
  assert.deepEqual(configs(upstreamWithoutIt), [], 'configured uids never appear without fresh upstream data');
});

test('hiding one uid hides every sibling sharing its familyUid', () => {
  const bare = { models: [], routes: {}, fusions: {}, sidekicks: [], hiddenNativeModelUids: ['swe-2-max'] };
  const member = (uid, label, family) => cat(s(1, label), s(22, uid), m(23, cat(s(23, family))));
  const input = cat(m(1, member('swe-2-max', 'SWE-2 Max', 'swe-2')), m(1, member('swe-2-high', 'SWE-2 High', 'swe-2')),
    m(1, member('solo-x', 'Solo X', '')), m(1, cat(s(1, 'No Family'), s(22, 'orphan'))));
  const output = augmentCatalog(input, { rpc: 'GetCliModelConfigs', format: proto, catalog: bare });
  assert.deepEqual(configs(output).map(entry => str(entry, 22)), ['solo-x', 'orphan'],
    'the hidden uid and its family sibling are both dropped; unrelated entries stay');
  const jsonOut = augmentCatalog({ clientModelConfigs: [
    { modelUid: 'swe-2-max', label: 'SWE-2 Max', modelInfo: { modelFamilyUid: 'swe-2' } },
    { modelUid: 'swe-2-high', label: 'SWE-2 High', modelInfo: { modelFamilyUid: 'swe-2' } },
    { modelUid: 'orphan', label: 'No Family' }] },
    { rpc: 'GetCliModelConfigs', format: json, catalog: bare });
  assert.deepEqual(jsonOut.clientModelConfigs.map(model => model.modelUid), ['orphan']);
});

test('ambiguous, malformed and own entries are skipped by observation but preserved in output', () => {
  const ambiguous = cat(s(22, 'uid-a'), s(22, 'uid-b'));
  const noUid = cat(s(1, 'No UID'));
  const ownEntry = cat(s(1, 'Own'), s(22, 'dfbyok-leftover'));
  const native = statusFixture().native;
  let report;
  const output = augmentCatalog(cat(m(1, ambiguous), m(1, noUid), m(1, ownEntry), m(1, native)),
    { rpc: 'GetCliModelConfigs', format: proto, catalog: buildCatalog(), onNativeModels: entries => { report = entries; } });
  assert.deepEqual(report, [{ uid: 'swe-2-max', label: 'Official SWE', disabled: false, harnessUids: ['swe-1p6', 'swe-1p5'], isModelRouter: false, sources: ['cli'] }]);
  const uids = configs(output).map(entry => fields(entry, 22).map(field => field.value.toString()));
  assert.deepEqual(uids, [['uid-a', 'uid-b'], [], ['swe-2-max']], 'ambiguous and uid-less natives pass through; own leftovers are replaced');
  const jsonReport = [];
  const jsonOutput = augmentCatalog({ clientModelConfigs: [{ label: 'ambiguous', modelUid: 'a', model_uid: 'b' }, { label: 'no uid' }, { modelUid: 'ok-native', label: 'OK' }] },
    { rpc: 'GetCliModelConfigs', format: json, catalog: buildCatalog(), onNativeModels: entries => jsonReport.push(...entries) });
  assert.deepEqual(jsonReport, [{ uid: 'ok-native', label: 'OK', disabled: false, harnessUids: [], isModelRouter: false, sources: ['cli'] }]);
  assert.equal(jsonOutput.clientModelConfigs.length, 3);
});

test('hidden filtering inside nested user status keeps disabled metadata and account fields', () => {
  const withHidden = { ...catalog, hiddenNativeModelUids: ['swe-2-max'] };
  const fixture = statusFixture();
  let report;
  const output = augmentCatalog(fixture.body, { rpc: lsStatus, format: proto, catalog: withHidden, onNativeModels: entries => { report = entries; } });
  const status = getNested(output, 1), list = getNested(status, 33);
  assert.deepEqual(configs(list).map(entry => str(entry, 22)), catalog.models.map(model => model.uid));
  assert.equal(str(status, 1), 'opaque-user-value');
  assert.equal(num(list, 88), 6);
  assert.deepEqual(report.map(entry => entry.uid), ['swe-2-max']);
  assert.deepEqual(augmentCatalog(output, { rpc: lsStatus, format: proto, catalog: withHidden }), output);
});

test('ambiguous proto uids stay byte-identical even when a first uid is configured hidden', () => {
  const bare = { models: [], routes: {}, fusions: {}, sidekicks: [], hiddenNativeModelUids: ['dup-uid', 'wire-uid', 'swe-2-max'] };
  const duplicate = cat(s(1, 'Dup'), s(22, 'dup-uid'), s(22, 'other-uid'));
  const wrongWire = cat(s(1, 'Wire'), s(22, 'wire-uid'), v(22, 7));
  const onlyWrongWire = cat(s(1, 'Varint'), v(22, 7));
  const hidden = statusFixture().native;
  const input = cat(m(1, duplicate), m(1, wrongWire), m(1, onlyWrongWire), m(1, hidden));
  let report;
  const output = augmentCatalog(input, { rpc: 'GetCliModelConfigs', format: proto, catalog: bare,
    onNativeModels: entries => { report = entries; } });
  const entries = configs(output);
  assert.equal(entries.length, 3, 'ambiguous records pass through; only the unambiguous hidden uid is removed');
  assert.deepEqual(report.map(entry => entry.uid), ['swe-2-max'], 'ambiguous records are not reported either');
  assert.ok(output.includes(Buffer.from('dup-uid')), 'the ambiguous record keeps its original bytes');
  assert.deepEqual(configs(augmentCatalog(output, { rpc: 'GetCliModelConfigs', format: proto, catalog: bare })).length, 3, 'idempotent');
});

test('JSON entries with unequal modelUid aliases are never hidden or observed', () => {
  const bare = { models: [], routes: {}, fusions: {}, sidekicks: [], hiddenNativeModelUids: ['alias-a', 'gone'] };
  const input = { clientModelConfigs: [
    { label: 'Mismatch', modelUid: 'alias-a', model_uid: 7 },
    { label: 'Both same', modelUid: 'alias-b', model_uid: 'alias-b' },
    { label: 'Hidden', modelUid: 'gone' },
    { label: 'Kept', model_uid: 'kept' },
  ] };
  let report;
  const output = augmentCatalog(input, { rpc: 'GetCliModelConfigs', format: json, catalog: bare,
    onNativeModels: entries => { report = entries; } });
  assert.deepEqual(output.clientModelConfigs.map(entry => entry.label), ['Mismatch', 'Both same', 'Kept']);
  assert.deepEqual(report.map(entry => entry.uid), ['alias-b', 'gone', 'kept'], 'the mismatched alias entry is neither hidden nor observed');
});

for (const format of [proto, json]) test(`${format.json ? 'JSON' : 'protobuf'} collectNativeModels extracts sanitized capability metadata`, () => {
  if (format.json) {
    for (const snake of [false, true]) {
      const info = snake ? { model_info: { harness_uids: ['swe-1p5'], is_model_router: false } }
        : { modelInfo: { harnessUids: ['swe-1p5'], isModelRouter: false } };
      const list = { clientModelConfigs: [{ label: 'A', modelUid: 'swe-a', disabled: false, ...info }] };
      assert.deepEqual(collectNativeModels(list, { rpc: 'GetCliModelConfigs', format: json }),
        [{ uid: 'swe-a', label: 'A', disabled: false, harnessUids: ['swe-1p5'], isModelRouter: false, sources: ['cli'] }]);
    }
    const nested = { userStatus: { cascadeModelConfigData: { clientModelConfigs: [
      { label: 'R', modelUid: 'swe-router', modelInfo: { harnessUids: ['swe-1p6'], isModelRouter: true } }] } } };
    assert.deepEqual(collectNativeModels(nested, { rpc: lsStatus, format: json }),
      [{ uid: 'swe-router', label: 'R', disabled: false, harnessUids: ['swe-1p6'], isModelRouter: true, sources: ['entitlement'] }]);
  } else {
    const fixture = statusFixture();
    assert.deepEqual(collectNativeModels(fixture.body, { rpc: lsStatus, format: proto }),
      [{ uid: 'swe-2-max', label: 'Official SWE', disabled: false, harnessUids: ['swe-1p6', 'swe-1p5'], isModelRouter: false, sources: ['entitlement'], pickerListed: true }]);
    const direct = cat(m(1, cat(s(1, 'Router'), s(22, 'swe-router'), m(23, cat(s(20, 'swe-1p6'), v(25, 1))))));
    assert.deepEqual(collectNativeModels(direct, { rpc: 'GetCliModelConfigs', format: proto }),
      [{ uid: 'swe-router', label: 'Router', disabled: false, harnessUids: ['swe-1p6'], isModelRouter: true, sources: ['cli'] }]);
    assert.equal(collectNativeModels(cat(m(1, cat(s(1, 'Missing status'), s(22, 'swe-x')))), { rpc: lsStatus, format: proto }).length, 0,
      'a flat proto list is not a nested user status payload');
  }
  assert.deepEqual(collectNativeModels(format.json ? {} : Buffer.alloc(0), { rpc: 'GetCliModelConfigs', format }), []);
  assert.equal(collectNativeModels(statusFixture().body, { rpc: 'GetAccount', format: proto }).length, 0);
});

test('collectNativeModels keeps canonical observation fields through the shared normalizer', () => {
  const entry = { label: 'Full', modelUid: 'swe-full', disabled: false,
    modelInfo: { harnessUids: ['h'], isModelRouter: false, modelFamilyUid: 'fam-full', maxTokens: 200000 } };
  const [record] = collectNativeModels({ clientModelConfigs: [entry] }, { rpc: 'GetCliModelConfigs', format: json });
  assert.equal(record.familyUid, 'fam-full');
  assert.equal(record.maxTokens, 200000);
  assert.deepEqual(record.sources, ['cli']);
  const withPicker = { clientModelSorts: [{ groups: [{ modelLabels: ['Full'] }] }], clientModelConfigs: [entry] };
  const [picked] = collectNativeModels(withPicker, { rpc: 'GetCascadeModelConfigs', format: json });
  assert.equal(picked.pickerListed, true, 'a sorts payload yields a positive picker verdict');
  const unpicked = { clientModelSorts: [{ groups: [{ modelLabels: ['Other'] }] }], clientModelConfigs: [entry] };
  const [verdict] = collectNativeModels(unpicked, { rpc: 'GetCascadeModelConfigs', format: json });
  assert.equal(verdict.pickerListed, false, 'absence from the sort groups is a false verdict, not absent');
  const protoEntry = cat(s(1, 'K'), s(22, 'swe-kind'), v(6, 1), m(23, cat(s(20, 'h'), v(25, 0), v(22, 8), s(23, 'fam-k'))));
  const [protoRecord] = collectNativeModels(cat(m(1, protoEntry)), { rpc: 'GetCliModelConfigs', format: proto });
  assert.equal(protoRecord.kind, 8);
  assert.equal(protoRecord.listed, true);
  assert.equal(protoRecord.familyUid, 'fam-k');
  assert.deepEqual(protoRecord.sources, ['cli']);
});

test('collectNativeModels fails closed on ambiguous or mistyped capability fields', () => {
  const wrap = entry => cat(m(1, entry));
  for (const entry of [
    cat(s(1, 'Dup23'), s(22, 'a'), m(23, cat(s(20, 'swe-1p6'))), m(23, cat(s(20, 'swe-1p5')))),
    cat(s(1, 'Wire23'), s(22, 'b'), v(23, 1)),
    cat(s(1, 'Wire20'), s(22, 'c'), m(23, cat(s(20, 'swe-1p6'), v(20, 1)))),
    cat(s(1, 'Dup25'), s(22, 'd'), m(23, cat(s(20, 'swe-1p6'), v(25, 1), v(25, 0)))),
    cat(s(1, 'Wire25'), s(22, 'e'), m(23, cat(s(20, 'swe-1p6'), s(25, 'x')))),
    cat(s(1, 'Junk23'), s(22, 'f'), m(23, Buffer.from([0x0a, 0xff]))),
  ]) {
    const records = collectNativeModels(wrap(entry), { rpc: 'GetCliModelConfigs', format: proto });
    assert.equal(records.length, 1);
    assert.deepEqual([records[0].harnessUids, records[0].isModelRouter], [[], false], 'ambiguous metadata yields no capability');
  }
  assert.equal(collectNativeModels(cat(m(1, cat(s(22, 'x'), s(22, 'y')))), { rpc: 'GetCliModelConfigs', format: proto }).length, 0);
  assert.equal(collectNativeModels(cat(m(1, cat(s(22, 'x'), v(22, 7)))), { rpc: 'GetCliModelConfigs', format: proto }).length, 0);
  for (const entry of [
    { modelUid: 'a', modelInfo: { harnessUids: ['swe-1p6'] }, model_info: { harnessUids: ['swe-1p5'] } },
    { modelUid: 'b', modelInfo: { harnessUids: 'swe-1p6' } },
    { modelUid: 'c', modelInfo: { harnessUids: ['swe-1p6'], isModelRouter: 'yes' } },
    { modelUid: 'd', modelInfo: { harnessUids: ['swe-1p6'], isModelRouter: true, is_model_router: false } },
    { modelUid: 'e', model_info: 'nope' },
    { modelUid: 'f', modelInfo: { harness_uids: ['swe-1p6', 7] } },
  ]) {
    const [record] = collectNativeModels({ clientModelConfigs: [entry] }, { rpc: 'GetCliModelConfigs', format: json });
    assert.deepEqual([record.harnessUids, record.isModelRouter], [[], false]);
  }
});

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

test('ambiguous user status envelopes drop observation entirely instead of guessing', () => {
  const fixture = statusFixture();
  const list = getNested(fixture.status, 33);
  for (const body of [
    cat(m(1, fixture.status), v(1, 7)),
    cat(m(1, fixture.status), m(1, fixture.status)),
    cat(v(9, 4), m(1, cat(s(1, 'opaque-user-value'), m(33, list), v(33, 2)))),
    cat(v(9, 4), m(1, cat(s(1, 'opaque-user-value'), m(33, list), m(33, list)))),
  ]) {
    assert.deepEqual(collectNativeModels(body, { rpc: lsStatus, format: proto }), []);
  }
});

const dimEntry = (order, name, controlType = 3) => m(2, cat(s(1, 'Sidekick'), m(2, cat(v(1, order), s(2, name), v(3, controlType)))));
const fam = (...entries) => m(30, cat(s(1, 'Fusion'), ...entries));
const fusionRecord = (uid, order, name, disabled = 0) =>
  cat(s(1, 'Official'), s(22, uid), v(4, disabled), m(23, cat(s(20, 'fusion'), v(25, 1))), fam(dimEntry(order, name)));

test('protobuf and JSON collect the official Sidekick dimension only when unambiguous', () => {
  const base = uid => cat(s(1, 'F'), s(22, uid), fam(dimEntry(4, 'GPT-5.6 Luna High')));
  assert.deepEqual(collectNativeModels(cat(m(1, base('fusion-a-sidekick-swe-x'))), { rpc: 'GetCliModelConfigs', format: proto })[0].sidekickDimension,
    { order: 4, name: 'GPT-5.6 Luna High', fastModeOrder: 0 });
  for (const entry of [
    cat(s(22, 'a'), fam(dimEntry(1, 'A')), fam(dimEntry(2, 'B'))),
    cat(s(22, 'b'), s(30, 'not-a-message')),
    cat(s(22, 'c'), fam(dimEntry(1, 'A'), dimEntry(2, 'B'))),
    cat(s(22, 'd'), fam(m(2, cat(s(1, 'Sidekick'), m(2, cat(v(1, 1), v(1, 2), s(2, 'A'))))))),
    cat(s(22, 'e'), fam(m(2, cat(s(1, 'Sidekick'), m(2, cat(v(1, 1), s(2, 'A'), s(2, 'B'))))))),
    cat(s(22, 'f'), fam(m(2, cat(s(1, 'Sidekick'), s(2, 'wrong-wire'))))),
    cat(s(22, 'g'), fam(m(2, cat(s(1, 'Sidekick'), m(2, cat(v(1, 1))))))),
    cat(s(22, 'h'), fam(m(2, cat(v(1, 1), s(2, 'no key?'))))),
    cat(s(22, 'i'), fam(dimEntry(1, 'A'), m(2, cat(s(1, 'Fast Mode'), m(2, cat(v(1, 0), v(1, 1))))))),
    cat(s(22, 'j'), fam(dimEntry(1, 'A'), m(2, cat(s(1, 'Fast Mode'), m(2, cat(v(1, 0), s(2, 'x'))))),
      m(2, cat(s(1, 'Fast Mode'), m(2, cat(v(1, 1), s(2, 'y'))))))),
  ]) {
    const [record] = collectNativeModels(cat(m(1, entry)), { rpc: 'GetCliModelConfigs', format: proto });
    assert.equal(record?.sidekickDimension, undefined, entry ? 'malformed family metadata must not yield a dimension' : '');
  }
  const [jsonRecord] = collectNativeModels({ clientModelConfigs: [{ modelUid: 'fusion-a-sidekick-swe-x',
    modelFamilyMetadata: { entries: [{ key: 'Sidekick', value: { order: 4, name: 'Luna', controlType: 3 } }] } }] },
    { rpc: 'GetCliModelConfigs', format: json });
  assert.deepEqual(jsonRecord.sidekickDimension, { order: 4, name: 'Luna', fastModeOrder: 0 });
  const [snakeRecord] = collectNativeModels({ client_model_configs: [{ model_uid: 'fusion-a-sidekick-swe-x',
    model_family_metadata: { entries: [{ key: 'Sidekick', value: { order: 5, name: 'Sol', control_type: 3 } }] } }] },
    { rpc: 'GetCliModelConfigs', format: json });
  assert.deepEqual(snakeRecord.sidekickDimension, { order: 5, name: 'Sol', fastModeOrder: 0 });
  for (const modelFamilyMetadata of [
    { entries: [{ key: 'Sidekick', value: { order: '4', name: 'A' } }] },
    { entries: [{ key: 'Sidekick', value: { order: -1, name: 'A' } }] },
    { entries: [{ key: 'Sidekick', value: { order: 4, name: '' } }] },
    { entries: [{ key: 'Sidekick', value: { order: 4, name: 'A' } }, { key: 'Sidekick', value: { order: 4, name: 'A' } }] },
    { entries: [{ key: 'Sidekick', value: { order: 4, name: 'A', controlType: 3, control_type: 2 } }] },
    { entries: 'nope' }, 'nope',
  ]) {
    const [record] = collectNativeModels({ clientModelConfigs: [{ modelUid: 'fusion-a-sidekick-swe-x', modelFamilyMetadata }] },
      { rpc: 'GetCliModelConfigs', format: json });
    assert.equal(record.sidekickDimension, undefined);
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

test('sanitized real catalog entries yield canonical orders and exact harnesses through proto observation', () => {
  const fixture = JSON.parse(fs.readFileSync(__dirname + '/fixtures/real-picker-0.3.11.json', 'utf8'));
  const protoFamily = family => m(30, cat(s(1, 'Fusion'), ...(family || []).map(dim =>
    m(2, cat(s(1, dim.key), m(2, cat(v(1, dim.order), s(2, dim.name), v(3, dim.controlType ?? 0))))))));
  const entry = record => cat(s(1, record.label), s(22, record.uid), v(4, record.disabled ? 1 : 0),
    m(23, cat(...(record.harnesses || []).map(harness => s(20, harness)), v(25, record.router ? 1 : 0))), protoFamily(record.family));
  const records = collectNativeModels(cat(...[...fixture.natives, ...fixture.fusions].map(record => m(1, entry(record)))),
    { rpc: 'GetCliModelConfigs', format: proto });
  const result = buildCatalog(config(), records);
  const expected = { 'swe-2-medium': 1, 'swe-2-high': 2, 'gpt-5-6-luna-high': 4, 'gpt-5-6-sol-high': 5, 'glm-5-2': 6 };
  const models = result.models.filter(model => model.kind === 'matrix');
  for (const [uid, order] of Object.entries(expected)) {
    const fusion = models.find(model => result.fusions[model.uid]?.sidekickUid === uid);
    assert.ok(fusion, uid + ' must generate a native combination');
    assert.equal(result.sidekicks.find(item => item.uid === uid).dimension.order, order, uid + ' retains its canonical binding');
    const dims = Object.fromEntries(fusion.json.modelFamilyMetadata.entries.map(entry => [entry.key, entry.value]));
    assert.equal(dims.Sidekick.order, order, uid + ' is emitted under its canonical order');
  }
  assert.deepEqual(result.fusions[models.find(model => result.fusions[model.uid]?.sidekickUid === 'gpt-5-6-luna-high').uid].sidekickHarnessUids, ['gpt-5p6']);
  assert.deepEqual(result.fusions[models.find(model => result.fusions[model.uid]?.sidekickUid === 'glm-5-2').uid].sidekickHarnessUids, ['strawberry-pancake']);
  assert.equal(result.sidekicks.find(item => item.uid === 'gpt-5-6-luna-high-priority'), undefined,
    'the -priority twin is never bound through ambiguous suffixes');
});

test('the installed picker selects every canonical native Sidekick on generated combinations', { skip: !fs.existsSync(rendererFile) }, () => {
  const picker = loadFamilyPicker();
  const fixture = JSON.parse(fs.readFileSync(__dirname + '/fixtures/real-picker-0.3.11.json', 'utf8'));
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

test('augmentation drops f32-less fusion entries emitted by earlier catalog generations', () => {
  const probe = buildCatalog(config(), OBSERVED_SWE);
  const stale = cat(s(1, 'Fusion (Claude Haiku 5.5 Medium + GLM)'), s(22, 'fusion-claude-haiku-5-5-medium-sidekick-glm-5-2'),
    m(30, cat(s(1, 'Fusion'), m(2, cat(s(1, 'Lead'), m(2, cat(v(1, 20), s(2, 'Claude Haiku 5.5 Medium'))))))));
  const official = cat(s(1, 'Fusion (Claude Fable 5.1 Medium + SWE)'), s(22, 'fusion-claude-fable-5-1-medium-sidekick-swe-2-max'),
    m(30, cat(s(1, 'Fusion'))), m(32, v(1, 1)));
  const input = cat(m(1, stale), m(1, official));
  const output = augmentCatalog(input, { rpc: 'GetCliModelConfigs', format: proto, catalog: probe });
  const uids = configs(output).map(entry => str(entry, 22));
  assert.ok(!uids.includes('fusion-claude-haiku-5-5-medium-sidekick-glm-5-2'), 'stale emitted uid is dropped');
  assert.ok(uids.includes('fusion-claude-fable-5-1-medium-sidekick-swe-2-max'), 'official f32 entry is preserved');
  for (const model of probe.models) assert.ok(uids.includes(model.uid), 'current emit is re-added');
});

test('staleFusionUids reports only unemitted f32-less fusion uids in every payload shape', () => {
  const { staleFusionUids } = require('../src/catalog.cjs');
  const emitted = new Set(['fusion-a-sidekick-b']);
  const ours = cat(s(1, 'F'), s(22, 'fusion-a-sidekick-b'));
  const staleEntry = cat(s(1, 'F2'), s(22, 'fusion-claude-x-sidekick-claude-y'));
  const official = cat(s(1, 'F3'), s(22, 'fusion-official-a-sidekick-b'), m(32, v(1, 1)));
  const plain = cat(s(1, 'P'), s(22, 'swe-2-max'));
  const flat = cat(m(1, ours), m(1, staleEntry), m(1, official), m(1, plain));
  assert.deepEqual(staleFusionUids(flat, { emitted, known: emitted }), ['fusion-claude-x-sidekick-claude-y']);
  const nested = cat(m(1, cat(s(1, 'status'), m(33, cat(m(1, staleEntry), m(1, official))))));
  assert.deepEqual(staleFusionUids(nested, { emitted, known: emitted }), ['fusion-claude-x-sidekick-claude-y']);
  // The bare `UserStatus` message the CLI caches carries the list at field 33 of
  // the payload itself, with field 1 taken by the `pro` boolean. Scanning only
  // the envelope made these entries invisible, so they could never be retired.
  const bare = cat(v(1, 1), m(33, cat(m(1, staleEntry), m(1, official))));
  assert.deepEqual(staleFusionUids(bare, { emitted, known: emitted }), ['fusion-claude-x-sidekick-claude-y']);
  const both = new Set(['fusion-a-sidekick-b', 'fusion-claude-x-sidekick-claude-y']);
  assert.deepEqual(staleFusionUids(flat, { emitted: both, known: both }), []);
  assert.deepEqual(staleFusionUids(Buffer.from('garbage'), { emitted, known: emitted }), []);
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

test('staleFusionUids keeps entries whose members are merely unselected', () => {
  const { staleFusionUids } = require('../src/catalog.cjs');
  const emitted = new Set(['fusion-live-sidekick-swe-2-max']);
  const unselected = cat(s(1, 'F'), s(22, 'fusion-lead-sidekick-swe-2-high'));
  const orphan = cat(s(1, 'F'), s(22, 'fusion-gone-sidekick-also-gone'));
  const byokGone = cat(s(1, 'F'), s(22, 'fusion-dfbyok-old-digest-sidekick-swe-2-max'));
  const excluded = cat(s(1, 'F'), s(22, 'fusion-lead-sidekick-swe-2-medium'));
  const malformed = cat(s(1, 'F'), s(22, 'fusion-sidekick-claude-haiku-5-5-medium'));
  const flat = cat(m(1, unselected), m(1, orphan), m(1, byokGone), m(1, excluded), m(1, malformed));
  const known = new Set(['lead', 'swe-2-high', 'swe-2-max', 'swe-2-medium', 'fusion-live-sidekick-swe-2-max']);
  // The complete form: only entries that can never be served again are reported.
  const sorted = uids => [...uids].sort();
  assert.deepEqual(sorted(staleFusionUids(flat, { emitted, known })),
    sorted(['fusion-gone-sidekick-also-gone', 'fusion-dfbyok-old-digest-sidekick-swe-2-max', 'fusion-sidekick-claude-haiku-5-5-medium']),
    'a merely unselected pair survives, unknown members and malformed uids do not');
  // Role-specific exclusions still retire an entry, so turning a model off
  // actually removes its dimension values from the picker.
  assert.deepEqual(sorted(staleFusionUids(flat, { emitted, known, excluded: { lead: new Set(), sidekick: new Set(['swe-2-medium']) } })),
    sorted(['fusion-gone-sidekick-also-gone', 'fusion-dfbyok-old-digest-sidekick-swe-2-max', 'fusion-lead-sidekick-swe-2-medium', 'fusion-sidekick-claude-haiku-5-5-medium']));
  assert.deepEqual(sorted(staleFusionUids(flat, { emitted, known, excluded: { lead: new Set(['lead']), sidekick: new Set() } })),
    sorted(['fusion-gone-sidekick-also-gone', 'fusion-dfbyok-old-digest-sidekick-swe-2-max', 'fusion-lead-sidekick-swe-2-high', 'fusion-lead-sidekick-swe-2-medium', 'fusion-sidekick-claude-haiku-5-5-medium']),
    'a lead exclusion only retires entries that use it as a lead');
});

test('staleFusionUids rejects non-object arguments loudly instead of deleting everything', () => {
  const { staleFusionUids } = require('../src/catalog.cjs');
  const flat = cat(m(1, cat(s(1, 'F'), s(22, 'fusion-a-sidekick-b'))));
  for (const bad of [new Set(['fusion-a-sidekick-b']), ['fusion-a-sidekick-b'], null]) {
    assert.throws(() => staleFusionUids(flat, bad), TypeError);
  }
  assert.throws(() => staleFusionUids(flat), TypeError, 'a missing options argument must not mean an empty catalog');
});

test('staleFusionUids requires a populated `known` set instead of falling back to absence semantics', () => {
  const { staleFusionUids } = require('../src/catalog.cjs');
  const flat = cat(m(1, cat(s(1, 'F'), s(22, 'fusion-lead-sidekick-swe-2-high'))));
  // `known` is the only real discriminator, so an absent or empty set would
  // report every entry missing from `emitted` as stale — the absence semantics
  // that once deleted 131 valid combinations.
  assert.throws(() => staleFusionUids(flat, { emitted: new Set() }), TypeError);
  assert.throws(() => staleFusionUids(flat, { emitted: new Set(), known: new Set() }), TypeError);
  assert.throws(() => staleFusionUids(flat, { emitted: new Set(), known: [] }), TypeError);
  assert.throws(() => staleFusionUids(flat, { emitted: new Set(), known: 'lead' }), TypeError);
  // The populated form still keeps a pair whose members are merely unselected.
  assert.deepEqual(staleFusionUids(flat, { emitted: new Set(), known: new Set(['lead', 'swe-2-high']) }), []);
});

test('a throwing staleProbe is a safe no-op for refreshStaleCliCaches', () => {
  const os = require('node:os'), nodePath = require('node:path');
  const { refreshStaleCliCaches } = require('../src/runtime/cli-cache.cjs');
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cli-cache-staleprobe-'));
  const name = 'model_configs_v5.bbbbbbbbbbbbbbbb.bin';
  const payload = Buffer.from('dfbyok-new-uid', 'utf8').toString('base64');
  const file = nodePath.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({ version: 1, identity_digest: 'd', fetched_at_secs: 1, payload }));
  const before = fs.readFileSync(file);
  const result = refreshStaleCliCaches({ dir, expectedUids: ['dfbyok-new-uid'],
    staleProbe: () => { throw new TypeError('staleFusionUids requires { emitted, known, excluded }'); },
    augment: p => p });
  assert.equal(result.errors.length, 0, 'a failing probe never surfaces as a write error');
  assert.deepEqual(result.refreshed, []);
  assert.deepEqual(result.skipped, [], 'a throwing probe yields an empty stale list, so the file is never a candidate');
  assert.deepEqual(fs.readFileSync(file), before, 'a wrongly-typed call can never wipe the cache');
});

// Lead role families: every native uid groups by its effort-series base. Fast
// Mode is an orthogonal switch, so official Fast siblings join the official
// family; any other same-base uid stays a single-member row.
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

for (const format of [proto, json]) test(`${format.json ? 'JSON' : 'protobuf'} collectNativeModels reads the server family uid`, () => {
  if (format.json) {
    for (const snake of [false, true]) {
      const info = snake
        ? { model_info: { harness_uids: ['swe-1p5'], is_model_router: false, model_family_uid: 'glm-5.2' } }
        : { modelInfo: { harnessUids: ['swe-1p5'], isModelRouter: false, modelFamilyUid: 'glm-5.2' } };
      const [record] = collectNativeModels({ clientModelConfigs: [{ label: 'GLM', modelUid: 'glm-5-2', ...info }] },
        { rpc: 'GetCliModelConfigs', format: json });
      assert.equal(record.familyUid, 'glm-5.2');
    }
    for (const bad of [{ modelFamilyUid: 42 }, { modelFamilyUid: '' }, { modelFamilyUid: 'x'.repeat(200) }]) {
      const [record] = collectNativeModels({ clientModelConfigs: [{ label: 'GLM', modelUid: 'glm-5-2',
        modelInfo: { harnessUids: ['h'], isModelRouter: false, ...bad } }] }, { rpc: 'GetCliModelConfigs', format: json });
      assert.equal(record.familyUid, undefined, 'malformed family ids are ignored: ' + JSON.stringify(bad));
      assert.deepEqual(record.harnessUids, ['h'], 'a bad family id never invalidates the rest of the entry');
    }
  } else {
    const protoWith = extra => cat(s(1, 'GLM'), s(22, 'glm-5-2'), m(23, cat(s(20, 'swe-1p5'), ...extra)));
    const [withFamily] = collectNativeModels(cat(m(1, protoWith([s(23, 'glm-5.2')]))),
      { rpc: 'GetCliModelConfigs', format: proto });
    assert.equal(withFamily.familyUid, 'glm-5.2');
    const [whitespace] = collectNativeModels(cat(m(1, protoWith([s(23, '  glm-5.2  ')]))),
      { rpc: 'GetCliModelConfigs', format: proto });
    assert.equal(whitespace.familyUid, 'glm-5.2', 'the family id is trimmed');
    for (const bad of [s(23, ''), v(23, 4), s(23, 'x'.repeat(200))]) {
      const [record] = collectNativeModels(cat(m(1, protoWith([bad]))), { rpc: 'GetCliModelConfigs', format: proto });
      assert.equal(record.familyUid, undefined);
      assert.deepEqual(record.harnessUids, ['swe-1p5'], 'a bad family id never invalidates the rest of the entry');
    }
  }
});

for (const format of [proto, json]) test(`${format.json ? 'JSON' : 'protobuf'} collectNativeModels keeps non-canonical control dimensions`, () => {
  if (format.json) {
    const [record] = collectNativeModels({ clientModelConfigs: [{ label: 'GLM', modelUid: 'glm-5-2-1m',
      modelInfo: { harnessUids: ['h'], isModelRouter: false },
      modelFamilyMetadata: { entries: [
        { key: 'Effort', value: { order: 1, name: 'High', controlType: 1 } },
        { key: '1M Context', value: { order: 1, controlType: 2 } },
        { key: 'Speed', value: {} },
      ] } }] }, { rpc: 'GetCliModelConfigs', format: json });
    assert.deepEqual(record.fusionMetadata, [
      { key: 'Effort', order: 1, name: 'High', controlType: 1 },
      { key: '1M Context', order: 1, name: '', controlType: 2 },
      { key: 'Speed', order: 0, name: '', controlType: 0 }],
      'a nameless non-canonical key like Speed must not void the whole metadata');
  } else {
    const dim = (key, ...valueParts) => m(2, cat(s(1, key), m(2, cat(...valueParts))));
    const entry = cat(s(1, 'GLM'), s(22, 'glm-5-2-1m'), m(23, cat(s(20, 'h'))),
      m(30, cat(s(1, 'Fusion'),
        dim('Effort', v(1, 1), s(2, 'High'), v(3, 1)),
        dim('1M Context', v(1, 1), v(3, 2)),
        dim('Speed', v(3, 2)))));
    const [record] = collectNativeModels(cat(m(1, entry)), { rpc: 'GetCliModelConfigs', format: proto });
    assert.deepEqual(record.fusionMetadata, [
      { key: 'Effort', order: 1, name: 'High', controlType: 1 },
      { key: '1M Context', order: 1, name: '', controlType: 2 },
      { key: 'Speed', order: 0, name: '', controlType: 2 }]);
  }
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

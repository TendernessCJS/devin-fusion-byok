'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalog, augmentCatalog } = require('../src/catalog.cjs');
const { parseFields, fields, s, v, m } = require('../src/protocol/wire.cjs');

const RPC = '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings';
const proto = { json: false, type: 'application/proto', framed: false };
const json = { json: true, type: 'application/json', framed: false };
const concat = (...parts) => Buffer.concat(parts.flat());
const own = uid => /^(?:dfbyok-|fusion-dfbyok-)/.test(uid);
const catalog = buildCatalog({
  providers: [{ id: 'test', name: 'Test', models: [{ id: 'lead' }, { id: 'swe' }] }],
  sidekicks: [{ providerId: 'test', model: 'swe' }, { nativeUid: 'swe-2-max' }],
}, [{ uid: 'swe-2-max', label: 'SWE-2 Max', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6', 'swe-1p5'] }]);
const apply = (data, format = proto, selected = catalog, rpc = RPC) =>
  augmentCatalog(data, { rpc, format, catalog: selected });
const choices = buffer => fields(buffer, 7).map(field => field.value.toString('utf8'));
const otherFields = buffer => concat(parseFields(buffer).filter(field => field.number !== 7).map(field => field.raw));
const fixture = () => concat(v(1, 1), s(7, 'native-gpt'), m(31, concat(v(2, 3), s(4, 'opaque'))),
  s(7, 'swe-2-max'), v(109, 12345), s(7, 'native-gpt'));

test('team settings protobuf registers local routes and preserves native choices and all unrelated bytes', () => {
  const input = fixture(), snapshot = Buffer.from(input);
  const output = apply(input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(choices(output), [...choices(input), ...catalog.models.map(model => model.uid)]);
  assert.deepEqual(otherFields(output), otherFields(input));
  assert.deepEqual(fields(output, 7).filter(field => !own(field.value.toString('utf8'))).map(field => field.raw),
    fields(input, 7).map(field => field.raw));
  assert.equal(choices(output).filter(uid => uid === 'native-gpt').length, 2);
});

for (const key of ['allowedModelUids', 'allowed_model_uids']) {
  test(`team settings JSON ${key} preserves original fields and never changes the input`, () => {
    const input = { [key]: ['native-gpt', 'swe-2-max'], permissions: { enabled: false },
      opaque: { quota: 37 }, futureSetting: ['x', 'y'] };
    const snapshot = structuredClone(input);
    const output = apply(input, json);
    assert.deepEqual(input, snapshot);
    assert.deepEqual(output, { ...snapshot, [key]: [...snapshot[key], ...catalog.models.map(model => model.uid)] });
    assert.ok(!Object.hasOwn(output, key === 'allowedModelUids' ? 'allowed_model_uids' : 'allowedModelUids'));
    assert.deepEqual(apply(output, json), output);
  });
}

for (const format of [proto, json]) {
  test(`native Sidekick Fusion requires an already allowed native UID (${format.json ? 'JSON' : 'protobuf'})`, () => {
    const input = format.json ? { allowedModelUids: ['native-gpt'] } : s(7, 'native-gpt');
    const output = apply(input, format);
    const values = format.json ? output.allowedModelUids : choices(output);
    assert.deepEqual(values, ['native-gpt', ...catalog.models.filter(model =>
      catalog.routes[model.uid] || !catalog.fusions[model.uid].sidekickNative).map(model => model.uid)]);
    assert.ok(!values.includes('swe-2-max'));
    for (const fusion of Object.values(catalog.fusions)) {
      assert.equal(values.includes(fusion.uid), !fusion.sidekickNative);
    }
  });
}

test('models without an actual local route or both Fusion assignments are not registered', () => {
  const unavailable = structuredClone(catalog);
  const blockedRoute = Object.values(unavailable.routes).find(route => route.model === 'swe').uid;
  delete unavailable.routes[blockedRoute];
  unavailable.models.push({ uid: 'dfbyok-no-route' }, { uid: 'fusion-dfbyok-no-assignment' });
  const values = choices(apply(fixture(), proto, unavailable));
  assert.ok(!values.includes(blockedRoute));
  assert.ok(!values.includes('dfbyok-no-route'));
  assert.ok(!values.includes('fusion-dfbyok-no-assignment'));
  for (const fusion of Object.values(unavailable.fusions)) {
    assert.equal(values.includes(fusion.uid), fusion.leadUid !== blockedRoute && fusion.sidekickUid !== blockedRoute);
  }
});

test('foreign model UIDs cannot be injected through either local routes or Fusion maps', () => {
  const injected = structuredClone(catalog), leadUid = Object.keys(injected.routes)[0];
  injected.models.push({ uid: 'native-forbidden' }, { uid: 'fusion-native-forbidden' });
  injected.routes['native-forbidden'] = { uid: 'native-forbidden', providerId: 'test', model: 'forbidden' };
  injected.fusions['fusion-native-forbidden'] = { leadUid, sidekickUid: 'swe-2-max', sidekickNative: true };
  const values = choices(apply(fixture(), proto, injected));
  assert.ok(!values.includes('native-forbidden'));
  assert.ok(!values.includes('fusion-native-forbidden'));
});

test('own Fusion UIDs cannot borrow non-own route registrations for Lead or CPA Sidekick', () => {
  const injected = structuredClone(catalog), leadUid = Object.keys(injected.routes)[0];
  injected.routes['native-forbidden'] = { uid: 'native-forbidden', providerId: 'test', model: 'forbidden' };
  injected.models.push({ uid: 'fusion-dfbyok-foreign-lead' }, { uid: 'fusion-dfbyok-foreign-sidekick' });
  injected.fusions['fusion-dfbyok-foreign-lead'] = { leadUid: 'native-forbidden', sidekickUid: leadUid, sidekickNative: false };
  injected.fusions['fusion-dfbyok-foreign-sidekick'] = { leadUid, sidekickUid: 'native-forbidden', sidekickNative: false };
  const values = choices(apply(fixture(), proto, injected));
  assert.ok(!values.includes('fusion-dfbyok-foreign-lead'));
  assert.ok(!values.includes('fusion-dfbyok-foreign-sidekick'));
});

test('missing or empty choices remain unrestricted, including empty response messages', () => {
  for (const input of [Buffer.alloc(0), v(1, 1), s(31, 'unrelated')]) assert.equal(apply(input), input);
  for (const input of [{}, { allowedModelUids: [] }, { allowed_model_uids: [], other: false }]) {
    assert.equal(apply(input, json), input);
  }
});

test('malformed protobuf returns the original buffer rather than partial rewritten settings', () => {
  for (const input of [Buffer.from([0x3a, 0xff]), v(7, 1), concat(s(7, 'native-gpt'), v(7, 2)),
    concat(s(7, 'native-gpt'), Buffer.from([0xff]))]) assert.equal(apply(input), input);
});

test('invalid JSON choices and unsupported response values pass through unchanged', () => {
  for (const input of [null, undefined, false, 42, 'invalid', [], { allowedModelUids: null },
    { allowedModelUids: 'native-gpt' }, { allowedModelUids: {} }, { allowed_model_uids: ['native-gpt', 1] }]) {
    assert.equal(apply(input, json), input);
  }
});

test('invalid catalog structures cannot partially change team settings', () => {
  const input = fixture();
  for (const value of [undefined, {}, { models: [] }, { models: [{ uid: 'dfbyok-invalid' }] },
    { models: [{ uid: 'fusion-dfbyok-invalid' }], routes: {}, fusions: null }]) {
    assert.equal(augmentCatalog(input, { rpc: RPC, format: proto, catalog: value }), input);
  }
});

test('protobuf refresh is idempotent and removes stale own choices while preserving native ordering', () => {
  const input = concat(s(7, 'dfbyok-removed'), fixture(), s(7, catalog.models[0].uid), s(7, 'fusion-dfbyok-removed'));
  const output = apply(input);
  assert.deepEqual(choices(output), [...choices(fixture()), ...catalog.models.map(model => model.uid)]);
  assert.deepEqual(apply(output), output);
  assert.deepEqual(otherFields(output), otherFields(input));
});

for (const key of ['allowedModelUids', 'allowed_model_uids']) {
  test(`JSON stale own entries are removed from ${key} during catalog refresh`, () => {
    const input = { [key]: ['dfbyok-removed', 'native-gpt', 'fusion-dfbyok-removed', catalog.models[0].uid] };
    const output = apply(input, json);
    assert.deepEqual(output[key], ['native-gpt', ...catalog.models.filter(model =>
      catalog.routes[model.uid] || !catalog.fusions[model.uid].sidekickNative).map(model => model.uid)]);
    assert.deepEqual(apply(output, json), output);
  });
}

for (const format of [proto, json]) {
  test(`mirrorNativeAllowlist appends observed native uids to the allowlist (${format.json ? 'JSON' : 'protobuf'})`, () => {
    const mirroredCatalog = { ...catalog, mirrorNativeAllowlist: true, nativeUids: ['native-a', 'native-b'] };
    const input = format.json ? { allowedModelUids: ['native-gpt', 'swe-2-max'], opaque: { quota: 37 } } : fixture();
    const output = apply(input, format, mirroredCatalog);
    const values = format.json ? output.allowedModelUids : choices(output);
    const retained = format.json ? ['native-gpt', 'swe-2-max'] : ['native-gpt', 'swe-2-max', 'native-gpt'];
    // Mirrored uids land between the retained native entries and the own
    // additions so a second pass retains them in place (idempotency).
    assert.deepEqual(values.slice(0, retained.length), retained);
    assert.deepEqual(values.slice(retained.length, retained.length + 2), ['native-a', 'native-b']);
    assert.deepEqual(values.slice(retained.length + 2).filter(uid => own(uid)), values.slice(retained.length + 2));
    if (!format.json) assert.deepEqual(otherFields(output), otherFields(input));
    else assert.equal(output.opaque.quota, 37);
  });

  test(`mirrorNativeAllowlist stays off without the flag (${format.json ? 'JSON' : 'protobuf'})`, () => {
    for (const variant of [{ ...catalog, nativeUids: ['native-a', 'native-b'] },
      { ...catalog, mirrorNativeAllowlist: false, nativeUids: ['native-a', 'native-b'] }]) {
      const input = format.json ? { allowedModelUids: ['native-gpt', 'swe-2-max'] } : fixture();
      assert.deepEqual(apply(input, format, variant), apply(input, format));
    }
  });

  test(`mirrorNativeAllowlist rewrite is idempotent (${format.json ? 'JSON' : 'protobuf'})`, () => {
    const mirroredCatalog = { ...catalog, mirrorNativeAllowlist: true, nativeUids: ['native-a', 'native-b'] };
    const input = format.json ? { allowedModelUids: ['native-gpt', 'swe-2-max'] } : fixture();
    const output = apply(input, format, mirroredCatalog);
    assert.deepEqual(apply(output, format, mirroredCatalog), output);
  });
}

test('mirrorNativeAllowlist never injects own uids and dedupes entries already allowed', () => {
  const mirroredCatalog = { ...catalog, mirrorNativeAllowlist: true,
    nativeUids: ['native-a', 'dfbyok-foreign', 'fusion-dfbyok-foreign', 'swe-2-max', ''] };
  const values = choices(apply(fixture(), proto, mirroredCatalog));
  const baseline = choices(apply(fixture(), proto));
  assert.deepEqual(values, [...baseline.slice(0, 3), 'native-a', ...baseline.slice(3)]);
  assert.ok(!values.includes('dfbyok-foreign'));
  assert.ok(!values.includes('fusion-dfbyok-foreign'));
  assert.equal(values.filter(uid => uid === 'swe-2-max').length, 1);
});

test('buildCatalog reports the unfiltered observed native uid set and the mirror flag', () => {
  const natives = [
    { uid: 'native-a' }, { uid: 'native-a' }, { uid: 'native-b' }, { uid: 'native-hidden' },
    { uid: 'dfbyok-own-1' }, { uid: 'fusion-dfbyok-own-1' }, { uid: 42 }, { label: 'no uid' },
  ];
  const built = buildCatalog({ providers: [], hiddenNativeModelUids: ['native-hidden'] }, natives);
  assert.deepEqual(built.nativeUids, ['native-a', 'native-b']);
  assert.equal(built.mirrorNativeAllowlist, false);
  assert.equal(buildCatalog({ providers: [], mirrorNativeAllowlist: true }, natives).mirrorNativeAllowlist, true);
  assert.equal(buildCatalog({ enabled: false }, natives).mirrorNativeAllowlist, false);
  assert.deepEqual(buildCatalog({ enabled: false }, natives).nativeUids, []);
});

test('only the exact SeatManagement GetCliTeamSettings RPC is changed', () => {
  const input = fixture();
  for (const rpc of ['GetCliTeamSettings', '/exa.api_server_pb.ApiServerService/GetCliTeamSettings',
    '/exa.seat_management_pb.SeatManagementService/SetCliTeamSettings', RPC + 'Extra', RPC + '?test=1',
    'https://official.invalid' + RPC, { path: RPC }]) {
    assert.equal(apply(input, proto, catalog, rpc), input);
  }
});

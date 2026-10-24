'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { buildCatalog, augmentCatalog, collectNativeModels, staleFusionUids } = require('../src/catalog.cjs');
const { fields, str, num, s, v, m } = require('../src/protocol/wire.cjs');
const { cat, proto, json, lsStatus, seatStatus, config, OBSERVED_SWE, catalog, getNested, configs, statusFixture, dimEntry, fam } = require('./helpers/catalog-fixtures.cjs');

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

test('collectNativeModels reads the bare UserStatus shape exactly like the envelope', () => {
  // The auth hook receives the bare UserStatus message (model list at field 33
  // of the payload itself); the bridge sees the f1→f33 envelope. Both must
  // yield the same observations, and ambiguous payloads must yield none.
  const entries = cat(
    m(1, cat(s(1, 'Official SWE'), s(22, 'swe-2-max'), m(23, cat(s(20, 'swe-1p6'))))),
    m(1, cat(s(1, 'Router'), s(22, 'swe-router'), m(23, cat(s(20, 'swe-1p6'), v(25, 1))))));
  const bare = cat(v(1, 1), m(33, entries));
  const envelope = m(1, m(33, entries));
  const expected = [
    { uid: 'swe-2-max', label: 'Official SWE', disabled: false, harnessUids: ['swe-1p6'], isModelRouter: false, sources: ['entitlement'] },
    { uid: 'swe-router', label: 'Router', disabled: false, harnessUids: ['swe-1p6'], isModelRouter: true, sources: ['entitlement'] }];
  assert.deepEqual(collectNativeModels(bare, { rpc: lsStatus, format: proto }), expected);
  assert.deepEqual(collectNativeModels(envelope, { rpc: lsStatus, format: proto }), expected,
    'envelope and bare shapes are equivalent inputs');
  for (const malformed of [
    cat(m(33, entries), m(33, entries)),                // duplicated top-level f33
    m(33, s(1, 'not-an-entry-list')),                   // f33 whose value is not a list
    cat(v(1, 1), Buffer.from('dfbyok-marker-only')),    // no f33 at all
  ]) {
    assert.deepEqual(collectNativeModels(malformed, { rpc: lsStatus, format: proto }), [],
      'an ambiguous or list-less payload is not a reliable status');
  }
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

test('sanitized real catalog entries yield canonical orders and exact harnesses through proto observation', () => {
  const fixture = JSON.parse(fs.readFileSync(__dirname + '/fixtures/real-picker.json', 'utf8'));
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
  const { refreshStaleCliCaches } = require('../src/runtime/host/cli-cache.cjs');
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cli-cache-staleprobe-'));
  const name = 'model_configs_v5.bbbbbbbbbbbbbbbb.bin';
  const payload = m(1, cat(s(1, 'dfbyok-new-uid'), s(22, 'dfbyok-new-uid'))).toString('base64');
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

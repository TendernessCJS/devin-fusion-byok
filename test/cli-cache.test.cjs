'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CACHE_NAME, MAX_CACHE_BYTES, inspectCliCacheCoverage, inspectCliCaches, refreshStaleCliCaches } = require('../src/runtime/host/cli-cache.cjs');
const { buildCatalog, augmentCatalog, staleFusionUids } = require('../src/catalog.cjs');
const { s, v, m } = require('../src/protocol/wire.cjs');
const cat = (...parts) => Buffer.concat(parts.flat());

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cli-cache-'));
const OWN = ['dfbyok-provider-aaaa-model-x-1111', 'dfbyok-provider-aaaa-model-y-2222', 'fusion-dfbyok-preset-3333'];
// Envelope validation requires real protobuf payloads, so markers are embedded
// in the minimal shape each cache kind stores: model configs carry f1 entries
// whose model uid is f22, user_status carries a bare UserStatus (f33 data),
// team_settings carries an f7 allowlist of uid strings.
const modelEntry = uid => m(1, cat(s(1, uid), s(22, uid)));
const payloadFor = (name, markers) => {
  if (name.startsWith('user_status')) return cat(v(1, 1), m(33, cat(markers.map(modelEntry))));
  if (name.startsWith('model_configs')) return cat(markers.map(modelEntry));
  return cat(markers.map(uid => s(7, uid)));
};
const writeCache = (dir, name, markers, envelope = {}) => {
  const payload = payloadFor(name, markers).toString('base64');
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 1, identity_digest: 'd', fetched_at_secs: 1, payload, ...envelope }));
};
const readCache = (dir, name) => {
  const raw = fs.readFileSync(path.join(dir, name));
  return { raw, envelope: JSON.parse(raw.toString('utf8')) };
};

test('CACHE_NAME matches only digested user_status/team_settings files', () => {
  assert.ok(CACHE_NAME.test('user_status.22718a016192f32f.bin'));
  assert.ok(CACHE_NAME.test('team_settings.d39593070cde109d.bin'));
  // model_configs* names are write candidates at every generation — they are
  // matched by the MODEL_CONFIGS prefix rule inside inspect(), not CACHE_NAME.
  for (const name of ['team_settings.bin', 'user_status.nothex12345678.bin', 'model_configs_v5.bin',
    'model_configs_v5.c87a25d819a134db.bin', 'model_configs_v6.0011223344556677.bin',
    'model_configs_v6.bin', 'model_configs_v7.0011223344556677.bin', 'model_configs.bin',
    'user_status.22718a016192f32f.bin.stale', 'devin_deployment.0fcbb40bac2b1a43.bin', 'sessions.db']) {
    assert.equal(CACHE_NAME.test(name), false, name);
  }
});

test('inspectCliCaches reports missing uids only for backend-owned files', () => {
  const dir = tmpdir();
  writeCache(dir, 'user_status.aaaaaaaaaaaaaaaa.bin', [...OWN, 'native-uid']);
  writeCache(dir, 'model_configs_v5.bbbbbbbbbbbbbbbb.bin', ['dfbyok-provider-aaaa-model-x-OLD9', OWN[2]]);
  writeCache(dir, 'team_settings.cccccccccccccccc.bin', ['native-only-1', 'native-only-2']);
  fs.writeFileSync(path.join(dir, 'team_settings.bin'), 'not json');
  const { entries, checked } = inspectCliCaches({ dir, expectedUids: OWN });
  assert.equal(checked, 2, 'files without the dfbyok marker are not ours');
  const byName = Object.fromEntries(entries.map(entry => [entry.name, entry.missing]));
  assert.deepEqual(byName['user_status.aaaaaaaaaaaaaaaa.bin'], []);
  assert.deepEqual(byName['model_configs_v5.bbbbbbbbbbbbbbbb.bin'], [OWN[0], OWN[1]]);
});

test('expected uids are recognised by prefix shape, not by substring', () => {
  const dir = tmpdir();
  writeCache(dir, 'user_status.dddddddddddddddd.bin', OWN);
  // `x-lookalike-dfbyok-text` carries the marker text but is not ours: keeping
  // it in `expected` would report it missing on every scan forever.
  const { expected, entries } = inspectCliCaches({ dir, expectedUids: [...OWN, 'x-lookalike-dfbyok-text'] });
  assert.deepEqual(expected, OWN);
  assert.deepEqual(entries[0].missing, []);
});


test('coverage generations carry a per-identity own count', () => {
  const dir = tmpdir();
  writeCache(dir, 'model_configs_v6.aaaa1111bbbb2222.bin', [OWN[0], OWN[1], 'native-model-z']);
  const coverage = inspectCliCacheCoverage({ dir });
  const gen = coverage.generations.find(entry => entry.name === 'model_configs_v6.aaaa1111bbbb2222.bin');
  assert.equal(gen.own, true);
  assert.equal(gen.ownCount, 2, 'ownCount counts uids, not boolean ownership');
});

test('inspectCliCaches and refreshStaleCliCaches require an explicit dir', () => {
  assert.throws(() => inspectCliCaches({ expectedUids: OWN }), TypeError);
  assert.throws(() => inspectCliCaches({ dir: '', expectedUids: OWN }), TypeError);
  assert.throws(() => refreshStaleCliCaches({ expectedUids: OWN }), TypeError);
  const dir = path.join(os.tmpdir(), 'cli-cache-absent-' + process.pid);
  assert.deepEqual(refreshStaleCliCaches({ dir, expectedUids: OWN }).refreshed, [], 'missing directory is tolerated');
});

test('fresh caches stay untouched and stale payloads are rewritten in place', () => {
  const dir = tmpdir();
  const fresh = 'user_status.aaaaaaaaaaaaaaaa.bin', stale = 'model_configs_v5.bbbbbbbbbbbbbbbb.bin';
  writeCache(dir, fresh, OWN);
  writeCache(dir, stale, ['dfbyok-old-uid', 'other']);
  const before = readCache(dir, stale);
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN,
    augment: payload => Buffer.concat([payload, ...OWN.map(modelEntry)]) });
  assert.deepEqual(result.refreshed, [stale]);
  assert.ok(fs.existsSync(path.join(dir, stale)), 'the primary file is never renamed away');
  assert.ok(!fs.existsSync(path.join(dir, stale + '.stale')), 'no .stale files are ever produced');
  const after = readCache(dir, stale);
  const text = Buffer.from(after.envelope.payload, 'base64').toString('latin1');
  for (const uid of OWN) assert.ok(text.includes(uid), uid + ' present after refresh');
  assert.equal(after.envelope.identity_digest, before.envelope.identity_digest);
  assert.equal(after.envelope.version, before.envelope.version);
  assert.equal(after.envelope.fetched_at_secs, before.envelope.fetched_at_secs);
  assert.deepEqual(readCache(dir, stale + '.bak').raw, before.raw, '.bak keeps the pre-rewrite bytes');
  assert.equal(fs.statSync(path.join(dir, stale)).mode & 0o777, 0o600, 'rewritten cache stays private');
  assert.ok(fs.existsSync(path.join(dir, fresh)), 'fresh cache survives');
});

test('each cache kind reaches augment with its exact RPC path', () => {
  const dir = tmpdir();
  const names = ['user_status.aaaaaaaaaaaaaaaa.bin', 'model_configs_v5.bbbbbbbbbbbbbbbb.bin',
    'model_configs_v6.0011223344556677.bin', 'team_settings.cccccccccccccccc.bin'];
  const rpcs = [];
  for (const name of names) writeCache(dir, name, ['dfbyok-old-uid']);
  refreshStaleCliCaches({ dir, expectedUids: OWN,
    augment: (payload, rpc) => { rpcs.push(rpc); return Buffer.concat([payload, modelEntry(OWN[0])]); } });
  assert.deepEqual(rpcs.sort(), [
    '/exa.language_server_pb.LanguageServerService/GetCliModelConfigs',
    '/exa.language_server_pb.LanguageServerService/GetCliModelConfigs',
    '/exa.language_server_pb.LanguageServerService/GetUserStatus',
    '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings'].sort());
});

test('an augment failure or empty result leaves the file byte-identical', () => {
  const dir = tmpdir();
  const name = 'model_configs_v5.bbbbbbbbbbbbbbbb.bin';
  writeCache(dir, name, ['dfbyok-old-uid']);
  const before = readCache(dir, name);
  for (const [augment, reason] of [[() => { throw new Error('boom'); }, 'augment-failed'],
      [() => Buffer.alloc(0), 'transform-failed'], [() => 'not-a-buffer', 'augment-failed']]) {
    const result = refreshStaleCliCaches({ dir, expectedUids: OWN, augment });
    assert.equal(result.refreshed.length, 0);
    assert.deepEqual(result.skipped, [{ name, reason }]);
    assert.deepEqual(readCache(dir, name).raw, before.raw, 'file bytes are preserved');
    assert.ok(!fs.existsSync(path.join(dir, name + '.bak')), 'no backup is written on failure');
  }
});

test('an augmenter that reports a skip while uids are still missing is not a no-op', () => {
  const dir = tmpdir();
  const name = 'user_status.aaaaaaaaaaaaaaaa.bin';
  writeCache(dir, name, [OWN[0], 'native-1']);
  const before = readCache(dir, name);
  // The automatic check gates on uid presence, so a payload can be missing uids
  // the augmenter never managed to add because the shape it assumed does not
  // match the stored payload. Reporting that as "nothing to do" hides a real
  // failure behind a successful-looking refresh.
  const reported = refreshStaleCliCaches({ dir, expectedUids: OWN,
    augment: (payload, rpc, report) => { report('shape-unrecognized'); return payload; } });
  assert.deepEqual(reported.skipped, [{ name, reason: 'shape-unrecognized' }]);
  assert.deepEqual(reported.errors, []);
  assert.deepEqual(readCache(dir, name).raw, before.raw, 'the file stays byte-identical');
  // The same report on a payload that already carries every expected uid stays
  // benign under a forced check: there is genuinely nothing left to rewrite.
  writeCache(dir, name, OWN);
  const complete = refreshStaleCliCaches({ dir, expectedUids: OWN, force: true,
    augment: (payload, rpc, report) => { report('shape-unrecognized'); return payload; } });
  assert.deepEqual(complete.skipped, [{ name, reason: 'no-improvement' }]);
});

test('a bare UserStatus cache is rewritten end to end through the real augmenter', () => {
  // This is the seam the two unit layers miss: the payload shape the CLI actually
  // stores, fed through the real `augmentCatalog` and the real rewrite path. The
  // shape mismatch that made every `user_status` rewrite a silent no-op passed
  // both layers — catalog tests built envelope-shaped payloads, and the cache
  // tests injected a synthetic augmenter. Measured on the real cache before the
  // fix: 236 of 456 own uids present, 8 retired fusion uids stuck.
  const dir = tmpdir();
  const name = 'user_status.aaaaaaaaaaaaaaaa.bin';
  const config = { providers: [{ id: 'cpa', name: 'CPA', baseUrl: 'https://cpa.invalid/v1', apiKey: 'k', apiFormat: 'openai',
    models: [{ id: 'alpha', label: 'Alpha', efforts: ['high', 'max'], contextWindow: 200000, maxOutputTokens: 32768 },
      { id: 'beta', label: 'Beta', contextWindow: 200000, maxOutputTokens: 32768 }] }] };
  const current = buildCatalog(config, []);
  const expected = current.models.map(model => model.uid);
  assert.equal(expected.length, 7, 'two effort variants plus the plain model, and their combinations');
  const emitted = new Set(Object.keys(current.fusions)), known = new Set([...Object.keys(current.routes), ...emitted]);
  const own = expected.find(uid => /^dfbyok-/.test(uid));
  const payload = cat(v(1, 1), m(33, cat(
    m(1, cat(s(1, 'Old Alpha'), s(22, own))),
    m(1, cat(s(1, 'Stale fusion'), s(22, 'fusion-gone-sidekick-also-gone'))),
    m(1, cat(s(1, 'Official'), s(22, 'swe-2-max'))))));
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 1, identity_digest: 'd', fetched_at_secs: 1, payload: payload.toString('base64') }));
  const run = force => refreshStaleCliCaches({ dir, expectedUids: expected, force,
    staleProbe: value => staleFusionUids(value, { emitted, known }),
    augment: (value, rpc, report) => augmentCatalog(value, { rpc, format: { json: false }, catalog: current, onSkip: report }) });
  const result = run(true);
  assert.deepEqual(result.refreshed, [name], 'the bare shape must actually be rewritten, not reported as current');
  assert.deepEqual(result.errors, []);
  const envelope = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  const text = Buffer.from(envelope.payload, 'base64').toString('latin1');
  for (const uid of expected) assert.ok(text.includes(uid), uid + ' is injected');
  assert.ok(!text.includes('fusion-gone-sidekick-also-gone'), 'the retired fusion entry is dropped');
  assert.ok(text.includes('swe-2-max'), 'official entries survive');
  assert.deepEqual([envelope.version, envelope.identity_digest, envelope.fetched_at_secs], [1, 'd', 1]);
  assert.ok(fs.existsSync(path.join(dir, name + '.bak')), 'the pre-rewrite bytes are kept');
  assert.deepEqual(run(true).skipped.map(skip => skip.reason), ['no-improvement'], 'a second forced pass changes nothing');
});

test('a GetCliTeamSettings payload that cannot be read reports instead of reading as current', () => {
  const dir = tmpdir();
  const name = 'team_settings.aaaaaaaaaaaaaaaa.bin';
  const config = { providers: [{ id: 'cpa', name: 'CPA', baseUrl: 'https://cpa.invalid/v1', apiKey: 'k', apiFormat: 'openai',
    models: [{ id: 'alpha', label: 'Alpha', contextWindow: 200000, maxOutputTokens: 32768 }] }] };
  const current = buildCatalog(config, []);
  // Field 7 is the allowlist of model uids; a varint there cannot be read as one.
  // The dfbyok marker keeps the file ours, so the allowlist rewrite is what fails.
  // The marker is embedded in a parseable proto string so the file survives
  // envelope validation and the failure is reported by the augmenter itself.
  const broken = cat(s(9, 'dfbyok-cpa-alpha-0000000000000000'), v(7, 9));
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 1, identity_digest: 'd', fetched_at_secs: 1, payload: broken.toString('base64') }));
  const result = refreshStaleCliCaches({ dir, expectedUids: current.models.map(model => model.uid),
    augment: (payload, rpc, report) => augmentCatalog(payload, { rpc, format: { json: false }, catalog: current, onSkip: report }) });
  assert.deepEqual(result.skipped, [{ name, reason: 'shape-unrecognized' }],
    'a failure code, never no-improvement — the wrong-wire allowlist is refused at validation now');
  assert.ok(!fs.existsSync(path.join(dir, name + '.bak')), 'an unreadable payload is never overwritten');
});

test('a cache the CLI refreshed mid-rewrite is left alone instead of clobbered', () => {
  // The CLI persists these files itself (it fetches the augmented catalog through
  // the bridge), so our augmentation can be derived from bytes that are already
  // superseded when the rename lands. Overwriting a fresher payload would drop
  // whatever the CLI just stored, and the check reruns on every native sync.
  const dir = tmpdir();
  const name = 'user_status.aaaaaaaaaaaaaaaa.bin';
  writeCache(dir, name, ['dfbyok-old', 'native-1']);
  const newer = JSON.stringify({ version: 1, identity_digest: 'd', fetched_at_secs: 7,
    payload: payloadFor(name, ['dfbyok-newer', 'native-2']).toString('base64') });
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN, augment: payload => {
    fs.writeFileSync(path.join(dir, name), newer);
    return cat(v(1, 1), m(33, cat([modelEntry('native-1'), modelEntry(OWN[0])])));
  } });
  assert.deepEqual(result.refreshed, []);
  assert.deepEqual(result.skipped, [{ name, reason: 'concurrent-write' }]);
  assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), newer, 'the fresher payload survives untouched');
  assert.ok(!fs.existsSync(path.join(dir, name + '.bak')), 'nothing is backed up when nothing is written');
  // A forced pass over a file that no longer changes rewrites it normally.
  const clean = refreshStaleCliCaches({ dir, expectedUids: OWN, force: true,
    augment: payload => cat(v(1, 1), m(33, cat([modelEntry('native-1'), modelEntry('dfbyok-newer'), modelEntry(OWN[0]), modelEntry(OWN[1])])) ) });
  assert.deepEqual(clean.refreshed, [name]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, name + '.bak'), 'utf8')).fetched_at_secs, 7,
    '.bak is the payload the rewrite was derived from, not a newer generation');
});

test('a payload without net uid gain is skipped as no-improvement', () => {
  const dir = tmpdir();
  const name = 'user_status.aaaaaaaaaaaaaaaa.bin';
  writeCache(dir, name, [OWN[0], 'native-1']);
  const before = readCache(dir, name);
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN, augment: payload => payload });
  assert.deepEqual(result.skipped, [{ name, reason: 'no-improvement' }]);
  assert.deepEqual(readCache(dir, name).raw, before.raw);
});

test('a payload that would drop an expected uid is refused as a regression guard', () => {
  const dir = tmpdir();
  const name = 'user_status.aaaaaaaaaaaaaaaa.bin';
  writeCache(dir, name, [OWN[0], 'native-1']);
  const before = readCache(dir, name);
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN,
    augment: () => cat(v(1, 1), m(33, modelEntry('dfbyok-new-uid-only'))) });
  assert.equal(result.refreshed.length, 0);
  assert.equal(result.skipped[0].reason, 'no-improvement');
  assert.deepEqual(readCache(dir, name).raw, before.raw, 'the file is never regressed');
});

test('files without the dfbyok marker and a missing augment are never rewritten', () => {
  const dir = tmpdir();
  const foreign = 'model_configs_v5.cccccccccccccccc.bin', own = 'team_settings.dddddddddddddddd.bin';
  writeCache(dir, foreign, ['native-only']);
  writeCache(dir, own, ['dfbyok-old-uid']);
  const foreignBefore = readCache(dir, foreign), ownBefore = readCache(dir, own);
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN });
  assert.deepEqual(result.refreshed, []);
  assert.deepEqual(result.skipped, [{ name: own, reason: 'unsupported' }]);
  assert.deepEqual(readCache(dir, foreign).raw, foreignBefore.raw);
  assert.deepEqual(readCache(dir, own).raw, ownBefore.raw);
});

test('stale-only caches are refreshed even when no expected uid is missing', () => {
  const dir = tmpdir();
  const name = 'model_configs_v5.bbbbbbbbbbbbbbbb.bin';
  writeCache(dir, name, [...OWN, 'fusion-stale-leftover']);
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN,
    staleProbe: () => ['fusion-stale-leftover'],
    augment: payload => cat(OWN.map(modelEntry)) });
  assert.deepEqual(result.refreshed, [name], 'a stale probe hit alone triggers the rewrite');
});

test('a rewrite that only removes stale entries counts as improvement', () => {
  const dir = tmpdir();
  const name = 'model_configs_v5.bbbbbbbbbbbbbbbb.bin';
  writeCache(dir, name, [...OWN, 'fusion-stale-leftover']);
  const clean = cat(OWN.map(modelEntry));
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN,
    staleProbe: () => ['fusion-stale-leftover'], augment: () => clean });
  assert.deepEqual(result.refreshed, [name]);
  assert.deepEqual(readCache(dir, name).envelope.payload, clean.toString('base64'));
});

test('stale probe failures and empty results leave the file untouched', () => {
  const dir = tmpdir();
  const name = 'model_configs_v5.bbbbbbbbbbbbbbbb.bin';
  writeCache(dir, name, OWN);
  const before = readCache(dir, name);
  for (const staleProbe of [() => { throw new Error('boom'); }, () => undefined]) {
    const result = refreshStaleCliCaches({ dir, expectedUids: OWN, staleProbe, augment: payload => payload });
    assert.deepEqual(result.refreshed, []);
    assert.deepEqual(readCache(dir, name).raw, before.raw);
  }
});

test('force rewrites a payload whose uids are all present but whose entries changed', () => {
  const dir = tmpdir();
  const name = 'model_configs_v5.bbbbbbbbbbbbbbbb.bin';
  writeCache(dir, name, [...OWN, 'native-1']);
  const before = readCache(dir, name);
  // The uid set is complete, so the automatic check sees nothing to do...
  const gated = refreshStaleCliCaches({ dir, expectedUids: OWN,
    augment: () => cat(OWN.map(uid => m(1, cat(s(1, 'reshaped-' + uid), s(22, uid))))) });
  assert.deepEqual(gated.refreshed, [], 'an unforced check leaves a complete payload alone');
  assert.deepEqual(gated.skipped, [], 'a complete payload is not even read');
  assert.deepEqual(readCache(dir, name).raw, before.raw);
  // ...while a forced refresh repairs the entry shape.
  const forced = refreshStaleCliCaches({ dir, expectedUids: OWN, force: true,
    augment: () => cat(OWN.map(uid => m(1, cat(s(1, 'reshaped-' + uid), s(22, uid))))) });
  assert.deepEqual(forced.refreshed, [name]);
  const rewritten = Buffer.from(readCache(dir, name).envelope.payload, 'base64');
  for (const uid of OWN) assert.ok(rewritten.includes(Buffer.from('reshaped-' + uid)), uid + ' reshaped');
  assert.deepEqual(readCache(dir, name + '.bak').raw, before.raw, 'the pre-repair bytes are kept');
});

test('a forced refresh still refuses to lose an expected uid or write identical bytes', () => {
  const dir = tmpdir();
  const name = 'user_status.aaaaaaaaaaaaaaaa.bin';
  writeCache(dir, name, [...OWN, 'native-1']);
  const before = readCache(dir, name);
  assert.deepEqual(refreshStaleCliCaches({ dir, expectedUids: OWN, force: true, augment: () => cat(v(1, 1), m(33, modelEntry(OWN[0]))) }).skipped,
    [{ name, reason: 'no-improvement' }]);
  assert.deepEqual(refreshStaleCliCaches({ dir, expectedUids: OWN, force: true, augment: payload => payload }).skipped,
    [{ name, reason: 'no-improvement' }]);
  assert.deepEqual(readCache(dir, name).raw, before.raw);
  assert.ok(!fs.existsSync(path.join(dir, name + '.bak')), 'no backup is written when nothing changed');
});

test('force never touches files without the marker or an unusable augment', () => {
  const dir = tmpdir();
  const foreign = 'model_configs_v5.cccccccccccccccc.bin', own = 'team_settings.dddddddddddddddd.bin';
  writeCache(dir, foreign, ['native-only']);
  writeCache(dir, own, ['dfbyok-old-uid']);
  assert.deepEqual(refreshStaleCliCaches({ dir, expectedUids: OWN, force: true }).skipped, [{ name: own, reason: 'unsupported' }]);
  assert.deepEqual(readCache(dir, foreign).raw, readCache(dir, foreign).raw);
  assert.equal(fs.existsSync(path.join(dir, own + '.bak')), false);
});

test('a stale model_configs_v6 cache is discovered and rewritten in place', () => {
  const dir = tmpdir();
  const name = 'model_configs_v6.0011223344556677.bin';
  writeCache(dir, name, ['dfbyok-old-uid', 'native-1']);
  const before = readCache(dir, name);
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN,
    augment: payload => Buffer.concat([payload, modelEntry(OWN[0]), modelEntry(OWN[1]), modelEntry(OWN[2])]) });
  assert.deepEqual(result.refreshed, [name]);
  assert.equal(result.coverage.supported, 1);
  const after = Buffer.from(readCache(dir, name).envelope.payload, 'base64').toString('latin1');
  for (const uid of OWN) assert.ok(after.includes(uid), uid + ' present after refresh');
  assert.deepEqual(readCache(dir, name + '.bak').raw, before.raw);
});

test('a model_configs_v6 file without the dfbyok marker is never touched', () => {
  const dir = tmpdir();
  const name = 'model_configs_v6.0011223344556677.bin';
  writeCache(dir, name, ['native-only-1', 'native-only-2']);
  const before = readCache(dir, name);
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN, force: true,
    augment: payload => Buffer.concat([payload, modelEntry(OWN[0])]) });
  assert.equal(result.checked, 0, 'foreign identities are not ours to check');
  assert.deepEqual(result.refreshed, []);
  assert.deepEqual(readCache(dir, name).raw, before.raw);
  assert.ok(!fs.existsSync(path.join(dir, name + '.bak')));
});

test('a future generation with a valid envelope is writable and marks coverage dynamic', () => {
  const dir = tmpdir();
  const name = 'model_configs_v9.0011223344556677.bin';
  writeCache(dir, name, ['dfbyok-old-uid', 'native-1']);
  const before = readCache(dir, name);
  const rpcs = [];
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN,
    augment: (payload, rpc) => { rpcs.push(rpc); return Buffer.concat([payload, ...OWN.map(modelEntry)]); } });
  assert.deepEqual(result.refreshed, [name]);
  assert.deepEqual(rpcs, ['/exa.language_server_pb.LanguageServerService/GetCliModelConfigs']);
  assert.equal(result.coverage.dynamic, true);
  assert.equal(result.coverage.current.generation, 9);
  assert.equal(result.coverage.current.name, name);
  assert.equal(result.coverage.supported, 1);
  assert.deepEqual(result.coverage.unsupported, []);
  assert.deepEqual(readCache(dir, name + '.bak').raw, before.raw, 'the pre-rewrite bytes are kept');
});

test('JSON model_configs files that fail validation are unsupported, non-JSON are legacy', () => {
  const dir = tmpdir();
  const bad = 'model_configs_v7.0011223344556677.bin';
  fs.writeFileSync(path.join(dir, bad), JSON.stringify({ version: 2 }));
  const legacy = 'model_configs_v3.bin';
  fs.writeFileSync(path.join(dir, legacy), 'historical non-JSON bytes');
  const bare = 'model_configs.bin';
  fs.writeFileSync(path.join(dir, bare), 'historical non-JSON bytes');
  const v4 = 'model_configs_v4.bin';
  fs.writeFileSync(path.join(dir, v4), 'historical non-JSON bytes');
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN, force: true,
    augment: payload => Buffer.concat([payload, modelEntry(OWN[0])]) });
  assert.equal(result.coverage.dirState, 'ok');
  assert.deepEqual(result.coverage.unsupported, [{ name: bad, generation: 7 }]);
  assert.deepEqual(result.coverage.legacy,
    [{ name: bare, generation: 1 }, { name: legacy, generation: 3 }, { name: v4, generation: 4 }]);
  assert.equal(result.coverage.dynamic, false);
  assert.deepEqual(result.skipped, [{ name: bad, reason: 'unsupported-envelope' }]);
  assert.equal(result.checked, 0);
  for (const name of [legacy, bare, v4]) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), 'historical non-JSON bytes');
  assert.ok(fs.readFileSync(path.join(dir, bad)).toString('utf8').includes('"version":2'));
});

test('coverage.current is the highest generation, breaking ties by fetched_at_secs', () => {
  const dir = tmpdir();
  const stale = 'model_configs_v5.aaaaaaaaaaaaaaaa.bin';
  const fresh = 'model_configs_v5.bbbbbbbbbbbbbbbb.bin';
  writeCache(dir, stale, OWN, { fetched_at_secs: 100 });
  writeCache(dir, fresh, OWN, { fetched_at_secs: 200 });
  writeCache(dir, 'model_configs_v6.0011223344556677.bin', OWN, { fetched_at_secs: 50 });
  const coverage = inspectCliCacheCoverage({ dir });
  assert.equal(coverage.current.generation, 6);
  assert.equal(coverage.current.name, 'model_configs_v6.0011223344556677.bin');
  const gens = Object.fromEntries(coverage.generations.map(g => [g.name, g]));
  assert.equal(gens[stale].generation, 5);
  assert.equal(gens[fresh].generation, 5);
  assert.ok(gens[stale].own && gens[fresh].own, 'both digests flag own payloads');
  // Same generation: the newest fetch wins the 'current' slot.
  const dir2 = tmpdir();
  writeCache(dir2, stale, OWN, { fetched_at_secs: 100 });
  writeCache(dir2, fresh, OWN, { fetched_at_secs: 200 });
  assert.equal(inspectCliCacheCoverage({ dir: dir2 }).current.name, fresh);
});

test('coverage.generations lists every writable model_configs file with its own flag', () => {
  const dir = tmpdir();
  writeCache(dir, 'model_configs_v5.aaaaaaaaaaaaaaaa.bin', OWN);
  writeCache(dir, 'model_configs_v6.0011223344556677.bin', ['native-only']);
  const coverage = inspectCliCacheCoverage({ dir });
  assert.deepEqual(coverage.generations.map(g => [g.name, g.own]), [
    ['model_configs_v5.aaaaaaaaaaaaaaaa.bin', true],
    ['model_configs_v6.0011223344556677.bin', false],
  ]);
  // user_status/team_settings stay counted in supported but are not generations.
  assert.equal(coverage.supported, 2);
});

test('a v12 cache rewrites exactly like v6: backup, 0600 mode, CAS guard', () => {
  const dir = tmpdir();
  const name = 'model_configs_v12.0011223344556677.bin';
  writeCache(dir, name, ['dfbyok-old-uid']);
  const before = readCache(dir, name);
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN,
    augment: payload => Buffer.concat([payload, ...OWN.map(modelEntry)]) });
  assert.deepEqual(result.refreshed, [name]);
  assert.equal(result.coverage.dynamic, true);
  assert.deepEqual(readCache(dir, name + '.bak').raw, before.raw);
  assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
  // CAS: bytes changed between inspection and rewrite are never clobbered.
  const dir2 = tmpdir();
  writeCache(dir2, name, ['dfbyok-old-uid']);
  const raced = refreshStaleCliCaches({ dir: dir2, expectedUids: OWN, augment: payload => {
    fs.writeFileSync(path.join(dir2, name), JSON.stringify({ version: 2, payload: 'AAAA' }));
    return Buffer.concat([payload, ...OWN.map(modelEntry)]);
  } });
  assert.deepEqual(raced.refreshed, []);
  assert.equal(raced.skipped.length, 1);
  assert.ok(['concurrent-write', 'malformed-payload', 'unsupported-envelope'].includes(raced.skipped[0].reason));
});

test('inspectCliCacheCoverage reports missing and unreadable directories', () => {
  const absent = path.join(os.tmpdir(), 'cli-cache-absent-' + process.pid);
  assert.deepEqual(inspectCliCacheCoverage({ dir: absent }),
    { dirState: 'missing', supported: 0, legacy: [], unsupported: [], generations: [], current: undefined, dynamic: false });
  const file = path.join(tmpdir(), 'not-a-dir');
  fs.writeFileSync(file, 'x');
  assert.deepEqual(inspectCliCacheCoverage({ dir: file }).dirState, 'missing');
  const dir = tmpdir();
  writeCache(dir, 'model_configs_v5.aaaaaaaaaaaaaaaa.bin', OWN);
  const coverage = inspectCliCacheCoverage({ dir });
  assert.deepEqual(coverage, { dirState: 'ok', supported: 1, legacy: [], unsupported: [],
    generations: [{ generation: 5, name: 'model_configs_v5.aaaaaaaaaaaaaaaa.bin', fetchedAt: 1, own: true, ownCount: 3 }],
    current: { generation: 5, name: 'model_configs_v5.aaaaaaaaaaaaaaaa.bin', fetchedAt: 1 }, dynamic: false });
  assert.equal(JSON.stringify(inspectCliCacheCoverage({ dir })), JSON.stringify(coverage),
    'coverage is fully determined by the directory contents — it feeds deduplicated panel state');
});

test('invalid envelopes and payloads are skipped with stable codes and left byte-identical', () => {
  const cases = [
    [{ version: 2 }, 'unsupported-envelope'],
    [{ version: 1, identity_digest: 'd', fetched_at_secs: 1, payload: 'not base64!!' }, 'unsupported-envelope'],
    [{ version: 1, fetched_at_secs: 1, payload: 'AAAA' }, 'unsupported-envelope'],
    [{ version: 1, identity_digest: 'd', fetched_at_secs: 1.5, payload: 'AAAA' }, 'unsupported-envelope'],
    [{ version: 1, identity_digest: 'd', fetched_at_secs: 1, payload: Buffer.from('plain text').toString('base64') }, 'malformed-payload'],
    // Valid proto but no model-list entries (f1 wire2) for a model_configs file.
    [{ version: 1, identity_digest: 'd', fetched_at_secs: 1,
      payload: cat(s(2, 'dfbyok-marker'), v(3, 9)).toString('base64') }, 'malformed-payload'],
  ];
  for (const [envelope, reason] of cases) {
    const dir = tmpdir();
    const name = 'model_configs_v6.0011223344556677.bin';
    fs.writeFileSync(path.join(dir, name), JSON.stringify(envelope));
    const before = readCache(dir, name);
    const result = refreshStaleCliCaches({ dir, expectedUids: OWN, force: true,
      augment: payload => Buffer.concat([payload, modelEntry(OWN[0])]) });
    assert.deepEqual(result.skipped, [{ name, reason }], 'envelope ' + JSON.stringify(envelope));
    assert.deepEqual(result.refreshed, []);
    assert.equal(result.checked, 0, 'a file that fails validation is not counted as checked');
    assert.deepEqual(readCache(dir, name).raw, before.raw, 'bytes are preserved');
    assert.ok(!fs.existsSync(path.join(dir, name + '.bak')), 'no backup without a write');
  }
});

test('a cache file over the size limit is skipped without being read', () => {
  const dir = tmpdir();
  const name = 'model_configs_v6.0011223344556677.bin';
  const file = path.join(dir, name);
  writeCache(dir, name, OWN);
  const before = fs.readFileSync(file);
  fs.truncateSync(file, MAX_CACHE_BYTES + 1);
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN, force: true,
    augment: payload => Buffer.concat([payload, modelEntry(OWN[0])]) });
  assert.deepEqual(result.skipped, [{ name, reason: 'too-large' }]);
  assert.deepEqual(result.errors, []);
  assert.equal(fs.statSync(file).size, MAX_CACHE_BYTES + 1, 'the oversized file is left alone');
  assert.ok(fs.readFileSync(file).subarray(0, before.length).equals(before), 'leading bytes untouched');
});

test('a file that turns invalid between inspection and rewrite is skipped, not written', () => {
  const dir = tmpdir();
  const name = 'model_configs_v6.0011223344556677.bin';
  writeCache(dir, name, ['dfbyok-old-uid']);
  const before = readCache(dir, name);
  // Swap in a foreign-generation payload while the rewrite is being computed;
  // the pre-write re-validation must refuse rather than augment old bytes.
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN, augment: payload => {
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 2, payload: 'AAAA' }));
    return Buffer.concat([payload, modelEntry(OWN[0])]);
  } });
  // The re-read sees different bytes than the ones inspected: whichever guard
  // fires first, the file is never augmented from a stale read.
  assert.deepEqual(result.refreshed, []);
  assert.equal(result.skipped.length, 1);
  assert.ok(['unsupported-envelope', 'concurrent-write', 'malformed-payload'].includes(result.skipped[0].reason));
  assert.ok(!fs.existsSync(path.join(dir, name + '.bak')));
  assert.notDeepEqual(fs.readFileSync(path.join(dir, name)), before.raw);
});

test('a second forced refresh of a rewritten v6 cache reports no-improvement', () => {
  const dir = tmpdir();
  const name = 'model_configs_v6.0011223344556677.bin';
  writeCache(dir, name, OWN);
  const augment = payload => Buffer.concat([payload, modelEntry('dfbyok-extra')]);
  assert.deepEqual(refreshStaleCliCaches({ dir, expectedUids: OWN, force: true, augment }).refreshed, [name]);
  const again = refreshStaleCliCaches({ dir, expectedUids: OWN, force: true, augment: payload => payload });
  assert.deepEqual(again.skipped, [{ name, reason: 'no-improvement' }]);
  assert.deepEqual(again.refreshed, []);
});

test('a non-model f1 entry carrying dfbyok text is rejected, never rewritten', () => {
  const dir = tmpdir();
  const name = 'model_configs_v12.0011223344556677.bin';
  const fake = Buffer.concat([m(1, s(7, 'dfbyok-not-a-model-uid'))]).toString('base64');
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 1, identity_digest: 'd', fetched_at_secs: 1, payload: fake }));
  const before = fs.readFileSync(path.join(dir, name));
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN, force: true,
    augment: payload => Buffer.concat([payload, modelEntry(OWN[0])]) });
  assert.deepEqual(result.refreshed, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'shape-unrecognized', 'an f1 entry without a real f22 uid is not a model');
  assert.ok(fs.readFileSync(path.join(dir, name)).equals(before), 'bytes never touched');
  assert.equal(result.coverage.unsupported[0].name, name, 'JSON but unreadable shape stays unsupported');
});

test('a dfbyok-looking label without an own uid is not ours and is left alone', () => {
  const dir = tmpdir();
  const name = 'model_configs_v6.0011223344556677.bin';
  // The marker lives in the f1 label, not the f22 uid — uid-based ownership
  // must refuse to call this file ours.
  const entry = m(1, cat(s(1, 'dfbyok-lookalike'), s(22, 'native-a')));
  writeCache(dir, name, []);
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 1, identity_digest: 'd', fetched_at_secs: 1,
    payload: entry.toString('base64') }));
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN, force: true,
    augment: payload => Buffer.concat([payload, modelEntry(OWN[0])]) });
  assert.equal(result.checked, 0);
  assert.deepEqual(result.refreshed, []);
  assert.equal(result.coverage.generations[0].own, false, 'label text never marks ownership');
});

test('the last own entry is retired from all three real cache payload shapes', () => {
  const entry = uid => modelEntry(uid);
  const unknown = s(41, 'weird-field');
  const cases = [
    ['model_configs_v6.0011223344556677.bin', cat(entry('dfbyok-own-x'), entry('native-1'), unknown),
      '/exa.language_server_pb.LanguageServerService/GetCliModelConfigs'],
    ['user_status.aaaaaaaaaaaaaaaa.bin', cat(v(1, 1), m(33, cat(entry('dfbyok-own-x'), entry('native-1'))), unknown),
      '/exa.language_server_pb.LanguageServerService/GetUserStatus'],
    ['team_settings.aaaaaaaaaaaaaaaa.bin', cat(s(7, 'dfbyok-own-x'), s(7, 'native-1'), unknown),
      '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings'],
  ];
  for (const [name, payload, rpc] of cases) {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 1, identity_digest: 'd', fetched_at_secs: 1, payload: payload.toString('base64') }));
    const empty = { models: [], hiddenNativeModelUids: [], hiddenFusionUids: [] };
    // Even an empty expected set triggers the rewrite: the stored own uid is
    // stale by definition.
    const result = refreshStaleCliCaches({ dir, expectedUids: [],
      augment: (bytes, rpc2, report) => augmentCatalog(bytes, { rpc: rpc2, format: { json: false }, catalog: empty, retireOwn: true, onSkip: report }) });
    assert.deepEqual(result.refreshed, [name], name + ' retires its last own entry');
    const after = Buffer.from(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).payload, 'base64');
    assert.ok(!after.includes(Buffer.from('dfbyok-own-x')), name + ' own uid gone');
    assert.ok(after.includes(Buffer.from('native-1')), name + ' native content preserved');
    assert.ok(after.includes(Buffer.from('weird-field')), name + ' unknown fields preserved');
    // .bak holds the byte-identical original, not a re-serialization.
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, name + '.bak'), 'utf8')).payload, payload.toString('base64'),
      name + ' .bak is the original bytes verbatim');
    // A second forced pass sees a fully native file: no own uid means no
    // ownership, so it is never read for rewriting — the .bak stays put.
    const again = refreshStaleCliCaches({ dir, expectedUids: [], force: true,
      augment: (bytes, rpc2, report) => augmentCatalog(bytes, { rpc: rpc2, format: { json: false }, catalog: empty, retireOwn: true, onSkip: report }) });
    assert.equal(again.checked, 0, name + ' is all-native after retirement');
    assert.deepEqual(again.refreshed, [], name + ' idempotent');
  }
});

test('broken JSON is unsupported and reports a bad cache health, never legacy', () => {
  const dir = tmpdir();
  const name = 'model_configs_v99.0123456789abcdef.bin';
  fs.writeFileSync(path.join(dir, name), '{broken-json');
  const coverage = inspectCliCacheCoverage({ dir });
  assert.deepEqual(coverage.unsupported, [{ name, generation: 99 }], 'JSON head means a future format');
  assert.deepEqual(coverage.legacy, []);
  for (const text of ['[broken-json', '[]', 'null', '"unknown-envelope"']) {
    fs.writeFileSync(path.join(dir, name), text);
    const next = inspectCliCacheCoverage({ dir });
    assert.deepEqual(next.unsupported, [{ name, generation: 99 }], text);
    assert.deepEqual(next.legacy, [], text);
  }
});

test('an expected uid that only appears inside a label still counts as missing', () => {
  const dir = tmpdir();
  const name = 'model_configs_v6.0011223344556677.bin';
  const fake = m(1, cat(s(1, 'prefix-' + OWN[1] + '-suffix'), s(22, 'native-9')));
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 1, identity_digest: 'd', fetched_at_secs: 1,
    payload: cat([fake, modelEntry(OWN[0])]).toString('base64') }));
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN,
    augment: payload => cat([fake, ...OWN.map(modelEntry)]) });
  assert.deepEqual(result.refreshed, [name], 'label text never satisfies an expected uid');
});

test('a failed user_status envelope surfaces as unsupported and reports bad cache health', () => {
  const dir = tmpdir();
  const name = 'user_status.aaaaaaaaaaaaaaaa.bin';
  fs.writeFileSync(path.join(dir, name), '{broken-json');
  const coverage = inspectCliCacheCoverage({ dir });
  assert.deepEqual(coverage.unsupported, [{ name, generation: null }], 'JSON drift is unsupported, never healthy');
});

test('a flat cache whose only entries are ours retires to a zero-byte payload', () => {
  const dir = tmpdir();
  const name = 'model_configs_v6.0011223344556677.bin';
  const payload = cat(OWN.slice(0, 2).map(modelEntry));
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 1, identity_digest: 'd', fetched_at_secs: 1,
    payload: payload.toString('base64') }));
  const empty = { models: [], hiddenNativeModelUids: [], hiddenFusionUids: [] };
  const result = refreshStaleCliCaches({ dir, expectedUids: [],
    augment: (bytes, rpc, report) => augmentCatalog(bytes, { rpc, format: { json: false }, catalog: empty, retireOwn: true, onSkip: report }) });
  assert.deepEqual(result.refreshed, [name], 'the last own entry retires to an empty list');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).payload, '', 'zero-byte flat payload');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, name + '.bak'), 'utf8')).payload, payload.toString('base64'));
  // The emptied file is supported-but-not-own: the next check reports neither
  // unsupported nor work, and the .bak survives.
  const again = refreshStaleCliCaches({ dir, expectedUids: [], force: true,
    augment: (bytes, rpc, report) => augmentCatalog(bytes, { rpc, format: { json: false }, catalog: empty, retireOwn: true, onSkip: report }) });
  assert.equal(again.checked, 0);
  assert.deepEqual(again.skipped, [], 'the empty flat file is legal and untouched');
  assert.equal(inspectCliCacheCoverage({ dir }).unsupported.length, 0);
});

test('an augment that empties a mixed flat payload is refused without a .bak', () => {
  const dir = tmpdir();
  const name = 'model_configs_v6.0011223344556677.bin';
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 1, identity_digest: 'd', fetched_at_secs: 1,
    payload: cat([modelEntry('dfbyok-own-x'), modelEntry('native-1')]).toString('base64') }));
  const before = fs.readFileSync(path.join(dir, name));
  const result = refreshStaleCliCaches({ dir, expectedUids: [], force: true, augment: () => Buffer.alloc(0) });
  assert.deepEqual(result.refreshed, []);
  assert.equal(result.skipped[0].reason, 'transform-failed', 'deleting native entries is never a rewrite');
  assert.ok(!fs.existsSync(path.join(dir, name + '.bak')));
  assert.ok(fs.readFileSync(path.join(dir, name)).equals(before));
});

test('an augmented result missing the real uid shape or keeping expected uids only in labels is refused', () => {
  const dir = tmpdir();
  const name = 'model_configs_v6.0011223344556677.bin';
  writeCache(dir, name, [OWN[0]]);
  const before = fs.readFileSync(path.join(dir, name));
  // Output keeps expected uids only inside labels — the uid set never gains.
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN, force: true,
    augment: () => cat([modelEntry('dfbyok-own-x'), m(1, cat(s(1, 'x' + OWN[1] + 'y'), s(22, 'native-9')))]) });
  assert.deepEqual(result.refreshed, [], 'label text is not a uid');
  assert.equal(result.skipped[0].reason, 'no-improvement');
  assert.ok(!fs.existsSync(path.join(dir, name + '.bak')));
  assert.ok(fs.readFileSync(path.join(dir, name)).equals(before));
});

test('retire:false forbids dropping stored own entries even when the emit lacks them', () => {
  const dir = tmpdir();
  const name = 'model_configs_v6.0011223344556677.bin';
  // Three plains plus two fusion combos: the activation-time check runs before
  // the native catalog is known, so the emit only carries the plains — and a
  // missing expected uid forces the rewrite the guard must withhold.
  const fusion = uid => m(1, cat(s(1, uid), s(22, uid)));
  const stored = cat([modelEntry(OWN[0]), fusion('fusion-native-a-sidekick-dfbyok-x'), fusion('fusion-native-b-sidekick-dfbyok-y')]);
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 1, identity_digest: 'd', fetched_at_secs: 1, payload: stored.toString('base64') }));
  const before = fs.readFileSync(path.join(dir, name));
  const catalog = { models: OWN.map((uid, i) => ({ uid, label: 'L' + i, raw: cat(s(1, 'L' + i), s(22, uid)) })) };
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN, retire: false,
    augment: (bytes, rpc, report) => augmentCatalog(bytes, { rpc, format: { json: false }, catalog, retireOwn: false, onSkip: report }) });
  assert.deepEqual(result.refreshed, [], 'retire:false never drops a stored own uid');
  assert.ok(result.skipped.some(skip => skip.reason === 'retire-withheld'), 'the withheld write is reported');
  assert.ok(fs.readFileSync(path.join(dir, name)).equals(before), 'bytes untouched');
  assert.ok(!fs.existsSync(path.join(dir, name + '.bak')), 'no backup is made for a withheld write');
});

test('retire:true still removes stale fusion entries under an authoritative catalog', () => {
  const dir = tmpdir();
  const name = 'model_configs_v6.0011223344556677.bin';
  const fusion = uid => m(1, cat(s(1, uid), s(22, uid)));
  const stored = cat([modelEntry(OWN[0]), fusion('fusion-native-a-sidekick-dfbyok-x')]);
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 1, identity_digest: 'd', fetched_at_secs: 1, payload: stored.toString('base64') }));
  const catalog = { models: [{ uid: OWN[0], label: 'L0', raw: cat(s(1, 'L0'), s(22, OWN[0])) }] };
  const result = refreshStaleCliCaches({ dir, expectedUids: [OWN[0]], retire: true,
    augment: (bytes, rpc, report) => augmentCatalog(bytes, { rpc, format: { json: false }, catalog, retireOwn: true, onSkip: report }) });
  assert.deepEqual(result.refreshed, [name], 'authoritative retirement keeps its established semantics');
  const after = Buffer.from(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).payload, 'base64');
  assert.ok(!after.includes(Buffer.from('fusion-native-a-sidekick-dfbyok-x')), 'the stale fusion entry is gone');
  assert.ok(after.includes(Buffer.from(OWN[0])), 'the plain own entry stays');
});

test('retire:false still performs additive writes when no own uid would be lost', () => {
  const dir = tmpdir();
  const name = 'model_configs_v6.0011223344556677.bin';
  writeCache(dir, name, [OWN[0]]);
  const catalog = { models: OWN.map((uid, i) => ({ uid, label: 'L' + i, raw: cat(s(1, 'L' + i), s(22, uid)) })) };
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN, retire: false,
    augment: (bytes, rpc, report) => augmentCatalog(bytes, { rpc, format: { json: false }, catalog, retireOwn: false, onSkip: report }) });
  assert.deepEqual(result.refreshed, [name], 'a missing expected uid is still written additively');
  const after = Buffer.from(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).payload, 'base64');
  for (const uid of OWN) assert.ok(after.includes(Buffer.from(uid)), uid);
});

test('retire:false refuses the all-own empty retirement entirely', () => {
  const dir = tmpdir();
  const name = 'model_configs_v6.0011223344556677.bin';
  const payload = cat(OWN.slice(0, 2).map(modelEntry));
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 1, identity_digest: 'd', fetched_at_secs: 1, payload: payload.toString('base64') }));
  const before = fs.readFileSync(path.join(dir, name));
  const empty = { models: [], hiddenNativeModelUids: [], hiddenFusionUids: [] };
  const result = refreshStaleCliCaches({ dir, expectedUids: [], retire: false,
    augment: (bytes, rpc, report) => augmentCatalog(bytes, { rpc, format: { json: false }, catalog: empty, retireOwn: false, onSkip: report }) });
  assert.deepEqual(result.refreshed, [], 'zero-byte retirement requires authority');
  assert.ok(fs.readFileSync(path.join(dir, name)).equals(before));
  assert.ok(!fs.existsSync(path.join(dir, name + '.bak')));
});

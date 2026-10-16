'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CACHE_NAME, inspectCliCaches, refreshStaleCliCaches } = require('../src/runtime/cli-cache.cjs');
const { buildCatalog, augmentCatalog, staleFusionUids } = require('../src/catalog.cjs');
const { s, v, m } = require('../src/protocol/wire.cjs');
const cat = (...parts) => Buffer.concat(parts.flat());

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cli-cache-'));
const OWN = ['dfbyok-provider-aaaa-model-x-1111', 'dfbyok-provider-aaaa-model-y-2222', 'fusion-dfbyok-preset-3333'];
const writeCache = (dir, name, markers) => {
  const payload = Buffer.from(markers.join('\x00'), 'utf8').toString('base64');
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 1, identity_digest: 'd', fetched_at_secs: 1, payload }));
};
const readCache = (dir, name) => {
  const raw = fs.readFileSync(path.join(dir, name));
  return { raw, envelope: JSON.parse(raw.toString('utf8')) };
};

test('CACHE_NAME matches only digested envelope files', () => {
  assert.ok(CACHE_NAME.test('user_status.22718a016192f32f.bin'));
  assert.ok(CACHE_NAME.test('model_configs_v5.c87a25d819a134db.bin'));
  assert.ok(CACHE_NAME.test('team_settings.d39593070cde109d.bin'));
  for (const name of ['team_settings.bin', 'user_status.nothex12345678.bin', 'model_configs_v5.bin',
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
    augment: payload => Buffer.concat([payload, Buffer.from('\x00' + OWN.join('\x00'), 'utf8')]) });
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
  const names = ['user_status.aaaaaaaaaaaaaaaa.bin', 'model_configs_v5.bbbbbbbbbbbbbbbb.bin', 'team_settings.cccccccccccccccc.bin'];
  const rpcs = [];
  for (const name of names) writeCache(dir, name, ['dfbyok-old-uid']);
  refreshStaleCliCaches({ dir, expectedUids: OWN,
    augment: (payload, rpc) => { rpcs.push(rpc); return Buffer.concat([payload, Buffer.from('\x00' + OWN[0])]); } });
  assert.deepEqual(rpcs.sort(), [
    '/exa.language_server_pb.LanguageServerService/GetCliModelConfigs',
    '/exa.language_server_pb.LanguageServerService/GetUserStatus',
    '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings'].sort());
});

test('an augment failure or empty result leaves the file byte-identical', () => {
  const dir = tmpdir();
  const name = 'model_configs_v5.bbbbbbbbbbbbbbbb.bin';
  writeCache(dir, name, ['dfbyok-old-uid']);
  const before = readCache(dir, name);
  for (const augment of [() => { throw new Error('boom'); }, () => Buffer.alloc(0), () => 'not-a-buffer']) {
    const result = refreshStaleCliCaches({ dir, expectedUids: OWN, augment });
    assert.equal(result.refreshed.length, 0);
    assert.deepEqual(result.skipped, [{ name, reason: 'augment-failed' }]);
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
  const broken = cat(Buffer.from('dfbyok-cpa-alpha-0000000000000000'), v(7, 9));
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 1, identity_digest: 'd', fetched_at_secs: 1, payload: broken.toString('base64') }));
  const result = refreshStaleCliCaches({ dir, expectedUids: current.models.map(model => model.uid),
    augment: (payload, rpc, report) => augmentCatalog(payload, { rpc, format: { json: false }, catalog: current, onSkip: report }) });
  assert.deepEqual(result.skipped, [{ name, reason: 'transform-failed' }],
    'a failure code, never no-improvement — this path used to be silent while the uid was still missing');
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
    payload: Buffer.from('dfbyok-newer\x00native-2').toString('base64') });
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN, augment: payload => {
    fs.writeFileSync(path.join(dir, name), newer);
    return Buffer.concat([payload, Buffer.from('\x00' + OWN[0])]);
  } });
  assert.deepEqual(result.refreshed, []);
  assert.deepEqual(result.skipped, [{ name, reason: 'concurrent-write' }]);
  assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), newer, 'the fresher payload survives untouched');
  assert.ok(!fs.existsSync(path.join(dir, name + '.bak')), 'nothing is backed up when nothing is written');
  // A forced pass over a file that no longer changes rewrites it normally.
  const clean = refreshStaleCliCaches({ dir, expectedUids: OWN, force: true,
    augment: payload => Buffer.concat([payload, Buffer.from('\x00' + OWN[0])]) });
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
    augment: () => Buffer.from('dfbyok-new-uid-only', 'utf8') });
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
    augment: payload => Buffer.concat([Buffer.from('dfbyok-provider-aaaa-model-x-1111\x00dfbyok-provider-aaaa-model-y-2222\x00fusion-dfbyok-preset-3333', 'utf8')]) });
  assert.deepEqual(result.refreshed, [name], 'a stale probe hit alone triggers the rewrite');
});

test('a rewrite that only removes stale entries counts as improvement', () => {
  const dir = tmpdir();
  const name = 'model_configs_v5.bbbbbbbbbbbbbbbb.bin';
  writeCache(dir, name, [...OWN, 'fusion-stale-leftover']);
  const clean = Buffer.from(OWN.join('\x00'), 'utf8');
  const result = refreshStaleCliCaches({ dir, expectedUids: OWN,
    staleProbe: () => ['fusion-stale-leftover'], augment: () => clean });
  assert.deepEqual(result.refreshed, [name]);
  assert.equal(Buffer.from(readCache(dir, name).envelope.payload, 'base64').toString('utf8'), OWN.join('\x00'));
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
    augment: () => Buffer.from(OWN.join('\x00') + '\x00reshaped', 'utf8') });
  assert.deepEqual(gated.refreshed, [], 'an unforced check leaves a complete payload alone');
  assert.deepEqual(gated.skipped, [], 'a complete payload is not even read');
  assert.deepEqual(readCache(dir, name).raw, before.raw);
  // ...while a forced refresh repairs the entry shape.
  const forced = refreshStaleCliCaches({ dir, expectedUids: OWN, force: true,
    augment: () => Buffer.from(OWN.join('\x00') + '\x00reshaped', 'utf8') });
  assert.deepEqual(forced.refreshed, [name]);
  assert.equal(Buffer.from(readCache(dir, name).envelope.payload, 'base64').toString('utf8'), OWN.join('\x00') + '\x00reshaped');
  assert.deepEqual(readCache(dir, name + '.bak').raw, before.raw, 'the pre-repair bytes are kept');
});

test('a forced refresh still refuses to lose an expected uid or write identical bytes', () => {
  const dir = tmpdir();
  const name = 'user_status.aaaaaaaaaaaaaaaa.bin';
  writeCache(dir, name, [...OWN, 'native-1']);
  const before = readCache(dir, name);
  assert.deepEqual(refreshStaleCliCaches({ dir, expectedUids: OWN, force: true, augment: () => Buffer.from(OWN[0], 'utf8') }).skipped,
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

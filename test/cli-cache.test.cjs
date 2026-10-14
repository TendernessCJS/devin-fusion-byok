'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CACHE_NAME, inspectCliCaches, refreshStaleCliCaches } = require('../src/runtime/cli-cache.cjs');

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

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CACHE_NAME, inspectCliCaches, invalidateStaleCliCaches } = require('../src/runtime/cli-cache.cjs');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cli-cache-'));
const OWN = ['dfbyok-provider-aaaa-model-x-1111', 'dfbyok-provider-aaaa-model-y-2222', 'fusion-dfbyok-preset-3333'];
const writeCache = (dir, name, markers) => {
  const payload = Buffer.from(markers.join('\x00'), 'utf8').toString('base64');
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 1, identity_digest: 'd', fetched_at_secs: 1, payload }));
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

test('invalidateStaleCliCaches renames stale files aside and keeps fresh ones', () => {
  const dir = tmpdir();
  writeCache(dir, 'user_status.aaaaaaaaaaaaaaaa.bin', OWN);
  writeCache(dir, 'user_status.bbbbbbbbbbbbbbbb.bin', ['dfbyok-old-uid', 'other']);
  writeCache(dir, 'model_configs_v5.cccccccccccccccc.bin', ['native-only']);
  const result = invalidateStaleCliCaches({ dir, expectedUids: OWN });
  assert.deepEqual(result.invalidated, ['user_status.bbbbbbbbbbbbbbbb.bin']);
  assert.ok(fs.existsSync(path.join(dir, 'user_status.bbbbbbbbbbbbbbbb.bin.stale')), 'aside copy keeps the content');
  assert.ok(!fs.existsSync(path.join(dir, 'user_status.bbbbbbbbbbbbbbbb.bin')));
  assert.ok(fs.existsSync(path.join(dir, 'user_status.aaaaaaaaaaaaaaaa.bin')), 'fresh cache survives');
  assert.ok(fs.existsSync(path.join(dir, 'model_configs_v5.cccccccccccccccc.bin')), 'foreign identity survives');
});

test('invalidateStaleCliCaches tolerates a missing directory and foreign uids in expected set', () => {
  const dir = path.join(os.tmpdir(), 'cli-cache-absent-' + process.pid);
  assert.deepEqual(invalidateStaleCliCaches({ dir, expectedUids: OWN }).invalidated, []);
  const real = tmpdir();
  writeCache(real, 'user_status.aaaaaaaaaaaaaaaa.bin', OWN);
  const result = invalidateStaleCliCaches({ dir: real, expectedUids: [...OWN, 'native-uid-not-ours'] });
  assert.deepEqual(result.invalidated, [], 'native uids are filtered out of the expected set');
});

test('invalidation is idempotent across repeated runs', () => {
  const dir = tmpdir();
  writeCache(dir, 'user_status.aaaaaaaaaaaaaaaa.bin', ['dfbyok-old-uid']);
  assert.equal(invalidateStaleCliCaches({ dir, expectedUids: OWN }).invalidated.length, 1);
  assert.equal(invalidateStaleCliCaches({ dir, expectedUids: OWN }).invalidated.length, 0, 'aside file is not re-scanned');
});

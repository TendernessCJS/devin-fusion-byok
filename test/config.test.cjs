'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultConfig, admitStorage } = require('../src/config/config.cjs');

test('defaultConfig is a minimal enabled config without retired keys', () => {
  assert.deepEqual(defaultConfig(), { enabled: true, providers: [] });
  assert.ok(!Object.hasOwn(defaultConfig(), 'roleExclusions'));
  assert.ok(!Object.hasOwn(defaultConfig(), 'sidekicks'));
});

test('storage admission marks empty roots and never claims a legacy backup-only root', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-config-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const current = path.join(dir, 'current'), legacy = path.join(dir, 'legacy');
  fs.mkdirSync(current); fs.mkdirSync(legacy);
  assert.equal(admitStorage(current), true);
  fs.writeFileSync(path.join(current, 'config.json'), '{}');
  assert.equal(admitStorage(current), true);
  fs.writeFileSync(path.join(legacy, 'config.json.bak'), '{}');
  assert.equal(admitStorage(legacy), false);
  assert.deepEqual(fs.readdirSync(legacy), ['config.json.bak']);
});

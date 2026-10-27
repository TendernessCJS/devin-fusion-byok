'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordUnknownCatalog } = require('../src/runtime/host/observations.cjs');

function root(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-observations-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const file = dir => path.join(dir, 'catalog-unknown.json');

test('recordUnknownCatalog dedupes by method name and refreshes the timestamp', t => {
  const dir = root(t);
  recordUnknownCatalog(dir, 'GetModelProviders');
  recordUnknownCatalog(dir, 'GetOtherModels');
  recordUnknownCatalog(dir, 'GetModelProviders');
  const entries = JSON.parse(fs.readFileSync(file(dir), 'utf8'));
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(entry => entry.rpc), ['GetOtherModels', 'GetModelProviders'],
    'a repeated sighting moves to the tail instead of duplicating');
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['at', 'rpc'], 'entries carry only the timestamp and method name');
    assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/);
  }
});

test('recordUnknownCatalog keeps only the last `limit` entries', t => {
  const dir = root(t);
  for (let i = 0; i < 7; i++) recordUnknownCatalog(dir, 'Method' + i, { limit: 5 });
  const entries = JSON.parse(fs.readFileSync(file(dir), 'utf8'));
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.map(entry => entry.rpc), ['Method2', 'Method3', 'Method4', 'Method5', 'Method6']);
});

test('a malformed existing file is tolerated and replaced', t => {
  const dir = root(t);
  fs.writeFileSync(file(dir), '{not json');
  recordUnknownCatalog(dir, 'GetModelProviders');
  const entries = JSON.parse(fs.readFileSync(file(dir), 'utf8'));
  assert.deepEqual(entries.map(entry => entry.rpc), ['GetModelProviders']);
  fs.writeFileSync(file(dir), '{"not":"an array"}');
  recordUnknownCatalog(dir, 'GetOtherModels');
  assert.deepEqual(JSON.parse(fs.readFileSync(file(dir), 'utf8')).map(entry => entry.rpc), ['GetOtherModels']);
});

test('a missing root or unreadable path never throws', t => {
  const dir = path.join(root(t), 'does-not-exist');
  assert.doesNotThrow(() => recordUnknownCatalog(dir, 'GetModelProviders'));
  assert.equal(fs.existsSync(file(dir)), false);
});

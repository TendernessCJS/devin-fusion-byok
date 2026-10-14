'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CACHE_VERSION, DEFAULT_TTL_MS, MAX_ENTRIES,
  normalizeNativeEntry, loadNativeCache, saveNativeCache } = require('../src/runtime/native-cache.cjs');

const entry = (over = {}) => ({ uid: 'swe-2-medium', label: 'SWE-2 Medium', ...over });

test('normalizeNativeEntry rejects malformed entries and bounds sizes', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { uid: 1 }, { uid: '' }, { uid: 'x'.repeat(257) }]) {
    assert.equal(normalizeNativeEntry(bad), null, JSON.stringify(bad));
  }
});

test('normalizeNativeEntry keeps only the documented capability fields', () => {
  const normalized = normalizeNativeEntry(entry({
    label: undefined, disabled: 'yes', isModelRouter: 1, apiKey: 'SECRET',
    harnessUids: ['h1', 7, 'x'.repeat(300), ...Array.from({ length: 70 }, (_, i) => 'h' + i)],
    sidekickDimension: { order: 1, name: 'Dim', fastModeOrder: 2, extra: true },
    fusionMetadata: [{ k: 'v' }], maxTokens: 1000, maxOutputTokens: 2000, supportsImages: true,
  }));
  assert.equal(normalized.label, '', 'non-string labels fall back to empty');
  assert.equal(normalized.disabled, false, 'truthy non-booleans do not count');
  assert.equal(normalized.isModelRouter, false);
  assert.equal(normalized.apiKey, undefined, 'no foreign keys survive');
  assert.ok(normalized.harnessUids.every(value => typeof value === 'string' && value.length <= 256));
  assert.equal(normalized.harnessUids.length, 64, 'harness list is bounded');
  assert.deepEqual(normalized.sidekickDimension, { order: 1, name: 'Dim', fastModeOrder: 2 });
  assert.deepEqual(normalized.fusionMetadata, [{ k: 'v' }]);
  assert.equal(normalized.maxTokens, 1000);
  assert.equal(normalized.maxOutputTokens, 2000);
  assert.equal(normalized.supportsImages, true);
  assert.equal(normalizeNativeEntry(entry({ sidekickDimension: 'no' })).sidekickDimension, undefined);
  assert.equal(normalizeNativeEntry(entry({ fusionMetadata: 'no' })).fusionMetadata, undefined);
  assert.equal(normalizeNativeEntry(entry()).maxTokens, undefined, 'absent capability flags stay absent');
  assert.equal(normalizeNativeEntry(entry()).supportsImages, undefined);
});

test('loadNativeCache returns nothing for missing, malformed or mismatched files', () => {
  const missing = () => { throw new Error('ENOENT'); };
  assert.deepEqual(loadNativeCache('/no/file', { readFile: missing }), []);
  assert.deepEqual(loadNativeCache('/f', { readFile: () => '{not json' }), []);
  assert.deepEqual(loadNativeCache('/f', { readFile: () => JSON.stringify({ version: 2, savedAt: new Date().toISOString(), models: [] }) }), []);
  assert.deepEqual(loadNativeCache('/f', { readFile: () => JSON.stringify({ version: CACHE_VERSION, savedAt: new Date().toISOString(), models: 'x' }) }), []);
  assert.deepEqual(loadNativeCache('/f', { readFile: () => JSON.stringify({ version: CACHE_VERSION, models: [] }) }), []);
  assert.deepEqual(loadNativeCache('/f', { readFile: () => JSON.stringify({ version: CACHE_VERSION, savedAt: 'garbage', models: [] }) }), []);
});

test('loadNativeCache enforces the TTL in both directions and dedupes by uid', () => {
  const now = 10_000_000_000;
  const file = data => () => JSON.stringify(data);
  const payload = savedAt => ({ version: CACHE_VERSION, savedAt: new Date(savedAt).toISOString(), models: [entry()] });
  assert.deepEqual(loadNativeCache('/f', { now: () => now, readFile: file(payload(now - DEFAULT_TTL_MS - 1)) }), [], 'expired entries are dropped');
  assert.deepEqual(loadNativeCache('/f', { now: () => now, readFile: file(payload(now + 2 * 60 * 60 * 1000)) }), [], 'far-future clocks are rejected');
  const fresh = payload(now - 1000);
  fresh.models = [entry(), entry({ label: 'dup' }), { uid: '' }, null, entry({ uid: 'other' })];
  const loaded = loadNativeCache('/f', { now: () => now, readFile: file(fresh) });
  assert.deepEqual(loaded.map(value => value.uid), ['swe-2-medium', 'other'], 'first occurrence wins and invalid entries are dropped');
});

test('saveNativeCache writes atomically through tmp + rename with private permissions', () => {
  const calls = [];
  const writeFile = (file, data, options) => calls.push(['write', file, data, options]);
  const rename = (from, to) => calls.push(['rename', from, to]);
  let clock = 5000;
  const ok = saveNativeCache('/root/native-cache.json', [entry(), entry({ uid: 'second' })], { now: () => clock, writeFile, rename });
  assert.equal(ok, true);
  assert.equal(calls[0][0], 'write');
  assert.equal(calls[0][1], '/root/native-cache.json.tmp');
  assert.deepEqual(calls[0][3], { mode: 0o600 });
  assert.deepEqual(calls[1], ['rename', '/root/native-cache.json.tmp', '/root/native-cache.json']);
  const saved = JSON.parse(calls[0][2]);
  assert.equal(saved.version, CACHE_VERSION);
  assert.equal(saved.savedAt, new Date(clock).toISOString());
  assert.deepEqual(saved.models.map(value => value.uid), ['swe-2-medium', 'second']);
});

test('saveNativeCache never throws and cleans up the temporary file on failure', () => {
  const calls = [];
  const badWrite = () => { throw new Error('disk full'); };
  const unlink = (file, options) => calls.push(file);
  assert.equal(saveNativeCache('/f', [entry()], { writeFile: badWrite, rename: () => calls.push('rename'), unlink }), false);
  assert.deepEqual(calls, ['/f.tmp'], 'the tmp file is removed and rename is never attempted');
  const badRename = () => { throw new Error('EBUSY'); };
  calls.length = 0;
  assert.equal(saveNativeCache('/f', [entry()], { writeFile: () => {}, rename: badRename, unlink }), false);
  assert.deepEqual(calls, ['/f.tmp']);
});

test('saveNativeCache truncates the entry list to MAX_ENTRIES', () => {
  let written;
  const writeFile = (file, data) => { written = JSON.parse(data); };
  const entries = Array.from({ length: MAX_ENTRIES + 10 }, (_, i) => entry({ uid: 'uid-' + i }));
  assert.equal(saveNativeCache('/f', entries, { writeFile, rename: () => {} }), true);
  assert.equal(written.models.length, MAX_ENTRIES);
  assert.equal(written.models[0].uid, 'uid-0');
});

test('the real filesystem round-trip writes a private readable file', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'native-cache.json');
  assert.equal(saveNativeCache(file, [entry()]), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(file + '.tmp'), false);
  const loaded = loadNativeCache(file);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].uid, 'swe-2-medium');
});

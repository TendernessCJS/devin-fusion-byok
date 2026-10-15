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

const EMPTY = { models: [], allowedUids: [] };

test('loadNativeCache returns nothing for missing, malformed or mismatched files', () => {
  const missing = () => { throw new Error('ENOENT'); };
  assert.deepEqual(loadNativeCache('/no/file', { readFile: missing }), EMPTY);
  assert.deepEqual(loadNativeCache('/f', { readFile: () => '{not json' }), EMPTY);
  assert.deepEqual(loadNativeCache('/f', { readFile: () => JSON.stringify({ version: 2, savedAt: new Date().toISOString(), models: [] }) }), EMPTY);
  assert.deepEqual(loadNativeCache('/f', { readFile: () => JSON.stringify({ version: CACHE_VERSION, savedAt: new Date().toISOString(), models: 'x' }) }), EMPTY);
  assert.deepEqual(loadNativeCache('/f', { readFile: () => JSON.stringify({ version: CACHE_VERSION, models: [] }) }), EMPTY);
  assert.deepEqual(loadNativeCache('/f', { readFile: () => JSON.stringify({ version: CACHE_VERSION, savedAt: 'garbage', models: [] }) }), EMPTY);
});

test('loadNativeCache enforces the TTL in both directions and dedupes by uid', () => {
  const now = 10_000_000_000;
  const file = data => () => JSON.stringify(data);
  const payload = savedAt => ({ version: CACHE_VERSION, savedAt: new Date(savedAt).toISOString(), models: [entry()] });
  assert.deepEqual(loadNativeCache('/f', { now: () => now, readFile: file(payload(now - DEFAULT_TTL_MS - 1)) }), EMPTY, 'expired entries are dropped');
  assert.deepEqual(loadNativeCache('/f', { now: () => now, readFile: file(payload(now + 2 * 60 * 60 * 1000)) }), EMPTY, 'far-future clocks are rejected');
  const fresh = payload(now - 1000);
  fresh.models = [entry(), entry({ label: 'dup' }), { uid: '' }, null, entry({ uid: 'other' })];
  fresh.allowedUids = ['MODEL_B', 'dfbyok-injected', 'MODEL_A', 'MODEL_B'];
  const loaded = loadNativeCache('/f', { now: () => now, readFile: file(fresh) });
  assert.deepEqual(loaded.models.map(value => value.uid), ['swe-2-medium', 'other'], 'first occurrence wins and invalid entries are dropped');
  assert.deepEqual(loaded.allowedUids, ['MODEL_A', 'MODEL_B'], 'the allowlist is deduped, sorted, and strips our own marker uids');
});

test('saveNativeCache writes atomically through tmp + rename with private permissions', () => {
  const calls = [];
  const writeFile = (file, data, options) => calls.push(['write', file, data, options]);
  const rename = (from, to) => calls.push(['rename', from, to]);
  let clock = 5000;
  const ok = saveNativeCache('/root/native-cache.json', [entry(), entry({ uid: 'second' })],
    { now: () => clock, writeFile, rename, allowedUids: ['MODEL_B', 'fusion-dfbyok-own', 'MODEL_A', 'MODEL_B'] });
  assert.equal(ok, true);
  assert.equal(calls[0][0], 'write');
  assert.equal(calls[0][1], '/root/native-cache.json.tmp');
  assert.deepEqual(calls[0][3], { mode: 0o600 });
  assert.deepEqual(calls[1], ['rename', '/root/native-cache.json.tmp', '/root/native-cache.json']);
  const saved = JSON.parse(calls[0][2]);
  assert.equal(saved.version, CACHE_VERSION);
  assert.equal(saved.savedAt, new Date(clock).toISOString());
  assert.deepEqual(saved.models.map(value => value.uid), ['swe-2-medium', 'second']);
  assert.deepEqual(saved.allowedUids, ['MODEL_A', 'MODEL_B']);
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
  assert.equal(loaded.models.length, 1);
  assert.equal(loaded.models[0].uid, 'swe-2-medium');
  assert.deepEqual(loaded.allowedUids, []);
});

test('mergeNativeEntry keeps the richer form when a poorer copy arrives later', () => {
  const { mergeNativeEntry, normalizeNativeEntry } = require('../src/runtime/native-cache.cjs');
  const rich = normalizeNativeEntry({ uid: 'fusion-a-sidekick-swe-2-high', label: 'F', disabled: false, isModelRouter: true,
    harnessUids: ['fusion'], sidekickDimension: { order: 2, name: 'SWE-2 High', fastModeOrder: 0 },
    fusionMetadata: [{ key: 'Sidekick', order: 2, name: 'SWE-2 High', controlType: 3 }] });
  const poor = normalizeNativeEntry({ uid: 'fusion-a-sidekick-swe-2-high', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'] });
  // A seeded entry (rich) followed by a dimension-less observation keeps its
  // dimensions: without them every native Sidekick becomes unresolvable and the
  // mirrored combinations are reported unemitted and deleted.
  assert.deepEqual(mergeNativeEntry(rich, poor), rich);
  // A fresher scalar still wins, so capability changes are never masked.
  const flipped = normalizeNativeEntry({ ...poor, disabled: true });
  assert.equal(mergeNativeEntry(rich, flipped).disabled, true);
  assert.deepEqual(mergeNativeEntry(rich, flipped).sidekickDimension, rich.sidekickDimension);
  // Richer incoming data replaces the poorer stored copy.
  assert.deepEqual(mergeNativeEntry(poor, rich), rich);
  assert.deepEqual(mergeNativeEntry(poor, poor), poor);
  assert.deepEqual(mergeNativeEntry(undefined, rich), rich);
  assert.deepEqual(mergeNativeEntry(rich, undefined), rich);
  // Harnesses are carried over too: a combination cannot be routed without them.
  const noHarness = normalizeNativeEntry({ uid: 'swe-2-high', disabled: false, isModelRouter: false });
  assert.deepEqual(mergeNativeEntry({ ...rich, harnessUids: ['swe-1p6'] }, noHarness).harnessUids, ['swe-1p6']);
});

test('normalizeNativeEntry and mergeNativeEntry carry the server family uid', () => {
  const { mergeNativeEntry } = require('../src/runtime/native-cache.cjs');
  assert.equal(normalizeNativeEntry(entry({ familyUid: 'glm-5.2' })).familyUid, 'glm-5.2');
  for (const bad of [42, '', 'x'.repeat(200), {}]) {
    assert.equal(normalizeNativeEntry(entry({ familyUid: bad })).familyUid, undefined, JSON.stringify(bad));
  }
  const withFamily = normalizeNativeEntry(entry({ familyUid: 'glm-5.2' }));
  const without = normalizeNativeEntry(entry());
  assert.equal(mergeNativeEntry(withFamily, without).familyUid, 'glm-5.2',
    'a later poorer copy must not drop the family id');
  assert.equal(mergeNativeEntry(without, withFamily).familyUid, 'glm-5.2');
  assert.equal(mergeNativeEntry(without, without).familyUid, undefined);
});

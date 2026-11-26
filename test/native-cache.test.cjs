'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CACHE_VERSION, DEFAULT_TTL_MS, MAX_ENTRIES,
  loadNativeCache, saveNativeCache } = require('../src/runtime/native-cache.cjs');
const { normalizeNativeEntry, normalizeAllowedUids } = require('../src/models/native-entry.cjs');

const entry = (over = {}) => ({ uid: 'swe-2-medium', label: 'SWE-2 Medium', ...over });

test('normalizeNativeEntry preserves the canonical observation fields', () => {
  const normalized = normalizeNativeEntry(entry({
    familyUid: 'fam-9', kind: 8, pickerListed: false,
    fusionMetadata: [{ key: 'Sidekick', order: 2, name: 'S' }],
    sources: ['cli', 'cascade', 'x'.repeat(40), 7, ...Array.from({ length: 9 }, () => 'extra')],
  }));
  assert.equal(normalized.familyUid, 'fam-9');
  assert.equal(normalized.kind, 8);
  assert.equal(normalized.pickerListed, false, 'a false verdict is a verdict and survives');
  assert.deepEqual(normalized.fusionMetadata, [{ key: 'Sidekick', order: 2, name: 'S' }]);
  assert.deepEqual(normalized.sources, ['cli', 'cascade', 'extra', 'extra', 'extra', 'extra', 'extra', 'extra'],
    'non-strings and overlong sources are filtered; the list is bounded at 8');
  assert.equal(normalizeNativeEntry(entry({ familyUid: 'x'.repeat(129) })).familyUid, undefined);
  assert.equal(normalizeNativeEntry(entry({ pickerListed: 'yes' })).pickerListed, undefined);
  assert.deepEqual(normalizeAllowedUids(['swe-2', 'dfbyok-own', 'fusion-dfbyok-x', 'swe-2', '', 9]), ['swe-2']);
});

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

const EMPTY = { models: [], allowedUids: [], allowedMode: 'restricted' };

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
  const { mergeNativeEntry } = require('../src/models/native-entry.cjs');
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
  const { mergeNativeEntry } = require('../src/models/native-entry.cjs');
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

test('pickerGroup and its rank validate at normalize and carry together at merge', () => {
  const { mergeNativeEntry } = require('../src/models/native-entry.cjs');
  const grouped = normalizeNativeEntry(entry({ pickerGroup: 'Official', pickerGroupRank: 3, pickerListed: true }));
  assert.deepEqual([grouped.pickerGroup, grouped.pickerGroupRank], ['Official', 3]);
  // Invalid values are silently dropped — a bad group name must never kill the entry.
  for (const bad of [{ pickerGroup: 'x'.repeat(65) }, { pickerGroup: '   ' }, { pickerGroup: 42 },
    { pickerGroupRank: -1 }, { pickerGroupRank: 1.5 }, { pickerGroupRank: 0x80000000 }, { pickerGroupRank: '0' }]) {
    const normalized = normalizeNativeEntry(entry(bad));
    assert.ok(normalized, JSON.stringify(bad) + ' must not drop the entry');
    assert.equal(normalized.pickerGroup, undefined, JSON.stringify(bad));
    assert.equal(normalized.pickerGroupRank, undefined, JSON.stringify(bad));
  }
  // A sorts-less observation (CLI) does not erase the group a sorts-carrying
  // observation (cascade) recorded — same carry rule as pickerListed.
  const flat = normalizeNativeEntry(entry());
  assert.equal(flat.pickerGroup, undefined);
  const merged = mergeNativeEntry(grouped, flat);
  assert.deepEqual([merged.pickerGroup, merged.pickerGroupRank], ['Official', 3], 'group and rank carry together');
  // The reverse direction takes the fresh cascade verdict instead.
  const reverse = mergeNativeEntry(flat, grouped);
  assert.deepEqual([reverse.pickerGroup, reverse.pickerGroupRank], ['Official', 3]);
  // A sorts-carrying observation of its own always wins over the carried one.
  const regrouped = normalizeNativeEntry(entry({ pickerGroup: 'Other', pickerGroupRank: 0, pickerListed: true }));
  assert.deepEqual([mergeNativeEntry(grouped, regrouped).pickerGroup, mergeNativeEntry(grouped, regrouped).pickerGroupRank], ['Other', 0]);
});

test('a sorts-carrying observation without a named group clears the carried pickerGroup', () => {
  const { mergeNativeEntry } = require('../src/models/native-entry.cjs');
  // pickerSorted validates like pickerListed: boolean only.
  assert.equal(normalizeNativeEntry(entry({ pickerSorted: true })).pickerSorted, true);
  assert.equal(normalizeNativeEntry(entry({ pickerSorted: 'yes' })).pickerSorted, undefined);
  const grouped = normalizeNativeEntry(entry({ pickerGroup: 'Official', pickerGroupRank: 3, pickerListed: true, pickerSorted: true }));
  // The label falls out of every named group in a later sorts-carrying
  // observation: that is a fresh verdict, so the prior group must not carry.
  const ungrouped = normalizeNativeEntry(entry({ pickerListed: true, pickerSorted: true }));
  const cleared = mergeNativeEntry(grouped, ungrouped);
  assert.equal(cleared.pickerGroup, undefined, 'a sorts verdict of "no group" clears the carried group');
  assert.equal(cleared.pickerGroupRank, undefined, 'the rank clears together with the group');
  assert.equal(cleared.pickerSorted, true);
  // A flat (sorts-less) observation still leaves the prior verdict untouched.
  const flat = normalizeNativeEntry(entry());
  const carried = mergeNativeEntry(grouped, flat);
  assert.deepEqual([carried.pickerGroup, carried.pickerGroupRank], ['Official', 3], 'sorts-less observations still carry');
});

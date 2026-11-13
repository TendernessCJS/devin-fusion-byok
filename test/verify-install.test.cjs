'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseLogLines, aggregateLog, evaluateLog, evaluateContractCache, compareTrees, verdictOf } =
  require('../scripts/verify-install.cjs');

const NOW = Date.parse('2026-11-09T12:00:00Z');
const line = (time, event, extra = {}) => JSON.stringify({ time, event, ...extra, secret: 'x' });

const SAMPLE = [
  line('2026-11-09T11:00:00Z', 'chat-complete', { status: 200, model: 'm1' }),
  line('2026-11-09T11:05:00Z', 'chat-complete', { status: 200, model: 'm1' }),
  line('2026-11-09T11:10:00Z', 'chat-complete', { status: 500, model: 'm2' }),
  line('2026-11-09T11:15:00Z', 'request-error'),
  line('2026-11-09T11:20:00Z', 'catalog', { rpc: 'GetUserStatus', models: 10, matrix: 8, beforeOwn: 0, afterOwn: 3 }),
  line('2026-11-09T11:30:00Z', 'catalog', { rpc: 'GetCliModelConfigs', models: 20, matrix: 18, beforeOwn: 0, afterOwn: 5 }),
  line('2026-11-09T11:40:00Z', 'state-envelope-replay-failed', { reasons: ['id'] }),
  line('2026-11-09T11:41:00Z', 'state-envelope-replay-failed', { reasons: ['id', 'shape'] }),
  line('2026-11-09T11:50:00Z', 'tool-name-unknown', { name: 'view_image' }),
].join('\n');

test('log aggregation counts statuses, models, errors, reasons and the latest catalog', () => {
  const agg = aggregateLog(parseLogLines(SAMPLE, 24, NOW));
  assert.equal(agg.chatTotal, 3);
  assert.deepEqual(agg.chatStatus, { '200': 2, '500': 1 });
  assert.deepEqual(agg.chatModel, { m1: 2, m2: 1 });
  assert.equal(agg.requestErrors, 1);
  assert.equal(agg.replayFailed, 2);
  assert.deepEqual(agg.replayReasons, { id: 2, shape: 1 });
  assert.deepEqual(agg.toolNames, ['view_image']);
  assert.equal(agg.lastCatalog.rpc, 'GetCliModelConfigs');
  assert.equal(agg.lastCatalog.afterOwn, 5);
});

test('the window filter drops out-of-range events and unparsable lines quietly', () => {
  const text = [
    line('2026-11-08T00:00:00Z', 'chat-complete', { status: 200 }),
    'not json at all',
    line('not-a-time', 'chat-complete', { status: 200 }),
    line('2026-11-09T11:00:00Z', 'chat-complete', { status: 200 }),
  ].join('\n');
  const agg = aggregateLog(parseLogLines(text, 24, NOW));
  assert.equal(agg.total, 1);
  assert.equal(agg.chatTotal, 1);
});

test('replay-failed, tool-name-unknown and forward-timeout never produce warn or fail', () => {
  const agg = aggregateLog(parseLogLines([
    line('2026-11-09T11:00:00Z', 'chat-complete', { status: 200 }),
    line('2026-11-09T11:20:00Z', 'catalog', { rpc: 'GetUserStatus', models: 1, matrix: 1, beforeOwn: 0, afterOwn: 1 }),
    line('2026-11-09T11:40:00Z', 'state-envelope-replay-failed', { reasons: ['id'] }),
    line('2026-11-09T11:50:00Z', 'tool-name-unknown', { name: 'view_image' }),
    line('2026-11-09T11:55:00Z', 'forward-timeout', { phase: 'body' }),
  ].join('\n'), 24, NOW));
  const { infos, warns } = evaluateLog(agg);
  assert.deepEqual(warns, []);
  assert.equal(infos.length, 3);
  assert.equal(verdictOf([{ level: 'INFO' }, { level: 'PASS' }]), 'ok');
});

test('replay reasons aggregate by count from the real object shape, and never become object keys', () => {
  const agg = aggregateLog(parseLogLines([
    line('2026-11-09T11:40:00Z', 'state-envelope-replay-failed', { reasons: { id: 1 } }),
    line('2026-11-09T11:41:00Z', 'state-envelope-replay-failed', { reasons: { id: 1 } }),
    line('2026-11-09T11:42:00Z', 'state-envelope-replay-failed', { reasons: { shape: 2, id: 1 } }),
  ].join('\n'), 24, NOW));
  assert.deepEqual(agg.replayReasons, { id: 3, shape: 2 });
  assert.equal(Object.hasOwn(agg.replayReasons, '[object Object]'), false,
    'reason counts must never collapse into an "[object Object]" key');
});

test('a stale contract cache fails; a fresh ok cache passes', () => {
  const stale = evaluateContractCache({ appVersion: '3.12.17', status: 'ok', missing: {} }, '3.12.32');
  assert.equal(stale[0].level, 'FAIL');
  assert.match(stale[0].message, /stale:契约缓存在 3\.12\.17,本体已 3\.12\.32;重载 Devin 后复验/);
  const fresh = evaluateContractCache({ appVersion: '3.12.32', status: 'ok', missing: {} }, '3.12.32');
  assert.equal(fresh[0].level, 'PASS');
  assert.equal(evaluateContractCache(null, '3.12.32')[0].level, 'FAIL');
  const drift = evaluateContractCache({ appVersion: '3.12.32', status: 'ok', missing: { ls: ['X'] } }, '3.12.32');
  assert.equal(drift[0].level, 'FAIL');
  const noVersion = evaluateContractCache({ appVersion: '3.12.32', status: 'ok', missing: {} }, null);
  assert.equal(noVersion[0].level, 'FAIL');
  assert.match(noVersion[0].message, /无法取得本体版本/);
});

test('verdict and exit-code mapping: fail wins over warn, warn still ok', () => {
  assert.equal(verdictOf([{ level: 'FAIL' }, { level: 'WARN' }]), 'fail');
  assert.equal(verdictOf([{ level: 'WARN' }, { level: 'PASS' }]), 'warn');
  assert.equal(verdictOf([{ level: 'PASS' }, { level: 'INFO' }]), 'ok');
});

test('log evaluation maps the three warn categories without touching info-only signals', () => {
  const agg = aggregateLog(parseLogLines([
    line('2026-11-09T11:00:00Z', 'chat-complete', { status: 500 }),
    line('2026-11-09T11:15:00Z', 'request-error'),
  ].join('\n'), 24, NOW));
  const { warns } = evaluateLog(agg);
  assert.equal(warns.length, 3, 'non-200 + request-error + no catalog');
  assert.match(warns[2], /窗口内未见目录注入/);
});

test('compareTrees: identical trees produce no diffs and no emptyDirs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, 'installed'), repo = path.join(root, 'repo');
  for (const dir of [installed, repo]) {
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.cjs'), 'same');
    fs.writeFileSync(path.join(dir, 'sub', 'b.cjs'), 'same too');
  }
  const { diffs, emptyDirs } = compareTrees(installed, repo);
  assert.deepEqual(diffs, []);
  assert.deepEqual(emptyDirs, []);
});

test('compareTrees: same-name file with different content is a diff', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, 'installed'), repo = path.join(root, 'repo');
  fs.mkdirSync(installed, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(installed, 'a.cjs'), 'installed body');
  fs.writeFileSync(path.join(repo, 'a.cjs'), 'repo body');
  const { diffs, emptyDirs } = compareTrees(installed, repo);
  assert.deepEqual(diffs, ['a.cjs']);
  assert.deepEqual(emptyDirs, []);
});

test('compareTrees: file only on installed side is (repo 缺)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, 'installed'), repo = path.join(root, 'repo');
  fs.mkdirSync(installed, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(installed, 'extra.cjs'), 'x');
  const { diffs } = compareTrees(installed, repo);
  assert.deepEqual(diffs, ['extra.cjs (repo 缺)']);
});

test('compareTrees: file only on repo side is (installed 缺)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, 'installed'), repo = path.join(root, 'repo');
  fs.mkdirSync(installed, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'missing.cjs'), 'x');
  const { diffs } = compareTrees(installed, repo);
  assert.deepEqual(diffs, ['missing.cjs (installed 缺)']);
});

test('compareTrees: empty dir only on installed side goes to emptyDirs, not diffs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, 'installed'), repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(installed, 'stores'), { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(installed, 'a.cjs'), 'same');
  fs.writeFileSync(path.join(repo, 'a.cjs'), 'same');
  const { diffs, emptyDirs } = compareTrees(installed, repo);
  assert.deepEqual(diffs, []);
  assert.deepEqual(emptyDirs, ['stores (repo 缺)']);
});

test('compareTrees: dir on one side vs same-name file on the other is (类型)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, 'installed'), repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(installed, 'thing'), { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'thing'), 'file');
  const { diffs } = compareTrees(installed, repo);
  assert.deepEqual(diffs, ['thing (类型)']);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createMonitor, associate, summarize } = require('../src/monitor/store.cjs');
const { createTracker, usageOf } = require('../src/protocol/tracker.cjs');
function tracker() {
  let clock = 0;
  const value = createTracker({ id: 'response-1', route: { model: 'test' }, provider: { id: 'p', apiKey: 'SECRET' }, now: () => clock });
  return { value, at: n => { clock = n; } };
}
test('usage separates subset counters, zero and missing; never accumulates repeated usage', () => {
  assert.deepEqual(usageOf({ usage: { prompt_tokens: 100, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 80 } } }, true), { inputTokens: 100, outputTokens: 0, cachedTokens: 80, reasoningTokens: null });
  assert.equal(usageOf({}, true), null);
  const t = tracker();
  t.at(100); t.value.event({ data: { choices: [{ delta: { reasoning_content: 'think' } }] } }, true);
  t.at(500); t.value.event({ data: { choices: [{ delta: { content: 'hello' } }] } }, true);
  const event = { type: 'response.completed', data: { response: { usage: { input_tokens: 100, output_tokens: 20, output_tokens_details: { reasoning_tokens: 10 } } } } };
  t.at(1000); t.value.event(event, false); t.value.event(event, false);
  t.at(1000); const record = t.value.finish('success', 200);
  assert.equal(record.firstOutputMs, 100); assert.equal(record.firstTextMs, 500);
  assert.equal(record.tps, 20); assert.equal(record.outputTokens, 20);
  assert.equal(record.reasoningTokens, 10); assert.equal(record.usageComplete, true);
  assert.ok(!JSON.stringify(record).includes('SECRET'));
});
test('empty events do not count as output; tool-only and cancellation are explicit', () => {
  const t = tracker(); t.at(10); t.value.event({ data: { choices: [{ delta: { role: 'assistant', content: '' } }] } }, true);
  t.at(20); t.value.event({ type: 'response.function_call_arguments.delta', data: { delta: '{}' } }, false);
  t.at(30); const record = t.value.finish('cancelled', 200);
  assert.equal(record.firstOutputMs, 20); assert.equal(record.firstTextMs, null);
  assert.equal(record.tps, null); assert.equal(record.inputTokens, null); assert.equal(record.usageComplete, false);
});
test('ambiguity never chooses a session and internal ids stay out of the public record', () => {
  const record = { ...tracker().value.finish('success', 200), toolIds: ['call-a'] };
  const rows = [{ message_id: 'call-a', session_id: 'a' }, { message_id: 'call-a', session_id: 'b' }];
  const ambiguous = associate([record], rows)[0];
  assert.equal(ambiguous.sessionId, null, 'two candidate sessions are never guessed between');
  assert.equal(ambiguous.attribution, 'ambiguous');
  assert.equal(ambiguous.attributionReason, 'ambiguous-match');
  const resolved = associate([record], [{ message_id: 'call-a', session_id: 'b' }])[0];
  assert.equal(resolved.sessionId, 'b'); assert.equal(resolved.attribution, 'tool-id');
  assert.equal(resolved.attributionReason, null);
  assert.equal(resolved.toolIds, undefined, 'internal ids never reach the public record');
});
test('aggregate TPS is ratio of sums and unknown counts are not zeros', () => {
  const base = tracker().value.finish('success', 200);
  const summary = summarize([{ ...base, outputTokens: 10, durationMs: 1000, tps: 10 }, { ...base, outputTokens: 90, durationMs: 3000, tps: 30 }, { ...base, status: 'cancelled' }]);
  assert.deepEqual(summary.tps, { value: 30, samples: 2 });
  assert.deepEqual(summary.throughputTps, { value: 25, samples: 2 });
  assert.deepEqual(summary.outputTokens, { value: 100, reported: 2 });
  assert.deepEqual(summary.inputTokens, { value: null, reported: 0 });
  assert.equal(summary.requests, 3); assert.equal(summary.cancelled, 1);
});
test('DeepSeek cache alias, tool-bearing output, done-only text and failed samples stay honest', () => {
  assert.equal(usageOf({ usage: { prompt_cache_hit_tokens: 80 } }, true).cachedTokens, 80);
  const t = tracker();
  t.at(100); t.value.event({ type: 'response.output_text.delta', data: { delta: 'hello' } }, false);
  t.at(200); t.value.event({ type: 'response.output_item.added', data: { item: { type: 'function_call', call_id: 'tool-1', name: 'exec' }, output_index: 0 } }, false);
  t.at(1000); t.value.event({ type: 'response.completed', data: { response: { usage: { input_tokens: 20, output_tokens: 30 } } } }, false);
  const record = t.value.finish('success', 200);
  assert.equal(record.tps, null); assert.deepEqual(record.toolIds, ['tool-1']); assert.equal(record.throughputTps, 30);
  const assigned = associate([record], [{ message_id: 'tool-1', session_id: 'session-a', kind: 'tool' }])[0];
  assert.equal(assigned.sessionId, 'session-a'); assert.equal(assigned.attribution, 'tool-id');
  const ambiguous = associate([record], [{ message_id: 'tool-1', session_id: 'a', kind: 'tool' }, { message_id: 'tool-1', session_id: 'b', kind: 'tool' }])[0];
  assert.equal(ambiguous.sessionId, null); assert.equal(ambiguous.attribution, 'ambiguous');
  const doneOnly = tracker(); doneOnly.at(500);
  doneOnly.value.event({ type: 'response.completed', data: { response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }], usage: { output_tokens: 5 } } } }, false);
  assert.equal(doneOnly.value.finish('success', 200).tps, null);
  assert.equal(doneOnly.value.finish('success', 200).firstTextMs, null);
  const summary = summarize([{ ...record, status: 'cancelled' }]);
  assert.equal(summary.textTtftMs.value, null); assert.equal(summary.ttftMs.samples, 0);
});

test('gateway timing includes metadata, tools and canceled usage; snapshots replace rather than merge', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-metrics-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tracked = tracker();
  tracked.at(50); tracked.value.event({ type: 'done' }, true);
  tracked.at(100); tracked.value.event({ data: { choices: [{ delta: { role: 'assistant' } }] } }, true);
  tracked.at(200); tracked.value.event({ data: { choices: [{ delta: { tool_calls: [{ id: 'call-a', function: { name: 'exec', arguments: '{}' } }] } }], usage: { prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 80 } } } }, true);
  tracked.at(500); tracked.value.event({ data: { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } } }, true);
  tracked.at(1100);
  const monitor = createMonitor({ root, databasePath: path.join(root, 'missing.db') });
  monitor.record(tracked.value.finish('cancelled', 200));
  const snapshot = await monitor.snapshot();
  const r = snapshot.records[0];
  assert.equal(r.firstResponseMs, 100); assert.equal(r.firstOutputMs, 200);
  assert.equal(r.gatewayTps, 20); assert.equal(r.tps, null);
  assert.equal(r.usageState, 'complete'); assert.equal(r.cachedTokens, null);
  assert.equal(r.status, 'cancelled'); assert.equal(snapshot.summary.gatewayTps.value, 20);
  assert.equal(snapshot.summary.firstResponseMs.value, 100);
  monitor.record({ ...r, id: 'legacy', schemaVersion: 2 });
  monitor.record({ ...r, id: 'bad', cachedTokens: 200 });
  const next = await monitor.snapshot();
  assert.equal(next.records.find(v => v.id === 'legacy').gatewayTps, null);
  assert.equal(next.records.find(v => v.id === 'legacy').firstResponseMs, null);
  assert.equal(next.records.find(v => v.id === 'bad').usageState, 'inconsistent');
  assert.equal(next.records.find(v => v.id === 'bad').gatewayTps, null);
});

test('persists private-safe records, resolves real SQLite IDs read-only and survives restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, 'sessions.db');
  execFileSync('/usr/bin/sqlite3', [db, "CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,last_activity_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT); INSERT INTO sessions VALUES('session-a','会话标题甲',1791793602); INSERT INTO tool_call_state VALUES('session-a','call-a');"]);
  const monitor = createMonitor({ root, databasePath: db });
  const record = { ...tracker().value.finish('success', 200), toolIds: ['call-a'] };
  monitor.record({ ...record, secret: 'SECRET' }); monitor.record(record);
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.records.length, 1); assert.equal(snapshot.sessions[0].sessionId, 'session-a');
  assert.equal(snapshot.sessions[0].title, '会话标题甲');
  assert.equal(snapshot.sessions[0].lastActivityAt, 1791793602, 'epoch seconds pass through unchanged');
  assert.equal(snapshot.records[0].attribution, 'tool-id');
  const file = path.join(root, 'monitor.jsonl');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.ok(!fs.readFileSync(file, 'utf8').includes('SECRET'));
  assert.equal((await createMonitor({ root, databasePath: db }).snapshot()).records.length, 1);
  const missing = await createMonitor({ root, databasePath: path.join(root, 'missing.db') }).snapshot();
  assert.equal(missing.sessionStatus, 'unavailable', 'a database that cannot be read is reported, never guessed around');
  assert.equal(missing.records[0].sessionId, null);
  assert.equal(missing.records[0].attributionReason, 'lookup-unavailable');
});

test('attribution reads only the indexed tool table', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-isolation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, 'sessions.db');
  execFileSync('/usr/bin/sqlite3', [db, "CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,last_activity_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT); INSERT INTO sessions VALUES('session-t','工具会话',300); INSERT INTO tool_call_state VALUES('session-t','call-a');"]);
  const monitor = createMonitor({ root, databasePath: db });
  monitor.record({ id: 'r1', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p', schemaVersion: 2, toolIds: ['call-a'] });
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.sessionStatus, 'ready');
  assert.equal(snapshot.sessions[0].sessionId, 'session-t');
  assert.equal(snapshot.sessions[0].title, '工具会话');
  assert.equal(snapshot.records[0].attribution, 'tool-id');
});

test('a failing tool-id lookup still reports the session lookup as unavailable', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-toolfail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const monitor = createMonitor({ root, databasePath: path.join(root, 'missing.db') });
  monitor.record({ id: 'r1', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p', schemaVersion: 2, toolIds: ['call-a'] });
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.sessionStatus, 'unavailable', 'the tool-id branch is authoritative');
  assert.equal(snapshot.records[0].sessionId, null);
});

test('session labels order newest first, tolerate missing rows and survive lookup failure', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-labels-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, 'sessions.db');
  execFileSync('/usr/bin/sqlite3', [db, "CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,last_activity_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT); INSERT INTO sessions VALUES('session-old','旧会话',100),('session-new','新会话',200); INSERT INTO tool_call_state VALUES('session-old','call-old'),('session-new','call-new'),('session-ghost','call-ghost');"]);
  const monitor = createMonitor({ root, databasePath: db });
  for (const [id, tool] of [['r-old', 'call-old'], ['r-new', 'call-new'], ['r-ghost', 'call-ghost'], ['r-lone', null]]) {
    monitor.record({ id, startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p', schemaVersion: 2, toolIds: tool ? [tool] : [] });
  }
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.sessionStatus, 'ready');
  assert.deepEqual(snapshot.sessions.map(s => [s.sessionId, s.title, s.lastActivityAt]),
    [['session-new', '新会话', 200], ['session-old', '旧会话', 100], ['session-ghost', null, null], [null, null, null]],
    'newest activity first, unlabeled sessions next, the unassigned bucket last');

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-nolabels-'));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  const db2 = path.join(bare, 'sessions.db');
  execFileSync('/usr/bin/sqlite3', [db2, "CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT); INSERT INTO tool_call_state VALUES('session-x','call-x');"]);
  const degraded = createMonitor({ root: bare, databasePath: db2 });
  degraded.record({ id: 'r-x', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p', schemaVersion: 2, toolIds: ['call-x'] });
  const fallback = await degraded.snapshot();
  assert.equal(fallback.sessionStatus, 'ready', 'a missing sessions table must not fail attribution');
  assert.equal(fallback.sessions[0].sessionId, 'session-x');
  assert.equal(fallback.sessions[0].title, null);
  assert.equal(fallback.sessions[0].lastActivityAt, null);
});

test('long session titles pass through snapshot and publicSnapshot untruncated', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-longtitle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, 'sessions.db');
  const longTitle = '长'.repeat(150) + '末尾标记';
  execFileSync('/usr/bin/sqlite3', [db, `CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,last_activity_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT); INSERT INTO sessions VALUES('session-long','${longTitle}',300); INSERT INTO tool_call_state VALUES('session-long','call-long');`]);
  const monitor = createMonitor({ root, databasePath: db });
  monitor.record({ id: 'r-long', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p', schemaVersion: 2, toolIds: ['call-long'] });
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.sessions[0].title, longTitle);
  const { publicSnapshot } = require('../src/runtime/monitor-client.cjs');
  assert.equal(publicSnapshot(snapshot).sessions[0].title, longTitle);
});

test('publicSnapshot carries session titles through the whitelist and still strips unknown fields', () => {
  const { publicSnapshot } = require('../src/runtime/monitor-client.cjs');
  const snapshot = publicSnapshot({ version: 1, status: 'ready', summary: { requests: 1 }, records: [],
    sessions: [{ sessionId: 's', title: '标题', lastActivityAt: 42, secret: 'x', attribution: 'tool-id', summary: { requests: 1 }, records: [] }] });
  assert.equal(snapshot.sessions[0].title, '标题');
  assert.equal(snapshot.sessions[0].lastActivityAt, 42);
  assert.equal(snapshot.sessions[0].secret, undefined);
});

function seedRecords(file, count, prefix = 'seed') {
  const lines = [];
  for (let i = 0; i < count; i++) lines.push(JSON.stringify({ id: `${prefix}-${i}`, startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p' }));
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
}

test('record persists asynchronously through a serialized queue without synchronous writes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-async-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'monitor.jsonl');
  seedRecords(file, 5000);
  const monitor = createMonitor({ root, databasePath: path.join(root, 'none.db') });
  const syncWrites = [];
  const originalWrite = fs.writeFileSync, originalAppend = fs.appendFileSync;
  fs.writeFileSync = (...args) => { syncWrites.push(args[0]); return originalWrite(...args); };
  fs.appendFileSync = (...args) => { syncWrites.push(args[0]); return originalAppend(...args); };
  try {
    monitor.record({ id: 'new-1', startedAt: '2026-01-02T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
    monitor.record({ id: 'new-2', startedAt: '2026-01-03T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
    assert.equal(syncWrites.length, 0, 'record() must not use synchronous fs writes');
    await monitor.flush();
  } finally { fs.writeFileSync = originalWrite; fs.appendFileSync = originalAppend; }
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 5002, 'the two records were appended, not rewritten');
  assert.equal(JSON.parse(lines.at(-1)).id, 'new-2');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(syncWrites.length, 0);
  await monitor.close();
});

test('the on-disk log compacts once per 250 records beyond the limit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-compact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'monitor.jsonl');
  seedRecords(file, 5249);
  const monitor = createMonitor({ root, databasePath: path.join(root, 'none.db') });
  monitor.record({ id: 'over', startedAt: '2026-01-02T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
  await monitor.flush();
  let lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 5000, 'crossing 5250 projected lines compacts back to the limit');
  assert.equal(JSON.parse(lines.at(-1)).id, 'over');
  assert.equal(JSON.parse(lines[0]).id, 'seed-250', 'the newest 5000 entries are kept');
  monitor.record({ id: 'after-1', startedAt: '2026-01-03T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
  monitor.record({ id: 'after-2', startedAt: '2026-01-04T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
  await monitor.flush();
  lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 5002, 'plain appends resume after a compaction');
  assert.equal(JSON.parse(lines.at(-1)).id, 'after-2');
  assert.equal(JSON.parse(lines[0]).id, 'seed-250');
  await monitor.close();
});

test('close writes exactly the in-memory tail, is idempotent and ignores later records', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-close-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'monitor.jsonl');
  seedRecords(file, 5100);
  const monitor = createMonitor({ root, databasePath: path.join(root, 'none.db') });
  monitor.record({ id: 'tail-1', startedAt: '2026-01-02T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
  monitor.record({ id: 'tail-2', startedAt: '2026-01-03T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
  const first = monitor.close();
  assert.equal(monitor.close(), first, 'repeated close returns the same promise');
  await first;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 5000, 'close compacts to exactly the retained tail');
  assert.equal(JSON.parse(lines.at(-1)).id, 'tail-2');
  monitor.record({ id: 'too-late', startedAt: '2026-01-04T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
  await monitor.flush();
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 5000, 'records after close are ignored');
  assert.equal((await monitor.snapshot()).summary.requests, 5000);
  const reloaded = createMonitor({ root, databasePath: path.join(root, 'none.db') });
  const snapshot = await reloaded.snapshot();
  assert.equal(snapshot.summary.requests, 5000);
  const ids = new Set(snapshot.records.map(r => r.id));
  assert.equal(ids.has('tail-1'), true);
  assert.equal(ids.has('tail-2'), true);
  assert.equal(ids.size, snapshot.records.length, 'no duplicates after restart');
  await reloaded.close();
});

test('async persistence failures mark storageError without losing the file or in-memory records', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-fail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'monitor.jsonl');
  seedRecords(file, 3);
  const monitor = createMonitor({ root, databasePath: path.join(root, 'none.db') });
  const originalAppend = fs.promises.appendFile;
  fs.promises.appendFile = () => Promise.reject(new Error('disk full'));
  try {
    monitor.record({ id: 'unwritten', startedAt: '2026-01-02T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
    await monitor.flush();
  } finally { fs.promises.appendFile = originalAppend; }
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3, 'the existing log stays intact');
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.storageError, true, 'the async failure is not hidden');
  assert.equal(snapshot.status, 'degraded');
  assert.equal(snapshot.summary.requests, 4, 'the record survives in memory even though the write failed');
  assert.equal(snapshot.records.some(r => r.id === 'unwritten'), true);
  await monitor.close();
});

test('a failed compaction cleans its temp file and keeps the original log', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-compactfail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'monitor.jsonl');
  seedRecords(file, 5249);
  const before = fs.readFileSync(file, 'utf8');
  const monitor = createMonitor({ root, databasePath: path.join(root, 'none.db') });
  const originalRename = fs.promises.rename;
  fs.promises.rename = () => Promise.reject(new Error('cross-device'));
  try {
    monitor.record({ id: 'triggers-compact', startedAt: '2026-01-02T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
    await monitor.flush();
  } finally { fs.promises.rename = originalRename; }
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the original log is untouched when rename fails');
  assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith('.tmp')), [], 'the temp file is cleaned up');
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.storageError, true);
  assert.equal(snapshot.status, 'degraded');
  await monitor.close();
});

test('a failed load preserves the existing log and blocks all later persistence', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-loadfail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'monitor.jsonl');
  seedRecords(file, 3);
  const before = fs.readFileSync(file, 'utf8');
  const original = fs.readFileSync;
  fs.readFileSync = (...args) => { if (String(args[0]).endsWith('monitor.jsonl')) throw new Error('io'); return original(...args); };
  let monitor;
  try { monitor = createMonitor({ root, databasePath: path.join(root, 'none.db') }); }
  finally { fs.readFileSync = original; }
  monitor.record({ id: 'post-fail', startedAt: '2026-01-02T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
  await monitor.flush();
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'no append may run after a failed load');
  await monitor.close();
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'close must not overwrite an unreadable log');
  assert.equal((await monitor.snapshot()).storageError, true);
});

test('a malformed line inside an otherwise readable log disables compaction but keeps appending', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-malformed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'monitor.jsonl');
  seedRecords(file, 2);
  fs.writeFileSync(file, 'BROKEN-LINE\n' + fs.readFileSync(file, 'utf8'), { mode: 0o600 });
  const monitor = createMonitor({ root, databasePath: path.join(root, 'none.db') });
  monitor.record({ id: 'appended', startedAt: '2026-01-02T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
  await monitor.flush();
  const grown = fs.readFileSync(file, 'utf8');
  assert.equal(grown.trim().split('\n').length, 4, 'ordinary appends still work with a sticky storageError');
  assert.ok(grown.startsWith('BROKEN-LINE\n'));
  await monitor.close();
  assert.equal(fs.readFileSync(file, 'utf8'), grown, 'close must not rewrite a log it cannot fully trust');
  assert.equal((await monitor.snapshot()).storageError, true);
});

test('a compaction queued behind a failed append never replaces the original log', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'monitor.jsonl');
  seedRecords(file, 5248);
  const before = fs.readFileSync(file, 'utf8');
  const monitor = createMonitor({ root, databasePath: path.join(root, 'none.db') });
  const original = fs.promises.appendFile;
  fs.promises.appendFile = () => Promise.reject(new Error('disk full'));
  try {
    monitor.record({ id: 'fails', startedAt: '2026-01-02T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
    monitor.record({ id: 'would-compact', startedAt: '2026-01-03T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
    await monitor.flush();
  } finally { fs.promises.appendFile = original; }
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the queued compaction must not write over a degraded log');
  await monitor.close();
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'close also refuses compaction under a sticky storageError');
  assert.equal((await monitor.snapshot()).storageError, true);
});

test('a foreign file at the generated tmp name is never removed, and a healthy close within the limit performs no rewrite', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-tmpname-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'monitor.jsonl');
  seedRecords(file, 5249);
  const monitor = createMonitor({ root, databasePath: path.join(root, 'none.db') });
  let captured;
  const original = fs.promises.open;
  fs.promises.open = async target => {
    captured = String(target);
    fs.writeFileSync(captured, 'foreign-content');
    throw Object.assign(new Error('exists'), { code: 'EEXIST' });
  };
  try {
    monitor.record({ id: 'triggers-compact', startedAt: '2026-01-02T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
    await monitor.flush();
  } finally { fs.promises.open = original; }
  assert.ok(captured, 'compaction attempted through fs.promises.open');
  assert.equal(fs.readFileSync(captured, 'utf8'), 'foreign-content', 'a path the job did not create must survive');
  assert.equal((await monitor.snapshot()).storageError, true);

  const healthy = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-idle-'));
  t.after(() => fs.rmSync(healthy, { recursive: true, force: true }));
  const healthyFile = path.join(healthy, 'monitor.jsonl');
  seedRecords(healthyFile, 100);
  const healthyMonitor = createMonitor({ root: healthy, databasePath: path.join(healthy, 'none.db') });
  await healthyMonitor.flush();
  let renames = 0;
  const originalRename = fs.promises.rename;
  fs.promises.rename = (...args) => { renames++; return originalRename(...args); };
  const beforeIdle = fs.readFileSync(healthyFile, 'utf8');
  try { await healthyMonitor.close(); } finally { fs.promises.rename = originalRename; }
  assert.equal(renames, 0, 'nothing to compact when the log already equals the in-memory tail');
  assert.equal(fs.readFileSync(healthyFile, 'utf8'), beforeIdle);
});

test('a threshold record under a sticky storageError is still appended, never compacted over', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-fallback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'monitor.jsonl');
  seedRecords(file, 5249);
  fs.writeFileSync(file, 'BROKEN-LINE\n' + fs.readFileSync(file, 'utf8'), { mode: 0o600 });
  const before = fs.readFileSync(file, 'utf8');
  const monitor = createMonitor({ root, databasePath: path.join(root, 'none.db') });
  monitor.record({ id: 'across', startedAt: '2026-01-02T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
  await monitor.flush();
  const grown = fs.readFileSync(file, 'utf8');
  assert.ok(grown.startsWith(before), 'the degraded log is never rewritten');
  const lines = grown.trim().split('\n');
  assert.equal(lines.length, 5251, 'the threshold-crossing record is appended instead of dropped');
  assert.equal(JSON.parse(lines.at(-1)).id, 'across');
  monitor.record({ id: 'still-appending', startedAt: '2026-01-03T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
  await monitor.flush();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1)).id, 'still-appending');
  assert.equal((await monitor.snapshot()).storageError, true);
  await monitor.close();
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(before), 'close keeps the degraded log untouched');
});

test('a stored record never claims attribution it has not computed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-shape-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'monitor.jsonl');
  const monitor = createMonitor({ root, databasePath: path.join(root, 'missing.db') });
  monitor.record({ id: 'r1', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
  await monitor.flush();
  const stored = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  for (const key of ['sessionId', 'attribution', 'attributionReason', 'messageIds', 'role']) {
    assert.ok(!(key in stored), key + ' is a snapshot-time verdict, not a stored fact');
  }
  // The snapshot that serves the panel still carries the computed verdict.
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.records[0].attribution, 'unassigned');
  assert.equal(snapshot.records[0].sessionId, null);
  // Lines written by an older version keep their placeholders and still load.
  fs.appendFileSync(file, JSON.stringify({ id: 'legacy', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm',
    sessionId: 'stale-session', attribution: 'tool-id', role: 'unknown' }) + '\n');
  const reloaded = createMonitor({ root, databasePath: path.join(root, 'missing.db') });
  const again = await reloaded.snapshot();
  assert.equal(again.records.length, 2);
  assert.equal(again.records.find(record => record.id === 'legacy').attribution, 'unassigned',
    'a stored placeholder is recomputed rather than trusted');
});

test('records without tool ids report not-needed and no-tool-ids without any database work', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-notools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const monitor = createMonitor({ root, databasePath: path.join(root, 'missing.db') });
  monitor.record({ id: 'r1', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.lookupStatus.tools, 'not-needed', 'no tool ids means the database is never queried');
  assert.equal(snapshot.records[0].attributionReason, 'no-tool-ids');
  assert.equal(snapshot.sessionStatus, 'ready');
});

test('a tool lookup failure distinguishes lookup-unavailable from no-tool-ids', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-toolfail-reason-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const monitor = createMonitor({ root, databasePath: path.join(root, 'missing.db') });
  monitor.record({ id: 'r-tool', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p', schemaVersion: 2, toolIds: ['call-a'] });
  monitor.record({ id: 'r-bare', startedAt: '2026-01-01T00:00:01Z', status: 'success', model: 'm', providerId: 'p' });
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.sessionStatus, 'unavailable');
  assert.equal(snapshot.status, 'degraded');
  const toolRecord = snapshot.records.find(r => r.id === 'r-tool');
  const bareRecord = snapshot.records.find(r => r.id === 'r-bare');
  assert.equal(toolRecord.attributionReason, 'lookup-unavailable');
  assert.equal(bareRecord.attributionReason, 'no-tool-ids');
  assert.equal(snapshot.attributionSummary.lookupUnavailable, 1);
  assert.equal(snapshot.attributionSummary.noToolIds, 1);
});

test('ambiguous matches are categorized and attribution counts cover every record', () => {
  const { attributionStats } = require('../src/monitor/store.cjs');
  const rows = [
    { message_id: 'call-x', session_id: 'a' },
    { message_id: 'call-x', session_id: 'b' },
    { message_id: 'call-y', session_id: 'c' },
  ];
  const records = [
    { id: 'r-amb', status: 'success', toolIds: ['call-x'] },
    { id: 'r-none', status: 'success', toolIds: [] },
    { id: 'r-miss', status: 'success', toolIds: ['call-z'] },
  ];
  const out = associate(records, rows);
  assert.equal(out[0].attribution, 'ambiguous');
  assert.equal(out[0].attributionReason, 'ambiguous-match');
  assert.equal(out[1].attributionReason, 'no-tool-ids');
  assert.equal(out[2].attributionReason, 'tool-id-unmatched');
  const assigned = associate([{ id: 'r-ok', status: 'success', toolIds: ['call-y'] }], rows)[0];
  assert.equal(assigned.sessionId, 'c');
  assert.equal(assigned.attribution, 'tool-id');
  assert.equal(assigned.attributionReason, null);
  const stats = attributionStats(out.concat([assigned]));
  assert.deepEqual(stats, { assigned: 1, ambiguous: 1, noToolIds: 1, unmatchedToolIds: 1, lookupUnavailable: 0 });
  assert.equal(Object.values(stats).reduce((a, b) => a + b, 0), 4, 'every record lands in exactly one bucket');
});

test('a missing label row differs from a failed label query, and titles never persist', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-labelstatus-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, 'sessions.db');
  execFileSync('/usr/bin/sqlite3', [db, "CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,last_activity_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT); INSERT INTO tool_call_state VALUES('session-t','call-a');"]);
  const monitor = createMonitor({ root, databasePath: db });
  monitor.record({ id: 'r1', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p', schemaVersion: 2, toolIds: ['call-a'] });
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.sessions[0].sessionId, 'session-t');
  assert.equal(snapshot.sessions[0].title, null);
  assert.equal(snapshot.lookupStatus.labels, 'ready', 'a query that ran with no matching row is ready, not unavailable');
  assert.equal(snapshot.status, 'ready');
  assert.ok(!fs.readFileSync(path.join(root, 'monitor.jsonl'), 'utf8').includes('session-t'), 'session ids never persist into the log');

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-labelfail-'));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  const db2 = path.join(bare, 'sessions.db');
  execFileSync('/usr/bin/sqlite3', [db2, "CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT); INSERT INTO tool_call_state VALUES('session-t','call-a');"]);
  const degraded = createMonitor({ root: bare, databasePath: db2 });
  degraded.record({ id: 'r1', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p', schemaVersion: 2, toolIds: ['call-a'] });
  const fallback = await degraded.snapshot();
  assert.equal(fallback.sessions[0].sessionId, 'session-t');
  assert.equal(fallback.lookupStatus.labels, 'unavailable', 'a sessions-table failure is reported separately');
  assert.equal(fallback.status, 'degraded');
});

test('storageDiagnostics reports safe fixed codes and counters for every failure class', async t => {
  const unreadable = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-diag-load-'));
  t.after(() => fs.rmSync(unreadable, { recursive: true, force: true }));
  const badFile = path.join(unreadable, 'monitor.jsonl');
  fs.writeFileSync(badFile, '{"id":"x"}\n', { mode: 0o600 });
  fs.chmodSync(badFile, 0o000);
  const failed = createMonitor({ root: unreadable, databasePath: path.join(unreadable, 'none.db') });
  const failedSnapshot = await failed.snapshot();
  assert.equal(failedSnapshot.storageError, true);
  assert.deepEqual(failedSnapshot.storageDiagnostics, { code: 'load-unavailable', pendingWrites: 0, failedWrites: 0, persistenceBlocked: true });
  fs.chmodSync(badFile, 0o600);

  const oversized = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-diag-size-'));
  t.after(() => fs.rmSync(oversized, { recursive: true, force: true }));
  fs.writeFileSync(path.join(oversized, 'monitor.jsonl'), 'x'.repeat(33 * 1024 * 1024), { mode: 0o600 });
  const big = createMonitor({ root: oversized, databasePath: path.join(oversized, 'none.db') });
  assert.equal((await big.snapshot()).storageDiagnostics.code, 'load-too-large');

  const readonly = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-diag-append-'));
  const db = path.join(readonly, 'none.db');
  const healthy = createMonitor({ root: readonly, databasePath: db });
  fs.chmodSync(readonly, 0o500);
  t.after(() => { try { fs.chmodSync(readonly, 0o700); } catch {} fs.rmSync(readonly, { recursive: true, force: true }); });
  healthy.record({ id: 'r1', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
  await healthy.flush();
  const snapshot = await healthy.snapshot();
  assert.equal(snapshot.storageDiagnostics.code, 'append-failed');
  assert.equal(snapshot.storageDiagnostics.failedWrites, 1);
  assert.equal(snapshot.storageDiagnostics.persistenceBlocked, false);
  fs.chmodSync(readonly, 0o700);
});

test('publicSnapshot exposes diagnostics through the whitelist and strips secrets', () => {
  const { publicSnapshot } = require('../src/runtime/monitor-client.cjs');
  const record = { schemaVersion: 3, id: 'r1', startedAt: '2026-01-01T00:00:00Z', model: 'm', providerId: 'p', status: 'error',
    attributionReason: 'lookup-unavailable', leak: 'SECRET', toolIds: ['internal'], messageIds: ['internal'] };
  const snapshot = {
    version: 1, status: 'degraded', storageError: true, sessionStatus: 'unavailable',
    lookupStatus: { tools: 'unavailable', labels: 'ready', leak: 'SECRET' },
    storageDiagnostics: { code: 'append-failed', pendingWrites: 0, failedWrites: 2, persistenceBlocked: false, raw: 'ENOENT /secret/path SECRET' },
    summary: { requests: 2, success: 0, error: 0, cancelled: 0, excludedUsageRecords: 0, leak: 'SECRET' },
    attributionSummary: { assigned: 1, ambiguous: 0, noToolIds: 0, unmatchedToolIds: 1, lookupUnavailable: 0, leak: 'SECRET' },
    records: [record],
    sessions: [{ sessionId: 's', title: 't', lastActivityAt: 1, attribution: 'tool-id',
      attributionSummary: { assigned: 0, ambiguous: 0, noToolIds: 0, unmatchedToolIds: 1, lookupUnavailable: 0, leak: 'SECRET' },
      summary: { requests: 1, success: 0, error: 1, cancelled: 0, excludedUsageRecords: 1 }, records: [record] }],
  };
  const pub = publicSnapshot(snapshot);
  assert.deepEqual(pub.lookupStatus, { tools: 'unavailable', labels: 'ready' });
  assert.deepEqual(pub.storageDiagnostics, { code: 'append-failed', pendingWrites: 0, failedWrites: 2, persistenceBlocked: false });
  assert.equal(pub.summary.excludedUsageRecords, 0, 'a real zero survives the whitelist');
  assert.deepEqual(pub.attributionSummary, { assigned: 1, ambiguous: 0, noToolIds: 0, unmatchedToolIds: 1, lookupUnavailable: 0 });
  assert.equal(pub.sessions[0].attributionSummary.unmatchedToolIds, 1);
  assert.equal(pub.records[0].attributionReason, 'lookup-unavailable');
  assert.equal(pub.records[0].toolIds, undefined);
  assert.ok(!JSON.stringify(pub).includes('SECRET'), 'no raw error text, paths or unknown fields leak');
});

test('publicSnapshot accepts legacy snapshots without diagnostics', () => {
  const { publicSnapshot } = require('../src/runtime/monitor-client.cjs');
  const legacy = { version: 1, status: 'ready', storageError: false, sessionStatus: 'ready',
    summary: { requests: 0, success: 0, error: 0, cancelled: 0 }, records: [], sessions: [] };
  const pub = publicSnapshot(legacy);
  assert.equal(pub.status, 'ready');
  assert.equal(pub.lookupStatus == null || pub.lookupStatus.tools == null, true, 'missing diagnostics stay absent');
  assert.equal(pub.storageDiagnostics == null || pub.storageDiagnostics.code == null, true);
});

test('an invalid attributionReason is normalized to null through the client whitelist', () => {
  const { publicSnapshot } = require('../src/runtime/monitor-client.cjs');
  const record = { schemaVersion: 3, id: 'r1', startedAt: '2026-01-01T00:00:00Z', model: 'm', providerId: 'p', status: 'success', attributionReason: 'injected-SECRET' };
  const pub = publicSnapshot({ version: 1, status: 'ready', storageError: false, sessionStatus: 'ready',
    summary: { requests: 1 }, records: [record], sessions: [] });
  assert.equal(pub.records[0].attributionReason, null);
  assert.ok(!JSON.stringify(pub).includes('SECRET'));
});

test('reasoning items in completed output mark hasReasoning and keep tps honest without detail', () => {
  const t = tracker();
  t.at(1000); t.value.event({ type: 'response.output_text.delta', data: { delta: 'visible' } }, false);
  t.at(2000); t.value.event({ type: 'response.completed', data: { response: {
    output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: 'visible' }] }],
    usage: { input_tokens: 100, output_tokens: 40 } } } }, false);
  const record = t.value.finish('success', 200);
  assert.equal(record.hasReasoning, true);
  assert.equal(record.visibleTokens, null);
  assert.equal(record.tps, null);

  const withTokens = tracker();
  withTokens.at(1000); withTokens.value.event({ type: 'response.output_text.delta', data: { delta: 'v' } }, false);
  withTokens.at(1500); withTokens.value.event({ type: 'response.output_item.done', data: { item: { type: 'reasoning', summary: [] } } }, false);
  withTokens.at(2000); withTokens.value.event({ type: 'response.completed', data: { response: {
    usage: { input_tokens: 100, output_tokens: 40, output_tokens_details: { reasoning_tokens: 10 } } } } }, false);
  const detailed = withTokens.value.finish('success', 200);
  assert.equal(detailed.hasReasoning, true);
  assert.equal(detailed.visibleTokens, 30);
  assert.equal(detailed.tps, 30);

  const chat = tracker();
  chat.at(1000); chat.value.event({ data: { choices: [{ delta: { content: 'x' } }] } }, true);
  chat.at(2000); chat.value.event({ data: { choices: [{ message: { reasoning: 'thinking' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } } }, true);
  const chatRecord = chat.value.finish('success', 200);
  assert.equal(chatRecord.hasReasoning, true, 'chat message.reasoning follows the same detection path');
});

test('inconsistent usage is excluded from aggregates but kept in the detail', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-inconsistent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const monitor = createMonitor({ root, databasePath: path.join(root, 'none.db') });
  monitor.record({ id: 'inconsistent', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p',
    schemaVersion: 3, inputTokens: 100, outputTokens: 30, cachedTokens: 200, durationMs: 1000, firstResponseMs: 100 });
  monitor.record({ id: 'partial', startedAt: '2026-01-01T00:00:01Z', status: 'success', model: 'm', providerId: 'p',
    schemaVersion: 3, outputTokens: 30, durationMs: 500 });
  const snapshot = await monitor.snapshot();
  const detail = snapshot.records.find(r => r.id === 'inconsistent');
  assert.equal(detail.usageState, 'inconsistent');
  assert.equal(detail.cachedTokens, 200, 'the raw reported counters stay in the detail row');
  assert.equal(detail.tps, null);
  assert.equal(detail.gatewayTps, null);
  assert.equal(detail.throughputTps, null);
  assert.equal(snapshot.summary.excludedUsageRecords, 1);
  assert.equal(snapshot.summary.inputTokens.value, null, 'an excluded record never contributes to reported counters');
  assert.equal(snapshot.summary.inputTokens.reported, 0);
  assert.equal(snapshot.summary.cachedTokens.reported, 0);
  assert.equal(snapshot.summary.outputTokens.reported, 1, 'a partial record with a legal counter still reports it');
  assert.equal(snapshot.summary.outputTokens.value, 30);

  const direct = summarize([{ id: 'x', status: 'success', inputTokens: 10, cachedTokens: 20, outputTokens: 5 }]);
  assert.equal(direct.excludedUsageRecords, 1, 'summarize detects inconsistency even without a usageState field');
  assert.equal(direct.inputTokens.value, null);
});

test('chat tool-call id fragments merge across chunks and responses keep only the real call id', () => {
  const fragmented = tracker();
  fragmented.value.event({ data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_', function: { name: 'exec' } }] } }] } }, true);
  fragmented.value.event({ data: { choices: [{ delta: { tool_calls: [{ index: 0, id: '123', function: { arguments: '{}' } }] } }] } }, true);
  assert.deepEqual(fragmented.value.finish('success', 200).toolIds, ['call_123'],
    'same-index fragments merge into the final call id');

  const multi = tracker();
  multi.value.event({ data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a' }] } }] } }, true);
  multi.value.event({ data: { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b' }] } }] } }, true);
  assert.deepEqual(multi.value.finish('success', 200).toolIds, ['call_a', 'call_b'],
    'different indexes never merge');

  const responses = tracker();
  responses.value.event({ type: 'response.output_item.added', data: { output_index: 0, item: { type: 'function_call', id: 'item-temp' } } }, false);
  responses.value.event({ type: 'response.output_item.done', data: { output_index: 0, item: { type: 'function_call', call_id: 'call-real', name: 'exec', arguments: '{}' } } }, false);
  assert.deepEqual(responses.value.finish('success', 200).toolIds, ['call-real'],
    'the item-scoped id is replaced by the real call_id at done');
});

test('latest text TPS wins over averages and cancelled usage still counts into throughput', () => {
  const base = tracker().value.finish('success', 200);
  const summary = summarize([
    { ...base, id: 'old', outputTokens: 10, durationMs: 1000, tps: 10, startedAt: '2026-01-01T00:00:00Z' },
    { ...base, id: 'new', outputTokens: 90, durationMs: 3000, tps: 30, startedAt: '2026-01-02T00:00:00Z' },
    { ...base, id: 'cancelled', status: 'cancelled', outputTokens: 20, durationMs: 1000, tps: null },
  ]);
  assert.equal(summary.tps.value, 30, 'the newest successful text TPS is reported, not an average');
  assert.equal(summary.tps.samples, 2, 'cancelled records never enter the text TPS pool');
  assert.equal(summary.throughputTps.samples, 3, 'a cancelled record with legal usage still counts into throughput');
  assert.equal(summary.outputTokens.reported, 3, 'cancelled usage keeps contributing to cost counters');
});

test('invalid diagnostics collapse to null instead of echoing fake zeros', () => {
  const { publicSnapshot } = require('../src/runtime/monitor-client.cjs');
  const pub = publicSnapshot({
    version: 1, status: 'ready', storageError: false, sessionStatus: 'ready',
    lookupStatus: { tools: 'bogus', labels: 'ready' },
    storageDiagnostics: { code: 'unknown-code', pendingWrites: 'many', failedWrites: -1, persistenceBlocked: 'yes' },
    attributionSummary: { assigned: 'x', ambiguous: 0, noToolIds: 0, unmatchedToolIds: 0, lookupUnavailable: 0 },
    retentionLimit: '5000',
    summary: { requests: 0, success: 0, error: 0, cancelled: 0, excludedUsageRecords: 'SECRET' },
    records: [], sessions: [{ sessionId: 's', summary: { requests: 0 }, records: [] }],
  });
  assert.equal(pub.storageDiagnostics, null, 'invalid counters collapse the whole diagnostics object');
  assert.equal(pub.attributionSummary, null, 'any invalid count discards the whole summary');
  assert.equal(pub.sessions[0].attributionSummary, null, 'a missing session summary stays null');
  assert.equal(pub.lookupStatus.tools, null, 'unknown enum values never echo');
  assert.equal(pub.lookupStatus.labels, 'ready');
  assert.equal(pub.retentionLimit, null, 'a string limit is stripped to null');
  assert.equal(pub.summary.excludedUsageRecords, null, 'invalid exclusion counts never echo');
  assert.ok(!JSON.stringify(pub).includes('SECRET'));

  const ok = publicSnapshot({ version: 1, status: 'ready', storageError: false, sessionStatus: 'ready',
    retentionLimit: 5000,
    storageDiagnostics: { code: 'made-up', pendingWrites: 0, failedWrites: 0, persistenceBlocked: true },
    summary: { requests: 0 }, records: [], sessions: [] });
  assert.equal(ok.retentionLimit, 5000);
  assert.equal(ok.storageDiagnostics.code, null, 'an unknown code strips to null but keeps the object');
  assert.equal(ok.storageDiagnostics.persistenceBlocked, true);
});

test('a failing fallback append under a sticky storageError reports append-failed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-fallback-fail-'));
  const file = path.join(root, 'monitor.jsonl');
  const lines = [];
  for (let i = 0; i < 5249; i++) lines.push(JSON.stringify({ id: 'r' + i, startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p' }));
  lines.push('not-json');
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  const monitor = createMonitor({ root, databasePath: path.join(root, 'none.db') });
  fs.chmodSync(file, 0o400);
  t.after(() => { try { fs.chmodSync(file, 0o600); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  monitor.record({ id: 'fresh', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
  await monitor.flush();
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.storageDiagnostics.code, 'append-failed', 'the fallback append reports its own code, not compact-failed');
  assert.equal(snapshot.storageDiagnostics.failedWrites, 1);
  fs.chmodSync(file, 0o600);
});

test('a frozen error from a fallback append still reports the fixed append-failed code', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-frozen-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'monitor.jsonl');
  const lines = [];
  for (let i = 0; i < 5249; i++) lines.push(JSON.stringify({ id: 'r' + i, startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p' }));
  lines.push('not-json');
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  const originalBytes = fs.readFileSync(file, 'utf8');
  const monitor = createMonitor({ root, databasePath: path.join(root, 'none.db') });
  t.mock.method(fs.promises, 'appendFile', () => Promise.reject(Object.freeze(new Error('SECRET frozen failure'))));
  monitor.record({ id: 'fresh', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
  await monitor.flush();
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.storageDiagnostics.code, 'append-failed');
  assert.equal(snapshot.storageDiagnostics.failedWrites, 1);
  assert.ok(!JSON.stringify(snapshot).includes('SECRET'), 'the frozen error text never surfaces');
  assert.equal(fs.readFileSync(file, 'utf8'), originalBytes, 'the original log is untouched');
});

test('attribution never queries the unindexed message_nodes side', async t => {
  const vm = require('node:vm');
  const filename = path.resolve('src/monitor/store.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const queries = [];
  const realExecFile = require('node:child_process').execFile;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, __dirname: path.dirname(filename),
    process, Buffer, URL, AbortController, setTimeout, clearTimeout, console, performance,
    require(name) {
      if (name.startsWith('.')) return require(path.resolve(path.dirname(filename), name));
      if (name === 'node:child_process') return { execFile: (file, args, options, callback) => {
        const child = realExecFile(file, args, options, callback);
        const original = child.stdin.end.bind(child.stdin);
        child.stdin.end = input => { queries.push(String(input)); return original(input); };
        return child;
      } };
      return require(name);
    } }, { filename });
  const { createMonitor } = module.exports;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-sqlcap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, 'sessions.db');
  execFileSync('/usr/bin/sqlite3', [db, "CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,last_activity_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT); CREATE TABLE message_nodes(session_id TEXT,chat_message TEXT); INSERT INTO sessions VALUES('session-t','会话',300); INSERT INTO tool_call_state VALUES('session-t','call-a'); INSERT INTO message_nodes VALUES('session-t','{\"message_id\":\"r-x\"}');"]);
  const plain = createMonitor({ root, databasePath: db });
  plain.record({ id: 'r-x', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p', schemaVersion: 2, toolIds: ['call-a'] });
  const snapshot = await plain.snapshot();
  assert.equal(snapshot.records[0].sessionId, 'session-t', 'the indexed tool branch attributes');
  assert.ok(queries.length > 0);
  assert.ok(queries.some(sql => sql.includes('tool_call_state')));
  assert.ok(queries.some(sql => sql.includes('FROM sessions')));
  // `json_extract(chat_message, '$.message_id')` has no index to use and took ~31s
  // on the real 8.1 GB database, so nothing may query that table — not even behind
  // an opt-in that could never finish.
  assert.ok(queries.every(sql => !sql.includes('message_nodes')), 'message_nodes is never queried at all');

  const seen = queries.length;
  const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-sqlnone-'));
  t.after(() => fs.rmSync(bareRoot, { recursive: true, force: true }));
  const bare = createMonitor({ root: bareRoot, databasePath: path.join(bareRoot, 'missing.db') });
  bare.record({ id: 'r-no-tools', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
  await bare.snapshot();
  assert.equal(queries.length, seen, 'a record without tool ids never issues SQL');
});

test('authored numeric edge cases stay exact through normalize and summarize', async t => {
  const zeroRecord = { id: 'zero', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', schemaVersion: 3,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, durationMs: 1000, hasTools: false, hasReasoning: false };
  const zero = summarize([zeroRecord]);
  assert.equal(zero.inputTokens.value, 0); assert.equal(zero.inputTokens.reported, 1);
  assert.equal(zero.outputTokens.value, 0); assert.equal(zero.outputTokens.reported, 1);
  assert.equal(zero.cachedTokens.value, 0); assert.equal(zero.cachedTokens.reported, 1);
  assert.equal(zero.reasoningTokens.value, 0); assert.equal(zero.reasoningTokens.reported, 1);
  assert.equal(zero.excludedUsageRecords, 0);
  assert.equal(zero.throughputTps.value, 0);

  const bad = summarize([
    { ...zeroRecord, id: 'a', inputTokens: 10, outputTokens: 5, cachedTokens: 20 },
    { ...zeroRecord, id: 'b', inputTokens: 10, outputTokens: 5, reasoningTokens: 6 },
  ]);
  assert.equal(bad.excludedUsageRecords, 2);
  for (const key of ['inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens']) {
    assert.equal(bad[key].value, null, key + ' stays null, never a fake zero');
    assert.equal(bad[key].reported, 0);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-numeric-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const monitor = createMonitor({ root, databasePath: path.join(root, 'none.db') });
  monitor.record({ id: 'legacy', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', schemaVersion: 2,
    outputTokens: 40, hasTools: false, hasReasoning: true, reasoningTokens: null, visibleTokens: 40, decodeMs: 1000 });
  monitor.record({ id: 'flags', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', schemaVersion: 2,
    outputTokens: 40, visibleTokens: 40, decodeMs: 1000 });
  const snapshot = await monitor.snapshot();
  const legacy = snapshot.records.find(r => r.id === 'legacy');
  assert.equal(legacy.visibleTokens, null, 'a persisted visibleTokens value cannot fabricate a body TPS when reasoning detail is missing');
  assert.equal(legacy.tps, null);
  const flags = snapshot.records.find(r => r.id === 'flags');
  assert.equal(flags.hasTools, null, 'a missing flag is unknown, never defaulted false');
  assert.equal(flags.hasReasoning, null);
  assert.equal(flags.tps, null);
});

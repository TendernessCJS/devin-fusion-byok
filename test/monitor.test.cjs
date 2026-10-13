'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createMonitor, createTracker, usageOf, associate, summarize } = require('../src/runtime/monitor.cjs');
function tracker() {
  let clock = 0;
  const value = createTracker({ id: 'response-1', request: { messages: [{ messageId: 'user-1', content: 'PRIVATE' }] }, route: { model: 'test' }, provider: { id: 'p', apiKey: 'SECRET' }, now: () => clock });
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
  assert.ok(!JSON.stringify(record).includes('SECRET')); assert.ok(!JSON.stringify(record).includes('PRIVATE'));
});
test('empty events do not count as output; tool-only and cancellation are explicit', () => {
  const t = tracker(); t.at(10); t.value.event({ data: { choices: [{ delta: { role: 'assistant', content: '' } }] } }, true);
  t.at(20); t.value.event({ type: 'response.function_call_arguments.delta', data: { delta: '{}' } }, false);
  t.at(30); const record = t.value.finish('cancelled', 200);
  assert.equal(record.firstOutputMs, 20); assert.equal(record.firstTextMs, null);
  assert.equal(record.tps, null); assert.equal(record.inputTokens, null); assert.equal(record.usageComplete, false);
});
test('exact response identity outranks shared history and ambiguity never chooses a session', () => {
  const r = tracker().value.finish('success', 200);
  const rows = [{ message_id: 'user-1', session_id: 'a' }, { message_id: 'user-1', session_id: 'b' }];
  assert.equal(associate([r], rows)[0].attribution, 'unassigned');
  assert.equal(associate([r], rows)[0].sessionId, null);
  rows.push({ message_id: 'response-1', session_id: 'b' });
  const result = associate([r], rows)[0];
  assert.equal(result.sessionId, 'b'); assert.equal(result.attribution, 'response-id');
  assert.equal(result.messageIds, undefined);
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
  t.at(200); t.value.event({ type: 'response.output_item.added', data: { item: { type: 'function_call', call_id: 'tool-1', name: 'exec' } } }, false);
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
  execFileSync('/usr/bin/sqlite3', [db, "CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,last_activity_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT); CREATE TABLE message_nodes(session_id TEXT,chat_message TEXT); INSERT INTO sessions VALUES('session-a','会话标题甲',1791793602); INSERT INTO message_nodes VALUES('session-a','{\"message_id\":\"response-1\"}');"]);
  const monitor = createMonitor({ root, databasePath: db });
  const record = tracker().value.finish('success', 200);
  monitor.record({ ...record, secret: 'SECRET' }); monitor.record(record);
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.records.length, 1); assert.equal(snapshot.sessions[0].sessionId, 'session-a');
  assert.equal(snapshot.sessions[0].title, '会话标题甲');
  assert.equal(snapshot.sessions[0].lastActivityAt, 1791793602, 'epoch seconds pass through unchanged');
  assert.equal(snapshot.records[0].attribution, 'response-id');
  assert.ok(!JSON.stringify(snapshot).includes('messageIds'));
  const file = path.join(root, 'monitor.jsonl');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.ok(!fs.readFileSync(file, 'utf8').includes('SECRET'));
  assert.equal((await createMonitor({ root, databasePath: db }).snapshot()).records.length, 1);
  const missing = await createMonitor({ root, databasePath: path.join(root, 'missing.db') }).snapshot();
  assert.equal(missing.sessionStatus, 'ready', 'without tool ids only the supplemental branch runs, and its failure is isolated');
  assert.equal(missing.records[0].sessionId, null);
});

test('a missing message_nodes table no longer sinks tool-id attribution', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-isolation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, 'sessions.db');
  execFileSync('/usr/bin/sqlite3', [db, "CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,last_activity_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT); INSERT INTO sessions VALUES('session-t','工具会话',300); INSERT INTO tool_call_state VALUES('session-t','call-a');"]);
  const monitor = createMonitor({ root, databasePath: db });
  monitor.record({ id: 'r1', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p', schemaVersion: 2, toolIds: ['call-a'] });
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.sessionStatus, 'ready', 'the unindexed message branch must not sink indexed tool-id matches');
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

test('message-id attribution still resolves sessions when no tool ids are present', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-message-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, 'sessions.db');
  execFileSync('/usr/bin/sqlite3', [db, "CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,last_activity_at INTEGER); CREATE TABLE message_nodes(session_id TEXT,chat_message TEXT); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT); INSERT INTO sessions VALUES('session-m','消息会话',400); INSERT INTO message_nodes VALUES('session-m','{\"message_id\":\"r-m\"}');"]);
  const monitor = createMonitor({ root, databasePath: db });
  monitor.record({ id: 'r-m', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.sessionStatus, 'ready');
  assert.equal(snapshot.sessions[0].sessionId, 'session-m');
  assert.equal(snapshot.sessions[0].title, '消息会话');
});

test('session labels order newest first, tolerate missing rows and survive lookup failure', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-labels-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, 'sessions.db');
  execFileSync('/usr/bin/sqlite3', [db, "CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,last_activity_at INTEGER); CREATE TABLE message_nodes(session_id TEXT,chat_message TEXT); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT); INSERT INTO sessions VALUES('session-old','旧会话',100),('session-new','新会话',200); INSERT INTO message_nodes VALUES('session-old','{\"message_id\":\"r-old\"}'),('session-new','{\"message_id\":\"r-new\"}'),('session-ghost','{\"message_id\":\"r-ghost\"}');"]);
  const monitor = createMonitor({ root, databasePath: db });
  for (const id of ['r-old', 'r-new', 'r-ghost', 'r-lone']) monitor.record({ id, startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.sessionStatus, 'ready');
  assert.deepEqual(snapshot.sessions.map(s => [s.sessionId, s.title, s.lastActivityAt]),
    [['session-new', '新会话', 200], ['session-old', '旧会话', 100], ['session-ghost', null, null], [null, null, null]],
    'newest activity first, unlabeled sessions next, the unassigned bucket last');

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-nolabels-'));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  const db2 = path.join(bare, 'sessions.db');
  execFileSync('/usr/bin/sqlite3', [db2, "CREATE TABLE message_nodes(session_id TEXT,chat_message TEXT); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT); INSERT INTO message_nodes VALUES('session-x','{\"message_id\":\"r-x\"}');"]);
  const degraded = createMonitor({ root: bare, databasePath: db2 });
  degraded.record({ id: 'r-x', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
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
  execFileSync('/usr/bin/sqlite3', [db, `CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,last_activity_at INTEGER); CREATE TABLE message_nodes(session_id TEXT,chat_message TEXT); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT); INSERT INTO sessions VALUES('session-long','${longTitle}',300); INSERT INTO message_nodes VALUES('session-long','{"message_id":"r-long"}');`]);
  const monitor = createMonitor({ root, databasePath: db });
  monitor.record({ id: 'r-long', startedAt: '2026-01-01T00:00:00Z', status: 'success', model: 'm', providerId: 'p' });
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

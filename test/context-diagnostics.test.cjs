'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createContextDiagnostics, STALE_AFTER_MS } = require('../src/runtime/host/context-diagnostics.cjs');
test('diagnostics are private, isolated, bounded snapshots carrying ids, numbers and counters only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-diagnostics-'));
  const options = { root, version: '0.3.26', readStatus: () => ({ state: 'observing', connections: 1, usageUpdates: 2, usageRejections: { 'invalid-used': 1, 'missing-size': 2, 'zero-size': -1, 'never-persist': 123 }, secret: 'never-persist' }), snapshot: () => [{ sessionId: 'sess-diag', lead: { used: 123 }, subagents: [{}] }], intervalMs: 60000 };
  const first = createContextDiagnostics({ ...options, pid: 123 });
  const second = createContextDiagnostics({ ...options, pid: 456 });
  try {
    const file = path.join(root, 'context-diagnostics', '123.json');
    const raw = fs.readFileSync(file, 'utf8'), data = JSON.parse(raw);
    assert.equal(data.connections, 1); assert.equal(data.leadSessions, 1); assert.equal(data.subagentUsages, 1);
    assert.equal(data.sessionUpdates, null); assert.ok(!raw.includes('never-persist'));
    assert.deepEqual(Object.keys(data).sort(), ['acceptedUsageUpdates', 'connections', 'leadSessions', 'pid', 'pluginVersion',
      'registrations', 'rejectedUsageUpdates', 'schemaVersion', 'sessionUpdates', 'state', 'subagentDetails',
      'subagentDetailsTruncated', 'subagentUsages', 'usageRejections', 'usageUpdates', 'writtenAt'],
      'the diagnostics document carries a fixed set of counters, ids and bounded detail');
    assert.deepEqual(Object.keys(data.subagentDetails[0]).sort(), ['lead', 'modelUid', 'sessionId', 'subagents']);
    assert.deepEqual(Object.keys(data.subagentDetails[0].subagents[0]).sort(), ['parentAgentId', 'runId', 'size', 'used'],
      'subagent detail rows carry ids and numbers only, no session payload');
    assert.deepEqual(data.usageRejections, { 'invalid-session-id': null, 'invalid-used': 1, 'missing-size': 2,
      'zero-size': null, 'invalid-parent-id': null, 'invalid-run-id': null }, 'the vocabulary matches the observer exactly');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    first.refresh(); assert.equal(fs.readdirSync(path.dirname(file)).length, 2);
    first.dispose(); assert.equal(JSON.parse(fs.readFileSync(file)).state, 'disposed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(file), '456.json'))).state, 'observing');
  } finally { first.dispose(); second.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('diagnostic read failures never escape into the extension', () => {
  const handle = createContextDiagnostics({ root: '/unused', version: 'bad', readStatus() { throw Error('private'); }, snapshot: () => [], intervalMs: 60000 });
  assert.equal(handle.refresh(), false); handle.dispose();
});

test('residue from processes that are gone is swept while live and recent files survive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-diagnostics-sweep-'));
  try {
    const dir = path.join(root, 'context-diagnostics');
    fs.mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - STALE_AFTER_MS - 60000);
    // A real pid that has already exited: every window used to leave one of these
    // behind forever (192 had accumulated, one per activation).
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const deadFile = path.join(dir, `${dead}.json`);
    // A file that is not a pid file at all is never a candidate, and neither is a
    // pid that could still be starting up: its file is merely absent for now.
    const foreign = path.join(dir, 'notes.txt');
    const recent = path.join(dir, '424242.json');
    const temporary = path.join(dir, '424243.json.tmp');
    for (const file of [deadFile, foreign, recent, temporary]) fs.writeFileSync(file, '{}');
    for (const file of [deadFile, foreign, temporary]) fs.utimesSync(file, old, old);

    const handle = createContextDiagnostics({ root, version: '0.3.45', readStatus: () => ({ state: 'observing' }),
      snapshot: () => [], pid: process.pid, intervalMs: 60000 });
    try {
      assert.equal(fs.existsSync(deadFile), false, 'a dead, stale pid file is removed');
      assert.equal(fs.existsSync(temporary), false, 'an old leftover temp file is removed');
      assert.equal(fs.existsSync(recent), true, 'a recent file survives even when its pid is not running');
      assert.equal(fs.existsSync(foreign), true, 'non-pid files are never touched');
      assert.equal(fs.existsSync(path.join(dir, `${process.pid}.json`)), true, 'our own file is written');
    } finally { handle.dispose(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('subagent details record bounded ids and numbers only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-diagnostics-'));
  const sub = (parentAgentId, runId, used, size) => ({ parentAgentId, runId, used, size });
  const snapshot = [
    { sessionId: 's1', modelUid: 'm1', lead: { used: 10, size: 100 }, subagents: [sub('p1', 'run-a', 5, 50), sub('p1', undefined, 6, 60)] },
    { sessionId: 's2', modelUid: 'm2', lead: null },
    { sessionId: 's3', modelUid: 'm3', lead: { used: 1, size: 2 }, subagents: Array.from({ length: 9 }, (_, i) => sub('p', 'r' + i, i, 10)) },
    { sessionId: 's4', modelUid: 'm4', lead: { used: 1, size: 2 }, subagents: [sub('p', 'r', 1, 10)] },
    { sessionId: 's5', modelUid: 'm5', lead: { used: 1, size: 2 }, subagents: [sub('p', 'r', 1, 10)] },
  ];
  const handle = createContextDiagnostics({ root, version: '0.3.45', readStatus: () => ({}), snapshot: () => snapshot, pid: 321, intervalMs: 60000 });
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, 'context-diagnostics', '321.json'), 'utf8'));
    assert.equal(data.subagentUsages, 13);
    assert.equal(data.subagentDetailsTruncated, true, 'five sessions and a nine-row session both trip the bounds');
    assert.equal(data.subagentDetails.length, 4, 'sessions are bounded at four');
    assert.equal(data.subagentDetails[0].sessionId, 's1');
    assert.equal(data.subagentDetails[0].modelUid, 'm1');
    assert.deepEqual(data.subagentDetails[0].lead, { used: 10, size: 100 });
    assert.deepEqual(data.subagentDetails[0].subagents[0], { parentAgentId: 'p1', runId: 'run-a', used: 5, size: 50 });
    assert.equal(data.subagentDetails[0].subagents[1].runId, null, 'a missing runId serializes as null, not undefined');
    assert.equal(data.subagentDetails[1].subagents.length, 8, 'rows are bounded per session');
  } finally { handle.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('subagent details stay empty and untruncated without subagent usage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-diagnostics-'));
  const handle = createContextDiagnostics({ root, version: '0.3.45', readStatus: () => ({}),
    snapshot: () => [{ sessionId: 's', modelUid: 'm', lead: { used: 1, size: 2 } }], pid: 322, intervalMs: 60000 });
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, 'context-diagnostics', '322.json'), 'utf8'));
    assert.deepEqual(data.subagentDetails, []);
    assert.equal(data.subagentUsages, 0);
    assert.equal(data.subagentDetailsTruncated, false);
  } finally { handle.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('subagent details stay untruncated within the bounds', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-diagnostics-'));
  const handle = createContextDiagnostics({ root, version: '0.3.45', readStatus: () => ({}),
    snapshot: () => [{ sessionId: 's', modelUid: 'm', lead: { used: 1, size: 2 },
      subagents: [{ parentAgentId: 'p', runId: 'r', used: 1, size: 2 }] }], pid: 323, intervalMs: 60000 });
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, 'context-diagnostics', '323.json'), 'utf8'));
    assert.equal(data.subagentDetailsTruncated, false);
    assert.deepEqual(data.subagentDetails, [{ sessionId: 's', modelUid: 'm', lead: { used: 1, size: 2 },
      subagents: [{ parentAgentId: 'p', runId: 'r', used: 1, size: 2 }] }]);
  } finally { handle.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('diagnostics counts only real subagents, never the root-scoped duplicate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-diagnostics-'));
  const { createContextState } = require('../src/runtime/host/context-state.cjs');
  const state = createContextState();
  state.observe('s', { sessionUpdate: 'usage_update', used: 100, size: 1000, _meta: { 'cognition.ai/subagent_context': { parentAgentId: 'root' } } });
  state.observe('s', { sessionUpdate: 'usage_update', used: 80, size: 262, _meta: { 'cognition.ai/subagent_context': { parentAgentId: 'sidekick' } } });
  const handle = createContextDiagnostics({ root, version: '0.3.45', readStatus: () => ({}), snapshot: () => state.snapshot(), pid: 324, intervalMs: 60000 });
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, 'context-diagnostics', '324.json'), 'utf8'));
    assert.equal(data.subagentUsages, 1, 'the root-scoped duplicate of the lead usage is not a subagent');
    assert.deepEqual(data.subagentDetails[0].subagents, [{ parentAgentId: 'sidekick', runId: null, used: 80, size: 262 }]);
  } finally { handle.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

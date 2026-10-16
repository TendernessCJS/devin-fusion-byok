'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createContextDiagnostics, STALE_AFTER_MS } = require('../src/runtime/context-diagnostics.cjs');
test('diagnostics are private, isolated, bounded snapshots without session payloads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-diagnostics-'));
  const options = { root, version: '0.3.26', readStatus: () => ({ state: 'observing', connections: 1, usageUpdates: 2, usageRejections: { 'invalid-used': 1, 'invalid-size': -1, 'never-persist': 123 }, secret: 'never-persist' }), snapshot: () => [{ sessionId: 'never-persist', lead: { used: 123 }, subagents: [{}] }], intervalMs: 60000 };
  const first = createContextDiagnostics({ ...options, pid: 123 });
  const second = createContextDiagnostics({ ...options, pid: 456 });
  try {
    const file = path.join(root, 'context-diagnostics', '123.json');
    const raw = fs.readFileSync(file, 'utf8'), data = JSON.parse(raw);
    assert.equal(data.connections, 1); assert.equal(data.leadSessions, 1); assert.equal(data.subagentUsages, 1);
    assert.equal(data.sessionUpdates, null); assert.ok(!raw.includes('never-persist')); assert.ok(!raw.includes('"used":'));
    assert.deepEqual(data.usageRejections, { 'invalid-session-id': null, 'invalid-used': 1, 'invalid-size': null, 'invalid-parent-id': null, 'invalid-run-id': null });
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

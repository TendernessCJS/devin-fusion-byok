'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { openUpstream } = require('../src/protocol/request-policy.cjs');

const retryable = () => { const e = new Error('socket closed'); e.code = 'ECONNRESET'; return e; };

function fixture({ sends = [], canRetry = error => error.code === 'ECONNRESET', deadlineMs = 600000, readDetail = async () => '' } = {}) {
  const calls = [], records = [], connectAttempts = [];
  let i = 0;
  const send = async body => { calls.push(body); const next = sends[Math.min(i++, sends.length - 1)]; if (next instanceof Error) throw next; return next; };
  const retry = {
    deadlineMs,
    nextPause: () => 1,
    pause: async () => {},
    canRetry,
    isAborted: () => false,
  };
  return { calls, records, connectAttempts, send, retry, readDetail,
    open: options => openUpstream({ chat: true, anthropic: false, provider: {}, model: 'm',
      cacheBreakpoints: false, cacheSupport: null, send, readDetail,
      record: event => records.push(event), connectAttempts, retry, ...options }) };
}

const ok = () => ({ ok: true, status: 200 });

test('three connection failures then success sends four times and logs recovery', async () => {
  const f = fixture({ sends: [retryable(), retryable(), retryable(), ok()] });
  const upstream = await f.open({ body: {} });
  assert.equal(upstream.status, 200);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.connectAttempts.map(a => a.attempt), [1, 2, 3]);
  assert.deepEqual(f.records.filter(e => e.event === 'upstream-retry-recovered'), [
    { event: 'upstream-retry-recovered', model: 'm', attempt: 3, attempts: 4 }]);
  assert.equal(f.records.filter(e => e.event === 'upstream-retry').length, 3);
});

test('a degrade resend never enters the connect-retry loop', async () => {
  const f = fixture({
    sends: [{ ok: false, status: 400 }, retryable()],
    readDetail: async () => 'invalid tool_choice',
  });
  await assert.rejects(
    f.open({ body: { tool_choice: 'required' } }),
    error => error.code === 'ECONNRESET');
  assert.equal(f.calls.length, 2, 'the degraded resend throws straight through — no retry');
  assert.equal(f.calls[1].tool_choice, 'auto');
  assert.deepEqual(f.records.filter(e => e.event === 'provider-degraded'), []);
});

test('a zero retry deadline sends exactly once', async () => {
  const f = fixture({ sends: [retryable(), ok()], deadlineMs: 0 });
  await assert.rejects(f.open({ body: {} }), error => error.code === 'ECONNRESET');
  assert.equal(f.calls.length, 1);
});

test('a non-400 failure is returned without any degrade resend', async () => {
  const f = fixture({ sends: [{ ok: false, status: 500 }] });
  const upstream = await f.open({ body: { tool_choice: 'required', store: true } });
  assert.equal(upstream.status, 500);
  assert.equal(f.calls.length, 1);
  assert.equal(f.records.length, 0);
});

test('tool_choice wins over the store branch when both match', async () => {
  const f = fixture({
    sends: [{ ok: false, status: 400 }, ok()],
    readDetail: async () => 'tool_choice and store are both rejected',
  });
  const upstream = await f.open({ body: { tool_choice: 'required', store: true } });
  assert.equal(upstream.status, 200);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].tool_choice, 'auto');
  assert.equal(f.calls[1].store, true, 'the first matching branch only degrades the choice');
  assert.deepEqual(f.records.filter(e => e.event === 'provider-degraded'), [
    { event: 'provider-degraded', model: 'm', reason: 'tool-choice' }]);
});

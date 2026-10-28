'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createManager } = require('../src/panel/manager.cjs');
const { fixture, fakeScheduler, planProgressFixture } = require('./helpers/auto-continue-fixture.cjs');

test('plan tracking v1/v2: pending->pending->completed sends exactly 2 continues then stops', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());

  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') {
        promptCount++;
        // The first two turns hit the turn budget (the continue trigger); the
        // final turn finishes normally — `end_turn` never continues. Truncated
        // turns emit text so the empty-truncation guard does not stop them.
        if (promptCount <= 2) connector.forwardClientRequest({ method: 'session/update',
          params: { sessionId: req.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } } } });
        return Promise.resolve({ stopReason: promptCount <= 2 ? 'max_turn_requests' : 'end_turn' });
      }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const p = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-plan-multi', prompt: [{ type: 'text', text: 'do task' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-plan-multi',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Step 1', status: 'pending' },
          { content: 'Step 2', status: 'pending' }
        ]
      }
    }
  });

  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.advance(2000);
  assert.equal(promptCount, 2);

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-plan-multi',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Step 1', status: 'completed' },
          { content: 'Step 2', status: 'in_progress' }
        ]
      }
    }
  });

  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.advance(4000);
  assert.equal(promptCount, 3);

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-plan-multi',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Step 1', status: 'completed' },
          { content: 'Step 2', status: 'completed' }
        ]
      }
    }
  });

  const res = await p;
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(scheduler.pendingCount(), 0);
  scheduler.advance(10000);
  assert.equal(promptCount, 3);
});

test('normal end_turn with zero pending plan does not continue', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());

  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') {
        promptCount++;
        return Promise.resolve({ stopReason: 'end_turn' });
      }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const p = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-plan-none', prompt: [{ type: 'text', text: 'hi' }] }
  });

  const res = await p;
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(promptCount, 1);
});

test('plan completion while timer is pending cancels continuation and resolves v1 promise', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());

  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') {
        promptCount++;
        connector.forwardClientRequest({ method: 'session/update',
          params: { sessionId: req.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } } } });
        return Promise.resolve({ stopReason: 'max_turn_requests' });
      }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const p = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-plan-cancel-timer', prompt: [{ type: 'text', text: 'run' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-plan-cancel-timer',
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'Task', status: 'pending' }]
      }
    }
  });

  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1);

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-plan-cancel-timer',
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'Task', status: 'completed' }]
      }
    }
  });

  assert.equal(scheduler.pendingCount(), 0);
  const res = await p;
  assert.equal(res.stopReason, 'max_turn_requests');
  scheduler.advance(10000);
  assert.equal(promptCount, 1);
});

test('incoming permission request disallows retry and clears pending timer', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());

  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') connector.forwardClientRequest({ method: 'session/update',
        params: { sessionId: req.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } } } });
      return Promise.resolve({ stopReason: 'max_turn_requests' });
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const p = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-perm', prompt: [{ type: 'text', text: 'perm' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-perm',
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'Step', status: 'pending' }]
      }
    }
  });

  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1);

  connector.forwardClientRequest({
    method: 'session/request_permission',
    params: { sessionId: 's-perm' }
  });

  assert.equal(scheduler.pendingCount(), 0);
  const res = await p;
  assert.equal(res.stopReason, 'max_turn_requests');
});

test('transient HTTP 429 retries whereas 401 does not', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: true, untilPlanComplete: false }),
    scheduler
  });
  t.after(() => handle.dispose());

  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest() { return Promise.resolve({ stopReason: 'end_turn' }); },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const p429 = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-429', prompt: [{ type: 'text', text: 'hi' }] }
  });
  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-429',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Provider returned HTTP 429.' } }
    }
  });
  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1);

  const p401 = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-401', prompt: [{ type: 'text', text: 'hi' }] }
  });
  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-401',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Provider returned HTTP 401.' } }
    }
  });
  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1); // Only s-429 pending
});

test('manager setAutoContinueUntilPlanComplete boolean validation and public state', async () => {
  let savedConfig = { enabled: true, providers: [] };
  const manager = createManager({
    read: () => savedConfig,
    write: c => { savedConfig = c; }
  });

  const s0 = manager.state();
  assert.equal(s0.autoContinueUntilPlanComplete, false);

  await assert.rejects(manager.dispatch('setAutoContinueUntilPlanComplete', { enabled: 'true' }), /完成待办/);
  await assert.rejects(manager.dispatch('setAutoContinueUntilPlanComplete', { enabled: 1 }), /完成待办/);

  const s1 = await manager.dispatch('setAutoContinueUntilPlanComplete', { enabled: true });
  assert.equal(s1.autoContinueUntilPlanComplete, true);
  assert.equal(savedConfig.autoContinueUntilPlanComplete, true);

  const s2 = await manager.dispatch('setAutoContinueUntilPlanComplete', { enabled: false });
  assert.equal(s2.autoContinueUntilPlanComplete, false);
  assert.equal(savedConfig.autoContinueUntilPlanComplete, false);
});

test('malformed, oversized, and invalid plan entries remove eligibility cleanly', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());

  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') {
        promptCount++;
        return Promise.resolve({ stopReason: 'end_turn' });
      }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const p = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-bad-plan', prompt: [{ type: 'text', text: 'start' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-bad-plan',
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'test', status: 'unknown_status' }]
      }
    }
  });

  const res = await p;
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(promptCount, 1);
});

test('terminal HTTP 401 and invalid format suppress plan continuation', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());

  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') {
        promptCount++;
        return Promise.resolve({ stopReason: 'end_turn' });
      }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const p = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-plan-blocked', prompt: [{ type: 'text', text: 'start' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-plan-blocked',
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'Valid pending task', status: 'pending' }]
      }
    }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-plan-blocked',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Provider returned HTTP 401.' }
      }
    }
  });

  const res = await p;
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(promptCount, 1);
});

test('legacy ext/method _session/elicitation and finishedOutcome cancel pending timer', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());

  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') connector.forwardClientRequest({ method: 'session/update',
        params: { sessionId: req.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } } } });
      return Promise.resolve({ stopReason: 'max_turn_requests' });
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const p = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-ext-elicit', prompt: [{ type: 'text', text: 'run' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-ext-elicit',
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'Pending', status: 'pending' }]
      }
    }
  });

  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1);

  connector.forwardClientRequest({
    method: 'ext/method',
    params: {
      method: '_session/elicitation',
      params: { sessionId: 's-ext-elicit' }
    }
  });

  assert.equal(scheduler.pendingCount(), 0);
  const res = await p;
  assert.equal(res.stopReason, 'max_turn_requests');
});

for (const protocolVersion of [1, 2]) {
  for (const variant of ['no-update', 'identical', 'reordered', 'new-plan-id', 'error-recovery']) {
    test(`v${protocolVersion} stops stale plan continuation after ${variant}`, { timeout: 1000 }, async t => {
      const f = planProgressFixture(t, protocolVersion);
      const pending = [
        { content: 'Reset verified', status: 'completed' },
        { content: 'Blocked; needs user confirmation', status: 'in_progress' }
      ];
      const p = f.prompt();
      f.plan(pending, variant === 'new-plan-id' ? 'old' : undefined);
      await f.finish(variant === 'error-recovery', 'max_turn_requests');
      assert.equal(f.scheduler.pendingCount(), 1);
      f.scheduler.advance(2000);
      assert.equal(f.calls.length, 2);
      if (variant === 'identical') f.plan(pending);
      if (variant === 'reordered') f.plan([...pending].reverse());
      if (variant === 'new-plan-id') f.plan(pending, 'new');
      await f.finish(false, 'max_turn_requests');
      assert.equal(f.scheduler.pendingCount(), 0);
      assert.equal(f.handle.status().activeSessions, 0);
      const result = await p;
      if (protocolVersion === 1) assert.equal(result.stopReason, 'max_turn_requests');
      const stopped = f.logs.filter(log => log.event === 'auto-continue-stopped');
      assert.equal(stopped.length, 1);
      assert.equal(stopped[0].data.reason, 'plan-no-progress');
      assert.equal(stopped[0].data.attempts, variant === 'error-recovery' ? 0 : 1);
      assert.deepEqual(Object.keys(stopped[0].data).sort(), ['attempts', 'reason']);
      assert.equal(JSON.stringify(f.logs).includes('Blocked'), false);
      f.scheduler.advance(60000);
      assert.equal(f.calls.length, 2);

      const next = f.prompt();
      f.plan(pending);
      await f.finish(false, 'max_turn_requests');
      assert.equal(f.scheduler.pendingCount(), 1);
      f.scheduler.advance(2000);
      assert.equal(f.calls.length, 4);
      f.plan(pending.map(entry => ({ ...entry, status: 'completed' })));
      await f.finish();
      await next;
      assert.equal(f.scheduler.pendingCount(), 0);
      assert.equal(f.handle.status().activeSessions, 0);
    });
  }

  test(`v${protocolVersion} permits semantic progress with unchanged pending count`, { timeout: 1000 }, async t => {
    const f = planProgressFixture(t, protocolVersion);
    const p = f.prompt();
    f.plan([{ content: 'Work', status: 'pending' }]);
    await f.finish(false, 'max_turn_requests');
    f.scheduler.advance(2000);
    f.plan([{ content: 'Work', status: 'in_progress' }]);
    await f.finish(false, 'max_turn_requests');
    assert.equal(f.scheduler.pendingCount(), 1);
    f.scheduler.advance(4000);
    f.plan([{ content: 'Verify work', status: 'in_progress' }]);
    await f.finish(false, 'max_turn_requests');
    assert.equal(f.scheduler.pendingCount(), 1);
    f.scheduler.advance(8000);
    f.plan([{ content: 'Verify work', status: 'completed' }]);
    await f.finish();
    await p;
    assert.equal(f.calls.length, 4);
    assert.equal(f.scheduler.pendingCount(), 0);
    assert.equal(f.handle.status().activeSessions, 0);
    assert.equal(f.logs.some(log => log.event === 'auto-continue-stopped'), false);
  });

  test(`v${protocolVersion} preserves error retries before stopping unchanged recovered plan`, { timeout: 1000 }, async t => {
    const f = planProgressFixture(t, protocolVersion);
    const p = f.prompt();
    f.plan([{ content: 'Waiting for confirmation', status: 'in_progress' }]);
    await f.finish(true);
    f.scheduler.advance(2000);
    await f.finish(true);
    assert.equal(f.scheduler.pendingCount(), 1);
    assert.equal(f.logs.some(log => log.event === 'auto-continue-stopped'), false);
    f.scheduler.advance(4000);
    await f.finish(false, 'max_turn_requests');
    assert.equal(f.scheduler.pendingCount(), 0);
    await p;
    assert.equal(f.calls.length, 3);
    assert.equal(f.handle.status().activeSessions, 0);
    assert.equal(f.logs.filter(log => log.event === 'auto-continue-stopped').length, 1);
    assert.equal(f.logs.filter(log => log.event === 'auto-continue-scheduled').every(log => log.data.reason === 'error'), true);
  });
}

test('max_turn_requests with a pending plan schedules one continue', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());
  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') { promptCount++; connector.forwardClientRequest({ method: 'session/update',
        params: { sessionId: req.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } } } });
        return Promise.resolve({ stopReason: 'max_turn_requests' }); }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-mtr', prompt: [{ type: 'text', text: 'do task' }] } });
  connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's-mtr',
    update: { sessionUpdate: 'plan', entries: [{ content: 'Step 1', status: 'pending' }] } } });
  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.advance(2000);
  assert.equal(promptCount, 2);
});

test('cancelled and refusal never continue even with a pending plan', { timeout: 1000 }, async t => {
  for (const stopReason of ['cancelled', 'refusal']) {
    const f = fixture();
    const scheduler = fakeScheduler();
    const handle = f.install({
      isEnabled: () => true,
      getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
      scheduler
    });
    t.after(() => handle.dispose());
    let promptCount = 0;
    const connector = {
      agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1,
      sendRequest(req) {
        if (req.method === 'session/prompt') { promptCount++; return Promise.resolve({ stopReason }); }
        return Promise.resolve({});
      },
      forwardClientRequest() {}
    };
    f.api.registerConnection(connector);
    const settled = connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-' + stopReason, prompt: [{ type: 'text', text: 'do' }] } });
    connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's-' + stopReason,
      update: { sessionUpdate: 'plan', entries: [{ content: 'Step 1', status: 'pending' }] } } });
    const result = await settled;
    assert.equal(result.stopReason, stopReason, 'the native resolve passes through');
    await new Promise(r => setImmediate(r));
    assert.equal(scheduler.pendingCount(), 0, stopReason);
    assert.equal(promptCount, 1, stopReason);
  }
});

test('max_turn_requests does not continue when untilPlanComplete is off', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: false }),
    scheduler
  });
  t.after(() => handle.dispose());
  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') { promptCount++; connector.forwardClientRequest({ method: 'session/update',
        params: { sessionId: req.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } } } });
        return Promise.resolve({ stopReason: 'max_turn_requests' }); }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-mtr-off', prompt: [{ type: 'text', text: 'do' }] } });
  connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's-mtr-off',
    update: { sessionUpdate: 'plan', entries: [{ content: 'Step 1', status: 'pending' }] } } });
  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(promptCount, 1);
});

test('v2 idle with max_turn_requests and a pending plan schedules one continue', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());
  let promptCount = 0, lastPrompt;
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 2,
    sendRequest(req) {
      if (req.method === 'session/prompt') { promptCount++; lastPrompt = req; return Promise.resolve({ acknowledgment: true }); }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-v2-mtr', prompt: [{ type: 'text', text: 'task' }] } });
  connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's-v2-mtr',
    update: { sessionUpdate: 'plan', entries: [{ content: 'Step 1', status: 'pending' }] } } });
  connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's-v2-mtr',
    update: { sessionUpdate: 'agent_message', messageId: 'm1', content: [{ type: 'text', text: 'working' }] } } });
  connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's-v2-mtr',
    update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'max_turn_requests' } } });
  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.advance(2000);
  assert.equal(promptCount, 2);
  assert.equal(lastPrompt.params.sessionId, 's-v2-mtr');
  assert.equal(lastPrompt.params.prompt[0].text, 'continue');
});

test('v2 idle with cancelled never continues even with a pending plan', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());
  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 2,
    sendRequest(req) {
      if (req.method === 'session/prompt') { promptCount++; return Promise.resolve({ acknowledgment: true }); }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-v2-cancel', prompt: [{ type: 'text', text: 'task' }] } });
  connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's-v2-cancel',
    update: { sessionUpdate: 'plan', entries: [{ content: 'Step 1', status: 'pending' }] } } });
  connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's-v2-cancel',
    update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' } } });
  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(promptCount, 1);
});

test('the plan retry chain stops at PLAN_ATTEMPT_LIMIT', { timeout: 2000 }, async t => {
  const { PLAN_ATTEMPT_LIMIT } = require('../src/runtime/host/auto-continue.cjs');
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());

  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') { promptCount++; connector.forwardClientRequest({ method: 'session/update',
        params: { sessionId: req.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } } } });
        return Promise.resolve({ stopReason: 'max_turn_requests' }); }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-cap', prompt: [{ type: 'text', text: 't' }] } });
  const plan = done => {
    const entries = [];
    for (let i = 0; i < 40; i++) entries.push({ content: 'item ' + i, status: i < done ? 'completed' : 'pending' });
    return { method: 'session/update', params: { sessionId: 's-cap',
      update: { sessionUpdate: 'plan', entries } } };
  };
  connector.forwardClientRequest(plan(0));
  // The snapshot is recorded when each continue fires, so each round reports
  // fresh progress *after* the continue is sent — matching how a real agent
  // makes progress during the continued turn.
  for (let round = 0; round <= PLAN_ATTEMPT_LIMIT + 4; round++) {
    await new Promise(r => setImmediate(r));
    scheduler.advance(30000);
    connector.forwardClientRequest(plan(round + 1));
    await new Promise(r => setImmediate(r));
  }
  const stops = f.logs.filter(l => l.event === 'auto-continue-stopped');
  assert.ok(stops.some(s => s.data.reason === 'plan-attempt-limit'), 'stopped with plan-attempt-limit');
  assert.ok(promptCount <= 1 + PLAN_ATTEMPT_LIMIT, `no prompt beyond the cap, got ${promptCount}`);
});

test('auto-continue-evaluated fires with the fixed field set even when disabled', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  let enabled = true;
  const handle = f.install({ isEnabled: () => enabled, getOptions: () => ({}), scheduler });
  t.after(() => handle.dispose());
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1,
    sendRequest() { return Promise.resolve({ stopReason: 'end_turn' }); },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  const p = connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-eval', prompt: [{ type: 'text', text: 'hi' }] } });
  enabled = false;
  await p;
  await new Promise(r => setImmediate(r));
  const events = f.logs.filter(l => l.event === 'auto-continue-evaluated');
  assert.equal(events.length, 1);
  const data = events[0].data;
  assert.deepEqual(Object.keys(data).sort(), [
    'decision', 'enabled', 'hasPendingPlan', 'onProviderError', 'pendingItems', 'planUpdates',
    'providerErrorMatched', 'reason', 'retryDisallowed', 'site', 'stopReason', 'suppressed',
    'terminalBlocker', 'untilPlanComplete',
  ].sort());
  assert.equal(data.site, 'resolve');
  assert.equal(data.enabled, false);
  assert.equal(data.decision, 'stop');
  assert.equal(data.reason, null);
  assert.equal(data.planUpdates, 0);
  assert.equal(data.pendingItems, 0);
});

test('error retries still cap at 5 and are not affected by PLAN_ATTEMPT_LIMIT', { timeout: 2000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: true, untilPlanComplete: false }),
    scheduler
  });
  t.after(() => handle.dispose());
  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') { promptCount++; return Promise.reject(new Error('Provider response could not be completed')); }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  const p = connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-err', prompt: [{ type: 'text', text: 'hi' }] } });
  p.catch(() => {});
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setImmediate(r));
    scheduler.advance(30000);
  }
  await new Promise(r => setImmediate(r));
  const stops = f.logs.filter(l => l.event === 'auto-continue-stopped');
  assert.ok(stops.some(s => s.data.reason === 'error-attempt-limit'), 'error chain still stops at 5');
  assert.ok(promptCount <= 6, `error retries stayed within the old budget, got ${promptCount}`);
});


test('a settle after a newer manual prompt is logged as untracked with reason superseded', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({ isEnabled: () => true, getOptions: () => ({}), scheduler });
  t.after(() => handle.dispose());
  const resolvers = [];
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1,
    sendRequest() { return new Promise(r => { resolvers.push(r); }); },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-sup', prompt: [{ type: 'text', text: 'a' }] } });
  connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-sup', prompt: [{ type: 'text', text: 'b' }] } });
  resolvers[0]({ stopReason: 'end_turn' });
  await new Promise(r => setImmediate(r));
  const events = f.logs.filter(l => l.event === 'auto-continue-evaluated');
  assert.equal(events.length, 1);
  assert.equal(events[0].data.decision, 'untracked');
  assert.equal(events[0].data.reason, 'superseded');
});

test('a cancelled stopReason is evaluated as stop with reason cancelled and never scheduled', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({ isEnabled: () => true, getOptions: () => ({ onProviderError: true, untilPlanComplete: true }), scheduler });
  t.after(() => handle.dispose());
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1,
    sendRequest() { return Promise.resolve({ stopReason: 'cancelled' }); },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  await connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-cancel', prompt: [{ type: 'text', text: 'hi' }] } });
  await new Promise(r => setImmediate(r));
  const events = f.logs.filter(l => l.event === 'auto-continue-evaluated');
  assert.equal(events.length, 1);
  assert.equal(events[0].data.decision, 'stop');
  assert.equal(events[0].data.reason, 'cancelled');
  assert.equal(f.logs.filter(l => l.event === 'auto-continue-scheduled').length, 0);
});

test('plan_update events before end_turn make planUpdates and pendingItems visible', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({ isEnabled: () => true, getOptions: () => ({ onProviderError: false, untilPlanComplete: true }), scheduler });
  t.after(() => handle.dispose());
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') return Promise.resolve({ stopReason: 'end_turn' });
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-vis', prompt: [{ type: 'text', text: 't' }] } });
  connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's-vis',
    update: { sessionUpdate: 'plan_update', plan: { planId: 'p1', type: 'items', entries: [
      { content: 'one', status: 'pending' }, { content: 'two', status: 'pending' }] } } } });
  await new Promise(r => setImmediate(r));
  const events = f.logs.filter(l => l.event === 'auto-continue-evaluated');
  assert.equal(events.length, 1);
  assert.ok(events[0].data.planUpdates >= 1);
  assert.equal(events[0].data.pendingItems, 2);
  assert.equal(events[0].data.hasPendingPlan, true);
});

test('a turn with no plan events reports zero plan counters', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({ isEnabled: () => true, getOptions: () => ({}), scheduler });
  t.after(() => handle.dispose());
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1,
    sendRequest() { return Promise.resolve({ stopReason: 'end_turn' }); },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  await connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-noplan', prompt: [{ type: 'text', text: 'hi' }] } });
  await new Promise(r => setImmediate(r));
  const events = f.logs.filter(l => l.event === 'auto-continue-evaluated');
  assert.equal(events.length, 1);
  assert.equal(events[0].data.planUpdates, 0);
  assert.equal(events[0].data.pendingItems, 0);
  assert.equal(events[0].data.hasPendingPlan, false);
});

test('entries without status count as pending', { timeout: 1000 }, async t => {
  const f = planProgressFixture(t, 1);
  f.prompt();
  f.plan([{ content: 'a' }, { content: 'b' }]);
  await f.finish(false, 'max_turn_requests');
  const events = f.logs.filter(l => l.event === 'auto-continue-evaluated');
  assert.equal(events.length, 1);
  assert.equal(events[0].data.pendingItems, 2);
  assert.equal(events[0].data.hasPendingPlan, true);
  assert.equal(events[0].data.planUpdates, 1);
  assert.equal(events[0].data.decision, 'plan-retry');
});

test('a non-native status invalidates the whole plan', { timeout: 1000 }, async t => {
  const f = planProgressFixture(t, 1);
  f.prompt();
  f.plan([{ content: 'a', status: 'cancelled' }]);
  await f.finish();
  const events = f.logs.filter(l => l.event === 'auto-continue-evaluated');
  assert.equal(events.length, 1);
  assert.equal(events[0].data.pendingItems, 0);
  assert.equal(events[0].data.hasPendingPlan, false);
  assert.equal(events[0].data.planUpdates, 1);
  assert.equal(f.scheduler.pendingCount(), 0);
});

test('an explicit pending status produces the same signature as a missing one', { timeout: 1000 }, async t => {
  const f = planProgressFixture(t, 1);
  const p = f.prompt();
  f.plan([{ content: 'a' }]);
  await f.finish(false, 'max_turn_requests');
  assert.equal(f.scheduler.pendingCount(), 1);
  f.scheduler.advance(2000);
  assert.equal(f.calls.length, 2);
  f.plan([{ content: 'a', status: 'pending' }]);
  await f.finish(false, 'max_turn_requests');
  const result = await p;
  assert.equal(result.stopReason, 'max_turn_requests');
  assert.equal(f.scheduler.pendingCount(), 0);
  const stopped = f.logs.filter(l => l.event === 'auto-continue-stopped');
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].data.reason, 'plan-no-progress');
});

test('max_turn_requests without a plan continues once', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());
  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') { promptCount++; connector.forwardClientRequest({ method: 'session/update',
        params: { sessionId: req.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } } } });
        return Promise.resolve({ stopReason: 'max_turn_requests' }); }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-mtr-noplan', prompt: [{ type: 'text', text: 'do' }] } });
  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1, 'a plan-less turn-limit stop still schedules a continue');
  scheduler.advance(2000);
  assert.equal(promptCount, 2);
  const evaluated = f.logs.filter(l => l.event === 'auto-continue-evaluated');
  assert.equal(evaluated.length, 1);
  assert.equal(evaluated[0].data.decision, 'plan-retry');
  assert.equal(evaluated[0].data.hasPendingPlan, false);
  assert.equal(evaluated[0].data.planUpdates, 0);
});

test('a plan-less turn-limit stop obeys the attempt budget', { timeout: 2000 }, async t => {
  const { PLAN_ATTEMPT_LIMIT } = require('../src/runtime/host/auto-continue.cjs');
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());
  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') { promptCount++; connector.forwardClientRequest({ method: 'session/update',
        params: { sessionId: req.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } } } });
        return Promise.resolve({ stopReason: 'max_turn_requests' }); }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-mtr-cap', prompt: [{ type: 'text', text: 't' }] } });
  for (let round = 0; round <= PLAN_ATTEMPT_LIMIT + 4; round++) {
    await new Promise(r => setImmediate(r));
    scheduler.advance(30000);
    await new Promise(r => setImmediate(r));
  }
  const stops = f.logs.filter(l => l.event === 'auto-continue-stopped');
  assert.ok(stops.some(s => s.data.reason === 'plan-attempt-limit'), 'stopped with plan-attempt-limit');
  assert.ok(promptCount <= 1 + PLAN_ATTEMPT_LIMIT, `no prompt beyond the cap, got ${promptCount}`);
});

test('end_turn without a plan does not continue', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());
  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') { promptCount++; return Promise.resolve({ stopReason: 'end_turn' }); }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-end-noplan', prompt: [{ type: 'text', text: 'do' }] } });
  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 0, 'end_turn without a plan is a normal finish');
  scheduler.advance(2000);
  assert.equal(promptCount, 1);
  const evaluated = f.logs.filter(l => l.event === 'auto-continue-evaluated');
  assert.equal(evaluated.length, 1);
  assert.equal(evaluated[0].data.decision, 'stop');
});

test('v2 idle with max_turn_requests and no plan schedules one continue', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());
  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 2,
    sendRequest(req) {
      if (req.method === 'session/prompt') { promptCount++; return Promise.resolve({ acknowledgment: true }); }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-v2-mtr-noplan', prompt: [{ type: 'text', text: 'task' }] } });
  connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's-v2-mtr-noplan',
    update: { sessionUpdate: 'agent_message', messageId: 'm1', content: [{ type: 'text', text: 'working' }] } } });
  connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's-v2-mtr-noplan',
    update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'max_turn_requests' } } });
  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.advance(2000);
  assert.equal(promptCount, 2);
});

test('max_turn_requests without a plan does not continue when untilPlanComplete is off', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: false }),
    scheduler
  });
  t.after(() => handle.dispose());
  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') { promptCount++; connector.forwardClientRequest({ method: 'session/update',
        params: { sessionId: req.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } } } });
        return Promise.resolve({ stopReason: 'max_turn_requests' }); }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-mtr-noplan-off', prompt: [{ type: 'text', text: 'do' }] } });
  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(promptCount, 1);
});

test('max_tokens without a plan continues once', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());
  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') { promptCount++; connector.forwardClientRequest({ method: 'session/update',
        params: { sessionId: req.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } } } });
        return Promise.resolve({ stopReason: 'max_tokens' }); }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-mt-noplan', prompt: [{ type: 'text', text: 'do' }] } });
  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1, 'a plan-less max_tokens stop still schedules a continue');
  scheduler.advance(2000);
  assert.equal(promptCount, 2);
  const evaluated = f.logs.filter(l => l.event === 'auto-continue-evaluated');
  assert.equal(evaluated.length, 1);
  assert.equal(evaluated[0].data.decision, 'plan-retry');
  assert.equal(evaluated[0].data.hasPendingPlan, false);
});

test('end_turn with a pending plan does not continue', { timeout: 1000 }, async t => {
  const f = planProgressFixture(t, 1);
  const p = f.prompt();
  f.plan([{ content: 'Step 1', status: 'pending' }]);
  await f.finish();
  assert.equal(f.scheduler.pendingCount(), 0, 'end_turn is a normal finish even with pending plan entries');
  f.scheduler.advance(2000);
  assert.equal(f.calls.length, 1);
  const result = await p;
  assert.equal(result.stopReason, 'end_turn');
  const evaluated = f.logs.filter(l => l.event === 'auto-continue-evaluated');
  assert.equal(evaluated.length, 1);
  assert.equal(evaluated[0].data.decision, 'stop');
  assert.equal(evaluated[0].data.hasPendingPlan, true);
});

test('a new plan replaces the previous one instead of accumulating', { timeout: 1000 }, async t => {
  const f = planProgressFixture(t, 1);
  f.prompt();
  f.plan([{ content: 'a', status: 'pending' }]);
  f.update({ sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'p2', entries: [{ content: 'b', status: 'completed' }] } });
  await f.finish(false, 'max_turn_requests');
  // The truncation contract still schedules the continue — the single-current
  // semantics show up in the evaluated payload: the stale pending entry from
  // the replaced plan must NOT leak into hasPendingPlan.
  assert.equal(f.scheduler.pendingCount(), 1, 'a plan-less truncation still continues once');
  const evaluated = f.logs.filter(l => l.event === 'auto-continue-evaluated');
  assert.equal(evaluated.length, 1);
  assert.equal(evaluated[0].data.decision, 'plan-retry');
  assert.equal(evaluated[0].data.hasPendingPlan, false);
});

test('removing the current plan cancels pending eligibility', { timeout: 1000 }, async t => {
  const f = planProgressFixture(t, 1);
  f.prompt();
  f.update({ sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'p1', entries: [{ content: 'a', status: 'pending' }] } });
  f.update({ sessionUpdate: 'plan_removed', planId: 'p1' });
  await f.finish(false, 'max_turn_requests');
  assert.equal(f.scheduler.pendingCount(), 1, 'a plan-less truncation still continues once');
  const evaluated = f.logs.filter(l => l.event === 'auto-continue-evaluated');
  assert.equal(evaluated.length, 1);
  assert.equal(evaluated[0].data.decision, 'plan-retry');
  assert.equal(evaluated[0].data.hasPendingPlan, false);
});


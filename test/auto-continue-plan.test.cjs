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
        return Promise.resolve({ stopReason: 'end_turn' });
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
        return Promise.resolve({ stopReason: 'end_turn' });
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
  assert.equal(res.stopReason, 'end_turn');
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
      return Promise.resolve({ stopReason: 'end_turn' });
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
  assert.equal(res.stopReason, 'end_turn');
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
      return Promise.resolve({ stopReason: 'end_turn' });
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
  assert.equal(res.stopReason, 'end_turn');
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
      await f.finish(variant === 'error-recovery');
      assert.equal(f.scheduler.pendingCount(), 1);
      f.scheduler.advance(2000);
      assert.equal(f.calls.length, 2);
      if (variant === 'identical') f.plan(pending);
      if (variant === 'reordered') f.plan([...pending].reverse());
      if (variant === 'new-plan-id') f.plan(pending, 'new');
      await f.finish();
      assert.equal(f.scheduler.pendingCount(), 0);
      assert.equal(f.handle.status().activeSessions, 0);
      const result = await p;
      if (protocolVersion === 1) assert.equal(result.stopReason, 'end_turn');
      const stopped = f.logs.filter(log => log.event === 'auto-continue-stopped');
      assert.equal(stopped.length, 1);
      assert.equal(stopped[0].data.reason, 'plan-no-progress');
      assert.equal(stopped[0].data.attempts, 1);
      assert.deepEqual(Object.keys(stopped[0].data).sort(), ['attempts', 'reason']);
      assert.equal(JSON.stringify(f.logs).includes('Blocked'), false);
      f.scheduler.advance(60000);
      assert.equal(f.calls.length, 2);

      const next = f.prompt();
      f.plan(pending);
      await f.finish();
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
    await f.finish();
    f.scheduler.advance(2000);
    f.plan([{ content: 'Work', status: 'in_progress' }]);
    await f.finish();
    assert.equal(f.scheduler.pendingCount(), 1);
    f.scheduler.advance(4000);
    f.plan([{ content: 'Verify work', status: 'in_progress' }]);
    await f.finish();
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
    await f.finish();
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
      if (req.method === 'session/prompt') { promptCount++; return Promise.resolve({ stopReason: 'max_turn_requests' }); }
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
      if (req.method === 'session/prompt') { promptCount++; return Promise.resolve({ stopReason: 'max_turn_requests' }); }
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
      if (req.method === 'session/prompt') { promptCount++; return Promise.resolve({ stopReason: 'end_turn' }); }
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
    'decision', 'enabled', 'hasPendingPlan', 'onProviderError', 'providerErrorMatched',
    'retryDisallowed', 'site', 'stopReason', 'suppressed', 'terminalBlocker', 'untilPlanComplete',
  ].sort());
  assert.equal(data.site, 'resolve');
  assert.equal(data.enabled, false);
  assert.equal(data.decision, 'stop');
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

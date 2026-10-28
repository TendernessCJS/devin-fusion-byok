'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createManager } = require('../src/panel/manager.cjs');
const { fixture, fakeScheduler } = require('./helpers/auto-continue-fixture.cjs');

test('manager setAutoContinue persists setting with boolean validation and updates public state', async () => {
  let savedConfig = { enabled: true, providers: [] };
  const manager = createManager({
    read: () => savedConfig,
    write: c => { savedConfig = c; }
  });

  const s0 = manager.state();
  assert.equal(s0.autoContinueOnProviderError, false);

  await assert.rejects(manager.dispatch('setAutoContinue', { enabled: 'true' }), /自动继续/);
  await assert.rejects(manager.dispatch('setAutoContinue', { enabled: 1 }), /自动继续/);

  const s1 = await manager.dispatch('setAutoContinue', { enabled: true });
  assert.equal(s1.autoContinueOnProviderError, true);
  assert.equal(savedConfig.autoContinueOnProviderError, true);

  const s2 = await manager.dispatch('setAutoContinue', { enabled: false });
  assert.equal(s2.autoContinueOnProviderError, false);
  assert.equal(savedConfig.autoContinueOnProviderError, false);
});

test('TRANSIENT_HTTP_RE requires end of string: recovered suffix does not retry', () => {
  const f = fixture();
  assert.equal(f.matchesProviderError('Provider returned HTTP 429.'), true);
  assert.equal(f.matchesProviderError('Provider returned HTTP 429. recovered'), false);
  assert.equal(f.matchesProviderError('Provider returned HTTP 429. and more text'), false);
});

test('provider error retries stop after five sends and settle the v1 turn', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const stops = [];
  const handle = f.install({
    isEnabled: () => true,
    scheduler,
    onStopped: info => stops.push(info)
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

  const send429 = () => connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-cap',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Provider returned HTTP 429.' } }
    }
  });

  const promptPromise = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-cap', prompt: [{ type: 'text', text: 'hi' }] }
  });

  for (let round = 0; round < 5; round++) {
    send429();
    await new Promise(r => setImmediate(r));
    scheduler.advance(30000);
  }
  assert.equal(promptCount, 6, 'the original prompt plus exactly five automatic retries');

  send429();
  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 0, 'a sixth retry is never scheduled');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].reason, 'error-attempt-limit');
  assert.equal(stops[0].attempts, 5);
  assert.equal(JSON.stringify(stops).includes('s-cap'), false, 'stop data must not leak the session id');
  assert.equal((await promptPromise).stopReason, 'end_turn', 'the v1 deferred settles with the last result');
});

test('provider error retries stop after five sends on v2 without a deferred', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const stops = [];
  const handle = f.install({
    isEnabled: () => true,
    scheduler,
    onStopped: info => stops.push(info)
  });
  t.after(() => handle.dispose());

  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    get protocolVersion() { return 2; },
    sendRequest(req) {
      if (req.method === 'session/prompt') {
        promptCount++;
        return Promise.resolve({ acknowledgment: true });
      }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const send429 = round => connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-cap-v2',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm' + round,
        content: { type: 'text', text: 'Provider returned HTTP 429.' }
      }
    }
  });
  const idle = () => connector.forwardClientRequest({
    method: 'session/update',
    params: { sessionId: 's-cap-v2', update: { sessionUpdate: 'state_update', state: 'idle' } }
  });

  await connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-cap-v2', prompt: [{ type: 'text', text: 'hi' }] }
  });

  for (let round = 0; round < 5; round++) {
    send429(round);
    idle();
    scheduler.advance(30000);
  }
  assert.equal(promptCount, 6, 'the original prompt plus exactly five automatic retries');

  send429(5);
  idle();
  assert.equal(scheduler.pendingCount(), 0, 'a sixth retry is never scheduled');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].reason, 'error-attempt-limit');
  assert.equal(stops[0].attempts, 5);
});

test('an error retry pending when the ten minute window lapses is refused and settles', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const stops = [];
  let clock = 0;
  const handle = f.install({
    isEnabled: () => true,
    scheduler,
    now: () => clock,
    onStopped: info => stops.push(info)
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

  const send429 = () => connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-window',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Provider returned HTTP 429.' } }
    }
  });

  const promptPromise = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-window', prompt: [{ type: 'text', text: 'hi' }] }
  });
  send429();
  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1, 'a retry is scheduled while inside the window');

  clock = 10 * 60 * 1000;
  scheduler.advance(30000);
  assert.equal(promptCount, 1, 'the lapsed timer must not send another prompt');
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].reason, 'error-time-limit');
  assert.equal(stops[0].attempts, 0);
  assert.equal((await promptPromise).stopReason, 'end_turn');
});

test('a recovered turn resets the error budget for the next manual prompt', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const stops = [];
  const handle = f.install({
    isEnabled: () => true,
    scheduler,
    onStopped: info => stops.push(info)
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

  const send429 = () => connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-reset-budget',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Provider returned HTTP 429.' } }
    }
  });

  const firstPrompt = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-reset-budget', prompt: [{ type: 'text', text: 'hi' }] }
  });
  for (let round = 0; round < 4; round++) {
    send429();
    await new Promise(r => setImmediate(r));
    scheduler.advance(30000);
  }
  assert.equal(promptCount, 5, 'four error retries spent');

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-reset-budget',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Recovered and done.' } }
    }
  });
  await firstPrompt;
  assert.equal(scheduler.pendingCount(), 0);

  const secondPrompt = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-reset-budget', prompt: [{ type: 'text', text: 'again' }] }
  });
  for (let round = 0; round < 5; round++) {
    send429();
    await new Promise(r => setImmediate(r));
    scheduler.advance(30000);
  }
  assert.equal(promptCount, 11, 'a fresh manual prompt gets a fresh budget of five retries');

  send429();
  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].reason, 'error-attempt-limit');
  assert.equal(stops[0].attempts, 5);
  assert.equal((await secondPrompt).stopReason, 'end_turn');
});

test('switching to plan continuation resets the consecutive error budget', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const stops = [];
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: true, untilPlanComplete: true }),
    scheduler,
    onStopped: info => stops.push(info)
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
        // Truncation is what lets the plan chain continue; the 429 text keeps
        // claiming the error chain first, so both budgets stay exercised.
        return Promise.resolve({ stopReason: 'max_turn_requests' });
      }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const update = value => connector.forwardClientRequest({
    method: 'session/update',
    params: { sessionId: 's-plan-reset', update: value }
  });
  const send429 = () => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Provider returned HTTP 429.' } });
  const plan = entries => update({ sessionUpdate: 'plan', entries });

  const promptPromise = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-plan-reset', prompt: [{ type: 'text', text: 'do task' }] }
  });

  send429();
  await new Promise(r => setImmediate(r));
  scheduler.advance(30000);
  assert.equal(promptCount, 2, 'one error retry spent');

  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } });
  plan([{ content: 'Step 1', status: 'pending' }]);
  await new Promise(r => setImmediate(r));
  scheduler.advance(30000);
  assert.equal(promptCount, 3, 'the pending plan keeps the turn going');

  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'more work' } });
  plan([{ content: 'Step 1', status: 'in_progress' }]);
  await new Promise(r => setImmediate(r));
  scheduler.advance(30000);
  assert.equal(promptCount, 4, 'plan progress triggers another continue');

  for (let round = 0; round < 5; round++) {
    send429();
    await new Promise(r => setImmediate(r));
    scheduler.advance(30000);
  }
  assert.equal(promptCount, 9, 'five fresh error retries after the plan interlude, not four');

  send429();
  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].reason, 'error-attempt-limit');
  assert.equal(stops[0].attempts, 5);
  assert.equal((await promptPromise).stopReason, 'max_turn_requests');
});

test('an onStopped callback that starts a fresh prompt is not deleted by the stop', async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const stops = [];
  let promptCount = 0;
  let freshPrompt, resolveFresh;
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1,
    sendRequest(request) {
      if (request.method === 'session/prompt') {
        promptCount++;
        if (request.params.prompt[0].text === 'manual again') {
          return new Promise(resolve => { resolveFresh = () => resolve({ stopReason: 'end_turn' }); });
        }
        return Promise.resolve({ stopReason: 'end_turn' });
      }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  const handle = f.install({
    isEnabled: () => true,
    scheduler,
    onStopped: data => {
      stops.push(data);
      freshPrompt = connector.sendRequest({ method: 'session/prompt',
        params: { sessionId: 's-reuse', prompt: [{ type: 'text', text: 'manual again' }] } });
    }
  });
  t.after(() => handle.dispose());
  f.api.registerConnection(connector);
  const error = () => connector.forwardClientRequest({ method: 'session/update',
    params: { sessionId: 's-reuse', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Provider returned HTTP 429.' } } } });
  const first = connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-reuse', prompt: [{ type: 'text', text: 'go' }] } });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  for (let round = 0; round < 5; round++) { error(); await tick(); scheduler.advance(30000); }
  assert.equal(promptCount, 6, 'one manual plus five automatic retries');
  error();
  await tick();
  await first;
  assert.equal(stops.length, 1);
  assert.ok(freshPrompt, 'the callback issued a new prompt during the stop');
  error();
  resolveFresh();
  await tick();
  assert.equal(scheduler.pendingCount(), 1, 'the new manual turn keeps a live error budget and schedules a retry');
  scheduler.advance(30000);
  await tick();
  assert.equal(promptCount, 8, 'the surviving turn still retries once on its own budget');
  assert.equal((await freshPrompt).stopReason, 'end_turn');
});

test('a rejected onStopped promise is contained without unhandled rejections', async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const stops = [];
  let unhandled = false;
  const listener = () => { unhandled = true; };
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  const handle = f.install({ isEnabled: () => true, scheduler, onStopped: data => { stops.push(data); return Promise.reject(new Error('visible-only')); } });
  t.after(() => handle.dispose());
  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1,
    sendRequest(request) {
      if (request.method === 'session/prompt') { promptCount++; return Promise.resolve({ stopReason: 'end_turn' }); }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  const error = () => connector.forwardClientRequest({ method: 'session/update',
    params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Provider returned HTTP 429.' } } } });
  const first = connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'go' }] } });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  for (let round = 0; round < 5; round++) { error(); await tick(); scheduler.advance(30000); }
  error();
  await tick();
  await first;
  assert.equal(stops.length, 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(unhandled, false, 'the callback rejection is caught');
});

test('error retries do not consume plan attempts or inflate plan backoff', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: true, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());
  const resolvers = [];
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') return new Promise(resolve => resolvers.push(resolve));
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  const update = value => connector.forwardClientRequest({
    method: 'session/update', params: { sessionId: 's-split', update: value }
  });
  const text = s => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: s } });

  connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's-split', prompt: [{ type: 'text', text: 't' }] } });
  text('some output');
  resolvers.shift()({ stopReason: 'max_tokens' });
  await new Promise(r => setImmediate(r));
  scheduler.advance(2000);
  await new Promise(r => setImmediate(r));

  text('Provider returned HTTP 429.');
  resolvers.shift()({ stopReason: 'max_turn_requests' });
  await new Promise(r => setImmediate(r));
  scheduler.advance(2000);
  await new Promise(r => setImmediate(r));

  text('more output');
  resolvers.shift()({ stopReason: 'max_tokens' });
  await new Promise(r => setImmediate(r));

  const scheduled = f.logs.filter(l => l.event === 'auto-continue-scheduled').map(l => ({ ...l.data }));
  assert.deepEqual(scheduled, [
    { attempts: 0, delay: 2000, reason: 'plan' },
    { attempts: 0, delay: 2000, reason: 'error' },
    { attempts: 1, delay: 4000, reason: 'plan' }
  ], 'the error retry must not bump the plan backoff (pre-fix: attempts 3 / delay 16000)');
  scheduler.advance(4000);
  await new Promise(r => setImmediate(r));
  resolvers.shift()({ stopReason: 'end_turn' });
});

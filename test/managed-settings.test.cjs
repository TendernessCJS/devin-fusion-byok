'use strict';
// The managed-settings gate is the serialization point between an enable-time
// write and a disable-time restore. These cases pin the two properties the
// receipt depends on: entries run one at a time in arrival order, and a drain
// waits for the entry that already started while cancelling the ones that have
// not.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createManagedSettingsGate } = require('../src/activation/managed-settings.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test('entries run one at a time in arrival order', async () => {
  const gate = createManagedSettingsGate();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const first = gate.critical(async () => { order.push('first-start'); await firstGate; order.push('first-end'); });
  const second = gate.critical(async () => { order.push('second'); });
  await tick();
  assert.deepEqual(order, ['first-start'], 'the second entry waits for the first');
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
});

test('a drain lets the running entry finish and cancels the queued one', async () => {
  const gate = createManagedSettingsGate();
  const ran = [];
  const running = deferred();
  const first = gate.critical(() => { ran.push('started'); return running.promise; });
  // "Running" means the body has begun; entries are dispatched on the next
  // microtask, so this tick is the documented boundary between the two kinds.
  await tick();
  const queued = gate.critical(() => { ran.push('queued-ran'); });
  // Catch the cancellation here so the assertion below sees a settled promise
  // instead of relying on the runner reporting an unhandled rejection.
  const queuedResult = queued.catch(error => error.code);
  const draining = gate.drain();
  await tick();
  running.resolve('done');
  assert.equal(await first, 'done', 'an entry that already started is allowed to complete');
  assert.equal(await queuedResult, 'cancelled');
  assert.equal(await draining, true);
  assert.deepEqual(ran, ['started'], 'the queued entry never executes');
});

test('a drain without any accepted entry returns immediately', async () => {
  const gate = createManagedSettingsGate();
  assert.equal(await gate.drain(), true);
});

test('writes after a drain are refused until open re-opens the gate', async () => {
  const gate = createManagedSettingsGate();
  await gate.drain();
  assert.throws(() => gate.critical(async () => {}), error => error.code === 'cancelled');
  gate.open();
  assert.equal(await gate.critical(async () => 'ran'), 'ran');
});

test('an entry queued before the drain cannot revive after a later open', async () => {
  const gate = createManagedSettingsGate();
  const running = deferred();
  const first = gate.critical(() => running.promise);
  await tick();
  const queued = gate.critical(async () => 'queued-ran');
  const queuedResult = queued.catch(error => error.code);
  const draining = gate.drain();
  running.resolve('first');
  // Re-opening immediately must not resurrect the entry accepted before the
  // drain: its epoch is stale.
  gate.open();
  assert.equal(await queuedResult, 'cancelled');
  await first;
  assert.equal(await draining, true);
  assert.equal(await gate.critical(async () => 'fresh'), 'fresh', 'a post-open entry runs normally');
});

test('a successful drain clears its timeout timer instead of leaving a 5s handle', async t => {
  const scheduled = new Map();
  let nextId = 1;
  t.mock.method(globalThis, 'setTimeout', fn => { const id = nextId++; scheduled.set(id, fn); return id; });
  t.mock.method(globalThis, 'clearTimeout', id => { scheduled.delete(id); });
  const gate = createManagedSettingsGate();
  const running = deferred();
  const entry = gate.critical(() => running.promise);
  await tick();
  const draining = gate.drain();
  assert.equal(scheduled.size, 1, 'the drain arms a timeout while an entry is still running');
  running.resolve('ran');
  assert.equal(await entry, 'ran');
  assert.equal(await draining, true);
  assert.equal(scheduled.size, 0, 'the timer is cleared as soon as every entry settles');
});

test('a drain that times out reports false without leaking a rejection', async () => {
  const gate = createManagedSettingsGate({ timeoutMs: 20 });
  const stuck = deferred();
  const entry = gate.critical(() => stuck.promise);
  await tick();
  const succeeded = await gate.drain();
  assert.equal(succeeded, false, 'a still-running entry makes the drain report a timeout');
  stuck.reject(Object.assign(new Error('late'), { code: 'late_failure' }));
  await entry.catch(error => error.code);
  await tick();
});

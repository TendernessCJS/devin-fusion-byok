'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPickerRefresh, signatureOf } = require('../src/runtime/picker-refresh.cjs');

function harness({ models = [{ uid: 'a', label: 'A' }], fail = [] } = {}) {
  let clock = 1000, current = models;
  const timers = [], commands = [], logs = [];
  const refresh = createPickerRefresh({
    lightCommands: ['devin.reloadAcpConnections'],
    readModels: () => current,
    executeCommand: async command => { commands.push(command); if (fail.includes(command)) throw new Error('missing'); },
    log: (event, data) => logs.push({ event, ...data }),
    now: () => clock,
    schedule: (fn, ms) => { const timer = { fn, at: clock + ms, cancelled: false }; timers.push(timer); return timer; },
    cancel: timer => { timer.cancelled = true; },
  });
  return {
    refresh, commands, logs, timers,
    set(next) { current = next; },
    advance(ms) { clock += ms; },
    async fire() {
      for (const timer of timers.splice(0)) if (!timer.cancelled) { clock = Math.max(clock, timer.at); timer.fn(); }
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('signature ignores order and tracks uid and label', () => {
  assert.equal(signatureOf([{ uid: 'b', label: 'B' }, { uid: 'a', label: 'A' }]), signatureOf([{ uid: 'a', label: 'A' }, { uid: 'b', label: 'B' }]));
  assert.notEqual(signatureOf([{ uid: 'a', label: 'A' }]), signatureOf([{ uid: 'a', label: 'Renamed' }]));
});

test('unchanged model lists never start a conversation', async () => {
  const h = harness();
  h.refresh.prime();
  assert.equal(h.refresh.changed(), false);
  await h.fire();
  assert.deepEqual(h.commands, []);
});

test('a new preset triggers one debounced connection reload', async () => {
  const h = harness();
  h.refresh.prime();
  h.set([{ uid: 'a', label: 'A' }, { uid: 'fusion-dfbyok-preset-x', label: 'ds' }]);
  assert.equal(h.refresh.changed(), true);
  assert.equal(h.timers[0].at - 1000, 1500);
  await h.fire();
  assert.deepEqual(h.commands, ['devin.reloadAcpConnections']);
});

test('rapid edits collapse into a single refresh', async () => {
  const h = harness();
  h.refresh.prime();
  h.set([{ uid: 'b', label: 'B' }]); h.refresh.changed();
  h.set([{ uid: 'c', label: 'C' }]); h.refresh.changed();
  await h.fire();
  assert.deepEqual(h.commands, ['devin.reloadAcpConnections']);
});

test('a second refresh waits until the CLI model cache is stale', async () => {
  const h = harness();
  h.refresh.prime();
  h.set([{ uid: 'b', label: 'B' }]); h.refresh.changed();
  await h.fire();
  const firstRun = 2500;
  h.advance(10000);
  h.set([{ uid: 'c', label: 'C' }]); h.refresh.changed();
  assert.equal(h.timers[0].at, firstRun + 65000);
  await h.fire();
  assert.equal(h.commands.length, 2);
});

test('a missing light command is reported and never opens a conversation', async () => {
  const missing = harness({ fail: ['devin.reloadAcpConnections'] });
  missing.refresh.prime(); missing.set([]); missing.refresh.changed(); await missing.fire();
  assert.deepEqual(missing.commands, ['devin.reloadAcpConnections']);
  assert.equal(missing.logs.at(-1).event, 'picker-refresh-unavailable');
});

test('dispose cancels a pending refresh', async () => {
  const h = harness();
  h.refresh.prime(); h.set([]); h.refresh.changed();
  h.refresh.dispose();
  await h.fire();
  assert.deepEqual(h.commands, []);
  assert.equal(h.refresh.changed(), false);
});

function lightHarness({ models = [{ uid: 'a', label: 'A' }], fail = [], appliedResult = false,
  observationSeq = 0, onExecute } = {}) {
  let clock = 1000, current = models, seq = observationSeq;
  const timers = [], commands = [], logs = [];
  const refresh = createPickerRefresh({
    lightCommands: ['devin.reloadAcpConnections'],
    readModels: () => current,
    executeCommand: async command => {
      commands.push(command);
      if (fail.includes(command)) throw new Error('missing');
      onExecute?.(command);
    },
    log: (event, data) => logs.push({ event, ...data }),
    now: () => clock,
    schedule: (fn, ms) => { const timer = { fn, at: clock + ms, cancelled: false }; timers.push(timer); return timer; },
    cancel: timer => { timer.cancelled = true; },
    observe: () => seq,
    applied: typeof appliedResult === 'function'
      ? token => appliedResult(token, () => seq)
      : () => appliedResult,
    wait: async ms => { clock += ms; },
    pollMs: 50,
    verifyTimeoutMs: 200,
  });
  return {
    refresh, commands, logs, timers,
    set(next) { current = next; },
    observeNext() { seq += 1; },
    async fire() {
      for (const timer of timers.splice(0)) if (!timer.cancelled) { clock = Math.max(clock, timer.at); timer.fn(); }
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

const trigger = async h => {
  h.refresh.prime();
  h.set([{ uid: 'a', label: 'A' }, { uid: 'fusion-dfbyok-preset-x', label: 'ds' }]);
  h.refresh.changed();
  await h.fire();
};

test('a verified light command refresh never opens a conversation', async () => {
  const h = lightHarness({ appliedResult: (token, getSeq) => getSeq() > token,
    onExecute: () => h.observeNext() });
  await trigger(h);
  assert.deepEqual(h.commands, ['devin.reloadAcpConnections']);
  assert.equal(h.logs.some(entry => entry.event === 'picker-refresh'), true);
});

test('an unverified light command is reported without opening a conversation', async () => {
  const h = lightHarness({ appliedResult: false });
  await trigger(h);
  assert.deepEqual(h.commands, ['devin.reloadAcpConnections'], 'executed light command ends the run; lazy sessions pick up fresh caches later');
  assert.equal(h.logs.some(entry => entry.event === 'picker-refresh-unverified' && entry.command === 'devin.reloadAcpConnections'), true);
});

test('an unverified light command still terminates when the injected clock never advances', async () => {
  let clock = 0, current = [{ uid: 'a' }];
  const commands = [], logs = [], timers = [];
  const refresh = createPickerRefresh({
    lightCommands: ['devin.reloadAcpConnections'],
    readModels: () => current,
    executeCommand: async command => { commands.push(command); },
    log: (event, data) => logs.push({ event, ...data }),
    now: () => clock,
    schedule: (fn, ms) => { const timer = { fn, at: ms, cancelled: false }; timers.push(timer); return timer; },
    cancel: timer => { timer.cancelled = true; },
    observe: () => 0,
    applied: () => false,
    wait: async () => {},
    pollMs: 50,
    verifyTimeoutMs: 200,
  });
  refresh.prime();
  current = [{ uid: 'b' }];
  refresh.changed();
  for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, ['devin.reloadAcpConnections'],
    'the round cap terminates the poll even when now() never advances');
  assert.equal(logs.some(entry => entry.event === 'picker-refresh-unverified'), true);
});

test('without an observer the light command still runs unverified', async () => {
  const h = harness();
  h.refresh.prime();
  h.set([{ uid: 'b', label: 'B' }]);
  h.refresh.changed();
  await h.fire();
  assert.deepEqual(h.commands, ['devin.reloadAcpConnections']);
  assert.equal(h.logs.some(entry => entry.event === 'picker-refresh-unverified'), false);
});

test('disposing during verification stops further commands', async () => {
  let clock = 0, current = [{ uid: 'a' }];
  const commands = [], timers = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const refresh = createPickerRefresh({
    lightCommands: ['devin.reloadAcpConnections'],
    readModels: () => current,
    executeCommand: async command => { commands.push(command); },
    log: () => {},
    now: () => clock,
    schedule: (fn, ms) => { const timer = { fn, at: ms, cancelled: false }; timers.push(timer); return timer; },
    cancel: timer => { timer.cancelled = true; },
    observe: () => 0,
    applied: () => false,
    wait: () => gate,
    pollMs: 50,
    verifyTimeoutMs: 200,
  });
  refresh.prime();
  current = [{ uid: 'b' }];
  refresh.changed();
  for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, ['devin.reloadAcpConnections']);
  refresh.dispose();
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, ['devin.reloadAcpConnections'], 'no fallback command runs after dispose');
});

test('omitting lightCommands never fires a command even when the signature changes', async () => {
  let clock = 1000, current = [{ uid: 'a' }];
  const timers = [], commands = [], logs = [];
  const refresh = createPickerRefresh({
    readModels: () => current,
    executeCommand: async command => { commands.push(command); },
    log: (event, data) => logs.push({ event, ...data }),
    now: () => clock,
    schedule: (fn, ms) => { const timer = { fn, at: clock + ms, cancelled: false }; timers.push(timer); return timer; },
    cancel: timer => { timer.cancelled = true; },
  });
  refresh.prime();
  current = [{ uid: 'b' }];
  refresh.changed();
  for (const timer of timers.splice(0)) if (!timer.cancelled) { clock = Math.max(clock, timer.at); timer.fn(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(commands.length, 0, 'no command fires without an explicit opt-in list');
  assert.ok(!logs.some(entry => entry.event === 'picker-refresh'), 'no refresh attempt is logged');
});

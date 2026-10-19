'use strict';

// Unit tests for the unified ACP injection registry in acp-hook.cjs. Fake
// layers tag their wrappers so the observable call order on a connector can be
// asserted; no real instrumentation module is loaded.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAcpRegistry } = require('../src/runtime/acp-hook.cjs');

function fixture() {
  const events = [];
  const api = {
    registerConnection(connector) {
      events.push('register');
      return { dispose() { events.push('native-dispose'); } };
    },
  };
  const originalRegister = api.registerConnection;
  const connector = { sendRequest() { events.push('native'); return 'result'; } };
  const originalSend = connector.sendRequest;

  // A fake layer wraps connector.sendRequest and tags each call. Once its
  // registry handle reports !attached the wrapper turns pass-through, mirroring
  // the real modules' own disposed flags.
  function layer(id, priority) {
    let handle;
    const wrappers = new Map();
    handle = createAcpRegistry(api).addLayer({
      id, priority,
      attach(target) {
        const prev = target.sendRequest;
        const status = () => handle.status().attached;
        const wrapper = function (...args) {
          if (status()) events.push(id);
          return prev.apply(this, args);
        };
        wrappers.set(target, { prev, wrapper });
        target.sendRequest = wrapper;
        events.push(`attach:${id}`);
        return target;
      },
      detach(target) {
        const record = wrappers.get(target);
        if (!record) return;
        events.push(`detach:${id}`);
        if (target.sendRequest === record.wrapper) target.sendRequest = record.prev;
        else delete target.sendRequest;
        wrappers.delete(target);
      },
    });
    return handle;
  }

  return { api, connector, events, originalRegister, originalSend, layer };
}

test('connector wrap order follows priority regardless of layer install order', () => {
  for (const order of [['goal-continue', 'auto-continue', 'acp-observer'],
                       ['acp-observer', 'auto-continue', 'goal-continue']]) {
    const f = fixture();
    const priority = { 'auto-continue': 10, 'goal-continue': 20, 'acp-observer': 30 };
    for (const id of order) f.layer(id, priority[id]);
    f.api.registerConnection(f.connector);
    f.events.length = 0;
    assert.equal(f.connector.sendRequest({}), 'result');
    assert.deepEqual(f.events, ['acp-observer', 'goal-continue', 'auto-continue', 'native']);
  }
});

test('removing a buried layer makes it pass-through and drains it when it reaches the top', () => {
  const f = fixture();
  const auto = f.layer('auto-continue', 10);
  const goal = f.layer('goal-continue', 20);
  const observer = f.layer('acp-observer', 30);
  f.api.registerConnection(f.connector);

  // auto-continue is innermost; removing it cannot detach physically yet.
  auto.remove();
  f.events.length = 0;
  f.connector.sendRequest({});
  assert.deepEqual(f.events, ['acp-observer', 'goal-continue', 'native']);
  assert.equal(f.api.registerConnection === f.originalRegister, false);

  observer.remove();
  assert.deepEqual(f.events.filter(e => e.startsWith('detach:')), ['detach:acp-observer']);
  f.events.length = 0;
  f.connector.sendRequest({});
  assert.deepEqual(f.events, ['goal-continue', 'native']);

  goal.remove();
  assert.deepEqual(f.events.filter(e => e.startsWith('detach:')), ['detach:goal-continue', 'detach:auto-continue']);
  assert.equal(f.connector.sendRequest, f.originalSend);
  assert.equal(f.api.registerConnection, f.originalRegister);
});

test('duplicate layer ids are rejected and remove is idempotent', () => {
  const f = fixture();
  const handle = f.layer('goal-continue', 20);
  assert.throws(() => f.layer('goal-continue', 99), /Duplicate ACP injection layer id/);
  f.api.registerConnection(f.connector);
  handle.remove();
  assert.doesNotThrow(() => handle.remove());
  assert.equal(f.connector.sendRequest, f.originalSend);
  assert.equal(f.api.registerConnection, f.originalRegister);
});

test('a layer whose attach throws neither blocks registration nor participates in detach', () => {
  const f = fixture();
  const registry = createAcpRegistry(f.api);
  registry.addLayer({ id: 'broken', priority: 5,
    attach() { throw new Error('attach failure'); },
    detach() { f.events.push('detach:broken'); } });
  f.layer('acp-observer', 30);
  const registration = f.api.registerConnection(f.connector);
  assert.equal(typeof registration.dispose, 'function');
  f.events.length = 0;
  registration.dispose();
  assert.deepEqual(f.events, ['detach:acp-observer', 'native-dispose']);
  assert.equal(f.connector.sendRequest, f.originalSend);
});

test('registration dispose detaches the connector layers in reverse attach order first', () => {
  const f = fixture();
  f.layer('auto-continue', 10);
  f.layer('goal-continue', 20);
  f.layer('acp-observer', 30);
  const registration = f.api.registerConnection(f.connector);
  f.events.length = 0;
  registration.dispose();
  assert.deepEqual(f.events, ['detach:acp-observer', 'detach:goal-continue', 'detach:auto-continue', 'native-dispose']);
  assert.equal(f.connector.sendRequest, f.originalSend);
});

test('a third-party wrapper on top of a fully removed registry stays resident without recursion', () => {
  const f = fixture();
  const first = f.layer('goal-continue', 20);
  f.api.registerConnection(f.connector);

  // Foreign override that chains into our wrapper, as real extensions do.
  const foreignCalls = [];
  const ours = f.api.registerConnection;
  const foreign = function (...args) { foreignCalls.push(args[0]); return ours.apply(this, args); };
  f.api.registerConnection = foreign;
  first.remove();
  assert.equal(f.api.registerConnection, foreign);

  // Re-adding a layer must not re-wrap: our registerConnection stays buried
  // under the foreign one and keeps attaching layers to new connectors.
  const second = f.layer('acp-observer', 30);
  const originalSend = function () { return 'ok'; };
  const other = { sendRequest: originalSend };
  f.api.registerConnection(other);
  assert.equal(foreignCalls.length, 1);
  assert.equal(f.events.filter(e => e === 'attach:acp-observer').length, 1);
  assert.notEqual(other.sendRequest, originalSend);
  assert.equal(second.status().connectors, 1);
  assert.equal(second.status().attached, true);
  assert.deepEqual(createAcpRegistry(f.api).inspect(),
    [{ id: 'acp-observer', priority: 30, connectors: 1, attached: true }]);
  second.remove();
});

test('inspect reports layer priority, activity and connector counts', () => {
  const f = fixture();
  f.layer('auto-continue', 10);
  f.layer('acp-observer', 30);
  assert.deepEqual(createAcpRegistry(f.api).inspect(), [
    { id: 'auto-continue', priority: 10, connectors: 0, attached: true },
    { id: 'acp-observer', priority: 30, connectors: 0, attached: true },
  ]);
});

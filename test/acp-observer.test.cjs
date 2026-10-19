'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/runtime/acp-observer.cjs'), 'utf8');
const NATIVE_MAIN = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/dist/extension.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const paths = [], registrations = [], logs = [], calls = [];
  const disposable = { dispose() {} };
  const api = { registerConnection(...args) { registrations.push({ thisArg: this, args }); return disposable; } };
  const originalRegister = api.registerConnection;
  const createRequire = nativePath => { paths.push(nativePath); return name => {
    assert.equal(name, 'vscode'); return { windsurfAcp: api };
  }; };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require(name) {
    if (name === 'node:module') return { createRequire };
    if (name === './acp-hook.cjs') {
      const hook = { exports: {} };
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/runtime/acp-hook.cjs'), 'utf8'),
        { module: hook, exports: hook.exports, require: () => ({ createRequire }) }, { filename: 'acp-hook.cjs' });
      return hook.exports;
    }
    assert.fail('unexpected require ' + name);
  } }, { filename: 'acp-observer.cjs' });
  function connection(value) {
    return { sendRequest(...args) { calls.push({ thisArg: this, args }); return value; } };
  }
  const install = options => module.exports.installAcpObserver({ nativeMainPath: NATIVE_MAIN,
    log: (event, counts) => logs.push({ event, counts }), ...options });
  return { api, originalRegister, paths, registrations, disposable, logs, calls, connection, install };
}

function response() {
  return { sessionId: 'private-session', _meta: { secret: 'private-response-token' }, configOptions: [
    { id: 'model', category: 'model', type: 'select', currentValue: 'native', options: [
      { value: 'native', name: 'Private label' },
      { group: 'Private group', options: [{ value: 'dfbyok-one' }, { value: 'fusion-dfbyok-one' }, { value: 'dfbyok-one' }] },
    ] },
    { category: 'mode', type: 'select', options: [{ value: 'dfbyok-not-a-model' }] },
  ] };
}

test('observes future registrations while preserving all native call arguments and exact Promise identity', async () => {
  const f = fixture(), handle = f.install(), data = response(), promise = Promise.resolve(data);
  const connection = f.connection(promise), receiver = {}, token = {}, extra = {};
  assert.equal(f.api.registerConnection.call(receiver, connection, extra), f.disposable);
  assert.equal(f.registrations[0].thisArg, receiver);
  assert.equal(f.registrations[0].args[0], connection);
  assert.equal(f.registrations[0].args[1], extra);
  const request = { method: 'session/new', params: { secret: 'private-request-token' } };
  assert.equal(connection.sendRequest.call(receiver, request, token, extra), promise);
  assert.equal(f.calls[0].thisArg, receiver);
  assert.equal(f.calls[0].args[0], request);
  assert.equal(f.calls[0].args[1], token);
  assert.equal(f.calls[0].args[2], extra);
  assert.equal(await promise, data);
  await tick();
  assert.deepEqual(clone(f.logs), [{ event: 'acp-models', counts: { rpc: 'session/new', configOptions: 2,
    modelSelectors: 1, models: 4, uniqueModels: 3, ownModels: 2, plainModels: 1, fusionModels: 1 } }]);
  assert.equal(handle.status.connections, 1);
  assert.equal(handle.status.responses, 1);
  assert.deepEqual(f.paths, [NATIVE_MAIN]);
  assert.ok(!JSON.stringify({ logs: f.logs, status: handle.status }).includes('private'));
});

test('never inspects authentication params or logs unrelated methods', async () => {
  const f = fixture(), handle = f.install(), connection = f.connection(Promise.resolve(response()));
  f.api.registerConnection(connection);
  // session/set_config_option is deliberately absent: it is an observed method.
  for (const method of ['authenticate', 'initialize', 'session/prompt', 'session/cancel']) {
    const request = { method, get params() { throw new Error('Request body must remain unread'); } };
    await connection.sendRequest(request);
  }
  assert.equal(f.logs.length, 0);
  assert.equal(handle.status.responses, 0);
  assert.equal(f.calls.length, 4);
});

test('counts all three session response methods and reports absent model lists explicitly', async () => {
  const f = fixture(); f.install();
  const connection = f.connection(Promise.resolve({ configOptions: [{ category: 'model', type: 'select', options: [] }] }));
  f.api.registerConnection(connection);
  for (const method of ['session/new', 'session/load', 'session/resume']) await connection.sendRequest({ method });
  assert.deepEqual(f.logs.map(entry => entry.counts.rpc), ['session/new', 'session/load', 'session/resume']);
  assert.ok(f.logs.every(entry => entry.counts.ownModels === 0 && entry.counts.models === 0));
  const missing = f.connection(Promise.resolve({}));
  f.api.registerConnection(missing);
  await missing.sendRequest({ method: 'session/new' });
  assert.equal(f.logs.at(-1).counts.modelSelectors, 0);
});

test('registration and request errors retain their exact original identity', async () => {
  const f = fixture(), registrationError = new Error('private-registration-failure');
  f.api.registerConnection = () => { throw registrationError; };
  f.install();
  const connection = f.connection(null), original = connection.sendRequest;
  assert.throws(() => f.api.registerConnection(connection), error => error === registrationError);
  assert.equal(connection.sendRequest, original);
  const g = fixture(); g.install();
  const failure = new Error('private-native-failure');
  const sync = { sendRequest() { throw failure; } };
  g.api.registerConnection(sync);
  assert.throws(() => sync.sendRequest({ method: 'session/new' }), error => error === failure);
  const rejected = Promise.reject(failure), asyncConnection = g.connection(rejected);
  g.api.registerConnection(asyncConnection);
  assert.equal(asyncConnection.sendRequest({ method: 'session/load' }), rejected);
  await assert.rejects(rejected, error => error === failure);
  assert.equal(g.logs.length, 0);
});

test('diagnostic failures, malformed objects, and synchronous returns cannot change native responses', async () => {
  const f = fixture(); f.install({ log() { throw new Error('private-log-failure'); } });
  const data = response(), sync = f.connection(data);
  f.api.registerConnection(sync);
  assert.equal(sync.sendRequest({ method: 'session/new' }), data);
  const malformed = { get configOptions() { throw new Error('Malformed response'); } };
  const promise = Promise.resolve(malformed), connection = f.connection(promise);
  f.api.registerConnection(connection);
  assert.equal(connection.sendRequest({ method: 'session/resume' }), promise);
  assert.equal(await promise, malformed);
  await tick();
});

test('idempotent installation and repeated registration observe each response only once', async () => {
  const f = fixture(), handle = f.install(), connection = f.connection(Promise.resolve(response()));
  assert.equal(f.install(), handle);
  f.api.registerConnection(connection);
  const wrapper = connection.sendRequest;
  f.api.registerConnection(connection);
  assert.equal(connection.sendRequest, wrapper);
  await connection.sendRequest({ method: 'session/new' });
  assert.equal(f.logs.length, 1);
  assert.equal(handle.status.connections, 1);
});

test('dispose restores own and inherited methods and ignores pending responses', async () => {
  const f = fixture(), handle = f.install();
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  const parent = { sendRequest() { return promise; } }, connection = Object.create(parent);
  f.api.registerConnection(connection);
  assert.ok(Object.hasOwn(connection, 'sendRequest'));
  assert.equal(connection.sendRequest({ method: 'session/new' }), promise);
  handle.dispose(); handle.dispose();
  assert.equal(f.api.registerConnection, f.originalRegister);
  assert.ok(!Object.hasOwn(connection, 'sendRequest'));
  assert.equal(connection.sendRequest, parent.sendRequest);
  resolve(response()); await promise; await tick();
  assert.equal(f.logs.length, 0);
  assert.equal(handle.status.state, 'disposed');
  assert.equal(handle.status.connections, 0);
  assert.notEqual(f.install(), handle);
});

test('dispose preserves wrappers installed by others and makes retained observer wrappers inert', async () => {
  const f = fixture(), handle = f.install(), connection = f.connection(Promise.resolve(response()));
  f.api.registerConnection(connection);
  const innerRegistration = f.api.registerConnection, innerRequest = connection.sendRequest;
  const registration = function (...args) { return innerRegistration.apply(this, args); };
  const request = function (...args) { return innerRequest.apply(this, args); };
  f.api.registerConnection = registration;
  connection.sendRequest = request;
  handle.dispose();
  assert.equal(f.api.registerConnection, registration);
  assert.equal(connection.sendRequest, request);
  await connection.sendRequest({ method: 'session/new' });
  const later = f.connection(null), original = later.sendRequest;
  f.api.registerConnection(later);
  assert.equal(later.sendRequest, original);
  // The foreign wrapper on registerConnection forces the registry to stay
  // resident, which reports the shadowing exactly once.
  assert.deepEqual(f.logs.map(entry => entry.event), ['acp-registry-shadowed']);
});

test('unwritable connectors still register successfully without observation', () => {
  const f = fixture(), handle = f.install(), connection = Object.freeze(f.connection(null));
  assert.equal(f.api.registerConnection(connection), f.disposable);
  assert.equal(handle.status.connections, 0);
});

test('counts remain immutable and expose no model values or response metadata', async () => {
  const f = fixture(), handle = f.install(), connection = f.connection(Promise.resolve(response()));
  f.api.registerConnection(connection);
  await connection.sendRequest({ method: 'session/new' });
  assert.ok(Object.isFrozen(handle.status));
  assert.ok(Object.isFrozen(handle.status.last));
  assert.throws(() => { handle.status.last.ownModels = 1000; }, TypeError);
  assert.ok(!JSON.stringify(handle.status).includes('dfbyok-one'));
});

test('config_option_update notifications are counted and set_config_option responses are observed', async () => {
  const f = fixture(), handle = f.install();
  const forwarded = [];
  const connection = {
    sendRequest() { return Promise.resolve(response()); },
    forwardClientRequest(...args) { forwarded.push(args); return 'private-forward-result'; },
  };
  const originalForward = connection.forwardClientRequest;
  const forwardDescriptor = Object.getOwnPropertyDescriptor(connection, 'forwardClientRequest');
  f.api.registerConnection(connection);
  const notification = { method: 'session/update', params: { sessionId: 'private-session', update: {
    sessionUpdate: 'config_option_update', configOptions: response().configOptions } } };
  assert.equal(connection.forwardClientRequest(notification), 'private-forward-result');
  assert.deepEqual(forwarded.map(args => args[0]), [notification]);
  await tick();
  assert.deepEqual(clone(f.logs), [{ event: 'acp-models', counts: { rpc: 'config_option_update', configOptions: 2,
    modelSelectors: 1, models: 4, uniqueModels: 3, ownModels: 2, plainModels: 1, fusionModels: 1 } }]);
  assert.equal(handle.status.lastUpdate, 'config_option_update');
  await connection.sendRequest({ method: 'session/set_config_option' });
  await tick();
  assert.equal(f.logs.at(-1).counts.rpc, 'session/set_config_option');
  assert.equal(handle.status.lastUpdate, 'session/set_config_option');
  handle.dispose();
  assert.equal(connection.forwardClientRequest, originalForward);
  assert.deepEqual({ ...Object.getOwnPropertyDescriptor(connection, 'forwardClientRequest') }, { ...forwardDescriptor });
  assert.ok(!JSON.stringify({ logs: f.logs, status: handle.status }).includes('private'));
});

test('unrelated session/update notifications pass through without observation or payload reads', async () => {
  const f = fixture(), handle = f.install();
  const connection = {
    sendRequest() { return Promise.resolve({}); },
    forwardClientRequest(...args) { return args[0]; },
  };
  f.api.registerConnection(connection);
  const chunk = { method: 'session/update', params: { sessionId: 'private-session', update: {
    sessionUpdate: 'agent_message_chunk',
    get configOptions() { throw new Error('Notification payload must remain unread'); },
  } } };
  assert.equal(connection.forwardClientRequest(chunk), chunk);
  await tick();
  assert.equal(f.logs.length, 0);
  assert.equal(handle.status.responses, 0);
  assert.equal(handle.status.lastUpdate, null);
  handle.dispose();
});

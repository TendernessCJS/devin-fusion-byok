'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandboxLoader } = require('./helpers/sandbox.cjs');
const filename = path.resolve(__dirname, '../src/activation/remote-support.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { install } = {}) {
  const installCalls = [], logs = [], disposed = [];
  const behavior = install || (() => ({
    status: () => ['tunnel'], ensureCurrentRemoteWindowTunnel: () => Promise.resolve(39842),
    dispose() { disposed.push(true); } }));
  const loader = createSandboxLoader({ filename, overrides: {
    '../runtime/host/remote-tunnel.cjs': {
      installRemoteSupport: options => { installCalls.push(options); return behavior(options); } },
  } });
  t.after(() => loader.assertStubsUsed('remote-support'));
  const vscode = { extensions: { getExtension: () => undefined }, env: {} };
  const support = loader.module.exports.createRemoteSupport({ vscode, root: '/root', log: event => logs.push(event) });
  return { support, installCalls, logs, disposed, loader };
}

test('concurrent and repeated starts install exactly once', async t => {
  const f = fixture(t);
  await Promise.all([f.support.start(), f.support.start()]);
  assert.equal(f.installCalls.length, 1, 'concurrent starts share the in-flight install');
  await f.support.start();
  assert.equal(f.installCalls.length, 1, 'a completed install is never repeated');
});

test('a failed install logs once, never throws, and a later start retries', async t => {
  let attempts = 0;
  const f = fixture(t, { install: () => {
    attempts++;
    if (attempts === 1) throw new Error('no api');
    return { status: () => ['tunnel'], ensureCurrentRemoteWindowTunnel: () => Promise.resolve(39842), dispose() {} };
  } });
  await f.support.start();
  await tick();
  assert.deepEqual(f.logs, ['remote-support-unavailable']);
  assert.equal(f.installCalls.length, 1);
  await f.support.start();
  assert.equal(f.installCalls.length, 2, 'the cleared install promise lets a later start retry');
  assert.deepEqual(f.support.status(), ['tunnel']);
});

test('stop disposes the manager and clears status', async t => {
  const f = fixture(t);
  await f.support.start();
  assert.deepEqual(f.support.status(), ['tunnel']);
  f.support.stop();
  assert.equal(f.disposed.length, 1);
  assert.equal(f.support.status().length, 0);
});

test('a stop issued mid-install disposes the arriving manager', async t => {
  const logs = [], disposed = [], installCalls = [];
  let support;
  const loader = createSandboxLoader({ filename, overrides: {
    '../runtime/host/remote-tunnel.cjs': { installRemoteSupport: () => {
      installCalls.push(true);
      support.stop();
      return { status: () => ['t'], ensureCurrentRemoteWindowTunnel: () => Promise.resolve(1),
        dispose() { disposed.push(true); } };
    } },
  } });
  t.after(() => loader.assertStubsUsed('remote-support'));
  support = loader.module.exports.createRemoteSupport({
    vscode: { extensions: { getExtension: () => undefined } }, root: '/root', log: event => logs.push(event) });
  await support.start();
  assert.equal(installCalls.length, 1);
  assert.equal(disposed.length, 1, 'the generation guard drops a manager installed after stop');
  assert.equal(support.status().length, 0);
});

test('ensureCurrentRemoteWindowTunnel rejects before install and delegates after', async t => {
  let result = Promise.resolve(39842);
  const manager = { status: () => ['tunnel'], ensureCurrentRemoteWindowTunnel: () => result, dispose() {} };
  const f = fixture(t, { install: () => manager });
  await assert.rejects(f.support.ensureCurrentRemoteWindowTunnel(), /remote_tunnel_unavailable/);
  assert.deepEqual(f.logs, ['remote-tunnel-unavailable']);
  await f.support.start();
  assert.equal(await f.support.ensureCurrentRemoteWindowTunnel(), 39842);
  result = Promise.reject(new Error('tunnel_down'));
  await assert.rejects(f.support.ensureCurrentRemoteWindowTunnel(), /tunnel_down/);
  assert.deepEqual(f.logs, ['remote-tunnel-unavailable', 'remote-tunnel-unavailable'],
    'a tunnel failure logs once and still propagates');
});

test('stop then start reinstalls a fresh manager and only that one stays live', async t => {
  const f = fixture(t);
  await f.support.start();
  f.support.stop();
  assert.equal(f.disposed.length, 1);
  await f.support.start();
  assert.equal(f.installCalls.length, 2, 'a stopped support installs again');
  assert.equal(f.disposed.length, 1, 'the old manager stays the only disposed one');
  assert.deepEqual(f.support.status(), ['tunnel']);
  await f.support.start();
  assert.equal(f.installCalls.length, 2, 'the fresh manager guards against a third install');
});

test('a stale install settling cannot clear a newer in-flight install', async t => {
  const logs = [], disposed = [], installCalls = [];
  let support, pending;
  const loader = createSandboxLoader({ filename, overrides: {
    '../runtime/host/remote-tunnel.cjs': { installRemoteSupport: () => {
      installCalls.push(true);
      // The old install's caller stops the generation and immediately starts
      // a new one — the stale promise must not clear the new install.
      if (installCalls.length === 1) { support.stop(); pending = support.start(); }
      const id = installCalls.length;
      return { status: () => ['m' + id], ensureCurrentRemoteWindowTunnel: () => Promise.resolve(1),
        dispose() { disposed.push(id); } };
    } },
  } });
  t.after(() => loader.assertStubsUsed('remote-support'));
  support = loader.module.exports.createRemoteSupport({
    vscode: { extensions: { getExtension: () => undefined } }, root: '/root', log: event => logs.push(event) });
  await pending;
  await support.start();
  await tick();
  assert.equal(installCalls.length, 2, 'stop during install lets a new install proceed');
  assert.equal(disposed.length, 1, 'exactly the stale manager is disposed');
  assert.deepEqual(support.status(), ['m2'], 'the newer manager is the live one');
  await support.start();
  assert.equal(installCalls.length, 2, 'a stale finally must not make the next start reinstall');
});

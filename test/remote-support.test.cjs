'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
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

test('a failed install records a bounded error summary', async t => {
  const logs = [];
  const loader = createSandboxLoader({ filename, overrides: {
    '../runtime/host/remote-tunnel.cjs': { installRemoteSupport: () => {
      const error = new Error('x'.repeat(500)); error.code = 'ERR_INSTALL'; throw error; } },
  } });
  t.after(() => loader.assertStubsUsed('remote-support'));
  const support = loader.module.exports.createRemoteSupport({
    vscode: { extensions: { getExtension: () => undefined } }, root: '/root',
    log: (event, data) => logs.push({ event, ...data }) });
  await support.start();
  await tick();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'remote-support-unavailable');
  assert.equal(logs[0].code, 'ERR_INSTALL', 'the cause is no longer swallowed');
  assert.equal(logs[0].message.length, 200, 'the message is truncated before it reaches the log');
});

test('discoverRemoteMain resolves a manifest main that omits the extension', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-remote-main-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'dist'));
  const file = path.join(root, 'dist/extension.js');
  fs.writeFileSync(file, 'module.exports = {};');
  const { discoverRemoteMain } = require(filename);
  const vscode = { extensions: { getExtension: () => ({ extensionPath: root, packageJSON: { main: './dist/extension' } }) } };
  assert.equal(discoverRemoteMain(vscode, 'codeium.windsurf-remote-openssh', 'unused'),
    file, 'an extensionless main must anchor to the file that exists');
  vscode.extensions.getExtension = () => ({ extensionPath: root, packageJSON: { main: './dist/extension.js' } });
  assert.equal(discoverRemoteMain(vscode, 'x', 'unused'), file, 'an explicit extension is kept as is');
  vscode.extensions.getExtension = () => ({ extensionPath: root, packageJSON: { main: './dist/missing' } });
  assert.equal(discoverRemoteMain(vscode, 'x', 'unused'), null, 'a main with no file on disk resolves to null');
});

test('discoverRemoteMain falls back to appRoot and resolves the same way', t => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-remote-app-'));
  t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(appRoot, 'extensions/windsurf-remote-wsl/dist'), { recursive: true });
  const file = path.join(appRoot, 'extensions/windsurf-remote-wsl/dist/extension.js');
  fs.writeFileSync(file, 'module.exports = {};');
  const { discoverRemoteMain } = require(filename);
  const vscode = { extensions: { getExtension: () => undefined }, env: { appRoot } };
  assert.equal(discoverRemoteMain(vscode, 'codeium.windsurf-remote-wsl', 'extensions/windsurf-remote-wsl/dist/extension.js'), file);
  assert.equal(discoverRemoteMain(vscode, 'codeium.windsurf-remote-wsl', 'extensions/nope/dist/extension.js'), null);
});

test('describeError falls back to the error name and omits an empty message', () => {
  const { describeError } = require(filename);
  assert.deepEqual(describeError(new TypeError('read only')), { code: 'TypeError', message: 'read only' });
  assert.deepEqual(describeError({}), { code: 'error' });
});

test('the local-window probe installs inert wrappers, disposes them and reports success', t => {
  const logs = []; let disposed = 0, inert = null;
  const loader = createSandboxLoader({ filename, overrides: {
    '../runtime/host/remote-tunnel.cjs': { installRemoteSupport: options => {
      inert = options.isEnabled(); return { dispose() { disposed++; } }; } },
  } });
  t.after(() => loader.assertStubsUsed('remote-support'));
  const ok = loader.module.exports.probeRemoteSupport({
    vscode: { extensions: { getExtension: () => undefined } }, root: '/root',
    log: (event, data) => logs.push({ event, ...data }) });
  assert.equal(ok, true);
  assert.equal(inert, false, 'the probe must never be able to inject ssh arguments');
  assert.equal(disposed, 1, 'the probe leaves no wrapper behind');
  assert.deepEqual(logs, [{ event: 'remote-support-probe', installed: true }]);
});

test('the local-window probe keeps the cause of a failed install', t => {
  const logs = [];
  const loader = createSandboxLoader({ filename, overrides: {
    '../runtime/host/remote-tunnel.cjs': { installRemoteSupport: () => {
      const error = new Error('Cannot set property spawn'); error.code = 'ERR_PROBE'; throw error; } },
  } });
  t.after(() => loader.assertStubsUsed('remote-support'));
  const ok = loader.module.exports.probeRemoteSupport({
    vscode: { extensions: { getExtension: () => undefined } }, root: '/root',
    log: (event, data) => logs.push({ event, ...data }) });
  assert.equal(ok, false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'remote-support-probe');
  assert.equal(logs[0].code, 'ERR_PROBE');
  assert.equal(logs[0].message, 'Cannot set property spawn');
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

'use strict';

// R3 structural guardrail for the LS injection bridge pool. Each observed
// native LS port — the main port (setPort / Heartbeat) and every child LS port
// (setChildLanguageServerInfo) — gets its own bridge in a shared map; ports
// observed concurrently stay alive side by side and idle bridges are reclaimed
// only after their TTL expires.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const url = require('node:url');

const source = fs.readFileSync(path.join(__dirname, '../src/runtime/host/ls-injection.cjs'), 'utf8');
const NATIVE_MAIN = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/dist/extension.js';
const HEARTBEAT = '/exa.language_server_pb.LanguageServerService/Heartbeat';
const tick = () => new Promise(resolve => setImmediate(resolve));

function fakeClock() {
  let current = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => current,
    setTimeout: (fn, ms) => {
      const id = ++sequence;
      timers.set(id, { fn, at: current + ms });
      return { id, unref() {} };
    },
    clearTimeout: handle => timers.delete(handle?.id ?? handle),
    advance(ms) {
      current += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= current) { timers.delete(id); timer.fn(); }
      }
    },
    pending: () => timers.size,
  };
}

function fixture({ clock, ttlMs } = {}) {
  const requests = [];
  const setters = [];
  const closed = [];
  const created = [];
  const childCalls = [];
  const http = {
    request(...args) { requests.push(args); return { native: 'request' }; },
  };
  const childSetter = (...args) => { childCalls.push(args); return 'native-child'; };
  const api = {
    setPort(...args) { setters.push(args); return { native: 'setter' }; },
    setChildLanguageServerInfo: childSetter,
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    URL,
    require(name) {
      if (name === 'node:url') return url;
      assert.equal(name, 'node:module');
      return { createRequire() {
        return inner => {
          if (inner === 'http') return http;
          if (inner === 'vscode') return { windsurfLanguageServer: api };
          throw new Error(`Unexpected native module: ${inner}`);
        };
      } };
    },
  }, { filename: 'ls-injection.cjs' });
  function createBridge(port) { created.push(port); return { port: port + 10000, close() { closed.push(port + 10000); } }; }
  function beat(port, host = '127.0.0.1') {
    return http.request(`http://${host}:${port}${HEARTBEAT}`, { method: 'POST' });
  }
  function install(options = {}) {
    return module.exports.installLsInjection({ nativeMainPath: NATIVE_MAIN, createBridge, clock, ttlMs, ...options });
  }
  return { http, api, requests, setters, closed, created, childCalls, childSetter, beat, install };
}

test('a second observed port gets its own bridge and the first is only closed at TTL', async () => {
  const clock = fakeClock();
  const f = fixture({ clock, ttlMs: 1000 });
  const handle = await f.install();
  f.beat(4567);
  await tick();
  assert.deepEqual(f.created, [4567]);
  assert.deepEqual(f.setters.map(call => call[0]), [14567]);

  clock.advance(500);
  f.beat(7890);
  await tick();
  assert.deepEqual(f.created, [4567, 7890]);
  assert.deepEqual(f.setters.map(call => call[0]), [14567, 17890]);
  assert.deepEqual(f.closed, []);
  assert.equal(handle.status.bridges, 2);

  // One ms before the first bridge's TTL: both still alive.
  clock.advance(499);
  await tick();
  assert.deepEqual(f.closed, []);
  // At expiry only the idle 4567 bridge is reclaimed; 7890 is now the
  // current main bridge, which the TTL never reclaims.
  clock.advance(1);
  await tick();
  assert.deepEqual(f.closed, [14567]);
  assert.equal(handle.status.bridges, 1);
  clock.advance(60 * 1000);
  await tick();
  assert.deepEqual(f.closed, [14567]);
  assert.equal(handle.status.bridges, 1);
  assert.equal(handle.status.proxyPort, 17890);
  await handle.dispose();
});

test('setChildLanguageServerInfo rewrites the port to the bridge without mutating the payload', async () => {
  const f = fixture();
  const handle = await f.install();
  f.beat(4567);
  await tick();
  assert.notEqual(f.api.setChildLanguageServerInfo, f.childSetter);

  const info = { workspaceUri: 'file:///a', port: 4567, csrfToken: 'private-csrf', other: 'kept' };
  const extra = { marker: true };
  assert.equal(f.api.setChildLanguageServerInfo(info, extra), 'native-child');
  const forwarded = f.childCalls.at(-1)[0];
  assert.notEqual(forwarded, info);
  assert.equal(forwarded.port, 14567);
  assert.equal(forwarded.csrfToken, 'private-csrf');
  assert.equal(forwarded.other, 'kept');
  assert.equal(info.port, 4567);
  assert.equal(f.childCalls.at(-1)[1], extra);

  // Invalid ports are passed through untouched and never create bridges.
  const before = f.created.length;
  const raw = { workspaceUri: 'file:///b', port: 'not-a-port' };
  f.api.setChildLanguageServerInfo(raw);
  assert.equal(f.childCalls.at(-1)[0], raw);
  assert.equal(f.created.length, before);
  assert.equal(f.created.length, 1);

  await handle.dispose();
  assert.equal(f.api.setChildLanguageServerInfo, f.childSetter);
});

test('the current main bridge never idles out while a child bridge expires by TTL', async () => {
  const clock = fakeClock();
  const f = fixture({ clock, ttlMs: 1000 });
  const handle = await f.install();
  f.beat(4567);
  await tick();
  f.api.setChildLanguageServerInfo({ workspaceUri: 'file:///a', port: 7890 });
  await tick();
  assert.equal(handle.status.bridges, 2);

  clock.advance(999);
  await tick();
  assert.deepEqual(f.closed, []);
  clock.advance(1);
  await tick();
  // The child bridge hit its TTL; the main bridge is re-armed, not reclaimed.
  assert.deepEqual(f.closed, [17890]);
  assert.equal(handle.status.bridges, 1);
  assert.equal(handle.status.proxyPort, 14567);

  // Advancing far past the TTL still never expires the main bridge.
  clock.advance(60 * 1000);
  await tick();
  assert.deepEqual(f.closed, [17890]);
  assert.equal(handle.status.bridges, 1);
  assert.equal(handle.status.proxyPort, 14567);
  await handle.dispose();
});

test('two active ports each rewrite to their own bridge', async () => {
  const f = fixture();
  const handle = await f.install();
  f.beat(4567);
  await tick();
  f.beat(7890);
  await tick();
  f.api.setChildLanguageServerInfo({ workspaceUri: 'file:///a', port: 4567 });
  f.api.setChildLanguageServerInfo({ workspaceUri: 'file:///b', port: 7890 });
  assert.equal(f.childCalls.at(-2)[0].port, 14567);
  assert.equal(f.childCalls.at(-1)[0].port, 17890);
  assert.deepEqual(f.closed, []);
  await handle.dispose();
  assert.deepEqual(f.closed, [14567, 17890]);
});

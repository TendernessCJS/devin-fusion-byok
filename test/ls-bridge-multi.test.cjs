'use strict';

// R0 structural guardrail for the LS injection bridge. The current
// implementation manages exactly one bridge: observing a new native LS port
// swaps the bridge and closes the predecessor. The multi-instance design (one
// bridge per observed port plus a child-LS rewrite through
// setChildLanguageServerInfo) is marked todo until R3 lands.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const url = require('node:url');

const source = fs.readFileSync(path.join(__dirname, '../src/runtime/ls-injection.cjs'), 'utf8');
const NATIVE_MAIN = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/dist/extension.js';
const HEARTBEAT = '/exa.language_server_pb.LanguageServerService/Heartbeat';
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
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
    return module.exports.installLsInjection({ nativeMainPath: NATIVE_MAIN, createBridge, ...options });
  }
  return { http, api, requests, setters, closed, created, childCalls, childSetter, beat, install };
}

// Characterizes today's single-slot bridge: a newer port wins and the previous
// bridge is closed eagerly. R3 replaces that eager close with an idle TTL, so
// this expectation is expected to change with the implementation (the todo case
// below states the target). Do not "restore" eager closing to keep this green.
test('observing a second LS port redirects setPort to the new bridge and closes the old one', async () => {
  const f = fixture();
  const handle = await f.install();
  f.beat(4567);
  await tick();
  assert.deepEqual(f.created, [4567]);
  assert.deepEqual(f.setters.map(call => call[0]), [14567]);

  f.beat(7890);
  await tick();
  assert.deepEqual(f.created, [4567, 7890]);
  assert.deepEqual(f.setters.map(call => call[0]), [14567, 17890]);
  assert.deepEqual(f.closed, [14567]);
  await handle.dispose();
});

test('setChildLanguageServerInfo stays the native function while installed and after dispose', async () => {
  const f = fixture();
  const handle = await f.install();
  f.beat(4567);
  await tick();
  assert.equal(f.api.setChildLanguageServerInfo, f.childSetter);
  await handle.dispose();
  assert.equal(f.api.setChildLanguageServerInfo, f.childSetter);
});

// R3 turns the bridge into a per-port multi-instance pool:
// setChildLanguageServerInfo({ workspaceUri, port, csrfToken }) is rewritten to
// that workspace's bridge port, simultaneous bridges each serve their own
// requests, and a superseded bridge is reclaimed by an idle TTL instead of
// being closed eagerly.
test('child LS info is rewritten per bridge and idle bridges expire via TTL',
  { todo: 'R3 multi-instance LS bridge: per-port bridges, child-LS rewrite, idle-TTL reclaim' },
  async () => {
    const f = fixture();
    const handle = await f.install();
    f.beat(4567);
    f.beat(7890);
    await tick();
    assert.notEqual(f.api.setChildLanguageServerInfo, f.childSetter);
    f.api.setChildLanguageServerInfo({ workspaceUri: 'file:///a', port: 4567, csrfToken: 't' });
    assert.equal(f.childCalls.at(-1)[0].port, 14567);
    assert.deepEqual(f.closed, []);
    await handle.dispose();
  });

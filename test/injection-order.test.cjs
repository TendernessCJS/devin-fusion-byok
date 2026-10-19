'use strict';

// R0 structural guardrail for the ACP monkeypatch layers: three independent
// installers (goal/continue, runtime/auto-continue, runtime/acp-observer) each
// wrap the same `api.registerConnection`. The current invariant is that
// disposing in exact reverse install order restores every patch. Disposing in
// `deactivate()` order (auto -> goal -> observer) leaves stale wrappers today;
// that case is marked todo until the R1 injection orchestration layer lands.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const NATIVE_MAIN = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/dist/extension.js';
const ROOT = path.join(__dirname, '../src');

// The shared undo plumbing, loaded once; it has no per-installer state. Its
// createRequire resolves 'vscode' against whichever fake api the active
// fixture installed (loadModule always points currentApi at that fixture).
let currentApi = null;
const acpHook = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'runtime/acp-hook.cjs'), 'utf8'),
  { module: acpHook, exports: acpHook.exports,
    require: () => ({ createRequire: () => name => {
      assert.equal(name, 'vscode');
      return { windsurfAcp: currentApi };
    } }) },
  { filename: 'acp-hook.cjs' });

function loadModule(relative, api) {
  const file = path.join(ROOT, relative);
  const source = fs.readFileSync(file, 'utf8');
  const module = { exports: {} };
  const vscode = { windsurfAcp: api, CancellationToken: { None: {} } };
  currentApi = api;
  vm.runInNewContext(source, {
    module, exports: module.exports,
    setTimeout, clearTimeout, setInterval, clearInterval,
    require(name) {
      if (name === 'node:crypto') return crypto;
      if (name === 'node:module') {
        return { createRequire(nativePath) {
          assert.equal(nativePath, NATIVE_MAIN);
          return inner => {
            assert.equal(inner, 'vscode');
            return vscode;
          };
        } };
      }
      if (name.endsWith('acp-hook.cjs')) return acpHook.exports;
      assert.fail('unexpected require ' + name);
    },
  }, { filename: path.basename(file) });
  return module.exports;
}

function fixture() {
  const registrations = [];
  const registration = { dispose() { registration.disposed = true; } };
  const api = {
    registerConnection(...args) { registrations.push(args); return registration; },
  };
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' },
    sendRequest() { return { stopReason: 'end_turn' }; },
    forwardClientRequest() {},
  };
  const originalSend = connector.sendRequest;
  const originalForward = connector.forwardClientRequest;
  const descriptor = Object.getOwnPropertyDescriptor(api, 'registerConnection');
  const goal = loadModule('goal/continue.cjs', api);
  const auto = loadModule('runtime/auto-continue.cjs', api);
  const observer = loadModule('runtime/acp-observer.cjs', api);
  function installAll() {
    const goalHandle = goal.installGoalContinue({ nativeMainPath: NATIVE_MAIN });
    const autoHandle = auto.installAutoContinue({ nativeMainPath: NATIVE_MAIN });
    const observerHandle = observer.installAcpObserver({ nativeMainPath: NATIVE_MAIN });
    return { goalHandle, autoHandle, observerHandle };
  }
  return { api, connector, registration, registrations, descriptor,
    originalRegister: api.registerConnection, originalSend, originalForward,
    observer, installAll };
}

function assertRegisterRestored(t, f) {
  const after = Object.getOwnPropertyDescriptor(t, 'registerConnection');
  assert.equal(t.registerConnection, f.originalRegister);
  assert.deepEqual(
    { writable: after.writable, enumerable: after.enumerable, configurable: after.configurable },
    { writable: f.descriptor.writable, enumerable: f.descriptor.enumerable, configurable: f.descriptor.configurable });
  assert.equal(after.value, f.descriptor.value);
}

// Guarded invariant: strict reverse install order restores the shared
// registerConnection member, including its property descriptor. Connector-level
// wrappers are intentionally not asserted here: measured attach order on a
// connector is auto -> goal -> observer (stack trace: auto-continue.cjs:735
// attaches before delegating, continue.cjs:489 attaches when the call reaches
// the innermost wrapper, acp-observer.cjs:82 wraps last), while install order is
// goal -> auto -> observer. Strict LIFO dispose therefore still leaves the
// auto wrapper behind; that risk is covered by the todo case below.
test('reverse-order dispose restores every registerConnection layer', () => {
  const f = fixture();
  const { goalHandle, autoHandle, observerHandle } = f.installAll();
  assert.notEqual(f.api.registerConnection, f.originalRegister);

  observerHandle.dispose();
  autoHandle.dispose();
  goalHandle.dispose();

  assertRegisterRestored(f.api, f);
});

test('acp-observer dispose is idempotent and does not disturb a restored API', () => {
  const f = fixture();
  const handle = f.observer.installAcpObserver({ nativeMainPath: NATIVE_MAIN });
  f.api.registerConnection(f.connector);
  handle.dispose();
  assert.equal(f.api.registerConnection, f.originalRegister);
  const restoredSend = f.connector.sendRequest;
  assert.doesNotThrow(() => handle.dispose());
  assert.equal(f.api.registerConnection, f.originalRegister);
  assert.equal(f.connector.sendRequest, restoredSend);
});

// deactivate() tears down auto-continue and goal-continue before the
// acp-observer; each layer then finds a foreign wrapper on top of its own and
// restoreMember correctly refuses to remove it, but the wrapper stays behind.
// R1's unified registry will dispose strictly LIFO, flipping this green.
test('deactivate-order dispose (auto -> goal -> observer) also restores all patches',
  { todo: 'R1 injection orchestration: unified LIFO registry makes out-of-order dispose safe' },
  () => {
    const f = fixture();
    const { goalHandle, autoHandle, observerHandle } = f.installAll();
    f.api.registerConnection(f.connector);
    autoHandle.dispose();
    goalHandle.dispose();
    observerHandle.dispose();
    assertRegisterRestored(f.api, f);
    assert.equal(f.connector.sendRequest, f.originalSend);
  });

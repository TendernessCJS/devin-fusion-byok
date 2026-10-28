'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '../../src/runtime/host/auto-continue.cjs'), 'utf8');
const NATIVE_MAIN = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/dist/extension.js';

function fixture() {
  const registrations = [], logs = [];
  const disposable = { dispose() {} };
  const api = { registerConnection(...args) { registrations.push({ thisArg: this, args }); return disposable; } };
  const originalRegister = api.registerConnection;
  const createRequire = () => modName => {
    assert.equal(modName, 'vscode');
    return {
      windsurfAcp: api,
      CancellationToken: { None: Symbol('CancellationToken.None') }
    };
  };
  const module = { exports: {} };

  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    setTimeout,
    clearTimeout,
    require(name) {
      if (name === 'node:crypto') return require('node:crypto');
      if (name === 'node:module') return { createRequire };
      if (name === './acp-hook.cjs') {
        const hook = { exports: {} };
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/runtime/host/acp-hook.cjs'), 'utf8'),
          { module: hook, exports: hook.exports, require: () => ({ createRequire }) }, { filename: 'acp-hook.cjs' });
        return hook.exports;
      }
      assert.fail('unexpected require ' + name);
    }
  }, { filename: 'auto-continue.cjs' });

  function install(options) {
    return module.exports.installAutoContinue({
      nativeMainPath: NATIVE_MAIN,
      log: (event, data) => logs.push({ event, data }),
      ...options
    });
  }

  return { api, originalRegister, registrations, disposable, logs, install,
    matchesProviderError: module.exports.matchesProviderError,
    matchesTerminalBlocker: module.exports.matchesTerminalBlocker };
}

function fakeScheduler() {
  let currentTime = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms = 0) {
      const id = nextId++;
      timers.set(id, { fn, time: currentTime + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      currentTime += ms;
      const ready = [...timers.entries()]
        .filter(([, t]) => t.time <= currentTime)
        .sort((a, b) => a[1].time - b[1].time);
      for (const [id, t] of ready) {
        if (timers.has(id)) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pendingCount() {
      return timers.size;
    }
  };
}

function planProgressFixture(t, protocolVersion) {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: true, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());
  const calls = [], resolvers = [];
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion,
    sendRequest(request) {
      calls.push(request);
      return protocolVersion === 2 ? Promise.resolve({ acknowledgment: true }) :
        new Promise(resolve => resolvers.push(resolve));
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  const sessionId = 'plan-progress';
  const update = value => connector.forwardClientRequest({
    method: 'session/update', params: { sessionId, update: value }
  });
  return {
    ...f, scheduler, handle, calls, update,
    prompt: () => connector.sendRequest({
      method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'task' }] }
    }),
    plan(entries, planId) {
      update(planId ? { sessionUpdate: 'plan_update', plan: { type: 'items', planId, entries } } :
        { sessionUpdate: 'plan', entries });
    },
    async finish(error = false, stopReason = 'end_turn') {
      const text = error ? 'Provider response could not be completed.' : 'Task finished; waiting for user confirmation.';
      update(protocolVersion === 2 ? {
        sessionUpdate: 'agent_message', messageId: `response-${calls.length}`, content: [{ type: 'text', text }]
      } : { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      if (protocolVersion === 2) update({ sessionUpdate: 'state_update', state: 'idle', stopReason });
      else resolvers.shift()({ stopReason });
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}
module.exports = { source, NATIVE_MAIN, fixture, fakeScheduler, planProgressFixture };

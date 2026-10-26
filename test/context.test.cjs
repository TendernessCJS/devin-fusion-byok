'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createContextState, usageRejectionReason, USAGE_REJECTIONS } = require('../src/runtime/host/context-state.cjs');
const { contextDetails, contextScript, contextHtml, createContextUi } = require('../src/panel/context-view.cjs');
const update = (used = 20, size = 100, meta) => ({ sessionUpdate: 'usage_update', used, size, ...(meta ? { _meta: { 'cognition.ai/subagent_context': meta } } : {}) });
const tick = () => new Promise(resolve => setImmediate(resolve));
test('context usage is session isolated, bounded, zero-aware and never substitutes subagent context', () => {
  const state = createContextState({ wallNow: () => 100, limit: 2 });
  state.observe('a', update(0));
  state.observe('a', update(40, 100, { parentAgentId: 'lead', runId: 'child' }));
  assert.equal(state.snapshot()[0].lead.used, 0);
  assert.equal(state.snapshot()[0].subagents[0].used, 40);
  for (const data of [update(-1), update(null), update(20, 0), update(20, NaN), update(60, 100, { parentAgentId: 'lead' })]) state.observe('a', data);
  assert.equal(state.snapshot()[0].lead.used, 0);
  state.observe('b', update(200));
  assert.equal(state.snapshot()[0].lead.used, 200);
  state.observe('c', update());
  assert.deepEqual(state.snapshot().map(x => x.sessionId), ['c', 'b']);
});
test('native subagent context accepts optional run IDs without overwriting lead or other scopes', () => {
  const state = createContextState();
  state.observe('s', update(10));
  assert.equal(state.observe('s', update(20, 100, { parentAgentId: 'a' })), true);
  state.observe('s', update(30, 100, { parentAgentId: 'b', runId: null }));
  state.observe('s', update(40, 100, { parentAgentId: 'a', runId: 'run' }));
  for (const runId of ['', 1, {}, []]) assert.equal(state.observe('s', update(99, 100, { parentAgentId: 'a', runId })), undefined);
  const session = state.snapshot()[0];
  assert.equal(session.lead.used, 10);
  assert.deepEqual(session.subagents.map(x => [x.parentAgentId, x.runId, x.used]), [['a', null, 20], ['b', null, 30], ['a', 'run', 40]]);
  assert.equal(contextDetails(session).rows.filter(row => row.key.startsWith('subagent:')).length, 3);
});
test('turn wall duration preserves generations and model changes invalidate context', () => {
  let now = 10;
  const state = createContextState({ now: () => now });
  const one = state.start('a'); now = 20;
  assert.equal(state.snapshot()[0].turn.durationMs, 10);
  const two = state.start('a'); now = 50;
  state.finish('a', one); assert.equal(state.snapshot()[0].turn.status, 'running');
  state.finish('a', two); now = 80;
  assert.equal(state.snapshot()[0].turn.durationMs, 30);
  const model = value => [{ category: 'model', type: 'select', currentValue: value }];
  state.selectModel('a', model('one')); state.observe('a', update());
  state.selectModel('a', model('two')); assert.equal(state.snapshot()[0].lead, null);
  state.reset('a'); assert.equal(state.snapshot().length, 0);
});
function fixture(protocolVersion = 1) {
  let enabled = true, response = Promise.resolve({}), forwardCalls = 0;
  const registrations = [], registration = { dispose() {} };
  const api = { registerConnection(...args) { registrations.push({ thisArg: this, args }); return registration; } }, original = api.registerConnection;
  const module = { exports: {} };
  const createRequire = () => () => ({ windsurfAcp: api });
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/runtime/host/context-observer.cjs'), 'utf8'), { module, exports: module.exports, require(name) {
    if (name === 'node:module') return { createRequire };
    if (name === './acp-hook.cjs') {
      const hook = { exports: {} };
      vm.runInNewContext(fs.readFileSync(require.resolve('../src/runtime/host/acp-hook.cjs'), 'utf8'),
        { module: hook, exports: hook.exports, require: () => ({ createRequire }) });
      return hook.exports;
    }
    return { createContextState, usageRejectionReason, USAGE_REJECTIONS };
  } });
  const connector = { agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion,
    sendRequest() { if (response instanceof Error) throw response; return response; },
    forwardClientRequest() { forwardCalls++; return 'forwarded'; }, setStatus() {} };
  const originalSend = connector.sendRequest, originalForward = connector.forwardClientRequest;
  const handle = module.exports.installContextObserver({ nativeMainPath: 'native', isEnabled: () => enabled });
  api.registerConnection(connector);
  return { api, original, connector, originalSend, originalForward, handle, registrations, registration, setResponse(value) { response = value; }, disable() { enabled = false; }, forwards: () => forwardCalls };
}
test('observer preserves native calls/promises, ignores authentication payload, tracks v1 and disposes', async () => {
  const f = fixture(), promise = Promise.resolve({}); f.setResponse(promise);
  assert.equal(f.connector.sendRequest({ method: 'authenticate', get params() { throw Error('must not read'); } }), promise);
  assert.equal(f.connector.sendRequest({ method: 'session/prompt', params: { sessionId: 'a' } }), promise);
  await tick(); assert.equal(f.handle.snapshot()[0].turn.status, 'finished');
  assert.equal(f.connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 'a', update: update() } }), 'forwarded');
  assert.equal(f.handle.snapshot()[0].lead.used, 20);
  f.handle.dispose(); assert.equal(f.connector.sendRequest, f.originalSend); assert.equal(f.connector.forwardClientRequest, f.originalForward); assert.equal(f.api.registerConnection, f.original);
  assert.equal(f.handle.snapshot().length, 0);
});
test('register passthrough, rejection identity and descriptor restore on inherited methods', async () => {
  const f = fixture();
  const first = f.registrations.at(-1);
  assert.equal(first.thisArg, f.api, 'registerConnection keeps the caller thisArg');
  assert.deepEqual(first.args, [f.connector], 'registerConnection forwards every argument');

  // A connector whose methods live on the prototype gets own wrappers that
  // delete cleanly on detach, revealing the inherited implementation again.
  const base = { sendRequest() { return 'sync-send'; }, forwardClientRequest() { return 'sync-fwd'; } };
  const inherited = Object.create(base);
  Object.assign(inherited, { agentId: 'devin-cli', bundled: true, location: { kind: 'local' } });
  const customThis = { marker: 1 };
  const returned = f.api.registerConnection.call(customThis, inherited, 'extra');
  assert.equal(returned, f.registration, 'the native registration object is returned untouched');
  const second = f.registrations.at(-1);
  assert.equal(second.thisArg, customThis);
  assert.deepEqual(second.args, [inherited, 'extra']);
  assert.equal(inherited.sendRequest({ method: 'session/cancel', params: { sessionId: 'x' } }), 'sync-send',
    'a synchronous native result keeps its identity');
  assert.equal(inherited.forwardClientRequest({ method: 'session/update' }), 'sync-fwd');

  const boom = new Error('native rejection');
  const rejected = Promise.reject(boom);
  f.setResponse(rejected);
  assert.equal(f.connector.sendRequest({ method: 'session/cancel', params: { sessionId: 'rej' } }), rejected,
    'a rejecting native Promise comes back as itself');
  await assert.rejects(rejected, error => error === boom, 'the rejection reason is not re-wrapped');

  f.handle.dispose();
  assert.equal(Object.hasOwn(inherited, 'sendRequest'), false, 'the own wrapper is removed, not replaced');
  assert.equal(inherited.sendRequest, base.sendRequest, 'the inherited implementation is visible again');
  assert.equal(inherited.forwardClientRequest, base.forwardClientRequest);
  assert.doesNotThrow(() => f.handle.dispose(), 'dispose is idempotent');
});
test('v2 acknowledgement is not completion; cancellation, failures, disable and disconnect clear safely', async () => {
  const f = fixture(2);
  f.connector.sendRequest({ method: 'session/prompt', params: { sessionId: 'a' } }); await tick();
  assert.equal(f.handle.snapshot()[0].turn.status, 'running');
  f.connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 'a', update: { sessionUpdate: 'state_update', state: 'idle' } } });
  assert.equal(f.handle.snapshot()[0].turn.status, 'idle');
  f.setResponse(new Error('native failure'));
  assert.throws(() => f.connector.sendRequest({ method: 'session/prompt', params: { sessionId: 'a' } }), /native failure/);
  assert.equal(f.handle.snapshot()[0].turn.status, 'error');
  f.connector.setStatus('disconnected'); assert.equal(f.handle.snapshot().length, 0);
  f.connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 'a', update: update() } });
  f.disable(); assert.equal(f.handle.snapshot().length, 0); f.handle.dispose();
});
test('a local transport-down status clears context state like a disconnect', async () => {
  const f = fixture(1);
  f.connector.sendRequest({ method: 'session/prompt', params: { sessionId: 'down' } }); await tick();
  assert.equal(f.handle.snapshot().length, 1);
  f.connector.setStatus('reconnectingMaxDelay');
  assert.equal(f.handle.snapshot().length, 0);
  assert.equal(f.handle.status().connections, 0);
  f.handle.dispose();
});
test('foreign connectors untouched and multiple connections with same session fail closed', () => {
  const f = fixture();
  const foreign = { ...f.connector, agentId: 'other', sendRequest() {} }, saved = foreign.sendRequest;
  f.api.registerConnection(foreign); assert.equal(foreign.sendRequest, saved);
  const second = { ...f.connector, sendRequest() {}, forwardClientRequest() {} };
  f.api.registerConnection(second);
  for (const connector of [f.connector, second]) connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 'a', update: update() } });
  assert.equal(f.handle.snapshot().length, 0); f.handle.dispose();
});
test('observer diagnostics distinguish connected traffic from missing usage without payloads', () => {
  const f = fixture();
  assert.equal(f.handle.status().connections, 1);
  assert.equal(f.handle.status().usageUpdates, 0);
  f.connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 'private-id', update: update(0) } });
  assert.equal(f.handle.status().sessionUpdates, 1);
  assert.equal(f.handle.status().usageUpdates, 1);
  assert.ok(!JSON.stringify(f.handle.status()).includes('private-id'));
  assert.equal(f.handle.snapshot()[0].lead.used, 0);
  f.handle.dispose();
  assert.equal(f.handle.status().connections, 0);
  assert.equal(f.handle.status().state, 'disposed');
});
test('usage rejection reasons are fixed, isolated and preserve valid zero and optional run IDs', () => {
  const f = fixture();
  try {
    // `missing-size` and `zero-size` are separate facts: one is an upstream shape
    // problem, the other is a value upstream sent. Folding them together once made
    // a startup replay read as a live rejection rate with no way to tell which.
    const cases = [[null, update(), 'invalid-session-id'], ['s', update(-1), 'invalid-used'],
      ['s', { sessionUpdate: 'usage_update', used: 20 }, 'missing-size'], ['s', update(20, null), 'missing-size'],
      ['s', update(0, 0), 'zero-size'],
      ['s', update(0, 100, { parentAgentId: '' }), 'invalid-parent-id'], ['s', update(0, 100, { parentAgentId: 'p', runId: 3 }), 'invalid-run-id']];
    for (const [sessionId, data, reason] of cases) {
      assert.equal(usageRejectionReason(sessionId, data), reason);
      f.connector.forwardClientRequest({ method: 'session/update', params: { sessionId, update: data } });
    }
    const valid = update(0, 100, { parentAgentId: 'p' });
    assert.equal(usageRejectionReason('s', valid), null);
    f.connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's', update: valid } });
    const status = f.handle.status();
    assert.equal(status.acceptedUsageUpdates, 1); assert.equal(status.rejectedUsageUpdates, 7);
    assert.deepEqual(Object.keys(status.usageRejections).sort(), [...USAGE_REJECTIONS].sort());
    // The counters are built inside the vm realm, so normalize before comparing.
    assert.deepEqual(JSON.parse(JSON.stringify(status.usageRejections)), Object.fromEntries(USAGE_REJECTIONS.map(key =>
      [key, cases.filter(([, , reason]) => reason === key).length])));
    status.usageRejections['invalid-used'] = 99;
    assert.equal(f.handle.status().usageRejections['invalid-used'], 1);
  } finally { f.handle.dispose(); }
});
test('empty context is a compact data grid without diagnostics', () => {
  const details = contextDetails(null);
  assert.equal(details.percent, null);
  assert.ok(details.rows.every(row => row.value === '—'));
  assert.ok(details.request.every(row => row.value === '—'));
  assert.doesNotMatch(details.lines.join('\n'), /连接|更新|不保证|未提供/);
});
test('details use exact session match, distinguish missing from zero, and clamp only the visual ring', () => {
  const session = { sessionId: 'a', lead: { used: 200, size: 100, timestampMs: 100 }, subagents: [] };
  const monitor = { sessions: [{ sessionId: 'b', records: [{ model: 'foreign', startedAt: '2026-01-01', gatewayTps: 999 }] }] };
  let result = contextDetails(session, monitor);
  assert.equal(result.percent, 100); assert.ok(result.lines.join('\n').includes('200%'));
  assert.ok(!result.lines.join('\n').includes('999')); assert.equal(result.request[0].value, '—');
  monitor.sessions[0].sessionId = 'a'; monitor.sessions[0].records[0].gatewayTps = 0;
  result = contextDetails(session, monitor);
  assert.ok(result.lines.includes('首响应后吞吐 TPS：0'));
  assert.ok(result.lines.includes('正文首字：—'));
  assert.equal(result.sessionTitle, null, 'no title on the matched session leaves the fallback to the caller');
  monitor.sessions[0].title = '审查全局规则';
  assert.equal(contextDetails(session, monitor).sessionTitle, '审查全局规则',
    'a matched session exposes its stored title for the selector label');
  const zeroSized = contextDetails({ sessionId: 'a', lead: { used: 5, size: 0, timestampMs: 1 }, subagents: [] });
  assert.equal(zeroSized.percent, null, 'a zero-sized context renders as missing, never NaN%');
});
test('context webview handles hostile strings as text and zero as real usage', () => {
  class Element {
    constructor() { this.children = []; this.value = ''; this.attributes = {}; this.listeners = {}; }
    append(...children) { this.children.push(...children); if (!this.value) this.value = children[0].value; }
    replaceChildren() { this.children = []; this.value = ''; }
    getAttribute(key) { return this.attributes[key]; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(key, fn) { this.listeners[key] = fn; }
  }
  const elements = new Map(); const get = key => { if (!elements.has(key)) elements.set(key, new Element()); return elements.get(key); };
  let receive;
  vm.runInNewContext(contextScript(), { acquireVsCodeApi: () => ({ postMessage() {} }), document: { getElementById: get, createElement: () => new Element() }, window: { addEventListener: (_, fn) => { receive = fn; } } });
  const message = { data: { type: 'context', items: [{ sessionId: 'a', percent: 0, rows: [{ key: 'model', label: '模型', value: '<img onerror=boom>' }], request: [] }] } };
  receive(message);
  assert.equal(get('percent').textContent, '0.0%');
  const cell = get('context').children[0], option = get('sessions').children[0];
  assert.equal(cell.children[1].textContent, '<img onerror=boom>');
  receive(message);
  assert.equal(get('context').children[0], cell); assert.equal(get('sessions').children[0], option);
  message.data.items[0].rows[0].value = 'updated'; receive(message);
  assert.equal(get('context').children[0], cell); assert.equal(cell.children[1].textContent, 'updated');
  assert.match(contextHtml('abc'), /default-src 'none'/);
  new vm.Script(contextHtml('abc').match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]);
});
test('the context webview hides metric sections and explains the empty state', () => {
  class Element {
    constructor() { this.children = []; this.value = ''; this.attributes = {}; this.listeners = {}; }
    append(...children) { this.children.push(...children); if (!this.value) this.value = children[0].value; }
    replaceChildren() { this.children = []; this.value = ''; }
    getAttribute(key) { return this.attributes[key]; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(key, fn) { this.listeners[key] = fn; }
  }
  const elements = new Map(); const get = key => { if (!elements.has(key)) elements.set(key, new Element()); return elements.get(key); };
  let receive;
  vm.runInNewContext(contextScript(), { acquireVsCodeApi: () => ({ postMessage() {} }), document: { getElementById: get, createElement: () => new Element() }, window: { addEventListener: (_, fn) => { receive = fn; } } });
  receive({ data: { type: 'context', items: [{ sessionId: '', rows: [], request: [] }], enabled: true } });
  assert.equal(get('empty').hidden, false);
  assert.equal(get('context').hidden, true);
  assert.equal(get('request').hidden, true);
  assert.equal(get('sessions').hidden, true);
  assert.match(get('empty').textContent, /还没有可观察的会话/);
  receive({ data: { type: 'context', items: [{ sessionId: '', rows: [], request: [] }], enabled: false } });
  assert.match(get('empty').textContent, /插件已停用/);
  const html = contextHtml('n');
  for (const needle of ['id="contextTitle"', 'id="requestTitle"', 'class="tiles"', 'id="empty"']) assert.ok(html.includes(needle), needle);
  for (const gone of ['class="grid"', 'class="metric"']) assert.ok(!html.includes(gone), gone);
});

test('context selection stays stable across updates and drives both panel and statusbar', () => {
  let open, receive, enabled = true, shows = 0, hides = 0;
  let sessions = ['a', 'b'].map((sessionId, index) => ({ sessionId, modelUid: 'm', subagents: [], lead: { used: index * 50, size: 100, timestampMs: 1 } }));
  const messages = [], item = { show() { shows++; }, hide() { hides++; }, dispose() {} };
  const panel = { visible: true, webview: { postMessage(value) { messages.push(value); }, onDidReceiveMessage(fn) { receive = fn; return { dispose() {} }; } }, onDidDispose() { return { dispose() {} }; }, dispose() {} };
  const handle = createContextUi({ vscode: { ViewColumn: { Active: 1 }, window: { createStatusBarItem: () => item, createWebviewPanel: () => panel }, commands: { registerCommand(_, fn) { open = fn; return { dispose() {} }; } } }, context: { subscriptions: [] }, snapshot: () => sessions, catalog: () => ({ models: [{ uid: 'm', label: '<model>' }] }), readMonitor: async () => null, isEnabled: () => enabled });
  try {
    open(); receive({ type: 'ready' });
    assert.equal(messages.at(-1).selectedSessionId, 'a');
    assert.deepEqual(messages.at(-1).items.map(x => x.label), ['会话 1 · <model>', '会话 2 · <model>']);
    const count = messages.length, tooltip = item.tooltip;
    let tooltipWrites = 0;
    Object.defineProperty(item, 'tooltip', { get: () => tooltip, set() { tooltipWrites++; }, configurable: true });
    handle.refresh(); handle.refresh();
    assert.equal(messages.length, count); assert.equal(tooltipWrites, 0); assert.equal(shows, 1);
    sessions[0].turn = { durationMs: 1000 }; handle.refresh();
    sessions[0].turn.durationMs = 2000; handle.refresh();
    assert.equal(tooltipWrites, 0); assert.equal(messages.at(-1).items[0].rows[2].value, '2 s');
    receive({ type: 'ready' }); assert.equal(messages.length, count + 3);
    Object.defineProperty(item, 'tooltip', { value: tooltip, writable: true, configurable: true });
    sessions.reverse(); handle.refresh();
    assert.equal(messages.at(-1).selectedSessionId, 'a');
    assert.match(item.text, /0%/); assert.equal(shows, 1);
    receive({ type: 'selectSession', sessionId: 'b' });
    assert.match(item.text, /50%/);
    for (const sessionId of ['unknown', {}, null]) receive({ type: 'selectSession', sessionId });
    assert.equal(messages.at(-1).selectedSessionId, 'b');
    enabled = false; handle.refresh(); handle.refresh(); assert.equal(hides, 1);
    enabled = true; handle.refresh(); assert.equal(shows, 2);
    sessions = sessions.filter(x => x.sessionId === 'a'); handle.refresh();
    assert.equal(messages.at(-1).selectedSessionId, 'a'); assert.match(item.text, /0%/);
  } finally { handle.dispose(); }
});
test('durations use seconds while tokens and TPS retain their units', () => {
  const session = { sessionId: 's', turn: { durationMs: 1234 } };
  const record = { startedAt: '2026-09-24', durationMs: 1234, firstResponseMs: 0, firstTextMs: null, firstOutputMs: 25, gatewayTps: 1234, inputTokens: 1234 };
  const monitor = { sessions: [{ sessionId: 's', records: [record] }] };
  const result = contextDetails(session, monitor);
  const values = Object.fromEntries(result.request.map(row => [row.key, row.value]));
  const labels = Object.fromEntries(result.request.map(row => [row.key, row.label]));
  assert.equal(labels.firstResponseMs, '首响应数据');
  assert.equal(labels.gatewayTps, '首响应后吞吐 TPS');
  assert.equal(labels.tps, '正文 TPS（不含工具）');
  assert.equal(result.rows[2].value, '1.234 s');
  assert.equal(values.durationMs, '1.234 s'); assert.equal(values.firstResponseMs, '0 s');
  assert.equal(values.firstTextMs, '—'); assert.equal(values.firstOutputMs, '0.025 s');
  assert.equal(values.gatewayTps, '1,234'); assert.equal(values.inputTokens, '1,234');
  assert.equal(contextDetails({ ...session, turn: { durationMs: 9999 } }, monitor).tooltip, result.tooltip);
  monitor.sessions.push(monitor.sessions[0]);
  assert.equal(contextDetails(session, monitor).request[0].value, '—');
});
test('statusbar uses untrusted plain text, coalesces metrics reads and disposes timer', async () => {
  let reads = 0, resolve;
  const item = { show() {}, hide() {}, dispose() {} };
  const context = { subscriptions: [] };
  const handle = createContextUi({ vscode: { window: { createStatusBarItem: () => item }, commands: { registerCommand: () => ({ dispose() {} }) } }, context,
    snapshot: () => [{ sessionId: '[evil](command:evil)', subagents: [], lead: null }], catalog: () => ({}), readMonitor: () => { reads++; return new Promise(done => { resolve = done; }); } });
  handle.refresh(); await tick(); assert.equal(reads, 1);
  assert.equal(typeof item.tooltip, 'string'); assert.doesNotMatch(item.tooltip, /不保证是当前聊天|本轮耗时/);
  handle.dispose(); resolve({ snapshot: null }); await tick();
});

test('observer exposes the focused session from intent methods, not passive updates', async () => {
  const f = fixture();
  assert.equal(f.handle.focused(), null, 'nothing focused until an intent method fires');
  f.connector.sendRequest({ method: 'session/prompt', params: { sessionId: 'a' } });
  assert.equal(f.handle.focused().sessionId, 'a');
  f.connector.sendRequest({ method: 'session/load', params: { sessionId: 'b' } });
  assert.equal(f.handle.focused().sessionId, 'b');
  f.connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 'c', update: update() } });
  assert.equal(f.handle.focused().sessionId, 'b', 'background session updates never steal focus');
  f.setResponse(Promise.resolve({ sessionId: 'fresh' }));
  f.connector.sendRequest({ method: 'session/new', params: {} });
  await tick();
  assert.equal(f.handle.focused().sessionId, 'fresh', 'session/new takes the response-assigned id');
  f.handle.dispose();
});

test('the panel follows new focus events once, then manual picks hold', () => {
  let focus = { sessionId: 'b', at: 100 };
  const sessions = ['a', 'b'].map((sessionId, index) => ({ sessionId, modelUid: 'm', subagents: [], lead: { used: index * 50, size: 100, timestampMs: 1 } }));
  const messages = [], item = { show() {}, hide() {}, dispose() {} };
  const panel = { visible: true, webview: { postMessage(value) { messages.push(value); }, onDidReceiveMessage(fn) { receive = fn; return { dispose() {} }; } }, onDidDispose() { return { dispose() {} }; }, dispose() {} };
  let receive, open;
  const handle = createContextUi({ vscode: { ViewColumn: { Active: 1 }, window: { createStatusBarItem: () => item, createWebviewPanel: () => panel }, commands: { registerCommand(_, fn) { open = fn; return { dispose() {} }; } } }, context: { subscriptions: [] },
    snapshot: () => sessions, catalog: () => ({ models: [{ uid: 'm', label: 'M' }] }), readMonitor: async () => null, focused: () => focus });
  try {
    open(); receive({ type: 'ready' });
    assert.equal(messages.at(-1).selectedSessionId, 'b', 'a pending focus event selects the focused session');
    handle.refresh(); handle.refresh();
    assert.equal(messages.at(-1).selectedSessionId, 'b');
    receive?.({ type: 'selectSession', sessionId: 'a' });
    handle.refresh();
    assert.equal(messages.at(-1).selectedSessionId, 'a', 'a manual pick is not reverted by the consumed focus event');
    focus = { sessionId: 'b', at: 200 };
    handle.refresh();
    assert.equal(messages.at(-1).selectedSessionId, 'b', 'the next Devin focus event wins again');
    focus = { sessionId: 'missing', at: 300 };
    handle.refresh();
    assert.equal(messages.at(-1).selectedSessionId, 'b', 'an unobservable session cannot steal the selection');
  } finally { handle.dispose(); }
});

test('subagent rows name the owning agent and append the run id when present', () => {
  const session = { sessionId: 's', lead: { used: 10, size: 100 }, subagents: [
    { parentAgentId: 'sidekick', runId: 'abcdef1234567890', used: 20, size: 200 },
    { parentAgentId: 'helper', runId: null, used: 30, size: 300 },
  ] };
  const subs = contextDetails(session).rows.filter(row => row.key.startsWith('subagent:'));
  assert.equal(subs.length, 2);
  assert.equal(subs[0].label, '子代理 · sidekick · abcdef12');
  assert.equal(subs[1].label, '子代理 · helper');
  assert.notEqual(subs[0].key, subs[1].key);
  assert.equal(subs[0].value, '20 / 200 token · 10%');
  assert.equal(subs[1].value, '30 / 300 token · 10%');
});

test('the reserved parent id root is the session context itself, not a subagent', () => {
  const state = createContextState();
  state.observe('s', update(100, 1000, { parentAgentId: 'root' }));
  let session = state.snapshot()[0];
  assert.equal(session.subagents.length, 0, 'a root-scoped update never produces a subagent row');
  assert.equal(session.lead.used, 100);
  assert.equal(session.lead.size, 1000);
  state.observe('s', update(80, 262, { parentAgentId: 'sidekick' }));
  state.observe('s', update(200, 1000, { parentAgentId: 'root' }));
  session = state.snapshot()[0];
  assert.equal(session.subagents.length, 1, 'only the sidekick-scoped update counts as a subagent');
  assert.equal(session.lead.used, 200, 'root-scoped updates keep writing the lead usage');
  assert.equal(session.lead.size, 1000);
  assert.equal(session.subagents[0].parentAgentId, 'sidekick');
  assert.equal(session.subagents[0].used, 80);
  assert.equal(session.subagents[0].size, 262);
});

test('a root-scoped state_update never settles the turn; only unscoped ones do', () => {
  const state = createContextState();
  state.start('s');
  state.observe('s', { sessionUpdate: 'state_update', state: 'idle', _meta: { 'cognition.ai/subagent_context': { parentAgentId: 'root' } } });
  assert.equal(state.snapshot()[0].turn.status, 'running', 'root ownership is a usage-scoping signal, not the session lifecycle channel');
  state.observe('s', { sessionUpdate: 'state_update', state: 'idle' });
  assert.equal(state.snapshot()[0].turn.status, 'idle');
});

test('sessions without observable data are hidden, cannot steal focus, and resolve native labels', () => {
  let open, receive, focus = null, catalog = { models: [{ uid: 'm', label: 'M' }] };
  let sessions = [
    { sessionId: 'empty', modelUid: 'swe-2-high', subagents: [], lead: null, turn: null },
    { sessionId: 'live', modelUid: 'm', subagents: [], lead: { used: 10, size: 100, timestampMs: 1 }, turn: null },
  ];
  const messages = [], item = { show() {}, hide() {}, dispose() {} };
  const panel = { visible: true, webview: { postMessage(value) { messages.push(value); }, onDidReceiveMessage(fn) { receive = fn; return { dispose() {} }; } }, onDidDispose() { return { dispose() {} }; }, dispose() {} };
  const handle = createContextUi({ vscode: { ViewColumn: { Active: 1 }, window: { createStatusBarItem: () => item, createWebviewPanel: () => panel }, commands: { registerCommand(_, fn) { open = fn; return { dispose() {} }; } } }, context: { subscriptions: [] },
    snapshot: () => sessions, catalog: () => catalog, nativeLabels: () => new Map([['swe-2-high', 'SWE-2 High'], ['m', 'Native M']]),
    readMonitor: async () => null, focused: () => focus });
  try {
    open(); receive({ type: 'ready' });
    let items = messages.at(-1).items;
    assert.equal(items.length, 1);
    assert.equal(items[0].sessionId, 'live');
    assert.ok(!items.some(entry => entry.sessionId === 'empty'), 'a prepared-but-unused session with no observable data never reaches the panel');
    focus = { sessionId: 'empty', at: 100 }; handle.refresh();
    assert.equal(messages.at(-1).selectedSessionId, 'live', 'an empty session must not steal the selection even though session/load counts as focus');
    sessions = [{ sessionId: 'native', modelUid: 'swe-2-high', subagents: [], lead: { used: 1, size: 2, timestampMs: 1 } }];
    handle.refresh();
    assert.match(messages.at(-1).items[0].label, /SWE-2 High$/, 'a native uid resolves to its observed label');
    sessions = [{ sessionId: 'own', modelUid: 'm', subagents: [], lead: { used: 1, size: 2, timestampMs: 1 } }];
    handle.refresh();
    assert.match(messages.at(-1).items[0].label, /· M$/, 'own catalog entries win over native labels for the same uid');
    sessions = [{ sessionId: 'empty', modelUid: 'swe-2-high', subagents: [], lead: null, turn: null }];
    handle.refresh();
    items = messages.at(-1).items;
    assert.equal(items.length, 1);
    assert.equal(items[0].sessionId, '', 'with nothing observable the panel falls back to the empty hint entry');
  } finally { handle.dispose(); }
});

test('tps falls back to the latest eligible sample with a visible timestamp note', () => {
  const localClock = value => { const d = new Date(Date.parse(value)); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const session = { sessionId: 's', lead: { used: 5, size: 100, timestampMs: 1 } };
  const rec = over => ({ schemaVersion: 2, status: 'success', model: 'm', startedAt: '2026-10-16T10:00:00', durationMs: 1000, ...over });
  const details = records => contextDetails(session, { sessions: [{ sessionId: 's', records }] });
  const pick = records => { const rows = details(records).request; const row = rows.find(r => r.key === 'tps'); return { row, values: Object.fromEntries(rows.map(r => [r.key, r.value])), labels: Object.fromEntries(rows.map(r => [r.key, r.label])) }; };

  // The newest request used tools (tps null); an older valid sample wins and is marked.
  const older = rec({ startedAt: '2026-10-16T10:00:00', tps: 88, hasTools: false });
  const toolCall = rec({ startedAt: '2026-10-16T10:05:00', tps: null, hasTools: true });
  let out = pick([older, toolCall]);
  assert.equal(out.values.tps, '88');
  assert.equal(out.labels.tps, '正文 TPS（不含工具） · 最近有效 ' + localClock(older.startedAt));
  assert.match(out.row.title, /早于最近一次请求/);

  // The newest request is itself eligible: no annotation.
  out = pick([rec({ startedAt: '2026-10-16T10:05:00', tps: 200, hasTools: false })]);
  assert.equal(out.values.tps, '200');
  assert.equal(out.labels.tps, '正文 TPS（不含工具）');

  // Ineligible-looking records are skipped: old schema, error status, inconsistent
  // usage (cachedTokens > inputTokens) and a null tps all lose to the one valid sample.
  out = pick([older,
    rec({ startedAt: '2026-10-16T10:06:00', schemaVersion: 1, tps: 999 }),
    rec({ startedAt: '2026-10-16T10:07:00', status: 'error', tps: 999 }),
    rec({ startedAt: '2026-10-16T10:08:00', tps: 999, cachedTokens: 50, inputTokens: 10 }),
    rec({ startedAt: '2026-10-16T10:09:00', tps: null }),
    rec({ startedAt: '2026-10-16T10:10:00', tps: -1 })]);
  assert.equal(out.values.tps, '88');
  assert.equal(out.labels.tps, '正文 TPS（不含工具） · 最近有效 ' + localClock(older.startedAt));

  // No eligible sample at all: dash value, bare label.
  out = pick([toolCall]);
  assert.equal(out.values.tps, '—');
  assert.equal(out.labels.tps, '正文 TPS（不含工具）');

  // An eligible sample whose timestamp cannot be parsed: keep the bare label, and
  // do not claim it is older than the newest request.
  out = pick([rec({ startedAt: 'not-a-timestamp', tps: 42 })]);
  assert.equal(out.values.tps, '42');
  assert.equal(out.labels.tps, '正文 TPS（不含工具）');
  assert.match(out.row.title, /时间无法解析/);
  assert.doesNotMatch(out.row.title, /早于最近一次请求/);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { renderPanel } = require('../src/panel/view.cjs');
const { monitorScript } = require('../src/panel/monitor-view.cjs');
const { createPanelController } = require('../src/panel/controller.cjs');
test('monitor browser script compiles, uses text nodes, and preserves zero versus missing', () => {
  class Element {
    constructor() { this.children = []; this.value = ''; this.textContent = ''; this.listeners = {}; this.style = {}; }
    append(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    get options() { return this.children; }
  }
  const elements = new Map();
  const byId = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  byId('monitor-session').value = 'all';
  let receive;
  vm.runInNewContext(monitorScript(), { document: { getElementById: byId, createElement: () => new Element() }, window: { addEventListener: (_, fn) => { receive = fn; } }, vscode: { postMessage() {} } });
  byId('monitor-time-range').value = 'all';
  const record = { id: 'id', startedAt: 'now', model: '<img onerror=alert(1)>', status: 'success', schemaVersion: 3, inputTokens: 0, outputTokens: null, usageComplete: false, attribution: 'unassigned' };
  receive({ data: { type: 'monitor-state', result: { snapshot: { summary: { requests: 1, success: 1, error: 0, cancelled: 0 }, records: [record], sessions: [], sessionStatus: 'ready' } } } });
  const cells = byId('monitor-requests').children[0].children;
  assert.equal(cells[1].textContent, '<img onerror=alert(1)>');
  assert.equal(cells[6].textContent, '0'); assert.equal(cells[7].textContent, '—');
  assert.equal(cells[4].textContent, '—'); assert.equal(cells[5].textContent, '—');
  Object.assign(record, { firstResponseMs: 1234, firstOutputMs: 0, firstTextMs: 25, durationMs: 4567, gatewayTps: 1234 });
  receive({ data: { type: 'monitor-state', result: { snapshot: { summary: { requests: 1, firstResponseMs: { value: 1234 }, ttftMs: { value: 0 }, textTtftMs: { value: 25 } }, records: [record], sessions: [], sessionStatus: 'ready' } } } });
  const secondsCells = byId('monitor-requests').children[0].children;
  assert.equal(secondsCells[4].textContent, '1.234'); assert.equal(secondsCells[10].textContent, '0');
  assert.equal(secondsCells[11].textContent, '0.025'); assert.equal(secondsCells[14].textContent, '4.567');
  assert.equal(secondsCells[5].textContent, '1,234');
  const tiles = new Map(byId('monitor-summary').children.map(tile => [tile.children[1].textContent, tile.children[0].textContent]));
  assert.equal(tiles.get('平均首数据事件 s'), '1.234');
  assert.equal(tiles.has('平均首输出 s'), false, 'secondary metrics stay hidden until the detail toggle is on');
  byId('monitor-detail').checked = true; byId('usage-monitor').classList = { toggle() {} };
  byId('monitor-detail').listeners.change();
  const detailed = new Map(byId('monitor-summary').children.map(tile => [tile.children[1].textContent, tile.children[0].textContent]));
  assert.equal(detailed.get('平均首输出 s'), '0'); assert.equal(detailed.get('平均正文首字 s'), '0.025');
  assert.equal(byId('monitor-status').hidden, true);
  const html = renderPanel({ nonce: 'safe', cspSource: 'test:' });
  assert.match(html, /id="usage-monitor"/); assert.match(html, /connect-src 'none'/);
  new vm.Script(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]);
});
test('session options show titles and relative times instead of internal slugs', () => {
  class Element {
    constructor() { this.children = []; this.value = ''; this.textContent = ''; this.listeners = {}; this.style = {}; }
    append(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    get options() { return this.children; }
  }
  const elements = new Map();
  const byId = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  byId('monitor-session').value = 'all';
  let receive;
  vm.runInNewContext(monitorScript(), { document: { getElementById: byId, createElement: () => new Element() }, window: { addEventListener: (_, fn) => { receive = fn; } }, vscode: { postMessage() {} } });
  byId('monitor-time-range').value = 'all';
  const now = Math.floor(Date.now() / 1000);
  const summary = { requests: 1, success: 1, error: 0, cancelled: 0 };
  const record = { id: 'r1', startedAt: 't', model: 'm', effort: null, status: 'success', usageState: 'missing', attribution: 'ambiguous' };
  receive({ data: { type: 'monitor-state', result: { snapshot: { summary, records: [record], sessionStatus: 'ready', sessions: [
    { sessionId: 'sprout-skull', title: '查看并讨论 VS Code 插件项目', lastActivityAt: now - 7200, attribution: 'response-id', summary, records: [] },
    { sessionId: 'puddle-airmail', title: '审查全局规则', lastActivityAt: now - 1800, attribution: 'tool-id', summary, records: [] },
    { sessionId: 'ghost-slug', title: null, lastActivityAt: null, attribution: 'tool-id', summary, records: [] },
    { sessionId: null, title: null, lastActivityAt: null, attribution: 'unassigned', summary, records: [] },
  ] } } } });
  const options = byId('monitor-session').children.map(o => [o.value, o.textContent]);
  assert.deepEqual(options[0], ['all', '全部会话']);
  assert.deepEqual(options[1], ['sprout-skull', '查看并讨论 VS Code 插件项目 · 2 小时前']);
  assert.deepEqual(options[2], ['puddle-airmail', '审查全局规则 · 30 分钟前']);
  assert.deepEqual(options[3], ['ghost-slug', 'ghost-slug'], 'session-level ambiguity cannot occur, so no 存在歧义 suffix here');
  assert.deepEqual(options[4], ['__unassigned__', '未归属／有歧义']);
  for (const [, text] of options) assert.ok(!text.includes('ID 确认'), 'noise suffix removed: ' + text);
  const ambiguousCell = byId('monitor-requests').children[0].children.at(-1);
  assert.equal(ambiguousCell.textContent, '存在歧义', 'record-level ambiguity still renders in the 会话关联 column');
  for (const option of byId('monitor-session').children) assert.equal(option.title, option.textContent, 'every option carries its full text as tooltip');
  byId('monitor-session').value = 'puddle-airmail';
  byId('monitor-session').listeners.change();
  assert.equal(byId('monitor-session').title, '审查全局规则 · 30 分钟前', 'select tooltip follows the chosen option');
  const html = renderPanel({ nonce: 'safe', cspSource: 'test:' });
  assert.match(html, /\.monitor-controls select \{[^}]*text-overflow: ellipsis/, 'the session selector truncates with an ellipsis');
});
test('long titles reach the option and select tooltips intact, empty titles still fall back', () => {
  class Element {
    constructor() { this.children = []; this.value = ''; this.textContent = ''; this.listeners = {}; this.style = {}; }
    append(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    get options() { return this.children; }
  }
  const elements = new Map();
  const byId = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  byId('monitor-session').value = 'all';
  let receive;
  vm.runInNewContext(monitorScript(), { document: { getElementById: byId, createElement: () => new Element() }, window: { addEventListener: (_, fn) => { receive = fn; } }, vscode: { postMessage() {} } });
  byId('monitor-time-range').value = 'all';
  const longTitle = '标'.repeat(150) + '末尾标记';
  const summary = { requests: 1, success: 1, error: 0, cancelled: 0 };
  receive({ data: { type: 'monitor-state', result: { snapshot: { summary, records: [], sessionStatus: 'ready', sessions: [
    { sessionId: 's-long', title: longTitle, lastActivityAt: null, attribution: 'tool-id', summary, records: [] },
    { sessionId: 'bare-slug', title: null, lastActivityAt: null, attribution: 'tool-id', summary, records: [] },
  ] } } } });
  const options = byId('monitor-session').children;
  assert.equal(options[1].textContent, longTitle);
  assert.equal(options[1].title, longTitle);
  assert.equal(options[2].textContent, 'bare-slug', 'missing titles still fall back to the session id');
  byId('monitor-session').value = 's-long';
  byId('monitor-session').listeners.change();
  assert.equal(byId('monitor-session').title, longTitle, 'select tooltip keeps the full tail');
});

test('usage monitor renders once inside the usage tab', () => {
  const html = renderPanel({ nonce: 'safe', cspSource: 'test:' });
  const monitor = html.indexOf('id="usage-monitor"');
  assert.equal(html.indexOf('id="usage-monitor"', monitor + 1), -1, 'usage monitor markup appears once');
  assert.ok(monitor > html.indexOf('id="view-usage"'), 'usage monitor sits in the usage tab');
  assert.ok(monitor < html.indexOf('id="view-settings"'), 'usage monitor stays out of the settings tab');
});
test('panel refresh is isolated, concurrent reads are coalesced and disposal suppresses posts', async () => {
  const posts = []; let onMessage, onClose, finish, reads = 0;
  const disposable = { dispose() {} };
  const panel = { visible: true, webview: { cspSource: 'test:', postMessage: async data => { posts.push(data); }, onDidReceiveMessage(fn) { onMessage = fn; return disposable; } }, onDidDispose(fn) { onClose = fn; return disposable; }, reveal() {}, dispose() { onClose(); } };
  const controller = createPanelController({ vscode: { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel } }, context: { subscriptions: [] }, manager: { state: () => ({}), dispatch() { throw new Error('must not dispatch monitor'); } }, safeError: () => ({ message: 'error' }), readMonitor: () => { reads++; return new Promise(resolve => { finish = resolve; }); } });
  controller.open();
  await onMessage({ id: 'refresh', type: 'monitor.refresh' });
  assert.equal(reads, 1);
  onClose(); finish({ status: 'ready', snapshot: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posts.length, 0);
});

function fakePanel(posts, postImpl) {
  const panel = { visible: true, reveal() {}, onClose: null,
    dispose() { this.onClose?.(); },
    onDidDispose(fn) { this.onClose = fn; return { dispose() {} }; },
    webview: { cspSource: 'test:', postMessage: postImpl, onDidReceiveMessage: () => ({ dispose() {} }) } };
  return panel;
}

test('failed state posts are retried and a ready message forces a resend', async () => {
  const posts = [];
  const outcomes = ['false', 'throw'];
  const panel = fakePanel(posts, async message => {
    posts.push(message);
    if (message.type === 'state' && outcomes.length) {
      const outcome = outcomes.shift();
      if (outcome === 'false') return false;
      throw new Error('post lost');
    }
    return true;
  });
  const state = { enabled: true, providers: [] };
  let handler;
  panel.webview.onDidReceiveMessage = fn => { handler = fn; return { dispose() {} }; };
  const controller = createPanelController({
    vscode: { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel } },
    context: { subscriptions: [] },
    manager: { state: () => state, dispatch: async () => state },
    safeError: () => ({ message: 'x' }),
  });
  controller.open();
  await controller.publish();
  await assert.rejects(controller.publish(), /post lost/);
  await controller.publish();
  const statePosts = () => posts.filter(m => m.type === 'state');
  assert.equal(statePosts().length, 3, 'both the false and the thrown send are retried until one lands');
  await handler({ id: 'r1', type: 'ready' });
  assert.equal(statePosts().length, 4, 'ready forces a resend even when the state has not changed');
  assert.deepEqual(posts.at(-1), { type: 'result', id: 'r1', ok: true });
});

test('identical panel state is posted once, so unchanged data cannot re-render the panel', async () => {
  const posts = [];
  const panel = fakePanel(posts, async data => { posts.push(data); return true; });
  const report = { at: '2026-10-15T00:00:00.000Z', checked: 4, refreshed: [], skipped: [], errors: [] };
  const state = () => ({ enabled: true, providers: [], cliCache: report });
  const controller = createPanelController({ vscode: { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel } },
    context: { subscriptions: [] }, manager: { state, dispatch: async () => state() },
    safeError: () => ({ message: 'e' }), readMonitor: async () => ({ status: 'ready', snapshot: null }) });
  controller.open();
  await controller.publish(); await controller.publish();
  assert.equal(posts.filter(message => message.type === 'state').length, 1, 'the second publish must be suppressed by the state comparison');
});

test('concurrent publishes are serialized and the later state wins', async () => {
  const posts = [], pending = [];
  const panel = fakePanel(posts, message => {
    posts.push(message);
    if (message.type === 'state') return new Promise(resolve => pending.push(() => resolve(true)));
    return Promise.resolve(true);
  });
  let state = { v: 'A' };
  const controller = createPanelController({
    vscode: { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel } },
    context: { subscriptions: [] },
    manager: { state: () => state, dispatch: async () => state },
    safeError: () => ({ message: 'x' }),
  });
  controller.open();
  const first = controller.publish();
  state = { v: 'B' };
  const second = controller.publish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posts.filter(m => m.type === 'state').length, 1, 'the second publish waits for the first send');
  pending.shift()();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posts.filter(m => m.type === 'state').length, 2);
  assert.equal(posts.filter(m => m.type === 'state').at(-1).state.v, 'B');
  pending.shift()();
  await second;
  await controller.publish();
  assert.equal(posts.filter(m => m.type === 'state').length, 2, 'the cached newer state is not reposted');
});

test('a stale send cannot pollute the state cache after the panel is replaced', async () => {
  const bags = [{ posts: [], pending: [] }, { posts: [], pending: [] }];
  const makePanel = bag => fakePanel(bag.posts, message => {
    bag.posts.push(message);
    if (message.type === 'state') return new Promise(resolve => bag.pending.push(() => resolve(true)));
    return Promise.resolve(true);
  });
  const panels = [makePanel(bags[0]), makePanel(bags[1])];
  let created = 0;
  const controller = createPanelController({
    vscode: { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panels[created++] } },
    context: { subscriptions: [] },
    manager: { state: () => ({ v: 1 }), dispatch: async () => ({ v: 1 }) },
    safeError: () => ({ message: 'x' }),
  });
  controller.open();
  const staleSend = controller.publish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bags[0].pending.length, 1);
  panels[0].dispose();
  controller.open();
  const freshSend = controller.publish();
  bags[0].pending.shift()();
  await staleSend;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bags[1].pending.length, 1, 'the fresh panel send runs after the stale one settles');
  bags[1].pending.shift()();
  await freshSend;
  await controller.publish();
  assert.equal(bags[1].posts.filter(m => m.type === 'state').length, 1, 'only the fresh send reaches the new panel');
});

function panelDom() {
  class Element {
    constructor() { this.children = []; this.value = ''; this.textContent = ''; this.listeners = {}; this.style = {}; }
    append(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    get options() { return this.children; }
  }
  const elements = new Map();
  const byId = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  byId('monitor-session').value = 'all';
  let receive;
  vm.runInNewContext(monitorScript(), { document: { getElementById: byId, createElement: () => new Element() }, window: { addEventListener: (_, fn) => { receive = fn; } }, vscode: { postMessage() {} } });
  byId('monitor-time-range').value = 'all';
  byId('usage-monitor').classList = { toggle() {} };
  return { byId, receive };
}

const snapshotOf = (count, extra = {}) => ({
  summary: { requests: count, success: count, error: 0, cancelled: 0 },
  sessionStatus: 'ready',
  records: Array.from({ length: count }, (_, i) => ({ id: 'r' + (count - 1 - i), startedAt: 't' + i, model: 'm', effort: null, status: 'success', usageState: 'missing', attribution: 'unassigned' })),
  sessions: [], ...extra
});
const send = (receive, snapshot) => receive({ data: { type: 'monitor-state', result: { status: 'ready', snapshot } } });

test('request table paginates 100 per page with working boundaries and full summary', () => {
  const { byId, receive } = panelDom();
  send(receive, snapshotOf(250));
  const rows = byId('monitor-requests');
  assert.equal(rows.children.length, 100, 'first page shows the newest 100');
  assert.equal(rows.children[0].title, '请求 ID：r249', 'newest first');
  assert.equal(rows.children.at(-1).title, '请求 ID：r150');
  assert.equal(byId('monitor-prev').disabled, true);
  assert.equal(byId('monitor-next').disabled, false);
  assert.match(byId('monitor-page').textContent, /1.*\/.*3/);
  assert.equal(byId('monitor-summary').children[0].children[0].textContent, '250', 'summary covers every record');
  byId('monitor-next').listeners.click();
  assert.equal(rows.children.length, 100);
  assert.equal(rows.children[0].title, '请求 ID：r149');
  assert.equal(byId('monitor-prev').disabled, false);
  byId('monitor-next').listeners.click();
  assert.equal(rows.children.length, 50);
  assert.equal(rows.children.at(-1).title, '请求 ID：r0');
  assert.equal(byId('monitor-next').disabled, true);
  byId('monitor-prev').listeners.click();
  assert.equal(rows.children.length, 100);
  assert.equal(byId('monitor-summary').children[0].children[0].textContent, '250');
});

test('session switch resets the page, snapshots clamp an out-of-range page, detail keeps it', () => {
  const { byId, receive } = panelDom();
  send(receive, snapshotOf(250));
  byId('monitor-next').listeners.click();
  byId('monitor-next').listeners.click();
  assert.equal(byId('monitor-requests').children.length, 50);

  send(receive, snapshotOf(200));
  assert.equal(byId('monitor-requests').children.length, 100, 'a smaller result clamps the page to its last valid page');
  assert.equal(byId('monitor-requests').children[0].title, '请求 ID：r99');
  assert.match(byId('monitor-page').textContent, /2.*\/.*2/);

  byId('monitor-detail').checked = true;
  byId('monitor-detail').listeners.change();
  assert.equal(byId('monitor-requests').children[0].title, '请求 ID：r99', 'the detail toggle keeps the page');

  send(receive, snapshotOf(250));
  assert.equal(byId('monitor-requests').children[0].title, '请求 ID：r149', 'a still-valid page survives a new snapshot');

  send(receive, snapshotOf(250, { sessions: [
    { sessionId: 's-a', title: 'A', lastActivityAt: null, attribution: 'tool-id',
      summary: { requests: 1, success: 1, error: 0, cancelled: 0 },
      records: [{ id: 'ra', startedAt: 't', model: 'm', effort: null, status: 'success', usageState: 'missing', attribution: 'unassigned' }] },
  ] }));
  byId('monitor-session').value = 's-a';
  byId('monitor-session').listeners.change();
  assert.equal(byId('monitor-requests').children.length, 1, 'switching sessions resets to page 0');
  assert.equal(byId('monitor-requests').children[0].title, '请求 ID：ra');

  send(receive, snapshotOf(0, { sessions: [
    { sessionId: 's-a', title: 'A', lastActivityAt: null, attribution: 'tool-id',
      summary: { requests: 0, success: 0, error: 0, cancelled: 0 }, records: [] },
  ] }));
  assert.equal(byId('monitor-requests').children[0].children[0].textContent, '还没有请求记录。', 'empty selection shows the hint row');
});

test('identical snapshots keep table and summary node identities, changes replace them', () => {
  const { byId, receive } = panelDom();
  send(receive, snapshotOf(250));
  const firstRow = byId('monitor-requests').children[0];
  const firstTile = byId('monitor-summary').children[0];
  send(receive, snapshotOf(250));
  assert.equal(byId('monitor-requests').children[0], firstRow, 'identical snapshot keeps row nodes');
  assert.equal(byId('monitor-summary').children[0], firstTile, 'identical snapshot keeps tile nodes');
  byId('monitor-next').listeners.click();
  assert.notEqual(byId('monitor-requests').children[0], firstRow, 'paging replaces rows');
  const secondRow = byId('monitor-requests').children[0];
  const updated = snapshotOf(250);
  updated.records[100] = { ...updated.records[100], status: 'error' };
  updated.summary = { requests: 250, success: 249, error: 1, cancelled: 0 };
  send(receive, updated);
  assert.notEqual(byId('monitor-requests').children[0], secondRow, 'a changed snapshot replaces rows');
  assert.notEqual(byId('monitor-summary').children[0], firstTile, 'a changed summary replaces tiles');
  const thirdRow = byId('monitor-requests').children[0];
  send(receive, updated);
  assert.equal(byId('monitor-requests').children[0], thirdRow, 'a repeated changed snapshot is deduplicated again');
});

function monitorFixture({ now } = {}) {
  let fakeNow = now ?? Date.now();
  class FakeDate extends Date { static now() { return fakeNow; } }
  class Element {
    constructor() { this.children = []; this.value = ''; this.textContent = ''; this.listeners = {}; this.style = {}; this.disabled = false; this.hidden = false; }
    append(...children) { this.children.push(...children); }
    replaceChildren() { this.children = []; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    get options() { return this.children; }
  }
  const elements = new Map();
  const byId = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  byId('monitor-session').value = 'all';
  let receive;
  vm.runInNewContext(monitorScript(), { document: { getElementById: byId, createElement: () => new Element() }, window: { addEventListener: (_, fn) => { receive = fn; } }, vscode: { postMessage() {} }, Date: FakeDate, Intl });
  return { byId, receive, setNow: value => { fakeNow = value; },
    selectTime: value => { byId('monitor-time-range').value = value; byId('monitor-time-range').listeners.change(); },
    setDates: (start, end) => { byId('monitor-date-start').value = start; byId('monitor-date-start').listeners.change(); if (end !== undefined) { byId('monitor-date-end').value = end; byId('monitor-date-end').listeners.change(); } },
    selectSession: value => { byId('monitor-session').value = value; byId('monitor-session').listeners.change(); } };
}
const dayMs = 24 * 3600 * 1000;
const isoLocal = ms => new Date(ms).toISOString();
const validRecord = (id, extra = {}) => ({ schemaVersion: 3, id, startedAt: new Date(Date.now()).toISOString(), model: 'm', status: 'success', attribution: 'unassigned', attributionReason: 'no-tool-ids', ...extra });

test('rows show attribution reasons in Chinese and keep the legacy fallback', () => {
  const f = monitorFixture();
  f.selectTime('all');
  const base = { startedAt: 't', model: 'm', status: 'success' };
  const records = [
    { ...base, id: 'a', attribution: 'unassigned', attributionReason: 'ambiguous-match' },
    { ...base, id: 'b', attribution: 'unassigned', attributionReason: 'no-tool-ids' },
    { ...base, id: 'c', attribution: 'unassigned', attributionReason: 'lookup-unavailable' },
    { ...base, id: 'd', attribution: 'unassigned', attributionReason: 'tool-id-unmatched' },
    { ...base, id: 'e', attribution: 'tool-id' },
    { ...base, id: 'f', attribution: 'ambiguous' },
  ];
  f.receive({ data: { type: 'monitor-state', result: { snapshot: { summary: { requests: 6, success: 6, error: 0, cancelled: 0 }, records, sessions: [], sessionStatus: 'ready' } } } });
  const cell = index => f.byId('monitor-requests').children[index].children.at(-1).textContent;
  assert.equal(cell(0), '存在歧义');
  assert.equal(cell(1), '无可用工具 ID');
  assert.equal(cell(2), '归属查询不可用');
  assert.equal(cell(3), '工具状态未匹配');
  assert.equal(cell(4), '本次工具 ID 确认');
  assert.equal(cell(5), '存在歧义');
});

test('the diagnostics line summarizes the window, attribution, exclusions and the message branch', () => {
  const f = monitorFixture();
  f.selectTime('all');
  const record = (id, extra = {}) => ({ id, startedAt: 't', model: 'm', status: 'success', attribution: 'unassigned', ...extra });
  f.receive({ data: { type: 'monitor-state', result: { snapshot: {
    summary: { requests: 3, success: 3, error: 0, cancelled: 0 }, retentionLimit: 5000,
    lookupStatus: { tools: 'ready', messages: 'disabled', labels: 'ready' },
    records: [record('a', { sessionId: 's-1' }), record('b', { attributionReason: 'no-tool-ids', usageState: 'inconsistent' }), record('c', { attributionReason: 'tool-id-unmatched' })], sessions: [], sessionStatus: 'ready' } } } });
  const diag = f.byId('monitor-diagnostics').textContent;
  assert.match(diag, /统计窗口：最近 5000 条（当前 3 条）/);
  assert.match(diag, /已确认 1 · 无可用工具 ID 1 · 工具状态未匹配 1 · 歧义 0 · 查询不可用 0/);
  assert.match(diag, /已从用量与吞吐汇总排除 1 条异常记录（仍计入请求数和时间指标）/);
  assert.match(diag, /消息 UUID 补查默认关闭/);

  f.receive({ data: { type: 'monitor-state', result: { snapshot: {
    summary: { requests: 1, success: 1, error: 0, cancelled: 0 }, records: [record('x')], sessions: [], sessionStatus: 'ready' } } } });
  const legacy = f.byId('monitor-diagnostics').textContent;
  assert.match(legacy, /当前保留 1 条/, 'an old backend without retentionLimit still gets the window line');
  assert.doesNotMatch(legacy, /归属：已确认/, 'missing attributionSummary never fabricates zeros');
  assert.doesNotMatch(legacy, /消息 UUID 补查|诊断消息补查/, 'missing lookupStatus never fabricates a branch state');

  f.receive({ data: { type: 'monitor-state', result: { snapshot: {
    summary: { requests: 1, success: 1, error: 0, cancelled: 0 }, retentionLimit: 5000,
    lookupStatus: { tools: 'ready', messages: 'unavailable', labels: 'ready' },
    records: [record('x')], sessions: [], sessionStatus: 'ready' } } } });
  assert.match(f.byId('monitor-diagnostics').textContent, /诊断消息补查失败（未影响工具归属）/);
});

test('status combines storage tool and label warnings without leaking internals', () => {
  const f = monitorFixture();
  f.selectTime('all');
  f.receive({ data: { type: 'monitor-state', result: { snapshot: {
    summary: { requests: 1, success: 0, error: 1, cancelled: 0 },
    storageError: true,
    storageDiagnostics: { code: 'append-failed', pendingWrites: 2, failedWrites: 3, persistenceBlocked: false, raw: 'ENOENT /secret/SECRET' },
    sessionStatus: 'unavailable',
    lookupStatus: { tools: 'unavailable', messages: 'unavailable', labels: 'unavailable' },
    records: [], sessions: [] } } } });
  const status = f.byId('monitor-status').textContent;
  assert.match(status, /监控记录追加失败，部分数据可能仅在内存中/);
  assert.match(status, /写入失败 3 次/);
  assert.match(status, /待写 2 次/);
  assert.match(status, /工具归属查询暂不可用，统计用量仍可查看/);
  assert.match(status, /会话标题读取失败，暂显示会话 ID/);
  assert.match(f.byId('monitor-diagnostics').textContent, /诊断消息补查失败/);
  assert.ok(!status.includes('SECRET') && !status.includes('/secret'), 'raw errors and paths never surface');
});

test('diagnostics update without rebuilding unchanged rows or tiles', () => {
  const f = monitorFixture();
  f.selectTime('all');
  const record = { id: 'r1', startedAt: 't', model: 'm', status: 'success', attribution: 'unassigned', attributionReason: 'no-tool-ids' };
  const base = { summary: { requests: 1, success: 1, error: 0, cancelled: 0 }, retentionLimit: 5000,
    records: [record], sessions: [], sessionStatus: 'ready' };
  f.receive({ data: { type: 'monitor-state', result: { snapshot: { ...base, lookupStatus: { tools: 'ready', messages: 'disabled', labels: 'ready' } } } } });
  const row = f.byId('monitor-requests').children[0];
  const tile = f.byId('monitor-summary').children[0];
  const firstDiag = f.byId('monitor-diagnostics').textContent;
  f.receive({ data: { type: 'monitor-state', result: { snapshot: { ...base, lookupStatus: { tools: 'ready', messages: 'unavailable', labels: 'ready' } } } } });
  assert.equal(f.byId('monitor-requests').children[0], row, 'identical rows keep their node identity');
  assert.equal(f.byId('monitor-summary').children[0], tile, 'identical tiles keep their node identity');
  const secondDiag = f.byId('monitor-diagnostics').textContent;
  assert.notEqual(secondDiag, firstDiag, 'a diagnostics-only change still refreshes the hint text');
  assert.match(secondDiag, /诊断消息补查失败/);
});

test('metric labels tooltips and cell titles carry the authored semantics', () => {
  const f = monitorFixture();
  f.selectTime('all');
  f.byId('monitor-detail').checked = true; f.byId('usage-monitor').classList = { toggle() {} };
  const record = (id, tps) => validRecord(id, { startedAt: 't', tps, inputTokens: 50, outputTokens: 40, cachedTokens: 10, reasoningTokens: 5, firstResponseMs: 100, gatewayTps: 50, throughputTps: 40, durationMs: 800 });
  f.receive({ data: { type: 'monitor-state', result: { snapshot: {
    summary: { requests: 2 },
    records: [record('r1', 10), record('r2', 30)],
    sessions: [], sessionStatus: 'ready' } } } });
  f.byId('monitor-detail').listeners.change();
  const tiles = new Map(f.byId('monitor-summary').children.map(tile => [tile.children[1].textContent, tile]));
  assert.ok(tiles.has('平均首数据事件 s'), 'firstResponseMs carries the SSE-event label');
  assert.ok(tiles.has('首数据后吞吐 TPS'));
  assert.ok(tiles.has('最近有效正文 TPS'));
  assert.ok(tiles.has('请求吞吐 TPS（含等待）'));
  assert.ok(!tiles.has('平均首响应 s'), 'the stale header-time label is gone');
  assert.match(tiles.get('最近有效正文 TPS').title, /不是平均值/);
  assert.match(tiles.get('最近有效正文 TPS').title, /2 条有效样本/);
  assert.match(tiles.get('平均首数据事件 s').title, /SSE 数据事件/);
  assert.match(tiles.get('输入 token').title, /排除/);
  assert.match(tiles.get('缓存命中 token').title, /子集/);
  const cells = f.byId('monitor-requests').children[0].children;
  assert.match(cells[4].title, /SSE 数据事件/, 'the firstResponse column reuses the tile semantics');
  assert.match(cells[5].title, /首数据事件/);
  assert.match(cells[13].title, /总请求耗时/);
  assert.equal(cells[4].textContent, '0.1', 'numeric positions are unchanged');
  assert.equal(cells[5].textContent, '50');
  assert.equal(cells[13].textContent, '40');
});

test('a selected session shows its own attribution bucket and exclusion count', () => {
  const f = monitorFixture();
  f.selectTime('all');
  const record = (id, sessionId, attribution, reason, extra = {}) => ({ id, startedAt: 't', model: 'm', status: 'success', attribution, sessionId, attributionReason: reason, ...extra });
  const a1 = record('a1', 's-a', 'tool-id', null);
  const a2 = record('a2', 's-a', 'tool-id', null, { usageState: 'inconsistent' });
  const u1 = record('u1', null, 'ambiguous', 'ambiguous-match', { usageState: 'inconsistent' });
  f.receive({ data: { type: 'monitor-state', result: { snapshot: {
    summary: { requests: 3 }, retentionLimit: 5000,
    lookupStatus: { tools: 'ready', messages: 'disabled', labels: 'ready' },
    records: [a1, a2, u1],
    sessions: [
      { sessionId: 's-a', title: '甲', lastActivityAt: 1, attribution: 'tool-id', records: [a1, a2], summary: { requests: 2 } },
      { sessionId: null, title: null, lastActivityAt: null, attribution: 'unassigned', records: [u1], summary: { requests: 1 } },
    ], sessionStatus: 'ready' } } } });
  f.selectSession('s-a');
  const diag = f.byId('monitor-diagnostics').textContent;
  assert.match(diag, /归属：已确认 2 · 无可用工具 ID 0 · 工具状态未匹配 0 · 歧义 0 · 查询不可用 0/, 'the bucket counts its own rows, not the global totals');
  assert.match(diag, /已从用量与吞吐汇总排除 1 条异常记录/, 'the bucket exclusion count wins over the global one');
  assert.match(diag, /统计窗口：最近 5000 条（当前 2 条）/, 'the window still uses the global retention limit with bucket size');
});

test('the time filter defaults to this month and recomputes every tile and row', () => {
  const f = monitorFixture({ now: new Date(2026, 9, 13, 12).getTime() });
  assert.equal(f.byId('monitor-time-range').value, 'this-month', 'every fresh open defaults to the current month');
  const inside = validRecord('in', { startedAt: new Date(2026, 9, 10, 12).toISOString(), outputTokens: 10, durationMs: 1000 });
  const outside = validRecord('out', { startedAt: new Date(2020, 0, 1).toISOString(), outputTokens: 999 });
  f.receive({ data: { type: 'monitor-state', result: { snapshot: {
    summary: { requests: 2, success: 2, error: 0, cancelled: 0, outputTokens: { value: 9999, reported: 2 } },
    records: [inside, outside], sessions: [], sessionStatus: 'ready', retentionLimit: 5000 } } } });
  assert.equal(f.byId('monitor-requests').children.length, 1, 'out-of-range rows are excluded');
  assert.equal(f.byId('monitor-requests').children[0].children[7].textContent, '10');
  const tiles = new Map(f.byId('monitor-summary').children.map(tile => [tile.children[1].textContent, tile.children[0].textContent]));
  assert.equal(tiles.get('请求'), '1');
  assert.equal(tiles.get('输出 token'), '10', 'the recomputed summary ignores the stale backend aggregate');
  const info = f.byId('monitor-range-info').textContent;
  assert.match(info, /按请求开始时间统计/);
  assert.match(info, /本机时区/);
  assert.match(info, /仅基于本地保留记录，可能不完整，非供应商账单/);
});

test('date and session filters stack, sessions outside the range still list, empties stay honest', () => {
  const f = monitorFixture({ now: new Date(2026, 9, 13, 12).getTime() });
  const fresh = validRecord('fresh', { startedAt: new Date(2026, 9, 10, 12).toISOString(), sessionId: 's-b', attribution: 'tool-id', outputTokens: 5 });
  const stale = validRecord('stale', { startedAt: new Date(2020, 0, 1).toISOString(), sessionId: 's-a', attribution: 'tool-id', outputTokens: 5 });
  const sessions = [
    { sessionId: 's-a', title: '旧会话', lastActivityAt: 1, attribution: 'tool-id', records: [stale], summary: { requests: 1 } },
    { sessionId: 's-b', title: '新会话', lastActivityAt: 2, attribution: 'tool-id', records: [fresh], summary: { requests: 1 } },
  ];
  f.receive({ data: { type: 'monitor-state', result: { snapshot: { records: [fresh, stale], sessions, sessionStatus: 'ready', summary: { requests: 2 }, retentionLimit: 5000 } } } });
  assert.equal(f.byId('monitor-requests').children.length, 1);
  f.selectSession('s-a');
  const rows = f.byId('monitor-requests').children;
  assert.equal(rows.length, 1, 'a bounded range with no records shows one empty row');
  assert.equal(rows[0].children[0].textContent, '所选时间区间内暂无保留记录。');
  const options = f.byId('monitor-session').children.map(option => option.value);
  assert.ok(options.includes('s-a') && options.includes('s-b'), 'sessions with no in-range records stay selectable');
});

test('invalid custom ranges fail closed with an alert and stay editable', () => {
  const f = monitorFixture();
  f.receive({ data: { type: 'monitor-state', result: { snapshot: { records: [validRecord('a')], sessions: [], sessionStatus: 'ready', summary: { requests: 1 } } } } });
  f.selectTime('custom');
  assert.equal(f.byId('monitor-date-controls').hidden, false, 'custom shows the date inputs');
  f.setDates('2025-02-29', '2025-02-28');
  const rows = f.byId('monitor-requests').children;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].children[0].textContent, '请修正时间区间后查看用量。', 'an invalid range never falls back to unfiltered data');
  assert.equal(f.byId('monitor-summary').children.length, 0, 'the summary is cleared while the range is invalid');
  assert.equal(f.byId('monitor-range-error').hidden, false);
  assert.match(f.byId('monitor-range-error').textContent, /日期/);
  assert.equal(f.byId('monitor-time-range').disabled, false, 'the controls stay editable');
  f.setDates('2025-02-28', '2025-02-28');
  assert.equal(f.byId('monitor-range-error').hidden, true);
});

test('refresh messages never reset the time range, custom inputs or session', () => {
  const f = monitorFixture({ now: new Date(2026, 9, 13, 12).getTime() });
  const sessions = [{ sessionId: 's-a', title: '甲', lastActivityAt: 1, attribution: 'tool-id',
    records: [validRecord('a', { sessionId: 's-a' })], summary: { requests: 1 } }];
  f.receive({ data: { type: 'monitor-state', result: { snapshot: { records: [validRecord('a', { sessionId: 's-a' })], sessions, sessionStatus: 'ready', summary: { requests: 1 } } } } });
  f.selectTime('custom');
  f.setDates('2020-01-01', '2020-12-31');
  f.selectSession('s-a');
  f.receive({ data: { type: 'monitor-state', result: { snapshot: { records: [validRecord('a', { sessionId: 's-a' })], sessions, sessionStatus: 'ready', summary: { requests: 1 } } } } });
  assert.equal(f.byId('monitor-time-range').value, 'custom');
  assert.equal(f.byId('monitor-date-start').value, '2020-01-01');
  assert.equal(f.byId('monitor-date-end').value, '2020-12-31');
  assert.equal(f.byId('monitor-session').value, 's-a');
});

test('page resets when the preset boundary rolls to a new day or month', () => {
  const f = monitorFixture({ now: new Date(2026, 9, 13, 12).getTime() });
  const records = [];
  for (let i = 0; i < 120; i++) records.push(validRecord('r' + i, { startedAt: new Date(2026, 9, 10, 12).toISOString(), outputTokens: 1 }));
  const snapshot = () => ({ data: { type: 'monitor-state', result: { snapshot: { records, sessions: [], sessionStatus: 'ready', summary: { requests: 120 } } } } });
  f.receive(snapshot());
  f.byId('monitor-next').listeners.click();
  assert.match(f.byId('monitor-page').textContent, /第 2/);
  f.setNow(new Date(2026, 9, 14, 12).getTime());
  f.selectTime('last-7-days');
  assert.match(f.byId('monitor-page').textContent, /第 1/, 'a preset change resets the page');
  f.byId('monitor-next').listeners.click();
  f.setNow(new Date(2026, 10, 1, 12).getTime());
  f.selectTime('this-month');
  assert.match(f.byId('monitor-page').textContent, /第 1/, 'a range boundary move resets the page');
});

test('switching back from all to this month refilters and recomputes', () => {
  const f = monitorFixture({ now: new Date(2026, 9, 13, 12).getTime() });
  const inside = validRecord('in', { startedAt: new Date(2026, 9, 10, 12).toISOString(), outputTokens: 10 });
  const outside = validRecord('out', { startedAt: new Date(2020, 0, 1).toISOString(), outputTokens: 999 });
  const message = { data: { type: 'monitor-state', result: { snapshot: { records: [inside, outside], sessions: [], sessionStatus: 'ready', summary: { requests: 2 } } } } };
  f.receive(message);
  assert.equal(f.byId('monitor-requests').children.length, 1);
  f.selectTime('all');
  assert.equal(f.byId('monitor-requests').children.length, 2, 'all keeps every retained record');
  assert.match(f.byId('monitor-range-info').textContent, /全部保留记录/);
  f.selectTime('this-month');
  assert.equal(f.byId('monitor-requests').children.length, 1, 'returning to this month refilters');
});

test('empty-state text refreshes across invalid, bounded and all scopes', () => {
  const f = monitorFixture({ now: new Date(2026, 9, 13, 12).getTime() });
  const inside = validRecord('a', { startedAt: new Date(2026, 9, 10).toISOString() });
  const send = records => f.receive({ data: { type: 'monitor-state', result: { snapshot: { records, sessions: [], sessionStatus: 'ready', summary: { requests: records.length } } } } });
  const cell = () => f.byId('monitor-requests').children[0].children[0].textContent;
  f.selectTime('all'); send([inside]);
  f.selectTime('custom'); f.setDates('2021-01-01', '2020-12-31');
  send([inside]);
  assert.equal(cell(), '请修正时间区间后查看用量。', 'an invalid scope never keeps showing old rows');
  f.setDates('2021-01-01', '2021-12-31');
  assert.equal(f.byId('monitor-range-error').hidden, true);
  assert.equal(cell(), '所选时间区间内暂无保留记录。', 'a now-valid empty range replaces the alert copy');
  send([]); f.selectTime('all');
  assert.equal(cell(), '还没有请求记录。', 'all-empty keeps the legacy copy');
  f.selectTime('last-7-days'); send([]);
  assert.equal(cell(), '所选时间区间内暂无保留记录。', 'bounded-empty is not stuck on the all-empty text');
});

test('row start times render in the local zone and keep the original timestamp on hover', () => {
  const saved = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Shanghai';
    const f = monitorFixture({ now: new Date(2026, 9, 13, 12).getTime() });
    f.selectTime('all');
    f.receive({ data: { type: 'monitor-state', result: { snapshot: {
      records: [validRecord('a', { startedAt: '2019-12-31T16:00:00.000Z' }), validRecord('b', { startedAt: 'not-a-date' })],
      sessions: [], sessionStatus: 'ready', summary: { requests: 2 } } } } });
    const first = f.byId('monitor-requests').children[0].children[0];
    const second = f.byId('monitor-requests').children[1].children[0];
    assert.match(first.textContent, /^2020\/01\/01 00:00/, 'the UTC instant renders as the local calendar moment');
    assert.equal(first.title, '原始时间：2019-12-31T16:00:00.000Z');
    assert.equal(second.textContent, 'not-a-date', 'unparseable timestamps pass through untouched');
    assert.equal(second.title, '原始时间：not-a-date');
    assert.equal(f.byId('monitor-requests').children[0].children[1].textContent, 'm', 'numeric columns keep their positions');
  } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
});

test('a timezone-only change re-keys the absolute range and resets the page', () => {
  const saved = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Shanghai';
    const f = monitorFixture({ now: new Date(2026, 9, 13, 12).getTime() });
    const records = [];
    for (let i = 0; i < 120; i++) records.push(validRecord('r' + i, { startedAt: new Date(2026, 9, 10).toISOString(), outputTokens: 1 }));
    const send = () => f.receive({ data: { type: 'monitor-state', result: { snapshot: { records, sessions: [], sessionStatus: 'ready', summary: { requests: 120 } } } } });
    f.selectTime('this-month'); send();
    f.byId('monitor-next').listeners.click();
    assert.match(f.byId('monitor-page').textContent, /第 2/, 'page two is valid before the move');
    process.env.TZ = 'America/Los_Angeles';
    send();
    assert.match(f.byId('monitor-page').textContent, /第 1/, 'same date label but different absolute bounds resets the page');
  } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
});

test('a preset rollover resets the page while the window stays populated', () => {
  const f = monitorFixture({ now: new Date(2026, 9, 13, 12).getTime() });
  const last7 = [];
  for (let i = 0; i < 120; i++) last7.push(validRecord('w' + i, { startedAt: new Date(2026, 9, 10, 12).toISOString(), outputTokens: 1 }));
  const send7 = () => f.receive({ data: { type: 'monitor-state', result: { snapshot: { records: last7, sessions: [], sessionStatus: 'ready', summary: { requests: 120 } } } } });
  f.selectTime('last-7-days'); send7();
  f.byId('monitor-next').listeners.click();
  assert.match(f.byId('monitor-page').textContent, /第 2/);
  f.setNow(new Date(2026, 9, 14, 12).getTime()); send7();
  assert.match(f.byId('monitor-page').textContent, /第 1/, 'a new day resets the page without changing the preset');
  assert.equal(f.byId('monitor-requests').children.length, 100, 'the window still holds records, so the reset is not a clamp');

  const months = [];
  for (let i = 0; i < 120; i++) months.push(validRecord('o' + i, { startedAt: new Date(2026, 9, 31, 12).toISOString(), outputTokens: 1 }));
  for (let i = 0; i < 120; i++) months.push(validRecord('n' + i, { startedAt: new Date(2026, 10, 1, 12).toISOString(), outputTokens: 1 }));
  const sendM = () => f.receive({ data: { type: 'monitor-state', result: { snapshot: { records: months, sessions: [], sessionStatus: 'ready', summary: { requests: 240 } } } } });
  f.setNow(new Date(2026, 9, 31, 23).getTime());
  f.selectTime('this-month'); sendM();
  f.byId('monitor-next').listeners.click();
  assert.match(f.byId('monitor-page').textContent, /第 2/, 'October month fills page two');
  f.setNow(new Date(2026, 10, 1, 1).getTime()); sendM();
  assert.match(f.byId('monitor-page').textContent, /第 1/, 'the month rollover resets the page');
  assert.equal(f.byId('monitor-requests').children.length, 100, 'November still fills page one');
});

test('bounded scopes drop an incomplete attribution breakdown while all keeps a complete one', () => {
  const f = monitorFixture({ now: new Date(2026, 9, 13, 12).getTime() });
  const records = [validRecord('a', { startedAt: new Date(2026, 9, 10).toISOString(), sessionId: 's-1', attribution: 'tool-id', attributionReason: null }),
    validRecord('b', { startedAt: new Date(2026, 9, 10).toISOString(), attribution: 'unassigned', attributionReason: null })];
  const snapshot = { records, sessions: [], sessionStatus: 'ready', summary: { requests: 2 }, retentionLimit: 5000,
    lookupStatus: { tools: 'ready', messages: 'disabled', labels: 'ready' },
    attributionSummary: { assigned: 1, ambiguous: 0, noToolIds: 1, unmatchedToolIds: 0, lookupUnavailable: 0 } };
  const send = () => f.receive({ data: { type: 'monitor-state', result: { snapshot } } });
  f.selectTime('all'); send();
  assert.match(f.byId('monitor-diagnostics').textContent, /归属：已确认 1 · 无可用工具 ID 1/, 'all keeps the complete same-scope original counts');
  f.selectTime('custom'); f.setDates('2026-10-01', '2026-10-31'); send();
  assert.doesNotMatch(f.byId('monitor-diagnostics').textContent, /归属：已确认/, 'an incomplete computed breakdown stays hidden instead of fabricating zeros');
});

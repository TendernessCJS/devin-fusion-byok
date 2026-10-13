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
  const record = { id: 'id', startedAt: 'now', model: '<img onerror=alert(1)>', status: 'success', inputTokens: 0, outputTokens: null, usageComplete: false, attribution: 'unassigned' };
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
  assert.equal(tiles.get('平均首响应 s'), '1.234');
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

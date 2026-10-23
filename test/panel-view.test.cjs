'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { renderPanel } = require('../src/panel/view.cjs');

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.listenerCounts = {}; this.dataset = {};
    this.classList = { add() {} }; this.style = {}; this.value = ''; this.textContent = ''; this.className = '';
    this.checked = false; this.disabled = false; this.open = false; this.scrollTop = 0;
    this.selectionStart = 0; this.selectionEnd = 0; this.ownerDocument = null; }
  append(...children) { for (const child of children) if (child != null) this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(name, listener) { this.listenerCounts[name] = (this.listenerCounts[name] || 0) + 1; this.listeners[name] = listener; }
  removeEventListener(name) { delete this.listeners[name]; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  close() { this.open = false; }
  showModal() { this.open = true; }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  reportValidity() { return true; }
}

// The panel writes most copy through createTextNode, so reading an aggregated
// element means walking its children (textContent itself stays empty in the stub).
function textOf(node) {
  if (!node) return '';
  return String(node.textContent || '') + (node.children || []).map(textOf).join('');
}

function collect(node, tag, predicate = () => true) {
  const found = [];
  if (node.tag === tag && predicate(node)) found.push(node);
  for (const child of node.children || []) found.push(...collect(child, tag, predicate));
  return found;
}

function panel(controlTags = {}, script = renderPanel({ nonce: 'safe', cspSource: 'test:' }).match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]) {
  const elements = new Map(), posts = [], listeners = [];
  let focused = true;
  const byId = id => { if (!elements.has(id)) { const node = new Element(controlTags[id] || 'div'); node.ownerDocument = document; elements.set(id, node); } return elements.get(id); };
  const document = { getElementById: byId, createTextNode: text => ({ textContent: text }),
    activeElement: null, scrollingElement: { scrollTop: 0 }, hasFocus: () => focused,
    querySelectorAll: selector => selector.includes('main')
      ? [...elements.values()].filter(node => ['button', 'input', 'select'].includes(node.tag) && node.attributes.class !== 'tab')
      : [] };
  document.createElement = tag => {
    const node = new Element(tag);
    node.ownerDocument = document;
    node.setAttribute = (key, value) => { node.attributes[key] = value; if (key === 'id') elements.set(value, node); };
    return node;
  };
  vm.runInNewContext(script,
    { acquireVsCodeApi: () => ({ getState: () => ({}), setState() {}, postMessage: message => posts.push(message) }), document,
      window: { addEventListener: (name, listener) => { if (name === 'message') listeners.push(listener); } }, setTimeout: () => 0, clearTimeout() {} });
  return { byId, posts, listeners, receive: data => { for (const listener of listeners) listener(data); },
    activeElement: () => document.activeElement, scrollingElement: () => document.scrollingElement,
    setHasFocus: value => { focused = value; } };
}

const state = () => ({ enabled: true, providers: [{ id: 'cpa', name: 'CPA', baseUrl: 'https://cpa.invalid/v1', apiFormat: 'openai',
  enabled: true, keyConfigured: true, models: [{ id: 'saved', label: 'Saved', enabled: true, efforts: [],
    contextWindow: 200000, maxOutputTokens: 32768 }] }], nativeModels: [], roleLists: { lead: [], sidekick: [] },
  autoContinueStatus: 'unavailable' });

test('all controls share the --control-h height token so rows align', () => {
  const html = renderPanel({ nonce: 'safe', cspSource: 'test:' });
  assert.match(html, /--control-h: 28px/);
  assert.match(html, /button \{ min-height: var\(--control-h\)/);
  assert.match(html, /input:not\(\[type="checkbox"\]\), select \{ min-height: var\(--control-h\)/);
  assert.doesNotMatch(html, /min-height: 30px/, 'no control may hard-code a height off the shared token');
  assert.match(html, /\.actions\.nowrap \{ flex-wrap: nowrap; \}/);
  assert.match(html, /#update-proxy \{ width: 200px/);
  assert.match(html, /ul, ol \{ padding-left: 20px; \}/, 'the ua list indentation is reset');
  assert.doesNotMatch(html, /h1, h2, h3, p \{ margin: 0 \}/, 'the heading reset must include lists too');
});

test('the tab strip puts models first and Fusion second', () => {
  const html = renderPanel({ nonce: 'safe', cspSource: 'test:' });
  assert.deepEqual([...html.matchAll(/data-tab="([a-z]+)"/g)].map(match => match[1]),
    ['models', 'fusion', 'usage', 'goal', 'fastcontext', 'settings']);
  const first = html.indexOf('id="view-models"'), second = html.indexOf('id="view-fusion"');
  assert.ok(first > 0 && second > first, 'the Fusion section follows the model section');
  assert.doesNotMatch(html, /id="view-presets"/, 'the preset tab is gone');
  assert.doesNotMatch(html, /id="fusion"/, 'the preset list container is gone');
  assert.doesNotMatch(html, /新建预设|我的预设/, 'no preset authoring copy survives');
  const sectionTag = id => html.match(new RegExp('<section[^>]*id="' + id + '"[^>]*>'))[0];
  assert.ok(!sectionTag('view-models').includes('hidden'), 'the first tab renders visible');
  assert.ok(sectionTag('view-fusion').includes('hidden'), 'the Fusion tab starts hidden');
});

test('the Fusion tab hosts the role grids that drive the official Fusion card', () => {
  const { byId, receive } = panel();
  receive({ data: { type: 'state', state: { ...state(), roleLists: {
    lead: [{ ref: { providerId: 'cpa', model: 'saved' }, label: 'CPA · Saved', native: false, available: true, selected: true, variantCount: 2 },
      { ref: { nativeUid: 'claude-haiku-5-5-high' }, label: 'Claude Haiku 5.5', native: true, available: true,
        selected: false, defaultSelected: false, explicitIncluded: false, memberUids: ['claude-haiku-5-5-high'] }],
    sidekick: [] } } } });
  assert.equal(byId('role-count').textContent, 'Lead 1 · Sidekick 0');
  const list = byId('lead-role-list');
  const titles = child => collect(child, 'span', node => node.className === 'row-title').map(node => node.textContent);
  const rows = list.children.filter(node => node.className === 'row');
  assert.deepEqual(titles(rows[0]), ['CPA · Saved'], 'the selected row stays in the main list');
  assert.match(textOf(rows[0]), /BYOK · 2 档/, 'a BYOK row shows its source and effort tier count');
  const fold = list.children.find(node => node.tag === 'details');
  assert.ok(fold, 'deselected official models move under the fold');
  assert.deepEqual(titles(fold), ['Claude Haiku 5.5'], 'the fold carries the rest of the official models');
  assert.match(fold.children[0].textContent, /更多官方模型（1）/);
  assert.doesNotMatch(renderPanel({ nonce: 'safe', cspSource: 'test:' }), /id="role-group"/,
    'the role picker no longer lives in settings');
});

test('a dead role row offers removal only once the native catalog is ready', () => {
  const { byId, receive } = panel();
  const deadNative = { ref: { nativeUid: 'gone-uid' }, label: 'Gone', native: true,
    available: false, selected: false, defaultSelected: false, disabled: true, reason: '当前未在可用列表中' };
  receive({ data: { type: 'state', state: { ...state(), roleLists: { lead: [deadNative], sidekick: [] } } } });
  let rows = collect(byId('lead-role-list'), 'div', node => node.className === 'row');
  assert.equal(collect(rows[0], 'button', node => node.textContent === '移除').length, 0,
    'an unconfirmed dead row cannot be dropped while the catalog is unsynced');
  assert.match(textOf(rows[0]), /官方目录未同步，暂无法确认/);
  receive({ data: { type: 'state', state: { ...state(), nativeCatalogStatus: 'ready',
    roleLists: { lead: [deadNative], sidekick: [] } } } });
  rows = collect(byId('lead-role-list'), 'div', node => node.className === 'row');
  const remove = collect(rows[0], 'button', node => node.textContent === '移除')[0];
  assert.ok(remove, 'a confirmed dead row offers removal');
  assert.match(textOf(rows[0]), /当前未在可用列表中/);
  remove.listeners.click();
});

test('the add-model dialog renders the 131072-token output default and keeps saved values', () => {
  const { byId, posts, receive } = panel();
  receive({ data: { type: 'state', state: state() } });
  const add = collect(byId('models'), 'button', node => node.textContent === '手动添加')[0];
  assert.ok(add, 'the manual add button is rendered');
  add.listeners.click();
  const dialog = byId('editor-dialog');
  const numbers = collect(dialog, 'input', node => node.attributes.type === 'number');
  assert.deepEqual(numbers.map(node => node.value), ['272000', '131072']);
  assert.equal(posts.filter(message => message.type === 'addModel').length, 0);
});

test('the edit-model dialog renders the saved output limit unchanged', () => {
  const { byId, receive } = panel();
  receive({ data: { type: 'state', state: state() } });
  const edit = collect(byId('models'), 'button', node => String(node.attributes['aria-label'] || '').startsWith('编辑模型'))[0];
  assert.ok(edit, 'the edit button is rendered');
  edit.listeners.click();
  const numbers = collect(byId('editor-dialog'), 'input', node => node.attributes.type === 'number');
  assert.deepEqual(numbers.map(node => node.value), ['200000', '32768']);
});

test('the effort hint lists the Max preset and notes provider-dependent support', () => {
  const { byId, receive } = panel();
  receive({ data: { type: 'state', state: state() } });
  const edit = collect(byId('models'), 'button', node => String(node.attributes['aria-label'] || '').startsWith('编辑模型'))[0];
  assert.ok(edit, 'the edit button is rendered');
  edit.listeners.click();
  const hints = collect(byId('editor-dialog'), 'span', node => node.className === 'hint').map(node => node.textContent);
  const effortHint = hints.find(text => text.includes('XHigh'));
  assert.ok(effortHint, 'the effort hint is rendered');
  assert.ok(effortHint.includes('Max'), 'the automatic preset hint mentions Max');
  assert.ok(/供应商/.test(effortHint), 'the hint notes that the supported tiers depend on the provider');
});

test('a model switch saves right away without a separate apply step', () => {
  const { byId, posts, receive } = panel();
  receive({ data: { type: 'state', state: state() } });
  const toggle = collect(byId('models'), 'input', node => node.attributes['aria-label'] === '启用模型 Saved')[0];
  assert.ok(toggle, 'the model switch is rendered');
  toggle.listeners.change({ target: { checked: false } });
  const update = posts.find(message => message.type === 'updateModels');
  assert.deepEqual(JSON.parse(JSON.stringify(update.payload)), { providerId: 'cpa', changes: [{ id: 'saved', enabled: false }] });
});

test('deleting a model lives in its edit dialog', () => {
  const { byId, receive } = panel();
  receive({ data: { type: 'state', state: state() } });
  assert.equal(collect(byId('models'), 'button', node => node.textContent === '删除').length, 0, 'rows carry no delete button');
  collect(byId('models'), 'button', node => String(node.attributes['aria-label'] || '').startsWith('编辑模型'))[0].listeners.click();
  assert.equal(collect(byId('editor-dialog'), 'button', node => node.textContent === '删除').length, 1);
});

test('the settings tab exposes the CLI cache refresh and reports the last run', () => {
  const { byId, posts, receive } = panel();
  receive({ data: { type: 'state', state: { ...state(), cliCache: { at: '2026-10-14T12:00:00.000Z', checked: 2,
    refreshed: ['model_configs_v5.abcd1234.bin'], skipped: [{ name: 'team_settings.abcd1234.bin', reason: 'no-improvement' }], errors: [] } } } });
  assert.match(textOf(byId('cache-report')), /已重写 model_configs_v5/);
  assert.match(textOf(byId('cache-report')), /team_settings 无需重写/);
  assert.match(textOf(byId('cache-hint')), /最近检查 \d{2}:\d{2}/);
  byId('refresh-cache').listeners.click();
  assert.ok(posts.some(message => message.type === 'refreshCliCaches'), 'the button asks the host to refresh');
});

test('an injection failure in the cache report reads as untouched, not as up to date', () => {
  const { byId, receive } = panel();
  receive({ data: { type: 'state', state: { ...state(), cliCache: { at: '2026-10-16T12:00:00.000Z', checked: 2, refreshed: [],
    skipped: [{ name: 'user_status.abcd1234.bin', reason: 'shape-unrecognized' },
      { name: 'team_settings.abcd1234.bin', reason: 'no-improvement' }], errors: [] } } } });
  const report = textOf(byId('cache-report'));
  assert.match(report, /user_status 未改动（载荷形状未识别）/);
  assert.doesNotMatch(report, /user_status 无需重写/, 'a failed injection must not claim the file is current');
  assert.match(report, /team_settings 无需重写/);
});

test('the settings tab summarizes backend and catalog status', () => {
  const { byId, receive } = panel();
  receive({ data: { type: 'state', state: { ...state(), backendStatus: 'running', nativeCatalogStatus: 'ready' } } });
  assert.match(textOf(byId('settings-general')), /后台服务 运行中 · 官方目录 已同步/);
  receive({ data: { type: 'state', state: { ...state(), backendStatus: 'port_in_use', nativeCatalogStatus: 'empty' } } });
  assert.match(textOf(byId('settings-general')), /后台服务 异常（port_in_use） · 官方目录 未同步/);
});

test('a state render mid-request keeps the busy lock but must not stick it', async () => {
  const { byId, posts, receive } = panel({ 'refresh-cache': 'button', 'reload-window': 'button', 'restart-devin': 'button',
    'plugin-enabled': 'input', 'add-provider': 'button' });
  receive({ data: { type: 'state', state: state() } });
  byId('refresh-cache').listeners.click();
  const request = posts.at(-1);
  assert.equal(request.type, 'refreshCliCaches');
  assert.equal(byId('refresh-cache').disabled, true, 'busy locks the clicked control');
  assert.equal(byId('reload-window').disabled, true, 'busy locks static controls');
  receive({ data: { type: 'state', state: { ...state(), cliCache: { at: 'x', checked: 1, refreshed: [], skipped: [], errors: [] } } } },
    'the host posts state before the result, so render lands while busy');
  receive({ data: { type: 'result', id: request.id, ok: true } });
  await Promise.resolve();
  assert.equal(byId('refresh-cache').disabled, false, 'unlock restores the original false, not a recorded true');
  assert.equal(byId('reload-window').disabled, false);
});

test('a state push keeps the focused search box, its caret and the scroll positions', () => {
  const ui = panel();
  ui.receive({ data: { type: 'state', state: state() } });
  const current = (container, tag, match) => collect(ui.byId(container), tag, match)[0];
  const search = current('models', 'input', node => node.getAttribute('aria-label') === '搜索导入的模型');
  const listNow = () => current('models', 'div', node => node.getAttribute('id') === 'model-list');
  search.focus(); search.value = 'dee'; search.setSelectionRange(2, 2);
  listNow().scrollTop = 120;
  ui.scrollingElement().scrollTop = 300;
  ui.receive({ data: { type: 'state', state: state() } });
  const next = current('models', 'input', node => node.getAttribute('aria-label') === '搜索导入的模型');
  assert.notStrictEqual(next, search, 'the state push really did rebuild the search box');
  assert.strictEqual(ui.activeElement(), next, 'focus follows the rebuilt node');
  assert.equal(next.selectionStart, 2, 'the caret survives the rebuild');
  assert.equal(listNow().scrollTop, 120, 'the list keeps its scroll offset');
  assert.equal(ui.scrollingElement().scrollTop, 300, 'the page keeps its scroll offset');
});

test('a state push never pulls focus back into a hidden panel', () => {
  const ui = panel();
  ui.receive({ data: { type: 'state', state: state() } });
  const search = collect(ui.byId('models'), 'input', node => node.getAttribute('aria-label') === '搜索导入的模型')[0];
  search.focus();
  ui.setHasFocus(false);
  ui.receive({ data: { type: 'state', state: state() } });
  const next = collect(ui.byId('models'), 'input', node => node.getAttribute('aria-label') === '搜索导入的模型')[0];
  assert.notStrictEqual(ui.activeElement(), next, 'a hidden webview must not steal focus back from the editor');
});

test('the Fusion tab reports the mirrored count and the last combination used', () => {
  const { byId, receive } = panel();
  receive({ data: { type: 'state', state: { ...state(), fusionCount: 236,
    lastFusion: { uid: 'fusion-a-sidekick-b', label: 'Fusion (CPA · Saved + SWE-2 Max)', source: 'mirrored' } } } });
  assert.equal(byId('fusion-summary').textContent,
    '已镜像 236 条组合；最近一次使用：Fusion (CPA · Saved + SWE-2 Max)（插件镜像）');

  receive({ data: { type: 'state', state: { ...state(), fusionCount: 12, lastFusion: null } } });
  assert.equal(byId('fusion-summary').textContent, '已镜像 12 条组合；还没有在 Fusion 卡片里选过组合');
});

test('a cache report without rewrites says so instead of staying blank', () => {
  const { byId, receive } = panel();
  receive({ data: { type: 'state', state: state() } });
  assert.match(textOf(byId('cache-report')), /还没有记录/);
  receive({ data: { type: 'state', state: { ...state(), cliCache: { at: '2026-10-14T12:00:00.000Z', checked: 3, refreshed: [], skipped: [], errors: [] } } } });
  assert.match(textOf(byId('cache-report')), /已是最新/);
  receive({ data: { type: 'state', state: { ...state(), cliCache: { at: '2026-10-14T12:00:00.000Z', checked: 0, refreshed: [], skipped: [], errors: [] } } } });
  assert.match(textOf(byId('cache-report')), /没有找到本插件写入的缓存文件/);
});

const FAMILY_FIXTURE = [
  { id: 'glm-5.2', label: 'GLM-5.2', variants: 3, efforts: ['No Thinking', 'High', 'Max'], toggles: ['1M Context'],
    hidden: true,
    members: [
      { uid: 'glm-5-2', label: 'GLM-5.2 High', disabled: false, eligible: true, hidden: false },
      { uid: 'glm-5-2-max', label: 'GLM-5.2 Max', disabled: false, eligible: true, hidden: true },
      { uid: 'glm-5-2-1m', label: 'GLM-5.2 High 1M', disabled: false, eligible: false, hidden: false }] },
  { id: 'swe-1.6', label: 'SWE-1.6', variants: 1, efforts: [], toggles: [], hidden: true,
    members: [{ uid: 'swe-1-6', label: 'SWE-1.6', disabled: false, eligible: false, hidden: true }] },
];

test('official models render as one row per family with a single family switch', async () => {
  const { byId, posts, receive } = panel();
  receive({ data: { type: 'state', state: { ...state(), nativeFamilies: FAMILY_FIXTURE } } });
  const list = byId('native-list');
  assert.equal(byId('native-count').textContent, '0 / 2 个系列 · 已隐藏 2');

  const rows = collect(list, 'div', node => node.className === 'row');
  assert.equal(collect(list, 'details', node => node.className === 'fold').length, 0,
    'family rows carry no member fold');
  assert.equal(rows.length, 2, 'one row per family, no member rows');
  assert.match(textOf(rows[0]), /GLM-5\.2/);
  assert.match(textOf(rows[0]), /3 个变体 · Effort No Thinking \/ High \/ Max · 1M Context/);
  assert.doesNotMatch(textOf(rows[0]), /部分隐藏/, 'hiding is all-or-nothing at family level');
  assert.doesNotMatch(textOf(rows[0]), /不能作为 Fusion/, 'eligible members mean no capability note');
  assert.match(textOf(rows[1]), /不可用作 Fusion Lead\/Sidekick/, 'no eligible member adds the note');

  const flush = () => Promise.resolve().then(() => {});
  const familySwitch = collect(rows[0], 'input', node => node.className === 'switch')[0];
  assert.equal(familySwitch.attributes['aria-label'], '在列表中显示 GLM-5.2 的 3 个变体');
  assert.equal(familySwitch.checked, false, 'one hidden member renders the family switch off');
  familySwitch.listeners.change({ target: { checked: true } });
  const showAll = posts.find(message => message.type === 'setNativeModelHidden');
  assert.deepEqual(JSON.parse(JSON.stringify(showAll.payload)),
    { uids: ['glm-5-2', 'glm-5-2-max', 'glm-5-2-1m'], hidden: false }, 'the family switch clears every member');
  receive({ data: { type: 'result', id: showAll.id, ok: true } });
  await flush();

  // A rebuild must keep the switch truthful: hidden families stay off, and
  // still no member fold reappears.
  receive({ data: { type: 'state', state: { ...state(), nativeFamilies: FAMILY_FIXTURE } } });
  const rowsAfter = collect(byId('native-list'), 'div', node => node.className === 'row');
  assert.equal(collect(byId('native-list'), 'details', node => node.className === 'fold').length, 0);
  assert.equal(rowsAfter.length, 2);
  assert.equal(collect(rowsAfter[0], 'input', node => node.className === 'switch')[0].checked, false);
  assert.equal(collect(rowsAfter[1], 'input', node => node.className === 'switch')[0].checked, false,
    'the hidden family renders off after a full rebuild');
});

test('the official-model search matches family labels and member uids', () => {
  const { byId, receive } = panel();
  receive({ data: { type: 'state', state: { ...state(), nativeFamilies: FAMILY_FIXTURE } } });
  const search = collect(byId('native-models'), 'input', node => node.attributes.type === 'search')[0];
  search.value = 'glm-5-2-max';
  search.listeners.input({ target: search });
  const rows = collect(byId('native-list'), 'div', node => node.className === 'row');
  assert.equal(rows.length, 1, 'only the matching family row remains');
  assert.match(textOf(rows[0]), /GLM-5\.2/);
});

test('model rows carry tier and context info, and a missing key warns on import', () => {
  const { byId, receive } = panel();
  const next = state();
  next.providers[0].models = [
    { id: 'multi', label: 'Multi', enabled: true, efforts: ['high', 'max'], contextWindow: 1048576, maxOutputTokens: 32768 },
    { id: 'plain', label: 'Plain', enabled: true, efforts: [], contextWindow: 32000, maxOutputTokens: 8192 }];
  receive({ data: { type: 'state', state: next } });
  const rows = collect(byId('model-list'), 'div', node => node.className === 'row');
  const texts = rows.map(textOf);
  assert.ok(texts.some(text => /Multi/.test(text) && /multi · 2 档 · 1M Context/.test(text)),
    'a multi-variant row shows the id, tier count and context window');
  assert.ok(texts.some(text => /plain · 32K Context/.test(text) && !/档/.test(text)),
    'a single-variant row omits the tier count');

  const second = panel();
  const keyless = state();
  keyless.providers[0].keyConfigured = false;
  second.receive({ data: { type: 'state', state: keyless } });
  const importButton = collect(second.byId('models'), 'button', node => node.textContent === '导入模型')[0];
  assert.match(importButton.title || '', /未配置 API 密钥/, 'import warns when no key is configured');
  importButton.listeners.click();
  assert.ok(!second.posts.some(message => message.type === 'refreshModels'),
    'import never reaches the backend without a key');
  assert.match(textOf(second.byId('status')), /未配置 API 密钥/, 'the click explains why import is unavailable');
});

test('bulk toggles act on the search-filtered set and say so', () => {
  const { byId, posts, receive } = panel();
  const next = state();
  next.providers[0].models = [
    { id: 'flash-a', label: 'Flash A', enabled: true, efforts: [], contextWindow: 272000 },
    { id: 'flash-b', label: 'Flash B', enabled: true, efforts: [], contextWindow: 272000 },
    { id: 'pro-c', label: 'Pro C', enabled: true, efforts: [], contextWindow: 272000 }];
  receive({ data: { type: 'state', state: next } });

  const search = collect(byId('models'), 'input', node => node.attributes.type === 'search')[0];
  search.value = 'flash';
  search.listeners.input({ target: search });

  const bulkRow = collect(byId('model-list'), 'div', node => node.className === 'row compact')[0];
  assert.match(textOf(bulkRow), /筛选出 2 个 · 2 \/ 2 已启用/, 'the count is scoped to the filtered set');
  const stopButton = collect(bulkRow, 'button', node => node.textContent === '停用这些')[0];
  assert.ok(stopButton, 'filtered bulk buttons drop the 「全部」 wording');
  stopButton.listeners.click();
  const update = posts.find(message => message.type === 'updateModels');
  assert.deepEqual(JSON.parse(JSON.stringify(update.payload.changes)),
    [{ id: 'flash-a', enabled: false }, { id: 'flash-b', enabled: false }],
    'only filtered models are touched');
});

test('a second state push does not stack listeners: one click still posts one request', async () => {
  const { byId, posts, receive, listeners } = panel();
  const messageRegistrations = listeners.length;
  receive({ data: { type: 'state', state: state() } });
  receive({ data: { type: 'state', state: state() } });
  const toggle = collect(byId('models'), 'input', node => node.attributes['aria-label'] === '启用模型 Saved')[0];
  assert.ok(toggle, 'the rebuilt model switch is in the live subtree');
  toggle.listeners.change({ target: { checked: false } });
  assert.equal(posts.filter(message => message.type === 'updateModels').length, 1,
    'each rebuilt row must carry exactly one handler');
  receive({ data: { type: 'result', id: posts.at(-1).id, ok: true } });
  await Promise.resolve();
  assert.equal(byId('add-provider').listenerCounts.click, 1, 'the add-provider bind ran exactly once');
  assert.equal(byId('refresh-cache').listenerCounts.click, 1, 'the refresh-cache bind ran exactly once');
  byId('refresh-cache').listeners.click();
  assert.equal(posts.filter(message => message.type === 'refreshCliCaches').length, 1,
    'static buttons are bound once, not once per render');
  assert.equal(listeners.length, messageRegistrations, 'state pushes must not register further message listeners');
});

test('the harness detects a duplicated static bind through registration counts', () => {
  const source = renderPanel({ nonce: 'safe', cspSource: 'test:' }).match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  const duplicated = source.replace('modelsView.bind();', 'modelsView.bind(); modelsView.bind();');
  assert.notEqual(duplicated, source, 'the in-memory patch must hit the real bind site');
  const { byId, listeners } = panel({}, duplicated);
  assert.equal(byId('add-provider').listenerCounts.click, 2,
    'the registration counter must expose a bind that ran twice');
  assert.equal(listeners.length, panel().listeners.length, 'message registrations match the unpatched panel');
});

test('unlock restores an originally-disabled control as still disabled', async () => {
  const { byId, posts, receive } = panel({ 'refresh-cache': 'button' });
  const locked = () => ({ ...state(), enabled: false,
    providers: [{ ...state().providers[0] }] });
  receive({ data: { type: 'state', state: locked() } });
  const deadSwitch = collect(byId('settings-general'), 'input', node => node.className === 'switch')[0];
  assert.equal(deadSwitch.disabled, true, 'an off plugin disables the auto-continue switches');
  byId('refresh-cache').listeners.click();
  const request = posts.at(-1);
  assert.equal(request.type, 'refreshCliCaches');
  receive({ data: { type: 'state', state: locked() } });
  receive({ data: { type: 'result', id: request.id, ok: true } });
  await Promise.resolve();
  const restored = collect(byId('settings-general'), 'input', node => node.className === 'switch')[0];
  assert.equal(restored.disabled, true, 'a node locked while disabled stays disabled, never resurrected');
  assert.equal(byId('refresh-cache').disabled, false);
});

test('provider selection, role/native search and fold state survive a state push', () => {
  const { byId, receive } = panel();
  const two = () => ({ ...state(), providers: [
    { ...state().providers[0] },
    { id: 'cpb', name: 'CPB', baseUrl: 'https://cpb.invalid/v1', apiFormat: 'openai', enabled: true, keyConfigured: true, models: [] }],
    roleLists: { lead: [{ ref: { nativeUid: 'n1' }, label: 'Native One', native: true, available: true, selected: true, memberUids: ['n1'] },
      { ref: { nativeUid: 'n2' }, label: 'Native Two', native: true, available: true, selected: false, defaultSelected: false, explicitIncluded: false, memberUids: ['n2'] }],
      sidekick: [] } });
  receive({ data: { type: 'state', state: two() } });
  collect(byId('providers'), 'button', node => textOf(node).includes('CPB'))[0].listeners.click();
  const fold = collect(byId('lead-role-list'), 'details', node => node.className === 'fold')[0];
  assert.ok(fold, 'an unselected official model lands under the fold');
  fold.open = true;
  fold.listeners.toggle();
  const roleSearchBox = collect(byId('role-lead'), 'input', node => node.attributes.type === 'search')[0];
  roleSearchBox.value = 'two';
  roleSearchBox.listeners.input({ target: roleSearchBox });
  const nativeSearchBox = collect(byId('native-models'), 'input', node => node.attributes.type === 'search')[0];
  nativeSearchBox.value = 'glm';
  nativeSearchBox.listeners.input({ target: nativeSearchBox });
  receive({ data: { type: 'state', state: two() } });
  const selected = collect(byId('providers'), 'button', node => node.className.includes('selected'))[0];
  assert.match(textOf(selected), /CPB/, 'the clicked provider stays selected');
  assert.equal(collect(byId('role-lead'), 'input', node => node.attributes.type === 'search')[0].value, 'two',
    'the role search text survives');
  assert.equal(collect(byId('native-models'), 'input', node => node.attributes.type === 'search')[0].value, 'glm',
    'the native search text survives');
  assert.equal(collect(byId('lead-role-list'), 'details', node => node.className === 'fold').length, 0,
    'a non-empty query hides the fold entirely, but the open flag is restored when it returns');
  const roleSearch2 = collect(byId('role-lead'), 'input', node => node.attributes.type === 'search')[0];
  roleSearch2.value = '';
  roleSearch2.listeners.input({ target: roleSearch2 });
  assert.equal(collect(byId('lead-role-list'), 'details', node => node.className === 'fold')[0].open, true,
    'the fold restores its open state');
});

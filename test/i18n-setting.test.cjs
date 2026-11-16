'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createI18n, CHOICE_KEY } = require('../src/i18n/index.cjs');
const { createPanelController } = require('../src/panel/controller.cjs');
const { renderPanel } = require('../src/panel/view.cjs');

function memento(initial = {}) {
  const values = { ...initial }, writes = [];
  return { values, writes, get: key => values[key], update: async (key, value) => { writes.push([key, value]); if (value === undefined) delete values[key]; else values[key] = value; } };
}

test('the language service follows the editor until a choice is stored, then persists that choice', async () => {
  let editor = 'en';
  const store = memento();
  const i18n = createI18n({ language: () => editor, memento: store });
  assert.equal(i18n.choice(), 'auto');
  assert.equal(i18n.t('common.cancel'), 'Cancel');
  editor = 'zh-tw';
  assert.equal(i18n.t('common.cancel'), '取消', 'auto re-reads the display language on every call');
  const events = [];
  i18n.onDidChange(event => events.push(event));
  assert.equal(await i18n.setChoice('en'), 'en');
  assert.deepEqual(store.values, { [CHOICE_KEY]: 'en' });
  assert.equal(i18n.t('common.cancel'), 'Cancel', 'an explicit choice beats the display language');
  await i18n.setChoice('auto');
  assert.deepEqual(store.writes.at(-1), [CHOICE_KEY, undefined], 'auto is stored as absent');
  assert.equal(i18n.t('common.cancel'), '取消');
  assert.deepEqual(events.map(({ locale, previous, choice }) => [previous, locale, choice]), [['zh-CN', 'en', 'en'], ['en', 'zh-CN', 'auto']]);
  await assert.rejects(i18n.setChoice('fr'), TypeError);
  assert.equal(store.writes.length, 2, 'an invalid choice writes nothing');
});

test('a junk stored value, a missing store and a throwing store all read as auto', async () => {
  assert.equal(createI18n({ language: () => 'en', memento: memento({ [CHOICE_KEY]: 'klingon' }) }).choice(), 'auto');
  assert.equal(createI18n({ language: () => 'en', memento: { get() { throw new Error('boom'); } } }).choice(), 'auto');
  const bare = createI18n({ language: () => 'en' });
  assert.equal(bare.choice(), 'auto');
  await assert.rejects(bare.setChoice('en'), /language_unavailable/);
});

function controllerHarness({ set } = {}) {
  let handler, choice = 'auto';
  const posted = [];
  const panel = { title: '', reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} }),
    webview: { html: '', postMessage: async message => { posted.push(message); return true; }, onDidReceiveMessage: fn => { handler = fn; return { dispose() {} }; } } };
  const locale = { current: 'zh-CN' };
  const t = Object.assign((key, params) => require('../src/i18n/index.cjs').translator(locale.current)(key, params), {});
  Object.defineProperty(t, 'locale', { get: () => locale.current });
  const calls = [];
  const controller = createPanelController({ vscode: { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel } },
    context: { subscriptions: [] }, safeError: () => ({ message: 'x' }), t,
    manager: { state: () => ({ providers: [] }), dispatch: async () => { throw new Error('the language never reaches the config manager'); } },
    language: { choice: () => choice, set: set || (async next => { calls.push(next); choice = next; locale.current = next === 'en' ? 'en' : 'zh-CN'; controller.relocalize(); }) } });
  controller.open();
  return { controller, panel, posted, calls, send: message => handler(message), locale };
}

test('the panel applies a language choice without a reload and answers after the store write', async () => {
  const h = controllerHarness();
  assert.match(h.panel.webview.html, /<html lang="zh-CN">/);
  assert.equal(h.panel.title, 'Fusion BYOK 控制面板');
  assert.match(h.panel.webview.html, /<option value="auto" selected>自动<\/option>/);
  await h.send({ id: 'lang-1', type: 'setLanguage', payload: { choice: 'en' } });
  assert.deepEqual(h.calls, ['en']);
  assert.match(h.panel.webview.html, /<html lang="en">/, 'the open panel re-renders in the new language');
  assert.equal(h.panel.title, 'Fusion BYOK Control Panel');
  assert.match(h.panel.webview.html, /<option value="en" selected>English<\/option>/, 'the new page shows the stored choice');
  assert.match(h.panel.webview.html, /语言 \/ Language/, 'the option keeps its bilingual title in English');
  assert.deepEqual(h.posted.at(-1), { type: 'result', id: 'lang-1', ok: true });
});

test('an invalid or failing language choice is reported to the page that asked', async () => {
  const h = controllerHarness({ set: async () => { throw new Error('disk full'); } });
  await h.send({ id: 'bad', type: 'setLanguage', payload: { choice: 'fr' } });
  assert.deepEqual(h.posted.find(message => message.id === 'bad'), { type: 'result', id: 'bad', ok: false, error: '不支持的语言选项。' });
  await h.send({ id: 'fail', type: 'setLanguage', payload: { choice: 'en' } });
  const failed = h.posted.find(message => message.id === 'fail');
  assert.equal(failed.ok, false, 'a failed write is not reported as success');
  assert.match(h.panel.webview.html, /<html lang="zh-CN">/);
});

test('without a language service the panel refuses the option instead of pretending', async () => {
  let handler;
  const posted = [];
  const panel = { reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} }),
    webview: { html: '', postMessage: async message => { posted.push(message); return true; }, onDidReceiveMessage: fn => { handler = fn; return { dispose() {} }; } } };
  createPanelController({ vscode: { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel } },
    context: { subscriptions: [] }, safeError: () => ({ message: 'x' }),
    manager: { state: () => ({ providers: [] }), dispatch: async () => ({ providers: [] }) } }).open();
  await handler({ id: 'n', type: 'setLanguage', payload: { choice: 'en' } });
  assert.deepEqual(posted.find(message => message.id === 'n'), { type: 'result', id: 'n', ok: false, error: '当前环境无法保存语言设置。' });
});

test('the selector posts setLanguage and puts the previous value back when the host refuses', async () => {
  const nodes = new Map(), posts = [], listeners = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, value: id === 'language-select' ? 'auto' : '', listeners: {}, children: [], dataset: {}, classList: { add() {} },
      addEventListener(name, fn) { this.listeners[name] = fn; }, setAttribute() {}, append() {}, replaceChildren() {}, querySelectorAll: () => [] });
    return nodes.get(id);
  };
  const document = { getElementById: node, createTextNode: text => ({ textContent: text }), querySelectorAll: () => [],
    createElement: () => node('el-' + nodes.size), scrollingElement: { scrollTop: 0 }, hasFocus: () => true };
  const script = renderPanel({ nonce: 'n' }).match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, { acquireVsCodeApi: () => ({ getState: () => ({}), setState() {}, postMessage: message => posts.push(message) }),
    document, window: { addEventListener: (name, fn) => { if (name === 'message') listeners.push(fn); } }, setTimeout: () => 0, clearTimeout() {} });
  const select = node('language-select');
  select.value = 'en';
  select.listeners.change();
  const request = posts.find(message => message.type === 'setLanguage');
  assert.equal(JSON.stringify(request.payload), JSON.stringify({ choice: 'en' }));
  for (const listener of listeners) listener({ data: { type: 'result', id: request.id, ok: false, error: 'nope' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(select.value, 'auto', 'a refused change restores the selector');
});

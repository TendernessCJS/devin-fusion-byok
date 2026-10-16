'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fastContextMarkup, fastContextScript } = require('../src/panel/fast-context-view.cjs');

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.value = ''; this.textContent = '';
    this.className = ''; this.disabled = false; this.listeners = {}; }
  // The real select adopts the first appended option and drops its value when it
  // is rebuilt, so the stub models both: without that the selection assertions
  // would pass on state the browser never produces.
  append(...children) {
    for (const child of children) {
      this.children.push(child);
      if (this.tag === 'select' && this.children.length === 1) this.value = child.value;
    }
  }
  replaceChildren(...children) {
    this.children = children;
    if (this.tag === 'select') this.value = '';
  }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  set innerHTML(value) { throw new Error('the Fast Context view must not build DOM from host strings'); }
}

function harness() {
  const elements = new Map(), posts = [], listeners = [];
  const document = {
    getElementById: id => { if (!elements.has(id)) elements.set(id, new Element(id === 'fc-root' ? 'select' : id)); return elements.get(id); },
    createElement: tag => new Element(tag)
  };
  new Function('vscode', 'document', 'window', fastContextScript())(
    { postMessage: message => posts.push(message) }, document,
    { addEventListener: (name, listener) => { if (name === 'message') listeners.push(listener); } });
  return { byId: id => elements.get('fc-' + id), posts,
    receive: data => { for (const listener of listeners) listener(data); } };
}

const state = (overrides = {}) => ({ type: 'fast-context-state',
  state: { roots: [{ name: 'amer', path: '/w/amer' }, { name: 'ai', path: '/w/ai' }], node: '/usr/bin/node',
    server: '/ext/server.cjs', trusted: true, nodeFound: true, ...overrides } });

test('the Fast Context tab asks for the snapshot and renders roots, preview and buttons', () => {
  const { byId, posts, receive } = harness();
  assert.deepEqual(posts.map(message => message.type), ['fastContext.state'], 'the view asks on load');
  receive({ data: state() });
  const select = byId('root');
  assert.deepEqual(select.children.map(option => option.value), ['/w/amer', '/w/ai']);
  assert.equal(select.children[0].textContent, 'amer · /w/amer');
  assert.equal(byId('status').textContent, '', 'a trusted workspace with roots and Node warns about nothing');
  assert.equal(byId('copy-prompt').disabled, false);
  assert.equal(byId('copy-config').disabled, false);
  assert.deepEqual(JSON.parse(byId('preview').textContent), { mcpServers: { 'fusion-fast-context':
    { command: '/usr/bin/node', args: ['/ext/server.cjs', '--root', '/w/amer'] } } });
  select.value = '/w/ai';
  select.listeners.change();
  assert.match(byId('preview').textContent, /\/w\/ai/);
  assert.ok(!byId('preview').textContent.includes('/w/amer'), 'the preview follows the selection, not the first root');
});

test('an untrusted or empty workspace disables copying and names every reason', () => {
  const { byId, receive } = harness();
  receive({ data: state({ roots: [], trusted: false, nodeFound: false }) });
  assert.equal(byId('copy-prompt').disabled, true);
  assert.equal(byId('copy-config').disabled, true);
  const status = byId('status').textContent;
  for (const reason of ['工作区未信任', '没有可用的本地项目', 'Node.js']) assert.ok(status.includes(reason), reason);
  assert.equal(byId('preview').textContent, '请先打开或选择一个本地项目文件夹。');
});

test('a refresh keeps an available selection and otherwise falls back to the first root', () => {
  const { byId, receive } = harness();
  const roots = list => state({ roots: list });
  receive({ data: roots([{ name: 'a', path: '/a' }, { name: 'b', path: '/b' }]) });
  byId('root').value = '/b';
  receive({ data: roots([{ name: 'b', path: '/b' }, { name: 'c', path: '/c' }]) });
  assert.equal(byId('root').value, '/b');
  receive({ data: roots([{ name: 'c', path: '/c' }]) });
  assert.equal(byId('root').value, '/c', 'a root that disappeared is not fabricated back');
});

test('copy results land as text and only failures use the warning class', () => {
  const { byId, receive } = harness();
  receive({ data: state() });
  receive({ data: { type: 'fast-context-result', ok: true, text: '已复制提示词' } });
  assert.equal(byId('result').textContent, '已复制提示词');
  assert.equal(byId('result').className, 'hint');
  receive({ data: { type: 'fast-context-result', ok: false, text: '复制失败' } });
  assert.equal(byId('result').className, 'warn');
  byId('copy-config').listeners.click();
  byId('pick').listeners.click();
});

test('the view never builds DOM from host strings', () => {
  assert.doesNotMatch(fastContextScript(), /innerHTML/);
  assert.match(fastContextScript(), /textContent/);
  assert.match(fastContextMarkup(), /id="fc-preview"/);
  assert.doesNotThrow(() => new Function('vscode', 'document', 'window', fastContextScript()));
});

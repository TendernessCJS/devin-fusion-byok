'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { baseStyles } = require('../src/panel/theme.cjs');
const { renderPanel } = require('../src/panel/view.cjs');
const { goalHtml } = require('../src/panel/goal-view.cjs');
const { contextHtml } = require('../src/panel/context-view.cjs');

test('the shared base layer carries the control tokens and primitives', () => {
  const base = baseStyles();
  for (const rule of ['--control-h: 28px', '--radius-container: 6px', 'ul, ol { padding-left: 20px; }',
    '.code-block {', 'button.secondary', 'button.quiet', 'button.danger',
    'pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin: 0; }',
    '.mt { margin-top: 12px; }', '.mb { margin-bottom: 12px; }',
    '.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }']) {
    assert.ok(base.includes(rule), rule);
  }
});

test('the base layer contains no view-specific selectors', () => {
  const base = baseStyles();
  for (const selector of ['#update-proxy', '.monitor-', '.topbar', 'dialog']) {
    assert.ok(!base.includes(selector), selector);
  }
});

test('every webview embeds the shared base layer instead of its own page chrome', () => {
  const views = { panel: renderPanel({ nonce: 'safe', cspSource: 'test:' }), goal: goalHtml('nonce'), context: contextHtml('nonce') };
  for (const [name, html] of Object.entries(views)) {
    assert.ok(html.includes('--control-h: 28px'), name);
    assert.ok(html.includes('min-height: var(--control-h)'), name);
    assert.ok(!html.includes('padding:20px'), name + ' must not carry the old page padding');
  }
});

test('spacing utilities are defined once, in the base layer only', () => {
  const html = renderPanel({ nonce: 'safe', cspSource: 'test:' });
  const count = needle => html.split(needle).length - 1;
  assert.equal(count('.mt { margin-top: 12px; }'), 1, '.mt must be defined exactly once');
  assert.equal(count('.mb { margin-bottom: 12px; }'), 1, '.mb must be defined exactly once');
});

test('metric tile primitives are defined once, in the base layer only', () => {
  const html = renderPanel({ nonce: 'safe', cspSource: 'test:' });
  const count = needle => html.split(needle).length - 1;
  assert.equal(count('.tiles { display: grid;'), 1, '.tiles must be defined exactly once');
  assert.equal(count('.tile-value { display: block;'), 1, '.tile-value must be defined exactly once');
  assert.ok(baseStyles().includes('.tile-label {'), '.tile-label lives in the base layer');
});

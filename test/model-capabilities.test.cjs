'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { modelEfforts } = require('../src/models/capabilities.cjs');

test('reasoningEffort and the explicit controls decide efforts before any id guess', () => {
  const model = extra => ({ id: 'gpt-5.6', label: 'X', ...extra });
  // The discovery/explicit capability field wins over the id heuristic.
  assert.deepEqual(modelEfforts(model({ reasoningEffort: true })), [null, 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(modelEfforts(model({ reasoningEffort: false })), [null], 'an explicit non-reasoning verdict suppresses the gpt id guess');
  // The most explicit efforts list still wins over everything.
  assert.deepEqual(modelEfforts(model({ reasoningEffort: false, efforts: ['low', 'high'] })), ['low', 'high']);
  assert.deepEqual(modelEfforts(model({ reasoningEffort: true, effortMode: 'none' })), [null], 'effortMode none stays first');
  assert.deepEqual(modelEfforts(model({ effortMode: 'manual' })), [null]);
});

test('non-reasoning variants never gain efforts from a family-shaped id', () => {
  for (const id of ['gpt-5.6-mini', 'gpt-5-mini-nano', 'o3-chat', 'claude-opus-4-6-preview', 'gpt-5.6-instruct']) {
    assert.deepEqual(modelEfforts({ id }), [null], id + ' must not auto-effort');
  }
  // The base reasoning ids keep the heuristic.
  assert.deepEqual(modelEfforts({ id: 'gpt-5.6' }), [null, 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(modelEfforts({ id: 'o3' }), [null, 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(modelEfforts({ id: 'claude-opus-4-6' }), [null, 'low', 'medium', 'high', 'xhigh', 'max']);
});

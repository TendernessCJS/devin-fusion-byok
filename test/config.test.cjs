'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultConfig } = require('../src/config/config.cjs');

test('defaultConfig is a minimal enabled config without retired keys', () => {
  assert.deepEqual(defaultConfig(), { enabled: true, providers: [] });
  assert.ok(!Object.hasOwn(defaultConfig(), 'roleExclusions'));
  assert.ok(!Object.hasOwn(defaultConfig(), 'sidekicks'));
});

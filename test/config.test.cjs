'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultConfig, pruneRetiredKeys } = require('../src/config/config.cjs');

test('defaultConfig is a minimal enabled config without retired keys', () => {
  assert.deepEqual(defaultConfig(), { enabled: true, providers: [] });
  assert.ok(!Object.hasOwn(defaultConfig(), 'roleExclusions'));
  assert.ok(!Object.hasOwn(defaultConfig(), 'sidekicks'));
});

test('pruneRetiredKeys removes every retired key but keeps live role lists', () => {
  const config = { enabled: true, providers: [], sidekicks: [{ providerId: 'cpa', model: 'x' }],
    roleExclusions: { lead: [], sidekick: [] }, roleInclusions: { lead: [{ providerId: 'cpa', model: 'x' }] },
    fusionPresets: [{ id: 'p1' }], defaultFusionUid: 'fusion-dfbyok-x', fusionMatrix: true };
  assert.equal(pruneRetiredKeys(config), true);
  for (const key of ['sidekicks', 'fusionPresets', 'defaultFusionUid', 'fusionMatrix']) {
    assert.ok(!Object.hasOwn(config, key), key + ' is a retired key with no reader left');
  }
  assert.ok(!Object.hasOwn(config, 'roleExclusions'), 'empty role maps are pruned');
  assert.ok(Object.hasOwn(config, 'roleInclusions'), 'non-empty role lists survive');
  assert.equal(pruneRetiredKeys({ enabled: true, providers: [] }), false, 'a clean config is untouched');
  assert.equal(pruneRetiredKeys({ roleInclusions: 'garbage' }), true, 'non-map role values are pruned too');
  const { BACKEND_URL } = require('../src/runtime/port.cjs');
  const derived = { inferenceServerUrl: BACKEND_URL };
  assert.equal(pruneRetiredKeys(derived), true, 'a persisted copy of the derived url is redundant');
  assert.equal(Object.hasOwn(derived, 'inferenceServerUrl'), false);
  const override = { inferenceServerUrl: 'http://10.0.0.9:1234' };
  assert.equal(pruneRetiredKeys(override), false, 'a divergent value is a deliberate manual override');
  assert.equal(override.inferenceServerUrl, 'http://10.0.0.9:1234');
  assert.deepEqual(config.roleInclusions, { lead: [{ providerId: 'cpa', model: 'x' }] }, 'live refs are preserved verbatim');
});

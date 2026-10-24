'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkInjectionHealth } = require('../src/runtime/host/injection-health.cjs');

const healthy = {
  backendStatus: 'running',
  bridgeState: 'ready',
  envValue: 'http://127.0.0.1:39842',
  expectedEnv: 'http://127.0.0.1:39842',
  cliCache: { checked: 3, refreshed: [], skipped: [], errors: [],
    coverage: { dirState: 'ok', supported: 3, legacy: [], unsupported: [] } },
  desktopCatalog: 'ready',
  acpObserved: 2,
  acpOwnModels: 4,
};
const ids = result => result.items.map(item => item.id);
const stateOf = (result, id) => result.items.find(item => item.id === id)?.state;

test('every signal ok yields an all-ok verdict with the fixed item order', () => {
  const result = checkInjectionHealth(healthy);
  assert.equal(result.ok, true);
  assert.deepEqual(ids(result), ['backend', 'bridge', 'env', 'cache', 'catalog', 'acp']);
  assert.ok(result.items.every(item => item.state === 'ok'));
  assert.ok(result.items.every(item => typeof item.label === 'string' && typeof item.hint === 'string'));
});

test('each signal independently reports bad', () => {
  assert.equal(stateOf(checkInjectionHealth({ ...healthy, backendStatus: 'stopped' }), 'backend'), 'bad');
  assert.equal(stateOf(checkInjectionHealth({ ...healthy, backendStatus: 'backend_unreachable' }), 'backend'), 'bad');
  assert.equal(stateOf(checkInjectionHealth({ ...healthy, bridgeState: 'error' }), 'bridge'), 'bad');
  assert.equal(stateOf(checkInjectionHealth({ ...healthy, envValue: 'http://127.0.0.1:1' }), 'env'), 'bad');
  assert.equal(stateOf(checkInjectionHealth({ ...healthy, envValue: null }), 'env'), 'bad');
  assert.equal(stateOf(checkInjectionHealth({ ...healthy, cliCache: { errors: [{ name: 'x.bin', code: 'EACCES' }],
    coverage: { dirState: 'ok', supported: 1, legacy: [], unsupported: [] } } }), 'cache'), 'bad');
  assert.equal(stateOf(checkInjectionHealth({ ...healthy, cliCache: { checked: 1, refreshed: [], skipped: [], errors: [],
    coverage: { dirState: 'ok', supported: 2, legacy: [], unsupported: [{ name: 'model_configs_v9.abcd.bin', generation: 9 }] } } }),
    'cache'), 'bad', 'an unsupported cache generation is a real problem, not a clean bill');
  assert.equal(stateOf(checkInjectionHealth({ ...healthy, desktopCatalog: 'degraded' }), 'catalog'), 'bad');
  assert.equal(stateOf(checkInjectionHealth({ ...healthy, desktopCatalog: 'unsupported' }), 'catalog'), 'bad');
  assert.equal(stateOf(checkInjectionHealth({ ...healthy, acpOwnModels: 0 }), 'acp'), 'bad',
    'a session was observed but none of our models appear in it');
  for (const bad of [checkInjectionHealth({ ...healthy, backendStatus: 'stopped' }),
    checkInjectionHealth({ ...healthy, bridgeState: 'error' }), checkInjectionHealth({ ...healthy, envValue: null })]) {
    assert.equal(bad.ok, false, 'a bad item fails the overall verdict');
  }
});

test('unknown states keep the overall verdict ok', () => {
  const pending = checkInjectionHealth({
    backendStatus: 'starting', bridgeState: 'connecting', envValue: healthy.envValue,
    expectedEnv: healthy.expectedEnv, cliCache: null, acpObserved: 0,
  });
  assert.deepEqual(pending.items.map(item => item.state), ['unknown', 'unknown', 'ok', 'unknown', 'unknown', 'unknown']);
  assert.equal(pending.ok, true);
  assert.equal(stateOf(checkInjectionHealth({ ...healthy, backendStatus: undefined }), 'backend'), 'unknown');
  assert.equal(stateOf(checkInjectionHealth({ ...healthy, bridgeState: 'waiting' }), 'bridge'), 'unknown');
  assert.equal(stateOf(checkInjectionHealth({ ...healthy, bridgeState: undefined }), 'bridge'), 'unknown');
  for (const cliCache of [undefined, { checked: 2, refreshed: [], skipped: [], errors: [] },
    { checked: 0, refreshed: [], skipped: [], errors: [], coverage: { dirState: 'missing', supported: 0, legacy: [], unsupported: [] } },
    { checked: 0, refreshed: [], skipped: [], errors: [], coverage: { dirState: 'unreadable', supported: 0, legacy: [], unsupported: [] } }]) {
    assert.equal(stateOf(checkInjectionHealth({ ...healthy, cliCache }), 'cache'), 'unknown',
      'an unchecked cache or unreadable directory is unverified, not green: ' + JSON.stringify(cliCache));
  }
  assert.equal(stateOf(checkInjectionHealth({ ...healthy, cliCache: { checked: 0, refreshed: [], skipped: [], errors: [],
    coverage: { dirState: 'ok', supported: 1, legacy: [{ name: 'model_configs.bin', generation: 1 }], unsupported: [] } } }),
    'cache'), 'ok', 'historical leftover files are informational only');
  for (const desktopCatalog of [undefined, 'pending', 'waiting-auth']) {
    assert.equal(stateOf(checkInjectionHealth({ ...healthy, desktopCatalog }), 'catalog'), 'unknown',
      'an unconfirmed or logged-out catalog is unverified, not green: ' + desktopCatalog);
  }
});

test('a disabled plugin reports every signal unknown and still ok', () => {
  const result = checkInjectionHealth({ ...healthy, enabled: false, backendStatus: 'stopped', bridgeState: 'error', envValue: null });
  assert.equal(result.ok, true);
  assert.deepEqual(ids(result), ['backend', 'bridge', 'env', 'cache', 'catalog', 'acp']);
  assert.ok(result.items.every(item => item.state === 'unknown'));
});

test('the result carries no timestamp or otherwise unstable field', () => {
  const result = checkInjectionHealth(healthy);
  assert.deepEqual(Object.keys(result).sort(), ['items', 'ok']);
  for (const item of result.items) {
    assert.deepEqual(Object.keys(item).sort(), ['hint', 'id', 'label', 'state'],
      'panel state is deduplicated by JSON — any per-call field would re-render the panel every 3s');
  }
  assert.equal(JSON.stringify(checkInjectionHealth(healthy)), JSON.stringify(result),
    'identical inputs produce byte-identical output');
});

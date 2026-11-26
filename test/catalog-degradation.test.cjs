'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeCatalog, buildCatalog } = require('../src/catalog/build.cjs');

test('safeCatalog degrades a malformed config instead of losing the whole catalog', () => {
  const valid = {
    inferenceServerUrl: 'http://127.0.0.1:1', providers: [
      { id: 'p', name: 'P', models: [{ id: 'lead', label: 'Lead', efforts: ['low'] }] },
    ],
  };
  const calls = [];
  const catalog = safeCatalog(valid, [], null, null, reason => calls.push(reason));
  assert.ok(catalog.models.length > 0, 'a valid config passes through untouched');
  assert.deepEqual(calls, [], 'no degradation callback for a clean config');
  assert.doesNotThrow(() => buildCatalog(valid, [], null), 'sanity: this fixture is strict-valid');

  // Invalid effort values and a duplicate provider id are strict-write errors.
  const broken = {
    providers: [
      { id: 'p', name: 'P', models: [{ id: 'lead', label: 'Lead', efforts: ['low', 'INVALID EFFORT!'] }] },
      { id: 'p', name: 'P2', models: [{ id: 'other', label: 'Other' }] },
    ],
  };
  assert.throws(() => buildCatalog(broken, [], null), /Duplicate provider id|Invalid effort/);
  const degraded = safeCatalog(broken, [], null, null, reason => calls.push(reason));
  assert.equal(calls.at(-1), 'sanitized');
  assert.ok(degraded.models.length > 0, 'the sanitized retry still emits the surviving model');
  assert.ok(degraded.models.every(model => !model.uid.includes('other')), 'the duplicate provider is dropped');

  // A config broken beyond sanitizing yields the empty catalog shape, never a throw.
  // Force total failure with an object whose providers getter throws on every
  // read, including the spread inside the sanitizer itself.
  const evil = {};
  Object.defineProperty(evil, 'providers', { enumerable: true, get() { throw new Error('unreadable'); } });
  const empty = safeCatalog(evil, [], null, null, reason => calls.push(reason));
  assert.equal(calls.at(-1), 'empty');
  assert.deepEqual(empty.models, []);
  assert.ok(empty.matrixUids instanceof Set && empty.nativeHarnessUids instanceof Map);
  assert.deepEqual(empty.rolePool, { lead: [], sidekick: [] });
  assert.deepEqual(empty.sidekickOrderDrift, []);
});

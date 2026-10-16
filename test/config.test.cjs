'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultConfig, pruneRetiredKeys, discover } = require('../src/config.cjs');

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
  assert.deepEqual(config.roleInclusions, { lead: [{ providerId: 'cpa', model: 'x' }] }, 'live refs are preserved verbatim');
});

test('discover defaults freshly seen models to 131072 output tokens and keeps saved values', async t => {
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url: String(url), authorization: options.headers.Authorization });
    return { ok: true, json: async () => ({ data: [{ id: 'brand-new' }, { id: 'kept-model' }] }) };
  };
  const provider = { id: 'p', name: 'Provider', baseUrl: 'https://provider.invalid/v1/', apiKey: 'fixture-secret',
    models: [{ id: 'kept-model', label: 'Saved', efforts: [], contextWindow: 200000, maxOutputTokens: 32768 }] };
  assert.equal(await discover(provider, { request }), 2);
  assert.deepEqual(requests, [{ url: 'https://provider.invalid/v1/models', authorization: 'Bearer fixture-secret' }]);
  assert.deepEqual(provider.models.find(m => m.id === 'brand-new'),
    { id: 'brand-new', label: 'Provider · brand-new', efforts: [], contextWindow: 272000, maxOutputTokens: 131072 });
  assert.deepEqual(provider.models.find(m => m.id === 'kept-model'),
    { id: 'kept-model', label: 'Saved', efforts: [], contextWindow: 200000, maxOutputTokens: 32768 });
});

test('discover uses its own direct transport, never the ambient fetch or global agents', async t => {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-secret');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'local-model' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  t.mock.method(globalThis, 'fetch', () => { throw new Error('ambient fetch must not be used'); });
  t.mock.method(http.globalAgent, 'createConnection', () => { throw new Error('the global agent must not be used'); });
  const oldProxy = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  try {
    const provider = { name: 'Local', baseUrl: `http://127.0.0.1:${server.address().port}/v1/`, apiKey: 'fixture-secret', models: [] };
    assert.equal(await discover(provider), 1);
    assert.equal(provider.models[0].id, 'local-model');
  } finally {
    if (oldProxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = oldProxy;
  }
});

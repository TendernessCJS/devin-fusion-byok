'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { importLegacy, discover } = require('../src/config.cjs');

const legacyModel = () => ({ id: 'legacy-model', name: 'Legacy Model', effortLevels: ['high'] });

test('importLegacy assigns the 131072-token output default without reading the real home directory', t => {
  const home = path.join(os.tmpdir(), 'fusion-byok-import-legacy-fixture');
  const reads = [];
  t.mock.method(os, 'homedir', () => home);
  t.mock.method(fs, 'readFileSync', file => {
    reads.push(file);
    return JSON.stringify({ providers: [{ id: 'legacy', name: 'Legacy', baseUrl: 'https://legacy.invalid/v1/', apiKey: 'fixture-secret',
      type: 'openai', models: [legacyModel()] }] });
  });
  const imported = importLegacy();
  assert.deepEqual(reads, [path.join(home, '.cwindsurf/providers.json')]);
  assert.equal(imported.providers[0].models[0].maxOutputTokens, 131072);
  assert.equal(imported.providers[0].models[0].contextWindow, 272000);
  assert.ok(!JSON.stringify(imported.providers[0].models[0]).includes('fixture-secret'));
});

test('importLegacy falls back to an empty provider list when the legacy file is unreadable', t => {
  t.mock.method(os, 'homedir', () => path.join(os.tmpdir(), 'fusion-byok-missing-home'));
  t.mock.method(fs, 'readFileSync', () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
  assert.deepEqual(importLegacy().providers, []);
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

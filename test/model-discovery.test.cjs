'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { discover } = require('../src/models/discovery.cjs');
const { ModelDiscoveryError, discoveryNotice } = require('../src/models/discovery-error.cjs');
const { createManager } = require('../src/panel/manager.cjs');
const { createPanelController } = require('../src/panel/controller.cjs');
const { safeError } = require('../src/activation/errors.cjs');

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

test('discover accepts a gateway envelope wrapping the OpenAI model list', async () => {
  const request = async () => ({ ok: true, json: async () => ({ code: 0, message: 'OK',
    data: { object: 'list', data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-5.1' }] } }) });
  const provider = { id: 'p', name: 'Proxy', baseUrl: 'https://gateway.invalid/openai', apiKey: 'fixture-secret', models: [] };
  assert.equal(await discover(provider, { request }), 2);
  assert.deepEqual(provider.models.map(m => m.id), ['gpt-6.1-sol', 'gpt-5.1']);
  assert.equal(provider.models[0].label, 'Proxy · gpt-6.1-sol');
});

test('discover names the manual escape hatch only when /models is absent', async () => {
  const provider = { name: 'Gateway', baseUrl: 'https://gateway.invalid/openai', apiKey: 'fixture-secret', models: [] };
  const failure = status => discover(provider, { request: async () => ({ ok: false, status }) })
    .then(() => null, error => error.message);
  assert.match(await failure(404), /HTTP 404（该供应商可能未提供 \/models.*手动添加/);
  assert.match(await failure(405), /HTTP 405（该供应商可能未提供 \/models/);
  assert.equal(await failure(500), '获取模型失败：HTTP 500',
    'a status that says nothing about the route must not claim /models is missing');
});

function panelFixture(t, { request }) {
  let config = { enabled: true, providers: [{ id: 'cpa', name: 'CPA', baseUrl: 'https://cpa.invalid/v1',
    apiFormat: 'openai', apiKey: 'fixture-secret-cpa', enabled: true,
    models: [{ id: 'kept', label: 'CPA · kept', enabled: true, efforts: [], contextWindow: 200000, maxOutputTokens: 32768 }] }] };
  const writes = [];
  const manager = createManager({
    read: () => structuredClone(config),
    write: next => { config = structuredClone(next); writes.push(structuredClone(next)); },
    discover: provider => discover(provider, { request }),
  });
  const posts = [];
  const panel = {
    visible: true,
    webview: {
      html: '', cspSource: 'test:',
      postMessage: message => { posts.push(message); return true; },
      onDidReceiveMessage: handler => { panel.handler = handler; return { dispose() {} }; },
    },
    reveal() {}, dispose() { if (panel.disposed) return; panel.disposed = true; panel.disposeHandler?.(); },
    onDidDispose: handler => { panel.disposeHandler = handler; return { dispose() {} }; },
  };
  const subscriptions = [];
  const controller = createPanelController({
    vscode: { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel } },
    context: { subscriptions }, manager, safeError,
  });
  t.after(() => { subscriptions.forEach(value => value.dispose()); panel.dispose(); });
  controller.open();
  const refresh = () => panel.handler({ id: 'refresh-1', type: 'refreshModels', payload: { providerId: 'cpa' } });
  const result = () => posts.find(message => message.type === 'result' && message.id === 'refresh-1');
  return { manager, refresh, result, writes, posts };
}

for (const status of [404, 405]) {
  test(`HTTP ${status} keeps the manual-add notice through dispatch to the webview`, async t => {
    const f = panelFixture(t, { request: async () => ({ ok: false, status }) });
    await f.refresh();
    const result = f.result();
    assert.equal(result.ok, false);
    assert.match(result.error, new RegExp(`HTTP ${status}（该供应商可能未提供 /models.*手动添加`),
      'the webview must see the specialized notice, not the generic failure');
    assert.deepEqual(f.writes, [], 'a failed refresh never commits');
    assert.equal(f.manager.state().importCandidates, null, 'no importable model set survives the failure');
    assert.equal(f.manager.state().providers[0].models.length, 1, 'saved models are untouched');
  });
}

for (const status of [429, 500]) {
  test(`HTTP ${status} surfaces only the fixed status notice through dispatch`, async t => {
    const f = panelFixture(t, { request: async () => ({ ok: false, status }) });
    await f.refresh();
    const result = f.result();
    assert.equal(result.ok, false);
    assert.equal(result.error, `获取模型失败：HTTP ${status}`);
    assert.deepEqual(f.writes, [], 'a failed refresh never commits');
  });
}

for (const status of [99, 600, '404', undefined]) {
  test(`an implausible upstream status (${String(status)}) is redacted, never passed through`, async t => {
    const f = panelFixture(t, { request: async () => ({ ok: false, status }) });
    await f.refresh();
    const result = f.result();
    assert.equal(result.ok, false);
    assert.equal(result.error, '操作失败，请检查接口配置和连接状态。');
    assert.deepEqual(f.writes, [], 'a failed refresh never commits');
  });
}

test('safeError rebuilds notices from the typed status, never the error message or body', () => {
  const tampered = new ModelDiscoveryError(404);
  tampered.message = '获取模型失败：HTTP 404 secret-body-leak';
  tampered.body = '<html>secret-body-leak</html>';
  const safe = safeError(tampered);
  assert.equal(safe.code, 'provider_http_error');
  assert.match(safe.message, /手动添加/);
  assert.ok(!JSON.stringify(safe).includes('secret-body-leak'));
  const invalid = new ModelDiscoveryError(0);
  assert.equal(safeError(invalid).code, 'operation_failed');
  assert.equal(safeError({ message: '获取模型失败：HTTP 429' }).message, '获取模型失败：HTTP 429');
  assert.equal(safeError({ message: '获取模型失败：HTTP 429 secret-api-key' }).code, 'operation_failed');
});

test('discoveryNotice accepts only integer HTTP statuses in 100..599', () => {
  assert.equal(discoveryNotice(99), null);
  assert.equal(discoveryNotice(600), null);
  assert.equal(discoveryNotice('404'), null);
  assert.equal(discoveryNotice(404.5), null);
  assert.match(discoveryNotice(404), /手动添加/);
  assert.match(discoveryNotice(405), /手动添加/);
  assert.equal(discoveryNotice(418), '获取模型失败：HTTP 418');
});

test('discover infers reasoning support and window fields from /models metadata', async () => {
  const request = async () => ({ ok: true, json: async () => ({ data: [
    { id: 'reasoning-params', supported_parameters: ['temperature', 'reasoning'] },
    { id: 'no-reasoning-params', supported_parameters: ['temperature'] },
    { id: 'caps-reasoning', capabilities: { reasoning: true } },
    { id: 'caps-thinking-snake', capabilities: { reasoning_effort: false } },
    { id: 'direct-bool', supports_reasoning: true },
    { id: 'no-clues' },
    { id: 'empty-params', supported_parameters: [] },
    { id: 'windows', context_length: 128000, max_output_tokens: 8192 },
    { id: 'windows-alt', max_context_length: 64000, max_completion_tokens: 4096 },
    { id: 'windows-len', max_model_len: 32000 },
    { id: 'output-over-window', context_length: 4096, max_tokens: 999999 },
    { id: 'kept', supported_parameters: ['reasoning'], context_length: 999999 },
  ] }) });
  const provider = { id: 'p', name: 'Provider', baseUrl: 'https://provider.invalid/v1/', apiKey: 'fixture-secret',
    models: [{ id: 'kept', label: 'Saved', efforts: [], contextWindow: 200000, maxOutputTokens: 32768, reasoningEffort: false }] };
  const data = await Promise.resolve().then(() => {
    const models = ['reasoning-params', 'no-reasoning-params', 'caps-reasoning', 'caps-thinking-snake', 'direct-bool', 'no-clues', 'empty-params', 'windows', 'windows-alt', 'windows-len', 'output-over-window', 'kept'];
    return require('../src/models/discovery.cjs').discover(provider, { request }).then(() => Object.fromEntries(provider.models.map(m => [m.id, m])));
  });
  assert.equal(data['reasoning-params'].reasoningEffort, true, 'a reasoning entry in supported_parameters means support');
  assert.equal(data['no-reasoning-params'].reasoningEffort, false, 'a populated list without reasoning means no support');
  assert.equal(data['caps-reasoning'].reasoningEffort, true, 'capabilities.reasoning boolean is honored');
  assert.equal(data['caps-thinking-snake'].reasoningEffort, false, 'capabilities false boolean is honored too');
  assert.equal(data['direct-bool'].reasoningEffort, true);
  assert.equal('reasoningEffort' in data['no-clues'], false, 'no evidence leaves the key absent');
  assert.equal('reasoningEffort' in data['empty-params'], false, 'an empty parameter list is no evidence');
  assert.equal(data['windows'].contextWindow, 128000);
  assert.equal(data['windows'].maxOutputTokens, 8192);
  assert.equal(data['windows-alt'].contextWindow, 64000);
  assert.equal(data['windows-alt'].maxOutputTokens, 4096);
  assert.equal(data['windows-len'].contextWindow, 32000);
  assert.equal(data['output-over-window'].maxOutputTokens, 4096, 'output tokens are capped by the window');
  assert.equal(data['kept'].reasoningEffort, false, 'saved entries are never rewritten by discovery');
  assert.equal(data['kept'].contextWindow, 200000);
});

test('url mode drives the request URL and dual-sends credential headers', async () => {
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url: String(url), headers: { ...options.headers } });
    return { ok: true, json: async () => ({ data: [{ id: 'm' }] }) };
  };
  const provider = { id: 'p', name: 'P', baseUrl: 'https://api.moonshot.cn/anthropic/v1', apiFormat: 'anthropic',
    apiKey: 'fixture-secret', modelsMode: 'url', modelsUrl: 'https://api.moonshot.cn/v1/models', models: [] };
  await discover(provider, { request });
  assert.equal(requests[0].url, 'https://api.moonshot.cn/v1/models',
    'the override is requested verbatim, without the derived page-size parameter');
  assert.equal(requests[0].headers.Authorization, 'Bearer fixture-secret', 'the bearer header rides along');
  assert.equal(requests[0].headers['x-api-key'], 'fixture-secret', 'the anthropic header rides along');
  assert.equal(requests[0].headers['anthropic-version'], '2023-06-01', 'the format header stays');
});

test('a legacy config with modelsUrl but no mode still reads as url mode', async () => {
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url: String(url), headers: { ...options.headers } });
    return { ok: true, json: async () => ({ data: [{ id: 'm' }] }) };
  };
  const provider = { id: 'p', name: 'P', baseUrl: 'https://x.invalid/v1', apiFormat: 'openai',
    apiKey: 'fixture-secret', modelsUrl: 'https://models.invalid/v1/models', models: [] };
  await discover(provider, { request });
  assert.equal(requests[0].url, 'https://models.invalid/v1/models', 'the stored override still drives the endpoint');
  assert.equal(requests[0].headers['x-api-key'], 'fixture-secret', 'legacy overrides keep the dual headers');
});

test('auto mode keeps the request URL and headers exactly as before', async () => {
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url: String(url), headers: { ...options.headers } });
    return { ok: true, json: async () => ({ data: [] }) };
  };
  const anthropic = { id: 'p', name: 'P', baseUrl: 'https://a.invalid/v1', apiFormat: 'anthropic', apiKey: 'fixture-secret', modelsMode: 'auto', models: [] };
  await discover(anthropic, { request });
  assert.deepEqual(requests.at(-1).headers, { 'anthropic-version': '2023-06-01', 'x-api-key': 'fixture-secret' },
    'anthropic discovery never grows a bearer header');
  assert.equal(requests.at(-1).url, 'https://a.invalid/v1/models?limit=1000');
  const openai = { id: 'p', name: 'P', baseUrl: 'https://o.invalid/v1', apiFormat: 'openai', apiKey: 'fixture-secret', models: [] };
  await discover(openai, { request });
  assert.deepEqual(requests.at(-1).headers, { Authorization: 'Bearer fixture-secret' },
    'openai discovery never grows an x-api-key header');
  assert.equal(requests.at(-1).url, 'https://o.invalid/v1/models');
});

test('an anthropic override paginates with after_id only, never with limit', async () => {
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url: String(url), headers: { ...options.headers } });
    const page = requests.length === 1
      ? { data: [{ id: 'm1' }], has_more: true, last_id: 'L1' }
      : { data: [{ id: 'm2' }], has_more: false };
    return { ok: true, json: async () => page };
  };
  const provider = { id: 'p', name: 'P', baseUrl: 'https://api.moonshot.cn/anthropic/v1', apiFormat: 'anthropic',
    apiKey: 'fixture-secret', modelsMode: 'url', modelsUrl: 'https://api.moonshot.cn/v1/models', models: [] };
  await discover(provider, { request });
  assert.equal(requests[0].url, 'https://api.moonshot.cn/v1/models', 'the first page hits the address verbatim');
  assert.equal(requests[1].url, 'https://api.moonshot.cn/v1/models?after_id=L1',
    'a declared further page adds after_id but never the page-size parameter');
  assert.equal(requests[1].headers['x-api-key'], 'fixture-secret', 'later pages keep the credential headers');
  assert.equal(requests[1].headers.Authorization, 'Bearer fixture-secret');
  assert.deepEqual(provider.models.map(m => m.id), ['m1', 'm2'], 'both pages are collected');
});

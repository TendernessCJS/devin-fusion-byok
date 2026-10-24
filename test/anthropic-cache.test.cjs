'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { parseChat } = require('../src/protocol/native-chat-codec.cjs');
const { serveChat, buildRequestBody } = require('../src/protocol/inference.cjs');
const { stripCacheControl } = require('../src/protocol/anthropic.cjs');
const { createCacheSupport } = require('../src/protocol/cache-support.cjs');

const anthropicRoute = { model: 'claude-opus-5-5', uid: 'local-claude' };
const anthropicProvider = { id: 'anthropic-test', baseUrl: 'https://api.anthropic.test', apiFormat: 'anthropic' };
const anthropicBody = (request, options) =>
  buildRequestBody(request, anthropicRoute, { ...anthropicProvider, apiKey: 'k' }, () => {}, options);
const request = prompts => parseChat({ promptCacheKey: 'key-1', chatMessagePrompts: prompts });

const marked = body => JSON.stringify(body).includes('"cache_control"');
const marks = body => body.messages.flatMap(message => message.content).filter(block => block.cache_control);

async function server(handler, t) {
  const instance = http.createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return `http://127.0.0.1:${instance.address().port}`;
}

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const success = [
  sse('message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
  sse('content_block_start', { index: 0, content_block: { type: 'text', text: 'ok' } }),
  sse('content_block_stop', { index: 0 }),
  sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
  sse('message_stop', {}),
];

const chatRequest = () => parseChat({
  promptCacheKey: 'key-1',
  chatMessagePrompts: [{ source: 1, prompt: 'one' }, { source: 2, prompt: 'two' }, { source: 1, prompt: 'three' }],
});

async function run(t, respond, cacheSupport) {
  const requests = [], logs = [];
  let result;
  const upstream = await server(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    respond(requests.length, res);
  }, t);
  const proxy = await server((req, res) => {
    serveChat({ request: chatRequest(), route: anthropicRoute, res,
      provider: { ...anthropicProvider, baseUrl: `${upstream}/v1`, apiKey: 'k' },
      log: event => logs.push(event), cacheSupport }).then(value => { result = value; });
  }, t);
  const response = await fetch(proxy);
  await response.arrayBuffer();
  return { requests, logs, result };
}

test('breakpoint lands on the last cacheable block of the penultimate message only', () => {
  const body = anthropicBody(chatRequest(), { cacheBreakpoints: true });
  assert.equal(body.messages.length, 3);
  assert.deepEqual(body.messages.at(-2).content.at(-1).cache_control, { type: 'ephemeral' });
  assert.equal(marks(body).length, 1);
  for (const block of body.messages.at(-1).content) assert.equal('cache_control' in block, false);
});

test('breakpoint stays off the last message when it carries an image', () => {
  const body = anthropicBody(request([
    { source: 1, prompt: 'one' }, { source: 2, prompt: 'two' },
    { source: 1, prompt: '', images: [{ base64: 'aGk=', mimeType: 'image/png' }] }]), { cacheBreakpoints: true });
  assert.deepEqual(body.messages.at(-2).content.at(-1).cache_control, { type: 'ephemeral' });
  for (const block of body.messages.at(-1).content) assert.equal('cache_control' in block, false);
});

test('no prompt cache key produces no breakpoint', () => {
  const body = anthropicBody(parseChat({ chatMessagePrompts: [{ source: 1, prompt: 'one' }, { source: 2, prompt: 'two' }] }),
    { cacheBreakpoints: true });
  assert.equal(marked(body), false);
});

test('disabled breakpoints produce no cache_control despite a cache key', () => {
  const body = anthropicBody(chatRequest(), { cacheBreakpoints: false });
  assert.equal(marked(body), false);
  assert.equal(marked(anthropicBody(chatRequest())), false, 'default options stay unmarked');
});

test('a single merged message never carries a breakpoint', () => {
  const body = anthropicBody(request([{ source: 1, prompt: 'only turn' }]), { cacheBreakpoints: true });
  assert.equal(body.messages.length, 1);
  assert.equal(marked(body), false);
});

test('adjacent tool results merge and the breakpoint lands on the last tool_result', () => {
  const body = anthropicBody(request([
    { source: 1, prompt: 'run it' },
    { source: 2, prompt: '', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] },
    { source: 4, prompt: 'first', toolCallId: 'c1' },
    { source: 4, prompt: 'second', toolCallId: 'c1' },
    { source: 2, prompt: 'done' }]), { cacheBreakpoints: true });
  assert.equal(body.messages.length, 4);
  const merged = body.messages.at(-2);
  assert.deepEqual(merged.content.map(block => block.type), ['tool_result', 'tool_result']);
  assert.deepEqual(merged.content.at(-1).cache_control, { type: 'ephemeral' });
  assert.equal('cache_control' in merged.content[0], false);
});

test('a 400 on a marked request retries stripped, disables the provider and succeeds', async t => {
  const disabled = [];
  const cacheSupport = { enabledFor: () => true, disable: provider => disabled.push(provider) };
  const { requests, logs, result } = await run(t, (attempt, res) => {
    if (attempt === 1) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'cache_control is not supported' } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(success.join(''));
  }, cacheSupport);
  assert.equal(requests.length, 2);
  assert.equal(JSON.stringify(requests[0]).includes('"cache_control"'), true);
  assert.equal(JSON.stringify(requests[1]).includes('"cache_control"'), false);
  assert.equal(disabled.length, 1);
  assert.equal(logs.some(entry => entry.event === 'cache-breakpoint-disabled' && entry.reason === '400'), true);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 200);
});

test('a marked 400 whose stripped retry still fails is not disabled and reports upstream_http', async t => {
  const disabled = [];
  const cacheSupport = { enabledFor: () => true, disable: provider => disabled.push(provider) };
  const { requests, result } = await run(t, (attempt, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'still bad' } }));
  }, cacheSupport);
  assert.equal(requests.length, 2);
  assert.equal(JSON.stringify(requests[1]).includes('"cache_control"'), false);
  assert.equal(disabled.length, 0);
  assert.equal(result.code, 'upstream_http');
});

test('a 400 without breakpoints is neither retried nor recorded', async t => {
  const disabled = [];
  const { requests, result } = await run(t, (attempt, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'context length exceeded' } }));
  }, { enabledFor: () => false, disable: provider => disabled.push(provider) });
  assert.equal(requests.length, 1);
  assert.equal(disabled.length, 0);
  assert.equal(result.code, 'upstream_http');
});

test('disabled providers persist by hash without apiKey or baseUrl in the file', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-support-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const support = createCacheSupport({ root });
  const provider = { id: 'p1', baseUrl: 'https://secret-host.example.com', apiKey: 'sk-live-plaintext' };
  support.disable(provider);
  assert.equal(support.enabledFor(provider), false);
  const text = fs.readFileSync(path.join(root, 'provider-cache.json'), 'utf8');
  const state = JSON.parse(text);
  assert.equal(state.version, 1);
  const keys = Object.keys(state.unsupported);
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^[0-9a-f]{64}$/);
  assert.equal(typeof state.unsupported[keys[0]].at, 'number');
  assert.ok(!text.includes('sk-live-plaintext'));
  assert.ok(!text.includes('secret-host.example.com'));
});

test('a missing or corrupt state file reads as fully enabled', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-support-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const provider = { id: 'p1', baseUrl: 'https://example.com' };
  assert.equal(createCacheSupport({ root }).enabledFor(provider), true);
  fs.writeFileSync(path.join(root, 'provider-cache.json'), 'not json at all');
  assert.equal(createCacheSupport({ root }).enabledFor(provider), true);
  fs.writeFileSync(path.join(root, 'provider-cache.json'), '{"version":2,"unsupported":{}}');
  assert.equal(createCacheSupport({ root }).enabledFor(provider), true);
});

test('chat and responses bodies never carry cache_control even with breakpoints enabled', () => {
  const source = chatRequest();
  for (const apiFormat of ['chat', 'responses']) {
    const body = buildRequestBody(source, { model: 'gpt-5' }, { apiFormat, baseUrl: 'https://o.test' }, () => {}, { cacheBreakpoints: true });
    assert.equal(JSON.stringify(body).includes('"cache_control"'), false, apiFormat);
    assert.equal(body.prompt_cache_key, 'key-1', apiFormat);
  }
});

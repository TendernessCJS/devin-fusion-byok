'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { providerHeaders } = require('../src/protocol/provider-request.cjs');
const { serveChat } = require('../src/protocol/inference.cjs');
const { version } = require('../package.json');

const sessionOf = key => createHash('sha256').update(key).digest('hex').slice(0, 32);
const opencode = new URL('https://opencode.ai/zen/go/v1/chat/completions');

test('OpenCode hosts get a stable hashed session id and a named user agent', () => {
  const request = { promptCacheKey: 'cascade-123', messages: [{ messageId: 'm1' }] };
  const headers = providerHeaders(opencode, request);
  assert.equal(headers['user-agent'], `devin-fusion-byok/${version}`);
  assert.equal(headers['x-opencode-session'], sessionOf('cache:cascade-123'));
  assert.match(headers['x-opencode-session'], /^[0-9a-f]{32}$/);
  assert.ok(!headers['x-opencode-session'].includes('cascade-123'), 'the raw native key is not sent');
  assert.deepEqual(providerHeaders(opencode, { promptCacheKey: 'cascade-123', messages: [{ messageId: 'other' }] }), headers,
    'later turns of the same conversation reuse the session id');
  assert.notEqual(providerHeaders(opencode, { promptCacheKey: 'cascade-456' })['x-opencode-session'], headers['x-opencode-session']);
  assert.deepEqual(providerHeaders(new URL('https://api.opencode.ai/v1/messages'), request), headers, 'subdomains count');
});

test('without a prompt cache key the first message id identifies the conversation', () => {
  const headers = providerHeaders(opencode, { promptCacheKey: '', messages: [{ messageId: '' }, { messageId: 'first' }, { messageId: 'second' }] });
  assert.equal(headers['x-opencode-session'], sessionOf('message:first'));
  assert.deepEqual(providerHeaders(opencode, { messages: [] }), { 'user-agent': `devin-fusion-byok/${version}` },
    'no conversation identity means no invented session id');
});

test('other hosts, including look-alikes, get no extra headers', () => {
  const request = { promptCacheKey: 'cascade-123' };
  for (const url of ['https://api.openai.com/v1/responses', 'https://notopencode.ai/v1/chat/completions',
    'https://opencode.ai.example.com/v1/chat/completions', 'http://127.0.0.1:8080/v1/messages']) {
    assert.deepEqual(providerHeaders(new URL(url), request), {}, url);
  }
});

test('serveChat sends the OpenCode headers alongside the API key', async t => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers });
    return new Response(JSON.stringify({ error: { message: 'stop here' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });
  const proxy = http.createServer((req, res) => {
    serveChat({
      request: { modelUid: 'byok-go', systemPrompt: '', promptCacheKey: 'cascade-789', messages: [{ role: 'user', source: 1, messageId: 'm1', content: 'hi', toolCalls: [], images: [], videos: [], documents: [] }], tools: [] },
      route: { model: 'glm-5.3', uid: 'byok-go' },
      provider: { baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'fake-key', apiFormat: 'chat' },
      res, timeouts: { retryPauseMs: 0 },
    });
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  const response = await original(`http://127.0.0.1:${proxy.address().port}/`);
  await response.arrayBuffer();
  assert.ok(seen.length >= 1);
  for (const call of seen) {
    assert.equal(call.url, 'https://opencode.ai/zen/go/v1/chat/completions');
    assert.equal(call.headers.authorization, 'Bearer fake-key');
    assert.equal(call.headers['x-opencode-session'], sessionOf('cache:cascade-789'));
    assert.equal(call.headers['user-agent'], `devin-fusion-byok/${version}`);
  }
});

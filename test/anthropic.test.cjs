'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { s, v, m, str, num, fields } = require('../src/protocol/wire.cjs');
const { parseChat } = require('../src/protocol/native-chat-codec.cjs');
const { serveChat, buildRequestBody } = require('../src/protocol/inference.cjs');
const { createAnthropicAdapter } = require('../src/protocol/anthropic.cjs');
const { modelEfforts } = require('../src/models/capabilities.cjs');

const nativeMessage = (source, text, extra = []) => m(3, Buffer.concat([v(2, source), s(3, text), ...extra]));
function nativeRequest() {
  return Buffer.concat([
    s(2, 'System prompt'), s(21, 'local-claude'), v(6, 9901),
    nativeMessage(1, 'User message', [m(10, Buffer.concat([s(1, 'aGVsbG8='), s(2, 'image/png'), s(3, 'Image caption')]))]),
    nativeMessage(2, 'Assistant before tool', [m(6, Buffer.concat([s(1, 'call_a'), s(2, 'shell_command'), s(3, '{"cmd":"ls"}')])),
      m(6, Buffer.concat([s(1, 'call_b'), s(2, 'shell_command'), s(3, '{"cmd":"pwd"}')]))]),
    nativeMessage(4, 'first result', [s(7, 'call_a')]),
    nativeMessage(4, 'second result', [s(7, 'call_b'), v(9, 1)]),
    nativeMessage(5, 'System message in the middle'),
    nativeMessage(1, 'User after tool'),
    m(10, Buffer.concat([s(1, 'shell_command'), s(2, 'Run a command'), s(3, '{"type":"object","properties":{"cmd":{"type":"string"}}}')])),
    m(12, Buffer.concat([s(1, 'tool'), s(2, 'shell_command')])),
  ]);
}

function unpack(buffer) {
  const messages = [];
  for (let offset = 0; offset < buffer.length;) {
    const flags = buffer[offset], length = buffer.readUInt32BE(offset + 1);
    if (!(flags & 2)) messages.push(buffer.subarray(offset + 5, offset + 5 + length));
    offset += 5 + length;
  }
  return messages;
}

async function server(handler, t) {
  const instance = http.createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return `http://127.0.0.1:${instance.address().port}`;
}

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

async function run(t, events, route = { model: 'claude-opus-5-5', uid: 'local-claude', effort: 'high' }) {
  const requests = [], metrics = [];
  const upstream = await server(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) res.write(event);
    res.end();
  }, t);
  const proxy = await server((req, res) => {
    serveChat({ request: parseChat(nativeRequest()), route, provider: { baseUrl: `${upstream}/v1`, apiKey: 'fake-anthropic-key', apiFormat: 'anthropic' }, res, onMetrics: value => metrics.push(value) });
  }, t);
  const response = await fetch(proxy);
  return { messages: unpack(Buffer.from(await response.arrayBuffer())), requests, metrics };
}

test('Anthropic request body maps system, images, tool calls, merged tool results and tool choice', () => {
  const body = buildRequestBody(parseChat(nativeRequest()), { model: 'claude-opus-5-5', effort: 'xhigh', maxOutputTokens: 131072 }, { apiFormat: 'anthropic' });
  assert.equal(body.system, 'System prompt');
  assert.equal(body.max_tokens, 128000);
  assert.deepEqual(body.output_config, { effort: 'xhigh' });
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages.map(message => message.role), ['user', 'assistant', 'user']);
  assert.deepEqual(body.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } });
  assert.deepEqual(body.messages[1].content.slice(1), [
    { type: 'tool_use', id: 'call_a', name: 'shell_command', input: { cmd: 'ls' } },
    { type: 'tool_use', id: 'call_b', name: 'shell_command', input: { cmd: 'pwd' } }]);
  const next = body.messages[2].content;
  assert.deepEqual(next.slice(0, 2), [
    { type: 'tool_result', tool_use_id: 'call_a', content: 'first result' },
    { type: 'tool_result', tool_use_id: 'call_b', content: 'second result', is_error: true }]);
  assert.deepEqual(next.slice(2).map(block => block.text), ['System message in the middle', 'User after tool']);
  assert.deepEqual(body.tools, [{ name: 'shell_command', description: 'Run a command', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } }]);
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'shell_command' });
  assert.equal(body.temperature, undefined);
});

test('Anthropic tool_choice follows the official SDK semantics', () => {
  const tool = m(10, Buffer.concat([s(1, 'shell_command'), s(2, 'Run'), s(3, '{}')]));
  const bodyWith = extra => buildRequestBody(parseChat(Buffer.concat([
    s(21, 'local-claude'), nativeMessage(1, 'hi'), tool, ...(extra ? [extra] : []),
  ])), { model: 'claude-opus-5-5' }, { apiFormat: 'anthropic' });
  for (const type of ['auto', 'any', 'none'])
    assert.deepEqual(bodyWith(m(12, s(1, type))).tool_choice, { type }, type);
  assert.deepEqual(bodyWith(m(12, Buffer.concat([s(1, 'tool'), s(2, 'shell_command')]))).tool_choice,
    { type: 'tool', name: 'shell_command' });
  assert.equal(bodyWith(null).tool_choice, undefined, 'no choice omits tool_choice');
});

test('Anthropic strict tools and disable_parallel_tool_use reach the wire body only when set', () => {
  const tool = m(10, Buffer.concat([s(1, 'shell_command'), s(2, 'Run'), s(3, '{}'), v(12, 1)]));
  const requestWith = choice => parseChat(Buffer.concat([
    s(21, 'local-claude'), nativeMessage(1, 'hi'), tool, v(11, 1), ...(choice ? [choice] : []),
  ]));
  const body = extra => buildRequestBody(extra, { model: 'claude-opus-5-5' }, { apiFormat: 'anthropic' });
  assert.equal(body(requestWith(null)).tools[0].strict, true, 'strict tool passes through');
  assert.deepEqual(body(requestWith(null)).tool_choice, { type: 'auto', disable_parallel_tool_use: true }, 'omitted choice gains the flag');
  assert.deepEqual(body(requestWith(m(12, Buffer.concat([s(1, 'tool'), s(2, 'shell_command')])))).tool_choice,
    { type: 'tool', name: 'shell_command', disable_parallel_tool_use: true });
  assert.deepEqual(body(requestWith(m(12, s(1, 'none')))).tool_choice, { type: 'none' }, 'none stays clean');
  const plain = body(parseChat(Buffer.concat([
    s(21, 'local-claude'), nativeMessage(1, 'hi'),
    m(10, Buffer.concat([s(1, 'shell_command'), s(2, 'Run'), s(3, '{}')])),
  ])));
  assert.equal('strict' in plain.tools[0], false, 'defaults add no vendor fields');
  assert.equal(plain.tool_choice, undefined);
});

test('Anthropic forced tool_choice retries with thinking disabled before degrading to auto', async t => {
  const tool = m(10, Buffer.concat([s(1, 'shell_command'), s(2, 'Run'), s(3, '{}')]));
  const requestWith = choice => Buffer.concat([s(21, 'local-claude'), nativeMessage(1, 'hi'), tool, ...(choice ? [choice] : [])]);
  const success = [
    sse('message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: 'ok' } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
    sse('message_stop', {}),
  ];
  async function runBoundary(request, failWith, failCount = 0) {
    const requests = [], metrics = [];
    const upstream = await server(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks)));
      if (requests.length > failCount) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(success.join('')); return; }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: failWith } }));
    }, t);
    const proxy = await server((req, res) => {
      serveChat({ request: parseChat(request), route: { model: 'claude-opus-5-5', uid: 'local-claude' }, provider: { baseUrl: `${upstream}/v1`, apiKey: 'k', apiFormat: 'anthropic' }, res, onMetrics: value => metrics.push(value) });
    }, t);
    const messages = unpack(Buffer.from(await (await fetch(proxy)).arrayBuffer()));
    return { requests, metrics, messages };
  }

  const refusal = 'tool_choice is not supported by this endpoint';
  const forced = await runBoundary(requestWith(m(12, Buffer.concat([s(1, 'tool'), s(2, 'shell_command')]))), refusal, 1);
  assert.equal(forced.requests.length, 2, 'forced choice retries once after the refusal');
  assert.deepEqual(forced.requests[1].thinking, { type: 'disabled' }, 'the first retry turns thinking off');
  assert.deepEqual(forced.requests[1].tool_choice, { type: 'tool', name: 'shell_command' }, 'the forced choice survives that retry');
  assert.equal(forced.messages.map(message => str(message, 3)).join(''), 'ok');
  assert.equal(forced.metrics[0].status, 'success');

  const twice = await runBoundary(requestWith(m(12, Buffer.concat([s(1, 'tool'), s(2, 'shell_command')]))), refusal, 2);
  assert.equal(twice.requests.length, 3, 'a second refusal falls through to the auto degrade');
  assert.deepEqual(twice.requests[2].tool_choice, { type: 'auto' });
  assert.equal('thinking' in twice.requests[2], false, 'the injected thinking flag does not leak into the degrade');

  for (const type of ['auto', 'none']) {
    const passive = await runBoundary(requestWith(m(12, s(1, type))), refusal, 1);
    assert.equal(passive.requests.length, 1, `${type} is not forced and never retries`);
    assert.equal(passive.metrics[0].code, 'upstream_http');
  }

  const other = await runBoundary(requestWith(m(12, Buffer.concat([s(1, 'tool'), s(2, 'shell_command')]))), 'context length exceeded', 1);
  assert.equal(other.requests.length, 1, 'a 400 unrelated to tool_choice never retries');
  assert.equal(other.metrics[0].code, 'upstream_http');

  const serialized = await runBoundary(Buffer.concat([
    s(21, 'local-claude'), nativeMessage(1, 'hi'),
    m(10, Buffer.concat([s(1, 'shell_command'), s(2, 'Run'), s(3, '{}')])),
    m(12, Buffer.concat([s(1, 'tool'), s(2, 'shell_command')])), v(11, 1),
  ]), refusal, 2);
  assert.equal(serialized.requests.length, 3);
  assert.deepEqual(serialized.requests[2].tool_choice, { type: 'auto', disable_parallel_tool_use: true },
    'the degrade-to-auto retry preserves disable_parallel_tool_use');
});

test('pause_turn is preserved as the raw finish reason without fabricating pause semantics', () => {
  const adapter = createAnthropicAdapter();
  const out = adapter({ type: 'message_delta', data: { delta: { stop_reason: 'pause_turn' } } });
  const chunk = out.find(entry => entry.data?.choices?.[0]?.finish_reason);
  assert.equal(chunk.data.choices[0].finish_reason, 'pause_turn');
  assert.equal(chunk.data.choices[0].delta?.content, undefined, 'no fabricated pause text');
});

test('Anthropic pause_turn ends as stop 2 and is attributed through provider-stop', async t => {
  const pause = [
    sse('message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: 'partial' } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 2 } }),
    sse('message_stop', {}),
  ];
  const logs = [];
  async function runPause(events) {
    const upstream = await server((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.join('')); }, t);
    const proxy = await server((req, res) => {
      serveChat({ request: parseChat(nativeRequest()), route: { model: 'claude-opus-5-5', uid: 'local-claude' },
        provider: { baseUrl: `${upstream}/v1`, apiKey: 'k', apiFormat: 'anthropic' }, res,
        log: event => logs.push(event) });
    }, t);
    const response = await fetch(proxy);
    return { status: response.status, messages: unpack(Buffer.from(await response.arrayBuffer())) };
  }
  const paused = await runPause(pause);
  assert.equal(paused.status, 200);
  assert.equal(num(paused.messages.at(-1), 5), 2, 'ACP stop reason stays 2 — pause is not fabricated');
  const entry = logs.find(event => event.event === 'provider-stop');
  assert.ok(entry, 'provider-stop is recorded');
  assert.equal(entry.reason, 'pause_turn');
  assert.equal(entry.model, 'claude-opus-5-5');

  logs.length = 0;
  const normal = await runPause(pause.map(line => line.replace('"pause_turn"', '"end_turn"')));
  assert.equal(normal.status, 200);
  assert.equal(num(normal.messages.at(-1), 5), 2);
  assert.equal(logs.find(event => event.event === 'provider-stop'), undefined, 'ordinary end_turn produces no noise');
});

test('Anthropic stream relays text, thinking and usage with x-api-key auth', async t => {
  const result = await run(t, [
    sse('message_start', { message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 1 } } }),
    sse('ping', {}),
    sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Considering' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
    sse('content_block_stop', { index: 0 }),
    sse('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Hello ' } }),
    sse('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'world' } }),
    sse('content_block_stop', { index: 1 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
    sse('message_stop', {}),
  ]);
  const request = result.requests[0];
  assert.equal(request.url, '/v1/messages');
  assert.equal(request.headers['x-api-key'], 'fake-anthropic-key');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.headers.authorization, undefined);
  assert.equal(result.messages.map(message => str(message, 3)).join(''), 'Hello world');
  assert.equal(result.metrics[0].status, 'success');
  assert.equal(result.metrics[0].inputTokens, 100);
  assert.equal(result.metrics[0].cachedTokens, 90);
  assert.equal(result.metrics[0].outputTokens, 7);
  assert.equal(result.metrics[0].hasReasoning, true);
});

test('Anthropic thinking signature and redacted marker reach the native stream', async t => {
  const result = await run(t, [
    sse('message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Considering' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-xyz' } }),
    sse('content_block_stop', { index: 0 }),
    sse('content_block_start', { index: 1, content_block: { type: 'redacted_thinking' } }),
    sse('content_block_stop', { index: 1 }),
    sse('content_block_start', { index: 2, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 2, delta: { type: 'text_delta', text: 'Answer' } }),
    sse('content_block_stop', { index: 2 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
    sse('message_stop', {}),
  ]);
  assert.equal(result.messages.map(message => str(message, 3)).join(''), 'Answer');
  assert.ok(result.messages.some(message => str(message, 10) === 'sig-xyz'), 'signature reaches field 10');
  assert.ok(result.messages.some(message => num(message, 11) === 1), 'redacted marker reaches field 11');
  assert.equal(result.metrics[0].status, 'success');
});

test('Anthropic replays the thinking block only when its signature is present', () => {
  const signed = buildRequestBody(parseChat(Buffer.concat([
    s(21, 'local-claude'), nativeMessage(2, 'ANSWER', [s(11, 'TH-1'), s(12, 'SIG-1')]), nativeMessage(1, 'next'),
  ])), { model: 'claude-opus-5-5' }, { apiFormat: 'anthropic' });
  assert.deepEqual(signed.messages[0].content[0], { type: 'thinking', thinking: 'TH-1', signature: 'SIG-1' });
  assert.deepEqual(signed.messages[0].content[1], { type: 'text', text: 'ANSWER' });
  const unsigned = buildRequestBody(parseChat(Buffer.concat([
    s(21, 'local-claude'), nativeMessage(2, 'ANSWER', [s(11, 'TH-1')]), nativeMessage(1, 'next'),
  ])), { model: 'claude-opus-5-5' }, { apiFormat: 'anthropic' });
  assert.ok(!unsigned.messages[0].content.some(block => block.type === 'thinking'), 'no signature means no thinking block');
});

test('Anthropic never replays a foreign dfbyok- signature as a thinking block', () => {
  const foreign = 'dfbyok-responses-v1:eyJhIjoxfQ';
  const body = buildRequestBody(parseChat(Buffer.concat([
    s(21, 'local-claude'), nativeMessage(2, 'ANSWER', [s(11, 'TH-1'), s(12, foreign)]), nativeMessage(1, 'next'),
  ])), { model: 'claude-opus-5-5' }, { apiFormat: 'anthropic' });
  assert.ok(!body.messages[0].content.some(block => block.type === 'thinking'), 'the foreign envelope produces no thinking block');
  assert.ok(!JSON.stringify(body).includes(foreign), 'the foreign string never reaches the wire');
  const replay = buildRequestBody(parseChat(Buffer.concat([
    s(21, 'local-claude'), nativeMessage(2, 'ANSWER', [s(11, 'TH-1'), s(12, 'AbCdEf==base64sig')]), nativeMessage(1, 'next'),
  ])), { model: 'claude-opus-5-5' }, { apiFormat: 'anthropic' });
  assert.deepEqual(replay.messages[0].content[0], { type: 'thinking', thinking: 'TH-1', signature: 'AbCdEf==base64sig' }, 'a genuine signature still replays');
});

test('Anthropic usage carries cache read and write as separate fields', async t => {
  const result = await run(t, [
    sse('message_start', { message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 3, output_tokens: 1 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: 'ok' } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
    sse('message_stop', {}),
  ]);
  const usage = result.messages.map(message => fields(message, 7)).flat().map(field => field.value)[0];
  assert.equal(num(usage, 5), 90, 'cache_read_tokens');
  assert.equal(num(usage, 4), 3, 'cache_write_tokens');
  assert.equal(num(usage, 2), 103, 'input_tokens stays inclusive');
});

test('redacted-only thinking still reports empty output', async t => {
  const result = await run(t, [
    sse('message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'redacted_thinking' } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
    sse('message_stop', {}),
  ]);
  assert.equal(result.metrics[0].status, 'error');
  assert.equal(result.metrics[0].code, 'upstream_empty_output');
});

test('Anthropic stream assembles streamed and empty tool inputs in block order', async t => {
  const result = await run(t, [
    sse('message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'shell_command', input: {} } }),
    sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"cmd":' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '"ls"}' } }),
    sse('content_block_stop', { index: 0 }),
    sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'list_files', input: {} } }),
    sse('content_block_stop', { index: 1 }),
    sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }),
    sse('message_stop', {}),
  ]);
  const tools = result.messages.flatMap(message => fields(message, 6)).map(field => [str(field.value, 1), str(field.value, 2), str(field.value, 3)]);
  assert.deepEqual(tools, [['toolu_1', 'shell_command', '{"cmd":"ls"}'], ['toolu_2', 'list_files', '{}']]);
  assert.equal(result.metrics[0].hasTools, true);
});

test('Anthropic stream errors and truncation surface as failures', async t => {
  const failed = await run(t, [
    sse('message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
    sse('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }),
  ]);
  assert.equal(failed.metrics[0].status, 'error');
  assert.equal(failed.metrics[0].code, 'upstream_stream_error');
  const truncated = await run(t, [sse('message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: 'partial' } })]);
  assert.equal(truncated.metrics[0].code, 'upstream_stream_incomplete');
});

test('recent Claude Opus and Sonnet models get automatic effort levels, Haiku does not', () => {
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-opus-4-6', 'claude-sonnet-4-8'])
    assert.deepEqual(modelEfforts({ id }), [null, 'low', 'medium', 'high', 'xhigh', 'max'], id);
  for (const id of ['claude-haiku-4-5', 'claude-opus-4-1', 'claude-sonnet-4-5', 'claude-3-7-sonnet'])
    assert.deepEqual(modelEfforts({ id }), [null], id);
});

test('Anthropic model discovery pages with x-api-key and keeps reported limits', async t => {
  const seen = [];
  const upstream = await server((req, res) => {
    const url = new URL(req.url, 'http://local');
    seen.push({ path: url.pathname, after: url.searchParams.get('after_id'), key: req.headers['x-api-key'], auth: req.headers.authorization });
    const page = url.searchParams.get('after_id')
      ? { data: [{ id: 'claude-haiku-4-5', max_input_tokens: 200000, max_tokens: 64000 }], has_more: false, last_id: 'claude-haiku-4-5' }
      : { data: [{ id: 'claude-opus-5-5', max_input_tokens: 1000000, max_tokens: 128000 }], has_more: true, last_id: 'claude-opus-5-5' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(page));
  }, t);
  const { discover } = require('../src/models/discovery.cjs');
  const provider = { name: 'Claude', baseUrl: `${upstream}/v1`, apiKey: 'fake-anthropic-key', apiFormat: 'anthropic', models: [] };
  assert.equal(await discover(provider), 2);
  assert.deepEqual(seen.map(item => [item.path, item.after, item.key, item.auth]),
    [['/v1/models', null, 'fake-anthropic-key', undefined], ['/v1/models', 'claude-opus-5-5', 'fake-anthropic-key', undefined]]);
  assert.deepEqual(provider.models.map(model => [model.id, model.contextWindow, model.maxOutputTokens]),
    [['claude-opus-5-5', 1000000, 128000], ['claude-haiku-4-5', 200000, 64000]]);
});

test('a forced choice first retries with thinking disabled, then degrades to auto', async t => {
  const tool = m(10, Buffer.concat([s(1, 'shell_command'), s(2, 'Run'), s(3, '{}')]));
  const request = Buffer.concat([s(21, 'local-claude'), nativeMessage(1, 'hi'), tool, m(12, Buffer.concat([s(1, 'tool'), s(2, 'shell_command')]))]);
  const success = [
    sse('message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: 'ok' } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
    sse('message_stop', {}),
  ];
  const refusal = JSON.stringify({ error: { message: 'tool_choice is not supported by this endpoint' } });
  async function runRetry(failCount) {
    const requests = [];
    const upstream = await server(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks)));
      if (requests.length > failCount) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(success.join('')); return; }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(refusal);
    }, t);
    const proxy = await server((req, res) => {
      serveChat({ request: parseChat(request), route: { model: 'claude-opus-5-5', uid: 'local-claude' },
        provider: { baseUrl: `${upstream}/v1`, apiKey: 'k', apiFormat: 'anthropic' }, res });
    }, t);
    await (await fetch(proxy)).arrayBuffer();
    return requests;
  }

  const disabled = await runRetry(1);
  assert.equal(disabled.length, 2);
  assert.deepEqual(disabled[1].thinking, { type: 'disabled' }, 'the first retry turns thinking off');
  assert.deepEqual(disabled[1].tool_choice, { type: 'tool', name: 'shell_command' }, 'the forced choice survives that retry');

  const degraded = await runRetry(2);
  assert.equal(degraded.length, 3);
  assert.deepEqual(degraded[2].tool_choice, { type: 'auto' }, 'the fallback degrades the choice to auto');
});

test('Anthropic thinking_tokens map to reasoning tokens in usage and metrics', async t => {
  const result = await run(t, [
    sse('message_start', { message: { usage: { input_tokens: 10, output_tokens: 0 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'T' } }),
    sse('content_block_stop', { index: 0 }),
    sse('content_block_start', { index: 1, content_block: { type: 'text', text: 'ok' } }),
    sse('content_block_stop', { index: 1 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20, output_tokens_details: { thinking_tokens: 12 } } }),
    sse('message_stop', {}),
  ]);
  assert.equal(result.metrics[0].reasoningTokens, 12);
  assert.equal(result.metrics[0].visibleTokens, 8);
  assert.equal(result.metrics[0].outputTokens, 20);
});

test('redacted thinking data round-trips through the signature lane', () => {
  const adapter = createAnthropicAdapter();
  const first = adapter({ type: 'content_block_start', data: { index: 0, content_block: { type: 'redacted_thinking', data: 'opaque-1' } } });
  assert.equal(first.length, 1);
  assert.equal(first[0].data.choices[0].delta.thinking_redacted, true);
  assert.equal(first[0].data.choices[0].delta.signature, 'dfbyok-redacted-v1:opaque-1');
  const second = adapter({ type: 'content_block_start', data: { index: 1, content_block: { type: 'redacted_thinking', data: 'opaque-2' } } });
  assert.equal(second[0].data.choices[0].delta.thinking_redacted, true);
  assert.equal(second[0].data.choices[0].delta.signature, undefined, 'a second redacted block carries no data');
  const body = buildRequestBody(parseChat(Buffer.concat([
    s(21, 'local-claude'), nativeMessage(2, 'ANSWER', [s(12, 'dfbyok-redacted-v1:opaque-1')]), nativeMessage(1, 'next'),
  ])), { model: 'claude-opus-5-5' }, { apiFormat: 'anthropic' });
  assert.deepEqual(body.messages[0].content[0], { type: 'redacted_thinking', data: 'opaque-1' });
  assert.ok(!body.messages[0].content.some(block => block.type === 'thinking'), 'no fabricated thinking block');
});

test('Anthropic request body maps document attachments and rejects unsupported media', () => {
  const request = docs => parseChat({ prompt: 'sys', chatMessagePrompts: [{ source: 1, prompt: 'see doc', ...docs }] });
  const pdf = buildRequestBody(request({ documents: [{ base64Data: 'QUJD', mimeType: 'application/pdf', filename: 'doc.pdf' }] }),
    { model: 'claude-opus-5-5' }, { apiFormat: 'anthropic' });
  assert.deepEqual(pdf.messages[0].content, [
    { type: 'text', text: 'see doc' },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' } }]);
  const plain = buildRequestBody(request({ documents: [{ base64Data: 'aGVsbG8=', mimeType: 'text/plain', filename: 'note.txt' }] }),
    { model: 'claude-opus-5-5' }, { apiFormat: 'anthropic' });
  assert.deepEqual(plain.messages[0].content[1], { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'hello' } });
  let err;
  try {
    buildRequestBody(request({ documents: [{ base64Data: 'QUJD', mimeType: 'application/msword', filename: 'doc.doc' }] }),
      { model: 'claude-opus-5-5' }, { apiFormat: 'anthropic' });
  } catch (thrown) { err = thrown; }
  assert.equal(err?.code, 'attachment_unsupported');
  err = undefined;
  try {
    buildRequestBody(request({ videos: [{ base64Data: 'QUJD', mimeType: 'video/mp4' }] }),
      { model: 'claude-opus-5-5' }, { apiFormat: 'anthropic' });
  } catch (thrown) { err = thrown; }
  assert.equal(err?.code, 'attachment_unsupported');
  assert.equal(err?.detail, 'video');
});

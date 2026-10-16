'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const zlib = require('node:zlib');
const wire = require('../src/protocol/wire.cjs');
const { parseChat } = require('../src/protocol/chat.cjs');
const { serveChat, buildRequestBody } = require('../src/protocol/responses.cjs');
const { s, v, m, str, num, fields } = wire;

function nativeMessage(source, text, extra = []) {
  return m(3, Buffer.concat([v(2, source), s(3, text), ...extra]));
}
function nativeRequest() {
  const args = '{ "prompt": "keep whitespace", "count": "01" }';
  return Buffer.concat([
    s(2, '  Original\n\nsystem instructions  '), s(21, 'local-cpa-lead'), v(6, 9901),
    nativeMessage(1, 'User message', [m(10, Buffer.concat([s(1, 'aGVsbG8='), s(2, 'image/png'), s(3, 'Image caption')]))]),
    nativeMessage(2, 'Assistant before tool', [m(6, Buffer.concat([s(1, 'call:1'), s(2, 'sidekick'), s(3, args)]))]),
    nativeMessage(4, 'Tool output', [s(7, 'call:1'), v(9, 1)]),
    nativeMessage(5, 'System message in the middle'),
    nativeMessage(1, 'User after tool'),
    ...['sidekick', 'shell_command', 'mcp__service__tool'].map(name => m(10, Buffer.concat([s(1, name), s(2, 'Original description'), s(3, '{"type":"object","properties":{"cmd":{"type":"string"}},"additionalProperties":false}')]))),
    m(12, Buffer.concat([s(1, 'tool'), s(2, 'sidekick')])),
  ]);
}

function unpack(buffer) {
  const messages = [];
  let eos = 0;
  for (let offset = 0; offset < buffer.length;) {
    const flags = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    let data = buffer.subarray(offset + 5, offset + 5 + length);
    offset += 5 + length;
    if (flags & 1) data = zlib.gunzipSync(data);
    if (flags & 2) { eos++; assert.deepEqual(JSON.parse(data), {}); }
    else messages.push(data);
  }
  return { messages, eos };
}

async function server(handler, t) {
  const instance = http.createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return { instance, url: `http://127.0.0.1:${instance.address().port}` };
}

async function bridge(t, upstreamHandler, apiFormat = 'openai-responses', timeouts = {}, onMetrics = () => {}) {
  const requests = [];
  const logs = [];
  const upstream = await server(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks)), auth: req.headers.authorization });
    await upstreamHandler(req, res);
  }, t);
  const proxy = await server((req, res) => {
    serveChat({ request: parseChat(nativeRequest()), route: { model: 'test-model', uid: 'local-cpa-lead', effort: 'high' }, provider: { baseUrl: `${upstream.url}/v1`, apiKey: 'fake-provider-secret', apiFormat }, res, log: event => logs.push(event), timeouts, onMetrics });
  }, t);
  return { ...proxy, requests, logs, upstream };
}

function event(value) { return `data: ${JSON.stringify(value)}\r\n\r\n`; }

test('monitor captures usage after Chat finish_reason without duplicate output', async t => {
  const metrics = [];
  const proxy = await bridge(t, async (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] }));
    res.write(event({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0 } } }));
    res.end('data: [DONE]\n\n');
  }, 'openai', {}, value => metrics.push(value));
  const response = await fetch(proxy.url);
  const output = unpack(Buffer.from(await response.arrayBuffer()));
  assert.equal(output.messages.map(m => str(m, 3)).join(''), 'hello');
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].inputTokens, 12); assert.equal(metrics[0].outputTokens, 3);
  assert.equal(metrics[0].cachedTokens, 0); assert.equal(metrics[0].usageComplete, true);
  assert.equal(metrics[0].status, 'success');
  assert.deepEqual(proxy.requests[0].body.stream_options, { include_usage: true });
});

test('protobuf retains unknown raw fields and uint64 without rounding', () => {
  const input = Buffer.concat([s(3, '模型'), v(911, 18446744073709551615n), m(300, Buffer.from([1, 2, 3]))]);
  const parsed = wire.parseFields(input);
  assert.equal(str(input, 3), '模型');
  assert.equal(num(input, 911), 18446744073709551615n);
  assert.deepEqual(Buffer.concat(parsed.map(field => field.raw)), input);
  assert.deepEqual(parsed.map(field => [field.number, field.wire]), [[3, 2], [911, 0], [300, 2]]);
});

test('protobuf rejects malformed lengths, tags and overflowing varints', () => {
  for (const input of [[0], [10, 4, 65], [9, 1, 2], [13, 1], [8, ...Array(10).fill(128)], [8, ...Array(9).fill(255), 2], [11]]) {
    assert.throws(() => wire.parseFields(Buffer.from(input)));
  }
});

test('Connect protobuf and JSON preserve framing and both gzip layers', () => {
  for (const json of [false, true]) for (const gzip of [false, true]) for (const compressed of [false, true]) {
    const data = json ? { unicode: '中文', value: 42 } : s(1, '中文');
    const format = { framed: true, json, gzip, compressed, type: json ? 'application/connect+json' : 'application/connect+proto' };
    const encoded = wire.encode(data, format);
    const decoded = wire.decode(encoded, { 'content-type': format.type, ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
    assert.deepEqual(decoded.data, data);
    assert.equal(decoded.framed, true);
    assert.equal(decoded.compressed, compressed);
    assert.deepEqual(wire.encode(decoded.data, decoded), encoded);
  }
  assert.throws(() => wire.decode(Buffer.from([0, 0, 0, 0, 10, 1]), { 'content-type': 'application/connect+proto' }));
  assert.throws(() => wire.decode(Buffer.concat([wire.frame(s(1, 'a')), wire.frame(s(1, 'b'))]), { 'content-type': 'application/connect+proto' }));
});

test('native parser preserves arbitrary tools, arguments, system bytes and message order', () => {
  const request = parseChat(nativeRequest());
  assert.equal(request.systemPrompt, '  Original\n\nsystem instructions  ');
  assert.equal(request.modelUid, 'local-cpa-lead');
  assert.equal(request.modelEnum, 9901);
  assert.deepEqual(request.tools.map(tool => tool.name), ['sidekick', 'shell_command', 'mcp__service__tool']);
  assert.equal(request.messages[1].toolCalls[0].arguments, '{ "prompt": "keep whitespace", "count": "01" }');
  assert.equal(request.messages[1].toolCalls[0].id, 'call:1');
  assert.equal(request.messages[2].toolResultIsError, true);
  assert.deepEqual(request.messages.map(message => message.role), ['user', 'assistant', 'tool', 'system', 'user']);
  assert.equal(request.tools[1].parameters.properties.cmd.type, 'string');
});

for (const snake of [false, true]) test(`native ${snake ? 'snake_case' : 'camelCase'} JSON schema matches protobuf history and tools`, () => {
  const key = (camel, underscored) => snake ? underscored : camel;
  const native = parseChat(nativeRequest());
  const data = {
    [key('chatModelUid', 'chat_model_uid')]: native.modelUid,
    [key('internalChatModel', 'internal_chat_model')]: native.modelEnum,
    prompt: native.systemPrompt,
    [key('chatMessagePrompts', 'chat_message_prompts')]: native.messages.map(message => ({
      [key('messageId', 'message_id')]: message.messageId,
      source: message.source,
      prompt: message.content,
      [key('toolCalls', 'tool_calls')]: message.toolCalls.map(call => ({ id: call.id, name: call.name, [key('argumentsJson', 'arguments_json')]: call.arguments })),
      [key('toolCallId', 'tool_call_id')]: message.toolCallId,
      [key('toolResultIsError', 'tool_result_is_error')]: message.toolResultIsError,
      images: message.images.map(image => ({ [key('base64Data', 'base64_data')]: image.base64, [key('mimeType', 'mime_type')]: image.mimeType, caption: image.caption })),
      thinking: message.thinking, signature: message.signature,
    })),
    tools: native.tools.map(tool => ({ name: tool.name, description: tool.description, [key('jsonSchemaString', 'json_schema_string')]: JSON.stringify(tool.parameters) })),
    [key('toolChoice', 'tool_choice')]: { [key('toolName', 'tool_name')]: 'sidekick' },
  };
  const parsed = parseChat(data);
  assert.deepEqual(parsed, native);
  assert.deepEqual(buildRequestBody(parsed, { model: 'chosen-model' }, { apiFormat: 'responses' }), buildRequestBody(native, { model: 'chosen-model' }, { apiFormat: 'responses' }));
  data[key('toolChoice', 'tool_choice')] = { [key('optionName', 'option_name')]: 'any' };
  assert.equal(buildRequestBody(parseChat(data), { model: 'chosen-model' }, { apiFormat: 'openai' }).tool_choice, 'required');
});

test('Responses and Chat requests preserve history, pictures and exact tool definitions', () => {
  const request = parseChat(nativeRequest());
  for (const effort of ['xhigh', 'max']) {
    for (const apiFormat of ['openai-responses', 'chat-completions']) {
      const body = buildRequestBody(request, { model: 'chosen-model', effort }, { apiFormat });
      assert.equal(body.model, 'chosen-model');
      const chat = apiFormat === 'chat-completions';
      const messages = chat ? body.messages : body.input;
      assert.equal(messages[0].content, request.systemPrompt);
      assert.equal(messages[1].content[1].type, chat ? 'image_url' : 'input_image');
      assert.equal(messages.at(-2).content, 'System message in the middle');
      assert.equal(messages.at(-1).content, 'User after tool');
      assert.deepEqual(body.tools.map(tool => (tool.function || tool).name), request.tools.map(tool => tool.name));
      assert.deepEqual((body.tools[1].function || body.tools[1]).parameters, request.tools[1].parameters);
      if (chat) {
        assert.equal(messages[2].tool_calls[0].function.arguments, request.messages[1].toolCalls[0].arguments);
        assert.equal(body.tool_choice.function.name, 'sidekick');
        assert.equal(body.reasoning_effort, effort);
      } else {
        assert.equal(messages[3].type, 'function_call');
        assert.equal(messages[4].type, 'function_call_output');
        assert.equal(messages[3].arguments, request.messages[1].toolCalls[0].arguments);
        assert.equal(body.tool_choice.name, 'sidekick');
        assert.equal(body.reasoning.effort, effort);
      }
    }
  }
});

test('openai menu format selects Chat Completions and configured output limit is retained', () => {
  const request = parseChat(nativeRequest());
  const chatBody = buildRequestBody(request, { model: 'chosen-model', maxOutputTokens: 8192 }, { apiFormat: 'openai', maxTokens: 4096 });
  assert.ok(Array.isArray(chatBody.messages));
  assert.equal(chatBody.input, undefined);
  assert.equal(chatBody.max_completion_tokens, 8192);
  const responsesBody = buildRequestBody(request, { model: 'chosen-model', maxOutputTokens: 8192 }, { apiFormat: 'responses' });
  assert.equal(responsesBody.max_output_tokens, 8192);
});

test('Responses completes parallel done-only calls and Unicode split across TCP chunks', async t => {
  const app = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const values = [
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '中文✓' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'sidekick' } },
      { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'item-2', call_id: 'call-2', name: 'mcp__service__tool' } },
      { type: 'response.function_call_arguments.done', item_id: 'item-1', arguments: '{ "prompt": "check" }' },
      { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'item-2', call_id: 'call-2', name: 'mcp__service__tool', arguments: '{"cmd":"run"}' } },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ];
    const bytes = Buffer.from(values.map(event).join(''));
    for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
    res.end();
  });
  const response = await fetch(app.url);
  assert.equal(response.headers.get('content-type'), 'application/connect+proto');
  const { messages, eos } = unpack(Buffer.from(await response.arrayBuffer()));
  assert.equal(messages.map(message => str(message, 3)).join(''), '中文✓');
  const tools = messages.flatMap(message => fields(message, 6)).map(field => ({ name: str(field.value, 2), args: str(field.value, 3) }));
  assert.deepEqual(tools, [{ name: 'sidekick', args: '{ "prompt": "check" }' }, { name: 'mcp__service__tool', args: '{"cmd":"run"}' }]);
  assert.equal(num(messages.at(-1), 5), 10);
  assert.equal(str(messages.at(-1), 23), 'local-cpa-lead');
  assert.equal(eos, 1);
  assert.equal(app.requests[0].url, '/v1/responses');
  assert.equal(app.requests[0].auth, 'Bearer fake-provider-secret');
  assert.equal(JSON.stringify(app.logs).includes('fake-provider-secret'), false);
  assert.deepEqual(app.logs[0].toolNames, ['sidekick', 'mcp__service__tool']);
});

test('Responses completed output alone reconstructs text and exact tool arguments', async t => {
  const app = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(event({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Only final text' }] }, { type: 'function_call', call_id: 'call-1', name: 'sidekick', arguments: '{"prompt":"done-only"}' }] } }));
  });
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  assert.equal(result.messages.map(message => str(message, 3)).join(''), 'Only final text');
  assert.equal(str(result.messages.flatMap(message => fields(message, 6))[0].value, 3), '{"prompt":"done-only"}');
  assert.equal(num(result.messages.at(-1), 5), 10);
});

test('Responses delta and completed output do not duplicate tool calls or text', async t => {
  const app = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      { type: 'response.output_text.delta', delta: 'A', output_index: 0, content_index: 0 },
      { type: 'response.output_text.done', text: 'AB', output_index: 0, content_index: 0 },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'item', call_id: 'call', name: 'sidekick' }, output_index: 1 },
      { type: 'response.function_call_arguments.delta', delta: '{"prompt":', item_id: 'item' },
      { type: 'response.function_call_arguments.delta', delta: '"task"}', output_index: 1 },
      { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'AB' }] }, { type: 'function_call', id: 'item', call_id: 'call', name: 'sidekick', arguments: '{"prompt":"task"}' }] } },
    ].map(event).join(''));
  });
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  assert.equal(result.messages.map(message => str(message, 3)).join(''), 'AB');
  assert.equal(result.messages.flatMap(message => fields(message, 6)).length, 1);
});

test('Responses parallel calls retain output index order when events arrive out of order', async t => {
  const app = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'c2', name: 'shell_command', arguments: '{"cmd":"second"}' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'sidekick', arguments: '{"prompt":"first"}' } },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ].map(event).join(''));
  });
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  assert.deepEqual(result.messages.flatMap(message => fields(message, 6)).map(tool => str(tool.value, 2)), ['sidekick', 'shell_command']);
});

test('explicit caller abort cancels a request before HTTP headers arrive', async t => {
  let upstreamStarted;
  const started = new Promise(resolve => { upstreamStarted = resolve; });
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const upstream = await server((req, res) => { res.on('close', upstreamClosed); upstreamStarted(); }, t);
  const controller = new AbortController();
  const logs = [];
  const proxy = await server((req, res) => {
    serveChat({ request: parseChat(nativeRequest()), route: { model: 'test-model', uid: 'local-test' }, provider: { baseUrl: `${upstream.url}/v1`, apiKey: 'unused', apiFormat: 'responses' }, res, signal: controller.signal, log: event => logs.push(event) });
  }, t);
  const pending = fetch(proxy.url).catch(() => null);
  await started;
  controller.abort();
  assert.equal(await pending, null);
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Upstream not aborted')), 2000); timer.unref(); })]);
  assert.equal(logs[0].event, 'chat-aborted');
});

test('Chat Completions assembles fragmented parallel native tool calls', async t => {
  const app = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      { choices: [{ index: 0, delta: { reasoning_content: 'Thinking', tool_calls: [{ index: 0, id: 'c1', function: { name: 'sidekick', arguments: '{"prompt":' } }, { index: 1, id: 'c2', function: { name: 'shell_command', arguments: '{"cmd":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '"echo ok"}' } }, { index: 0, function: { arguments: '"task"}' } }] }, finish_reason: 'tool_calls' }] },
    ].map(event).join('') + 'data: [DONE]\n\n');
  }, 'openai-chat-completions');
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  assert.equal(app.requests[0].url, '/v1/chat/completions');
  assert.equal(result.messages.map(message => str(message, 9)).join(''), 'Thinking');
  const tools = result.messages.flatMap(message => fields(message, 6));
  assert.deepEqual(tools.map(tool => [str(tool.value, 2), str(tool.value, 3)]), [['sidekick', '{"prompt":"task"}'], ['shell_command', '{"cmd":"echo ok"}']]);
  assert.equal(num(result.messages.at(-1), 5), 10);
});

test('Responses refusal deltas and done events surface as visible text', async t => {
  const viaDelta = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      { type: 'response.refusal.delta', delta: 'I cannot help.', output_index: 0, content_index: 0 },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ].map(event).join(''));
  });
  const deltaResult = unpack(Buffer.from(await (await fetch(viaDelta.url)).arrayBuffer()));
  assert.equal(deltaResult.messages.map(m => str(m, 3)).join(''), 'I cannot help.');

  const viaDone = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      { type: 'response.refusal.done', refusal: 'Refused fully.', output_index: 0, content_index: 0 },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ].map(event).join(''));
  });
  const doneResult = unpack(Buffer.from(await (await fetch(viaDone.url)).arrayBuffer()));
  assert.equal(doneResult.messages.map(m => str(m, 3)).join(''), 'Refused fully.');
});

test('Responses reasoning_text and summary done events surface as thinking text', async t => {
  const viaText = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      { type: 'response.reasoning_text.delta', delta: 'thinking hard', output_index: 0, content_index: 0 },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ].map(event).join(''));
  });
  const textResult = unpack(Buffer.from(await (await fetch(viaText.url)).arrayBuffer()));
  assert.equal(textResult.messages.map(m => str(m, 9)).join(''), 'thinking hard');
  assert.equal(textResult.messages.map(m => str(m, 3)).join(''), '');

  const viaSummary = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      { type: 'response.reasoning_summary_text.done', text: 'summary全文', output_index: 0, summary_index: 0 },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ].map(event).join(''));
  });
  const summaryResult = unpack(Buffer.from(await (await fetch(viaSummary.url)).arrayBuffer()));
  assert.equal(summaryResult.messages.map(m => str(m, 9)).join(''), 'summary全文');
});

test('Chat delta.refusal surfaces as visible text', async t => {
  const proxy = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ choices: [{ delta: { refusal: 'no' } }] }));
    res.write(event({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    res.end('data: [DONE]\n\n');
  }, 'openai');
  const output = unpack(Buffer.from(await (await fetch(proxy.url)).arrayBuffer()));
  assert.equal(output.messages.map(m => str(m, 3)).join(''), 'no');
});

test('completed without any content reports upstream_empty_output but truncation does not', async t => {
  const metrics = [];
  const empty = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      { type: 'response.created', response: { status: 'in_progress' } },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ].map(event).join(''));
  }, 'openai-responses', {}, value => metrics.push(value));
  const emptyResult = unpack(Buffer.from(await (await fetch(empty.url)).arrayBuffer()));
  assert.match(emptyResult.messages.map(m => str(m, 3)).join(''), /no output/i);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].status, 'error');
  assert.equal(metrics[0].code, 'upstream_empty_output');

  const truncatedMetrics = [];
  const truncated = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(event({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }));
  }, 'openai-responses', {}, value => truncatedMetrics.push(value));
  await fetch(truncated.url);
  assert.equal(truncatedMetrics.length, 1);
  assert.equal(truncatedMetrics[0].status, 'success');
});

test('Responses usage carries cached tokens as cache_read_tokens', async t => {
  const proxy = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      { type: 'response.output_text.delta', delta: 'ok', output_index: 0, content_index: 0 },
      { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 40 } } } },
    ].map(event).join(''));
  });
  const output = unpack(Buffer.from(await (await fetch(proxy.url)).arrayBuffer()));
  const usage = output.messages.map(m => fields(m, 7)).flat().map(field => field.value)[0];
  assert.equal(num(usage, 5), 40, 'cache_read_tokens');
  assert.equal(num(usage, 2), 100, 'input_tokens stays inclusive');
});

test('Chat usage carries cached tokens from details and the flat fallback', async t => {
  const viaDetails = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ choices: [{ delta: { content: 'ok' } }] }));
    res.write(event({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } } }));
    res.end('data: [DONE]\n\n');
  }, 'openai');
  const detailed = unpack(Buffer.from(await (await fetch(viaDetails.url)).arrayBuffer()));
  const detailedUsage = detailed.messages.map(m => fields(m, 7)).flat().map(field => field.value)[0];
  assert.equal(num(detailedUsage, 5), 40);

  const viaFlat = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ choices: [{ delta: { content: 'ok' } }] }));
    res.write(event({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 25 } }));
    res.end('data: [DONE]\n\n');
  }, 'openai');
  const flat = unpack(Buffer.from(await (await fetch(viaFlat.url)).arrayBuffer()));
  const flatUsage = flat.messages.map(m => fields(m, 7)).flat().map(field => field.value)[0];
  assert.equal(num(flatUsage, 5), 25);
});

test('Chat legacy delta.function_call becomes a tool call with a stable id', async t => {
  const metrics = [];
  const proxy = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ choices: [{ delta: { function_call: { name: 'shell_command' } } }] }));
    res.write(event({ choices: [{ delta: { function_call: { arguments: '{"cmd":' } } }] }));
    res.write(event({ choices: [{ delta: { function_call: { arguments: '"ls"}' } } }] }));
    res.write(event({ choices: [{ delta: {}, finish_reason: 'function_call' }] }));
    res.end('data: [DONE]\n\n');
  }, 'openai', {}, value => metrics.push(value));
  const output = unpack(Buffer.from(await (await fetch(proxy.url)).arrayBuffer()));
  const tools = output.messages.flatMap(m => fields(m, 6)).map(field => field.value);
  assert.equal(tools.length, 1);
  assert.equal(str(tools[0], 2), 'shell_command');
  assert.equal(str(tools[0], 3), '{"cmd":"ls"}');
  assert.ok(str(tools[0], 1).length > 0, 'legacy call gets a non-empty id');
  assert.equal(num(output.messages.at(-1), 5), 10, 'finish_reason function_call ends as FUNCTION_CALL');
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].hasTools, true);
  assert.ok(metrics[0].toolIds.includes(str(tools[0], 1)), 'panel toolIds carry the same minted id');
  assert.equal(metrics[0].tps, null, 'tool calls never compute throughput');
});

test('Responses done snapshots emit refusal and reasoning blocks exactly once', async t => {
  const cases = [
    ['snapshot refusal', [{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'DECLINED' }] }] } }], 'DECLINED', ''],
    ['item refusal', [{ type: 'response.output_item.done', output_index: 0, item: { type: 'message', content: [{ type: 'refusal', refusal: 'STOP' }] } }, { type: 'response.completed', response: { status: 'completed', output: [] } }], 'STOP', ''],
    ['reasoning summary', [{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'SUM' }] }] } }], '', 'SUM'],
    ['reasoning content', [{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'RT' }] }] } }], '', 'RT'],
    ['delta then done then completed', [
      { type: 'response.refusal.delta', delta: 'A', output_index: 0, content_index: 0 },
      { type: 'response.refusal.done', refusal: 'AB', output_index: 0, content_index: 0 },
      { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'AB' }] }] } },
    ], 'AB', ''],
  ];
  for (const [name, values, wantText, wantThinking] of cases) await t.test(name, async st => {
    const metrics = [];
    const proxy = await bridge(st, async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(values.map(event).join(''));
    }, 'openai-responses', {}, value => metrics.push(value));
    const output = unpack(Buffer.from(await (await fetch(proxy.url)).arrayBuffer()));
    assert.equal(output.messages.map(m => str(m, 3)).join(''), wantText, 'visible text');
    assert.equal(output.messages.map(m => str(m, 9)).join(''), wantThinking, 'thinking text');
    assert.notEqual(metrics[0].firstOutputMs, null);
    assert.equal(metrics[0].hasReasoning, wantThinking.length > 0);
  });
});

test('Responses incomplete emits final output items and maps reasons', async t => {
  for (const [detail, wantReason] of [['content_filter', 11], ['max_output_tokens', 3]]) await t.test(detail, async st => {
    const proxy = await bridge(st, async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([
        { type: 'response.output_text.delta', delta: 'part', output_index: 0, content_index: 0 },
        { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: detail },
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'part' }] }] } },
      ].map(event).join(''));
    });
    const output = unpack(Buffer.from(await (await fetch(proxy.url)).arrayBuffer()));
    assert.equal(output.messages.map(m => str(m, 3)).join(''), 'part', 'final snapshot text is emitted once');
    assert.equal(num(output.messages.at(-1), 5), wantReason, `reason ${detail} maps to ${wantReason}`);
  });

  await t.test('incomplete function_call is never emitted as a tool', async st => {
    const proxy = await bridge(st, async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'sidekick' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"prompt":' },
        { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
          output: [{ type: 'function_call', call_id: 'c1', name: 'sidekick', arguments: '{"prompt":' }] } },
      ].map(event).join(''));
    });
    const output = unpack(Buffer.from(await (await fetch(proxy.url)).arrayBuffer()));
    assert.equal(output.messages.flatMap(m => fields(m, 6)).length, 0, 'truncated tool calls are dropped');
    assert.equal(num(output.messages.at(-1), 5), 3);
  });
});

test('parseChat preserves disableParallelToolCalls and tool strict across proto and JSON', () => {
  const toolField = m(10, Buffer.concat([s(1, 'shell_command'), s(2, 'Run'), s(3, '{}'), v(12, 1)]));
  const proto = parseChat(Buffer.concat([
    s(21, 'local-model'), m(3, Buffer.concat([v(2, 1), s(3, 'hi')])), toolField, v(11, 1),
  ]));
  const camel = parseChat({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'shell_command' }], disableParallelToolCalls: true });
  const snake = parseChat({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'shell_command' }], disable_parallel_tool_calls: true });
  for (const [label, request] of [['proto', proto], ['camel', camel], ['snake', snake]]) {
    assert.equal(request.disableParallelToolCalls, true, label);
  }
  assert.equal(proto.tools[0].strict, true, 'proto field 12');
  const strictJson = parseChat({ messages: [], tools: [{ name: 'x', strict: true }] });
  assert.equal(strictJson.tools[0].strict, true, 'JSON strict');
  const defaults = parseChat({ messages: [], tools: [{ name: 'x' }] });
  assert.equal(defaults.disableParallelToolCalls, false);
  assert.equal(defaults.tools[0].strict, false);
});

test('disableParallelToolCalls and tool strict reach the OpenAI wire bodies only when set', () => {
  const flagged = parseChat(Buffer.concat([
    s(21, 'local-model'), m(3, Buffer.concat([v(2, 1), s(3, 'hi')])),
    m(10, Buffer.concat([s(1, 'shell_command'), s(2, 'Run'), s(3, '{}'), v(12, 1)])), v(11, 1),
  ]));
  const chat = buildRequestBody(flagged, { model: 'm' }, { apiFormat: 'openai' });
  assert.equal(chat.parallel_tool_calls, false);
  assert.equal(chat.tools[0].function.strict, true);
  const responses = buildRequestBody(flagged, { model: 'm' }, { apiFormat: 'openai-responses' });
  assert.equal(responses.parallel_tool_calls, false);
  assert.equal(responses.tools[0].strict, true);
  const plain = buildRequestBody(parseChat({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'shell_command' }] }), { model: 'm' }, { apiFormat: 'openai' });
  assert.equal('parallel_tool_calls' in plain, false);
  assert.equal(plain.tools[0].function.strict, false, 'native default false must be emitted verbatim');
  const plainResponses = buildRequestBody(parseChat({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'shell_command' }] }), { model: 'm' }, { apiFormat: 'openai-responses' });
  assert.equal(plainResponses.tools[0].strict, false, 'responses emits the same default');
});

test('tool strict is forwarded verbatim to both OpenAI wire bodies', async t => {
  const schema = { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false };
  const requestFor = strict => {
    const tool = [s(1, 'skill'), s(2, 'Pick'), s(3, JSON.stringify(schema))];
    if (strict) tool.push(v(12, 1));
    return Buffer.concat([s(21, 'local-model'), m(3, Buffer.concat([v(2, 1), s(3, 'hi')])), m(10, Buffer.concat(tool))]);
  };
  async function wireBody(apiFormat, request) {
    const bodies = [];
    const upstream = await server(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      bodies.push(JSON.parse(Buffer.concat(chunks)));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('');
    }, t);
    const proxy = await server((req, res) => {
      serveChat({ request: parseChat(request), route: { model: 'm', uid: 'u' }, provider: { baseUrl: `${upstream.url}/v1`, apiFormat }, res });
    }, t);
    await fetch(proxy.url);
    return bodies[0];
  }
  for (const apiFormat of ['openai', 'openai-responses']) {
    const toolAt = body => apiFormat === 'openai' ? body.tools[0].function : body.tools[0];
    const unset = toolAt(await wireBody(apiFormat, requestFor(false)));
    assert.equal(unset.strict, false, `${apiFormat} emits strict:false`);
    assert.deepEqual(unset.parameters, schema, `${apiFormat} does not inject required`);
    const flagged = toolAt(await wireBody(apiFormat, requestFor(true)));
    assert.equal(flagged.strict, true, `${apiFormat} passes strict:true through`);
    assert.deepEqual(flagged.parameters, schema);
  }
});

test('incomplete, malformed and unterminated streams do not execute tools', async t => {
  for (const ending of ['incomplete', 'invalid-json', 'truncated']) await t.test(ending, async st => {
    const app = await bridge(st, async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(event({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'sidekick' } }));
      res.write(event({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"prompt":' }));
      if (ending === 'incomplete') res.write(event({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }));
      if (ending === 'invalid-json') res.write(event({ type: 'response.completed', response: { status: 'completed', output: [] } }));
      res.end();
    });
    const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
    assert.equal(result.messages.flatMap(message => fields(message, 6)).length, 0);
    assert.equal(num(result.messages.at(-1), 5), ending === 'incomplete' ? 3 : 13);
    const errorLog = app.logs.find(entry => entry.event === 'chat-error');
    if (ending === 'invalid-json') {
      assert.equal(errorLog?.code, 'upstream_invalid_tool');
      assert.equal(errorLog?.detail, 'invalid-json');
    }
  });
});

test('upstream_invalid_tool logs self-distinguishing detail for each cause', async t => {
  await t.test('incomplete-call: a call item without any id', async st => {
    const app = await bridge(st, async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(event({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'sidekick' } }));
      res.write(event({ type: 'response.completed', response: { status: 'completed', output: [] } }));
      res.end();
    });
    await fetch(app.url);
    const errorLog = app.logs.find(entry => entry.event === 'chat-error');
    assert.equal(errorLog?.code, 'upstream_invalid_tool');
    assert.equal(errorLog?.detail, 'incomplete-call');
  });

  await t.test('no-index: arguments delta without output_index or item_id', async st => {
    const app = await bridge(st, async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(event({ type: 'response.function_call_arguments.delta', delta: '{}' }));
      res.write(event({ type: 'response.completed', response: { status: 'completed', output: [] } }));
      res.end();
    });
    await fetch(app.url);
    const errorLog = app.logs.find(entry => entry.event === 'chat-error');
    assert.equal(errorLog?.code, 'upstream_invalid_tool');
    assert.equal(errorLog?.detail, 'no-index');
  });

  await t.test('a valid tool call produces no chat-error with detail', async st => {
    const app = await bridge(st, async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(event({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'sidekick' } }));
      res.write(event({ type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"prompt":"ok"}' }));
      res.write(event({ type: 'response.completed', response: { status: 'completed', output: [] } }));
      res.end();
    });
    await fetch(app.url);
    assert.equal(app.logs.find(entry => entry.event === 'chat-error'), undefined);
    assert.equal(app.logs.find(entry => 'detail' in entry), undefined);
  });
});

test('upstream errors expose HTTP status without body, prompt or credentials', async t => {
  const app = await bridge(t, async (req, res) => { res.writeHead(429); res.end('fake-provider-secret secret upstream reply with user content'); });
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  assert.equal(result.messages.map(message => str(message, 3)).join(''), 'Provider returned HTTP 429.');
  assert.equal(num(result.messages.at(-1), 5), 13);
  assert.equal(JSON.stringify(app.logs).includes('secret'), false);
  assert.equal(JSON.stringify(app.logs).includes('User message'), false);
});

test('a thinking-mode refusal of a forced tool_choice retries once with auto', async t => {
  let call = 0;
  const app = await bridge(t, async (req, res) => {
    call += 1;
    if (call === 1) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Thinking mode does not support this tool_choice' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ choices: [{ delta: { content: 'recovered' } }] }));
    res.write(event({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    res.end('data: [DONE]\n\n');
  }, 'openai');
  const output = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  assert.equal(app.requests.length, 2, 'exactly one retry');
  assert.deepEqual(app.requests[0].body.tool_choice, { type: 'function', function: { name: 'sidekick' } });
  assert.equal(app.requests[1].body.tool_choice, 'auto');
  assert.equal(output.messages.map(message => str(message, 3)).join(''), 'recovered');
  assert.equal(JSON.stringify(app.logs).includes('tool_choice'), false, 'the provider message is never logged');
});

test('the same refusal degrades on the Responses path too', async t => {
  let call = 0;
  const app = await bridge(t, async (req, res) => {
    call += 1;
    if (call === 1) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"Thinking mode does not support this tool_choice"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'recovered' }));
    res.write(event({ type: 'response.completed', response: { status: 'completed', output: [] } }));
    res.end();
  });
  const output = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  assert.equal(app.requests.length, 2);
  assert.deepEqual(app.requests[0].body.tool_choice, { type: 'function', name: 'sidekick' });
  assert.equal(app.requests[1].body.tool_choice, 'auto');
  assert.equal(output.messages.map(message => str(message, 3)).join(''), 'recovered');
});

test('a 400 unrelated to tool_choice keeps its single attempt and plain status', async t => {
  const app = await bridge(t, async (req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"This model\'s maximum context length is 65536 tokens"}}');
  });
  const output = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  assert.equal(app.requests.length, 1, 'an unrelated 400 must not be retried');
  assert.equal(output.messages.map(message => str(message, 3)).join(''), 'Provider returned HTTP 400.');
  assert.equal(num(output.messages.at(-1), 5), 13);
});

test('client cancellation aborts active upstream request', async t => {
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  let upstreamStarted;
  const started = new Promise(resolve => { upstreamStarted = resolve; });
  const app = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ type: 'response.output_text.delta', delta: 'Started' }));
    res.on('close', upstreamClosed);
    upstreamStarted();
  });
  const controller = new AbortController();
  const response = await fetch(app.url, { signal: controller.signal });
  await started;
  await response.body.getReader().read();
  controller.abort();
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Upstream not aborted')), 2000); timer.unref(); })]);
  assert.equal(app.logs.some(log => log.event === 'chat-aborted'), true);
});

test('provider idle timeout outputs code 13 and target text, cancel does not retry', async t => {
  let timer;
  const app = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ type: 'response.output_text.delta', delta: 'First chunk' }));
    timer = setTimeout(() => { if (!res.writableEnded) res.end(); }, 2000);
    res.on('close', () => clearTimeout(timer));
  }, 'openai-responses', { idleMs: 50, firstResponseMs: 500 });
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  assert.equal(result.messages.map(message => str(message, 3)).join(''), 'First chunkProvider response could not be completed.');
  assert.equal(num(result.messages.at(-1), 5), 13);
  assert.ok(app.logs.some(l => l.event === 'chat-error' && l.code === 'upstream_timeout'));
});

test('finish_reason content_filter maps to stopReason 11', async t => {
  const app = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      { choices: [{ index: 0, delta: { content: 'Blocked content' }, finish_reason: 'content_filter' }] }
    ].map(event).join('') + 'data: [DONE]\n\n');
  }, 'openai-chat-completions');
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  assert.equal(num(result.messages.at(-1), 5), 11);
});

test('raw heartbeat keeps stream alive past idle timeout until completion', async t => {
  const app = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': heartbeat comment\r\n\r\n');
    await new Promise(r => setTimeout(r, 40));
    res.write(': heartbeat comment\r\n\r\n');
    await new Promise(r => setTimeout(r, 40));
    res.write(event({ type: 'response.output_text.delta', delta: 'Complete after heartbeats' }));
    res.write(event({ type: 'response.completed', response: { status: 'completed', output: [] } }));
    res.end();
  }, 'openai-responses', { idleMs: 60 });
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  assert.equal(result.messages.map(message => str(message, 3)).join(''), 'Complete after heartbeats');
  assert.equal(num(result.messages.at(-1), 5), 2);
  assert.ok(app.logs.some(l => l.event === 'chat-complete' && l.requestId));
});

test('response.failed outputs generic target phrase and classified stream error', async t => {
  const app = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ type: 'response.failed', error: { message: 'internal server error' } }));
    res.end();
  }, 'openai-responses');
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  assert.equal(result.messages.map(message => str(message, 3)).join(''), 'Provider response could not be completed.');
  assert.equal(num(result.messages.at(-1), 5), 13);
  assert.ok(app.logs.some(l => l.event === 'chat-error' && l.code === 'upstream_stream_error'));
});

test('invalid tool call JSON outputs invalid format message', async t => {
  const app = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'tool' } }));
    res.write(event({ type: 'response.function_call_arguments.done', output_index: 0, arguments: 'not valid json{' }));
    res.write(event({ type: 'response.completed', response: { status: 'completed', output: [] } }));
    res.end();
  }, 'openai-responses');
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  assert.equal(result.messages.map(message => str(message, 3)).join(''), 'Provider response format is invalid.');
  assert.equal(num(result.messages.at(-1), 5), 13);
  assert.ok(app.logs.some(l => l.event === 'chat-error' && l.code === 'upstream_invalid_tool'));
});

test('firstResponse timeout triggers code 13 and upstream_timeout error', async t => {
  const app = await bridge(t, async (req, res) => {
    // Hang without sending headers
    await new Promise(r => setTimeout(r, 200));
  }, 'openai-responses', { firstResponseMs: 30, idleMs: 500 });
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  assert.equal(result.messages.map(message => str(message, 3)).join(''), 'Provider response could not be completed.');
  assert.equal(num(result.messages.at(-1), 5), 13);
  assert.ok(app.logs.some(l => l.event === 'chat-error' && l.code === 'upstream_timeout'));
});

test('malformed non-SSE content-type outputs invalid format message', async t => {
  const app = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Not SSE content');
  }, 'openai-responses');
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  assert.equal(result.messages.map(message => str(message, 3)).join(''), 'Provider response format is invalid.');
  assert.equal(num(result.messages.at(-1), 5), 13);
  assert.ok(app.logs.some(l => l.event === 'chat-error' && l.code === 'upstream_content_type'));
});

test('Responses forwards native usage field 7 after a valid completed snapshot', async t => {
  const app = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'ok' }));
    res.end(event({ type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 21, output_tokens: 7 } } }));
  });
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  const usage = fields(result.messages.at(-2), 7)[0]?.value;
  assert.ok(usage, 'usage message precedes the stop chunk');
  assert.equal(num(usage, 2), 21);
  assert.equal(num(usage, 3), 7);
  assert.equal(str(usage, 7), str(result.messages.at(-2), 1));
  assert.equal(str(usage, 9), 'local-cpa-lead');
  assert.equal(num(result.messages.at(-1), 5), 2);
  assert.equal(str(result.messages.at(-1), 23), 'local-cpa-lead');
});

test('Chat forwards usage after finish_reason and accepts a real zero', async t => {
  const app = await bridge(t, async (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }));
    res.write(event({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } }));
    res.end('data: [DONE]\n\n');
  }, 'openai');
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  const usage = fields(result.messages.at(-2), 7)[0]?.value;
  assert.ok(usage, 'a reported zero still emits usage');
  assert.equal(num(usage, 2), 0);
  assert.equal(num(usage, 3), 0);
  assert.equal(num(result.messages.at(-1), 5), 2);
});

test('usage is suppressed for missing, partial, fractional, negative and oversized snapshots', async t => {
  const cases = [
    { prompt_tokens: 5 },
    { completion_tokens: 5 },
    { prompt_tokens: 5.5, completion_tokens: 5 },
    { prompt_tokens: -1, completion_tokens: 5 },
    { prompt_tokens: Number.MAX_SAFE_INTEGER + 2, completion_tokens: 5 },
    { prompt_tokens: 5, completion_tokens: Number.MAX_SAFE_INTEGER + 2 }
  ];
  for (const usage of cases) {
    const app = await bridge(t, async (_, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(event({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }));
      res.write(event({ choices: [], usage }));
      res.end('data: [DONE]\n\n');
    }, 'openai');
    const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
    assert.equal(result.messages.flatMap(message => fields(message, 7)).length, 0, JSON.stringify(usage));
    assert.equal(num(result.messages.at(-1), 5), 2, JSON.stringify(usage));
  }
});

test('repeated snapshots replace rather than merge and a later invalid snapshot suppresses usage', async t => {
  const app = await bridge(t, async (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] }));
    res.write(event({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 40 } }));
    res.write(event({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 4 } }));
    res.end('data: [DONE]\n\n');
  }, 'openai');
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  const usages = result.messages.flatMap(message => fields(message, 7));
  assert.equal(usages.length, 1);
  assert.equal(num(usages[0].value, 2), 11);
  assert.equal(num(usages[0].value, 3), 4);

  const partial = await bridge(t, async (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] }));
    res.write(event({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } }));
    res.write(event({ choices: [], usage: { prompt_tokens: 5 } }));
    res.end('data: [DONE]\n\n');
  }, 'openai');
  const replaced = unpack(Buffer.from(await (await fetch(partial.url)).arrayBuffer()));
  assert.equal(replaced.messages.flatMap(message => fields(message, 7)).length, 0);
  assert.equal(num(replaced.messages.at(-1), 5), 2);
});

test('stop chunk writes the model uid to actual_model_uid and never to field 20', async t => {
  const app = await bridge(t, async (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(event({ type: 'response.completed', response: { status: 'completed', output: [] } }));
  });
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  const stop = result.messages.at(-1);
  assert.equal(str(stop, 23), 'local-cpa-lead');
  assert.equal(fields(stop, 20).length, 0);
});

test('an explicitly present malformed usage clears a previous valid snapshot', async t => {
  const run = async mutate => {
    const app = await bridge(t, async (_, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(event({ choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] }));
      res.write(event({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } }));
      res.write(event({ choices: [], usage: mutate }));
      res.end('data: [DONE]\n\n');
    }, 'openai');
    return unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  };
  for (const malformed of [7, 'usage', null]) {
    const result = await run(malformed);
    assert.equal(result.messages.flatMap(message => fields(message, 7)).length, 0, JSON.stringify(malformed));
    assert.equal(num(result.messages.at(-1), 5), 2, JSON.stringify(malformed));
  }
});

test('events without a usage property retain the latest valid snapshot', async t => {
  const app = await bridge(t, async (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ choices: [], usage: { prompt_tokens: 13, completion_tokens: 6 } }));
    res.write(event({ choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] }));
    res.write(event({ choices: [] }));
    res.end('data: [DONE]\n\n');
  }, 'openai');
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  const usages = result.messages.flatMap(message => fields(message, 7));
  assert.equal(usages.length, 1);
  assert.equal(num(usages[0].value, 2), 13);
  assert.equal(num(usages[0].value, 3), 6);
});

// --- Responses custom tools (native fields 9-11) ---

function customToolRequest(extra = []) {
  return Buffer.concat([
    s(21, 'local-model'), m(3, Buffer.concat([v(2, 1), s(3, 'hi')])),
    m(10, Buffer.concat([s(1, 'apply_patch'), s(2, 'Edit files'), s(3, '{}'), ...extra])),
  ]);
}

test('custom tool declaration emits type custom with grammar format when complete', () => {
  const request = parseChat(customToolRequest([v(9, 1), s(10, 'start: "a"'), s(11, 'lark')]));
  const body = buildRequestBody(request, { model: 'm' }, { apiFormat: 'openai-responses' });
  assert.deepEqual(body.tools[0], {
    type: 'custom', name: 'apply_patch', description: 'Edit files',
    format: { type: 'grammar', definition: 'start: "a"', syntax: 'lark' }
  });
});

test('custom tool without syntax emits no format instead of guessing', () => {
  const request = parseChat(customToolRequest([v(9, 1), s(10, 'start: "a"')]));
  const body = buildRequestBody(request, { model: 'm' }, { apiFormat: 'openai-responses' });
  assert.equal(body.tools[0].type, 'custom');
  assert.equal('format' in body.tools[0], false);
});

test('custom tool with an unrecognized syntax emits no format', () => {
  const request = parseChat(customToolRequest([v(9, 1), s(10, 'x'), s(11, 'yaml')]));
  const body = buildRequestBody(request, { model: 'm' }, { apiFormat: 'openai-responses' });
  assert.equal(body.tools[0].type, 'custom');
  assert.equal('format' in body.tools[0], false);
});

test('a tool without is_custom_tool stays a function with the strict flag intact', () => {
  const request = parseChat(customToolRequest([v(12, 1)]));
  const body = buildRequestBody(request, { model: 'm' }, { apiFormat: 'openai-responses' });
  assert.equal(body.tools[0].type, 'function');
  assert.equal(body.tools[0].strict, true);
});

test('custom tools stay function-shaped under openai and anthropic formats', () => {
  const request = parseChat(customToolRequest([v(9, 1), s(10, 'g'), s(11, 'lark')]));
  const chat = buildRequestBody(request, { model: 'm' }, { apiFormat: 'openai' });
  assert.equal(chat.tools[0].type, 'function');
  const anthropic = buildRequestBody(request, { model: 'm' }, { apiFormat: 'anthropic' });
  assert.equal(anthropic.tools[0].type, undefined);
  assert.equal('strict' in anthropic.tools[0], false);
  assert.ok(anthropic.tools[0].input_schema);
});

test('a custom tool call relays raw input verbatim, including non-JSON', async t => {
  const raw = '*** Begin Patch\n*** Update File: a.txt\n+line\n*** End Patch';
  const app = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ type: 'response.output_item.added', output_index: 0, item: { type: 'custom_tool_call', id: 'ctc1', call_id: 'cc1', name: 'apply_patch' } }));
    res.write(event({ type: 'response.custom_tool_call_input.delta', output_index: 0, item_id: 'ctc1', delta: '*** Begin' }));
    res.write(event({ type: 'response.custom_tool_call_input.done', output_index: 0, item_id: 'ctc1', input: raw }));
    res.write(event({ type: 'response.completed', response: { status: 'completed', output: [] } }));
    res.end();
  });
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  const tools = result.messages.flatMap(message => fields(message, 6)).map(f => {
    const calls = [];
    for (let o = 0; o < f.value.length;) {
      const tag = f.value[o], len = f.value.readUInt32BE(o + 1);
      calls.push(f.value.subarray(o + 5, o + 5 + len)); o += 5 + len;
    }
    return calls;
  }).flat();
  const args = tools.map(call => str(call, 3));
  assert.equal(tools.length, 1);
  assert.equal(str(tools[0], 2), 'apply_patch');
  assert.equal(args[0], raw, 'raw non-JSON input reaches the ACP tool call verbatim');
  assert.equal(num(result.messages.at(-1), 5), 10);
  assert.equal(app.logs.find(e => e.event === 'chat-error'), undefined);
});

// --- responsesState envelope and replay ---

const STATE_PREFIX = 'dfbyok-responses-v1:';
const REASONING_ITEM = { type: 'reasoning', id: 'r1', encrypted_content: 'enc-abc', summary: [] };
const MESSAGE_ITEM = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] };
const CALL_ITEM = { type: 'function_call', call_id: 'c9', name: 'shell', arguments: '{"cmd":"ls"}' };

async function upstreamFixture(t, events) {
  const bodies = [];
  const upstream = await server(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(events.join(''));
  }, t);
  return { bodies, baseUrl: `${upstream.url}/v1` };
}

async function stateSession(t, provider, request, fixture) {
  const proxy = await server((req, res) => {
    serveChat({ request: parseChat(request), route: { model: 'm', uid: 'u' },
      provider: { ...provider, baseUrl: fixture.baseUrl, apiKey: provider.apiKey || 'k' }, res });
  }, t);
  const response = await fetch(proxy.url);
  return unpack(Buffer.from(await response.arrayBuffer()));
}

const TURN_EVENTS = [
  event({ type: 'response.output_item.added', output_index: 0, item: REASONING_ITEM }),
  event({ type: 'response.output_item.done', output_index: 0, item: REASONING_ITEM }),
  event({ type: 'response.output_item.added', output_index: 1, item: MESSAGE_ITEM }),
  event({ type: 'response.output_item.done', output_index: 1, item: MESSAGE_ITEM }),
  event({ type: 'response.completed', response: { status: 'completed', output: [REASONING_ITEM, MESSAGE_ITEM] } }),
];

function decodeSignature(messages) {
  const sigs = messages.map(message => str(message, 10)).filter(Boolean);
  return { sigs, states: sigs.map(sig => JSON.parse(Buffer.from(sig.slice(STATE_PREFIX.length), 'base64url').toString('utf8'))) };
}

test('responsesState off (default): no include/store, no signature, no replay', async t => {
  const signature = STATE_PREFIX + Buffer.from(JSON.stringify({ scope: 'x', items: [MESSAGE_ITEM] })).toString('base64url');
  const request = Buffer.concat([
    s(21, 'local-model'), nativeMessage(1, 'user'),
    nativeMessage(2, 'done', [s(12, signature)]),
    nativeMessage(1, 'again'),
  ]);
  const fixture = await upstreamFixture(t, TURN_EVENTS);
  const result = await stateSession(t, { apiFormat: 'openai-responses' }, request, fixture);
  assert.equal('include' in fixture.bodies[0], false, 'off: no include');
  assert.equal('store' in fixture.bodies[0], false, 'off: no store');
  assert.equal(decodeSignature(result.messages).sigs.length, 0, 'off: no state signature emitted');
  const input = fixture.bodies[0].input;
  assert.equal(input.filter(item => item?.type === 'reasoning').length, 0, 'off: envelope is never replayed');
});

test('responsesState on: body gains store:false and encrypted-content include', async t => {
  const provider = { id: 'p1', apiFormat: 'openai-responses', responsesState: true };
  const fixture = await upstreamFixture(t, TURN_EVENTS);
  const request = Buffer.concat([s(21, 'local-model'), nativeMessage(1, 'user')]);
  const result = await stateSession(t, provider, request, fixture);
  assert.equal(fixture.bodies[0].store, false);
  assert.deepEqual(fixture.bodies[0].include, ['reasoning.encrypted_content']);
  const { sigs, states } = decodeSignature(result.messages);
  assert.equal(sigs.length, 1);
  const signatureIndex = result.messages.findIndex(message => str(message, 10));
  const stopIndex = result.messages.findIndex(message => num(message, 5) === 2);
  assert.ok(signatureIndex >= 0 && signatureIndex < stopIndex, 'signature precedes the stop chunk');
  const { createHash } = require('node:crypto');
  const scope = createHash('sha256').update(JSON.stringify(['p1', fixture.baseUrl, 'k', 'm'])).digest('hex');
  assert.equal(states[0].scope, scope);
  assert.deepEqual(states[0].items, [REASONING_ITEM, MESSAGE_ITEM]);
});

test('responsesState replay restores items in order before the assistant text', async t => {
  const provider = { id: 'p1', apiFormat: 'openai-responses', responsesState: true };
  const fixture = await upstreamFixture(t, TURN_EVENTS);
  const first = await stateSession(t, provider, Buffer.concat([s(21, 'local-model'), nativeMessage(1, 'user')]), fixture);
  const envelope = decodeSignature(first.messages).sigs[0];
  await stateSession(t, provider, Buffer.concat([
    s(21, 'local-model'), nativeMessage(1, 'user'),
    nativeMessage(2, 'done', [s(12, envelope)]),
    nativeMessage(1, 'again'),
  ]), fixture);
  const input = fixture.bodies[1].input;
  const start = input.findIndex(item => item?.type === 'reasoning');
  assert.ok(start >= 0, 'reasoning item is replayed');
  assert.deepEqual(input.slice(start, start + 2), [REASONING_ITEM, MESSAGE_ITEM]);
});

test('replay silently degrades when scope, content or items are invalid', async t => {
  const provider = { id: 'p1', apiFormat: 'openai-responses', responsesState: true };
  const fixture = await upstreamFixture(t, TURN_EVENTS);
  const first = await stateSession(t, provider, Buffer.concat([s(21, 'local-model'), nativeMessage(1, 'user')]), fixture);
  const envelope = decodeSignature(first.messages).sigs[0];
  const requestWith = (signature, text = 'done') => Buffer.concat([
    s(21, 'local-model'), nativeMessage(1, 'user'),
    nativeMessage(2, text, [s(12, signature)]),
    nativeMessage(1, 'again'),
  ]);
  const replayed = input => input.filter(item => item?.type === 'reasoning').length;

  const edited = await stateSession(t, provider, requestWith(envelope, 'done differently'), fixture);
  assert.equal(replayed(fixture.bodies.at(-1).input), 0, 'content drift disables replay');

  const decoded = JSON.parse(Buffer.from(envelope.slice(STATE_PREFIX.length), 'base64url').toString('utf8'));
  const badScope = STATE_PREFIX + Buffer.from(JSON.stringify({ ...decoded, scope: 'deadbeef' })).toString('base64url');
  await stateSession(t, provider, requestWith(badScope), fixture);
  assert.equal(replayed(fixture.bodies.at(-1).input), 0, 'scope mismatch disables replay');

  const badItems = STATE_PREFIX + Buffer.from(JSON.stringify({ ...decoded, items: [{ type: 'mystery' }] })).toString('base64url');
  await stateSession(t, provider, requestWith(badItems), fixture);
  assert.equal(fixture.bodies.at(-1).input.filter(item => item?.type === 'mystery').length, 0, 'invalid items are not replayed');
  void edited;
});

test('an oversized or invalid-item response produces no signature chunk', async t => {
  const bigItem = { ...MESSAGE_ITEM, content: [{ type: 'output_text', text: 'x'.repeat(300 * 1024) }] };
  const provider = { apiFormat: 'openai-responses', responsesState: true };
  const bigFixture = await upstreamFixture(t, [event({ type: 'response.completed', response: { status: 'completed', output: [bigItem] } })]);
  const big = await stateSession(t, provider, Buffer.concat([s(21, 'local-model'), nativeMessage(1, 'user')]), bigFixture);
  assert.equal(decodeSignature(big.messages).sigs.length, 0, 'oversized envelope is dropped');
  const invalidFixture = await upstreamFixture(t, [event({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'reasoning', summary: [] }, MESSAGE_ITEM] } })]);
  const invalid = await stateSession(t, provider, Buffer.concat([s(21, 'local-model'), nativeMessage(1, 'user')]), invalidFixture);
  assert.equal(decodeSignature(invalid.messages).sigs.length, 0, 'missing encrypted_content drops the envelope');
});

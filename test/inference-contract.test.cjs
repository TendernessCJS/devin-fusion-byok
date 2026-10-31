'use strict';

// D2 contract matrix: terminal states and retry ownership, measured rather than
// inferred. Every case drives the real `serveChat` path against a local server
// that counts what the provider actually received, and asserts three things at
// once: what the client saw (ACP frames), what the monitor recorded, and how
// many upstream sends it took.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const wire = require('../src/protocol/wire.cjs');
const { serveChat } = require('../src/protocol/inference.cjs');
const { parseChat } = require('../src/protocol/native-chat-codec.cjs');
const { s, v, m, str, num, fields } = wire;

const ERROR_TEXT = 'Provider response could not be completed.';

class FakeRes extends EventEmitter {
  constructor({ stallAt = Infinity } = {}) {
    super();
    this.headersSent = false;
    this.destroyed = false;
    this.writableEnded = false;
    this.stallAt = stallAt;
    this.writes = 0;
    this.frames = [];
    this.headStatus = 0;
  }
  writeHead(status) { this.headersSent = true; this.headStatus = status; }
  write(chunk) { this.writes++; this.frames.push(chunk); return this.writes !== this.stallAt; }
  end(chunk) { if (chunk) this.frames.push(chunk); this.writableEnded = true; }
  destroy() { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit('close')); } return this; }
}

function nativeMessage(source, text) {
  return m(3, Buffer.concat([v(2, source), s(3, text)]));
}
function baseRequest() {
  const request = parseChat(Buffer.concat([s(21, 'local-model'), nativeMessage(1, 'user')]));
  request.tools = [{ name: 'shell', description: '', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }];
  return request;
}

function unpackFrames(frames) {
  const messages = [];
  let eos = 0;
  for (const buffer of frames) {
    for (let offset = 0; offset < buffer.length;) {
      const flags = buffer[offset];
      const length = buffer.readUInt32BE(offset + 1);
      const data = buffer.subarray(offset + 5, offset + 5 + length);
      offset += 5 + length;
      if (flags & 2) eos++;
      else messages.push(data);
    }
  }
  return { messages, eos };
}

function readOut(frames) {
  const { messages, eos } = unpackFrames(frames);
  const usage = messages.flatMap(message => fields(message, 7).map(field => ({
    input: Number(num(field.value, 2)), output: Number(num(field.value, 3))
  })));
  return {
    text: messages.map(message => str(message, 3) || '').join(''),
    thinking: messages.map(message => str(message, 9) || '').join(''),
    tools: messages.flatMap(message => fields(message, 6).map(field => ({ id: str(field.value, 1), name: str(field.value, 2) }))),
    usage,
    stop: messages.length ? num(messages.at(-1), 5) : null,
    eos
  };
}

const data = value => `data: ${JSON.stringify(value)}\n\n`;
const sse = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const DONE = 'data: [DONE]\n\n';

async function listen(t, handler) {
  const instance = http.createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return `http://127.0.0.1:${instance.address().port}`;
}

// One scenario = one upstream behaviour + one expected observation. The server
// always records the parsed body of every send it received, so `hits` is a real
// wire count, not a counter inside the code under test.
async function run(t, { format, frames, handler, request = baseRequest(), res = new FakeRes(), signal = null, timeouts = {}, cacheSupport = null }) {
  const received = [], logs = [], metrics = [];
  const url = await listen(t, async (req, up) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    received.push(body);
    if (handler) return handler({ attempt: received.length, body, up });
    up.writeHead(200, { 'content-type': 'text/event-stream' });
    up.end(typeof frames === 'function' ? frames(received.length) : frames);
  });
  const result = await serveChat({
    request, route: { model: 'm', uid: 'u' }, provider: { baseUrl: url, apiKey: 'k', apiFormat: format },
    res, signal, log: event => logs.push(event), timeouts, cacheSupport, onMetrics: value => metrics.push(value)
  });
  return { result, res, logs, metrics, received, out: readOut(res.frames) };
}

function assertObservation(observation, expect) {
  const { result, metrics, logs, out, received } = observation;
  if (expect.hits !== undefined) assert.equal(received.length, expect.hits, 'upstream send count');
  assert.equal(metrics.length, 1, 'metrics settle exactly once');
  if (expect.code) {
    assert.equal(result.error, true);
    assert.equal(result.code, expect.code);
    assert.equal(metrics[0].status, 'error');
    assert.equal(metrics[0].code, expect.code);
    assert.equal(logs.find(event => event.event === 'chat-error')?.code, expect.code);
  } else {
    assert.equal(result.error, undefined, `unexpected failure: ${result.code}`);
    assert.equal(metrics[0].status, 'success');
  }
  if (expect.stop !== undefined) assert.equal(out.stop, expect.stop, 'ACP stop reason');
  if (expect.text !== undefined) assert.equal(out.text, expect.text);
  if (expect.endsWith !== undefined) assert.ok(out.text.endsWith(expect.endsWith), `text ends with ${expect.endsWith}: ${out.text}`);
  if (expect.thinking !== undefined) assert.equal(out.thinking, expect.thinking);
  if (expect.tools !== undefined) assert.deepEqual(out.tools, expect.tools);
  if (expect.usage !== undefined) assert.deepEqual(out.usage, expect.usage);
  if (expect.usageComplete !== undefined) assert.equal(metrics[0].usageComplete, expect.usageComplete);
  assert.equal(out.eos, 1, 'the downstream stream is closed exactly once');
}

// ---------------------------------------------------------------------------
// Responses: `response.completed` / `response.incomplete` are the authorities.
// ---------------------------------------------------------------------------

const COMPLETED = response => data({ type: 'response.completed', response: { status: 'completed', output: [], ...response } });
const INCOMPLETE = reason => data({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason }, output: [] } });
const RESP_DELTA = value => data({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: value });

const RESPONSES = [
  { name: 'completed with usage', frames: [RESP_DELTA('hi'), COMPLETED({ usage: { input_tokens: 10, output_tokens: 5 } })],
    expect: { text: 'hi', stop: 2, usage: [{ input: 10, output: 5 }], usageComplete: true, hits: 1 } },
  { name: 'completed without usage keeps usageComplete false', frames: [RESP_DELTA('hi'), COMPLETED({})],
    expect: { text: 'hi', stop: 2, usage: [], usageComplete: false, hits: 1 } },
  { name: 'legal truncation max_output_tokens', frames: [RESP_DELTA('hi'), INCOMPLETE('max_output_tokens')],
    expect: { text: 'hi', stop: 3, usageComplete: false, hits: 1 } },
  { name: 'content_filter truncation maps to 11', frames: [RESP_DELTA('hi'), INCOMPLETE('content_filter')],
    expect: { text: 'hi', stop: 11, hits: 1 } },
  { name: 'refusal is delivered as ordinary text', frames: [
    data({ type: 'response.refusal.delta', output_index: 0, content_index: 0, delta: 'no' }), COMPLETED({})],
    expect: { text: 'no', stop: 2, hits: 1 } },
  { name: 'error frame before output', frames: [data({ type: 'error', error: { code: 'server_error' } })],
    expect: { code: 'upstream_stream_error', stop: 13, text: ERROR_TEXT, hits: 1 } },
  { name: 'error frame after output keeps the delivered text', frames: [
    RESP_DELTA('hi'), data({ type: 'error', error: { code: 'server_error' } })],
    expect: { code: 'upstream_stream_error', stop: 13, text: 'hi' + ERROR_TEXT, hits: 1 } },
  { name: 'EOF without a terminal event is an incomplete stream', frames: [RESP_DELTA('hi')],
    expect: { code: 'upstream_stream_incomplete', stop: 13, text: 'hi' + ERROR_TEXT, hits: 1 } },
  { name: 'invalid tool JSON fails before any tool block is emitted', frames: [
    data({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'shell' } }),
    data({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc1', delta: '{"cmd":' }),
    data({ type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc1', arguments: '{"cmd":' }),
    COMPLETED({})],
    expect: { code: 'upstream_invalid_tool', stop: 13, tools: [], text: 'Provider response format is invalid.', hits: 1 } },
  { name: 'valid tool JSON is emitted once with its id', frames: [
    data({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'shell' } }),
    data({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc1', delta: '{"cmd":"ls"}' }),
    data({ type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc1', arguments: '{"cmd":"ls"}' }),
    COMPLETED({})],
    expect: { stop: 10, tools: [{ id: 'c1', name: 'shell' }], text: '', hits: 1 } },
  { name: 'thinking-only output is a success', frames: [
    data({ type: 'response.reasoning_text.delta', output_index: 0, content_index: 0, delta: 'think' }), COMPLETED({})],
    expect: { text: '', thinking: 'think', stop: 2, hits: 1 } },
  { name: 'terminal event with no output at all fails', frames: [COMPLETED({})],
    expect: { code: 'upstream_empty_output', stop: 13, text: 'Provider returned no output.', hits: 1 } },
  { name: 'frames after the terminal event are never read', frames: [RESP_DELTA('a'), COMPLETED({}), RESP_DELTA('b'), COMPLETED({})],
    expect: { text: 'a', stop: 2, hits: 1 } }
];

for (const scenario of RESPONSES) {
  test(`responses terminal: ${scenario.name}`, { timeout: 5000 }, async t => {
    assertObservation(await run(t, { format: 'openai-responses', frames: scenario.frames.join('') }), scenario.expect);
  });
}

// ---------------------------------------------------------------------------
// Chat completions: `finish_reason` is terminal, `[DONE]` closes the stream,
// and a usage chunk may arrive between them.
// ---------------------------------------------------------------------------

const CHAT_FINISH = (reason, delta = {}) => data({ choices: [{ index: 0, delta, finish_reason: reason }] });
const CHAT_DELTA = value => data({ choices: [{ index: 0, delta: { content: value } }] });
const CHAT_USAGE = usage => data({ choices: [], usage });

const CHAT = [
  { name: 'normal finish', frames: [CHAT_DELTA('hi'), CHAT_FINISH('stop'), DONE],
    expect: { text: 'hi', stop: 2, usage: [], usageComplete: false, hits: 1 } },
  { name: 'finish_reason then usage then DONE keeps the usage', frames: [
    CHAT_DELTA('hi'), CHAT_FINISH('stop'),
    CHAT_USAGE({ prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0 } }), DONE],
    expect: { text: 'hi', stop: 2, usage: [{ input: 12, output: 3 }], usageComplete: true, hits: 1 } },
  { name: 'length maps to 3', frames: [CHAT_DELTA('hi'), CHAT_FINISH('length'), DONE],
    expect: { text: 'hi', stop: 3, hits: 1 } },
  { name: 'content_filter maps to 11', frames: [
    data({ choices: [{ index: 0, delta: { refusal: 'no' }, finish_reason: 'content_filter' }] }), DONE],
    expect: { text: 'no', stop: 11, hits: 1 } },
  { name: 'error frame before output', frames: [data({ error: { message: 'boom' } })],
    expect: { code: 'upstream_stream_error', stop: 13, text: ERROR_TEXT, hits: 1 } },
  { name: 'late error between finish_reason and DONE is still a failure', frames: [
    CHAT_DELTA('hi'), CHAT_FINISH('stop'), data({ error: { message: 'late' } }), DONE],
    expect: { code: 'upstream_stream_error', stop: 13, text: 'hi' + ERROR_TEXT, hits: 1 } },
  { name: 'EOF without finish_reason or DONE is incomplete', frames: [CHAT_DELTA('hi')],
    expect: { code: 'upstream_stream_incomplete', stop: 13, text: 'hi' + ERROR_TEXT, hits: 1 } },
  { name: 'DONE without finish_reason keeps the end_turn compatibility', frames: [CHAT_DELTA('hi'), DONE],
    expect: { text: 'hi', stop: 2, hits: 1 } },
  { name: 'invalid tool JSON fails before the tool block', frames: [
    data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'shell', arguments: '{"cmd":' } }] } }] }),
    CHAT_FINISH('tool_calls'), DONE],
    expect: { code: 'upstream_invalid_tool', stop: 13, tools: [], text: 'Provider response format is invalid.', hits: 1 } },
  { name: 'thinking-only output is a success', frames: [
    data({ choices: [{ index: 0, delta: { reasoning_content: 'think' } }] }), CHAT_FINISH('stop'), DONE],
    expect: { text: '', thinking: 'think', stop: 2, hits: 1 } },
  { name: 'signature marker alone is not output', frames: [
    data({ choices: [{ index: 0, delta: { signature: 'sig' } }] }), CHAT_FINISH('stop'), DONE],
    expect: { code: 'upstream_empty_output', stop: 13, text: 'Provider returned no output.', hits: 1 } },
  { name: 'present but null usage clears the snapshot', frames: [
    CHAT_DELTA('hi'), CHAT_FINISH('stop'),
    CHAT_USAGE({ prompt_tokens: 7, completion_tokens: 2 }), CHAT_USAGE(null), DONE],
    expect: { text: 'hi', stop: 2, usage: [], usageComplete: false, hits: 1 } },
  { name: 'null usage before the final totals keeps the totals', frames: [
    data({ choices: [{ index: 0, delta: { content: 'hi' }, usage: null }] }), CHAT_FINISH('stop'),
    CHAT_USAGE(null), CHAT_USAGE({ prompt_tokens: 7, completion_tokens: 2 }), DONE],
    expect: { text: 'hi', stop: 2, usage: [{ input: 7, output: 2 }], usageComplete: true, hits: 1 } }
];

for (const scenario of CHAT) {
  test(`chat terminal: ${scenario.name}`, { timeout: 5000 }, async t => {
    assertObservation(await run(t, { format: 'openai', frames: scenario.frames.join('') }), scenario.expect);
  });
}

// ---------------------------------------------------------------------------
// Anthropic: `message_delta.stop_reason` is terminal, `message_stop` closes.
// ---------------------------------------------------------------------------

const A_START = sse({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 0 } } });
const A_TEXT = value => sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } });
const A_REASON = (reason, usage = { output_tokens: 5 }) => sse({ type: 'message_delta', delta: { stop_reason: reason }, usage });
const A_STOP = sse({ type: 'message_stop' });

const ANTHROPIC = [
  { name: 'normal end_turn with merged usage', frames: [A_START, A_TEXT('hi'), A_REASON('end_turn'), A_STOP],
    expect: { text: 'hi', stop: 2, usage: [{ input: 10, output: 5 }], usageComplete: true, hits: 1 } },
  { name: 'max_tokens maps to 3', frames: [A_START, A_TEXT('hi'), A_REASON('max_tokens'), A_STOP],
    expect: { text: 'hi', stop: 3, hits: 1 } },
  { name: 'refusal maps to 11', frames: [A_START, A_TEXT('no'), A_REASON('refusal'), A_STOP],
    expect: { text: 'no', stop: 11, hits: 1 } },
  { name: 'error event fails the stream', frames: [A_START, A_TEXT('hi'), sse({ type: 'error', error: { type: 'overloaded_error' } })],
    expect: { code: 'upstream_stream_error', stop: 13, text: 'hi' + ERROR_TEXT, hits: 1 } },
  { name: 'EOF without message_stop is incomplete', frames: [A_START, A_TEXT('hi')],
    expect: { code: 'upstream_stream_incomplete', stop: 13, text: 'hi' + ERROR_TEXT, hits: 1 } },
  { name: 'message_stop without a stop_reason still ends the turn', frames: [A_START, A_TEXT('hi'), A_STOP],
    expect: { text: 'hi', stop: 2, hits: 1 } },
  { name: 'invalid tool JSON fails before the tool block', frames: [
    A_START,
    sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'shell' } }),
    sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"cmd":' } }),
    sse({ type: 'content_block_stop', index: 1 }), A_REASON('tool_use'), A_STOP],
    expect: { code: 'upstream_invalid_tool', stop: 13, tools: [], text: 'Provider response format is invalid.', hits: 1 } },
  { name: 'valid tool JSON is emitted once with its id', frames: [
    A_START,
    sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'shell' } }),
    sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' } }),
    sse({ type: 'content_block_stop', index: 1 }), A_REASON('tool_use'), A_STOP],
    expect: { stop: 10, tools: [{ id: 'tu_1', name: 'shell' }], text: '', hits: 1 } },
  { name: 'thinking-only output is a success', frames: [
    A_START,
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'think' } }),
    A_REASON('end_turn'), A_STOP],
    expect: { text: '', thinking: 'think', stop: 2, hits: 1 } },
  { name: 'signature delta alone is not output', frames: [
    A_START,
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
    A_REASON('end_turn'), A_STOP],
    expect: { code: 'upstream_empty_output', stop: 13, text: 'Provider returned no output.', hits: 1 } }
];

for (const scenario of ANTHROPIC) {
  test(`anthropic terminal: ${scenario.name}`, { timeout: 5000 }, async t => {
    assertObservation(await run(t, { format: 'anthropic', frames: scenario.frames.join('') }), scenario.expect);
  });
}

// ---------------------------------------------------------------------------
// Budget matrix: who owns which retry, measured by real send counts.
// ---------------------------------------------------------------------------

function json400(up, message) {
  up.writeHead(400, { 'content-type': 'application/json' });
  up.end(JSON.stringify({ error: { message } }));
}

test('budget: a degraded resend is not wrapped by the connection retry', { timeout: 5000 }, async t => {
  const logs = [];
  const request = baseRequest();
  request.toolChoice = { name: 'shell' };
  const { received, result } = await run(t, {
    format: 'openai-responses', request, timeouts: { retryPauseMs: 0 },
    handler: ({ attempt, up }) => {
      if (attempt === 1) return json400(up, 'tool_choice unsupported in thinking mode');
      up.destroy();
    }
  });
  // The degraded send is a plain send: a connection failure there ends the
  // request instead of re-entering the four-attempt connect budget.
  assert.equal(received.length, 2);
  assert.equal(received[1].tool_choice, 'auto');
  assert.equal(result.error, true);
  assert.equal(result.code, 'upstream_network');
  assert.equal(logs.find(event => event.event === 'upstream-retry'), undefined);
});

test('budget: a 400 naming two degrade fields takes only the first branch', { timeout: 5000 }, async t => {
  const request = baseRequest();
  request.toolChoice = { name: 'shell' };
  const { received, result } = await run(t, {
    format: 'openai-responses', request,
    handler: ({ attempt, up }) => {
      if (attempt === 1) return json400(up, 'tool_choice and store are both unsupported');
      up.writeHead(200, { 'content-type': 'text/event-stream' });
      up.end([RESP_DELTA('hi'), COMPLETED({})].join(''));
    }
  });
  assert.equal(received.length, 2);
  assert.equal(received[1].tool_choice, 'auto');
  assert.equal('store' in received[1], true, 'the store field survives: only the first branch ran');
  assert.equal(result.error, undefined);
});

test('budget: anthropic forced choice sends at most three times', { timeout: 5000 }, async t => {
  const request = baseRequest();
  request.toolChoice = { name: 'shell' };
  const { received, logs, result } = await run(t, {
    format: 'anthropic', request,
    handler: ({ attempt, up }) => {
      if (attempt < 3) return json400(up, 'thinking mode does not support this tool_choice');
      up.writeHead(200, { 'content-type': 'text/event-stream' });
      up.end([A_START, A_TEXT('hi'), A_REASON('end_turn'), A_STOP].join(''));
    }
  });
  assert.equal(received.length, 3);
  assert.deepEqual(received[1].thinking, { type: 'disabled' });
  assert.deepEqual(received[2].tool_choice, { type: 'auto' });
  assert.equal(logs.filter(event => event.event === 'provider-degraded').length, 1);
  assert.equal(result.error, undefined);
});

test('budget: a first-header timeout sends once', { timeout: 5000 }, async t => {
  const { received, result, logs } = await run(t, {
    format: 'openai-responses', timeouts: { firstResponseMs: 150 },
    handler: ({ up }) => { up.writeHead(200, { 'content-type': 'text/event-stream' }); }
  });
  assert.equal(received.length, 1);
  assert.equal(result.error, true);
  assert.equal(result.code, 'upstream_timeout');
  assert.equal(logs.find(event => event.event === 'chat-error').code, 'upstream_timeout');
});

test('budget: an idle timeout mid-stream keeps delivered text and sends once', { timeout: 5000 }, async t => {
  const { received, result, out } = await run(t, {
    format: 'openai-responses', timeouts: { idleMs: 150 },
    handler: ({ up }) => {
      up.writeHead(200, { 'content-type': 'text/event-stream' });
      up.write(RESP_DELTA('hi'));
    }
  });
  assert.equal(received.length, 1);
  assert.equal(result.error, true);
  assert.equal(result.code, 'upstream_timeout');
  assert.equal(out.text.startsWith('hi'), true);
});

test('budget: a downstream backpressure timeout never re-sends upstream', { timeout: 5000 }, async t => {
  const res = new FakeRes({ stallAt: 1 });
  const { received, result, logs, metrics } = await run(t, {
    format: 'openai-responses', res, timeouts: { drainMs: 80 },
    frames: [RESP_DELTA('a'), RESP_DELTA('b'), COMPLETED({})].join('')
  });
  assert.equal(received.length, 1);
  assert.equal(result.aborted, true);
  assert.equal(metrics[0].code, 'client_cancelled');
  assert.equal(logs.find(event => event.event === 'chat-aborted')?.reason, 'backpressure-timeout');
  assert.equal(logs.find(event => event.event === 'chat-error'), undefined);
});

test('budget: a client abort during the retry pause starts no further send', { timeout: 5000 }, async t => {
  const controller = new AbortController();
  const { received, result, metrics } = await run(t, {
    format: 'openai-responses', signal: controller.signal, timeouts: { retryPauseMs: 400 },
    handler: ({ up }) => {
      up.socket.destroy();
      setTimeout(() => controller.abort(), 50);
    }
  });
  assert.equal(received.length, 1, 'the paused retry never reached the provider');
  assert.equal(result.aborted, true);
  assert.equal(metrics[0].status, 'cancelled');
  assert.equal(metrics[0].code, 'client_cancelled');
});

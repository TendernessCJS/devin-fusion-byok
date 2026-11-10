'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createStreamProcessor } = require('../src/protocol/stream-processor.cjs');
const { fields, str, num } = require('../src/protocol/wire.cjs');

const id = 'req-1', uid = 'model-1';
const collector = () => {
  const frames = [];
  return { emit: async frame => { frames.push(frame); }, frames };
};
const texts = frames => frames.map(frame => str(frame, 3)).filter(Boolean);
const stops = frames => frames.filter(frame => num(frame, 5) > 0 && str(frame, 3) === '');

test('text and thinking deltas emit in order for the chat lane', async () => {
  const { emit, frames } = collector();
  const stream = createStreamProcessor({ id, uid, chat: true, emit });
  const event = delta => stream.event({ type: 'message', data: { choices: [{ index: 0, delta }] } });
  await event({ content: 'he' });
  await event({ reasoning_content: 'r' });
  await event({ content: 'llo' });
  await event({ content: '' });
  await stream.event({ type: 'message', data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } });
  const done = await stream.finish();
  assert.deepEqual(done, { toolNames: [], toolIds: [] });
  assert.equal(frames.length, 4);
  assert.equal(str(frames[0], 3), 'he');
  assert.equal(str(frames[1], 9), 'r', 'the second frame is the thinking delta');
  assert.equal(str(frames[2], 3), 'llo');
  assert.equal(num(frames[3], 5), 2);
  assert.equal(str(frames[3], 23), uid);
  assert.ok(frames.every(frame => str(frame, 1) === id));
});

test('a done-only message validates its prefix and a mismatch throws', async () => {
  const { emit, frames } = collector();
  const stream = createStreamProcessor({ id, uid, chat: false, emit });
  await stream.event({ type: 'response.output_item.added', data: { output_index: 0, item: { type: 'message' } } });
  await stream.event({ type: 'response.output_text.delta', data: { output_index: 0, content_index: 0, delta: 'he' } });
  await assert.rejects(
    stream.event({ type: 'response.output_text.done', data: { output_index: 0, content_index: 0, text: 'goodbye' } }),
    error => error.code === 'upstream_text_mismatch');
  await stream.event({ type: 'response.output_text.done', data: { output_index: 0, content_index: 0, text: 'hello' } });
  await stream.event({ type: 'response.completed', data: { response: { status: 'completed' } } });
  await stream.finish();
  assert.equal(frames.length, 3);
  assert.deepEqual(texts(frames), ['he', 'llo'], 'the done tail emits only the delta after the earlier prefix');
  assert.equal(num(frames[2], 5), 2);
});

test('parallel tool calls emit one ordered tool chunk with verbatim arguments', async () => {
  const { emit, frames } = collector();
  const stream = createStreamProcessor({ id, uid, chat: false, emit });
  const args0 = '{ "a" : 1 }', args1 = '{"b":[1,2]}';
  for (const [index, callId, name, args] of [[1, 'c2', 'beta', args1], [0, 'c1', 'alpha', args0]]) {
    await stream.event({ type: 'response.output_item.done', data: { output_index: index,
      item: { type: 'function_call', id: callId, call_id: callId, name, arguments: args } } });
  }
  await stream.event({ type: 'response.completed', data: { response: { status: 'completed' } } });
  const done = await stream.finish();
  assert.deepEqual(done, { toolNames: ['alpha', 'beta'], toolIds: ['c1', 'c2'] });
  assert.equal(frames.length, 2);
  const tools = fields(frames[0], 6).map(field => ({
    id: str(field.value, 1), name: str(field.value, 2), args: str(field.value, 3), custom: num(field.value, 6) }));
  assert.deepEqual(tools, [
    { id: 'c1', name: 'alpha', args: args0, custom: 0 },
    { id: 'c2', name: 'beta', args: args1, custom: 0 }]);
  assert.equal(num(frames[1], 5), 10);
});

test('signature and redacted-thinking markers do not count as output', async () => {
  const { emit, frames } = collector();
  const stream = createStreamProcessor({ id, uid, chat: true, emit });
  await stream.event({ type: 'message', data: { choices: [{ index: 0, delta: { signature: 'sig', thinking_redacted: true } }] } });
  await stream.event({ type: 'message', data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } });
  await assert.rejects(stream.finish(), error => error.code === 'upstream_empty_output');
  assert.equal(frames.length, 2);
  assert.equal(str(frames[0], 10), 'sig');
  assert.equal(num(frames[1], 11), 1);
});

test('finish without a terminal event throws upstream_stream_incomplete', async () => {
  const { emit } = collector();
  const stream = createStreamProcessor({ id, uid, chat: false, emit });
  await stream.event({ type: 'response.output_text.delta', data: { output_index: 0, content_index: 0, delta: 'hi' } });
  await assert.rejects(stream.finish(), error => error.code === 'upstream_stream_incomplete');
});

test('a repeated finish returns the cached result and emits no more frames', async () => {
  const { emit, frames } = collector();
  const stream = createStreamProcessor({ id, uid, chat: true, emit });
  await stream.event({ type: 'message', data: { choices: [{ index: 0, delta: { content: 'hi' } }] } });
  await stream.event({ type: 'message', data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } });
  const first = await stream.finish();
  const size = frames.length;
  const second = await stream.finish();
  assert.equal(second, first);
  assert.equal(frames.length, size);
});

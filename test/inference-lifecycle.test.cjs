'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const { serveChat } = require('../src/protocol/inference.cjs');
const { createStreamWriter } = require('../src/protocol/stream-writer.cjs');
const { readErrorDetail } = require('../src/protocol/provider-events.cjs');
const wire = require('../src/protocol/wire.cjs');
const { parseChat } = require('../src/protocol/native-chat-codec.cjs');
const { s, v, m } = wire;

function nativeMessage(source, text) {
  return m(3, Buffer.concat([v(2, source), s(3, text)]));
}
const request = () => parseChat(Buffer.concat([s(21, 'local-model'), nativeMessage(1, 'user')]));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn, deadline = 3000) {
  const start = Date.now();
  while (!fn()) { if (Date.now() - start > deadline) throw new Error('condition not met'); await tick(); }
}

// Minimal downstream stand-in: EventEmitter-based ServerResponse clone that can
// be told which write() call should report backpressure and never drain.
class FakeRes extends EventEmitter {
  constructor({ stallAt = Infinity } = {}) {
    super();
    this.headersSent = false;
    this.destroyed = false;
    this.writableEnded = false;
    this.stallAt = stallAt;
    this.writes = 0;
    this.frames = [];
    this.destroyCalls = 0;
    this.headStatus = 0;
  }
  writeHead(status) { this.headersSent = true; this.headStatus = status; }
  write(chunk) { this.writes++; this.frames.push(chunk); return this.writes !== this.stallAt; }
  end() { this.writableEnded = true; }
  destroy() { this.destroyCalls++; if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit('close')); } return this; }
  listenerNoise() { return this.listenerCount('drain') + this.listenerCount('close') + this.listenerCount('error'); }
}

async function server(handler, t) {
  const instance = http.createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return { url: `http://127.0.0.1:${instance.address().port}` };
}

async function chat(t, upstreamHandler, { res = new FakeRes(), signal = null, timeouts = {}, log = () => {}, onMetrics = () => {} } = {}) {
  const upstream = await server(upstreamHandler, t);
  const done = serveChat({ request: request(), route: { model: 'm', uid: 'u' }, provider: { baseUrl: `${upstream.url}/v1`, apiKey: 'k', apiFormat: 'openai-responses' }, res, signal, log, timeouts, onMetrics });
  return { done, res, upstream };
}

const SSE = 'data: {"type":"response.output_text.delta","delta":"hi"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n';

test('final 400 diagnostics retain the send deadline and client cancellation', { timeout: 5000 }, async t => {
  for (const cancel of [false, true]) await t.test(cancel ? 'client abort' : 'deadline', async t => {
    let hits = 0, secondHit, closed;
    const received = new Promise(resolve => { secondHit = resolve; });
    const socketClosed = new Promise(resolve => { closed = resolve; });
    const upstream = await server((req, up) => {
      req.resume();
      req.on('end', () => {
        hits++;
        up.writeHead(400, { 'content-type': 'application/json' });
        if (hits === 1) up.end('{"error":{"message":"tool_choice unsupported"}}');
        else {
          up.on('close', closed);
          up.write('{"error":{"message":"synthetic-body-sentinel');
          secondHit();
        }
      });
    }, t);
    const controller = new AbortController();
    const res = new FakeRes(), metrics = [], logs = [];
    const input = request();
    input.tools = [{ name: 'x', description: '', parameters: { type: 'object', properties: {} } }];
    input.toolChoice = { name: 'x' };
    const done = serveChat({ request: input, route: { model: 'm', uid: 'u' },
      provider: { baseUrl: upstream.url, apiFormat: 'openai' }, res, signal: controller.signal,
      timeouts: { firstResponseMs: 250, idleMs: 250 },
      onMetrics: value => metrics.push(value), log: event => logs.push(event) });
    t.after(() => controller.abort());
    await received;
    if (cancel) controller.abort();
    const result = await done;
    await socketClosed;
    assert.equal(hits, 2);
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].status, cancel ? 'cancelled' : 'error');
    assert.equal(metrics[0].code, cancel ? 'client_cancelled' : 'upstream_http');
    if (cancel) assert.equal(result.aborted, true);
    else {
      assert.equal(result.code, 'upstream_http');
      const text = res.frames.map(buffer => wire.str(buffer.subarray(5), 3)).join('');
      assert.equal(text, 'Provider returned HTTP 400.');
      assert.equal(logs.find(event => event.event === 'chat-error').diagnostic, undefined);
    }
    assert.equal(JSON.stringify(logs).includes('synthetic-body-sentinel'), false);
    assert.equal(res.listenerNoise(), 0);
  });
});

test('error-frame drain failures settle as client cancellation', { timeout: 5000 }, async t => {
  for (const upstreamError of ['http', 'incomplete']) for (const mode of ['timeout', 'close', 'abort']) {
    await t.test(`${upstreamError}/${mode}`, async t => {
      const res = new FakeRes({ stallAt: upstreamError === 'http' ? 1 : 2 });
      const controller = new AbortController();
      const metrics = [], logs = [];
      let hits = 0;
      const { done } = await chat(t, (_, up) => {
        hits++;
        if (upstreamError === 'http') { up.writeHead(500); up.end('failure'); }
        else {
          up.writeHead(200, { 'content-type': 'text/event-stream' });
          up.end('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
        }
      }, { res, signal: controller.signal, timeouts: { drainMs: mode === 'timeout' ? 10 : 1000 },
        onMetrics: value => metrics.push(value), log: event => logs.push(event) });
      if (mode !== 'timeout') {
        await until(() => res.listenerCount('drain') > 0);
        if (mode === 'close') res.destroy();
        else controller.abort();
      }
      const result = await done;
      assert.equal(result.aborted, true);
      assert.equal(hits, 1);
      assert.equal(res.writes, upstreamError === 'http' ? 1 : 2);
      assert.equal(metrics.length, 1);
      assert.equal(metrics[0].status, 'cancelled');
      assert.equal(metrics[0].code, 'client_cancelled');
      const aborted = logs.filter(event => event.event === 'chat-aborted');
      assert.equal(aborted.length, 1);
      assert.equal(aborted[0].reason, mode === 'timeout' ? 'backpressure-timeout' : undefined);
      assert.equal(logs.some(event => event.event === 'chat-error'), false);
      assert.equal(res.listenerNoise(), 0);
    });
  }
});

test('a false write waits for one drain and keeps frames in order', async t => {
  const res = new FakeRes({ stallAt: 2 });
  const { done } = await chat(t, (_, up) => { up.writeHead(200, { 'content-type': 'text/event-stream' }); up.end(SSE); }, { res });
  await until(() => res.listenerCount('drain') > 0);
  const before = res.frames.length;
  res.emit('drain');
  const result = await done;
  assert.equal(result.status, 200);
  assert.ok(res.writes === res.frames.length && res.writes >= before);
  assert.ok(res.writableEnded, 'the response completed after the drain');
  assert.equal(res.listenerNoise(), 0, 'no leftover listeners');
});

test('close, error and abort during the drain wait all settle as cancelled', async t => {
  for (const mode of ['close', 'error', 'abort']) {
    const res = new FakeRes({ stallAt: 1 });
    const metrics = [];
    const controller = new AbortController();
    const { done } = await chat(t, (_, up) => { up.writeHead(200, { 'content-type': 'text/event-stream' }); up.end(SSE); }, { res, signal: controller.signal, onMetrics: value => metrics.push(value) });
    await until(() => res.listenerCount('drain') > 0);
    if (mode === 'close') res.destroy();
    else if (mode === 'error') { res.destroyed = true; res.emit('error', new Error('socket broke')); }
    else controller.abort();
    const result = await done;
    assert.equal(result.aborted, true, mode);
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].status, 'cancelled');
    assert.equal(metrics[0].code, 'client_cancelled');
    assert.equal(res.listenerNoise(), 0, mode + ' leaves no listeners');
  }
});

test('a signal aborted before the wait rejects immediately', async () => {
  const res = new FakeRes({ stallAt: 1 });
  const controller = new AbortController();
  controller.abort();
  const writer = createStreamWriter({ res, signal: controller.signal, timeoutMs: 60000 });
  await assert.rejects(writer.write(Buffer.from('x')), /Client closed/);
  writer.dispose();
  assert.equal(res.writes, 0);
});

test('a drain that never comes trips the timeout into a cancelled outcome', async t => {
  const res = new FakeRes({ stallAt: 1 });
  const metrics = [];
  const logs = [];
  const requests = [];
  const { done } = await chat(t, (req, up) => {
    requests.push(req.url);
    up.writeHead(200, { 'content-type': 'text/event-stream' });
    up.end(SSE);
  }, { res, timeouts: { drainMs: 10 }, onMetrics: value => metrics.push(value), log: event => logs.push(event) });
  const result = await done;
  assert.equal(result.aborted, true);
  assert.ok(res.destroyCalls >= 1);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].status, 'cancelled');
  assert.equal(metrics[0].code, 'client_cancelled');
  const aborted = logs.filter(event => event.event === 'chat-aborted');
  assert.equal(aborted.length, 1);
  assert.equal(aborted[0].reason, 'backpressure-timeout');
  assert.equal(requests.length, 1, 'upstream got exactly one request');
  assert.equal(res.listenerNoise(), 0);
});

test('non-timeout aborts log chat-aborted without a reason', async t => {
  const res = new FakeRes({ stallAt: 1 });
  const logs = [];
  const controller = new AbortController();
  const { done } = await chat(t, (_, up) => { up.writeHead(200, { 'content-type': 'text/event-stream' }); up.end(SSE); }, { res, signal: controller.signal, log: event => logs.push(event) });
  await until(() => res.listenerCount('drain') > 0);
  controller.abort();
  await done;
  const aborted = logs.filter(event => event.event === 'chat-aborted');
  assert.equal(aborted.length, 1);
  assert.equal(aborted[0].reason, undefined);
});

test('dispose rejects a pending wait and cleans listeners and timer', async () => {
  const res = new FakeRes({ stallAt: 1 });
  let timeouts = 0;
  const writer = createStreamWriter({ res, timeoutMs: 20, onTimeout: () => { timeouts++; } });
  const pending = writer.write(Buffer.from('x'));
  const rejection = assert.rejects(pending, /Client closed/);
  writer.dispose();
  await rejection;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(timeouts, 0, 'dispose cleared the drain timer');
  assert.equal(res.listenerNoise(), 0);
});

test('two parallel requests settle independently', async t => {
  const resA = new FakeRes({ stallAt: 1 });
  const resB = new FakeRes();
  const metricsA = [], metricsB = [];
  const a = await chat(t, (_, up) => { up.writeHead(200, { 'content-type': 'text/event-stream' }); up.end(SSE); }, { res: resA, onMetrics: value => metricsA.push(value) });
  const b = await chat(t, (_, up) => { up.writeHead(200, { 'content-type': 'text/event-stream' }); up.end(SSE); }, { res: resB, onMetrics: value => metricsB.push(value) });
  const [bResult] = await Promise.all([b.done]);
  assert.equal(bResult.status, 200);
  await until(() => resA.listenerCount('drain') > 0);
  resA.destroy();
  const aResult = await a.done;
  assert.equal(aResult.aborted, true);
  assert.equal(metricsA.length, 1);
  assert.equal(metricsA[0].status, 'cancelled');
  assert.equal(metricsB.length, 1);
  assert.equal(metricsB[0].status, 'success');
});

test('readErrorDetail releases the reader lock on EOF, cap and error paths', async () => {
  const makeBody = (reads, { cancelThrows = false } = {}) => {
    const calls = { reads: 0, cancels: 0, releases: 0 };
    let i = 0;
    return { calls, getReader: () => ({
      read: () => { calls.reads++; const next = reads[i++]; return next instanceof Error ? Promise.reject(next) : Promise.resolve(next); },
      cancel: () => { calls.cancels++; return cancelThrows ? Promise.reject(new Error('nope')) : Promise.resolve(); },
      releaseLock: () => { calls.releases++; },
    }) };
  };
  const eof = makeBody([
    { done: false, value: Buffer.from('partial') },
    { done: true },
  ]);
  assert.equal(await readErrorDetail({ body: eof }), 'partial');
  assert.equal(eof.calls.releases, 1, 'EOF releases the lock');

  const capped = makeBody([
    { done: false, value: Buffer.from('x'.repeat(5000)) },
  ]);
  assert.equal((await readErrorDetail({ body: capped }, 10)).length, 10);
  assert.equal(capped.calls.cancels, 1);
  assert.equal(capped.calls.releases, 1, 'cancel path releases the lock');

  const failing = makeBody([new Error('read blew up')]);
  assert.equal(await readErrorDetail({ body: failing }), '');
  assert.equal(failing.calls.releases, 1, 'rejection releases the lock');

  const cancelThrows = makeBody([{ done: false, value: Buffer.from('data') }], { cancelThrows: true });
  assert.equal(await readErrorDetail({ body: cancelThrows }, 1), 'd');
  assert.equal(cancelThrows.calls.releases, 1, 'failing cancel still releases');
});

test('upstream body reader is released when the stream ends or errors', async t => {
  // Terminal early: [DONE] before the upstream socket closes → the loop exits
  // and the underlying body must be cancelled rather than left hanging.
  let closeUpstream;
  const upstreamClosed = new Promise(resolve => { closeUpstream = resolve; });
  const res = new FakeRes();
  const { done } = await chat(t, (_, up) => {
    up.on('close', closeUpstream);
    up.writeHead(200, { 'content-type': 'text/event-stream' });
    up.write('data: {"type":"response.output_text.delta","delta":"a"}\n\n');
    up.write('data: [DONE]\n\n');
    // Keep the socket open past [DONE]; our side must cancel the read.
  }, { res });
  const result = await done;
  assert.equal(result.status, 200);
  await upstreamClosed;

  // Invalid JSON mid-stream: the parse error must also free the reader.
  const res2 = new FakeRes();
  let closed2;
  const upstreamClosed2 = new Promise(resolve => { closed2 = resolve; });
  const chat2 = await chat(t, (_, up) => {
    up.on('close', closed2);
    up.writeHead(200, { 'content-type': 'text/event-stream' });
    up.end('data: {broken json}\n\n');
  }, { res: res2 });
  const result2 = await chat2.done;
  assert.equal(result2.error, true);
  assert.equal(result2.code, 'upstream_invalid_json');
  await upstreamClosed2;
});

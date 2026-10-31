'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { events, parseEvent, classifyErrorDetail } = require('../src/protocol/provider-events.cjs');

async function* body(...chunks) { for (const chunk of chunks) yield typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk; }
async function collect(chunks, options) {
  const out = [];
  for await (const event of events(body(...chunks), options)) out.push(event);
  return out;
}
const bytes = text => [...Buffer.from(text, 'utf8')].map(byte => Buffer.from([byte]));
const split = (text, size) => { const buf = Buffer.from(text, 'utf8'), out = []; for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size)); return out; };

test('LF, CRLF and lone CR delimiters produce the same event sequence', async () => {
  const make = eol => ['event: alpha' + eol + 'data: {"v":1}' + eol + eol + 'data: {"v":2}' + eol + eol];
  for (const eol of ['\n', '\r\n', '\r']) {
    assert.deepEqual(await collect(make(eol)), [{ type: 'alpha', data: { v: 1 } }, { type: '', data: { v: 2 } }], 'delimiter ' + JSON.stringify(eol));
  }
});

test('mixed newlines and a CRLF split across chunks frame identically', async () => {
  assert.deepEqual(await collect([
    'data: {"a":1}\r', '\n\ndata: {"b":2}\n\rdata: {"c":3}\r\n\ndata: {"d":4}\r\r',
  ]), [
    { type: '', data: { a: 1 } },
    { type: '', data: { b: 2 } },
    { type: '', data: { c: 3 } },
    { type: '', data: { d: 4 } },
  ]);
  // CR at a chunk boundary whose LF arrives in the next chunk is one terminator.
  assert.deepEqual(await collect(['data: {"x":1}\r', '\n', '\ndata: {"x":2}\n\n']),
    [{ type: '', data: { x: 1 } }, { type: '', data: { x: 2 } }]);
});

test('one chunk with many frames and one-byte chunks frame identically', async () => {
  const text = 'data: {"n":"中"}' + '\n\n'.repeat(1) + 'event: e\ndata: {"n":"🙂"}' + '\n\n' + 'data: [DONE]\n\n';
  const expected = [{ type: '', data: { n: '中' } }, { type: 'e', data: { n: '🙂' } }, { type: 'done' }];
  assert.deepEqual(await collect([text]), expected);
  assert.deepEqual(await collect(bytes(text)), expected);
});

test('multiline data joins, last event wins, comments and unknown fields are ignored', async () => {
  assert.deepEqual(await collect([
    ': comment\nid: 99\nretry: 5000\nfoo: bar\nevent: first\nevent: last\ndata: {"a":\ndata: 1}\n\n',
    'event: nodata\n\n',
    '\n\n',
    'data: {"ok":true}\n\n',
  ]), [
    { type: 'last', data: { a: 1 } },
    { type: '', data: { ok: true } },
  ]);
});

test('data: [DONE] yields the done marker', async () => {
  assert.deepEqual(await collect(['data: [DONE]\n\n']), [{ type: 'done' }]);
});

test('a trailing frame without a blank line still parses at EOF', async () => {
  assert.deepEqual(await collect(['data: {"tail":true}']), [{ type: '', data: { tail: true } }]);
  assert.deepEqual(await collect(['data: {"a":1}\n\ndata: {"tail":2}\r']), [{ type: '', data: { a: 1 } }, { type: '', data: { tail: 2 } }]);
});

test('invalid JSON and malformed UTF-8 both reject', async () => {
  await assert.rejects(collect(['data: {not json}\n\n']), error => error.code === 'upstream_invalid_json');
  await assert.rejects(collect(['data: {"x":"', Buffer.from([0xff, 0xfe]), '"}\n\n']), 'fatal decoding rejects bad bytes');
});

test('many small frames in one large chunk pass a small per-frame limit', async () => {
  const frame = 'data: {"v":1}\n\n';
  const options = { maxBufferCharacters: 64 };
  assert.equal((await collect([frame.repeat(20)], options)).length, 20, 'one big chunk of small frames');
  assert.equal((await collect([...Array(20)].map(() => frame), options)).length, 20, 'the same frames split per chunk');
});

test('a single oversized frame rejects however it is sliced', async () => {
  const big = 'data: {"v":"' + 'x'.repeat(200) + '"}\n\n';
  await assert.rejects(collect([big], { maxBufferCharacters: 64 }), error => error.code === 'upstream_content_type');
  await assert.rejects(collect(bytes(big), { maxBufferCharacters: 64 }), error => error.code === 'upstream_content_type');
});

test('the per-frame limit boundary is exact', async () => {
  const payload = 'y'.repeat(40);
  const frame = 'data: {"v":"' + payload + '"}\n\n';
  // frameChars accrues line.length + 1 per completed line, the blank included.
  const chars = ('data: {"v":"' + payload + '"}').length + 2;
  for (const [limit, ok] of [[chars - 1, false], [chars, true], [chars + 1, true]]) {
    const run = () => collect([frame], { maxBufferCharacters: limit });
    if (ok) assert.equal((await run()).length, 1, 'limit ' + limit);
    else await assert.rejects(run(), error => error.code === 'upstream_content_type');
  }
});

test('parsing does not depend on chunk boundaries', async () => {
  const text = 'event: e\ndata: {"k":"中🙂"}\r\n\ndata: {"z":2}\r\rdata: [DONE]\n\n';
  const expected = await collect([text]);
  for (const size of [1, 2, 3, 7]) assert.deepEqual(await collect(split(text, size)), expected, 'chunk size ' + size);
});

test('classifyErrorDetail returns only the enum token or null', () => {
  assert.equal(classifyErrorDetail('invalid signature in thinking block'), 'signature-mentioned');
  assert.equal(classifyErrorDetail('SIGNATURE check failed'), 'signature-mentioned');
  assert.equal(classifyErrorDetail('context length exceeded'), null);
  assert.equal(classifyErrorDetail(undefined), null);
  assert.equal(classifyErrorDetail({ message: 'signature' }), null);
  const noisy = 'x'.repeat(5000) + 'signature';
  const result = classifyErrorDetail(noisy);
  assert.equal(result, 'signature-mentioned');
  assert.ok(!result.includes('x'), 'the enum never carries detail text');
});

test('oversized EOF tails and unfinished lines obey the frame limit', async () => {
  const oversized = 'data: {"v":"' + 'x'.repeat(200) + '"}';
  await assert.rejects(collect([oversized], { maxBufferCharacters: 64 }),
    error => error.code === 'upstream_content_type');
  let pulledAgain = false;
  async function* unfinished() {
    yield Buffer.from(oversized);
    pulledAgain = true;
    throw new Error('must not request another chunk');
  }
  await assert.rejects(async () => {
    for await (const event of events(unfinished(), { maxBufferCharacters: 64 })) void event;
  }, error => error.code === 'upstream_content_type');
  assert.equal(pulledAgain, false, 'reject during accumulation, not at the next newline or EOF');
  await assert.rejects(collect([': ' + 'x'.repeat(40) + '\n', 'data: {"v":"' + 'y'.repeat(40) + '"}'],
    { maxBufferCharacters: 64 }), error => error.code === 'upstream_content_type');
});

test('EOF limits count UTF-16 characters and reset after a completed frame', async () => {
  const frame = 'data: {"v":"🙂"}';
  const expected = [{ type: '', data: { v: '🙂' } }];
  assert.deepEqual(await collect([frame], { maxBufferCharacters: frame.length }), expected);
  await assert.rejects(collect([frame], { maxBufferCharacters: frame.length - 1 }),
    error => error.code === 'upstream_content_type');
  assert.deepEqual(await collect([frame + '\n\n' + frame], { maxBufferCharacters: frame.length + 2 }),
    [...expected, ...expected]);
});

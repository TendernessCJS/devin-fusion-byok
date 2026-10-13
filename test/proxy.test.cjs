'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { Duplex } = require('node:stream');
const { parseProxy, tunnel, proxyRequestBytes } = require('../src/proxy.cjs');
const update = require('../src/update.cjs');

function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); }
function fakeSocket(written) {
  return new Duplex({
    write(chunk, encoding, callback) { written.push(Buffer.from(chunk)); callback(); },
    read() {}
  });
}

test('parseProxy accepts http and https with or without port and credentials', () => {
  const plain = parseProxy('http://127.0.0.1:7897');
  assert.equal(plain.url.protocol, 'http:');
  assert.equal(plain.url.hostname, '127.0.0.1');
  assert.equal(plain.url.port, '7897');
  assert.equal(plain.authorization, undefined);
  const secure = parseProxy('https://proxy.internal');
  assert.equal(secure.url.protocol, 'https:');
  const basic = Buffer.from('user:pass').toString('base64');
  assert.equal(parseProxy('http://user:pass@127.0.0.1:7897').authorization, 'Basic ' + basic);
  const encoded = Buffer.from('user@corp:p:ss').toString('base64');
  assert.equal(parseProxy('http://user%40corp:p%3Ass@127.0.0.1:1').authorization, 'Basic ' + encoded);
});

test('parseProxy returns null for empty values and rejects bad input', () => {
  for (const value of ['', '   ', undefined, null]) assert.equal(parseProxy(value), null);
  for (const value of ['socks5://127.0.0.1:1080', 'ftp://127.0.0.1:21', 'not a url', 'http://:8080', 'http://h:abc', 'http://h:99999'])
    assert.throws(() => parseProxy(value), /proxy/);
});

test('parseProxy errors never echo credentials or the raw input', () => {
  assert.throws(() => parseProxy('http://svc-user:sup3rsecret@bad-host:xyz'), error => {
    assert.equal(error.message, 'proxy');
    assert.doesNotMatch(error.message, /svc-user|sup3rsecret|bad-host/);
    return true;
  });
});

test('tunnel issues CONNECT and forwards Proxy-Authorization', async () => {
  const written = [];
  const socket = fakeSocket(written);
  const pending = tunnel(parseProxy('http://user:pass@127.0.0.1:1'), 'api.github.com', 443, { connect: () => socket });
  socket.push('HTTP/1.1 200 Connection Established\r\n\r\n');
  assert.equal(await pending, socket);
  const head = Buffer.concat(written).toString('latin1');
  assert.match(head, /CONNECT api\.github\.com:443 HTTP\/1\.1\r\nHost: api\.github\.com:443\r\n/);
  assert.match(head, new RegExp('Proxy-Authorization: Basic ' + Buffer.from('user:pass').toString('base64')));
});

test('tunnel preserves bytes received after the CONNECT response head', async () => {
  const socket = fakeSocket([]);
  const pending = tunnel(parseProxy('http://127.0.0.1:1'), 'api.github.com', 443, { connect: () => socket });
  socket.push('HTTP/1.1 200 Connection Established\r\n\r\nRESIDUAL');
  const resolved = await pending;
  assert.equal(resolved.read().toString('latin1'), 'RESIDUAL');
  resolved.destroy();
});

test('tunnel reports only the status line on non-200 responses and destroys the socket', async () => {
  const socket = fakeSocket([]);
  let destroyed = false;
  const original = socket.destroy.bind(socket);
  socket.destroy = error => { destroyed = true; return original(error); };
  const pending = tunnel(parseProxy('http://user:pass@127.0.0.1:1'), 'api.github.com', 443, { connect: () => socket });
  socket.push('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n');
  await assert.rejects(pending, error => {
    assert.match(error.message, /407 Proxy Authentication Required/);
    assert.doesNotMatch(error.message, /user|pass|Basic|Authorization/i);
    return true;
  });
  assert.equal(destroyed, true);
});

test('end-to-end CONNECT tunnel carries plain HTTP traffic and enforces limits', async () => {
  const target = http.createServer((req, res) => {
    if (req.url === '/missing') { res.writeHead(404); return res.end(); }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
    if (req.url === '/next') { res.writeHead(302, { location: '/final' }); return res.end(); }
    if (req.url === '/lengthy') { res.writeHead(200, { 'content-length': '100' }); return res.end('x'.repeat(100)); }
    if (req.url === '/stream') { res.writeHead(200, { 'transfer-encoding': 'chunked' }); res.write('x'.repeat(50)); return res.end('y'.repeat(50)); }
    res.end('hello ' + req.url);
  });
  const proxyServer = http.createServer((req, res) => res.writeHead(501).end());
  const connected = [];
  proxyServer.on('connect', (req, socket) => {
    connected.push(req.url);
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(socket); socket.pipe(upstream);
    });
    upstream.once('error', () => socket.destroy());
    upstream.once('close', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
  });
  await listen(target); await listen(proxyServer);
  const targetPort = target.address().port;
  const px = parseProxy('http://127.0.0.1:' + proxyServer.address().port);
  const original = update.allowedUrl;
  update.allowedUrl = url => new URL(url);
  try {
    const base = 'http://127.0.0.1:' + targetPort;
    assert.equal((await proxyRequestBytes(base + '/ok', { proxy: px, limit: 1024 })).toString(), 'hello /ok');
    assert.deepEqual(connected, ['127.0.0.1:' + targetPort]);
    assert.equal((await proxyRequestBytes(base + '/next', { proxy: px, limit: 1024 })).toString(), 'hello /final');
    await assert.rejects(proxyRequestBytes(base + '/loop', { proxy: px, limit: 1024 }), error => error.message === 'redirect');
    await assert.rejects(proxyRequestBytes(base + '/missing', { proxy: px, limit: 1024 }), error => error.message === 'http');
    await assert.rejects(proxyRequestBytes(base + '/lengthy', { proxy: px, limit: 10 }), error => error.message === 'http');
    await assert.rejects(proxyRequestBytes(base + '/stream', { proxy: px, limit: 10 }), error => error.message === 'size');
  } finally {
    update.allowedUrl = original;
    target.close(); proxyServer.close();
  }
});

test('targets outside the allowlist are rejected before any connection opens', async () => {
  let calls = 0;
  await assert.rejects(
    proxyRequestBytes('https://untrusted.example/x', { proxy: parseProxy('http://127.0.0.1:1'), limit: 10, connect: () => { calls++; return fakeSocket([]); } }),
    error => error.message === 'url');
  assert.equal(calls, 0);
});

test('tunnel rejects immediately when the proxy closes before the CONNECT response head', async () => {
  const socket = fakeSocket([]);
  const pending = tunnel(parseProxy('http://127.0.0.1:1'), 'api.github.com', 443, { connect: () => socket, timeout: 1000 });
  const started = Date.now();
  socket.push(null);
  await assert.rejects(pending, error => {
    assert.equal(error.message, 'proxy', 'a pre-head close must not wait for the timeout');
    return true;
  });
  assert.ok(Date.now() - started < 500, 'the rejection is immediate, not the timeout abort');

  const closed = fakeSocket([]);
  const second = tunnel(parseProxy('http://127.0.0.1:1'), 'api.github.com', 443, { connect: () => closed, timeout: 1000 });
  closed.destroy();
  await assert.rejects(second, error => error.message === 'proxy');
});

test('directFetch reads plain, gzip and brotli bodies on its own agent', async t => {
  const zlib = require('node:zlib');
  const server = http.createServer((req, res) => {
    if (req.url === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: 1 })); return; }
    if (req.url === '/gzip') { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(zlib.gzipSync('compressed-body')); return; }
    if (req.url === '/br') { res.writeHead(200, { 'content-encoding': 'br' }); res.end(zlib.brotliCompressSync('brotli-body')); return; }
    if (req.url === '/slow') { res.writeHead(200); res.write('a'); setTimeout(() => { res.write('b'); res.end('c'); }, 30); return; }
    res.writeHead(404); res.end();
  });
  await listen(server);
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const { directFetch } = require('../src/proxy.cjs');
  const json = await directFetch(base + '/json');
  assert.equal(json.status, 200);
  assert.deepEqual(await json.json(), { ok: 1 });
  assert.equal(await (await directFetch(base + '/gzip')).text(), 'compressed-body');
  assert.equal(await (await directFetch(base + '/br')).text(), 'brotli-body');
  assert.equal(await (await directFetch(base + '/slow')).text(), 'abc', 'a slow body is read to completion');
});

test('directFetch manual returns redirects and error rejects them, never following', async t => {
  let targetHits = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { location: '/target' }); res.end(); return; }
    if (req.url === '/empty') { res.writeHead(204); res.end(); return; }
    targetHits++;
    res.end('target-body');
  });
  await listen(server);
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const { directFetch } = require('../src/proxy.cjs');
  const manual = await directFetch(base + '/redir', { redirect: 'manual' });
  assert.equal(manual.status, 302);
  assert.equal(manual.headers.get('location'), '/target');
  await manual.body?.cancel?.();
  await assert.rejects(directFetch(base + '/redir', { redirect: 'error' }));
  assert.equal(targetHits, 0, 'redirect targets are never requested');
  const empty = await directFetch(base + '/empty');
  assert.equal(empty.status, 204);
  assert.equal(await empty.text(), '');
});

test('directFetch aborts before headers and destroys the socket mid-body or on cancel', async t => {
  let closes = 0;
  const server = http.createServer((req, res) => {
    req.socket.on('close', () => { closes++; });
    if (req.url === '/hold') return;
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write('first');
    setInterval(() => res.write('more'), 25).unref();
  });
  await listen(server);
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const { directFetch } = require('../src/proxy.cjs');
  await assert.rejects(directFetch(base + '/hold', { signal: AbortSignal.abort() }));

  const controller = new AbortController();
  const mid = await directFetch(base + '/body', { signal: controller.signal });
  const reader = mid.body.getReader();
  await reader.read();
  controller.abort();
  await assert.rejects(reader.read());
  for (let i = 0; i < 200 && closes === 0; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes >= 1, true, 'an aborted body closes the upstream socket');

  const cancelRes = await directFetch(base + '/body2');
  const secondReader = cancelRes.body.getReader();
  await secondReader.read();
  const before = closes;
  await secondReader.cancel();
  for (let i = 0; i < 200 && closes === before; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes > before, true, 'reader cancellation destroys the upstream socket');
});

test('directFetch uses a dedicated non-global agent with TLS verification kept on', async t => {
  const https = require('node:https');
  const { EventEmitter } = require('node:events');
  const seen = [];
  const original = http.ClientRequest;
  http.ClientRequest = function (options) {
    seen.push(options);
    const req = new EventEmitter();
    req.end = () => {}; req.destroy = () => {};
    process.nextTick(() => req.emit('error', new Error('tls fixture failure')));
    return req;
  };
  const { directFetch } = require('../src/proxy.cjs');
  try {
    await assert.rejects(directFetch('https://example.invalid/x'), /tls fixture failure/);
  } finally { http.ClientRequest = original; }
  const agent = seen[0]?.agent;
  assert.ok(agent instanceof https.Agent, 'a dedicated agent is built per request');
  assert.notEqual(agent, https.globalAgent, 'the global agent is never used');
  assert.equal(agent.options.keepAlive, false);
  assert.equal(agent.options.rejectUnauthorized, true, 'certificate and hostname checks stay enabled');
});

test('directFetch propagates aborts and upstream destruction through a compressed body', async t => {
  const zlib = require('node:zlib');
  const settleWithin = (promise, ms = 800) => {
    let timer;
    return Promise.race([
      promise.then(value => { clearTimeout(timer); return { value }; }, error => { clearTimeout(timer); return { error }; }),
      new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), ms); }),
    ]);
  };
  let closes = 0;
  const server = http.createServer((req, res) => {
    req.socket.on('close', () => { closes++; });
    if (req.url === '/stall-gzip' || req.url === '/stall-br') {
      const compressed = req.url.endsWith('br') ? zlib.brotliCompressSync('payload') : zlib.gzipSync('payload');
      res.writeHead(200, { 'content-encoding': req.url.endsWith('br') ? 'br' : 'gzip' });
      res.write(compressed.subarray(0, 6));
      return;
    }
    if (req.url === '/dies-gzip') {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.write(zlib.gzipSync('payload').subarray(0, 6));
      setTimeout(() => res.destroy(new Error('upstream died')), 30);
      return;
    }
    if (req.url === '/bad-gzip') {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end('this is not gzip data');
      return;
    }
    if (req.url === '/deflate') {
      res.writeHead(200, { 'content-encoding': 'deflate' });
      res.end(zlib.deflateSync('deflated'));
      return;
    }
    res.writeHead(404); res.end();
  });
  await listen(server);
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const { directFetch } = require('../src/proxy.cjs');

  for (const path of ['/stall-gzip', '/stall-br']) {
    const controller = new AbortController();
    const stalled = await directFetch(base + path, { signal: controller.signal });
    const pendingRead = stalled.body.getReader().read();
    controller.abort();
    const outcome = await settleWithin(pendingRead);
    assert.ok(!outcome.timeout, `an aborted ${path} reader must not hang`);
    assert.ok(outcome.error, 'the pending read rejects');
    assert.equal(outcome.error.name, 'AbortError', `the ${path} abort surfaces a real AbortError, not a watchdog`);
  }
  for (let i = 0; i < 200 && closes < 2; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes >= 2, true, 'aborts destroy both upstream sockets through their decoders');

  const dying = await directFetch(base + '/dies-gzip');
  const dyingOutcome = await settleWithin(dying.body.getReader().read(), 1500);
  assert.ok(!dyingOutcome.timeout, 'an upstream destroy mid-decode rejects promptly');
  assert.ok(dyingOutcome.error, 'the reader rejects when the origin dies mid-decode');
  assert.doesNotMatch(String(dyingOutcome.error && dyingOutcome.error.message), /hung/i);

  await assert.rejects((await directFetch(base + '/bad-gzip')).text(), /invalid|incorrect|unexpected|Error/i);
  assert.equal(await (await directFetch(base + '/deflate')).text(), 'deflated');
});

test('a cancelled compressed body reader closes the origin connection', async t => {
  const zlib = require('node:zlib');
  let closes = 0;
  const server = http.createServer((req, res) => {
    req.socket.on('close', () => { closes++; });
    res.writeHead(200, { 'content-encoding': 'gzip' });
    const compressed = zlib.gzipSync('x'.repeat(1000));
    res.write(compressed.subarray(0, 5));
    let offset = 5;
    const interval = setInterval(() => {
      if (offset >= compressed.length) { clearInterval(interval); return; }
      res.write(compressed.subarray(offset, offset += 10));
    }, 10);
    res.on('close', () => clearInterval(interval));
  });
  await listen(server);
  t.after(() => server.close());
  const { directFetch } = require('../src/proxy.cjs');
  const response = await directFetch(`http://127.0.0.1:${server.address().port}/x`);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  for (let i = 0; i < 200 && closes === 0; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes >= 1, true, 'reader cancellation destroys the origin socket through the decoder');
});

test('directFetch strips IPv6 brackets for the request and keeps the URL untouched', async () => {
  const { EventEmitter } = require('node:events');
  const seen = [];
  const original = http.ClientRequest;
  http.ClientRequest = function (options) {
    seen.push(options.hostname);
    const req = new EventEmitter();
    req.end = () => {}; req.destroy = () => {};
    process.nextTick(() => req.emit('error', new Error('stub')));
    return req;
  };
  const { directFetch } = require('../src/proxy.cjs');
  try { await assert.rejects(directFetch('http://[::1]:8080/v1/models'), /stub/); }
  finally { http.ClientRequest = original; }
  assert.deepEqual(seen, ['::1'], 'node request options get the bare IPv6 address');
});

test('a request error after response headers propagates to the body reader', async () => {
  const { EventEmitter } = require('node:events');
  const { Readable } = require('node:stream');
  const original = http.ClientRequest;
  const fakeReq = new EventEmitter();
  fakeReq.end = () => {}; fakeReq.destroy = () => {};
  const fakeRes = new Readable({ read() {} });
  fakeRes.statusCode = 200;
  fakeRes.headers = {};
  http.ClientRequest = function (options, callback) {
    process.nextTick(() => {
      callback(fakeRes);
      process.nextTick(() => fakeReq.emit('error', new Error('post-headers failure')));
    });
    return fakeReq;
  };
  const { directFetch } = require('../src/proxy.cjs');
  try {
    const response = await directFetch('http://fixture.invalid/x');
    await assert.rejects(
      Promise.race([response.body.getReader().read(), new Promise((_, reject) => setTimeout(() => reject(new Error('reader hung')), 800))]),
      /post-headers failure|aborted|error/i,
      'a request-level error after headers rejects the body reader');
  } finally { http.ClientRequest = original; }
});

test('request paths never touch the request/get functions patched by the extension host', async t => {
  const https = require('node:https');
  const calls = { 'http.request': 0, 'http.get': 0, 'https.request': 0, 'https.get': 0 };
  const originals = { 'http.request': http.request, 'http.get': http.get, 'https.request': https.request, 'https.get': https.get };
  const stub = name => () => { calls[name]++; throw new Error('host-patched ' + name + ' must not run'); };
  http.request = stub('http.request'); http.get = stub('http.get');
  https.request = stub('https.request'); https.get = stub('https.get');
  t.after(() => { http.request = originals['http.request']; http.get = originals['http.get']; https.request = originals['https.request']; https.get = originals['https.get']; });

  const target = http.createServer((req, res) => res.end('ok ' + req.url));
  const proxyServer = http.createServer((req, res) => res.writeHead(501).end());
  proxyServer.on('connect', (req, socket) => {
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(socket); socket.pipe(upstream);
    });
    upstream.once('error', () => socket.destroy());
    upstream.once('close', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
  });
  await listen(target); await listen(proxyServer);
  t.after(() => { target.close(); proxyServer.close(); });

  const px = parseProxy('http://127.0.0.1:' + proxyServer.address().port);
  const original = update.allowedUrl;
  update.allowedUrl = url => new URL(url);
  try {
    const base = 'http://127.0.0.1:' + target.address().port;
    assert.equal((await proxyRequestBytes(base + '/tunneled', { proxy: px, limit: 1024 })).toString(), 'ok /tunneled');
    const { directFetch } = require('../src/proxy.cjs');
    assert.equal(await (await directFetch(base + '/direct')).text(), 'ok /direct');
  } finally { update.allowedUrl = original; }
  assert.deepEqual(calls, { 'http.request': 0, 'http.get': 0, 'https.request': 0, 'https.get': 0 });
});

test('maskProxy hides credentials and echoes credential-free proxies verbatim', () => {
  const { maskProxy } = require('../src/proxy.cjs');
  assert.equal(maskProxy(' http://127.0.0.1:7897 '), 'http://127.0.0.1:7897');
  assert.equal(maskProxy('https://proxy.internal'), 'https://proxy.internal');
  assert.equal(maskProxy('http://user:s3cret@127.0.0.1:7897'), 'http://***@127.0.0.1:7897');
  assert.equal(maskProxy('https://u:p@proxy.internal'), 'https://***@proxy.internal');
  assert.equal(maskProxy('http://user%40corp:p%3Ass@10.0.0.1:1'), 'http://***@10.0.0.1:1');
  for (const value of ['not a url', '', '   ', 42, null, undefined]) assert.equal(maskProxy(value), '');
});

test('requests fall back to http.request when the ClientRequest constructor fails', async t => {
  const { EventEmitter } = require('node:events');
  const { Readable } = require('node:stream');
  const calls = [];
  const originalClientRequest = http.ClientRequest;
  const originalRequest = http.request;
  http.ClientRequest = function () { throw Object.assign(new Error('protocol mismatch'), { code: 'ERR_INVALID_PROTOCOL' }); };
  http.request = (options, callback) => {
    calls.push(options.hostname);
    const req = new EventEmitter();
    req.end = () => {}; req.destroy = () => {};
    const res = new Readable({ read() {} });
    res.statusCode = 204; res.headers = {};
    process.nextTick(() => { callback(res); res.push(null); });
    return req;
  };
  t.after(() => { http.ClientRequest = originalClientRequest; http.request = originalRequest; });
  const { directFetch } = require('../src/proxy.cjs');
  const response = await directFetch('http://fixture.invalid/x');
  assert.equal(response.status, 204);
  assert.deepEqual(calls, ['fixture.invalid'], 'the request went through the http.request fallback');
});

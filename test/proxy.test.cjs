'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { Duplex } = require('node:stream');
const { parseProxy, tunnel, proxyRequestBytes } = require('../src/proxy.cjs');
const update = require('../src/update.cjs');
const updateUrl = require('../src/update/url-policy.cjs');

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
  const original = updateUrl.allowedUrl;
  updateUrl.allowedUrl = url => new URL(url);
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
    updateUrl.allowedUrl = original;
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
  const original = updateUrl.allowedUrl;
  updateUrl.allowedUrl = url => new URL(url);
  try {
    const base = 'http://127.0.0.1:' + target.address().port;
    assert.equal((await proxyRequestBytes(base + '/tunneled', { proxy: px, limit: 1024 })).toString(), 'ok /tunneled');
  } finally { updateUrl.allowedUrl = original; }
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

test('src/proxy.cjs stays a pure compatibility facade over the new modules', () => {
  const facade = require('../src/proxy.cjs');
  const config = require('../src/update/proxy-config.cjs');
  const transport = require('../src/update/proxy-transport.cjs');
  const direct = require('../src/network/direct-fetch.cjs');
  assert.equal(facade.parseProxy, config.parseProxy);
  assert.equal(facade.maskProxy, config.maskProxy);
  assert.equal(facade.tunnel, transport.tunnel);
  assert.equal(facade.proxyRequestBytes, transport.proxyRequestBytes);
  assert.equal(facade.directFetch, direct.directFetch);
});

test('proxyRequestBytes enforces length, redirect and abort contracts end to end', async () => {
  const target = http.createServer((req, res) => {
    if (req.url === '/exact') { res.writeHead(200, { 'content-length': '10' }); return res.end('x'.repeat(10)); }
    if (req.url === '/noloc') { res.writeHead(302); return res.end(); }
    if (req.url === '/r6') { res.writeHead(302, { location: '/r6' }); return res.end(); }
    if (req.url === '/slow') { slowHits++; req.socket.on('close', () => { closes++; }); res.writeHead(200, { 'content-length': '4' }); res.write('ab'); return; }
    res.end('ok');
  });
  const proxyServer = http.createServer((req, res) => res.writeHead(501).end());
  const connected = [];
  const tunnels = [];
  let slowHits = 0, closes = 0;
  proxyServer.on('connect', (req, socket) => {
    connected.push(req.url);
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(socket); socket.pipe(upstream);
    });
    tunnels.push(socket, upstream);
    // Both tunnel ends must swallow socket errors: a mid-body abort can reset
    // the client socket while the upstream is still writing, and an
    // unlistened 'error' event would fail the whole file.
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    upstream.once('close', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
  });
  await listen(target); await listen(proxyServer);
  const targetPort = target.address().port;
  const px = parseProxy('http://127.0.0.1:' + proxyServer.address().port);
  const original = updateUrl.allowedUrl;
  updateUrl.allowedUrl = url => new URL(url);
  try {
    const base = 'http://127.0.0.1:' + targetPort;
    assert.equal((await proxyRequestBytes(base + '/exact', { proxy: px, limit: 10 })).toString(), 'x'.repeat(10),
      'content-length equal to the limit is accepted');
    await assert.rejects(proxyRequestBytes(base + '/noloc', { proxy: px, limit: 10 }), error => error.message === 'redirect');
    connected.length = 0;
    await assert.rejects(proxyRequestBytes(base + '/r6', { proxy: px, limit: 10 }), error => error.message === 'redirect');
    assert.equal(connected.length, 6, 'the seventh CONNECT is never issued');
    const pre = new AbortController(); pre.abort();
    const before = connected.length;
    await assert.rejects(proxyRequestBytes(base + '/exact', { proxy: px, limit: 10, signal: pre.signal }),
      error => error.message === 'aborted');
    assert.equal(connected.length, before, 'a pre-aborted signal opens no connection');
    const mid = new AbortController();
    const closesBefore = closes, hitsBefore = slowHits;
    const pending = proxyRequestBytes(base + '/slow', { proxy: px, limit: 10, signal: mid.signal, timeout: 5000 });
    for (let i = 0; i < 1000 && slowHits === hitsBefore; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(slowHits, hitsBefore + 1, 'the request reached the origin and wrote its first chunk');
    mid.abort();
    await assert.rejects(pending, error => error.message === 'aborted');
    for (let i = 0; i < 1000 && closes === closesBefore; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(closes > closesBefore, 'the mid-body abort destroys the origin socket');
  } finally {
    updateUrl.allowedUrl = original;
    for (const sock of tunnels) sock.destroy();
    target.close(); proxyServer.close();
  }
});

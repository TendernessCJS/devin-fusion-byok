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

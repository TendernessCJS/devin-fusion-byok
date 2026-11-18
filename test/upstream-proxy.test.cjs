'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { once } = require('node:events');
const { createForwardAgent } = require('../src/runtime/upstream-proxy.cjs');
const { compileProxyPolicy } = require('../src/network/proxy-policy.cjs');
const tlsTest = require('./fixtures/tls-test.cjs');

const DIRECT = { httpProxy: '', httpsProxy: '', noProxy: [] };
const compile = config => compileProxyPolicy(config);

// A plain TCP CONNECT proxy that records every request line and tunnels to the
// requested host:port — enough surface for the real-throughput tests.
async function connectProxy(t, { respond = '200', auth } = {}) {
  const seen = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once('error', () => {});
    let head = Buffer.alloc(0);
    const onData = chunk => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      const lines = head.subarray(0, end).toString('latin1').split('\r\n');
      seen.push(lines);
      if (auth) {
        const header = lines.find(l => /^proxy-authorization:/i.test(l));
        if (!header || header.split(':')[1].trim() !== auth) {
          socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
          return;
        }
      }
      if (!respond.startsWith('200')) { socket.end('HTTP/1.1 ' + respond + '\r\n\r\ndenied'); return; }
      const [host, port] = lines[0].split(' ')[1].split(':');
      // Every fixture hostname resolves to the local upstream — the CONNECT proxy
      // owns 'DNS' here so the client-side code never has to resolve it.
      const upstream = net.connect({ host: /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : '127.0.0.1', port: Number(port) }, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const rest = head.subarray(end + 4);
        if (rest.length) upstream.write(rest);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
    };
    socket.on('data', onData);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const s of sockets) s.destroy(); await new Promise(r => server.close(r)); });
  return { port: server.address().port, seen, sockets };
}

function get(target, { agent, timeout = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = target.startsWith('https') ? https : http;
    const req = mod.get(target, { agent: agent === undefined ? false : agent, servername: 'localhost', ca: undefined }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('test-timeout')));
    req.on('error', reject);
  });
}

test('compileProxyPolicy accepts the strict shape and freezes the result', () => {
  const policy = compile({ httpProxy: 'http://127.0.0.1:8888', httpsProxy: 'https://proxy.example:443', noProxy: ['a.com', 'b.com:8080'] });
  assert.equal(policy.httpProxy.url.port, '8888');
  assert.equal(policy.httpsProxy.url.hostname, 'proxy.example');
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.noProxy), true);
});

test('compileProxyPolicy produces DIRECT for empty proxy values', () => {
  const policy = compile(DIRECT);
  assert.equal(policy.httpProxy, null);
  assert.equal(policy.httpsProxy, null);
  assert.equal(createForwardAgent(new URL('https://example.com/'), policy), null);
});

for (const [name, bad] of [
  ['unknown key', { httpProxy: '', httpsProxy: '', noProxy: [], extra: 1 }],
  ['missing key', { httpProxy: '' }],
  ['non-string proxy', { httpProxy: 42, httpsProxy: '', noProxy: [] }],
  ['non-array noProxy', { httpProxy: '', httpsProxy: '', noProxy: 'x' }],
  ['socks scheme', { httpProxy: 'socks5://127.0.0.1:1080', httpsProxy: '', noProxy: [] }],
  ['url path', { httpProxy: 'http://127.0.0.1:8888/path', httpsProxy: '', noProxy: [] }],
  ['url query', { httpProxy: 'http://127.0.0.1:8888/?x=1', httpsProxy: '', noProxy: [] }],
  ['url hash', { httpProxy: 'http://127.0.0.1:8888/#h', httpsProxy: '', noProxy: [] }],
  ['too many noProxy items', { httpProxy: '', httpsProxy: '', noProxy: Array(513).fill('a') }],
  ['oversized url', { httpProxy: 'http://h/' + 'x'.repeat(9000), httpsProxy: '', noProxy: [] }],
  ['oversized noProxy item', { httpProxy: '', httpsProxy: '', noProxy: ['x'.repeat(2000)] }],
  ['cidr rejected', { httpProxy: '', httpsProxy: '', noProxy: ['10.0.0.0/8'] }],
  ['bad port rejected', { httpProxy: '', httpsProxy: '', noProxy: ['a.com:notaport'] }],
  ['null config', null],
  ['array config', []],
]) {
  test(`compileProxyPolicy rejects ${name} with proxy_invalid`, () => {
    assert.throws(() => compile(bad), { code: 'proxy_invalid' });
  });
}

test('userinfo and a bare / path are legal', () => {
  const a = compile({ httpProxy: 'http://user:pass@127.0.0.1:8888/', httpsProxy: '', noProxy: [] });
  assert.ok(a.httpProxy.authorization.startsWith('Basic '));
  compile({ httpProxy: 'http://127.0.0.1:8888', httpsProxy: '', noProxy: [] });
});

// noProxy semantics — exercised through createForwardAgent: returning null is
// the DIRECT decision, non-null means "route via proxy".
function routes(host, { noProxy = [], port } = {}) {
  const policy = compile({ httpProxy: 'http://127.0.0.1:1', httpsProxy: 'http://127.0.0.1:1', noProxy });
  const printed = host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host;
  const target = new URL('https://' + printed + (port ? ':' + port : '') + '/');
  return createForwardAgent(target, policy) !== null;
}

test('noProxy domain boundary: matches itself and subdomains, never notgf.com.cn', () => {
  const opts = { noProxy: ['gf.com.cn'] };
  assert.equal(routes('gf.com.cn', opts), false);
  assert.equal(routes('api.gf.com.cn', opts), false);
  assert.equal(routes('deep.api.gf.com.cn', opts), false);
  assert.equal(routes('notgf.com.cn', opts), true);
  assert.equal(routes('gf.com.cn.evil.com', opts), true);
});

test('noProxy leading dot, *. domain, wildcard and case/comma handling', () => {
  assert.equal(routes('api.X.com', { noProxy: ['.x.com'] }), false);
  assert.equal(routes('x.com', { noProxy: ['.x.com'] }), false);
  assert.equal(routes('api.y.com', { noProxy: ['*.y.com'] }), false);
  assert.equal(routes('anything.example', { noProxy: ['*'] }), false);
  assert.equal(routes('a.z.com', { noProxy: [' B.COM , c.com '] }) === routes('a.z.com', { noProxy: ['b.com', 'c.com'] }), true);
});

test('noProxy ports only exempt the matching port', () => {
  assert.equal(routes('a.com', { noProxy: ['a.com:8443'], port: 8443 }), false);
  assert.equal(routes('a.com', { noProxy: ['a.com:8443'], port: 443 }), true);
  assert.equal(routes('a.com', { noProxy: ['a.com:8443'] }), true);
});

test('noProxy IPv6: bracketed and bare ::1 match, malformed is rejected', () => {
  assert.equal(routes('[::1]', { noProxy: ['[::1]'] }), false);
  assert.equal(routes('::1', { noProxy: ['::1'] }), false);
  assert.equal(routes('[::1]', { noProxy: ['[::1]:443'], port: 443 }), false);
  assert.throws(() => compile({ httpProxy: '', httpsProxy: '', noProxy: ['[::1'] }), { code: 'proxy_invalid' });
});

test('loopback bypasses unconditionally, with no DNS involved', () => {
  for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.42.9.3', '::1', '[::1]'])
    assert.equal(routes(host, { noProxy: [] }), false, host);
  assert.equal(routes('localhost.example', { noProxy: [] }), true);
});

test('HTTPS through a real CONNECT proxy: upstream bytes arrive verbatim', async t => {
  const upstream = https.createServer({ key: tlsTest.key, cert: tlsTest.cert }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('upstream-bytes-' + req.url);
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => upstream.close(r)));
  const proxy = await connectProxy(t, { respond: '200' });
  const policy = compile({ httpProxy: '', httpsProxy: `http://127.0.0.1:${proxy.port}`, noProxy: [] });
  const target = new URL(`https://tls.fixture:${upstream.address().port}/rpc`);
  const agent = createForwardAgent(target, policy, { secureOptions: { ca: tlsTest.cert } });
  const res = await get(`https://tls.fixture:${upstream.address().port}/rpc`, { agent });
  assert.equal(res.body, 'upstream-bytes-/rpc');
  assert.equal(proxy.seen.length, 1);
  assert.equal(proxy.seen[0][0], `CONNECT tls.fixture:${upstream.address().port} HTTP/1.1`);
  agent.destroy();
});

test('HTTP through a real CONNECT proxy forwards Proxy-Authorization only to the proxy', async t => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers);
    res.end('http-ok');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => upstream.close(r)));
  const proxy = await connectProxy(t, { respond: '200' });
  const policy = compile({ httpProxy: `http://user:secret@127.0.0.1:${proxy.port}`, httpsProxy: '', noProxy: [] });
  const target = new URL(`http://fixture.invalid:${upstream.address().port}/x`);
  // Route the CONNECT hop at the proxy but keep `host` resolution out of it:
  // the tunnel is asked for example.test and our proxy dials the fixture port.
  const agent = createForwardAgent(target, policy, {
    connect: p => net.connect({ host: '127.0.0.1', port: proxy.port }),
  });
  const res = await get(`http://fixture.invalid:${upstream.address().port}/x`, { agent });
  assert.equal(res.body, 'http-ok');
  const connect = proxy.seen[0].join('\r\n');
  assert.match(connect, /Proxy-Authorization: Basic /);
  assert.equal(seen[0]['proxy-authorization'], undefined, 'proxy credentials must not reach the upstream');
  agent.destroy();
});

test('proxy non-200 fails the request and never falls back to DIRECT', async t => {
  const proxy = await connectProxy(t, { respond: '403 Forbidden' });
  let upstreamHit = false;
  const upstream = http.createServer((req, res) => { upstreamHit = true; res.end('no'); });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => upstream.close(r)));
  const policy = compile({ httpProxy: `http://127.0.0.1:${proxy.port}`, httpsProxy: '', noProxy: [] });
  const agent = createForwardAgent(new URL(`http://127.0.0.1:${upstream.address().port}/`), policy);
  // bypass only for loopback — use a non-loopback hostname so the proxy is used
  const agent2 = createForwardAgent(new URL(`http://fixture.invalid:${upstream.address().port}/`), policy,
    { connect: p => net.connect({ host: '127.0.0.1', port: proxy.port }) });
  await assert.rejects(get(`http://fixture.invalid:${upstream.address().port}/`, { agent: agent2 }), /proxy|socket|403|ECONNRESET|aborted|Error/);
  assert.equal(upstreamHit, false);
  agent?.destroy(); agent2.destroy();
});

test('unreachable proxy fails instead of dialing the target directly', async t => {
  const policy = compile({ httpProxy: 'http://127.0.0.1:1', httpsProxy: 'http://127.0.0.1:1', noProxy: [] });
  const agent = createForwardAgent(new URL('http://fixture.invalid:80/'), policy);
  await assert.rejects(get('http://fixture.invalid:80/', { agent, timeout: 3000 }));
  agent.destroy();
});

test('oversized CONNECT response head rejects the tunnel', async t => {
  const server = net.createServer(socket => {
    socket.on('data', () => { socket.write('HTTP/1.1 200 OK\r\n' + 'X: ' + 'a'.repeat(17000) + '\r\n\r\n'); });
    socket.on('error', () => {});
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const policy = compile({ httpProxy: `http://127.0.0.1:${server.address().port}`, httpsProxy: '', noProxy: [] });
  const agent = createForwardAgent(new URL('http://fixture.invalid:80/'), policy);
  await assert.rejects(get('http://fixture.invalid:80/', { agent }));
  agent.destroy();
});

test('EOF during CONNECT rejects', async t => {
  const server = net.createServer(socket => socket.destroy());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const policy = compile({ httpProxy: `http://127.0.0.1:${server.address().port}`, httpsProxy: '', noProxy: [] });
  const agent = createForwardAgent(new URL('http://fixture.invalid:80/'), policy);
  await assert.rejects(get('http://fixture.invalid:80/', { agent }));
  agent.destroy();
});

test('untrusted upstream certificate fails the TLS handshake', async t => {
  const upstream = https.createServer({ key: tlsTest.key, cert: tlsTest.cert }, (req, res) => res.end('x'));
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => upstream.close(r)));
  const proxy = await connectProxy(t, { respond: '200' });
  const policy = compile({ httpProxy: '', httpsProxy: `http://127.0.0.1:${proxy.port}`, noProxy: [] });
  const target = new URL(`https://tls.fixture:${upstream.address().port}/`);
  // No secureOptions: the default CA store must reject the self-signed cert.
  const agent = createForwardAgent(target, policy);
  await assert.rejects(get(`https://tls.fixture:${upstream.address().port}/`, { agent }), /self.signed|certificate|UNABLE_TO/i);
  agent.destroy();
});

test('agent.destroy cancels a still-running CONNECT handshake', async t => {
  let dialled = false;
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('data', () => { dialled = true; /* never respond */ }); socket.on('error', () => {}); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(r => server.close(r)); });
  const policy = compile({ httpProxy: `http://127.0.0.1:${server.address().port}`, httpsProxy: '', noProxy: [] });
  const agent = createForwardAgent(new URL('http://fixture.invalid:80/'), policy);
  const attempt = get('http://fixture.invalid:80/', { agent });
  await new Promise(r => setTimeout(r, 100));
  agent.destroy();
  await assert.rejects(attempt);
});

test('abort signal cancels a pending tunnel', async t => {
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(r => server.close(r)); });
  const policy = compile({ httpProxy: `http://127.0.0.1:${server.address().port}`, httpsProxy: '', noProxy: [] });
  const controller = new AbortController();
  const agent = createForwardAgent(new URL('http://fixture.invalid:80/'), policy, { signal: controller.signal });
  const attempt = get('http://fixture.invalid:80/', { agent });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(attempt);
});

test('DIRECT policy performs a plain connection (null agent)', async t => {
  const upstream = http.createServer((req, res) => res.end('direct'));
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => upstream.close(r)));
  const policy = compile(DIRECT);
  assert.equal(createForwardAgent(new URL(`http://127.0.0.1:${upstream.address().port}/`), policy), null);
  const res = await get(`http://127.0.0.1:${upstream.address().port}/`);
  assert.equal(res.body, 'direct');
});

const { tunnel } = require('../src/network/proxy-tunnel.cjs');
const { Duplex } = require('node:stream');

test('comma-expanded noProxy: every token is validated and applied', () => {
  const policy = compile({ httpProxy: 'http://127.0.0.1:1', httpsProxy: 'http://127.0.0.1:1', noProxy: ['a.com,b.com', 'c.com'] });
  assert.equal(policy.noProxy.length, 3);
  const mk = host => createForwardAgent(new URL('https://' + host + '/'), policy) !== null;
  assert.equal(mk('b.com'), false, 'second comma token applies');
  assert.equal(mk('c.com'), false, 'third item applies');
  assert.equal(mk('d.com'), true);
});

test('an invalid later token still fails even behind a wildcard', () => {
  assert.throws(() => compile({ httpProxy: '', httpsProxy: '', noProxy: ['*,bad/host'] }), { code: 'proxy_invalid' });
  assert.throws(() => compile({ httpProxy: '', httpsProxy: '', noProxy: ['ok.com,10.0.0.0/8'] }), { code: 'proxy_invalid' });
});

test('noProxy item types: numbers rejected, port bounds enforced', () => {
  assert.throws(() => compile({ httpProxy: '', httpsProxy: '', noProxy: [123] }), { code: 'proxy_invalid' });
  assert.throws(() => compile({ httpProxy: '', httpsProxy: '', noProxy: ['a.com:0'] }), { code: 'proxy_invalid' });
  assert.throws(() => compile({ httpProxy: '', httpsProxy: '', noProxy: ['a.com:65536'] }), { code: 'proxy_invalid' });
  compile({ httpProxy: '', httpsProxy: '', noProxy: ['a.com:65535'] });
});

test('malformed IPv6 entries are rejected; compressed and expanded forms match', () => {
  assert.throws(() => compile({ httpProxy: '', httpsProxy: '', noProxy: ['[gg::1]'] }), { code: 'proxy_invalid' });
  assert.throws(() => compile({ httpProxy: '', httpsProxy: '', noProxy: ['[2001:::1]'] }), { code: 'proxy_invalid' });
  const policy = compile({ httpProxy: 'http://127.0.0.1:1', httpsProxy: 'http://127.0.0.1:1', noProxy: ['2001:db8::1'] });
  // 2001:0db8:0:0:0:0:0:1 is the same address in expanded spelling.
  assert.equal(createForwardAgent(new URL('https://[2001:0db8:0:0:0:0:0:1]/'), policy), null);
  assert.ok(createForwardAgent(new URL('https://[2001:0db8:0:0:0:0:0:2]/'), policy) !== null);
});

test('empty httpsProxy is explicit DIRECT for HTTPS, never an HTTP-proxy fallback', () => {
  const policy = compile({ httpProxy: 'http://127.0.0.1:1', httpsProxy: '', noProxy: [] });
  assert.equal(createForwardAgent(new URL('https://fixture.invalid/'), policy), null, 'https target is direct');
  assert.ok(createForwardAgent(new URL('http://fixture.invalid/'), policy) !== null, 'http target proxied');
});

test('CONNECT response over the header cap in a single chunk rejects at tunnel level', async () => {
  const fake = new Duplex({ write(chunk, encoding, callback) { callback(); }, read() {} });
  const promise = tunnel({ url: new URL('http://127.0.0.1:9') }, 'h', 443, { connect: () => fake });
  fake.push('HTTP/1.1 200 OK\r\n' + 'X: ' + 'a'.repeat(17000) + '\r\n\r\n');
  await assert.rejects(promise, /proxy/);
});

test('residual bytes beyond the high-water mark still drain completely', async t => {
  const payload = Buffer.alloc(200 * 1024, 7);
  const server = net.createServer(socket => {
    socket.once('data', () => socket.end(Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\n\r\n'), payload])));
    socket.on('error', () => {});
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const sock = await tunnel({ url: new URL('http://x') }, 'h', 443,
    { connect: () => net.connect({ host: '127.0.0.1', port: server.address().port }) });
  let received = 0;
  for await (const chunk of sock) received += chunk.length;
  assert.equal(received, payload.length);
  sock.destroy();
});

test('IPv6 targets are bracketed in the CONNECT authority form', async () => {
  const writes = [];
  const fake = new Duplex({ write(chunk, encoding, callback) { writes.push(chunk); callback(); }, read() {} });
  const promise = tunnel({ url: new URL('http://127.0.0.1:9') }, '::1', 8080, { connect: () => fake });
  fake.push('HTTP/1.1 200 OK\r\n\r\n');
  await promise;
  assert.match(writes[0].toString(), /CONNECT \[::1\]:8080 HTTP\/1\.1/);
});

test('a TLS handshake that never answers is killed by destroy() and abort', async t => {
  // CONNECT 200 arrives, then silence: no TLS bytes ever come back.
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    let head = Buffer.alloc(0);
    let answered = false;
    socket.on('data', chunk => {
      if (answered) return; // TLS bytes arrive: stay silent
      head = Buffer.concat([head, chunk]);
      if (head.indexOf('\r\n\r\n') === -1) return;
      answered = true;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      // never answer the TLS handshake
    });
    socket.on('error', () => {});
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { for (const s of sockets) s.destroy(); return new Promise(r => server.close(r)); });
  const policy = compile({ httpProxy: '', httpsProxy: `http://127.0.0.1:${server.address().port}`, noProxy: [] });
  for (const mode of ['destroy', 'abort']) {
    const controller = new AbortController();
    const agent = createForwardAgent(new URL('https://tls.fixture:443/'), policy, { signal: controller.signal });
    const attempt = get('https://tls.fixture:443/', { agent });
    await new Promise(r => setTimeout(r, 80));
    if (mode === 'destroy') agent.destroy(); else controller.abort();
    await assert.rejects(attempt, { name: 'Error' });
  }
});

test('secureOptions can add trust but cannot weaken verification', async t => {
  const upstream = https.createServer({ key: tlsTest.key, cert: tlsTest.cert }, (req, res) => res.end('ok'));
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => upstream.close(r)));
  const proxy = await connectProxy(t, { respond: '200' });
  const policy = compile({ httpProxy: '', httpsProxy: `http://127.0.0.1:${proxy.port}`, noProxy: [] });
  // Wrong hostname + a malicious attempt to disable verification: the CA is
  // injected, so only the hostname check stands between success and failure.
  const agent = createForwardAgent(new URL(`https://other.fixture:${upstream.address().port}/`), policy,
    { secureOptions: { ca: tlsTest.cert, rejectUnauthorized: false, checkServerIdentity: () => undefined } });
  await assert.rejects(get(`https://other.fixture:${upstream.address().port}/`, { agent }), /ERR_TLS|certificate|ALTNAME/i);
  agent.destroy();
});

test('a peer that closes mid-TLS-handshake rejects promptly and frees the socket', async t => {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    let answered = false;
    socket.on('data', chunk => {
      if (answered) { socket.destroy(); return; } // TLS ClientHello arrives: hang up
      if (chunk.indexOf('\r\n\r\n') === -1) return;
      answered = true;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    });
    socket.on('error', () => {});
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { for (const s of sockets) s.destroy(); return new Promise(r => server.close(r)); });
  const policy = compile({ httpProxy: '', httpsProxy: `http://127.0.0.1:${server.address().port}`, noProxy: [] });
  const agent = createForwardAgent(new URL('https://tls.fixture:443/'), policy);
  const started = Date.now();
  await assert.rejects(get('https://tls.fixture:443/', { agent }), { name: 'Error' });
  assert.ok(Date.now() - started < 2000, 'the early close settles the handshake, not the timer');
  agent.destroy();
});

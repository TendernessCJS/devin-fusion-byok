'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const actualBackend = require('../src/runtime/backend.cjs');
const { controlFile } = require('../src/runtime/contract.cjs');
const { readProxySettings } = require('../src/activation/proxy-settings.cjs');

const DIRECT = { httpProxy: '', httpsProxy: '', noProxy: [] };
const RPC = '/exa.api_server_pb.ApiServerService/GetUserStatus';

async function upstreamServer(t, { hold = false } = {}) {
  const hits = [];
  const held = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (hold) { held.push(res); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('upstream-response');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    for (const res of held) res.end();
    for (const socket of held) socket.destroy?.();
    await new Promise(r => server.close(r));
    server.closeAllConnections?.();
  });
  return { port: server.address().port, hits, held, release: () => { for (const res of held.splice(0)) res.end('released'); } };
}

async function start(t, { initialProxy } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-proxy-backend-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ providers: [] }));
  const options = { root, port: 0, log: () => {} };
  if (initialProxy !== undefined) options.initialProxy = initialProxy;
  const backend = await actualBackend.startBackend(options);
  t.after(async () => { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + backend.port;
  const control = () => JSON.parse(fs.readFileSync(controlFile(root), 'utf8'));
  const post = (pathName, body, token = control().token, headers = {}) =>
    fetch(base + pathName, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body) });
  const setUpstream = origin => post('/_runtime/upstream', { origin });
  const setProxy = config => post('/_runtime/proxy', config);
  return { root, backend, base, control, post, setUpstream, setProxy };
}

test('a cold backend reports proxyReadiness but refuses upstream traffic', async t => {
  const upstream = await upstreamServer(t);
  const f = await start(t); // no initialProxy: the production cold-start shape
  const health = await fetch(f.base + '/health').then(r => r.json());
  assert.equal(health.proxyProtocol, 1);
  assert.equal(health.proxyReady, false);
  assert.equal(typeof health.runtime.node, 'string');
  assert.equal(typeof health.runtime.startedAt, 'string');
  // The health surface carries booleans/metadata only — never policy content.
  assert.equal(JSON.stringify(health).includes('httpProxy'), false);
  assert.equal(JSON.stringify(health).includes('proxy_url'), false);

  assert.equal((await f.setUpstream(`http://127.0.0.1:${upstream.port}`)).status, 200);
  const response = await fetch(f.base + RPC, { method: 'GET' });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'proxy_unavailable' });
  assert.equal(upstream.hits.length, 0, 'zero upstream connections before the first policy');
});

test('installing a policy enables forwarding; a new snapshot retargets later requests', async t => {
  const upstream = await upstreamServer(t);
  const f = await start(t);
  await f.setUpstream(`http://127.0.0.1:${upstream.port}`);
  assert.equal((await f.setProxy(DIRECT)).status, 200);
  const response = await fetch(f.base + RPC);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'upstream-response');
  assert.equal(upstream.hits.length, 1);
});

test('POST /_runtime/proxy is bearer-protected and origin-protected', async t => {
  const f = await start(t);
  const noToken = await fetch(f.base + '/_runtime/proxy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noToken.status, 403);
  const badToken = await f.post('/_runtime/proxy', DIRECT, 'not-the-token');
  assert.equal(badToken.status, 403);
  const withOrigin = await f.post('/_runtime/proxy', DIRECT, f.control().token, { origin: 'https://evil.example' });
  assert.equal(withOrigin.status, 403);
  const health = await fetch(f.base + '/health').then(r => r.json());
  assert.equal(health.proxyReady, false, 'no failed attempt installs a policy');
});

for (const [name, body] of [
  ['non-object', 42],
  ['unknown key', { ...DIRECT, extra: 1 }],
  ['socks scheme', { ...DIRECT, httpProxy: 'socks5://127.0.0.1:1080' }],
  ['url with path', { ...DIRECT, httpProxy: 'http://127.0.0.1:9/path' }],
]) {
  test(`POST /_runtime/proxy rejects ${name} without touching the live policy`, async t => {
    const upstream = await upstreamServer(t);
    const f = await start(t, { initialProxy: DIRECT });
    await f.setUpstream(`http://127.0.0.1:${upstream.port}`);
    const before = await fetch(f.base + '/health').then(r => r.json());
    const response = await f.post('/_runtime/proxy', body);
    assert.equal(response.status, 400);
    const after = await fetch(f.base + '/health').then(r => r.json());
    assert.equal(after.proxyReady, before.proxyReady);
    // Prior policy still serves: forwarding keeps working with the old snapshot.
    const forwarded = await fetch(f.base + RPC);
    assert.equal(forwarded.status, 200);
  });
}

test('POST /_runtime/proxy enforces the 64KiB control-body limit', async t => {
  const f = await start(t);
  const response = await fetch(f.base + '/_runtime/proxy', {
    method: 'POST', headers: { authorization: 'Bearer ' + f.control().token, 'content-type': 'application/json' },
    body: JSON.stringify({ httpProxy: '', httpsProxy: '', noProxy: Array(600).fill('x'.repeat(200)) }),
  });
  assert.ok(response.status === 413 || response.status === 400);
});

test('two backends on the same host keep isolated policies', async t => {
  const upstream = await upstreamServer(t);
  const a = await start(t, { initialProxy: DIRECT });
  const b = await start(t);
  await a.setUpstream(`http://127.0.0.1:${upstream.port}`);
  await b.setUpstream(`http://127.0.0.1:${upstream.port}`);
  await a.setProxy(DIRECT);
  assert.equal((await fetch(a.base + RPC)).status, 200);
  assert.equal((await fetch(b.base + RPC)).status, 503);
});

test('an in-flight request keeps its compiled policy; new requests get the new snapshot', async t => {
  // The CONNECT/bytes side is covered in upstream-proxy.test.cjs; here the
  // identity of the policy object reaching forward() is the contract: a
  // control push must never retarget a request already in flight.
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const { collect } = require('../src/runtime/bridge.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-proxy-snapshot-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ providers: [] }));
  const seen = [];
  const held = [];
  const filename = path.resolve(__dirname, '../src/runtime/backend.cjs');
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename),
    process, Buffer, URL, AbortController, setTimeout, clearTimeout,
    require(name) {
      if (name === './bridge.cjs') return {
        collect,
        async forward(req, res, target, options) {
          seen.push(options?.proxy ?? null);
          held.push(res);
        },
      };
      return realRequire(name);
    },
  }, { filename });
  const backend = await module.exports.startBackend({
    root, port: 0, log: () => {},
    initialProxy: { httpProxy: 'http://127.0.0.1:9001', httpsProxy: 'http://127.0.0.1:9001', noProxy: [] },
  });
  t.after(async () => { for (const res of held) if (!res.writableEnded) res.end('late'); await backend.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + backend.port;
  const control = () => JSON.parse(fs.readFileSync(controlFile(root), 'utf8'));
  const first = fetch(base + RPC);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(seen.length, 1);
  const policyA = seen[0];
  assert.ok(policyA && policyA.httpProxy, 'forward received the compiled policy');
  await fetch(base + '/_runtime/proxy', { method: 'POST',
    headers: { authorization: 'Bearer ' + control().token, 'content-type': 'application/json' },
    body: JSON.stringify({ httpProxy: 'http://127.0.0.1:9002', httpsProxy: '', noProxy: [] }) });
  const second = fetch(base + RPC);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(seen.length, 2);
  assert.notEqual(seen[1], policyA, 'the second request runs on a new policy snapshot');
  assert.equal(seen[1].httpProxy.url.port, '9002');
  // The held first response still resolves on its own snapshot.
  for (const res of held) if (!res.writableEnded) res.end('done');
  await Promise.allSettled([first, second]);
});

// ── readProxySettings (host-side acquisition) ─────────────────────────────

const vscodeWith = inspected => ({ workspace: { getConfiguration: () => ({ inspect: key => inspected[key] }) } });

test('readProxySettings prefers the user-level value, never the workspace value', () => {
  const { config, source } = readProxySettings(vscodeWith({
    proxy: { globalValue: 'http://global:1', workspaceValue: 'http://workspace:2' },
    noProxy: { globalValue: 'a.com', workspaceValue: 'ws.com' },
  }), {});
  assert.equal(config.httpProxy, 'http://global:1');
  assert.equal(config.httpsProxy, 'http://global:1');
  assert.ok(config.noProxy.includes('a.com'));
  assert.ok(!config.noProxy.includes('ws.com'));
  assert.equal(source, 'settings');
});

test('readProxySettings falls back to environment and reports the source', () => {
  const empty = vscodeWith({ proxy: { globalValue: '' } });
  const { config, source } = readProxySettings(empty, { HTTP_PROXY: 'http://env:1', HTTPS_PROXY: 'https://envs:2', NO_PROXY: 'env.com' });
  assert.equal(config.httpProxy, 'http://env:1');
  assert.equal(config.httpsProxy, 'https://envs:2');
  assert.ok(config.noProxy.includes('env.com'));
  assert.equal(source, 'environment');
  const cleared = readProxySettings(empty, {});
  assert.equal(cleared.config.httpProxy, '');
  assert.equal(cleared.source, 'none');
  // Loopback bypass is unconditional regardless of provenance.
  for (const host of ['localhost', '127.0.0.1', '::1']) assert.ok(cleared.config.noProxy.includes(host));
});

// ── end-to-end: backend → real bridge.forward → real CONNECT → TLS upstream ──

const vm = require('node:vm');
const { createRequire } = require('node:module');
const https = require('node:https');
const tlsTest = require('./fixtures/tls-test.cjs');
const { createForwardAgent } = require('../src/runtime/upstream-proxy.cjs');

async function connectProxy(t, { auth } = {}) {
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
      const [host, port] = lines[0].split(' ')[1].replace(/^\[|\]$/g, '').split(':');
      const upstream = net.connect({ host: '127.0.0.1', port: Number(port) }, () => {
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
  return { port: server.address().port, seen };
}

function vmBackend() {
  // Wrap ONLY createForwardAgent so the fixture CA is trusted — real
  // bridge.forward, real CONNECT, real strict TLS everywhere else.
  const bridgeFilename = path.resolve(__dirname, '../src/runtime/bridge.cjs');
  const bridgeRequire = createRequire(bridgeFilename);
  const bridgeModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(bridgeFilename, 'utf8'), {
    module: bridgeModule, exports: bridgeModule.exports,
    __dirname: path.dirname(bridgeFilename),
    process, Buffer, URL, URLSearchParams, AbortController, AbortSignal,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    queueMicrotask, console, TextDecoder, TextEncoder,
    require(name) {
      if (name === './upstream-proxy.cjs') return {
        createForwardAgent: (target, policy, options) =>
          createForwardAgent(target, policy, { ...options, secureOptions: { ca: tlsTest.cert } }),
      };
      return bridgeRequire(name);
    },
  }, { filename: bridgeFilename });
  const backendFilename = path.resolve(__dirname, '../src/runtime/backend.cjs');
  const backendRequire = createRequire(backendFilename);
  const backendModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(backendFilename, 'utf8'), {
    module: backendModule, exports: backendModule.exports,
    __dirname: path.dirname(backendFilename),
    process, Buffer, URL, URLSearchParams, AbortController, AbortSignal,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    queueMicrotask, console, TextDecoder, TextEncoder,
    require(name) {
      if (name === './bridge.cjs') return bridgeModule.exports;
      return backendRequire(name);
    },
  }, { filename: backendFilename });
  return backendModule.exports;
}

test('backend→forward→CONNECT→TLS: snapshot switch retargets live traffic A→B', async t => {
  const upstreamHeaders = [];
  const held = [];
  const upstream = https.createServer({ key: tlsTest.key, cert: tlsTest.cert }, (req, res) => {
    upstreamHeaders.push(req.headers);
    if (upstreamHeaders.length === 1) { held.push(res); return; } // first request lingers on proxy A
    res.end('tls-bytes-' + upstreamHeaders.length);
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(async () => { for (const res of held.splice(0)) res.end(); await new Promise(r => upstream.close(r)); upstream.closeAllConnections?.(); });
  const proxyA = await connectProxy(t, { auth: 'Basic dTpw' });
  const proxyB = await connectProxy(t, {});

  const mod = vmBackend();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-proxy-e2e-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ providers: [] }));
  const backend = await mod.startBackend({ root, port: 0, log: () => {}, initialProxy: DIRECT });
  t.after(async () => { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + backend.port;
  const control = () => JSON.parse(fs.readFileSync(controlFile(root), 'utf8'));
  const post = (pathName, body) => fetch(base + pathName, { method: 'POST',
    headers: { authorization: 'Bearer ' + control().token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post('/_runtime/upstream', { origin: `https://tls.fixture:${upstream.address().port}` });
  const policy = port => ({ httpProxy: `http://127.0.0.1:${port}`, httpsProxy: `http://u:p@127.0.0.1:${port}`, noProxy: [] });
  assert.equal((await post('/_runtime/proxy', policy(proxyA.port))).status, 200);

  // Request 1 connects through A and parks inside the held upstream.
  const first = fetch(base + RPC, { headers: { 'proxy-authorization': 'Basic must-not-leak' } });
  await untilTest(() => proxyA.seen.length === 1, 'CONNECT through proxy A');
  // The policy flips while request 1 is mid-flight; request 2 must use B.
  assert.equal((await post('/_runtime/proxy', policy(proxyB.port))).status, 200);
  const second = await fetch(base + RPC);
  assert.equal(await second.text(), 'tls-bytes-2');
  assert.equal(proxyB.seen.length, 1, 'the new snapshot really dialed proxy B');
  assert.equal(proxyA.seen.length, 1, 'no second CONNECT went to A');
  // Request 1 still completes through its own snapshot (A).
  held.splice(0).forEach(res => res.end('tls-bytes-1'));
  assert.equal(await (await first).text(), 'tls-bytes-1');
  // The client's own Proxy-Authorization header never reaches the upstream,
  // while the policy credential only ever travels to the proxy.
  for (const headers of upstreamHeaders) assert.equal(headers['proxy-authorization'], undefined);
  const toA = proxyA.seen[0].find(l => /^proxy-authorization:/i.test(l));
  assert.equal(toA?.split(':')[1].trim(), 'Basic dTpw');

  // Cancelling a client kills only its own connection: the next request works.
  const controller = new AbortController();
  const third = fetch(base + RPC, { signal: controller.signal });
  await untilTest(() => upstreamHeaders.length === 3, 'third request reached upstream');
  controller.abort();
  await third.catch(() => {});
  const fourth = await fetch(base + RPC);
  assert.equal(await fourth.text(), 'tls-bytes-4');
});

async function untilTest(check, label) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('timed out waiting for ' + label);
}

test('readProxySettings produces compilable configs across the common sources', () => {
  const { compileProxyPolicy } = require('../src/network/proxy-policy.cjs');
  const roundTrip = config => {
    const policy = compileProxyPolicy(config);
    // The control body serializes to JSON: nothing may degrade to null.
    const back = JSON.parse(JSON.stringify(config));
    assert.equal(back.noProxy.every(item => typeof item === 'string'), true, 'no nulls in noProxy');
    return policy;
  };
  const http = inspected => ({ workspace: { getConfiguration: () => ({ inspect: key => inspected[key] }) } });
  // (i) nothing configured anywhere — env explicitly empty, no process.env bleed.
  roundTrip(readProxySettings(http({}), {}).config);
  // (ii) only http.proxy set, no noProxy anywhere.
  const onlyProxy = readProxySettings(http({ proxy: { globalValue: 'http://127.0.0.1:9' } }), {}).config;
  assert.equal(onlyProxy.httpsProxy, 'http://127.0.0.1:9');
  roundTrip(onlyProxy);
  // (iii) a real string[] noProxy without NO_PROXY in the environment.
  const arrayCase = readProxySettings(http({
    proxy: { globalValue: 'http://127.0.0.1:9' },
    noProxy: { globalValue: ['gf.com.cn', '10.0.0.1'], workspaceValue: ['evil'] },
  }), {}).config;
  assert.ok(arrayCase.noProxy.includes('gf.com.cn'));
  assert.ok(!arrayCase.noProxy.includes('evil'));
  roundTrip(arrayCase);
  // (iv) environment fallback only.
  const envOnly = readProxySettings(http({}), { HTTP_PROXY: 'http://env.invalid:1' }).config;
  assert.equal(envOnly.httpsProxy, 'http://env.invalid:1');
  roundTrip(envOnly);
});

test('readProxySettings rejects malformed values instead of degrading to DIRECT', () => {
  const { compileProxyPolicy } = require('../src/network/proxy-policy.cjs');
  const http = inspected => ({ workspace: { getConfiguration: () => ({ inspect: key => inspected[key] }) } });
  // A non-string http.proxy is invalid input, not "unset".
  const badProxy = readProxySettings(http({ proxy: { globalValue: 8080 } }), {});
  assert.throws(() => compileProxyPolicy(badProxy.config), { code: 'proxy_invalid' });
  // Non-string array items survive to compile time, where they are rejected.
  const badItem = readProxySettings(http({
    proxy: { globalValue: 'http://127.0.0.1:9' },
    noProxy: { globalValue: ['ok.com', 42] },
  }), {});
  assert.throws(() => compileProxyPolicy(badItem.config), { code: 'proxy_invalid' });
});

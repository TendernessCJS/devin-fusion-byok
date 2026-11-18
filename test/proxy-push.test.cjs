'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const actualBackend = require('../src/runtime/backend.cjs');
const { pushProxy } = require('../src/runtime/host/proxy.cjs');
const { rootIdentity } = require('../src/runtime/contract.cjs');
const { runtimeIdentity } = require('../src/runtime/source-identity.cjs');

const DIRECT = { httpProxy: '', httpsProxy: '', noProxy: [] };

async function start(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-proxy-push-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ providers: [] }));
  const backend = await actualBackend.startBackend({ root, port: 0, log: () => {}, initialProxy: DIRECT, ...options });
  t.after(async () => { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, backend };
}

test('pushProxy installs a policy and returns only safe fields', async t => {
  const { root, backend } = await start(t);
  const result = await pushProxy({ root, config: DIRECT, source: 'settings', port: backend.port });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'settings');
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'ready', 'source']);
  const health = await fetch(`http://127.0.0.1:${backend.port}/health`).then(r => r.json());
  assert.equal(health.proxyReady, true);
});

test('pushProxy reports unsupported against a backend without proxyProtocol', async t => {
  // Stand-in legacy service: same identity headers, no proxyProtocol.
  const { root } = await start(t);
  const identity = runtimeIdentity(root);
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...identity, instanceId: 'legacy', managementProtocol: 1, upstreamProtocol: 1 }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const result = await pushProxy({ root, config: DIRECT, port: server.address().port });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported'); // no proxyProtocol: never a silent success
});

test('pushProxy reports identity when the control file belongs to another root', async t => {
  const { root, backend } = await start(t);
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-proxy-foreign-'));
  fs.writeFileSync(path.join(foreign, 'config.json'), JSON.stringify({ providers: [] }));
  t.after(() => fs.rmSync(foreign, { recursive: true, force: true }));
  // The port serves `root`'s backend, but pushProxy is pointed at `foreign`:
  // identity must be refused before any policy crosses.
  const result = await pushProxy({ root: foreign, config: DIRECT, port: backend.port });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'identity');
});

test('pushProxy returns unavailable when nothing listens', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-proxy-dead-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = http.createServer(() => {});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  server.close();
  const result = await pushProxy({ root, config: DIRECT, port, signal: AbortSignal.timeout(3000) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unavailable');
});

test('pushProxy stops on an already-aborted signal without dialing', async t => {
  let dialed = false;
  const request = async () => { dialed = true; throw new Error('must not run'); };
  const controller = new AbortController();
  controller.abort();
  const result = await pushProxy({ root: '/nonexistent', config: DIRECT, port: 1, signal: controller.signal, request });
  assert.equal(result.ok, false);
  assert.equal(dialed, false);
});

test('an invalid payload answer is a failure, never a success', async t => {
  const { root, backend } = await start(t);
  const result = await pushProxy({ root, config: { httpProxy: 'socks5://x', httpsProxy: '', noProxy: [] }, port: backend.port });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid');
});

test('pushProxy keeps working when http.request/http.get are poisoned by the host', async t => {
  const { root, backend } = await start(t);
  const originalRequest = http.request;
  const originalGet = http.get;
  http.request = () => { throw new Error('patched transport must not be used'); };
  http.get = () => { throw new Error('patched transport must not be used'); };
  t.after(() => { http.request = originalRequest; http.get = originalGet; });
  const result = await pushProxy({ root, config: DIRECT, source: 'environment', port: backend.port });
  assert.equal(result.ok, true, 'the unpatched ClientRequest constructor still reaches the backend');
  assert.equal(result.source, 'environment');
});

test('pushProxy rejects a health/control pair with missing source identity', async t => {
  const { root } = await start(t);
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: 'devin-fusion-byok', rootId: rootIdentity(root).rootId,
        instanceId: 'x', managementProtocol: 1, proxyProtocol: 1, proxyReady: true }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  // No sourceId on either side: two `undefined`s must never compare equal and
  // unlock the bearer POST.
  const result = await pushProxy({ root, config: DIRECT, port: server.address().port });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'identity');
});

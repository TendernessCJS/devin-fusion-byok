'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const actualBackend = require('../src/runtime/backend.cjs');
const { collect } = require('../src/runtime/bridge.cjs');
const { buildCatalog, augmentCatalog } = require('../src/catalog.cjs');
const wire = require('../src/protocol/wire.cjs');
const http = require('node:http');
const API = '/exa.api_server_pb.ApiServerService/';

test('same-version Anthropic adapter changes invalidate the runtime source identity', () => {
  const filename = path.resolve(__dirname, '../src/runtime/backend.cjs');
  const realRequire = createRequire(filename);
  let adapterChanged = false;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), process,
    require(name) {
      if (name === 'node:fs') return { ...fs, readFileSync(file, ...options) {
        const original = fs.readFileSync(file, ...options);
        return adapterChanged && path.resolve(file) === path.resolve(__dirname, '../src/protocol/anthropic.cjs')
          ? Buffer.concat([Buffer.from(original), Buffer.from('\n// synthetic adapter change\n')]) : original;
      } };
      return realRequire(name);
    },
  }, { filename });
  const loaded = module.exports.runtimeIdentity('/synthetic-runtime-root');
  adapterChanged = true;
  assert.notEqual(module.exports.runtimeIdentity('/synthetic-runtime-root', true).sourceId, loaded.sourceId);
  assert.equal(module.exports.runtimeIdentity('/synthetic-runtime-root').sourceId, loaded.sourceId);
});

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-backend-test-'));
  // The retired preset list selected these natives; a role inclusion is the
  // current spelling of the same intent.
  const config = { providers: [{ id: 'test', name: 'Test', models: [{ id: 'model', label: 'Model' }] }], sidekicks: [{ nativeUid: 'swe-2-max', label: 'SWE-2 Max' }],
    roleInclusions: { lead: [], sidekick: ['swe-2-max', 'gpt-5-6-luna-high', 'swe-odd'].map(uid => ({ nativeUid: uid })) } };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const forwarded = [], chats = [], logs = [];
  const held = new Map();
  let hold = false;
  let natives = null;
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
          const body = options.body ?? await collect(req);
          forwarded.push({ target: target.href, body });
          if (natives && /ModelConfigs|GetUserStatus/.test(req.url)) options.onNativeModels?.(natives);
          if (hold) held.set(req.url, res);
          else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('official'); }
        },
      };
      if (name === '../protocol/responses.cjs') return { serveChat: async ({ route, res }) => { chats.push(route); res.end('custom'); } };
      return realRequire(name);
    },
  }, { filename });
  const backend = await module.exports.startBackend({ root, port: 0, log: (...event) => logs.push(event) });
  const base = 'http://127.0.0.1:' + backend.port;
  t.after(async () => {
    for (const res of held.values()) res.end();
    await backend.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const health = () => fetch(base + '/health').then(r => r.json());
  const control = () => JSON.parse(fs.readFileSync(actualBackend.controlFile(root), 'utf8'));
  const shutdown = (token = control().token) => fetch(base + '/_runtime/shutdown', { method: 'POST', headers: { authorization: 'Bearer ' + token } });
  return { root, config, backend, base, health, control, shutdown, forwarded, chats, logs, held,
    setHold: value => { hold = value; }, setNatives: value => { natives = value; } };
}

test('runtime health exposes ownership and source identity without exposing its private control token', async t => {
  const f = await fixture(t);
  const health = await f.health();
  const control = f.control();
  assert.equal(health.service, 'devin-fusion-byok');
  assert.equal(health.rootId, actualBackend.runtimeIdentity(f.root).rootId);
  assert.match(health.sourceId, /^[a-f0-9]{64}$/);
  assert.equal(health.managementProtocol, 1);
  assert.equal(health.activeRequests, 0);
  assert.equal(health.instanceId, control.instanceId);
  assert.match(control.token, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(health).includes(control.token));
  assert.ok(!JSON.stringify(f.logs).includes(control.token));
  assert.equal(fs.statSync(actualBackend.controlFile(f.root)).mode & 0o777, 0o600);
  assert.equal((await f.shutdown('wrong-token')).status, 403);
  assert.equal((await f.health()).draining, false);
});

test('monitor is authenticated, origin-blocked, and client validates runtime identity', async t => {
  const f = await fixture(t);
  const endpoint = f.base + '/_runtime/monitor';
  assert.equal((await fetch(endpoint)).status, 403);
  const headers = { authorization: 'Bearer ' + f.control().token };
  assert.equal((await fetch(endpoint, { headers: { ...headers, origin: 'https://example.com' } })).status, 403);
  const data = await (await fetch(endpoint, { headers })).json();
  assert.equal(data.snapshot.version, 1); assert.equal(data.snapshot.records.length, 0);
  assert.ok(!JSON.stringify(data).includes(f.control().token));
  const { readMonitor } = require('../src/runtime/monitor-client.cjs');
  const result = await readMonitor({ root: f.root, port: f.backend.port });
  assert.equal(result.status, 'ready'); assert.equal(result.snapshot.summary.requests, 0);
  await assert.rejects(readMonitor({ root: f.root + '-wrong', port: f.backend.port }), /identity/);
});

test('readMonitor retries once on connection-level failures', async t => {
  const f = await fixture(t);
  const { readMonitor } = require('../src/runtime/monitor-client.cjs');
  let calls = 0;
  const request = (url, options) => {
    calls += 1;
    if (calls === 1) { const error = new TypeError('fetch failed'); error.cause = { code: 'ECONNRESET' }; return Promise.reject(error); }
    return fetch(url, options);
  };
  const result = await readMonitor({ root: f.root, port: f.backend.port, request });
  assert.equal(result.status, 'ready');
  assert.equal(calls, 3, 'the first attempt dies on /health; the retry issues /health and /_runtime/monitor');
});

test('safe shutdown refuses active RPCs and stops only after the complete response', async t => {
  const f = await fixture(t);
  f.setHold(true);
  const rpc = '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings';
  const inflight = fetch(f.base + rpc, { method: 'POST', body: 'native' });
  while (!f.held.has(rpc)) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.health()).activeRequests, 1);
  assert.equal((await f.shutdown()).status, 409);
  assert.equal((await f.health()).draining, false);
  f.held.get(rpc).end('completed'); f.held.delete(rpc);
  assert.equal(await (await inflight).text(), 'completed');
  assert.equal((await f.health()).activeRequests, 0);
  assert.equal((await f.shutdown()).status, 200);
  await f.backend.stopped;
  assert.equal(fs.existsSync(actualBackend.controlFile(f.root)), false);
});

test('public-origin control calls cannot stop the daemon even with a valid token', async t => {
  const f = await fixture(t);
  const response = await fetch(f.base + '/_runtime/shutdown', { method: 'POST', headers: {
    origin: 'https://example.com', authorization: 'Bearer ' + f.control().token,
  } });
  assert.equal(response.status, 403);
  assert.equal((await f.health()).draining, false);
});

test('a second startup on the same port cannot overwrite the running runtime control file', async t => {
  const f = await fixture(t);
  const previous = fs.readFileSync(actualBackend.controlFile(f.root), 'utf8');
  await assert.rejects(actualBackend.startBackend({ root: f.root, port: f.backend.port }), { code: 'EADDRINUSE' });
  assert.equal(fs.readFileSync(actualBackend.controlFile(f.root), 'utf8'), previous);
});

test('native model requests, unknown model IDs and wrong RPC services never select a custom provider', async t => {
  const f = await fixture(t);
  for (const [rpc, modelUid] of [[API + 'GetChatMessage?keep=1', 'swe-2-max'], [API + 'GetChatMessage', '__proto__'], ['/exa.other_pb.OtherService/GetChatMessage', Object.keys(buildCatalog(f.config).routes)[0]]]) {
    const body = JSON.stringify({ modelUid, messages: [] });
    const response = await fetch(f.base + rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(await response.text(), 'official');
    assert.equal(f.forwarded.at(-1).body.toString(), body);
    assert.equal(f.forwarded.at(-1).target, 'https://server.codeium.com' + rpc);
  }
  assert.deepEqual(f.chats, []);
});

test('disabled configuration forwards even an otherwise valid custom model to the native backend', async t => {
  const f = await fixture(t);
  const modelUid = Object.keys(buildCatalog(f.config).routes)[0];
  f.config.enabled = false;
  fs.writeFileSync(path.join(f.root, 'config.json'), JSON.stringify(f.config));
  const response = await fetch(f.base + API + 'GetChatMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelUid }) });
  assert.equal(await response.text(), 'official');
  assert.deepEqual(f.chats, []);
});

test('known custom model requests use their exact provider route', async t => {
  const f = await fixture(t);
  const modelUid = Object.keys(buildCatalog(f.config).routes)[0];
  const response = await fetch(f.base + API + 'GetChatMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelUid }) });
  assert.equal(await response.text(), 'custom');
  assert.equal(f.chats.length, 1);
  assert.equal(f.chats[0].uid, modelUid);
  assert.deepEqual(f.forwarded, []);
});

test('an own plain model is listed, allowed and callable standalone against a third-party endpoint', async t => {
  const calls = [];
  const sse = 'data: {"choices":[{"index":0,"delta":{"content":"standalone-ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const provider = http.createServer(async (req, res) => {
    calls.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse((await collect(req)).toString()) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-backend-standalone-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { providers: [{ id: 'third', name: 'Third', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    apiFormat: 'openai', apiKey: 'fixture-provider-key', models: [{ id: 'standalone-model', label: 'Standalone' }, { id: 'peer-model', label: 'Peer' }] }],
    sidekicks: [{ providerId: 'third', model: 'standalone-model' }] };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const backend = await actualBackend.startBackend({ root, port: 0 });
  t.after(() => backend.close());
  const catalog = buildCatalog(config);
  const own = Object.keys(catalog.routes)[0];
  assert.match(own, /^dfbyok-/);
  const proto = { json: false, type: 'application/proto', framed: false };
  const allowed = augmentCatalog(wire.s(7, 'native-gpt'), { rpc: '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings', format: proto, catalog });
  const uids = wire.parseFields(allowed).filter(field => field.number === 7).map(field => field.value.toString());
  assert.equal(uids[0], 'native-gpt');
  assert.ok(uids.includes(own));
  const mirrored = Object.values(catalog.fusions);
  assert.equal(mirrored.length, 2, 'the two BYOK cross pairs are mirrored even without any native observation');
  assert.ok(mirrored.every(fusion => fusion.leadUid !== fusion.sidekickUid), 'same-family pairs are never emitted');
  const ownFusion = mirrored.find(fusion => fusion.leadUid === own);
  assert.ok(ownFusion);
  const lockedNative = Buffer.concat([wire.s(1, 'Fusion (Locked)'), wire.s(22, 'fusion-official-locked'), wire.v(4, 1), wire.m(32, wire.v(1, 1))]);
  const listed = augmentCatalog(wire.m(1, lockedNative), { rpc: API + 'GetCliModelConfigs', format: proto, catalog });
  const entries = wire.parseFields(listed).filter(field => field.number === 1 && field.wire === 2).map(field => field.value);
  const mirroredUids = new Set(mirrored.map(fusion => fusion.uid));
  assert.deepEqual(entries.slice(0, 2).map(entry => wire.str(entry, 22)).sort(), [...mirroredUids].sort(), 'mirrored combinations lead the list');
  assert.equal(wire.str(entries[2], 22), own);
  assert.equal(wire.str(entries.at(-1), 22), 'fusion-official-locked');
  assert.equal(wire.num(entries.at(-1), 4), 1);
  const response = await fetch('http://127.0.0.1:' + backend.port + API + 'GetChatMessage', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelUid: own, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes('standalone-ok'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/v1/chat/completions');
  assert.equal(calls[0].body.model, 'standalone-model');
  assert.equal(calls[0].authorization, 'Bearer fixture-provider-key');
});

test('a catalog observation enables AssignModel with the native Sidekick exact harness intersection', async t => {
  const f = await fixture(t);
  const observed = [
    { uid: 'swe-2-max', label: 'SWE-2 Max', disabled: false, isModelRouter: false, harnessUids: ['swe-1p5', 'other-harness'] },
    { uid: 'fusion-lead-a-sidekick-swe-2-max', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 3, name: 'SWE-2 Max' } },
  ];
  const fusion = Object.values(buildCatalog(f.config, observed).fusions).find(fusion => fusion.sidekickUid === 'swe-2-max');
  assert.ok(fusion, 'fixture config saves swe-2-max as a native Sidekick preference');
  const before = JSON.stringify({ modelRouterUid: fusion.uid, fusionLeadRouterUid: fusion.uid });
  const cold = await fetch(f.base + API + 'AssignModel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: before });
  assert.equal(await cold.text(), 'official', 'before any catalog observation the combination fails closed');
  f.setNatives(observed);
  const catalogResponse = await fetch(f.base + API + 'GetCliModelConfigs', { method: 'POST', body: 'native' });
  assert.equal(await catalogResponse.text(), 'official');
  const resolved = await fetch(f.base + API + 'AssignModel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: before });
  const data = JSON.parse(await resolved.text());
  assert.equal(data.assignment.modelUid, 'swe-2-max');
  assert.deepEqual(data.assignment.harnessUids, ['swe-1p5', 'other-harness']);
});

test('a saved native Sidekick preference alone never grants capability without observation', async t => {
  const f = await fixture(t);
  const fusionUid = Object.values(buildCatalog(f.config, [
    { uid: 'swe-2-max', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] },
    { uid: 'fusion-lead-a-sidekick-swe-2-max', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 3, name: 'SWE-2 Max' } },
  ]).fusions)
    .find(fusion => fusion.sidekickUid === 'swe-2-max').uid;
  const response = await fetch(f.base + API + 'AssignModel', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelRouterUid: fusionUid, fusionLeadRouterUid: fusionUid }) });
  assert.equal(await response.text(), 'official');
  assert.equal(f.forwarded.at(-1).target, 'https://server.codeium.com' + API + 'AssignModel');
});

test('officially paired and standalone native Sidekicks assign declared harnesses', async t => {
  const f = await fixture(t);
  const observed = [
    { uid: 'gpt-5-6-luna-high', label: 'GPT-5.6 Luna High Thinking', disabled: false, isModelRouter: false, harnessUids: ['gpt-5p6'] },
    { uid: 'swe-odd', label: 'Odd', disabled: false, isModelRouter: false, harnessUids: ['odd-harness'] },
    { uid: 'fusion-official-sidekick-gpt-5-6-luna-high', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'],
      sidekickDimension: { order: 4, name: 'GPT-5.6 Luna High' } },
    { uid: 'fusion-official-sidekick-swe-odd', label: 'F', disabled: true, isModelRouter: true, harnessUids: ['fusion'],
      sidekickDimension: { order: 9, name: 'Odd' } },
  ];
  const built = buildCatalog(f.config, observed);
  const luna = Object.values(built.fusions).find(fusion => fusion.sidekickUid === 'gpt-5-6-luna-high');
  assert.ok(luna, 'enabled official pairing makes the unfamiliar-harness native eligible');
  // Both natives are included as Sidekicks, so both are mirrored.
  const odd = Object.values(built.fusions).find(fusion => fusion.sidekickUid === 'swe-odd');
  assert.ok(odd, 'an unlocked standalone native is eligible once included');
  assert.deepEqual(odd.sidekickHarnessUids, ['odd-harness']);
  f.setNatives(observed);
  await fetch(f.base + API + 'GetCliModelConfigs', { method: 'POST', body: 'native' });
  const resolved = await fetch(f.base + API + 'AssignModel', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelRouterUid: luna.uid, fusionLeadRouterUid: luna.uid }) });
  const data = JSON.parse(await resolved.text());
  assert.equal(data.assignment.modelUid, 'gpt-5-6-luna-high');
  assert.deepEqual(data.assignment.harnessUids, ['gpt-5p6'], 'the declared official harness is forwarded exactly');
  // `odd` is only emittable against a selected Lead, so the observation is
  // dropped first to prove the harness travels on the mirrored entry itself.
  assert.ok(Object.values(built.fusions).some(fusion => fusion.sidekickUid === 'swe-odd'));
  const oddPreset = Object.values(buildCatalog(f.config, observed).fusions).find(fusion => fusion.sidekickUid === 'swe-odd');
  assert.ok(oddPreset);
  const oddResolved = await fetch(f.base + API + 'AssignModel', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelRouterUid: oddPreset.uid, fusionLeadRouterUid: oddPreset.uid }) });
  const oddData = JSON.parse(await oddResolved.text());
  assert.equal(oddData.assignment.modelUid, 'swe-odd');
  assert.deepEqual(oddData.assignment.harnessUids, ['odd-harness']);
  const disabled = observed.map(item => item.uid === 'swe-odd' ? { ...item, disabled: true } : item);
  assert.equal(Object.values(buildCatalog(f.config, disabled).fusions).some(fusion => fusion.sidekickUid === 'swe-odd'), false);
});

test('backend close waits for the monitor write queue to drain', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-backend-monitor-close-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ providers: [] }));
  const filename = path.resolve(__dirname, '../src/runtime/backend.cjs');
  const realRequire = createRequire(filename);
  let releaseClose, monitorClosed = false;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename),
    process, Buffer, URL, AbortController, setTimeout, clearTimeout,
    require(name) {
      if (name === './monitor.cjs') return { createMonitor: () => ({
        record() {},
        async snapshot() { return {}; },
        close() { monitorClosed = true; return new Promise(resolve => { releaseClose = resolve; }); },
      }) };
      return realRequire(name);
    },
  }, { filename });
  const backend = await module.exports.startBackend({ root, port: 0, log: () => {} });
  t.after(async () => { releaseClose?.(); await backend.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let resolved = false;
  const closing = backend.close().then(() => { resolved = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(monitorClosed, true);
  assert.equal(resolved, false, 'close must not resolve before the monitor queue drains');
  releaseClose();
  await closing;
  assert.equal(resolved, true);
  await backend.stopped;
});

test('close drains in-flight RPCs, keeps health during the monitor flush, then releases the port', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-backend-drain-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ providers: [] }));
  const filename = path.resolve(__dirname, '../src/runtime/backend.cjs');
  const realRequire = createRequire(filename);
  const held = [];
  let releaseMonitor, monitorCloseStarted = false;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename),
    process, Buffer, URL, AbortController, setTimeout, clearTimeout,
    require(name) {
      if (name === './monitor.cjs') return { createMonitor: () => ({
        record() {},
        async snapshot() { return {}; },
        close() { monitorCloseStarted = true; return new Promise(resolve => { releaseMonitor = resolve; }); },
      }) };
      if (name === './bridge.cjs') return { collect, async forward(req, res) { held.push(res); } };
      return realRequire(name);
    },
  }, { filename });
  const backend = await module.exports.startBackend({ root, port: 0, log: () => {} });
  const base = 'http://127.0.0.1:' + backend.port;
  const health = () => fetch(base + '/health').then(r => r.json());
  t.after(async () => {
    for (const res of held) res.end();
    for (let i = 0; i < 200 && !releaseMonitor; i++) await new Promise(resolve => setImmediate(resolve));
    releaseMonitor?.();
    await Promise.race([backend.close(), new Promise(resolve => setTimeout(resolve, 1000))]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const inflight = fetch(base + API + 'GetChatMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelUid: 'unknown-model', messages: [] }) });
  for (let i = 0; i < 100 && !held.length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(held.length, 1, 'the forwarded RPC is held in flight');
  assert.equal((await health()).activeRequests, 1);

  let resolved = false;
  const closing = backend.close().then(() => { resolved = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(monitorCloseStarted, false, 'the monitor flush must wait for in-flight RPCs to finish');
  assert.equal(resolved, false);

  const duringDrain = await health();
  assert.equal(duringDrain.draining, true, 'health stays available and reports draining');
  assert.equal((await fetch(base + API + 'GetChatMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelUid: 'unknown-model', messages: [] }) })).status, 503, 'new RPCs are refused while draining');

  held[0].end('done');
  await inflight;
  for (let i = 0; i < 200 && !monitorCloseStarted; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(monitorCloseStarted, true, 'monitor flush starts once requests drain');
  assert.equal(resolved, false, 'close still waits for the monitor queue');
  const duringFlush = await health();
  assert.equal(duringFlush.draining, true, 'health stays reachable while the monitor flushes');

  releaseMonitor();
  const outcome = await Promise.race([closing.then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('hung'), 2000))]);
  assert.equal(outcome, 'closed');
  assert.equal(resolved, true);
  await backend.stopped;
  await assert.rejects(fetch(base + '/health'), 'the port is released after the flush completes');
  assert.equal(fs.existsSync(actualBackend.controlFile(root)), false);
});

test('close waits for both the client response and the serveChat handler so late metrics land', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-backend-dual-drain-'));
  const config = { providers: [{ id: 'test', name: 'Test', models: [{ id: 'model', label: 'Model' }] }], sidekicks: [] };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const own = Object.keys(buildCatalog(config).routes)[0];
  const filename = path.resolve(__dirname, '../src/runtime/backend.cjs');
  const realRequire = createRequire(filename);
  const events = [];
  let entered = false, releaseHandler;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename),
    process, Buffer, URL, AbortController, setTimeout, clearTimeout,
    require(name) {
      if (name === './monitor.cjs') return { createMonitor: () => ({
        record(data) { events.push('record'); assert.equal(events.includes('monitor-close'), false, 'late metrics must arrive before the monitor closes'); },
        async snapshot() { return {}; },
        close() { events.push('monitor-close'); return Promise.resolve(); },
      }) };
      if (name === '../protocol/responses.cjs') return { serveChat: async ({ res, onMetrics }) => {
        entered = true;
        await new Promise(resolve => { releaseHandler = resolve; });
        onMetrics({ id: 'late-1', startedAt: '2026-01-01T00:00:00Z', status: 'cancelled', model: 'm', providerId: 'p' });
        res.end('done');
      } };
      return realRequire(name);
    },
  }, { filename });
  const backend = await module.exports.startBackend({ root, port: 0, log: () => {} });
  const base = 'http://127.0.0.1:' + backend.port;
  t.after(async () => { releaseHandler?.(); await Promise.race([backend.close(), new Promise(r => setTimeout(r, 1000))]); fs.rmSync(root, { recursive: true, force: true }); });
  const abort = new AbortController();
  const inflight = fetch(base + API + 'GetChatMessage', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelUid: own, messages: [{ role: 'user', content: 'hi' }] }), signal: abort.signal });
  inflight.catch(() => {});
  for (let i = 0; i < 200 && !entered; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, true, 'serveChat entered and holds its gate');
  abort.abort();
  for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve));
  const closing = backend.close();
  let closed = false;
  closing.then(() => { closed = true; });
  for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve));
  const health = await fetch(base + '/health').then(r => r.json());
  assert.equal(health.activeRequests, 1, 'a finished response alone must not drain the request while the handler still runs');
  assert.equal(events.includes('monitor-close'), false, 'monitor flush must not start while a handler is unfinished');
  assert.equal(closed, false);
  releaseHandler();
  const outcome = await Promise.race([closing.then(() => 'closed'), new Promise(r => setTimeout(() => r('hung'), 2000))]);
  assert.equal(outcome, 'closed');
  assert.deepEqual(events, ['record', 'monitor-close'], 'the cancelled request still records metrics before the monitor closes');
  await backend.stopped;
});

test('same-version monitor-stats changes invalidate the runtime source identity', () => {
  const filename = path.resolve(__dirname, '../src/runtime/backend.cjs');
  const realRequire = createRequire(filename);
  let statsChanged = false;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), process,
    require(name) {
      if (name === 'node:fs') return { ...fs, readFileSync(file, ...options) {
        const original = fs.readFileSync(file, ...options);
        return statsChanged && path.resolve(file) === path.resolve(__dirname, '../src/runtime/monitor-stats.cjs')
          ? Buffer.concat([Buffer.from(original), Buffer.from('\n// synthetic stats change\n')]) : original;
      } };
      return realRequire(name);
    },
  }, { filename });
  const loaded = module.exports.runtimeIdentity('/synthetic-runtime-root');
  statsChanged = true;
  assert.notEqual(module.exports.runtimeIdentity('/synthetic-runtime-root', true).sourceId, loaded.sourceId);
  assert.equal(module.exports.runtimeIdentity('/synthetic-runtime-root').sourceId, loaded.sourceId);
});

test('the host can push its richer observations and the backend serves them', async t => {
  const f = await fixture(t);
  const { pushNativeModels } = require('../src/runtime/native-models.cjs');
  const health = await f.health();
  assert.equal(health.nativeModelsIngest, 1, 'the ingest capability is advertised');
  const endpoint = f.base + '/_runtime/native-models';
  // The shape the native extension really reports: the model itself plus the
  // official pairing entry that binds it as a Sidekick.
  const rich = [
    { uid: 'swe-2-high', label: 'SWE-2 High', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'],
      fusionMetadata: [{ key: 'Effort', order: 3, name: 'High', controlType: 1 }] },
    { uid: 'fusion-swe-2-high-sidekick-swe-2-high', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'],
      sidekickDimension: { order: 2, name: 'SWE-2 High', fastModeOrder: 0 } },
  ];

  // Auth and origin are enforced exactly like the read endpoint.
  assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer ' + f.control().token, origin: 'https://example.com' }, body: '{}' })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer ' + f.control().token }, body: '"not-an-object"' })).status, 400);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer ' + f.control().token }, body: JSON.stringify({ models: 'nope' }) })).status, 400);

  const pushed = await pushNativeModels({ root: f.root, port: f.backend.port, models: rich });
  assert.equal(pushed.pushed, 2);
  assert.equal(pushed.improved, true, 'the backend had nothing, so the push improved it');
  const read = await (await fetch(endpoint, { headers: { authorization: 'Bearer ' + f.control().token } })).json();
  assert.deepEqual(read.models, rich, 'the backend now serves the pushed observations');
  // A second identical push is accepted but changes nothing, so a throttled
  // host can repeat it without churning the cache file.
  const again = await pushNativeModels({ root: f.root, port: f.backend.port, models: rich });
  assert.equal(again.pushed, 2);
  assert.equal(again.improved, false);

  // The point of the push: the backend's own catalog now resolves the native
  // Sidekick, so the payload and allowlist it serves agree with the host
  // instead of mirroring only the configurations the CLI happened to reveal.
  const built = buildCatalog(f.config, read.models);
  assert.ok(Object.values(built.fusions).some(fusion => fusion.sidekickUid === 'swe-2-high'),
    'the pushed binding produces the native Sidekick combinations');
  assert.ok(built.matrixUids.size >= 1);
});

test('a push is refused when identity, capability or the payload do not line up', async t => {
  const f = await fixture(t);
  const { pushNativeModels } = require('../src/runtime/native-models.cjs');
  const models = [{ uid: 'swe-2-high', label: 'F', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] }];
  assert.deepEqual(await pushNativeModels({ root: f.root + '-wrong', port: f.backend.port, models }), { pushed: 0, reason: 'identity' });
  // Our own uids are never upstream observations, so a payload of only those is
  // not worth sending.
  assert.deepEqual(await pushNativeModels({ root: f.root, port: f.backend.port,
    models: [{ uid: 'dfbyok-own', label: 'x', disabled: false, isModelRouter: false, harnessUids: ['fusion'] }] }), { pushed: 0, reason: 'empty' });
  assert.deepEqual(await pushNativeModels({ root: f.root, port: f.backend.port, models: [] }), { pushed: 0, reason: 'empty' });
  // A dead port is a skip, never a throw: the host keeps its own richer view.
  assert.deepEqual((await pushNativeModels({ root: f.root, port: 1, models })).reason, 'unavailable');
  // An older backend advertises no ingest capability and is left alone.
  const legacy = await fixture(t);
  const legacyFetch = async (url, options) => {
    if (String(url).endsWith('/health')) return { ok: true, json: async () => ({ ...(await legacy.health()), nativeModelsIngest: undefined }) };
    throw new Error('must not push');
  };
  assert.deepEqual(await pushNativeModels({ root: legacy.root, port: legacy.backend.port, models, request: legacyFetch }),
    { pushed: 0, reason: 'unsupported' });
});

// A half-read SSE stream can leave a response that is neither finished nor
// closed, so release() never runs and an unbounded drain never completes. That
// made close() hang, which in turn made SIGTERM a no-op (its handler awaits
// close()) and left an orphan backend only SIGKILL could remove.
async function stuckFixture(t, drainTimeoutMs = 60) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-backend-stuck-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ providers: [] }));
  const filename = path.resolve(__dirname, '../src/runtime/backend.cjs');
  const realRequire = createRequire(filename);
  const held = [], logs = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename),
    process, Buffer, URL, AbortController, setTimeout, clearTimeout,
    require(name) {
      // The RPC is accepted and then never answered: exactly the shape a dropped
      // stream leaves behind.
      if (name === './bridge.cjs') return { collect, async forward(req, res) { held.push(res); } };
      return realRequire(name);
    },
  }, { filename });
  const backend = await module.exports.startBackend({ root, port: 0, log: (...event) => logs.push(event), drainTimeoutMs });
  t.after(async () => {
    for (const res of held) res.destroy?.();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, backend, base: 'http://127.0.0.1:' + backend.port, held, logs, controlFile: actualBackend.controlFile(root) };
}

test('a request that never settles cannot block shutdown forever', async t => {
  const f = await stuckFixture(t);
  const inflight = fetch(f.base + API + 'GetChatMessage', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelUid: 'unknown-model', messages: [] }) }).catch(() => {});
  for (let i = 0; i < 100 && !f.held.length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.held.length, 1, 'the forwarded RPC is held in flight');

  const outcome = await Promise.race([
    f.backend.close().then(() => 'closed'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 1500)),
  ]);
  assert.equal(outcome, 'closed', 'close must resolve even with an unsettled request');
  assert.ok(f.logs.some(([event]) => event === 'drain-timeout'), 'the abandoned drain is reported');
  await f.backend.stopped;
  assert.equal(fs.existsSync(f.controlFile), false, 'the control file is released so the next start is clean');
  // The listening socket is released too: a fresh connect is refused, so a
  // replacement backend can bind immediately instead of losing the race.
  await assert.rejects(fetch(f.base + '/health'), 'the port is no longer served');
  f.held[0].destroy?.();
  await inflight;
});

test('close resolves promptly when nothing is in flight', async t => {
  const f = await stuckFixture(t);
  const started = Date.now();
  await f.backend.close();
  assert.ok(Date.now() - started < 1000, 'an idle close does not wait for the timeout');
  assert.ok(!f.logs.some(([event]) => event === 'drain-timeout'), 'no drain was abandoned');
  await f.backend.stopped;
});

test('a stuck monitor flush cannot block shutdown either', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-backend-monitor-stuck-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ providers: [] }));
  const filename = path.resolve(__dirname, '../src/runtime/backend.cjs');
  const realRequire = createRequire(filename);
  const logs = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename),
    process, Buffer, URL, AbortController, setTimeout, clearTimeout,
    require(name) {
      // A queue that never drains: close() must not inherit its hang.
      if (name === './monitor.cjs') return { createMonitor: () => ({ record() {}, async snapshot() { return {}; }, close: () => new Promise(() => {}) }) };
      return realRequire(name);
    },
  }, { filename });
  const backend = await module.exports.startBackend({ root, port: 0, log: (...event) => logs.push(event), drainTimeoutMs: 60 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outcome = await Promise.race([
    backend.close().then(() => 'closed'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 1500)),
  ]);
  assert.equal(outcome, 'closed');
  assert.ok(logs.some(([event]) => event === 'monitor-close-timeout'), 'the abandoned flush is reported');
  await backend.stopped;
});

// The host's reader treats a served dfbyok uid as an invalid catalog and fails
// the whole refresh, so the backend must never store one — even if a future
// caller forgets to filter its payload.
test('the backend never stores our own uids, so a read cannot be poisoned', async t => {
  const f = await fixture(t);
  const endpoint = f.base + '/_runtime/native-models';
  const headers = { authorization: 'Bearer ' + f.control().token, 'content-type': 'application/json' };
  const pushed = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ models: [
    { uid: 'dfbyok-provider-x-model-y-1111', label: 'own', disabled: false, isModelRouter: false, harnessUids: ['fusion'] },
    { uid: 'fusion-dfbyok-preset-2222', label: 'own fusion', disabled: false, isModelRouter: true, harnessUids: ['fusion'] },
    { uid: 'swe-2-high', label: 'SWE-2 High', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] },
  ] }) });
  assert.equal(pushed.status, 200);
  const result = await pushed.json();
  assert.equal(result.accepted, 1, 'only the upstream entry is accepted');
  const read = await (await fetch(endpoint, { headers })).json();
  assert.deepEqual(read.models.map(entry => entry.uid), ['swe-2-high']);
  // And the host's own reader agrees the payload is usable.
  const { readNativeModels } = require('../src/runtime/native-models.cjs');
  const seen = await readNativeModels({ root: f.root, port: f.backend.port });
  assert.equal(seen.status, 'ready');
  assert.deepEqual(seen.models.map(entry => entry.uid), ['swe-2-high']);
});

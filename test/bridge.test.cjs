'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { createLsBridge, forward, collect } = require('../src/runtime/bridge.cjs');
const { buildCatalog } = require('../src/catalog.cjs');
const wire = require('../src/protocol/wire.cjs');
const LS = '/exa.language_server_pb.LanguageServerService/';
const catalog = buildCatalog({ providers: [{ id: 'test', name: 'Test', models: [{ id: 'test-model', label: 'Test model' }] }] });

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
async function request(port, pathname, { body = Buffer.alloc(0), headers = {}, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port, method, path: pathname, headers }, async response => {
      try { resolve({ status: response.statusCode, headers: response.headers, body: await collect(response) }); }
      catch (error) { reject(error); }
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

test('LS bridge preserves native RPC bytes, query, CSRF, streaming response and cancellation headers', async t => {
  const payload = Buffer.from([0, 1, 0xff, 4]);
  const native = await listen(async (req, res) => {
    assert.equal(req.url, LS + 'Heartbeat?native=value');
    assert.equal(req.headers['x-codeium-csrf-token'], 'test-csrf');
    assert.deepEqual(await collect(req), payload);
    res.writeHead(200, { 'content-type': 'application/connect+proto', 'x-native-header': 'retained' });
    res.write(payload.subarray(0, 2)); res.end(payload.subarray(2));
  });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog });
  t.after(() => bridge.close());
  const response = await request(bridge.port, LS + 'Heartbeat?native=value', {
    body: payload, headers: { 'x-codeium-csrf-token': 'test-csrf', 'content-type': 'application/connect+proto' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['x-native-header'], 'retained');
  assert.deepEqual(response.body, payload);
});

test('catalog augmentation preserves upstream gzip and re-compresses the rewritten payload', async t => {
  const original = { clientModelConfigs: [{ modelUid: 'official', label: 'Official' }] };
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(zlib.gzipSync(JSON.stringify(original)));
  });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog });
  t.after(() => bridge.close());
  const response = await request(bridge.port, LS + 'GetCliModelConfigs');
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-encoding'], 'gzip');
  assert.equal(response.headers['transfer-encoding'], undefined);
  assert.equal(Number(response.headers['content-length']), response.body.length);
  const json = JSON.parse(zlib.gunzipSync(response.body).toString('utf8'));
  assert.deepEqual(json.clientModelConfigs.slice(0, catalog.models.length).map(model => model.modelUid), catalog.models.map(model => model.uid));
  assert.equal(json.clientModelConfigs.at(-1).modelUid, 'official');
  assert.equal(json.clientModelConfigs.length, 1 + catalog.models.length);
});

test('ForSite catalog RPCs resolve to the same payload shape as their base method', () => {
  const { rpcShape } = require('../src/catalog/payload.cjs');
  for (const [service, method] of [
    ['/exa.api_server_pb.ApiServerService/', 'GetCliModelConfigs'],
    ['/exa.api_server_pb.ApiServerService/', 'GetCascadeModelConfigs'],
    ['/exa.api_server_pb.ApiServerService/', 'GetCommandModelConfigs'],
    ['/exa.language_server_pb.LanguageServerService/', 'GetCliModelConfigs'],
    ['/exa.seat_management_pb.SeatManagementService/', 'GetUserStatus'],
  ]) {
    assert.deepEqual(rpcShape(service + method + 'ForSite'), rpcShape(service + method), method + 'ForSite');
  }
});

test('a ForSite catalog response is augmented exactly like the base RPC', async t => {
  const original = { clientModelConfigs: [{ modelUid: 'official', label: 'Official' }] };
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(original));
  });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog });
  t.after(() => bridge.close());
  const response = await request(bridge.port, LS + 'GetCliModelConfigsForSite');
  assert.equal(response.status, 200);
  const json = JSON.parse(response.body);
  assert.equal(json.clientModelConfigs.length, 1 + catalog.models.length);
  assert.equal(json.clientModelConfigs.at(-1).modelUid, 'official');
});

test('unknown catalog-shaped RPCs report once per method, known traffic stays quiet', async t => {
  const reports = [];
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog, onUnknownCatalog: method => reports.push(method) });
  t.after(() => bridge.close());
  const api = '/exa.api_server_pb.ApiServerService/';
  await request(bridge.port, api + 'GetModelProviders');
  await request(bridge.port, api + 'GetModelProviders');
  assert.deepEqual(reports, ['GetModelProviders'], 'an unknown catalog-like method reports exactly once');
  await request(bridge.port, api + 'GetChatMessage');
  assert.deepEqual(reports, ['GetModelProviders'], 'an unrelated RPC reports nothing');
  await request(bridge.port, api + 'GetCliModelConfigs');
  assert.deepEqual(reports, ['GetModelProviders'], 'a known catalog RPC reports nothing');
  await request(bridge.port, api + 'GetModelStatuses');
  assert.deepEqual(reports, ['GetModelProviders'], 'a reviewed pass-through RPC reports nothing');
});

test('GetModelStatuses forwards untouched through the bridge', async t => {
  const upstream = { modelStatusInfos: [{ modelUid: 'official', status: 2, message: 'warn' }] };
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(upstream));
  });
  t.after(() => native.close());
  const reports = [];
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog, onUnknownCatalog: method => reports.push(method) });
  t.after(() => bridge.close());
  const response = await request(bridge.port, '/exa.language_server_pb.LanguageServerService/GetModelStatuses');
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), upstream, 'the badge list passes through byte-identical');
  assert.deepEqual(reports, [], 'a KNOWN_UNCHANGED method never reports');
});

test('catalog augmentation of an uncompressed upstream stays plain', async t => {
  const original = { clientModelConfigs: [{ modelUid: 'official', label: 'Official' }] };
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(original));
  });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog });
  t.after(() => bridge.close());
  const response = await request(bridge.port, LS + 'GetCliModelConfigs');
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-encoding'], undefined);
  assert.equal(Number(response.headers['content-length']), response.body.length);
  const json = JSON.parse(response.body);
  assert.equal(json.clientModelConfigs.length, 1 + catalog.models.length);
  assert.equal(json.clientModelConfigs.at(-1).modelUid, 'official');
});

test('compressed Connect catalog emits uncompressed frames without stale encoding headers', async t => {
  const input = { clientModelConfigs: [] };
  const encoded = wire.encode(input, { json: true, framed: true, compressed: true });
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/connect+json', 'connect-content-encoding': 'gzip' });
    res.end(encoded);
  });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog });
  t.after(() => bridge.close());
  const response = await request(bridge.port, LS + 'GetCliModelConfigs');
  assert.equal(response.headers['connect-content-encoding'], undefined);
  assert.equal(response.body[0], 0);
  assert.equal(wire.decode(response.body, response.headers).data.clientModelConfigs.length, catalog.models.length);
});

test('unrecognized service names and malformed catalogs retain upstream body and encoding', async t => {
  const encoded = zlib.gzipSync('{malformed-json');
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': encoded.length });
    res.end(encoded);
  });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog });
  t.after(() => bridge.close());
  for (const pathname of ['/unrelated/GetCliModelConfigs', LS + 'GetCliModelConfigs']) {
    const response = await request(bridge.port, pathname);
    assert.deepEqual(response.body, encoded);
    assert.equal(response.headers['content-encoding'], 'gzip');
  }
});

test('buffered native forwards replace chunked framing with the actual content length', async t => {
  const native = await listen(async (req, res) => {
    assert.equal(req.headers['transfer-encoding'], undefined);
    assert.equal(req.headers['content-length'], '7');
    res.end(await collect(req));
  });
  t.after(() => native.close());
  const relay = await listen(async (req, res) => {
    const body = await collect(req);
    forward(req, res, new URL('http://127.0.0.1:' + native.port + req.url), { body });
  });
  t.after(() => relay.close());
  const response = await request(relay.port, '/native', { body: Buffer.from('replay!'), headers: { 'transfer-encoding': 'chunked' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.toString(), 'replay!');
});

test('LS bridge rejects absolute URLs and supports native origin preflight', async t => {
  let nativeRequests = 0;
  const native = await listen((req, res) => { nativeRequests++; res.end(); });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog });
  t.after(() => bridge.close());
  assert.equal((await request(bridge.port, 'http://example.com/')).status, 400);
  assert.equal((await request(bridge.port, '//example.com/')).status, 400);
  const response = await request(bridge.port, LS + 'GetUserStatus', { method: 'OPTIONS', headers: {
    origin: 'vscode-file://vscode-app', 'access-control-request-headers': 'content-type,x-codeium-csrf-token',
  } });
  assert.equal(response.status, 204);
  assert.equal(response.headers['access-control-allow-origin'], 'vscode-file://vscode-app');
  assert.equal(response.headers['access-control-allow-headers'], 'content-type,x-codeium-csrf-token');
  assert.equal(nativeRequests, 0);
});

test('catalog RPCs report sanitized native models to the observer and keep hidden entries filtered', async t => {
  const hiddenCatalog = { ...catalog, hiddenNativeModelUids: ['official-hidden'] };
  const original = { clientModelConfigs: [
    { modelUid: 'official-hidden', label: 'Hidden Official', disabled: true, accountUrl: 'https://secret.invalid' },
    { modelUid: 'official-shown', label: 'Shown Official' },
  ] };
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(original));
  });
  t.after(() => native.close());
  const reports = [];
  const bridge = await createLsBridge(native.port, { getCatalog: () => hiddenCatalog, onNativeModels: entries => reports.push(entries) });
  t.after(() => bridge.close());
  const response = await request(bridge.port, LS + 'GetCliModelConfigs');
  assert.equal(response.status, 200);
  const json = JSON.parse(response.body);
  assert.deepEqual(json.clientModelConfigs.map(model => model.modelUid), [...catalog.models.map(model => model.uid), 'official-shown']);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0], [
    { uid: 'official-hidden', label: 'Hidden Official', disabled: true, harnessUids: [], isModelRouter: false, sources: ['cli'] },
    { uid: 'official-shown', label: 'Shown Official', disabled: false, harnessUids: [], isModelRouter: false, sources: ['cli'] },
  ]);
  assert.ok(!JSON.stringify(reports).includes('secret.invalid'));
});

test('the first catalog response already combines a newly observed eligible native Sidekick', async t => {
  const observed = [];
  const original = { clientModelConfigs: [
    { modelUid: 'swe-2-medium', label: 'SWE-2 Medium', modelInfo: { harnessUids: ['swe-1p5'], isModelRouter: false } },
    { modelUid: 'swe-locked', label: 'Locked', disabled: true, modelInfo: { harnessUids: ['swe-1p6'], isModelRouter: false } },
    { modelUid: 'fusion-lead-a-sidekick-swe-2-medium', label: 'F', modelInfo: { harnessUids: ['fusion'], isModelRouter: true },
      modelFamilyMetadata: { entries: [{ key: 'Sidekick', value: { order: 1, name: 'SWE-2 Medium' } }] } },
  ] };
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(original));
  });
  t.after(() => native.close());
  const config = { providers: [{ id: 'test', name: 'Test', models: [{ id: 'lead', label: 'Lead' }] }] };
  let observations = 0;
  const bridge = await createLsBridge(native.port, {
    getCatalog: () => buildCatalog(config, observed),
    onNativeModels: entries => { observations++; observed.push(...entries); },
  });
  t.after(() => bridge.close());
  const response = await request(bridge.port, LS + 'GetCliModelConfigs');
  assert.equal(response.status, 200);
  assert.equal(observations, 1, 'one observation callback per catalog response');
  const built = buildCatalog(config, observed);
  const combo = Object.values(built.fusions).find(fusion => fusion.sidekickUid === 'swe-2-medium');
  assert.ok(combo, 'the newly observed native Sidekick is combined');
  assert.deepEqual(combo.sidekickHarnessUids, ['swe-1p5']);
  const uids = JSON.parse(response.body).clientModelConfigs.map(model => model.modelUid);
  assert.ok(uids.includes(combo.uid), 'the same response already carries the new combination');
  assert.equal(uids.filter(uid => uid.startsWith('fusion-dfbyok-')).length, built.matrixUids.size,
    'every mirrored combination is emitted, and the locked native is not');
});

test('the first catalog response binds official Sidekick dimensions and unlocks paired harnesses', async t => {
  const observed = [];
  const original = { clientModelConfigs: [
    { modelUid: 'gpt-5-6-luna-high', label: 'GPT-5.6 Luna High Thinking',
      modelInfo: { harnessUids: ['gpt-5p6'], isModelRouter: false } },
    { modelUid: 'fusion-claude-opus-5-max-sidekick-gpt-5-6-luna-high', label: 'Fusion (Claude Opus 5 Max + GPT-5.6 Luna High)',
      modelInfo: { harnessUids: ['fusion'], isModelRouter: true },
      modelFamilyMetadata: { entries: [{ key: 'Sidekick', value: { order: 4, name: 'GPT-5.6 Luna High', controlType: 3 } }] } },
  ] };
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(original));
  });
  t.after(() => native.close());
  const config = { providers: [{ id: 'test', name: 'Test', models: [{ id: 'lead', label: 'Lead' }] }] };
  const reports = [];
  const bridge = await createLsBridge(native.port, {
    getCatalog: () => buildCatalog(config, observed),
    onNativeModels: entries => { reports.push(entries); observed.push(...entries); },
  });
  t.after(() => bridge.close());
  const response = await request(bridge.port, LS + 'GetCliModelConfigs');
  assert.equal(response.status, 200);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].find(entry => entry.uid.startsWith('fusion-'))?.sidekickDimension, { order: 4, name: 'GPT-5.6 Luna High', fastModeOrder: 0 });
  const expected = buildCatalog(config, observed).fusions;
  const combo = Object.values(expected).find(fusion => fusion.sidekickUid === 'gpt-5-6-luna-high');
  assert.ok(combo, 'the officially paired native is eligible with its declared harness');
  assert.deepEqual(combo.sidekickHarnessUids, ['gpt-5p6']);
  const emitted = JSON.parse(response.body).clientModelConfigs.find(model => model.modelUid === combo.uid);
  assert.ok(emitted, 'the same response already carries the bound combination');
  const dims = Object.fromEntries(emitted.modelFamilyMetadata.entries.map(entry => [entry.key, entry.value]));
  assert.deepEqual(dims.Sidekick, { order: 4, name: 'GPT-5.6 Luna High', controlType: 3 },
    'the emitted entry reuses the official Sidekick dimension');
  assert.match(emitted.label, /^Fusion \(/);
  assert.equal(emitted.modelInfo.modelFamilyUid, 'fusion');
});

const settleWithin = (promise, ms = 2000) => {
  let timer;
  return Promise.race([
    promise.then(value => { clearTimeout(timer); return { value }; }, error => { clearTimeout(timer); return { error }; }),
    new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), ms); }),
  ]);
};

test('forward abandons a connection that never completes the handshake', async t => {
  const events = [];
  const { EventEmitter } = require('node:events');
  const fake = new EventEmitter();
  fake.end = () => {}; fake.write = () => true; fake.destroy = () => fake.emit('close');
  const original = http.request;
  http.request = (target, options, callback) => target instanceof URL ? fake : original(target, options, callback);
  try {
    const bridge = await createLsBridge(9, { getCatalog: () => catalog, log: (event, data) => events.push([event, data]),
      timeouts: { connectMs: 30, firstResponseMs: 5000, idleMs: 5000 } });
    t.after(() => bridge.close());
    const outcome = await settleWithin(request(bridge.port, LS + 'Heartbeat'));
    assert.ok(!outcome.timeout, 'the request must not hang waiting for a stalled connection');
    assert.equal(outcome.value.status, 502);
    assert.deepEqual(events.filter(([event]) => event === 'forward-timeout').map(([, data]) => data.phase), ['connect']);
  } finally { http.request = original; }
});

test('the catalog log reports the mirrored combination count', async t => {
  const events = [];
  const matrixCatalog = buildCatalog({ providers: [{ id: 'p', name: 'P', models: [{ id: 'a' }, { id: 'b' }] }] });
  assert.equal(matrixCatalog.matrixUids.size, 2, 'two models emit the two cross pairs');
  const native = await listen((req, res) => { res.writeHead(200, { 'content-type': 'application/proto' }); res.end(wire.s(7, 'swe-2-medium')); });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => matrixCatalog, log: (event, data) => events.push([event, data]) });
  t.after(() => bridge.close());
  const response = await request(bridge.port, '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings');
  assert.equal(response.status, 200);
  const entry = events.find(([event]) => event === 'catalog');
  assert.ok(entry, 'a catalog RPC emits the catalog log event');
  assert.equal(entry[1].matrix, 2, 'mirrored combinations are counted');
  assert.equal(Object.hasOwn(entry[1], 'presets'), false, 'the retired preset counter is gone from the log');
});

test('the catalog log counts every own marker occurrence in the emitted bytes', async t => {
  const events = [];
  const native = await listen((req, res) => { res.writeHead(200, { 'content-type': 'application/proto' }); res.end(wire.s(7, 'swe-2-medium')); });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog, log: (event, data) => events.push([event, data]) });
  t.after(() => bridge.close());
  const response = await request(bridge.port, LS + 'GetCliModelConfigs');
  assert.equal(response.status, 200);
  const entry = events.find(([event]) => event === 'catalog');
  assert.ok(entry, 'a catalog RPC emits the catalog log event');
  // The byte scan must agree with what the augmented payload actually carries:
  // count the marker in the emitted response bytes and compare directly.
  const marker = Buffer.from('dfbyok-');
  let expected = 0, index = 0;
  while ((index = response.body.indexOf(marker, index)) !== -1) { expected++; index += marker.length; }
  assert.ok(expected > 0, 'the augmented payload must carry own entries');
  assert.equal(entry[1].beforeOwn, 0, 'the upstream payload has no own markers');
  assert.equal(entry[1].afterOwn, expected, 'afterOwn counts exactly the markers in the emitted bytes');
});

test('forward returns 502 when the upstream accepts but never sends headers', async t => {
  const events = [];
  const native = await listen((req, res) => { req.socket.on('close', () => res.destroy()); });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog, log: (event, data) => events.push([event, data]),
    timeouts: { connectMs: 5000, firstResponseMs: 40, idleMs: 5000 } });
  t.after(() => bridge.close());
  const outcome = await settleWithin(request(bridge.port, LS + 'Heartbeat'));
  assert.ok(!outcome.timeout, 'the request must not hang waiting for response headers');
  assert.equal(outcome.value.status, 502);
  assert.deepEqual(events.filter(([event]) => event === 'forward-timeout').map(([, data]) => data.phase), ['headers']);
});

test('forward destroys a stalled body stream after the idle budget without a total deadline', async t => {
  const events = [];
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write('first-chunk');
  });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog, log: (event, data) => events.push([event, data]),
    timeouts: { connectMs: 5000, firstResponseMs: 5000, idleMs: 40 } });
  t.after(() => bridge.close());
  const outcome = await settleWithin(request(bridge.port, LS + 'Heartbeat'));
  assert.ok(!outcome.timeout, 'a stalled body must not hang the request');
  assert.ok(outcome.error, 'the downstream connection is destroyed after the idle budget');
  assert.deepEqual(events.filter(([event]) => event === 'forward-timeout').map(([, data]) => data.phase), ['body']);
});

test('forward-timeout records the rpc name so stalled streams are identifiable', async t => {
  const events = [];
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write('first-chunk');
  });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog, log: (event, data) => events.push([event, data]),
    timeouts: { connectMs: 5000, firstResponseMs: 5000, idleMs: 50 } });
  t.after(() => bridge.close());
  await settleWithin(request(bridge.port, LS + 'GetProcessInfo'));
  const timeout = events.find(([event]) => event === 'forward-timeout');
  assert.equal(timeout[1].phase, 'body');
  assert.equal(timeout[1].rpc, 'GetProcessInfo');
});

test('forward lets a slow but steady stream exceed every total-duration budget', async t => {
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    let count = 0;
    const timer = setInterval(() => {
      res.write('chunk-' + count++);
      if (count === 8) { clearInterval(timer); res.end('-end'); }
    }, 40);
  });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog, log: () => {},
    timeouts: { connectMs: 5000, firstResponseMs: 5000, idleMs: 120 } });
  t.after(() => bridge.close());
  const response = await request(bridge.port, LS + 'Heartbeat');
  assert.equal(response.status, 200);
  assert.equal(response.body.toString(), 'chunk-0chunk-1chunk-2chunk-3chunk-4chunk-5chunk-6chunk-7-end');
});

test('forward clears all timers and destroys upstream when the client cancels mid-body', async t => {
  const events = [];
  let upstreamSawClose = false;
  const native = await listen((req, res) => {
    res.socket.on('close', () => { upstreamSawClose = true; });
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write('start');
    const interval = setInterval(() => res.write('more'), 20);
    res.on('close', () => clearInterval(interval));
  });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog, log: (event, data) => events.push([event, data]),
    timeouts: { connectMs: 5000, firstResponseMs: 5000, idleMs: 60 } });
  t.after(() => bridge.close());
  const client = http.request({ hostname: '127.0.0.1', port: bridge.port, method: 'POST', path: LS + 'Heartbeat' }, response => {
    response.on('data', () => {});
    response.once('data', () => client.destroy());
  });
  client.end();
  for (let i = 0; i < 200 && !upstreamSawClose; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(upstreamSawClose, true, 'the upstream connection is destroyed when the client cancels');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(events.filter(([event]) => event === 'forward-timeout'), [], 'no timer fires after cancellation');
});

test('forward only clears the TLS connect budget on secureConnect, not the TCP connect', async t => {
  const events = [];
  const { EventEmitter } = require('node:events');
  const fakeSocket = new EventEmitter();
  fakeSocket.connecting = true;
  const fakeReq = new EventEmitter();
  fakeReq.end = () => {}; fakeReq.write = () => true; fakeReq.destroy = () => {};
  const original = https.request;
  https.request = (target, options, callback) => {
    process.nextTick(() => { fakeReq.emit('socket', fakeSocket); fakeSocket.emit('connect'); });
    return fakeReq;
  };
  try {
    const downstream = await listen((req, res) => forward(req, res, new URL('https://127.0.0.1:9/x'), {
      getCatalog: () => catalog, log: (event, data) => events.push([event, data]),
      timeouts: { connectMs: 40, firstResponseMs: 5000, idleMs: 5000 } }));
    t.after(() => downstream.close());
    const outcome = await settleWithin(request(downstream.port, '/x'));
    assert.ok(!outcome.timeout);
    assert.equal(outcome.value.status, 502);
    assert.deepEqual(events.filter(([event]) => event === 'forward-timeout').map(([, data]) => data.phase), ['connect'],
      'a bare TCP connect on a TLS socket must not consume the connect budget');
  } finally { https.request = original; }
});

test('the headers budget starts at request creation, not at socket connect', async t => {
  const events = [];
  const { EventEmitter } = require('node:events');
  const fakeSocket = new EventEmitter();
  fakeSocket.connecting = true;
  const fakeReq = new EventEmitter();
  fakeReq.end = () => {}; fakeReq.write = () => true; fakeReq.destroy = () => {};
  const original = http.request;
  http.request = (target, options, callback) => {
    if (!(target instanceof URL)) return original(target, options, callback);
    process.nextTick(() => fakeReq.emit('socket', fakeSocket));
    setTimeout(() => fakeSocket.emit('connect'), 40);
    return fakeReq;
  };
  try {
    const downstream = await listen((req, res) => forward(req, res, new URL('http://127.0.0.1:9/x'), {
      getCatalog: () => catalog, log: (event, data) => events.push([event, data]),
      timeouts: { connectMs: 5000, firstResponseMs: 70, idleMs: 5000 } }));
    t.after(() => downstream.close());
    const started = Date.now();
    const outcome = await settleWithin(request(downstream.port, '/x'));
    assert.ok(!outcome.timeout);
    assert.equal(outcome.value.status, 502);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 105, `headers budget is counted from request start (elapsed ${elapsed}ms), not connect + 70ms`);
    assert.deepEqual(events.filter(([event]) => event === 'forward-timeout').map(([, data]) => data.phase), ['headers']);
  } finally { http.request = original; }
});

test('a socket connect arriving after cancellation cannot resurrect timers', async t => {
  const events = [];
  const { EventEmitter } = require('node:events');
  const fakeSocket = new EventEmitter();
  fakeSocket.connecting = true;
  const fakeReq = new EventEmitter();
  fakeReq.end = () => {}; fakeReq.write = () => true; fakeReq.destroy = () => {};
  const original = http.request;
  http.request = (target, options, callback) => {
    if (!(target instanceof URL)) return original(target, options, callback);
    process.nextTick(() => fakeReq.emit('socket', fakeSocket));
    setTimeout(() => fakeSocket.emit('connect'), 120);
    return fakeReq;
  };
  try {
    const downstream = await listen((req, res) => forward(req, res, new URL('http://127.0.0.1:9/x'), {
      getCatalog: () => catalog, log: (event, data) => events.push([event, data]),
      timeouts: { connectMs: 5000, firstResponseMs: 60, idleMs: 60 } }));
    t.after(() => downstream.close());
    const client = http.request({ hostname: '127.0.0.1', port: downstream.port, method: 'POST', path: '/x' });
    client.on('error', () => {});
    client.end();
    setTimeout(() => client.destroy(), 40);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(events.filter(([event]) => event === 'forward-timeout'), [],
      'a late socket connect after the downstream cancel must not arm any timer');
  } finally { http.request = original; }
});

test('a stalled buffered catalog response also hits the body idle budget', async t => {
  const events = [];
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"partial":');
  });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog, log: (event, data) => events.push([event, data]),
    timeouts: { connectMs: 5000, firstResponseMs: 5000, idleMs: 40 } });
  t.after(() => bridge.close());
  const outcome = await settleWithin(request(bridge.port, LS + 'GetCliModelConfigs'));
  assert.ok(!outcome.timeout);
  assert.equal(outcome.value.status, 502, 'the buffered branch replies 502 because headers were never sent');
  assert.deepEqual(events.filter(([event]) => event === 'forward-timeout').map(([, data]) => data.phase), ['body']);
});

test('an established but unsecured TLS socket keeps waiting for secureConnect', async t => {
  const events = [];
  const { EventEmitter } = require('node:events');
  const fakeSocket = new EventEmitter();
  fakeSocket.connecting = false;
  fakeSocket.authorized = false;
  fakeSocket.encrypted = true;
  const fakeReq = new EventEmitter();
  fakeReq.end = () => {}; fakeReq.write = () => true; fakeReq.destroy = () => {};
  const original = https.request;
  https.request = (target, options, callback) => {
    process.nextTick(() => fakeReq.emit('socket', fakeSocket));
    return fakeReq;
  };
  try {
    const downstream = await listen((req, res) => forward(req, res, new URL('https://127.0.0.1:9/x'), {
      getCatalog: () => catalog, log: (event, data) => events.push([event, data]),
      timeouts: { connectMs: 40, firstResponseMs: 5000, idleMs: 5000 } }));
    t.after(() => downstream.close());
    const outcome = await settleWithin(request(downstream.port, '/x'));
    assert.ok(!outcome.timeout);
    assert.equal(outcome.value.status, 502);
    assert.deepEqual(events.filter(([event]) => event === 'forward-timeout').map(([, data]) => data.phase), ['connect'],
      'connecting===false alone must not prove a TLS channel is secured');
  } finally { https.request = original; }
});

test('late socket response and data events after cancellation resurrect nothing', async t => {
  const events = [];
  const { EventEmitter } = require('node:events');
  let responseCb;
  const fakeSocket = new EventEmitter();
  fakeSocket.connecting = false;
  const fakeReq = new EventEmitter();
  fakeReq.end = () => {}; fakeReq.write = () => true; fakeReq.destroy = () => {};
  const fakeRes = new EventEmitter();
  let resDestroyed = 0;
  fakeRes.destroy = () => { resDestroyed++; };
  const original = http.request;
  http.request = (target, options, callback) => {
    if (!(target instanceof URL)) return original(target, options, callback);
    responseCb = callback;
    process.nextTick(() => fakeReq.emit('socket', fakeSocket));
    return fakeReq;
  };
  try {
    const downstream = await listen((req, res) => forward(req, res, new URL('http://127.0.0.1:9/x'), {
      getCatalog: () => catalog, log: (event, data) => events.push([event, data]),
      timeouts: { connectMs: 5000, firstResponseMs: 60, idleMs: 60 } }));
    t.after(() => downstream.close());
    const client = http.request({ hostname: '127.0.0.1', port: downstream.port, method: 'POST', path: '/x' });
    client.on('error', () => {});
    client.end();
    setTimeout(() => client.destroy(), 40);
    await new Promise(resolve => setTimeout(resolve, 80));
    const lateSocket = new EventEmitter();
    lateSocket.connecting = true;
    fakeReq.emit('socket', lateSocket);
    assert.equal(lateSocket.listenerCount('connect'), 0, 'a socket arriving after stop is never armed');
    responseCb(fakeRes);
    assert.equal(resDestroyed, 1, 'an upstream response arriving after cancellation is destroyed');
    fakeRes.emit('data', Buffer.from('late'));
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(events.filter(([event]) => event === 'forward-timeout'), [],
      'late events after the downstream cancel cannot arm any timer');
  } finally { http.request = original; }
});

test('a genuinely reused socket still clears the connect budget immediately', async t => {
  const events = [];
  const { EventEmitter } = require('node:events');
  const fakeSocket = new EventEmitter();
  fakeSocket.connecting = false;
  fakeSocket.authorized = true;
  const fakeReq = new EventEmitter();
  fakeReq.end = () => {}; fakeReq.write = () => true; fakeReq.destroy = () => {};
  fakeReq.reusedSocket = true;
  const original = https.request;
  https.request = (target, options, callback) => {
    process.nextTick(() => fakeReq.emit('socket', fakeSocket));
    return fakeReq;
  };
  try {
    const downstream = await listen((req, res) => forward(req, res, new URL('https://127.0.0.1:9/x'), {
      getCatalog: () => catalog, log: (event, data) => events.push([event, data]),
      timeouts: { connectMs: 40, firstResponseMs: 60, idleMs: 5000 } }));
    t.after(() => downstream.close());
    const outcome = await settleWithin(request(downstream.port, '/x'));
    assert.ok(!outcome.timeout);
    assert.equal(outcome.value.status, 502);
    assert.deepEqual(events.filter(([event]) => event === 'forward-timeout').map(([, data]) => data.phase), ['headers'],
      'an authorized reused TLS socket skips the connect budget and times out on headers instead');
  } finally { https.request = original; }
});

test('a streaming RPC idles past the regular body budget and still completes', async t => {
  const events = [];
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write('first-chunk');
    setTimeout(() => res.end('last-chunk'), 200);
  });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog, log: (event, data) => events.push([event, data]),
    timeouts: { connectMs: 5000, firstResponseMs: 5000, idleMs: 40, streamingIdleMs: 5000 } });
  t.after(() => bridge.close());
  const outcome = await settleWithin(request(bridge.port, '/exa.x_pb.XService/StreamCascadePanelReactiveUpdates'));
  assert.ok(!outcome.timeout, 'a server-push stream must not be killed by the ordinary idle budget');
  assert.equal(outcome.value.status, 200);
  assert.equal(outcome.value.body.toString(), 'first-chunklast-chunk', 'the response completes intact after the idle gap');
  assert.deepEqual(events.filter(([event]) => event === 'forward-timeout'), []);
});

test('a streaming RPC without an explicit streaming idle carries no body idle limit at all', async t => {
  const events = [];
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write('first-chunk');
    setTimeout(() => res.end('last-chunk'), 200);
  });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog, log: (event, data) => events.push([event, data]),
    timeouts: { connectMs: 5000, firstResponseMs: 5000, idleMs: 40 } });
  t.after(() => bridge.close());
  const outcome = await settleWithin(request(bridge.port, '/exa.x_pb.XService/StreamCascadePanelReactiveUpdates'));
  assert.ok(!outcome.timeout, 'a server-push stream must not be killed by the ordinary idle budget');
  assert.equal(outcome.value.status, 200);
  assert.equal(outcome.value.body.toString(), 'first-chunklast-chunk', 'the response completes intact after the idle gap');
  assert.deepEqual(events.filter(([event]) => event === 'forward-timeout'), []);
});

test('an explicit streamingIdleMs still bounds a silent stream', async t => {
  const events = [];
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write('first-chunk');
  });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog, log: (event, data) => events.push([event, data]),
    timeouts: { connectMs: 5000, firstResponseMs: 5000, idleMs: 40, streamingIdleMs: 40 } });
  t.after(() => bridge.close());
  const outcome = await settleWithin(request(bridge.port, '/exa.x_pb.XService/StreamCascadePanelReactiveUpdates'));
  assert.ok(!outcome.timeout, 'a stalled stream must not hang the request');
  assert.ok(outcome.error, 'the downstream connection is destroyed after the idle budget');
  assert.deepEqual(events.filter(([event]) => event === 'forward-timeout').map(([, data]) => data.phase), ['body']);
});

test('the same idle gap still times out on a non-streaming path', async t => {
  const events = [];
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write('first-chunk');
    setTimeout(() => res.end('last-chunk'), 200);
  });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog, log: (event, data) => events.push([event, data]),
    timeouts: { connectMs: 5000, firstResponseMs: 5000, idleMs: 40, streamingIdleMs: 5000 } });
  t.after(() => bridge.close());
  const outcome = await settleWithin(request(bridge.port, LS + 'Heartbeat'));
  assert.ok(!outcome.timeout);
  assert.ok(outcome.error, 'the downstream connection is destroyed after the idle budget');
  assert.deepEqual(events.filter(([event]) => event === 'forward-timeout').map(([, data]) => data.phase), ['body']);
});

test('team-settings observations notify once per request and null exactly once per failure', async t => {
  const seat = '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings';
  const other = LS + 'GetProcessInfo';
  let respond = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"allowedModelUids":[]}'); };
  const native = await listen((req, res) => respond(req, res));
  t.after(() => native.close());
  const observations = [];
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog,
    onAllowedUids: observation => observations.push(observation),
    timeouts: { connectMs: 2000, firstResponseMs: 60, idleMs: 2000 } });
  t.after(() => bridge.close());
  const json = (status, body) => (req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); };
  const nulls = () => observations.filter(o => o === null).length;
  const settledNulls = async (expected, message) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && nulls() !== expected) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(nulls(), expected, message);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(nulls(), expected, message + ' — exactly once, no error/close re-entry');
  };
  respond = json(200, '{"allowedModelUids":[]}');
  await request(bridge.port, seat);
  await request(bridge.port, seat);
  assert.deepEqual(observations, [{ kind: 'unrestricted' }, { kind: 'unrestricted' }]);
  respond = json(200, '{"anything":1}');
  await request(bridge.port, other);
  assert.equal(observations.length, 2, 'an unrelated RPC reports nothing');
  respond = json(200, '{"allowedModelUids":"oops"}');
  await request(bridge.port, seat);
  await settledNulls(1, 'a legal non-array allowlist notifies null once');
  respond = json(200, '{not-json');
  await request(bridge.port, seat);
  await settledNulls(2, 'undecodable JSON notifies null once');
  respond = json(500, '{}');
  await request(bridge.port, seat);
  await settledNulls(3, 'a non-200 upstream notifies null once');
  respond = (req, res) => { req.socket.destroy(); };
  await request(bridge.port, seat).catch(() => {});
  await settledNulls(4, 'a dropped upstream connection notifies null once');
  respond = (req, res) => {};
  await request(bridge.port, seat).catch(() => {});
  await settledNulls(5, 'a header timeout notifies null once');
  let upstreamSawClose;
  const entered = new Promise(resolve => {
    respond = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"allowedModelUids":[');
      upstreamSawClose = new Promise(done => res.on('close', done));
      resolve();
    };
  });
  const client = http.request({ hostname: '127.0.0.1', port: bridge.port, method: 'POST', path: seat });
  client.on('error', () => {});
  client.end('{}');
  await entered;
  client.destroy();
  const cancelDeadline = Date.now() + 3000;
  while (Date.now() < cancelDeadline && nulls() !== 6) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(nulls(), 6, 'a client cancelling mid-body notifies null exactly once');
  assert.ok(await Promise.race([upstreamSawClose.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 3000))]),
    'the abandoned upstream request is torn down');
  respond = json(200, '{"allowedModelUids":["swe-2-medium"]}');
  await request(bridge.port, seat);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(observations.at(-1)?.kind, 'restricted');
  assert.equal(observations.length, 9, 'a finished response never reports a trailing null');
});

const { Writable } = require('node:stream');
const { EventEmitter: DownReq } = require('node:events');
async function until(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (!fn()) { if (Date.now() > deadline) throw new Error('condition not met: ' + label); await new Promise(r => setImmediate(r)); }
}
class StalledWritable extends Writable {
  constructor() { super({ highWaterMark: 1 }); this.headersSent = false; this.held = []; this.calls = 0; }
  writeHead(status) { this.headersSent = true; this.headStatus = status; }
  _write(chunk, enc, cb) { this.calls++; this.held.push(cb); }
}
const rpcGetProcessInfo = '/exa.language_server_pb.LanguageServerService/GetProcessInfo';

test('a blocked downstream pauses upstream but the drain watchdog still bounds the wait', async t => {
  let upstreamClose = 0;
  const native = await listen((req, res) => {
    res.socket.on('close', () => upstreamClose++);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write(Buffer.alloc(64 * 1024));
  });
  t.after(() => native.close());
  const logs = [];
  const req = new DownReq();
  req.method = 'POST'; req.headers = {};
  const res = new StalledWritable();
  t.after(() => { if (!res.destroyed) res.destroy(); });
  forward(req, res, new URL('http://127.0.0.1:' + native.port + '/x'), {
    body: Buffer.from('req'), rpc: rpcGetProcessInfo,
    timeouts: { idleMs: 40, drainMs: 90 },
    log: (event, data) => logs.push({ event, data }),
  });
  await until(() => res.writableNeedDrain, 3000, 'backpressure established');
  await until(() => upstreamClose >= 1, 3000, 'drain watchdog kills the upstream socket');
  const drains = logs.filter(l => l.event === 'forward-timeout' && l.data?.phase === 'drain');
  assert.equal(drains.length, 1, 'exactly one drain timeout is logged');
  assert.equal(drains[0].data.rpc, 'GetProcessInfo');
  assert.equal(res.destroyed, true, 'headers-sent downstream is destroyed by fail()');
});

test('body idle does not fire while blocked, and re-arms after the drain', async t => {
  let upstreamClose = 0;
  const native = await listen((req, res) => {
    res.socket.on('close', () => upstreamClose++);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write(Buffer.alloc(64 * 1024));
  });
  t.after(() => native.close());
  const logs = [];
  const req = new DownReq();
  req.method = 'POST'; req.headers = {};
  const res = new StalledWritable();
  t.after(() => { if (!res.destroyed) res.destroy(); });
  forward(req, res, new URL('http://127.0.0.1:' + native.port + '/x'), {
    body: Buffer.from('req'), rpc: rpcGetProcessInfo,
    timeouts: { idleMs: 60, drainMs: 5000 },
    log: (event, data) => logs.push({ event, data }),
  });
  await until(() => res.writableNeedDrain && res.held.length >= 1, 3000, 'first write stalled');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(logs.filter(l => l.event === 'forward-timeout').length, 0, 'blocked time is not upstream idle');
  res.held.shift()();
  res._write = (chunk, enc, cb) => cb();
  await until(() => upstreamClose >= 1, 3000, 'body idle fires once flowing again');
  const timeouts = logs.filter(l => l.event === 'forward-timeout');
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].data.phase, 'body', 'the post-drain stall is a body idle timeout');
});

test('upstream EOF while a write is in flight cannot cancel the drain watchdog', async t => {
  let upstreamClose = 0;
  const seen = { order: [], closeComplete: null };
  const realRequest = http.request;
  http.request = function (...args) {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') args[args.length - 1] = upstream => {
      upstream.on('pause', () => { seen.order.push('pause'); });
      upstream.on('end', () => { seen.order.push('end'); });
      upstream.on('close', () => { seen.order.push('close'); seen.closeComplete = upstream.complete; });
      return cb(upstream);
    };
    return realRequest.apply(this, args);
  };
  t.after(() => { http.request = realRequest; });
  const native = await listen((req, res) => {
    res.socket.on('close', () => upstreamClose++);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.alloc(4096));
  });
  t.after(() => native.close());
  const logs = [];
  const req = new DownReq();
  req.method = 'POST'; req.headers = {};
  const res = new StalledWritable();
  t.after(() => { if (!res.destroyed) res.destroy(); });
  forward(req, res, new URL('http://127.0.0.1:' + native.port + '/x'), {
    body: Buffer.from('req'), rpc: rpcGetProcessInfo,
    timeouts: { idleMs: 40, drainMs: 80 },
    log: (event, data) => logs.push({ event, data }),
  });
  await until(() => seen.order.includes('pause') && seen.order.includes('end'), 3000, 'upstream paused, then ended while the tail write is in flight');
  assert.ok(seen.order.indexOf('pause') < seen.order.indexOf('end'), 'pause precedes upstream end: ' + seen.order.join(','));
  assert.equal(res.writableEnded, true, 'pipe ended the response');
  assert.equal(res.writableFinished, false, 'the buffered tail is still waiting');
  assert.equal(res.destroyed, false);
  await until(() => res.destroyed, 3000, 'watchdog still fires after upstream EOF');
  const drains = logs.filter(l => l.event === 'forward-timeout' && l.data?.phase === 'drain');
  assert.equal(drains.length, 1);
  assert.equal(seen.closeComplete, true, 'the client-side upstream close carried complete=true');
});

test('a repeated pause does not extend the first blocked wait', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let upstreamClose = 0, upstreamRef = null;
  const realRequest = http.request;
  http.request = function (...args) {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') args[args.length - 1] = upstream => { upstreamRef = upstream; return cb(upstream); };
    return realRequest.apply(this, args);
  };
  t.after(() => { http.request = realRequest; });
  const native = await listen((req, res) => {
    res.socket.on('close', () => upstreamClose++);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write(Buffer.alloc(64 * 1024));
  });
  t.after(() => native.close());
  const logs = [];
  const req = new DownReq();
  req.method = 'POST'; req.headers = {};
  const res = new StalledWritable();
  t.after(() => { if (!res.destroyed) res.destroy(); });
  forward(req, res, new URL('http://127.0.0.1:' + native.port + '/x'), {
    body: Buffer.from('req'), rpc: rpcGetProcessInfo,
    timeouts: { idleMs: 5000, drainMs: 150 },
    log: (event, data) => logs.push({ event, data }),
  });
  await until(() => res.writableNeedDrain && upstreamRef, 3000, 'backpressure established');
  t.mock.timers.tick(80);
  upstreamRef.emit('pause');
  upstreamRef.emit('pause');
  t.mock.timers.tick(70);
  await until(() => upstreamClose >= 1, 3000, 'single watchdog expiry');
  const drains = logs.filter(l => l.event === 'forward-timeout' && l.data?.phase === 'drain');
  assert.equal(drains.length, 1, 'expired on the original deadline — a reset would still be waiting at 230ms');
  assert.equal(res.destroyed, true);
});

test('two real backpressure windows each get their own bounded wait', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let upstreamClose = 0;
  const native = await listen((req, res) => {
    res.socket.on('close', () => upstreamClose++);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write(Buffer.alloc(256 * 1024));
  });
  t.after(() => native.close());
  const logs = [];
  const req = new DownReq();
  req.method = 'POST'; req.headers = {};
  const res = new StalledWritable();
  t.after(() => { if (!res.destroyed) res.destroy(); });
  forward(req, res, new URL('http://127.0.0.1:' + native.port + '/x'), {
    body: Buffer.from('req'), rpc: rpcGetProcessInfo,
    timeouts: { idleMs: 5000, drainMs: 150 },
    log: (event, data) => logs.push({ event, data }),
  });
  await until(() => res.writableNeedDrain && res.calls >= 1, 3000, 'first block');
  t.mock.timers.tick(80);
  assert.equal(logs.filter(l => l.event === 'forward-timeout').length, 0, 'first block still inside its budget');
  res.held.shift()();
  await until(() => res.calls >= 2 && res.writableNeedDrain, 3000, 'second block begins');
  t.mock.timers.tick(70);
  assert.equal(logs.filter(l => l.event === 'forward-timeout' && l.data?.phase === 'drain').length, 0, 'a shared stale timer would have fired by now');
  t.mock.timers.tick(80);
  await until(() => upstreamClose >= 1, 3000, 'the second blocked wait expires on its own budget');
  assert.equal(logs.filter(l => l.event === 'forward-timeout' && l.data?.phase === 'drain').length, 1);
});

test('request abort, downstream error and a late drain all settle without a drain timeout', async t => {
  for (const mode of ['aborted', 'error', 'late-drain']) {
    let upstreamClose = 0;
    const native = await listen((req, res) => {
      res.socket.on('close', () => upstreamClose++);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(Buffer.alloc(64 * 1024));
    });
    t.after(() => native.close());
    const logs = [];
    const req = new DownReq();
    req.method = 'POST'; req.headers = {};
    const res = new StalledWritable();
    forward(req, res, new URL('http://127.0.0.1:' + native.port + '/x'), {
      body: Buffer.from('req'), rpc: rpcGetProcessInfo,
      timeouts: { idleMs: 40, drainMs: 60 },
      log: (event, data) => logs.push({ event, data }),
    });
    await until(() => res.writableNeedDrain, 3000, mode + ': backpressure established');
    if (mode === 'aborted') req.emit('aborted');
    else if (mode === 'error') { res.destroy(new Error('downstream broke')); }
    else { res.destroy(); res.emit('drain'); }
    await until(() => upstreamClose >= 1, 3000, mode + ': upstream closed');
    await new Promise(r => setTimeout(r, 120));
    assert.equal(logs.filter(l => l.event === 'forward-timeout').length, 0, mode + ': nothing fires after settle');
    assert.equal(res.listenerCount('drain'), 0, mode + ': drain listener removed');
  }
});

test('a parallel normal request is unaffected by a blocked sibling', async t => {
  const closes = { stall: 0, fine: 0 };
  const native = await listen((req, res) => {
    res.socket.on('close', () => closes[req.url === '/stall' ? 'stall' : 'fine']++);
    if (req.url === '/stall') { res.writeHead(200); res.write(Buffer.alloc(64 * 1024)); return; }
    res.writeHead(200); res.end('ok');
  });
  t.after(() => native.close());
  const logs = [];
  const reqA = new DownReq(); reqA.method = 'POST'; reqA.headers = {};
  const resA = new StalledWritable();
  t.after(() => { if (!resA.destroyed) resA.destroy(); });
  forward(reqA, resA, new URL('http://127.0.0.1:' + native.port + '/stall'), {
    body: Buffer.from('a'), rpc: rpcGetProcessInfo, timeouts: { idleMs: 40, drainMs: 80 },
    log: (event, data) => logs.push({ event, data }) });
  const reqB = new DownReq(); reqB.method = 'POST'; reqB.headers = {};
  const resB = new class extends Writable {
    constructor() { super({ highWaterMark: 1 }); this.headersSent = false; this.out = []; }
    writeHead(status) { this.headersSent = true; this.headStatus = status; }
    _write(chunk, enc, cb) { this.out.push(chunk); cb(); }
  }();
  t.after(() => { if (!resB.destroyed) resB.destroy(); });
  forward(reqB, resB, new URL('http://127.0.0.1:' + native.port + '/fine'), {
    body: Buffer.from('b'), rpc: rpcGetProcessInfo, timeouts: { idleMs: 40, drainMs: 80 },
    log: (event, data) => logs.push({ event, data }) });
  await until(() => Buffer.concat(resB.out).toString() === 'ok', 3000, 'normal request completes');
  assert.equal(resB.headStatus, 200);
  assert.equal(resB.writableFinished, true, 'the normal response finished cleanly');
  await until(() => closes.stall >= 1, 3000, 'blocked sibling bounded by its watchdog');
  assert.equal(logs.filter(l => l.event === 'forward-timeout' && l.data?.phase === 'drain').length, 1);
});

test('streaming RPC forwards get the same drain bound', async t => {
  let upstreamClose = 0;
  const native = await listen((req, res) => {
    res.socket.on('close', () => upstreamClose++);
    res.writeHead(200, { 'content-type': 'application/connect+proto' });
    res.write(Buffer.alloc(64 * 1024));
  });
  t.after(() => native.close());
  const logs = [];
  const req = new DownReq();
  req.method = 'POST'; req.headers = {};
  const res = new StalledWritable();
  t.after(() => { if (!res.destroyed) res.destroy(); });
  forward(req, res, new URL('http://127.0.0.1:' + native.port + '/x'), {
    body: Buffer.from('req'), rpc: '/exa.language_server_pb.LanguageServerService/StreamCascadeUpdates',
    timeouts: { idleMs: 40, streamingIdleMs: 5000, drainMs: 80 },
    log: (event, data) => logs.push({ event, data }),
  });
  await until(() => res.writableNeedDrain, 3000, 'backpressure established');
  await until(() => upstreamClose >= 1, 3000, 'drain watchdog bounds streaming forwards too');
  const drains = logs.filter(l => l.event === 'forward-timeout' && l.data?.phase === 'drain');
  assert.equal(drains.length, 1);
  assert.equal(drains[0].data.rpc, 'StreamCascadeUpdates');
});

test('a finishing downstream releases drain and finish listeners without needing close', async t => {
  let upstreamClose = 0;
  const native = await listen((req, res) => {
    res.socket.on('close', () => upstreamClose++);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end('done-body');
  });
  t.after(() => native.close());
  const logs = [];
  const req = new DownReq();
  req.method = 'POST'; req.headers = {};
  const res = new class extends Writable {
    constructor() { super({ highWaterMark: 1, autoDestroy: false }); this.headersSent = false; this.out = []; }
    writeHead(status) { this.headersSent = true; this.headStatus = status; }
    _write(chunk, enc, cb) { this.out.push(chunk); cb(); }
  }();
  t.after(() => { if (!res.destroyed) res.destroy(); });
  forward(req, res, new URL('http://127.0.0.1:' + native.port + '/x'), {
    body: Buffer.from('req'), rpc: rpcGetProcessInfo,
    timeouts: { idleMs: 40, drainMs: 60 },
    log: (event, data) => logs.push({ event, data }),
  });
  await until(() => res.writableFinished, 3000, 'response finished');
  assert.equal(Buffer.concat(res.out).toString(), 'done-body');
  await new Promise(r => setTimeout(r, 120));
  assert.equal(logs.filter(l => l.event === 'forward-timeout').length, 0, 'nothing fires after finish');
  assert.equal(res.listenerCount('drain'), 0, 'drain listener removed on finish');
  assert.equal(res.listenerCount('finish'), 0, 'finish listener removed on finish');
});

test('a buffered catalog rewrite waits for the downstream finish within the drain bound', async t => {
  let hits = 0;
  const native = await listen((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ clientModelConfigs: [{ modelUid: 'official', label: 'Official' }] }));
  });
  t.after(() => native.close());
  const logs = [];
  const req = new DownReq(); req.method = 'POST'; req.headers = {};
  const res = new StalledWritable();
  t.after(() => { if (!res.destroyed) res.destroy(); });
  forward(req, res, new URL('http://127.0.0.1:' + native.port + '/x'), {
    body: Buffer.from('{}'), rpc: LS + 'GetCliModelConfigs',
    getCatalog: () => catalog,
    timeouts: { idleMs: 40, drainMs: 80 },
    log: (event, data) => logs.push({ event, data }),
  });
  await until(() => res.writableEnded && res.calls >= 1, 3000, 'catalog rewrite issued its final write');
  assert.equal(res.writableFinished, false, 'the rewritten payload is stalled in the downstream buffer');
  await until(() => res.destroyed, 3000, 'the finish wait expires on the drain bound');
  const drains = logs.filter(l => l.event === 'forward-timeout' && l.data?.phase === 'drain');
  assert.equal(drains.length, 1);
  assert.equal(drains[0].data.rpc, 'GetCliModelConfigs');
  assert.equal(hits, 1, 'one upstream request, no retry');
});

test('a hung _final also hits the drain bound while a normal catalog write completes', async t => {
  let hits = 0;
  const native = await listen((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ clientModelConfigs: [{ modelUid: 'official', label: 'Official' }] }));
  });
  t.after(() => native.close());
  const logs = [];
  const reqA = new DownReq(); reqA.method = 'POST'; reqA.headers = {};
  const resA = new class extends Writable {
    constructor() { super({ highWaterMark: 1 }); this.headersSent = false; this.out = []; }
    writeHead(status) { this.headersSent = true; }
    _write(chunk, enc, cb) { this.out.push(chunk); cb(); }
    _final(cb) {}
  }();
  t.after(() => { if (!resA.destroyed) resA.destroy(); });
  forward(reqA, resA, new URL('http://127.0.0.1:' + native.port + '/a'), {
    body: Buffer.from('{}'), rpc: LS + 'GetCliModelConfigs', getCatalog: () => catalog,
    timeouts: { idleMs: 40, drainMs: 80 },
    log: (event, data) => logs.push({ event, data }) });
  const reqB = new DownReq(); reqB.method = 'POST'; reqB.headers = {};
  const resB = new class extends Writable {
    constructor() { super({ highWaterMark: 1 }); this.headersSent = false; this.out = []; }
    writeHead(status) { this.headersSent = true; }
    _write(chunk, enc, cb) { this.out.push(chunk); cb(); }
  }();
  t.after(() => { if (!resB.destroyed) resB.destroy(); });
  forward(reqB, resB, new URL('http://127.0.0.1:' + native.port + '/b'), {
    body: Buffer.from('{}'), rpc: LS + 'GetCliModelConfigs', getCatalog: () => catalog,
    timeouts: { idleMs: 40, drainMs: 80 },
    log: (event, data) => logs.push({ event, data }) });
  await until(() => resB.writableFinished, 3000, 'normal catalog write finishes');
  await until(() => resA.writableEnded && resA.out.length >= 1, 3000, 'the stalled final write flushed its bytes');
  assert.deepEqual(Buffer.concat(resA.out), Buffer.concat(resB.out),
    'the stall sits in finish, not in truncated output');
  const decoded = JSON.parse(Buffer.concat(resB.out).toString());
  const uids = decoded.clientModelConfigs.map(entry => entry.modelUid);
  for (const model of catalog.models) assert.ok(uids.includes(model.uid), 'rewritten catalog carries ' + model.uid);
  assert.ok(uids.includes('official'), 'native entries survive the rewrite');
  await until(() => resA.destroyed, 3000, 'hung _final is bounded by the drain wait');
  assert.equal(logs.filter(l => l.event === 'forward-timeout' && l.data?.phase === 'drain').length, 1);
  assert.equal(hits, 2);
});

test('a late drain cannot extend the finish wait, and early settle cleans it up', async t => {
  let hits = 0;
  const native = await listen((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ clientModelConfigs: [{ modelUid: 'official', label: 'Official' }] }));
  });
  t.after(() => native.close());
  const logs = [];
  const reqA = new DownReq(); reqA.method = 'POST'; reqA.headers = {};
  const resA = new StalledWritable();
  t.after(() => { if (!resA.destroyed) resA.destroy(); });
  forward(reqA, resA, new URL('http://127.0.0.1:' + native.port + '/a'), {
    body: Buffer.from('{}'), rpc: LS + 'GetCliModelConfigs', getCatalog: () => catalog,
    timeouts: { idleMs: 40, drainMs: 80 },
    log: (event, data) => logs.push({ event, data }) });
  await until(() => resA.writableEnded && resA.calls >= 1, 3000, 'final write stalled');
  resA.emit('drain');
  resA.emit('drain');
  await until(() => resA.destroyed, 3000, 'injected drain events must not defer the finish bound');
  assert.equal(logs.filter(l => l.event === 'forward-timeout' && l.data?.phase === 'drain').length, 1);
  for (const [label, settle] of [
    ['aborted', req => req.emit('aborted')],
    ['error', (req, res) => res.destroy(new Error('downstream broke'))],
    ['close', (req, res) => res.destroy()],
  ]) {
    const reqB = new DownReq(); reqB.method = 'POST'; reqB.headers = {};
    const resB = new StalledWritable();
    t.after(() => { if (!resB.destroyed) resB.destroy(); });
    const logsB = [];
    forward(reqB, resB, new URL('http://127.0.0.1:' + native.port + '/b'), {
      body: Buffer.from('{}'), rpc: LS + 'GetCliModelConfigs', getCatalog: () => catalog,
      timeouts: { idleMs: 40, drainMs: 60 },
      log: (event, data) => logsB.push({ event, data }) });
    await until(() => resB.writableEnded && resB.calls >= 1, 3000, label + ': final write stalled');
    settle(reqB, resB);
    await new Promise(r => setTimeout(r, 120));
    assert.equal(logsB.filter(l => l.event === 'forward-timeout').length, 0, label + ': settles before the drain bound');
    assert.equal(resB.listenerCount('drain'), 0, label + ': drain listener removed');
    assert.equal(resB.listenerCount('finish'), 0, label + ': finish listener removed');
  }
});

test('an aborted request during catalog transform cannot resurrect the finish wait', async t => {
  let hits = 0;
  const native = await listen((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ clientModelConfigs: [{ modelUid: 'official', label: 'Official' }] }));
  });
  t.after(() => native.close());
  const logs = [];
  const req = new DownReq(); req.method = 'POST'; req.headers = {};
  const res = new StalledWritable();
  t.after(() => { if (!res.destroyed) res.destroy(); });
  let transformCalls = 0;
  forward(req, res, new URL('http://127.0.0.1:' + native.port + '/x'), {
    body: Buffer.from('{}'), rpc: LS + 'GetCliModelConfigs',
    getCatalog: () => { transformCalls++; req.emit('aborted'); return catalog; },
    timeouts: { idleMs: 40, drainMs: 60 },
    log: (event, data) => logs.push({ event, data }),
  });
  await until(() => transformCalls === 1 && res.writableEnded, 3000, 'the transform ran and the abort settled');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(transformCalls, 1, 'the catalog transform is actually invoked by this fixture');
  assert.equal(logs.filter(l => l.event === 'forward-timeout').length, 0, 'no timer resurrects after the abort');
  assert.equal(res.listenerCount('drain'), 0, 'drain listener removed by the abort');
  assert.equal(res.listenerCount('finish'), 0, 'finish listener removed by the abort');
  assert.equal(hits, 1);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { startBackend, controlFile, runtimeIdentity } = require('../src/runtime/backend.cjs');
const { readNativeModels } = require('../src/runtime/native-models.cjs');
const { collect } = require('../src/runtime/bridge.cjs');
const { createManager } = require('../src/panel/model.cjs');
const { buildCatalog, buildRoleLists } = require('../src/catalog.cjs');
const API = '/exa.api_server_pb.ApiServerService/';

const fixtureJson = JSON.parse(fs.readFileSync(__dirname + '/fixtures/real-picker-0.3.11.json', 'utf8'));
const upstream = { clientModelConfigs: [
  ...fixtureJson.natives.map(record => ({ modelUid: record.uid, label: record.label, disabled: !!record.disabled,
    modelInfo: { harnessUids: record.harnesses || [], isModelRouter: !!record.router },
    ...(record.family?.length ? { modelFamilyMetadata: { entries: record.family.map(dim => ({ key: dim.key, value: { order: dim.order, name: dim.name } })) } } : {}) })),
  ...fixtureJson.fusions.map(record => ({ modelUid: record.uid, label: record.label, disabled: !!record.disabled,
    modelInfo: { harnessUids: ['fusion'], isModelRouter: true },
    modelFamilyMetadata: { entries: (record.family || []).map(dim => ({ key: dim.key, value: { order: dim.order, name: dim.name } })) } })),
] };

async function backendFixture(t, { natives = upstream, hold = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-sync-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    providers: [{ id: 'load', name: 'load', baseUrl: 'https://load.invalid/v1', apiKey: 'fixture-secret', apiFormat: 'openai',
      models: [{ id: 'gpt-6-astra', label: 'gpt-6-astra' }] }] }));
  const forwarded = [], held = new Map();
  let payload = natives;
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
          forwarded.push({ target: target.href, url: req.url });
          if (/ModelConfigs|GetUserStatus/.test(req.url)) {
            options.onNativeModels?.(require('../src/catalog.cjs').collectNativeModels(payload, { rpc: 'GetCliModelConfigs', format: { json: true } }));
          }
          if (hold) held.set(req.url, res);
          else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('official'); }
        },
      };
      return realRequire(name);
    },
  }, { filename });
  const backend = await module.exports.startBackend({ root, port: 0, log: () => {} });
  const base = 'http://127.0.0.1:' + backend.port;
  t.after(async () => { for (const res of held.values()) res.end(); await backend.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, backend, base, forwarded, setPayload: value => { payload = value; } };
}

test('readNativeModels returns the backend observed catalog with dimensions intact', async t => {
  const f = await backendFixture(t);
  await fetch(f.base + API + 'GetCliModelConfigs', { method: 'POST', body: 'trigger' });
  const result = await readNativeModels({ root: f.root, port: f.backend.port });
  assert.equal(result.status, 'ready');
  const luna = result.models.find(entry => entry.uid === 'gpt-5-6-luna-high');
  assert.deepEqual(luna?.sidekickDimension, undefined, 'plain natives carry no dimension');
  const official = result.models.find(entry => entry.uid === 'fusion-claude-fable-5-1-medium-sidekick-gpt-5-6-luna-high');
  assert.deepEqual(official.sidekickDimension, { order: 4, name: 'GPT-5.6 Luna High', fastModeOrder: 0 });
  assert.ok(result.models.length >= 19, 'all sanitized upstream records are exposed');
  assert.equal(result.models.some(entry => entry.uid === 'dfbyok-provider-3490cae1-c564-42ae-afe9-cfba2b5-gpt-6-astra-801ca1a9934850b2'), false,
    'own models are excluded from native observations');
});

test('the endpoint rejects wrong and missing bearer tokens and browser origins', async t => {
  const f = await backendFixture(t);
  for (const headers of [{}, { authorization: 'Bearer deadbeef' }, { authorization: 'bearer ' + '0'.repeat(64) }]) {
    const response = await fetch(f.base + '/_runtime/native-models', { headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
  }
  const control = JSON.parse(fs.readFileSync(controlFile(f.root), 'utf8'));
  const origin = await fetch(f.base + '/_runtime/native-models', { headers: { authorization: 'Bearer ' + control.token, origin: 'https://evil.invalid' } });
  assert.equal(origin.status, 403, 'Origin-bearing requests are rejected before auth');
  const healthOrigin = await fetch(f.base + '/health', { headers: { origin: 'http://localhost' } });
  assert.equal(healthOrigin.status, 403);
  const ok = await fetch(f.base + '/_runtime/native-models', { headers: { authorization: 'Bearer ' + control.token } });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.instanceId, control.instanceId);
  assert.equal(body.token, undefined, 'the token never appears in responses');
});

test('readNativeModels fails closed on foreign roots, stale receipts and unsupported backends', async t => {
  const f = await backendFixture(t);
  await assert.rejects(readNativeModels({ root: f.root + '-other', port: f.backend.port }), /native_catalog_identity/,
    'a different root id is not this backend');
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-foreign-'));
  fs.writeFileSync(path.join(foreign, 'config.json'), '{}');
  const foreignBackend = await startBackend({ root: foreign, port: 0, log: () => {} });
  t.after(async () => { await foreignBackend.close(); fs.rmSync(foreign, { recursive: true, force: true }); });
  await assert.rejects(readNativeModels({ root: f.root, port: foreignBackend.port }), /native_catalog_identity/,
    'the control file must match the live instance identity');
  const control = JSON.parse(fs.readFileSync(controlFile(f.root), 'utf8'));
  fs.writeFileSync(controlFile(f.root), JSON.stringify({ ...control, token: '0'.repeat(64) }));
  await assert.rejects(readNativeModels({ root: f.root, port: f.backend.port }), /native_catalog_unavailable/,
    'a stale receipt token is rejected by the live backend');
  await f.backend.close();
  const restarted = await startBackend({ root: f.root, port: f.backend.port, log: () => {} });
  t.after(() => restarted.close());
  const fresh = JSON.parse(fs.readFileSync(controlFile(f.root), 'utf8'));
  assert.notEqual(fresh.instanceId, control.instanceId);
  assert.notEqual(fresh.token, control.token);
  const after = await readNativeModels({ root: f.root, port: f.backend.port });
  assert.equal(after.status, 'empty', 'a restarted backend reports only its own observations');
  const legacy = await (async () => {
    const server = require('node:http').createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...runtimeIdentity(f.root), instanceId: 'legacy', managementProtocol: 1, activeRequests: 0, draining: false })); return; }
      res.writeHead(404); res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server;
  })();
  t.after(() => legacy.close());
  const unsupported = await readNativeModels({ root: f.root, port: legacy.address().port });
  assert.equal(unsupported.status, 'unsupported', 'an older backend without the capability reports unsupported');
});

test('createManager.ready hydrates panel state from a synced backend with zero LS observations', async t => {
  const f = await backendFixture(t);
  await fetch(f.base + API + 'GetUserStatus', { method: 'POST', body: 'trigger' });
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8'));
  let status = 'loading';
  const backendModels = [];
  const manager = createManager({
    read: () => JSON.parse(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8')),
    write: next => fs.writeFileSync(path.join(f.root, 'config.json'), JSON.stringify(next)),
    nativeModels: () => backendModels,
    nativeCatalogStatus: () => status,
    refreshNativeModels: async () => {
      const result = await readNativeModels({ root: f.root, port: f.backend.port });
      status = result.status;
      backendModels.length = 0;
      backendModels.push(...result.models);
    },
  });
  const state = await manager.dispatch('ready');
  assert.equal(state.nativeCatalogStatus, 'ready');
  const expected = { 'swe-2-medium': true, 'swe-2-high': true,
    'gpt-5-6-luna-high': true, 'gpt-5-6-sol-high': true, 'glm-5-2': true };
  for (const [uid] of Object.entries(expected)) {
    const row = state.nativeModels.find(entry => entry.uid === uid);
    assert.ok(row, uid + ' must appear in the panel official list');
    assert.equal(row.eligible, true, uid + ' must be eligible via backend observations');
  }
  assert.equal(state.nativeModels.find(entry => entry.uid === 'swe-2-max')?.eligible, true);
  assert.equal(state.nativeModels.find(entry => entry.uid === 'gpt-5-6-luna-high-priority')?.eligible, true);
  const built = buildCatalog(saved, backendModels);
  const luna = Object.values(built.fusions).find(fusion => fusion.sidekickUid === 'gpt-5-6-luna-high');
  assert.ok(luna, 'the synced native Sidekick is mirrored once its harness is known');
  assert.deepEqual(luna.sidekickHarnessUids, ['gpt-5p6'], 'the mirrored combination uses the synced native harness');
  assert.ok(state.fusionCount > 0, 'the mirrored combinations are reported to the panel');
  const lead = built.rolePool.lead.find(item => item.ref.providerId);
  const created = await manager.dispatch('setRoleModel', { role: 'lead', enabled: true, model: lead.ref });
  assert.ok(created.roleLists.lead.some(item => item.ref.providerId === lead.ref.providerId && item.selected));
  const fresh = buildCatalog(JSON.parse(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8')), backendModels);
  assert.deepEqual(Object.values(fresh.fusions).find(fusion => fusion.sidekickUid === 'gpt-5-6-luna-high').sidekickHarnessUids, ['gpt-5p6']);
  assert.ok(!JSON.stringify(state).includes('fixture-secret'), 'no credentials leak into public state');
  const roleLists = buildRoleLists(saved, backendModels);
  assert.ok(roleLists.lead.some(r => (r.memberUids || [r.ref.nativeUid]).includes('claude-fable-5-1-medium')), 'Claude Lead is present from backend observations');
  const nativeCreated = await manager.dispatch('setRoleModel', { role: 'lead', enabled: true, model: { nativeUid: 'claude-fable-5-1-medium' } });
  assert.ok(Object.values(buildCatalog(JSON.parse(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8')), backendModels).fusions)
    .some(fusion => fusion.leadUid === 'claude-fable-5-1-medium'), 'the native Lead is mirrored too');
  // Native Leads are grouped into effort families, so the uid shows up as a member.
  assert.ok(nativeCreated.roleLists.lead.some(item =>
    (item.memberUids || [item.ref.nativeUid]).includes('claude-fable-5-1-medium') && item.selected));
});

test('backend observations remain scoped to the live instance', async t => {
  const f = await backendFixture(t);
  await fetch(f.base + API + 'GetCliModelConfigs', { method: 'POST', body: 'trigger' });
  const first = await readNativeModels({ root: f.root, port: f.backend.port });
  assert.equal(first.status, 'ready');
  f.setPayload([]);
  const control = JSON.parse(fs.readFileSync(controlFile(f.root), 'utf8'));
  const raw = await fetch(f.base + '/_runtime/native-models', { headers: { authorization: 'Bearer ' + control.token } });
  const body = await raw.json();
  assert.ok(body.models.length > 0, 'backend records persist per instance until replaced by fresh observations');
});

test('readNativeModels retries once on connection-level failures', async t => {
  const f = await backendFixture(t);
  let calls = 0;
  const request = (url, options) => {
    calls += 1;
    if (calls === 1) { const error = new TypeError('fetch failed'); error.cause = { code: 'ECONNRESET' }; return Promise.reject(error); }
    return fetch(url, options);
  };
  const result = await readNativeModels({ root: f.root, port: f.backend.port, request });
  assert.equal(result.status, 'empty');
  assert.equal(calls, 3, 'the first attempt dies on /health; the retry issues /health and /_runtime/native-models');
});

test('readNativeModels never retries identity rejections', async t => {
  const f = await backendFixture(t);
  let calls = 0;
  const request = (url, options) => { calls += 1; return fetch(url, options); };
  await assert.rejects(readNativeModels({ root: f.root + '-other', port: f.backend.port, request }), /native_catalog_identity/);
  assert.equal(calls, 1, 'identity failures are not connection failures and must not be retried');
});

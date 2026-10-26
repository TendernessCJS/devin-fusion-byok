'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { startBackend, controlFile, runtimeIdentity } = require('../src/runtime/backend.cjs');
const { readNativeModels } = require('../src/runtime/host/native-models.cjs');
const { collect } = require('../src/runtime/bridge.cjs');
const { createManager } = require('../src/panel/manager.cjs');
const { buildCatalog, buildRoleLists, collectAllowedUids } = require('../src/catalog.cjs');
const { loadNativeCache } = require('../src/runtime/native-cache.cjs');
const { s, v } = require('../src/protocol/wire.cjs');
const API = '/exa.api_server_pb.ApiServerService/';

const fixtureJson = JSON.parse(fs.readFileSync(__dirname + '/fixtures/real-picker.json', 'utf8'));
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
  const members = (state.nativeFamilies || []).flatMap(family => family.members);
  const member = uid => members.find(entry => entry.uid === uid);
  const expected = { 'swe-2-medium': true, 'swe-2-high': true,
    'gpt-5-6-luna-high': true, 'gpt-5-6-sol-high': true, 'glm-5-2': true };
  for (const [uid] of Object.entries(expected)) {
    const row = member(uid);
    assert.ok(row, uid + ' must appear in the panel official list');
    assert.equal(row.eligible, true, uid + ' must be eligible via backend observations');
  }
  assert.equal(member('swe-2-max')?.eligible, true);
  assert.equal(member('gpt-5-6-luna-high-priority')?.eligible, true);
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

// A minimal stand-in backend: the real backend only ever serves normalized
// entries, so proving the reader keeps failing closed on malformed payloads
// needs a server that can emit them.
async function fakeCatalogBackend(t, { models, allowedUids }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-fake-'));
  const identity = runtimeIdentity(root);
  const instanceId = 'fake-instance';
  const token = 'f'.repeat(64);
  fs.writeFileSync(controlFile(root), JSON.stringify({ rootId: identity.rootId, instanceId, sourceId: identity.sourceId, token }));
  let payload = { instanceId, models, ...(allowedUids ? { allowedUids } : {}) };
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...identity, instanceId, nativeModelsProtocol: 1 }));
      return;
    }
    if (req.url === '/_runtime/native-models' && req.headers.authorization === 'Bearer ' + token) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(403); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, port: server.address().port, setPayload: next => { payload = { instanceId, ...next }; } };
}

test('readNativeModels returns canonical observation fields through the shared normalizer', async t => {
  const backend = await fakeCatalogBackend(t, { models: [
    { uid: 'swe-full', label: 'SWE Full', disabled: false, isModelRouter: false, harnessUids: ['h1'],
      familyUid: 'fam-full', kind: 3, listed: true, pickerListed: false, sources: ['cli'],
      maxTokens: 200000, maxOutputTokens: 4096, supportsImages: true,
      sidekickDimension: { order: 2, name: 'S', fastModeOrder: 1 },
      fusionMetadata: [{ key: 'Sidekick', order: 2, name: 'S' }] },
  ], allowedUids: ['swe-full', 'dfbyok-own', 'swe-full'] });
  const result = await readNativeModels({ root: backend.root, port: backend.port });
  assert.equal(result.status, 'ready');
  const [record] = result.models;
  assert.equal(record.familyUid, 'fam-full');
  assert.equal(record.kind, 3);
  assert.equal(record.listed, true);
  assert.equal(record.pickerListed, false, 'a false verdict survives the endpoint round trip');
  assert.deepEqual(record.sources, ['cli']);
  assert.deepEqual(record.sidekickDimension, { order: 2, name: 'S', fastModeOrder: 1 });
  assert.deepEqual(record.fusionMetadata, [{ key: 'Sidekick', order: 2, name: 'S', controlType: 0 }]);
  assert.equal(record.maxTokens, 200000);
  assert.equal(record.maxOutputTokens, 4096);
  assert.equal(record.supportsImages, true);
  assert.deepEqual(result.allowedUids, ['swe-full'], 'the allowlist is deduped, sorted and stripped of own uids');
});

test('readNativeModels still fails closed on malformed catalog entries', async t => {
  const f = await fakeCatalogBackend(t, { models: [] });
  const valid = { uid: 'swe-ok', disabled: false, isModelRouter: false, harnessUids: ['h'] };
  for (const models of [
    [{ ...valid, disabled: 'yes' }],
    [{ ...valid, isModelRouter: 'no' }],
    [{ ...valid, harnessUids: 'h' }],
    [{ ...valid, harnessUids: [7] }],
    [{ uid: 'dfbyok-leftover', disabled: false, isModelRouter: false, harnessUids: [] }],
    [{ uid: 'x'.repeat(300), disabled: false, isModelRouter: false, harnessUids: [] }],
    [{ ...valid, fusionMetadata: 'nope' }],
    [{ ...valid, fusionMetadata: [{ key: 'Sidekick', order: 1 }] }],
    [{ ...valid, fusionMetadata: [{ key: 'A', order: 1, name: 'a' }, { key: 'A', order: 2, name: 'b' }] }],
    [valid, { uid: 'bad', disabled: 'maybe', isModelRouter: false, harnessUids: [] }],
  ]) {
    f.setPayload({ models });
    await assert.rejects(readNativeModels({ root: f.root, port: f.port }), /native_catalog_invalid/,
      'a malformed entry must reject the whole read, not be skipped');
  }
  f.setPayload({ models: [valid] });
  const ok = await readNativeModels({ root: f.root, port: f.port });
  assert.equal(ok.status, 'ready', 'a structurally valid entry still reads back');
});

// Minimal installCatalogSync harness: only ../runtime/host/native-models.cjs is
// stubbed, so the push/read paths never reach a real backend.
function syncFixture({ read = async () => ({ status: 'ready', models: [] }) } = {}) {
  const logs = [], pushes = [];
  const filename = path.resolve(__dirname, '../src/activation/catalog-sync.cjs');
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    require(name) {
      if (name === '../runtime/host/native-models.cjs') return {
        isUpstreamUid: realRequire('../runtime/host/native-models.cjs').isUpstreamUid,
        readNativeModels: read,
        pushNativeModels: options => { pushes.push(options); return Promise.resolve({ pushed: 0, reason: 'unavailable' }); },
      };
      if (name.startsWith('.') || name.startsWith('node:')) return realRequire(name);
      assert.fail('unexpected require ' + name);
    },
  }, { filename });
  const lifecycle = { activationDisposed: false, activationGeneration: 0 };
  const shared = {
    nativeModels: new Map(), nativeAllowedUids: new Set(),
    nativeRevision: 0, lastPushedRevision: 0, lastPushAt: 0, nativeSyncSize: -1,
    nativeAuthoritative: false,
  };
  let changes = 0;
  module.exports.installCatalogSync({ deps: { lifecycle, config: () => ({}), log: (event, data) => logs.push({ event, data }), root: '/nonexistent',
    stores: { nativeCatalog: shared } },
    shared, onChange: () => { changes += 1; } });
  return { shared, logs, pushes, changes: () => changes };
}

const OBSERVED_ENTRY = { uid: 'swe-2-high', label: 'P', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] };

test('the observation channel reports the synced catalog size too', () => {
  const f = syncFixture();
  f.shared.observeNativeModels([OBSERVED_ENTRY]);
  const entry = f.logs.find(line => line.event === 'native-sync');
  assert.ok(entry, 'observeNativeModels must log native-sync just like refresh does');
  assert.equal(entry.data.count, 1);
  assert.equal(f.changes(), 1, 'the observation channel commits through onChange exactly once');
});

test('local observations survive a backend-empty refresh in the published view', async () => {
  const f = syncFixture();
  f.shared.observeNativeModels([OBSERVED_ENTRY]);
  await f.shared.refreshNativeModels();
  assert.ok(f.shared.nativeModels.has('swe-2-high'),
    'the retained observation pool must repopulate the rebuilt view');
});

test('a failed read keeps the published catalog instead of wiping it', async () => {
  const BACKEND_ENTRY = { uid: 'gpt-5-6-luna-high', label: 'L', disabled: false, isModelRouter: false, harnessUids: ['gpt-5p6'] };
  let result = { status: 'ready', models: [BACKEND_ENTRY] };
  const f = syncFixture({ read: async () => result });
  await f.shared.refreshNativeModels();
  assert.ok(f.shared.nativeModels.has('gpt-5-6-luna-high'));
  const revision = f.shared.nativeRevision;
  result = { status: 'unavailable', models: [] };
  await f.shared.refreshNativeModels();
  assert.ok(f.shared.nativeModels.has('gpt-5-6-luna-high'),
    'an unavailable read must not wipe backend-sourced entries');
  assert.equal(f.shared.nativeCatalogStatus, 'unavailable');
  assert.equal(f.shared.nativeRevision, revision,
    'retaining the view must not advance the revision');
  assert.ok(f.logs.some(line => line.event === 'native-refresh-retained'),
    'the guard must be observable in logs');
  assert.equal(f.changes(), 2, 'each refresh commits through onChange exactly once, including the retained path');
});

test('an authoritative empty answer still clears backend-sourced entries', async () => {
  const BACKEND_ENTRY = { uid: 'gpt-5-6-luna-high', label: 'L', disabled: false, isModelRouter: false, harnessUids: ['gpt-5p6'] };
  let result = { status: 'ready', models: [BACKEND_ENTRY] };
  const f = syncFixture({ read: async () => result });
  await f.shared.refreshNativeModels();
  assert.ok(f.shared.nativeModels.has('gpt-5-6-luna-high'));
  result = { status: 'empty', models: [] };
  await f.shared.refreshNativeModels();
  assert.equal(f.shared.nativeModels.has('gpt-5-6-luna-high'), false,
    'an authoritative empty answer is stale-entry cleanup and must still clear');
  assert.equal(f.shared.nativeCatalogStatus, 'empty');
});

test('readNativeModels passes a valid family uid through and ignores malformed ones', async t => {
  const f = await backendFixture(t, { natives: { clientModelConfigs: [
    { modelUid: 'glm-5-2', label: 'GLM', disabled: false, modelInfo: { harnessUids: ['h'], isModelRouter: false, modelFamilyUid: 'glm-5.2' } },
    { modelUid: 'glm-5-2-1m', label: 'GLM 1M', disabled: false, modelInfo: { harnessUids: ['h'], isModelRouter: false, modelFamilyUid: 'x'.repeat(200) } },
    { modelUid: 'swe-x', label: 'SWE', disabled: false, modelInfo: { harnessUids: ['h'], isModelRouter: false, modelFamilyUid: 42 } },
  ] } });
  await fetch(f.base + API + 'GetCliModelConfigs', { method: 'POST', body: 'trigger' });
  const result = await readNativeModels({ root: f.root, port: f.backend.port });
  assert.equal(result.status, 'ready');
  assert.equal(result.models.find(e => e.uid === 'glm-5-2')?.familyUid, 'glm-5.2');
  assert.equal(result.models.find(e => e.uid === 'glm-5-2-1m')?.familyUid, undefined,
    'overlong family ids are dropped, not thrown');
  assert.equal(result.models.find(e => e.uid === 'swe-x')?.familyUid, undefined,
    'non-string family ids are dropped, not thrown');
});

test('a stale backend allowlist echo cannot overwrite the host set', async () => {
  const f = syncFixture({ read: async () => ({ status: 'ready', models: [], allowedUids: ['A1'] }) });
  // This scenario presupposes an already-authoritative catalog: the echo
  // semantics being tested are independent of the first-authority bump.
  f.shared.nativeAuthoritative = true;
  f.shared.observeAllowedUids({ kind: 'restricted', uids: ['A1', 'A2'] });
  const revision = f.shared.nativeRevision;
  await f.shared.refreshNativeModels();
  assert.deepEqual([...f.shared.nativeAllowedUids].sort(), ['A1', 'A2'],
    'an older backend echo must not roll back the host-observed allowlist');
  assert.equal(f.shared.nativeRevision, revision, 'an advisory echo must not advance the revision');
});

test('the first backend allowlist echo is adopted once, then the host stays authoritative', async () => {
  let result = { status: 'ready', models: [], allowedUids: ['A1'] };
  const f = syncFixture({ read: async () => result });
  await f.shared.refreshNativeModels();
  assert.deepEqual([...f.shared.nativeAllowedUids], ['A1'], 'cold start adopts the backend verdict once');
  result = { status: 'ready', models: [], allowedUids: ['A2'] };
  await f.shared.refreshNativeModels();
  assert.deepEqual([...f.shared.nativeAllowedUids], ['A1'], 'a later divergent echo does not replace the adopted set');
  assert.ok(f.logs.some(line => line.event === 'native-allowed-diverged'),
    'the divergence must be observable in logs');
});

test('a host-observed uid wins label and disabled over a stale backend copy', async () => {
  const f = syncFixture({ read: async () => ({ status: 'ready', models: [
    { uid: 'swe-2-high', label: 'Stale', disabled: true, isModelRouter: false, harnessUids: ['swe-1p6'], familyUid: 'fam' }] }) });
  f.shared.observeNativeModels([{ uid: 'swe-2-high', label: 'Host', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] }]);
  await f.shared.refreshNativeModels();
  const entry = f.shared.nativeModels.get('swe-2-high');
  assert.equal(entry.label, 'Host', 'the host observation wins scalar fields');
  assert.equal(entry.disabled, false, 'a stale disabled flag must not downgrade the host copy');
  assert.equal(entry.familyUid, 'fam', 'fields the host never saw are still carried from the backend copy');
});

test('backend-only entries are still adopted into the published view', async () => {
  const f = syncFixture({ read: async () => ({ status: 'ready', models: [
    { uid: 'swe-2-max', label: 'B', disabled: false, isModelRouter: false, harnessUids: ['h'] }] }) });
  f.shared.observeNativeModels([OBSERVED_ENTRY]);
  await f.shared.refreshNativeModels();
  assert.ok(f.shared.nativeModels.has('swe-2-max'), 'a uid the host never observed still comes in from the backend');
  assert.ok(f.shared.nativeModels.has('swe-2-high'));
});

test('a backend that lost the allowlist is force-pushed the host set', async () => {
  const f = syncFixture({ read: async () => ({ status: 'ready', models: [], allowedUids: [] }) });
  f.shared.observeNativeModels([OBSERVED_ENTRY]);
  f.shared.observeAllowedUids({ kind: 'restricted', uids: ['A1', 'A2'] });
  await new Promise(resolve => setTimeout(resolve, 30));
  const before = f.pushes.length;
  f.shared.lastPushedRevision = f.shared.nativeRevision;
  f.shared.lastPushAt = 0;
  await f.shared.refreshNativeModels();
  assert.equal(f.shared.nativePushStale, true, 'an empty echo against a host-observed set arms the forced repush');
  assert.ok(f.logs.some(line => line.event === 'native-allowed-backend-lost'));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(f.pushes.length > before, 'the forced push must fire even when the revision gate has nothing new');
  assert.deepEqual([...f.pushes.at(-1).allowedUids].sort(), ['A1', 'A2'],
    'the repush carries the host allowlist, not the backend echo');
});

test('three consecutive unrestricted observations flip the mode and push it', async () => {
  const f = syncFixture();
  f.shared.observeNativeModels([OBSERVED_ENTRY]);
  f.shared.observeAllowedUids({ kind: 'restricted', uids: ['A1', 'A2'] });
  for (let i = 0; i < 3; i++) f.shared.observeAllowedUids({ kind: 'unrestricted' });
  assert.equal(f.shared.nativeAllowedMode, 'unrestricted');
  assert.equal(f.shared.nativeAllowedUids.size, 0, 'flipping clears the restricted set');
  assert.equal(f.logs.filter(line => line.event === 'native-allowed-cleared').length, 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.pushes.at(-1).allowedMode, 'unrestricted', 'the push carries the lifted restriction');
});

test('two consecutive unrestricted observations do not flip', () => {
  const f = syncFixture();
  f.shared.observeAllowedUids({ kind: 'restricted', uids: ['A1'] });
  f.shared.observeAllowedUids({ kind: 'unrestricted' });
  f.shared.observeAllowedUids({ kind: 'unrestricted' });
  assert.equal(f.shared.nativeAllowedMode, 'restricted');
  assert.ok(f.shared.nativeAllowedUids.has('A1'), 'the weak empty signal stays debounced');
});

test('an unrestricted backend echo against an unrestricted host is agreement, not loss', async () => {
  const f = syncFixture({ read: async () => ({ status: 'ready', models: [], allowedUids: [], allowedMode: 'unrestricted' }) });
  f.shared.observeAllowedUids({ kind: 'restricted', uids: ['A1'] });
  for (let i = 0; i < 3; i++) f.shared.observeAllowedUids({ kind: 'unrestricted' });
  await f.shared.refreshNativeModels();
  assert.equal(f.logs.some(line => line.event === 'native-allowed-backend-lost'), false,
    'an empty echo consistent with the host mode must not arm the repush');
  assert.equal(f.shared.nativeAllowedMode, 'unrestricted');
});

test('a single restricted observation restores restricted mode without debounce', async () => {
  const f = syncFixture();
  f.shared.observeNativeModels([OBSERVED_ENTRY]);
  f.shared.observeAllowedUids({ kind: 'restricted', uids: ['A1'] });
  for (let i = 0; i < 3; i++) f.shared.observeAllowedUids({ kind: 'unrestricted' });
  assert.equal(f.shared.nativeAllowedMode, 'unrestricted');
  f.shared.observeAllowedUids({ kind: 'restricted', uids: ['B1'] });
  assert.equal(f.shared.nativeAllowedMode, 'restricted', 'the first restricted verdict restores immediately');
  assert.deepEqual([...f.shared.nativeAllowedUids], ['B1']);
  await new Promise(resolve => setTimeout(resolve, 30));
  const push = f.pushes.at(-1);
  assert.equal(push.allowedMode, 'restricted');
  assert.deepEqual(JSON.parse(JSON.stringify(push.allowedUids)), ['B1']);
});

test('a host that never observed a restricted verdict ignores unrestricted streaks', () => {
  const f = syncFixture();
  for (let i = 0; i < 3; i++) f.shared.observeAllowedUids({ kind: 'unrestricted' });
  assert.equal(f.shared.nativeAllowedMode, 'restricted',
    'without a prior restricted observation the weak signal never flips');
  assert.equal(f.logs.some(line => line.event === 'native-allowed-cleared'), false);
});

test('the control endpoint validates the mode before mutating state', async t => {
  const f = await backendFixture(t);
  const control = JSON.parse(fs.readFileSync(controlFile(f.root), 'utf8'));
  const auth = { authorization: 'Bearer ' + control.token };
  const entry = { uid: 'swe-2-high', label: 'P', disabled: false, isModelRouter: false, harnessUids: ['h'] };
  const post = payload => fetch(f.base + '/_runtime/native-models', { method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const get = async () => (await fetch(f.base + '/_runtime/native-models', { headers: auth })).json();
  let response = await post({ models: [entry], allowedMode: 'unrestricted', allowedUids: ['sneaky'] });
  assert.equal(response.status, 400, 'unrestricted plus a uid list is an inconsistent payload');
  let body = await get();
  assert.equal(body.allowedMode, 'restricted', 'the rejected payload never reached the allowlist');
  response = await post({ models: [entry], allowedMode: 'bogus' });
  assert.equal(response.status, 400);
  response = await post({ models: [entry], allowedMode: 'unrestricted' });
  assert.equal(response.status, 200);
  body = await get();
  assert.equal(body.allowedMode, 'unrestricted');
  assert.deepEqual(body.allowedUids, []);
});

test('a legacy cache without allowedMode stays restricted and legacy posts still work', async t => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-cache-')), 'native-cache.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), models: [], allowedUids: ['a1', 'a2'] }));
  const seeded = loadNativeCache(file);
  assert.equal(seeded.allowedMode, 'restricted', 'a missing key can never lift a restriction');
  assert.deepEqual(seeded.allowedUids, ['a1', 'a2']);
  const f = await backendFixture(t);
  const control = JSON.parse(fs.readFileSync(controlFile(f.root), 'utf8'));
  const entry = { uid: 'swe-2-high', label: 'P', disabled: false, isModelRouter: false, harnessUids: ['h'] };
  const response = await fetch(f.base + '/_runtime/native-models', { method: 'POST',
    headers: { authorization: 'Bearer ' + control.token, 'content-type': 'application/json' },
    body: JSON.stringify({ models: [entry], allowedUids: ['swe-2-high'] }) });
  assert.equal(response.status, 200, 'an old client without a mode field posts restricted as before');
  const body = await (await fetch(f.base + '/_runtime/native-models', { headers: { authorization: 'Bearer ' + control.token } })).json();
  assert.equal(body.allowedMode, 'restricted');
  assert.deepEqual(body.allowedUids, ['swe-2-high']);
});

test('collectAllowedUids reports a three-state verdict', () => {
  const seat = '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings';
  const proto = {};
  assert.deepEqual(collectAllowedUids(s(1, 'other'), { rpc: seat, format: proto }), { kind: 'unrestricted' },
    'a parsed payload without field 7 is confirmed unrestricted');
  assert.equal(collectAllowedUids(Buffer.concat([s(7, 'a'), v(7, 1)]), { rpc: seat, format: proto }), null,
    'a non-length-delimited field 7 is malformed');
  assert.equal(collectAllowedUids(s(7, 'a'), { rpc: 'GetCliModelConfigs', format: proto }), null, 'other RPCs report nothing');
  assert.equal(collectAllowedUids('not-a-buffer', { rpc: seat, format: proto }), null);
  const json = { json: true };
  assert.deepEqual(collectAllowedUids({}, { rpc: seat, format: json }), { kind: 'unrestricted' });
  assert.deepEqual(collectAllowedUids({ allowedModelUids: [] }, { rpc: seat, format: json }), { kind: 'unrestricted' });
  assert.equal(collectAllowedUids({ allowedModelUids: ['ok', 1] }, { rpc: seat, format: json }), null,
    'illegal elements still read as a malformed shape');
  assert.deepEqual(collectAllowedUids({ allowedModelUids: ['a', 'b'] }, { rpc: seat, format: json }),
    { kind: 'restricted', uids: ['a', 'b'] });
});

test('a same-value host observation still establishes source authority', async () => {
  const HOST = { uid: 'swe-2-high', label: 'Host', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] };
  let result = { status: 'ready', models: [{ ...HOST }] };
  const f = syncFixture({ read: async () => result });
  await f.shared.refreshNativeModels();
  const revision = f.shared.nativeRevision;
  f.shared.observeNativeModels([{ ...HOST }]);
  assert.equal(f.shared.nativeRevision, revision, 'an unchanged observation must not bump the revision');
  result = { status: 'ready', models: [
    { uid: 'swe-2-high', label: 'Stale', disabled: true, isModelRouter: false, harnessUids: ['swe-1p6'], familyUid: 'fam' }] };
  await f.shared.refreshNativeModels();
  const entry = f.shared.nativeModels.get('swe-2-high');
  assert.equal(entry.label, 'Host', 'the host observation is authoritative even when it matched the backend copy');
  assert.equal(entry.disabled, false);
  assert.equal(entry.familyUid, 'fam');
});

// Real backend + real forward, with only the upstream URL swapped to a local
// server: exercises the raw CLI allowlist channel end to end, including the
// debounce and failure-reset semantics the mock-forward fixture cannot reach.
async function rawForwardFixture(t, respond) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-raw-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ providers: [] }));
  const filename = path.resolve(__dirname, '../src/runtime/backend.cjs');
  const realRequire = createRequire(filename);
  const realBridge = realRequire('./bridge.cjs');
  const module = { exports: {} };
  const upstream = http.createServer(async (req, res) => {
    req.resume();
    try { await respond(req, res); } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename),
    process, Buffer, URL, AbortController, setTimeout, clearTimeout,
    require(name) {
      if (name === './bridge.cjs') return {
        collect: realBridge.collect,
        forward: (request, response, target, options) =>
          realBridge.forward(request, response, new URL(request.url, 'http://127.0.0.1:' + upstream.address().port), options),
      };
      return realRequire(name);
    },
  }, { filename });
  const backend = await module.exports.startBackend({ root, port: 0, log: () => {} });
  t.after(async () => {
    await backend.close();
    await new Promise(resolve => upstream.close(resolve));
    upstream.closeAllConnections();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + backend.port;
  const auth = () => ({ authorization: 'Bearer ' + JSON.parse(fs.readFileSync(controlFile(root), 'utf8')).token });
  const get = async () => (await fetch(base + '/_runtime/native-models', { headers: auth() })).json();
  // Responses are always fully consumed so later requests never race a
  // half-read body; callers get the status code and nothing dangles.
  const post = async payload => { const r = await fetch(base + '/_runtime/native-models', { method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify(payload) }); await r.arrayBuffer(); return r.status; };
  const cli = async () => { const r = await fetch(base + '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings',
    { method: 'POST', body: '{}' }); await r.arrayBuffer(); return r.status; };
  const other = async () => { const r = await fetch(base + '/exa.language_server_pb.LanguageServerService/GetUserStatus',
    { method: 'POST', body: '{}' }); await r.arrayBuffer(); return r.status; };
  return { get, post, cli, other };
}

test('the raw CLI channel needs three consecutive empty verdicts to lift a restriction', async t => {
  let statusCode = 200, payload = { allowedModelUids: [] };
  const f = await rawForwardFixture(t, (req, res) => {
    res.writeHead(statusCode, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  const entry = { uid: 'swe-2-high', label: 'P', disabled: false, isModelRouter: false, harnessUids: ['h'] };
  assert.equal(await f.post({ models: [entry], allowedUids: ['A1'] }), 200);
  assert.equal((await f.get()).allowedMode, 'restricted');
  await f.cli();
  assert.equal((await f.get()).allowedMode, 'restricted', 'one empty verdict is a weak signal');
  await f.cli();
  await f.other();
  assert.equal((await f.get()).allowedMode, 'restricted', 'an unrelated RPC must not interrupt the streak');
  await f.cli();
  let body = await f.get();
  assert.equal(body.allowedMode, 'unrestricted', 'two empties plus an unrelated RPC then a third still flip');
  assert.deepEqual(body.allowedUids, []);
  payload = { allowedModelUids: ['B1'] };
  await f.cli();
  body = await f.get();
  assert.equal(body.allowedMode, 'restricted', 'a raw restricted verdict applies immediately');
  assert.deepEqual(body.allowedUids, ['B1']);
  payload = { allowedModelUids: [] };
  await f.cli();
  await f.cli();
  statusCode = 500; await f.cli(); statusCode = 200;
  await f.cli();
  assert.equal((await f.get()).allowedMode, 'restricted', 'empty, empty, failed, empty is not three consecutive');
  await f.cli();
  await f.cli();
  assert.equal((await f.get()).allowedMode, 'unrestricted', 'three clean empties after the failure flip again');
  payload = { allowedModelUids: ['C1'] };
  await f.cli();
  payload = { allowedModelUids: [] };
  await f.cli();
  await f.cli();
  assert.equal(await f.post({ models: [entry], allowedUids: ['C1'] }), 200);
  await f.cli();
  assert.equal((await f.get()).allowedMode, 'restricted',
    'a confirmed host submission resets the raw streak even when nothing changed');
  assert.equal(await f.post({ models: [entry], allowedMode: 'unrestricted' }), 200);
  assert.equal((await f.get()).allowedMode, 'unrestricted', 'a confirmed unrestricted applies without the streak');
});

test('a status flip into authority bumps the revision even with identical models', async () => {
  let result = { status: 'ready', models: [OBSERVED_ENTRY] };
  const f = syncFixture({ read: async () => result });
  await f.shared.refreshNativeModels();
  const baseline = f.shared.nativeRevision;
  result = { status: 'unavailable', models: [] };
  await f.shared.refreshNativeModels();
  const retained = f.shared.nativeRevision;
  assert.equal(f.shared.nativeCatalogStatus, 'unavailable');
  // The retained branch keeps the model set — an identical-content flip back
  // to authoritative must still republish once.
  const before = f.shared.nativeModels.size;
  result = { status: 'ready', models: [OBSERVED_ENTRY] };
  await f.shared.refreshNativeModels();
  assert.equal(f.shared.nativeModels.size, before, 'the model content is unchanged');
  assert.ok(f.shared.nativeRevision > retained, 'the authority flip alone advances the revision');
});

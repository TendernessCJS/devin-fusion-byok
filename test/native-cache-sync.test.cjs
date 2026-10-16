'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { collect } = require('../src/runtime/bridge.cjs');
const { augmentCatalog, buildCatalog, collectNativeModels } = require('../src/catalog.cjs');
const { parseFields, s, m, v } = require('../src/protocol/wire.cjs');
const cat = (...parts) => Buffer.concat(parts.flat());

const TEAM_RPC = '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings';
const proto = { json: false, type: 'application/proto', framed: false };
const SEEDED = [{ uid: 'swe-2-medium', label: 'SWE-2 Medium', disabled: false, isModelRouter: false, harnessUids: ['swe-2'] }];
// The sidekick is selected through an explicit role inclusion, which is the
// shape the retired preset migration used to produce.
const config = () => ({
  enabled: true,
  providers: [{ id: 'p', name: 'P', baseUrl: 'https://p.invalid/v1', apiKey: 'fixture-secret', apiFormat: 'openai',
    models: [{ id: 'lead', label: 'Lead' }] }],
  roleInclusions: { sidekick: [{ nativeUid: 'swe-2-medium' }] },
});

async function fixture(t, { seedCache = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-cache-sync-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config()));
  if (seedCache) {
    fs.writeFileSync(path.join(root, 'native-cache.json'), JSON.stringify({
      version: 1, savedAt: new Date().toISOString(),
      models: [{ uid: 'swe-2-medium', label: 'SWE-2 Medium', disabled: false, isModelRouter: false, harnessUids: ['swe-2'] }],
    }));
  }
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
          const upstream = s(7, 'swe-2-medium');
          const augmented = augmentCatalog(upstream, { rpc: target.pathname, format: proto,
            catalog: options.getCatalog(), onFusionStatus: options.onFusionStatus });
          res.writeHead(200, { 'content-type': 'application/proto' });
          res.end(augmented);
        },
      };
      return realRequire(name);
    },
  }, { filename });
  const backend = await module.exports.startBackend({ root, port: 0, log: () => {} });
  const base = 'http://127.0.0.1:' + backend.port;
  t.after(async () => { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, backend, base };
}

const teamChoices = async base => {
  const response = await fetch(base + TEAM_RPC, { method: 'POST', body: 'native' });
  const body = Buffer.from(await response.arrayBuffer());
  return parseFields(body).filter(field => field.number === 7).map(field => field.value.toString('utf8'));
};

// A BYOK Lead combined with a native Sidekick is only emittable once the native
// catalog knows that sidekick, so its matrix uid marks "resolvable now".
const nativeSidekickCombo = nativeModels => {
  const catalog = buildCatalog(config(), nativeModels);
  const leadUid = Object.keys(catalog.routes)[0];
  return `fusion-${leadUid}-sidekick-swe-2-medium`;
};

test('a seeded native cache resolves native-Sidekick combinations in the first team-settings answer', async t => {
  const f = await fixture(t, { seedCache: true });
  const values = await teamChoices(f.base);
  assert.ok(values.includes(nativeSidekickCombo(SEEDED)),
    'the very first answer must already contain the combination, not wait for live observations');
  assert.ok(values.some(value => value.startsWith('dfbyok-')), 'plain BYOK models remain listed');
});

test('without a cache the same combination is invisible in the first answer (the blind window)', async t => {
  const f = await fixture(t, { seedCache: false });
  const values = await teamChoices(f.base);
  assert.ok(!values.includes(nativeSidekickCombo(SEEDED)), 'a cold backend cannot resolve native-Sidekick combinations');
  assert.ok(values.some(value => value.startsWith('dfbyok-') && !value.startsWith('fusion-')),
    'plain BYOK models are unaffected by the blind window');
});

// The persisted cache must converge to the richest observation. Gating the save
// on the entry count alone never fires once a full seed is loaded (a seed of 875
// entries never changes size), so a dimension-less seed kept winning every
// restart and the mirrored combinations flipped between complete and empty.
test('an observation that only adds family metadata is still persisted', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-cache-improve-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ enabled: true,
    providers: [{ id: 'p', name: 'P', models: [{ id: 'lead', label: 'Lead' }] }] }));
  // Seeded without the dimensions the next observation will carry.
  fs.writeFileSync(path.join(root, 'native-cache.json'), JSON.stringify({ version: 1, savedAt: new Date().toISOString(),
    models: [{ uid: 'fusion-lead-a-sidekick-swe-2-high', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'] }] }));

  const dimensioned = cat(s(1, 'F'), s(22, 'fusion-lead-a-sidekick-swe-2-high'), m(23, cat(s(20, 'fusion'))),
    m(30, cat(s(1, 'Fusion'),
      m(2, cat(s(1, 'Lead'), m(2, cat(v(1, 1), s(2, 'Lead'))))),
      m(2, cat(s(1, 'Sidekick'), m(2, cat(v(1, 2), s(2, 'SWE-2 High'), v(3, 3))))),
      m(2, cat(s(1, 'Fast Mode'), m(2, cat(v(3, 2))))))));
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
          const upstream = cat(m(1, dimensioned));
          const observed = collectNativeModels(upstream, { rpc: target.pathname, format: proto });
          if (observed.length) options.onNativeModels?.(observed);
          res.writeHead(200, { 'content-type': 'application/proto' });
          res.end(upstream);
        },
      };
      return realRequire(name);
    },
  }, { filename });
  const backend = await module.exports.startBackend({ root, port: 0, log: () => {} });
  const response = await fetch('http://127.0.0.1:' + backend.port + '/exa.api_server_pb.ApiServerService/GetCliModelConfigs',
    { method: 'POST', body: 'native' });
  assert.equal(response.status, 200);
  // Read while the backend is still running: close() flushes unconditionally, so
  // only the content trigger can make the file richer before shutdown.
  const cacheFile = path.join(root, 'native-cache.json');
  const deadline = Date.now() + 5000;
  let saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  while (Date.now() < deadline && !saved.models[0]?.sidekickDimension) {
    await new Promise(resolve => setTimeout(resolve, 250));
    saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
  await backend.close();
  assert.equal(saved.models.length, 1, 'the uid set is unchanged, so only the content trigger can fire');
  const entry = saved.models[0];
  assert.deepEqual(entry.sidekickDimension, { order: 2, name: 'SWE-2 High', fastModeOrder: 0 },
    'the richer observation replaced the seeded copy');
  assert.deepEqual((entry.fusionMetadata || []).map(dim => dim.key), ['Lead', 'Sidekick', 'Fast Mode']);
});

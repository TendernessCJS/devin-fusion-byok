'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { collect } = require('../src/runtime/bridge.cjs');
const { augmentCatalog, buildCatalog, migrateFusionConfig } = require('../src/catalog.cjs');
const { parseFields, s } = require('../src/protocol/wire.cjs');

const TEAM_RPC = '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings';
const proto = { json: false, type: 'application/proto', framed: false };
const SEEDED = [{ uid: 'swe-2-medium', label: 'SWE-2 Medium', disabled: false, isModelRouter: false, harnessUids: ['swe-2'] }];
// The stored shape before presets were retired: the sidekick is selected only
// because a preset referenced it, which the migration turns into a role
// inclusion.
const legacyConfig = () => ({
  enabled: true,
  providers: [{ id: 'p', name: 'P', baseUrl: 'https://p.invalid/v1', apiKey: 'fixture-secret', apiFormat: 'openai',
    models: [{ id: 'lead', label: 'Lead' }] }],
  fusionPresets: [{ id: 'ds', name: 'DS Pro', lead: { providerId: 'p', model: 'lead', effort: null },
    sidekick: { nativeUid: 'swe-2-medium' } }],
});

async function fixture(t, { seedCache = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-cache-sync-'));
  const config = legacyConfig();
  migrateFusionConfig(config, seedCache ? SEEDED : []);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
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
  const config = legacyConfig();
  assert.equal(migrateFusionConfig(config, nativeModels), true, 'the fixture config must need migrating');
  const catalog = buildCatalog(config, nativeModels);
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

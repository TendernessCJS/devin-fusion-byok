'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { collect } = require('../src/runtime/bridge.cjs');
const { augmentCatalog, presetUid } = require('../src/catalog.cjs');
const { parseFields, s } = require('../src/protocol/wire.cjs');

const TEAM_RPC = '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings';
const proto = { json: false, type: 'application/proto', framed: false };

async function fixture(t, { seedCache = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-cache-sync-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    enabled: true,
    providers: [{ id: 'p', name: 'P', baseUrl: 'https://p.invalid/v1', apiKey: 'fixture-secret', apiFormat: 'openai',
      models: [{ id: 'lead', label: 'Lead' }] }],
    fusionPresets: [{ id: 'ds', name: 'DS Pro', lead: { providerId: 'p', model: 'lead', effort: null },
      sidekick: { nativeUid: 'swe-2-medium' } }],
  }));
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

test('a seeded native cache keeps saved Fusion presets in the first team-settings answer', async t => {
  const f = await fixture(t, { seedCache: true });
  const values = await teamChoices(f.base);
  assert.ok(values.includes(presetUid('ds')),
    'the very first answer must already contain the Fusion preset, not wait for live observations');
  assert.ok(values.some(value => value.startsWith('dfbyok-')), 'plain BYOK models remain listed');
});

test('without a cache the same preset is invisible in the first answer (the blind window)', async t => {
  const f = await fixture(t, { seedCache: false });
  const values = await teamChoices(f.base);
  assert.ok(!values.includes(presetUid('ds')), 'a cold backend cannot resolve native-referencing presets');
  assert.ok(values.some(value => value.startsWith('dfbyok-') && !value.startsWith('fusion-')),
    'plain BYOK models are unaffected by the blind window');
});

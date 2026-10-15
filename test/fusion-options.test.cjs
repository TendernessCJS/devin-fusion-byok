'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { modelEfforts } = require('../src/model-capabilities.cjs');
const { buildCatalog, resolveAssignment } = require('../src/catalog.cjs');
const { buildRequestBody } = require('../src/protocol/responses.cjs');
const { createManager } = require('../src/panel/model.cjs');
const { rendererFile, loadFamilyPicker } = require('./support/installed-renderer.cjs');
const config = () => ({ providers: [{ id: 'load', name: 'load', apiFormat: 'openai-responses', models:
  ['gpt-6-astra', 'swe-2-high', 'swe-2-max', 'swe-2-medium'].map(id => ({ id, efforts: [] })) }],
  sidekicks: [{ providerId: 'load', model: 'swe-2-max' }, { nativeUid: 'swe-2-max' }] });
const OBSERVED_SWE = [
  { uid: 'swe-2-max', label: 'SWE-2 Max', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6', 'swe-1p5'] },
  { uid: 'fusion-lead-a-sidekick-swe-2-max', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 3, name: 'SWE-2 Max' } },
];

test('legacy empty effort lists gain GPT presets while retaining provider-default routing UIDs', () => {
  const catalog = buildCatalog(config());
  const gpt = Object.values(catalog.routes).filter(route => route.model === 'gpt-6-astra');
  assert.deepEqual(gpt.map(route => route.effort), [null, 'low', 'medium', 'high', 'xhigh', 'max']);
  const digest = crypto.createHash('sha256').update(JSON.stringify(['load', 'gpt-6-astra', null])).digest('hex').slice(0, 16);
  assert.equal(gpt[0].uid, 'dfbyok-load-gpt-6-astra-' + digest);
  const maxRoute = gpt.at(-1);
  assert.notEqual(maxRoute.uid, gpt[0].uid);
  const maxModel = catalog.models.find(model => model.uid === maxRoute.uid);
  assert.equal(maxModel.label, 'load · gpt-6-astra Max');
  assert.deepEqual(maxModel.json.modelFamilyMetadata.entries, [{ key: 'Effort', value: { order: 5, name: 'Max', controlType: 1 } }]);
  for (const role of ['lead', 'sidekick']) {
    assert.ok(catalog.rolePool[role].some(item => item.ref.providerId === 'load' && item.ref.model === 'gpt-6-astra' && item.ref.effort === 'max'),
      role + ' candidates expose the automatic Max preset');
  }
  assert.deepEqual(modelEfforts({ id: 'o3', efforts: [] }), [null, 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(modelEfforts({ id: 'swe-2-max', efforts: [] }), [null]);
  assert.deepEqual(modelEfforts({ id: 'relay/gpt-6-astra-high', efforts: [] }), [null]);
  assert.deepEqual(modelEfforts({ id: 'custom-model', efforts: [] }), [null]);
  assert.deepEqual(modelEfforts({ id: 'gpt-6-astra', efforts: [], effortMode: 'none' }), [null]);
  assert.deepEqual(modelEfforts({ id: 'custom-model', efforts: ['none', 'medium', 'max'], effortMode: 'manual' }), ['none', 'medium', 'max']);
});

test('every enabled import is a Sidekick without a second configuration step', () => {
  const input = config();
  input.providers.push({ id: 'other', name: 'Other', models: [{ id: 'extra' }, { id: 'disabled', enabled: false }] });
  const catalog = buildCatalog(input, OBSERVED_SWE);
  assert.deepEqual(new Set(catalog.sidekicks.filter(s => !s.native).map(s => s.providerId + '/' + s.model)),
    new Set(['load/gpt-6-astra', 'load/swe-2-high', 'load/swe-2-max', 'load/swe-2-medium', 'other/extra']));
  const perLead = new Set(Object.values(catalog.routes).map(route =>
    Object.values(catalog.fusions).filter(fusion => fusion.leadUid === route.uid).length));
  assert.equal(perLead.size, 1, 'every Lead is mirrored with the same Sidekick set');
  assert.ok([...perLead][0] >= 5, 'each Lead pairs with every Sidekick family representative');
  assert.ok(catalog.rolePool.sidekick.length >= 6);
  assert.equal(input.sidekicks.length, 2, 'catalog generation does not rewrite user settings');
});

test('selected native Fusion effort resolves to the actual Responses and Chat API parameter', () => {
  const catalog = buildCatalog(config());
  const request = { systemPrompt: '', messages: [{ role: 'user', content: 'Hello' }] };
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const pair = Object.values(catalog.fusions).find(f => catalog.routes[f.leadUid].model === 'gpt-6-astra' && catalog.routes[f.leadUid].effort === effort &&
      !f.sidekickNative && catalog.routes[f.sidekickUid].model === 'swe-2-high');
    assert.ok(pair);
    const lead = resolveAssignment({ modelRouterUid: pair.uid }, { json: true }, catalog).assignment.modelUid;
    assert.equal(buildRequestBody(request, catalog.routes[lead], { apiFormat: 'openai-responses' }).reasoning.effort, effort);
    assert.equal(buildRequestBody(request, catalog.routes[lead], { apiFormat: 'openai' }).reasoning_effort, effort);
    const sidekick = resolveAssignment({ modelRouterUid: pair.uid, fusionLeadRouterUid: pair.uid }, { json: true }, catalog).assignment.modelUid;
    assert.equal(catalog.routes[sidekick].model, 'swe-2-high');
  }
  assert.equal(buildRequestBody(request, { model: 'custom', effort: 'none' }, { apiFormat: 'openai' }).reasoning_effort, 'none');
  assert.deepEqual(buildRequestBody(request, { model: 'custom', effort: 'none' }, { apiFormat: 'openai-responses' }).reasoning, { effort: 'none' });
  assert.equal(buildRequestBody(request, { model: 'custom', effort: null }, { apiFormat: 'openai' }).reasoning_effort, undefined);
});

test('actual installed Fusion picker enables every GPT effort and imported Sidekick', { skip: !fs.existsSync(rendererFile) }, () => {
  const native = loadFamilyPicker();
  const catalog = buildCatalog(config(), OBSERVED_SWE);
  const models = catalog.models.filter(m => m.kind === 'matrix').map(m => ({ modelUid: m.uid, disabled: false, familyUid: m.json.modelInfo.modelFamilyUid,
    familyMetadata: Object.fromEntries(m.json.modelFamilyMetadata.entries.map(e => [e.key, e.value])) }));
  const rows = native.rows(models);
  assert.equal(rows.length, 1, 'mirrored entries join the single official Fusion family');
  const variants = rows[0].family.models;
  assert.equal(variants.length, models.length, 'every mirrored combination stays in the family');
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.ok(variants.some(model => catalog.routes[catalog.fusions[model.modelUid].leadUid].effort === effort),
      effort + ' remains reachable through the family');
  }
});

test('selective import immediately exposes the new model in both roles and effort settings are editable', async () => {
  const observed = [...OBSERVED_SWE,
    { uid: 'nova-1-high', label: 'Nova High', disabled: false, isModelRouter: false, harnessUids: ['nova-harness'] },
    { uid: 'fusion-lead-a-sidekick-nova-1-high', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 4, name: 'Nova High' } }];
  let current = { providers: [{ id: 'load', name: 'load', models: [] }], sidekicks: [{ nativeUid: 'nova-1-high' }],
    roleInclusions: { lead: [{ nativeUid: 'swe-2-max' }], sidekick: [] } };
  const manager = createManager({ read: () => structuredClone(current), write: c => { current = c; },
    discover: async p => { p.models = [{ id: 'gpt-6-astra', efforts: [] }] }, nativeModels: () => observed });
  const preview = await manager.dispatch('refreshModels', { providerId: 'load' });
  // Before any import the only selectable Lead is the explicitly included
  // native one, so it mirrors exactly one combination.
  assert.equal(preview.fusionCount, 1, 'only the included native Lead is mirrored before an import');
  const imported = await manager.dispatch('importModels', { providerId: 'load', token: preview.importCandidates.token, ids: ['gpt-6-astra'] });
  assert.ok(imported.fusionCount > 0, 'importing a model mirrors its combinations');
  // The per-variant pool lives on the catalog (the panel only sees family-level
  // role rows), so it is read from the persisted config the manager wrote.
  const pool = role => buildCatalog(current, observed).rolePool[role];
  assert.equal(pool('lead').filter(item => !item.ref.nativeUid).length, 6);
  assert.ok(pool('lead').some(item => item.ref.nativeUid === 'swe-2-max'));
  assert.ok(pool('lead').some(item => item.ref.model === 'gpt-6-astra' && item.ref.effort === 'max'));
  assert.ok(pool('sidekick').some(item => item.ref.model === 'gpt-6-astra' && item.ref.effort === 'max'));
  assert.ok(pool('lead').some(item => item.ref.model === 'gpt-6-astra' && item.ref.effort === null));
  assert.ok(imported.roleLists.lead.some(item => item.ref.model === 'gpt-6-astra'), 'the panel row appears too');
  assert.ok(imported.sidekicks.some(s => s.providerId === 'load' && s.model === 'gpt-6-astra'));
  const custom = await manager.dispatch('updateModels', { providerId: 'load', changes: [{ id: 'gpt-6-astra', effortMode: 'manual', efforts: ['low', 'high'] }] });
  assert.ok(custom.fusionCount < imported.fusionCount, 'fewer effort variants mirror fewer combinations');
  assert.equal(pool('lead').filter(item => !item.ref.nativeUid).length, 2);
  assert.ok(pool('lead').some(item => item.ref.nativeUid === 'swe-2-max'));
  const providerDefault = await manager.dispatch('updateModels', { providerId: 'load', changes: [{ id: 'gpt-6-astra', effortMode: 'none' }] });
  assert.ok(providerDefault.fusionCount < custom.fusionCount, 'a single variant mirrors the fewest combinations');
  assert.equal(pool('lead').filter(item => !item.ref.nativeUid).length, 1);
  assert.ok(pool('lead').some(item => item.ref.nativeUid === 'swe-2-max'));
});

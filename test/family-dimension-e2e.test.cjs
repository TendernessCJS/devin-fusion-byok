'use strict';
// Full-chain contract: production buildCatalog → augmentCatalog → native
// decode → real mapModelCatalog → real intersection rr → real family
// aggregation/selection → production resolveAssignment. Only the decode step
// is reimplemented (it mirrors protobuf-es defaults: absent scalars decode to
// 0 / ''), and it covers exactly the fields the mapper reads: config label,
// modelUid, provider, supportsImages, maxTokens, disabled, modelInfo
// {modelFamilyUid, displayOption}, modelFamilyMetadata {label, entries
// key→{order,name}} and sorts {name, groups{groupName, modelLabels}}.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalog, augmentCatalog, resolveAssignment } = require('../src/catalog.cjs');
const { fields, str, num, s, v, m } = require('../src/protocol/wire.cjs');
const { cat, proto, json, lsStatus, config, OBSERVED_SWE, statusFixture } = require('./helpers/catalog-fixtures.cjs');
const { webappAvailable, loadWebappPicker, loadModelCatalogMapper, loadFamilyPipeline } = require('./helpers/installed-renderer.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// Loads the helper against a synthetic install root so drift cases exercise
// the real detection code, not the machine's actual Devin install.
function helperAt(root) {
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'helpers/installed-renderer.cjs'), 'utf8'),
    { module: mod, require, process: { env: { DFBYOK_TEST_APP_ROOT: root } } });
  return mod.exports;
}
const tempRoot = files => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-app-'));
  const assets = path.join(root, 'out/vs/workbench/devin-webapp-host/assets');
  for (const [name, source] of Object.entries(files || {})) {
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, name), source);
  }
  return root;
};

const field = (buffer, number) => fields(buffer, number)[0];

function decodeConfig(buffer) {
  const info = field(buffer, 23)?.value, meta = field(buffer, 30)?.value;
  return {
    label: str(buffer, 1), modelUid: str(buffer, 22), provider: num(buffer, 10),
    supportsImages: !!num(buffer, 5), maxTokens: num(buffer, 18) || undefined,
    disabled: !!num(buffer, 4),
    // protobuf-es defaults for scalar/repeated fields the mapper reads and we
    // never write (pricing/cost fields are outside this decoder's coverage).
    pricingType: 0, creditMultiplier: 0, modelCostTier: 0, modelDimensions: [], complianceLevels: [],
    modelInfo: info && { modelFamilyUid: str(info, 23) || undefined, displayOption: num(info, 22) },
    modelFamilyMetadata: meta && {
      modelFamilyLabel: str(meta, 1),
      // protobuf-es materializes absent scalars: an order/name that was never
      // written decodes as 0 / '', never undefined.
      entries: fields(meta, 2).map(entry => ({ key: str(entry.value, 1),
        value: { order: num(field(entry.value, 2)?.value ?? Buffer.alloc(0), 1),
          name: str(field(entry.value, 2)?.value ?? Buffer.alloc(0), 2) } })),
    },
  };
}

function decodeStatus(bytes) {
  const list = field(bytes, 33);
  assert.ok(list && list.wire === 2, 'the status carries cascadeModelConfigData at field 33');
  return {
    clientModelConfigs: fields(list.value, 1).map(entry => decodeConfig(entry.value)),
    clientModelSorts: fields(list.value, 2).map(entry => ({ name: str(entry.value, 1),
      groups: fields(entry.value, 2).map(group => ({ groupName: str(group.value, 1),
        modelLabels: fields(group.value, 2).map(label => label.value.toString('utf8')) })) })),
  };
}

function fixture(catalog = buildCatalog(config(), OBSERVED_SWE)) {
  const fixture = statusFixture();
  // The stored auth status is the bare UserStatus (field 1 = `pro` bool →
  // varint, model list at field 33) — the same payload the auth hook rewrites.
  const bare = cat(v(1, 1), m(33, cat(fixture.list,
    m(1, cat(s(1, 'Official'), s(22, 'fusion-claude-fable-5-1-medium-sidekick-swe-2-max'), v(32, 1),
      m(23, cat(s(20, 'fusion'), v(25, 1))), m(30, cat(s(1, 'Fusion'),
      m(2, cat(s(1, 'Sidekick'), m(2, cat(v(1, 3), s(2, 'SWE-2 Max'), v(3, 3))))))))))));
  const augmented = augmentCatalog(bare, { rpc: lsStatus, format: proto, catalog });
  const data = decodeStatus(augmented);
  const mapModelCatalog = loadModelCatalogMapper();
  const rr = loadWebappPicker();
  const { Gt, Kt, Ut, Nt, Pt, Ft } = loadFamilyPipeline();
  const mapped = mapModelCatalog(data);
  // ACP configOption values are uid strings; the official agent offers the
  // same catalog it was fed, so every emitted uid plus the native ones appear.
  const options = data.clientModelConfigs.map(entry => ({ name: entry.label, value: entry.modelUid }));
  const strict = rr({ name: 'model', options }, mapped, true);
  const ordered = strict.models;
  const grouped = Gt(ordered, ordered);
  const rows = Kt(grouped, [], null, true);
  const fusion = grouped.families.get('fusion');
  let current = rows.find(row => row.family?.familyUid === 'fusion')?.model;
  const select = (dimName, orderNameOrOrder) => {
    const index = fusion.dimensions.findIndex(dimension => dimension.name === dimName);
    assert.ok(index >= 0, 'dimension present: ' + dimName);
    const dimension = fusion.dimensions[index];
    const order = typeof orderNameOrOrder === 'number' ? orderNameOrOrder
      : dimension.values.find(value => value.name === orderNameOrOrder)?.order;
    assert.ok(order !== undefined, `dimension ${dimName} offers value ${orderNameOrOrder}`);
    const picked = Ut(fusion, current, index, order);
    assert.ok(picked, `selecting ${dimName}=${orderNameOrOrder} resolves a model`);
    // The real UI applies the next dimension choice to the newly picked model,
    // which is what constrains the remaining dimensions.
    current = picked;
    return picked;
  };
  return { catalog, fixture, augmented, data, mapped, strict, grouped, rows, fusion, select, Nt, Pt, Ft, ordered };
}

test('the strict intersection produces real sorts and no misses for a fully-offered catalog', { skip: !webappAvailable }, () => {
  const f = fixture();
  assert.ok(f.strict.models.length > 0 && f.strict.sorts.length > 0, 'strict branch taken');
  assert.equal(f.strict.catalogMisses.length, 0, 'every offered option resolved into the catalog');
  const fusionRow = f.rows.find(row => row.family?.familyUid === 'fusion');
  assert.ok(fusionRow, 'the emitted fusion family renders as a family row');
  const dimNames = [...f.fusion.dimensions].map(dimension => dimension.name);
  assert.deepEqual(dimNames, ['Lead', 'Effort', 'Sidekick', 'Fast Mode', 'Recommended Sidekick'],
    'dimension order follows first-seen emission');
});

test('BYOK lead × native sidekick: every shown dimension value resolves to a concrete emitted uid', { skip: !webappAvailable }, () => {
  const f = fixture();
  const catalogUids = new Set(f.catalog.models.map(model => model.uid));
  // 1-value dimensions are not switchable in the real UI; 2+ value ones are.
  for (const dimension of f.fusion.dimensions) {
    if (dimension.name === 'Fast Mode' || dimension.name === 'Recommended Sidekick') {
      assert.equal(dimension.values.length, 1, `${dimension.name} collapses to one value and stays hidden`);
      continue;
    }
    assert.ok(dimension.values.length >= 2, `${dimension.name} offers ${dimension.values.length} values`);
  }
  assert.deepEqual([...f.fusion.dimensions[1].values].map(value => value.name), ['Medium', 'High']);
  // The machine-verified session shape: BYOK lead × native sidekick.
  const picked = f.select('Sidekick', 'SWE-2 Max');
  assert.equal(picked.modelUid.includes('-sidekick-swe-2-max'), true);
  const lead = resolveAssignment({ modelRouterUid: picked.modelUid }, json, f.catalog);
  const sidekick = resolveAssignment({ fusionLeadRouterUid: picked.modelUid }, json, f.catalog);
  assert.equal(lead.assignment.modelUid.startsWith('dfbyok-'), true, 'the lead resolves to a BYOK uid');
  assert.deepEqual(lead.assignment.harnessUids, ['fusion']);
  assert.equal(sidekick.assignment.modelUid, 'swe-2-max');
  assert.deepEqual(sidekick.assignment.harnessUids, ['swe-1p6', 'swe-1p5'], 'the native sidekick keeps its native harnesses');
  assert.equal(catalogUids.has(picked.modelUid), true, 'the pick is an actually emitted uid');
});

test('BYOK × BYOK combinations resolve; same-model pairs and fast variants are never emitted', { skip: !webappAvailable }, () => {
  const f = fixture();
  const matrix = f.fusion.models;
  for (const model of matrix) {
    assert.equal(model.modelUid.includes('-fast'), false, 'no forged fast-mode tier');
    const parts = model.modelUid.slice('fusion-'.length).split('-sidekick-');
    assert.equal(parts[0].startsWith(parts[1] + '-'), false, 'lead and sidekick are never the same uid');
  }
  // Switching the lead to the effort-less CPA · SWE-2 Max lands on whichever
  // sidekick best keeps the previous trailing values (real Ut fallback); the
  // BYOK lead still resolves to BYOK × BYOK with ['fusion'] harnesses.
  const picked = f.select('Lead', 'CPA · SWE-2 Max');
  assert.ok(picked.modelUid.startsWith('fusion-dfbyok-cpa-ws-swe-2-max-'), picked.modelUid);
  const assignment = resolveAssignment({ modelRouterUid: picked.modelUid }, json, f.catalog);
  assert.equal(assignment.assignment.modelUid.startsWith('dfbyok-cpa-ws-swe-2-max-'), true);
  assert.deepEqual(assignment.assignment.harnessUids, ['fusion']);
  const sk = resolveAssignment({ fusionLeadRouterUid: picked.modelUid }, json, f.catalog);
  assert.equal(sk.assignment.modelUid.startsWith('dfbyok-'), true);
  // The exact-match path ignores dimensions the current model lacks: picking
  // the effort-carrying BYOK sidekick lands on the exact emitted tuple.
  const sidekickPicked = f.select('Sidekick', 'CPA · Grok 4.6 Medium');
  assert.equal(sidekickPicked.modelUid,
    'fusion-dfbyok-cpa-ws-swe-2-max-66dfb6f3f0c50d9e-sidekick-dfbyok-cpa-grok-4-6-9305ca7fe8d45a41');
  const sk2 = resolveAssignment({ fusionLeadRouterUid: sidekickPicked.modelUid }, json, f.catalog);
  assert.equal(sk2.assignment.modelUid, 'dfbyok-cpa-grok-4-6-9305ca7fe8d45a41');
});

test('native official fusion rows keep the native path untouched', { skip: !webappAvailable }, () => {
  // An official fusion row only survives when both components are observed
  // natives — otherwise stale retirement drops it like any foreign fusion uid.
  const natives = [...OBSERVED_SWE,
    { uid: 'claude-fable-5-1-medium', label: 'Fable', disabled: false, isModelRouter: false, harnessUids: ['claude-harness'] }];
  const f = fixture(buildCatalog(config(), natives));
  const official = 'fusion-claude-fable-5-1-medium-sidekick-swe-2-max';
  const entry = f.data.clientModelConfigs.find(entry => entry.modelUid === official);
  assert.ok(entry, 'the official fusion entry survives the rewrite');
  assert.equal(entry.disabled, false);
  const resolved = resolveAssignment({ modelRouterUid: official }, json, f.catalog);
  assert.equal(resolved.assignment.modelUid, 'claude-fable-5-1-medium');
  assert.ok(resolved.assignment.harnessUids.includes('claude-harness'), 'native lead keeps its native harness');
});

test('dimension degenerates: order-0 default matches explicit 0, order collisions dedupe first-seen', { skip: !webappAvailable }, () => {
  const f = fixture();
  // Fast Mode is emitted with only a controlType — its decoded {order:0,name:''}
  // must equal an explicitly-written order 0, and every entry collapsing to the
  // same order leaves exactly one value.
  const fastMode = f.fusion.dimensions.find(dimension => dimension.name === 'Fast Mode');
  assert.deepEqual([...fastMode.values].map(value => ({ order: value.order, name: value.name })), [{ order: 0, name: '' }]);
  const recommended = f.fusion.dimensions.find(dimension => dimension.name === 'Recommended Sidekick');
  assert.equal(recommended.values.length, 1, 'all name-only values share order 0 and dedupe to first-seen');
  assert.equal(recommended.values[0].name, 'CPA · SWE-2 Max');
  // A true toggle: two empty-name values render via the i18n on/off path.
  const { Pt, Ft } = f;
  const values = Pt([{ familyMetadata: { X: { order: 0, name: '' } } }, { familyMetadata: { X: { order: 1, name: '' } } }])[0].values;
  assert.equal(values.length, 2);
  assert.equal(Ft(values), true, 'two empty-name values are a toggle');
});

test('intersection fallback: empty catalog falls back to ACP options, disabled entries render as disabled rows', { skip: !webappAvailable }, () => {
  const rr = loadWebappPicker();
  const options = [{ name: 'Opt A', value: 'uid-a' }, { name: 'Opt B', value: 'uid-b' }];
  const empty = rr({ name: 'model', options }, { models: [], sorts: [] }, true);
  assert.deepEqual(empty.models.map(model => model.modelUid), ['uid-a', 'uid-b'],
    'the ACP option list is the fallback, not a dropped catalog');
  assert.equal(empty.catalogMisses.length, 0);
  const disabled = rr({ name: 'model', options },
    { models: [{ modelUid: 'gone', label: 'Gone', disabled: true }, { modelUid: 'uid-a', label: 'A' }],
      sorts: [{ name: 'S', isDefault: true, groups: [{ name: 'G', modelUids: ['uid-a'] }] }] }, true);
  const row = disabled.models.find(model => model.modelUid === 'gone');
  assert.ok(row && row.disabled === true, 'a disabled catalog entry survives as a disabled row');
});

test('duplicate labels collapse to the last uid in sort resolution and lose earlier rows', { skip: !webappAvailable }, () => {
  const rr = loadWebappPicker();
  const options = [{ name: 'Same', value: 'uid-first' }, { name: 'Same', value: 'uid-last' }];
  // label→uid Map overwrite is the installed behavior: the earlier uid is
  // unreachable through sorts even though both models exist.
  const mapped = { models: [{ modelUid: 'uid-first', label: 'Same' }, { modelUid: 'uid-last', label: 'Same' }],
    sorts: [{ name: 'S', groups: [{ name: 'G', modelLabels: ['Same'] }] }] };
  const strict = rr({ name: 'model', options }, { models: mapped.models, sorts: [{ name: 'S', isDefault: true, displayMetric: undefined, groups: [{ name: 'G', modelUids: ['uid-last'] }] }] }, true);
  assert.equal(strict.sorts[0].groups[0].options[0].modelUid, 'uid-last');
});

test('mutation proof: a wrong order or a missing dimension value breaks the exact selection', { skip: !webappAvailable }, () => {
  const f = fixture();
  const sidekick = f.fusion.dimensions.find(dimension => dimension.name === 'Sidekick');
  const rep = f.rows.find(row => row.family?.familyUid === 'fusion')?.model;
  // Mutate a copy: give the Medium sidekick a nonexistent tuple constraint.
  const { Ut } = loadFamilyPipeline();
  const wrongOrder = Math.max(...sidekick.values.map(value => value.order)) + 777;
  const picked = Ut(f.fusion, rep, 2, wrongOrder);
  assert.notEqual(picked?.modelUid, 'fusion-dfbyok-cpa-grok-4-6-9305ca7fe8d45a41-sidekick-dfbyok-cpa-ws-swe-2-max-66dfb6f3f0c50d9e',
    'an order that matches no tuple cannot select the original combination');
  const f2 = fixture();
  const noEffort = f2.fusion.models.map(model => ({ ...model, familyMetadata: Object.fromEntries(
    Object.entries(model.familyMetadata ?? {}).filter(([key]) => key !== 'Effort')) }));
  const regrouped = f2.Nt(noEffort);
  assert.equal(regrouped.families.get('fusion').dimensions.find(dimension => dimension.name === 'Effort'), undefined,
    'removing the Effort dimension value removes the dimension entirely');
});

test('installed-renderer probe: missing assets dir skips, present-but-drifted fails loudly', () => {
  const missing = helperAt(fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-empty-')));
  assert.equal(missing.webappAvailable, false, 'no assets dir is the only skip channel');
  // A directory that exists must yield exactly one matching bundle — anything
  // else is a layout change, never a silent skip.
  const drifted = helperAt(tempRoot({ 'renamed.js': 'function replacementPicker() { return []; }' }));
  assert.equal(drifted.webappAvailable, true);
  assert.throws(() => drifted.loadWebappPicker(), /layout changed/);
  const duplicated = helperAt(tempRoot({
    'a.js': 'x catalogMisses y', 'b.js': 'x catalogMisses y' }));
  assert.throws(() => duplicated.loadWebappPicker(), /layout changed.*2 bundles|duplicate/i);
  // A real present-but-anchorless mapper bundle must throw too.
  const noMapper = helperAt(tempRoot({ 'modelCatalogSource-x.js': 'export{}' }));
  assert.throws(() => noMapper.loadModelCatalogMapper(), /not found|layout changed/);
});

test('installed-renderer probe: a file at the assets path or fs failures fail loudly, never skip', () => {
  // The assets path existing as a regular file is drift, not absence.
  const fileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-file-'));
  const assetsFile = path.join(fileRoot, 'out/vs/workbench/devin-webapp-host/assets');
  fs.mkdirSync(path.dirname(assetsFile), { recursive: true });
  fs.writeFileSync(assetsFile, 'not a directory');
  const h = helperAt(fileRoot);
  assert.equal(h.webappAvailable, true, 'a file at the path is not ENOENT');
  assert.throws(() => h.loadWebappPicker(), /layout changed|ENOENT|ENOTDIR/);
  // Duplicate anchor-bearing bundles are drift, never a first-match win.
  const dup = helperAt(tempRoot({ 'x.js': 'pre catalogMisses post', 'y.js': 'pre catalogMisses post' }));
  assert.throws(() => dup.loadWebappPicker(), /layout changed/);
});

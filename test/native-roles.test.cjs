'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeRoles, buildCatalog, buildRoleLists, resolveAssignment } = require('../src/catalog.cjs');
const { createManager } = require('../src/panel/manager.cjs');
const { fields, str, s } = require('../src/protocol/wire.cjs');

const ref = (model, effort = null) => ({ providerId: 'p', model, effort });
const config = () => ({ providers: [{ id: 'p', name: 'Provider', apiKey: 'SECRET', models: [{ id: 'a', efforts: ['low', 'high'] }, { id: 'b' }] }] });
// The writer replaces the stored config rather than merging into it, so a key
// the manager deletes (a pruned role list, a retired preset field) really goes
// away — which is what updateConfig + applyKeyDelta do on disk.
const managerFor = (current, nativeModels) => {
  const holder = { config: current };
  return { manager: createManager({ read: () => structuredClone(holder.config), write: next => { holder.config = structuredClone(next); }, nativeModels: () => nativeModels }), holder };
};

// Models the strict official lists do not cover are still offered as roles: the
// vendor's own Fusion card simply has not listed them yet. This is the layer
// that named presets used to reach into; presets are gone, the capability is not.
test('standalone unlocked native models are candidates without official Fusion rows', () => {
  const native = { uid: 'standalone-swe', label: 'Standalone SWE', disabled: false, isModelRouter: false, harnessUids: ['swe-standalone'] };
  const input = config();
  const roles = buildRoleLists(input, [native]);
  const leadRow = roles.lead.find(item => item.ref.nativeUid === native.uid);
  const sidekickRow = roles.sidekick.find(item => item.ref.nativeUid === native.uid);
  assert.equal(leadRow.available, true);
  assert.equal(leadRow.selected, false, 'an unofficial native model is available but never selected by default');
  assert.equal(sidekickRow.available, true);
  assert.equal(sidekickRow.selected, false);
  assert.equal(buildCatalog(input, [native]).rolePool.lead.some(item => item.ref.nativeUid === native.uid), false);

  input.roleInclusions = { lead: [{ nativeUid: native.uid }], sidekick: [{ nativeUid: native.uid }] };
  const included = buildCatalog(input, [native]);
  assert.deepEqual(included.rolePool.lead.find(item => item.ref.nativeUid === native.uid).ref, { nativeUid: native.uid });
  assert.deepEqual(included.rolePool.sidekick.find(item => item.ref.nativeUid === native.uid).ref, { nativeUid: native.uid });
  const combos = Object.values(included.fusions).filter(fusion => fusion.leadUid === native.uid || fusion.sidekickUid === native.uid);
  assert.ok(combos.length >= 2, 'selected native roles produce combinations');
  for (const fusion of combos) {
    const lead = resolveAssignment({ modelRouterUid: fusion.uid }, { json: true }, included).assignment;
    assert.equal(lead.modelUid, fusion.leadUid);
    if (fusion.leadNative) assert.deepEqual(lead.harnessUids, fusion.leadHarnessUids);
    const side = resolveAssignment({ modelRouterUid: fusion.uid, fusionLeadRouterUid: fusion.uid }, { json: true }, included).assignment;
    assert.equal(side.modelUid, fusion.sidekickUid);
    if (fusion.sidekickNative) assert.deepEqual(side.harnessUids, fusion.sidekickHarnessUids);
    const proto = resolveAssignment(s(2, fusion.uid), {}, included);
    assert.equal(str(fields(proto, 1)[0].value, 2), fusion.leadUid);
  }
});

test('analyzeRoles feeds both builders identical results to recomputing per call', () => {
  const observed = [
    { uid: 'swe-2-max', label: 'SWE-2 Max', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'], familyUid: 'fam-swe' },
    { uid: 'swe-2-mini', label: 'SWE-2 Mini', disabled: false, isModelRouter: false, harnessUids: ['swe-1p5'], familyUid: 'fam-swe' },
    { uid: 'outside-allowlist', label: 'Outside', disabled: false, isModelRouter: false, harnessUids: ['odd-harness'] },
    { uid: 'fusion-lead-a-sidekick-swe-2-max', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'],
      sidekickDimension: { order: 3, name: 'SWE-2 Max' } },
  ];
  const input = config();
  input.hiddenNativeModelUids = ['swe-2-mini'];
  input.roleExclusions = { lead: [{ nativeUid: 'swe-2-max' }] };
  const allowed = new Set(['swe-2-max', 'swe-2-mini']);
  const analysis = analyzeRoles(input, observed, allowed);
  // The analysis keeps both hidden semantics: the catalog reads the direct
  // blacklist, the role list the family-expanded one (swe-2-max joins
  // swe-2-mini's family).
  assert.ok(analysis.hidden.has('swe-2-mini') && !analysis.hidden.has('swe-2-max'));
  assert.ok(analysis.hiddenExpanded.has('swe-2-max'), 'family expansion reaches the sibling uid');
  assert.ok(analysis.allowed.has('swe-2-max') && !analysis.allowed.has('outside-allowlist'));
  assert.deepEqual(buildRoleLists(input, observed, allowed, analysis), buildRoleLists(input, observed, allowed));
  assert.deepEqual(buildCatalog(input, observed, allowed, analysis), buildCatalog(input, observed, allowed));
});

test('standalone duplicate eligibility conflicts fail closed while identical records remain eligible', () => {
  const base = { uid: 'duplicate-native', label: 'Duplicate', disabled: false, isModelRouter: false, harnessUids: ['native-harness'] };
  const conflicting = [
    { disabled: true, isModelRouter: false, harnessUids: ['native-harness'] },
    { disabled: false, isModelRouter: true, harnessUids: ['native-harness'] },
    { disabled: false, isModelRouter: false, harnessUids: [] },
    { disabled: false, isModelRouter: false, harnessUids: ['different'] },
    { disabled: false, isModelRouter: false, harnessUids: ['   '] },
  ];
  for (const contradiction of conflicting) {
    for (const order of [[base, { ...base, ...contradiction }], [{ ...base, ...contradiction }, base]]) {
      const input = config();
      input.roleInclusions = { lead: [{ nativeUid: base.uid }], sidekick: [{ nativeUid: base.uid }] };
      const pool = buildCatalog(input, order).rolePool;
      assert.equal(pool.lead.some(item => item.ref.nativeUid === base.uid), false);
      assert.equal(pool.sidekick.some(item => item.ref.nativeUid === base.uid), false);
    }
  }
  const input = config();
  input.roleInclusions = { lead: [{ nativeUid: base.uid }], sidekick: [{ nativeUid: base.uid }] };
  const pool = buildCatalog(input, [base, { ...base }]).rolePool;
  assert.equal(pool.lead.filter(item => item.ref.nativeUid === base.uid).length, 1);
  assert.equal(pool.sidekick.filter(item => item.ref.nativeUid === base.uid).length, 1);
});

test('standalone native candidates preserve filtering and role-specific exclusions', () => {
  const valid = { uid: 'valid-native', label: 'Valid', disabled: false, isModelRouter: false, harnessUids: ['native-harness'] };
  const entries = [valid,
    { uid: 'disabled-native', label: 'Disabled', disabled: true, isModelRouter: false, harnessUids: ['h'] },
    { uid: 'router-native', label: 'Router', disabled: false, isModelRouter: true, harnessUids: ['h'] },
    { uid: 'bad-harness', label: 'Bad', disabled: false, isModelRouter: false, harnessUids: [] },
    { uid: 'fusion-router', label: 'Fusion', disabled: false, isModelRouter: false, harnessUids: ['h'] },
    { uid: 'malformed-harness', label: 'Malformed', disabled: false, isModelRouter: false, harnessUids: [''] },
  ];
  const input = config();
  input.hiddenNativeModelUids = ['valid-native'];
  input.roleInclusions = { lead: [{ nativeUid: valid.uid }], sidekick: [{ nativeUid: valid.uid }] };
  assert.equal(buildCatalog(input, entries).rolePool.lead.some(item => item.ref.nativeUid), false,
    'a hidden model is never a candidate even when included');
  const hiddenOff = { ...input, hiddenNativeModelUids: [] };
  const included = buildCatalog(hiddenOff, entries);
  assert.equal(included.rolePool.lead.some(item => item.ref.nativeUid === valid.uid), true);
  assert.equal(included.rolePool.lead.some(item => item.ref.nativeUid === 'disabled-native'), false);
  assert.equal(included.rolePool.lead.some(item => item.ref.nativeUid === 'fusion-router'), false);
  const excluded = { ...hiddenOff, roleExclusions: { lead: [{ nativeUid: valid.uid }], sidekick: [] } };
  const catalog = buildCatalog(excluded, entries);
  assert.equal(catalog.rolePool.lead.some(item => item.ref.nativeUid === valid.uid), false);
  assert.equal(catalog.rolePool.sidekick.some(item => item.ref.nativeUid === valid.uid), true, 'exclusions stay role-specific');
});

test('role switches persist, stay role-specific and survive a restart', async () => {
  const native = { uid: 'optin-native', label: 'OptIn', disabled: false, isModelRouter: false, harnessUids: ['optin-harness'] };
  const { manager, holder } = managerFor(config(), [native]);
  await manager.dispatch('setRoleModel', { role: 'sidekick', model: { nativeUid: native.uid }, enabled: true });
  assert.deepEqual(holder.config.roleInclusions, { sidekick: [{ nativeUid: native.uid }] }, 'empty role lists are not persisted');
  const catalog = buildCatalog(holder.config, [native]);
  assert.equal(catalog.rolePool.lead.some(item => item.ref.nativeUid === native.uid), false);
  assert.equal(catalog.rolePool.sidekick.some(item => item.ref.nativeUid === native.uid), true);

  const cold = managerFor(structuredClone(holder.config), []).manager.state();
  const coldRow = cold.roleLists.sidekick.find(item => item.ref.nativeUid === native.uid);
  assert.equal(coldRow.selected, false, 'an unobserved native model is not reported as selected');
  assert.equal(coldRow.explicitIncluded, true);
  assert.equal(coldRow.available, false);
  const warm = managerFor(holder.config, [native]).manager.state();
  const warmRow = warm.roleLists.sidekick.find(item => item.ref.nativeUid === native.uid);
  assert.equal(warmRow.available, true);
  assert.equal(warmRow.selected, true);
});

test('a disabled provider or model is never selected and never pooled', () => {
  const off = config();
  off.providers[0].models[0].enabled = false;
  const roles = buildRoleLists(off, []);
  const row = roles.lead.find(item => item.ref.model === 'a');
  assert.equal(row.available, false);
  assert.equal(row.selected, false);
  const catalog = buildCatalog(off, []);
  assert.equal(catalog.rolePool.lead.some(item => item.ref.model === 'a'), false);
  assert.equal(catalog.rolePool.sidekick.some(item => item.ref.model === 'a'), false);
  const providerOff = config();
  providerOff.providers[0].enabled = false;
  const disabled = buildCatalog(providerOff, []);
  assert.equal(disabled.rolePool.lead.length, 0);
  assert.equal(disabled.rolePool.sidekick.length, 0);
});

test('deleting a provider prunes its role references instead of stranding them', async () => {
  const { manager, holder } = managerFor(config(), []);
  await manager.dispatch('setRoleModel', { role: 'lead', model: ref('a'), enabled: false });
  assert.deepEqual(holder.config.roleExclusions, { lead: [{ providerId: 'p', model: 'a' }] });
  // A switchless "not in the available list" row would stick around forever, so
  // a reference whose model is gone for good is dropped with the provider.
  await manager.dispatch('deleteProvider', { id: 'p' });
  assert.equal(Object.hasOwn(holder.config, 'roleExclusions'), false);
  const third = managerFor({ ...config(), roleInclusions: { lead: [ref('a')] } }, []).manager;
  await third.dispatch('setAutoContinue', { enabled: true });
  await third.dispatch('deleteProvider', { id: 'p' });
  assert.equal(Object.hasOwn(holder.config, 'roleInclusions'), false);
});

test('native role references are never pruned when the catalog is merely cold', async () => {
  const native = { uid: 'optin-native', label: 'OptIn', disabled: false, isModelRouter: false, harnessUids: ['h'] };
  const input = { ...config(), roleInclusions: { lead: [{ nativeUid: native.uid }] } };
  const { manager, holder } = managerFor(input, [native]);
  await manager.dispatch('setAutoContinue', { enabled: true });
  assert.deepEqual(holder.config.roleInclusions.lead, [{ nativeUid: native.uid }], 'an observation gap is not a deletion');
});

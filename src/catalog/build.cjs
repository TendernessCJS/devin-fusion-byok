'use strict';
const { BACKEND_URL } = require('../runtime/port.cjs');
const { modelEfforts, modelSupportsImages } = require('../models/capabilities.cjs');
const { positive, slug, digest, ownUid, has, refKey, nativeUid, effortMetadata, leadFamilyBase, stableOrders, groupedOrders } = require('./identity.cjs');
const { configFor } = require('./codec.cjs');
const { discoverOfficialRoles, discoverAdditionalNativeRoles, buildRoleLists } = require('./roles.cjs');

function buildCatalog(config = {}, nativeModels = [], allowedUids = null, analysis = null) {
  if (config.enabled === false) {
    return { models: [], routes: {}, fusions: {}, sidekicks: [], hiddenNativeModelUids: [], hiddenFusionUids: [] };
  }
  const models = [], routes = {}, fusions = {}, leads = [];
  // The fallback must never point at the hosted API: this value becomes the
  // inference address of every BYOK/combination entry, so pointing it at
  // Codeium means every BYOK request silently 404s. The local runtime is the
  // only correct default.
  const inferenceServerUrl = config.inferenceServerUrl || BACKEND_URL;
  const inferenceUrl = new URL(inferenceServerUrl);
  if (!['http:', 'https:'].includes(inferenceUrl.protocol) || inferenceUrl.username || inferenceUrl.password) {
    throw new Error('Invalid inference server URL');
  }
  const providers = Array.isArray(config.providers) ? config.providers.filter(provider => provider && provider.enabled !== false) : [];
  // Provider block ranks drive grouped dimension orders below. Rank the
  // UNFILTERED provider list by display name — never by config position and
  // never by the enabled filter — so toggling a provider or reordering config
  // cannot reshuffle orders that caches and the picker already saw.
  const providerRanks = new Map();
  (Array.isArray(config.providers) ? config.providers : [])
    .filter(provider => provider && typeof provider.id === 'string' && provider.id)
    .map(provider => ({ provider, key: [String(provider.name || provider.id).toLowerCase(), String(provider.name || provider.id), provider.id] }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .forEach(({ provider }, rank) => providerRanks.set(provider.id, rank));
  const identities = new Set();
  for (const provider of providers) {
    if (typeof provider.id !== 'string' || !provider.id) throw new Error('Provider id is required');
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      if (!model || model.enabled === false) continue;
      if (typeof model.id !== 'string' || !model.id) throw new Error('Model id is required');
      const key = JSON.stringify([provider.id, model.id]);
      if (identities.has(key)) throw new Error('Duplicate provider/model identity');
      identities.add(key);
      const prefix = provider.name || provider.id, sourceLabel = model.label || model.id;
      const familyLabel = sourceLabel.startsWith(prefix + ' · ') ? sourceLabel : `${prefix} · ${sourceLabel}`;
      const efforts = modelEfforts(model);
      for (const effort of efforts) {
        if (effort !== null && (typeof effort !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(effort))) throw new Error('Invalid effort value');
        const uid = `dfbyok-${slug(provider.id)}-${slug(model.id)}-${digest([provider.id, model.id, effort]).slice(0, 16)}`;
        const contextWindow = positive(model.contextWindow, 272000);
        const maxOutputTokens = Math.min(positive(model.maxOutputTokens, 131072), contextWindow);
        const lead = { uid, key, familyLabel, providerId: provider.id, model: model.id, effort,
          contextWindow, maxOutputTokens, supportsImages: modelSupportsImages(model), inferenceServerUrl };
        leads.push(lead);
        routes[uid] = { uid, providerId: provider.id, model: model.id, effort, maxOutputTokens };
      }
    }
  }
  const hiddenNativeModelUids = [];
  for (const uid of Array.isArray(config.hiddenNativeModelUids) ? config.hiddenNativeModelUids : []) {
    if (typeof uid !== 'string' || !uid || uid.length > 256 || ownUid(uid) || hiddenNativeModelUids.includes(uid)) continue;
    hiddenNativeModelUids.push(uid);
  }
  const hiddenSet = new Set(hiddenNativeModelUids);
  const officialRoles = analysis ? analysis.catalog.officialRoles : discoverOfficialRoles(nativeModels, hiddenSet, config);
  const { eligibleNativeLeads: additionalNativeLeads, eligibleNativeSidekicks: additionalNativeSidekicks } = analysis
    ? analysis.catalog.additionalRoles : discoverAdditionalNativeRoles(nativeModels, hiddenSet, officialRoles);
  const { eligibleNativeLeads, eligibleNativeSidekicks, hiddenFusionUids } = officialRoles;

  // Labels also identify entries in native sort groups. Disambiguate providers
  // with equal display names without changing stable routing identities.
  const familyKeys = new Map();
  for (const lead of leads) {
    if (!familyKeys.has(lead.familyLabel)) familyKeys.set(lead.familyLabel, new Set());
    familyKeys.get(lead.familyLabel).add(lead.key);
  }
  for (const lead of leads) if (familyKeys.get(lead.familyLabel).size > 1) lead.familyLabel += ` (${lead.providerId}/${lead.model})`;
  // Labels also index native sort groups (Map<label, uid>), and the effort
  // suffix is appended after the family label, so families can still collide
  // on the final label ("Foo" + High vs "Foo High" + none) — or on the family
  // name itself, since a hand-written label may match the generated
  // `(providerId/model)` suffix. Renaming must be family-level: variants of a
  // family share one Lead-dimension value, so splitting a colliding family
  // would strand the other variants. Uids and routes stay untouched, and the
  // outcome only depends on `key`, never on config order.
  const finalLabel = lead => lead.familyLabel + (lead.effort ? ` ${effortMetadata(lead.effort).name}` : '');
  const familiesByKey = new Map();
  for (const lead of leads) {
    const list = familiesByKey.get(lead.key) || [];
    list.push(lead);
    familiesByKey.set(lead.key, list);
  }
  const families = [...familiesByKey.entries()].map(([key, members]) => ({ key, leads: members }));
  // A label claimed by two families — whether as a family name or a variant's
  // final label — marks both families for renaming.
  const owners = new Map();
  const claim = (label, family) => {
    let set = owners.get(label);
    if (!set) owners.set(label, set = new Set());
    set.add(family);
  };
  for (const family of families) {
    claim(family.leads[0].familyLabel, family);
    for (const lead of family.leads) claim(finalLabel(lead), family);
  }
  const affected = new Set();
  for (const set of owners.values()) if (set.size > 1) for (const family of set) affected.add(family);
  const reserved = new Set();
  for (const family of families) {
    if (affected.has(family)) continue;
    reserved.add(family.leads[0].familyLabel);
    for (const lead of family.leads) reserved.add(finalLabel(lead));
  }
  for (const family of [...affected].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) {
    const identity = digest(family.key).slice(0, 8);
    let suffix = identity, candidate;
    for (let counter = 1; ; counter++) {
      candidate = `${family.leads[0].familyLabel} (${suffix})`;
      const free = !reserved.has(candidate) &&
        family.leads.every(lead => !reserved.has(candidate + (lead.effort ? ` ${effortMetadata(lead.effort).name}` : '')));
      if (free) break;
      suffix = `${identity}-${counter + 1}`;
    }
    for (const lead of family.leads) lead.familyLabel = candidate;
    reserved.add(candidate);
    for (const lead of family.leads) reserved.add(finalLabel(lead));
  }
  for (const lead of leads) {
    const effort = effortMetadata(lead.effort);
    models.push(configFor({ ...lead, label: lead.familyLabel + (lead.effort ? ` ${effort.name}` : ''),
      familyUid: 'dfbyok-family-' + digest(lead.key).slice(0, 16),
      family: { modelFamilyLabel: lead.familyLabel, entries: [{ key: 'Effort', value: effort }] } }));
  }

  const roleSelection = buildRoleLists(config, nativeModels, allowedUids, analysis);
  const selectedLeadKeys = new Set(roleSelection.lead.filter(item => item.selected).map(item => refKey(item.ref)));
  const selectedSidekickKeys = new Set(roleSelection.sidekick.filter(item => item.selected).map(item => refKey(item.ref)));

  const selectedImportedLeads = leads.filter(lead => selectedLeadKeys.has(refKey({ providerId: lead.providerId, model: lead.model })));
  // Lead role items group official uids into effort families; expand every
  // selected family's member uids so the whole series emits combinations.
  // Fast leads are never emitted: our matrix entries cannot carry the Fast
  // Mode order the official Fast variants carry (declaring one would add a
  // third Fast Mode option), so an emitted fast lead would duplicate its
  // non-fast twin dimension for dimension. `staleFusionUids`/`resolveAssignment`
  // also treat a fast lead uid as illegitimate — not emitting keeps all three
  // in step. Which uids are fast is read from the observed Fast Mode dimension
  // rather than a uid suffix: the upstream catalog marks the same concept as
  // `-fast` on Claude models and `-priority` on the GPT ones. Sidekicks are
  // untouched: the official Sidekick dimension has no sub-tiers, so a fast
  // sidekick uid is a legitimate value of its own.
  const fastLeadUids = new Set();
  for (const entry of Array.isArray(nativeModels) ? nativeModels : []) {
    const uid = typeof entry?.uid === 'string' ? entry.uid : '';
    if (!uid || uid.startsWith('fusion-') || ownUid(uid)) continue;
    if ((Array.isArray(entry.fusionMetadata) ? entry.fusionMetadata : [])
      .some(dim => dim?.key === 'Fast Mode' && dim.order !== 0)) fastLeadUids.add(uid);
  }
  const selectedNativeLeadUids = new Set(), selectedNativeSidekickUids = new Set();
  for (const [role, items, set] of [['lead', roleSelection.lead, selectedNativeLeadUids], ['sidekick', roleSelection.sidekick, selectedNativeSidekickUids]]) {
    for (const item of items) {
      if (!item.selected || !item.native) continue;
      for (const uid of item.memberUids || [item.ref.nativeUid]) {
        if (role === 'lead' && fastLeadUids.has(uid)) continue;
        set.add(uid);
      }
    }
  }
  const selectedAdditionalNativeLeads = [...additionalNativeLeads.values()].filter(native => selectedNativeLeadUids.has(native.uid));
  const selectedAdditionalNativeSidekicks = [...additionalNativeSidekicks.values()].filter(native => selectedNativeSidekickUids.has(native.uid));

  const sidekicks = [], seenSidekicks = new Set();
  const leadFamilies = new Map();
  for (const lead of leads) {
    if (!leadFamilies.has(lead.key)) leadFamilies.set(lead.key, []);
    leadFamilies.get(lead.key).push(lead);
  }
  for (const [key, candidates] of leadFamilies) {
    // Official Sidekick values are variant-level (the effort is baked into the
    // value's name, e.g. "Claude Sonnet 5.5 Medium"), so a selected BYOK family
    // emits every variant — the sidekick's effort becomes a real choice instead
    // of silently resolving to the provider default.
    const ref = { providerId: candidates[0]?.providerId, model: candidates[0]?.model };
    if (!selectedSidekickKeys.has(refKey(ref))) continue;
    for (const lead of candidates) {
      if (seenSidekicks.has(lead.uid)) continue;
      seenSidekicks.add(lead.uid);
      sidekicks.push({ uid: lead.uid, native: false, providerId: lead.providerId, model: lead.model,
        label: lead.familyLabel + (lead.effort ? ` ${effortMetadata(lead.effort).name}` : '') });
    }
  }
  for (const native of [...eligibleNativeSidekicks.values()].sort((a, b) => a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0)) {
    const ref = { nativeUid: native.uid };
    if (!seenSidekicks.has(native.uid) && selectedSidekickKeys.has(refKey(ref))) {
      seenSidekicks.add(native.uid);
      sidekicks.push({ uid: native.uid, label: native.label, native: true, harnessUids: native.harnessUids, dimension: native.dimension });
    }
  }

  const importedCandidate = lead => ({ ...lead, native: false,
    ref: { providerId: lead.providerId, model: lead.model, effort: lead.effort },
    label: lead.familyLabel + (lead.effort ? ` · ${effortMetadata(lead.effort).name}` : ' · 默认档位') });
  const candidates = {
    lead: [...selectedImportedLeads.map(importedCandidate), ...selectedAdditionalNativeLeads.map(native => ({
      ...native, native: true, ref: { nativeUid: native.uid },
      contextWindow: positive(native.maxTokens, 272000),
      maxOutputTokens: Math.min(positive(native.maxOutputTokens, 16384), positive(native.maxTokens, 272000)),
      inferenceServerUrl,
    }))],
    sidekick: [...leads.filter(lead => selectedSidekickKeys.has(refKey({ providerId: lead.providerId, model: lead.model }))).map(importedCandidate),
      ...selectedAdditionalNativeSidekicks.map(native => ({ ...native, native: true, ref: { nativeUid: native.uid } }))],
  };
  // Mirror our members into the official Fusion family card: official-shaped
  // `fusion-<lead>-sidekick-<side>` uids with self-declared dimension values
  // make BYOK models selectable in the native Lead/Effort/Sidekick dropdowns.
  // The picker derives each dimension's choices from entries sharing the Lead
  // value, so every lead needs the full cross product of sidekicks (and its own
  // effort variants) or the dropdown locks to a single value. Native members
  // reuse the official dimension identity (name+order) when observed, so our
  // values merge into the official options instead of duplicating them.
  // Entries colliding with an official fusion uid are skipped — the official
  // catalog already covers them and a duplicate would shadow the official entry.
  const matrixUids = new Set(), matrixModels = [];
  // Native uids can be eligible in both roles; keep role-specific harnesses
  // separate so a uid used as sidekick never inherits the fusion lead harness.
  const nativeHarnessUids = new Map(), nativeLeadHarnessUids = new Map();
  for (const native of [...eligibleNativeSidekicks.values(), ...additionalNativeSidekicks.values()]) {
    if (!nativeHarnessUids.has(native.uid)) nativeHarnessUids.set(native.uid, native.harnessUids);
  }
  for (const native of [...eligibleNativeLeads.values(), ...additionalNativeLeads.values()]) {
    if (!nativeLeadHarnessUids.has(native.uid)) nativeLeadHarnessUids.set(native.uid, native.leadHarnessUids || native.harnessUids);
  }
  const officialFusionUids = new Set();
  for (const entry of Array.isArray(nativeModels) ? nativeModels : []) {
    const observedUid = typeof entry?.uid === 'string' ? entry.uid : '';
    if (observedUid.startsWith('fusion-') && !observedUid.includes('dfbyok')) officialFusionUids.add(observedUid);
  }
  const sidekickPools = new Map();
  for (const item of candidates.sidekick) {
    const key = item.native ? `native${item.uid}` : item.key;
    if (!sidekickPools.has(key)) sidekickPools.set(key, []);
    sidekickPools.get(key).push(item);
  }
  // Native pools are single-member (one uid per key); BYOK pools hold every
  // effort variant of the family and all of them become selectable values.
  const sidekickReps = [...sidekickPools.values()].flatMap(variants =>
    variants[0].native ? [variants[0]] : variants);
  const pairs = [], customLeadSlots = new Map(), customSideSlots = new Map();
  for (const lead of candidates.lead) {
    for (const sidekick of sidekickReps) {
      // Only emit pairs with at least one added member (a BYOK model or a
      // native model outside the official dimension list): official lead ×
      // official sidekick stays the native catalog's authority — emitting
      // combinations it does not offer would invent unsupported pairs.
      if (lead.native && lead.leadDimension && sidekick.native && sidekick.dimension) continue;
      // Official combinations never pair a model with itself: the observed
      // grid leaves every same-family tuple empty (Sonnet 5.5 leads lack a
      // Sonnet 5.5 sidekick; GPT-5.6 Sol lacks GPT-5.6 Sol High). Match at
      // family level — same provider/model key for BYOK, same uid family
      // base for natives — so cross-effort self-pairs are filtered too.
      if (lead.native === sidekick.native &&
          (lead.native ? leadFamilyBase(lead.uid) === leadFamilyBase(sidekick.uid)
                       : lead.key === sidekick.key)) continue;
      const uid = `fusion-${lead.uid}-sidekick-${sidekick.uid}`;
      if (matrixUids.has(uid) || officialFusionUids.has(uid)) continue;
      const leadDim = lead.native ? (lead.leadDimension ? lead.leadDimension.name : lead.leadBaseLabel || lead.label)
        : lead.familyLabel;
      const sideDim = sidekick.native && sidekick.dimension ? sidekick.dimension.name
        : sidekick.native ? sidekick.label
        : sidekick.familyLabel + (sidekick.effort ? ` ${effortMetadata(sidekick.effort).name}` : '');
      if (!(lead.native && lead.leadDimension)) customLeadSlots.set(leadDim, { providerId: lead.native ? '' : lead.providerId });
      if (!(sidekick.native && sidekick.dimension)) {
        customSideSlots.set(sideDim, {
          base: sidekick.native ? `native:${sidekick.uid}` : `byok:${sidekick.key}`,
          slot: effortMetadata(sidekick.effort).order,
          providerId: sidekick.native ? '' : sidekick.providerId,
          model: sidekick.native ? '' : sidekick.familyLabel,
        });
      }
      pairs.push({ lead, sidekick, leadDim, sideDim, uid });
    }
  }
  // Custom dimension values take orders well above the official range. BYOK
  // values group per provider (blocks ranked by provider NAME, never config
  // position) and sort inside the block; native values keep hash orders, and
  // each mechanism passes the other's assigned orders as reserved so the two
  // never collide. Sequential orders would shift whenever the selected set
  // changes, and stale entries kept in the CLI cache carry their old order —
  // two different names landing on the same order make the picker drop one
  // silently (it dedupes dimension values by order). A per-name hash offset
  // inside each slot keeps cross-generation collisions a coincidence instead
  // of a certainty. Native sidekick values additionally take consecutive
  // slots inside a FAMILY (sorted by effort tier), so a model's variants stay
  // adjacent in the dropdown instead of scattering.
  const leadGroups = [], customNativeLeads = [];
  for (const [name, v] of customLeadSlots) {
    const rank = providerRanks.get(v.providerId);
    if (rank === undefined) { customNativeLeads.push(name); continue; }
    (leadGroups[rank] || (leadGroups[rank] = [])).push(name);
  }
  leadGroups.forEach(names => names.sort());
  const leadOrders = groupedOrders(leadGroups, roleSelection.reservedLeadOrders);
  for (const [name, order] of stableOrders(customNativeLeads, [...roleSelection.reservedLeadOrders, ...leadOrders.values()]))
    leadOrders.set(name, order);
  const sideByokGroups = [], sideGroups = new Map();
  for (const [name, v] of customSideSlots) {
    const rank = providerRanks.get(v.providerId);
    if (rank === undefined) {
      if (!sideGroups.has(v.base)) sideGroups.set(v.base, []);
      sideGroups.get(v.base).push({ name, slot: v.slot });
      continue;
    }
    (sideByokGroups[rank] || (sideByokGroups[rank] = [])).push({ name, model: v.model, slot: v.slot });
  }
  sideByokGroups.forEach(entries => entries.sort((a, b) => a.model < b.model ? -1 : a.model > b.model ? 1
    : a.slot - b.slot || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
  const sideOrders = new Map(), usedSideOrders = new Set(roleSelection.reservedSidekickOrders);
  const sideByokNames = sideByokGroups.map(entries => entries.map(entry => entry.name));
  for (const [name, order] of groupedOrders(sideByokNames, usedSideOrders)) {
    usedSideOrders.add(order);
    sideOrders.set(name, order);
  }
  const sideBaseOrders = stableOrders([...sideGroups.keys()], usedSideOrders);
  for (const [base, group] of sideGroups) {
    group.sort((a, b) => a.slot - b.slot || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let order = sideBaseOrders.get(base);
    for (const { name } of group) {
      while (usedSideOrders.has(order)) order++;
      usedSideOrders.add(order);
      sideOrders.set(name, order);
    }
  }
  for (const { lead, sidekick, leadDim, sideDim, uid } of pairs) {
    matrixUids.add(uid);
    const leadLabel = lead.native ? lead.label
      : lead.familyLabel + (lead.effort ? ` ${effortMetadata(lead.effort).name}` : '');
    const label = `Fusion (${leadLabel} + ${sideDim})`;
    const leadOrder = lead.native && lead.leadDimension ? lead.leadDimension.order : leadOrders.get(leadDim);
    const effort = lead.native ? lead.effortDimension || null
      : lead.effort ? effortMetadata(lead.effort) : null;
    const sideOrder = sidekick.native && sidekick.dimension ? sidekick.dimension.order : sideOrders.get(sideDim);
    fusions[uid] = { uid, label, leadUid: lead.uid, sidekickUid: sidekick.uid,
      leadNative: lead.native, sidekickNative: sidekick.native,
      ...(lead.native ? { leadHarnessUids: lead.leadHarnessUids } : {}),
      ...(sidekick.native ? { sidekickHarnessUids: sidekick.harnessUids } : {}) };
    matrixModels.push(configFor({ ...lead, uid, label,
      inferenceServerUrl,
      // The combination runs the Lead on its own execution channel:
      // ['fusion', ...lead harnesses] for a native lead, the bare ['fusion']
      // router for a BYOK lead — the same rule resolveAssignment applies.
      // The sidekick is resolved by its own router, so no sidekick harness
      // ever lands on a combination entry.
      harnessUids: lead.native && Array.isArray(lead.leadHarnessUids) && lead.leadHarnessUids.length
        ? lead.leadHarnessUids : ['fusion'],
      family: { modelFamilyLabel: 'Fusion', entries: [
        { key: 'Lead', value: { order: leadOrder, name: leadDim, controlType: 3 } },
        ...(effort ? [{ key: 'Effort', value: { order: effort.order, name: effort.name, controlType: 1 } }] : []),
        { key: 'Sidekick', value: { order: sideOrder, name: sideDim, controlType: 3 } },
        // Official shape for the two informational dimensions: no order (they
        // are not selectable), a controlType only on Fast Mode, and a name only
        // on Recommended Sidekick. Our entries then merge into the official
        // values instead of inventing extra buckets.
        { key: 'Fast Mode', value: { controlType: 2 } },
        { key: 'Recommended Sidekick', value: { name: sideDim } },
      ] }, familyUid: 'fusion', fusion: true, kind: 'matrix' }));
  }
  // Matrix entries lead the list, matching the order the picker saw before the
  // named-preset pipeline was retired.
  return { models: [...matrixModels, ...models], routes, fusions, sidekicks, hiddenNativeModelUids, hiddenFusionUids, matrixUids, nativeHarnessUids, nativeLeadHarnessUids,
    rolePool: Object.fromEntries(Object.entries(candidates).map(([role, items]) => [role, items.map(item => ({ ref: item.ref, label: item.label, uid: item.uid }))])),
    lastFusionSelection: typeof config.lastFusionSelection === 'string' ? config.lastFusionSelection : undefined };
}

// Which surface an entry was observed through decides whether it can appear in
// a model picker at all: the configs RPCs are selectable catalogs, user_status
// is the account entitlement list (a superset containing legacy/internal rows).
module.exports = { buildCatalog };

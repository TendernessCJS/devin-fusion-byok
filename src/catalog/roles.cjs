'use strict';
const { ownUid, has, refKey, nativeUid, leadFamilyBase, leadFamilyTier, NATIVE_EFFORT_NAMES, stableOrders, leadFamilyLabel, normalizeAllowedUids, expandHiddenByFamily } = require('./identity.cjs');

function discoverOfficialRoles(nativeModels, hiddenSet, config = {}, allowed = null) {
  const observed = Array.isArray(nativeModels) ? nativeModels : [];
  const observedUids = new Set();
  const nativeModelsMap = new Map();
  for (const entry of observed) {
    const uid = typeof entry?.uid === 'string' ? entry.uid : '';
    if (uid && uid.length <= 256 && !ownUid(uid) && !uid.startsWith('fusion-')) {
      observedUids.add(uid);
      nativeModelsMap.set(uid, entry);
    }
  }

  const reservedOrders = new Set(), reservedLeadOrders = new Set();
  const leadNamesByOrder = new Map(), leadClaimsByTuple = new Map();
  const sidekickClaimsByUid = new Map(), sidekickClaimsByOrder = new Map();
  const officialCombos = [];

  for (const entry of observed) {
    const uid = typeof entry?.uid === 'string' ? entry.uid : '';
    if (!uid.startsWith('fusion-') || ownUid(uid)) continue;
    const marker = uid.lastIndexOf('-sidekick-');
    if (marker < 0 || marker <= 'fusion-'.length) continue;

    const fusionMeta = Array.isArray(entry.fusionMetadata) ? entry.fusionMetadata : null;
    let leadDim = fusionMeta?.find(d => d.key === 'Lead');
    let effortDim = fusionMeta?.find(d => d.key === 'Effort');
    let sidekickDim = fusionMeta?.find(d => d.key === 'Sidekick');
    let fastModeDim = fusionMeta?.find(d => d.key === 'Fast Mode');

    if (!sidekickDim && entry.sidekickDimension) {
      sidekickDim = { order: entry.sidekickDimension.order, name: entry.sidekickDimension.name, controlType: 3 };
      fastModeDim = { order: entry.sidekickDimension.fastModeOrder ?? 0 };
    }

    if (leadDim && Number.isSafeInteger(leadDim.order) && leadDim.order >= 0 && leadDim.order <= 0x7fffffff) {
      reservedLeadOrders.add(leadDim.order);
    }
    if (sidekickDim && Number.isSafeInteger(sidekickDim.order) &&
        sidekickDim.order >= 0 && sidekickDim.order <= 0x7fffffff) {
      reservedOrders.add(sidekickDim.order);
    }

    const leadCandidate = uid.slice('fusion-'.length, marker);
    const sideCandidate = uid.slice(marker + '-sidekick-'.length);
    const leadKnown = observedUids.has(leadCandidate);
    const sideKnown = observedUids.has(sideCandidate);

    officialCombos.push({
      entry, uid, leadCandidate, sideCandidate, leadKnown, sideKnown,
      disabled: entry.disabled === true,
      fastModeOrder: fastModeDim ? fastModeDim.order : 0,
      leadDim, effortDim, sidekickDim,
    });

    if (fastModeDim && fastModeDim.order !== 0) continue;
    if (entry.disabled !== false) continue;
    if (!Array.isArray(entry.harnessUids) || !entry.harnessUids.includes('fusion')) continue;

    const sideNative = sideKnown ? nativeModelsMap.get(sideCandidate) : null;
    if (sideKnown && sideNative.disabled === false && sideNative.isModelRouter === false && sideNative.harnessUids?.length && !hiddenSet.has(sideCandidate)
        && (!allowed || allowed.has(sideCandidate))) {
      if (sidekickDim && Number.isSafeInteger(sidekickDim.order) && sidekickDim.name) {
        if (!sidekickClaimsByUid.has(sideCandidate)) {
          sidekickClaimsByUid.set(sideCandidate, { orders: new Set(), names: new Set() });
        }
        const rec = sidekickClaimsByUid.get(sideCandidate);
        rec.orders.add(sidekickDim.order);
        rec.names.add(sidekickDim.name);
        if (!sidekickClaimsByOrder.has(sidekickDim.order)) sidekickClaimsByOrder.set(sidekickDim.order, new Set());
        sidekickClaimsByOrder.get(sidekickDim.order).add(sideCandidate);
      }
    }

    if (!leadKnown || !sideKnown) continue;
    const leadNative = nativeModelsMap.get(leadCandidate);
    // A Fusion lead runs under the harnesses its combination entry declares
    // (['fusion'] plus the lead's own, degrading to bare ['fusion'] for a
    // harnessless lead), so the member's harnessUids only decide standalone
    // availability — declared leads with none (gpt-6-astra-*) still qualify.
    // The sidekick below keeps the harness requirement: a subagent runs on
    // its own harness.
    if (leadNative.disabled !== false || leadNative.isModelRouter !== false || hiddenSet.has(leadCandidate)
        || (allowed && !allowed.has(leadCandidate))) continue;
    if (sideNative.disabled !== false || sideNative.isModelRouter !== false || !sideNative.harnessUids?.length || hiddenSet.has(sideCandidate)
        || (allowed && !allowed.has(sideCandidate))) continue;

    if (leadDim && Number.isSafeInteger(leadDim.order) && leadDim.name &&
        effortDim && Number.isSafeInteger(effortDim.order) && effortDim.name) {
      if (!leadNamesByOrder.has(leadDim.order)) leadNamesByOrder.set(leadDim.order, new Set());
      leadNamesByOrder.get(leadDim.order).add(leadDim.name);

      if (!leadClaimsByTuple.has(leadCandidate)) {
        leadClaimsByTuple.set(leadCandidate, {
          leadOrder: leadDim.order, leadName: leadDim.name,
          effortOrder: effortDim.order, effortName: effortDim.name,
          harnesses: new Set(),
          tuples: new Set(),
        });
      }
      const rec = leadClaimsByTuple.get(leadCandidate);
      rec.tuples.add(leadDim.order + ':' + effortDim.order + ':' + leadDim.name + ':' + effortDim.name);
      rec.harnesses.add(JSON.stringify(entry.harnessUids));
    }
  }

  const inconsistentLeadOrders = new Set();
  for (const [order, names] of leadNamesByOrder) {
    if (names.size > 1) inconsistentLeadOrders.add(order);
  }

  const leadConflicts = new Set();
  const uidByTuple = new Map();
  for (const [uid, rec] of leadClaimsByTuple) {
    if (rec.tuples.size !== 1 || rec.harnesses.size !== 1 || inconsistentLeadOrders.has(rec.leadOrder)) {
      leadConflicts.add(uid);
      continue;
    }
    const tupleKey = rec.leadOrder + ':' + rec.effortOrder;
    if (uidByTuple.has(tupleKey)) {
      leadConflicts.add(uid);
      leadConflicts.add(uidByTuple.get(tupleKey));
    } else {
      uidByTuple.set(tupleKey, uid);
    }
  }

  const sidekickConflicts = new Set();
  for (const uids of sidekickClaimsByOrder.values()) if (uids.size > 1) for (const u of uids) sidekickConflicts.add(u);
  for (const [u, rec] of sidekickClaimsByUid) {
    if (rec.orders.size !== 1 || rec.names.size !== 1) sidekickConflicts.add(u);
  }

  const eligibleNativeLeads = new Map();
  for (const [uid, rec] of leadClaimsByTuple) {
    if (leadConflicts.has(uid)) continue;
    const native = nativeModelsMap.get(uid);
    const harnesses = JSON.parse([...rec.harnesses][0]);
    eligibleNativeLeads.set(uid, {
      uid, label: native.label || uid,
      leadDimension: { order: rec.leadOrder, name: rec.leadName, controlType: 3 },
      effortDimension: { order: rec.effortOrder, name: rec.effortName, controlType: 1 },
      leadHarnessUids: harnesses,
      maxTokens: native.maxTokens,
      maxOutputTokens: native.maxOutputTokens,
      supportsImages: native.supportsImages,
    });
  }

  const eligibleNativeSidekicks = new Map();
  for (const [uid, rec] of sidekickClaimsByUid) {
    if (sidekickConflicts.has(uid)) continue;
    const native = nativeModelsMap.get(uid);
    const sidekickOrder = [...rec.orders][0];
    const sidekickName = [...rec.names][0];
    eligibleNativeSidekicks.set(uid, {
      uid, label: sidekickName || native.label || uid,
      dimension: { order: sidekickOrder, name: sidekickName },
      harnessUids: native.harnessUids,
    });
  }

  const hiddenFusionUids = [];
  if (config.enabled !== false) {
    const leadExclusions = new Set((Array.isArray(config.roleExclusions?.lead) ? config.roleExclusions.lead : []).map(refKey));
    const sidekickExclusions = new Set((Array.isArray(config.roleExclusions?.sidekick) ? config.roleExclusions.sidekick : []).map(refKey));
    // Official leads group into effort families; an exclusion recorded on any
    // family member hides every official combo of the whole series.
    const leadFamilyByUid = new Map();
    for (const [uid, native] of eligibleNativeLeads) {
      const dim = native.leadDimension;
      const key = dim && Number.isSafeInteger(dim.order) ? `${dim.order}:${dim.name}` : `uid:${uid}`;
      let family = leadFamilyByUid.get(key);
      if (!family) leadFamilyByUid.set(key, family = []);
      family.push(uid);
    }
    for (const family of leadFamilyByUid.values()) {
      if (!family.some(uid => leadExclusions.has(refKey({ nativeUid: uid })))) continue;
      for (const uid of family) leadExclusions.add(refKey({ nativeUid: uid }));
    }
    for (const combo of officialCombos) {
      if (combo.disabled) {
        hiddenFusionUids.push(combo.uid);
        continue;
      }
      if (combo.leadDim && Number.isSafeInteger(combo.leadDim.order) &&
          combo.effortDim && Number.isSafeInteger(combo.effortDim.order)) {
        let leadExcluded = false;
        for (const [leadUid, native] of eligibleNativeLeads) {
          if (native.leadDimension && native.leadDimension.order === combo.leadDim.order &&
              native.effortDimension && native.effortDimension.order === combo.effortDim.order) {
            if (leadExclusions.has(refKey({ nativeUid: leadUid })) || hiddenSet.has(leadUid)) {
              leadExcluded = true; break;
            }
          }
        }
        if (leadExcluded) {
          hiddenFusionUids.push(combo.uid);
          continue;
        }
      }
      if (combo.sidekickDim && Number.isSafeInteger(combo.sidekickDim.order)) {
        let sideExcluded = false;
        for (const [sideUid, native] of eligibleNativeSidekicks) {
          if (native.dimension && native.dimension.order === combo.sidekickDim.order) {
            if (sidekickExclusions.has(refKey({ nativeUid: sideUid })) || hiddenSet.has(sideUid)) {
              sideExcluded = true; break;
            }
          }
        }
        if (sideExcluded) {
          hiddenFusionUids.push(combo.uid);
          continue;
        }
      }
      if (combo.leadKnown && combo.sideKnown) {
        const leadRef = refKey({ nativeUid: combo.leadCandidate });
        const sideRef = refKey({ nativeUid: combo.sideCandidate });
        const leadNative = nativeModelsMap.get(combo.leadCandidate);
        const sideNative = nativeModelsMap.get(combo.sideCandidate);
        const leadDisabled = leadNative?.disabled === true || leadNative?.isModelRouter === true || hiddenSet.has(combo.leadCandidate);
        const sideDisabled = sideNative?.disabled === true || sideNative?.isModelRouter === true || hiddenSet.has(combo.sideCandidate);
        if (leadDisabled || sideDisabled || leadExclusions.has(leadRef) || sidekickExclusions.has(sideRef)) {
          hiddenFusionUids.push(combo.uid);
          continue;
        }
      }
    }
  }

  return { eligibleNativeLeads, eligibleNativeSidekicks, reservedOrders, reservedLeadOrders, hiddenFusionUids };
}

// Everything observed that the strict official lists do not cover: any model
// with a usable harness is a candidate Lead or Sidekick, so the picker can be
// extended with official models the vendor's own Fusion card does not offer
// yet. Not preset-related despite its former name.
function discoverAdditionalNativeRoles(nativeModels, hiddenSet, officialRoles, allowed = null) {
  const records = new Map();
  const conflicts = new Set();
  for (const entry of Array.isArray(nativeModels) ? nativeModels : []) {
    const uid = typeof entry?.uid === 'string' ? entry.uid : '';
    if (!uid || uid.length > 256 || ownUid(uid) || uid.startsWith('fusion-') || hiddenSet.has(uid)
        || (allowed && !allowed.has(uid))) continue;
    const harnessUids = entry.harnessUids;
    const eligible = entry.disabled === false && entry.isModelRouter === false && Array.isArray(harnessUids) &&
      harnessUids.length > 0 && harnessUids.every(value => typeof value === 'string' && value.trim().length > 0);
    const record = { uid, label: typeof entry.label === 'string' && entry.label ? entry.label : uid,
      harnessUids: Array.isArray(harnessUids) ? [...harnessUids] : null, eligible,
      fusionMetadata: Array.isArray(entry.fusionMetadata) ? entry.fusionMetadata : undefined,
      maxTokens: entry.maxTokens, maxOutputTokens: entry.maxOutputTokens, supportsImages: entry.supportsImages === true };
    const prior = records.get(uid);
    if (prior && (prior.eligible !== record.eligible || JSON.stringify(prior.harnessUids) !== JSON.stringify(record.harnessUids) ||
      prior.label !== record.label)) conflicts.add(uid);
    else if (!prior) records.set(uid, record);
  }
  for (const uid of conflicts) records.delete(uid);
  const leads = new Map(), sidekicks = new Map();
  // Official families admit exactly two kinds of members: the officially
  // declared uids and their Fast Mode siblings (Fast Mode is an orthogonal
  // switch — same Lead, same Effort, Fast Mode != 0). Any other uid sharing
  // the family base (e.g. gpt-6-sol-none under gpt-6-sol) must not join: it
  // would invent an Effort value the official card does not offer.
  const officialLeadBases = new Map(), officialEffortOrders = new Map();
  for (const native of officialRoles.eligibleNativeLeads.values()) {
    const base = leadFamilyBase(native.uid);
    if (!officialLeadBases.has(base)) officialLeadBases.set(base, native.leadDimension);
    const eff = native.effortDimension;
    if (eff && Number.isSafeInteger(eff.order) && eff.name && !officialEffortOrders.has(eff.name)) {
      officialEffortOrders.set(eff.name, eff.order);
    }
  }
  for (const native of records.values()) {
    const officialLead = officialRoles.eligibleNativeLeads.get(native.uid);
    const officialSidekick = officialRoles.eligibleNativeSidekicks.get(native.uid);
    const baseUid = leadFamilyBase(native.uid);
    const officialDim = officialLeadBases.get(baseUid);
    const token = leadFamilyTier(native.uid);
    // Lead candidates: harnessed entries, officially declared leads, and
    // tier-token siblings of an official family — a Fusion lead runs under
    // the combination's harness (['fusion', ...its own harnesses], same rule
    // resolveAssignment emits), so the member's own harness still only
    // decides standalone availability. Sidekick candidates keep the harness
    // requirement: a subagent always runs on its own harness, and the
    // combination never declares it — sidekicks resolve through their router.
    const leadCandidate = native.eligible || officialLead || (officialDim && token);
    const sideCandidate = native.eligible || officialSidekick;
    if (!leadCandidate && !sideCandidate) continue;
    if (leadCandidate) {
      if (officialLead) {
        leads.set(native.uid, { ...officialLead, familyKey: `base:${baseUid}` });
      } else {
        // Every native lead groups by the uid's family base. Members emit the
        // family label as their shared Lead name, so one selected row offers
        // the whole series — a tier token or the observed Effort dimension
        // supplies each member's own Effort value.
        const record = { ...native, leadHarnessUids: [...new Set(['fusion', ...(native.harnessUids || [])])] };
        const eff = (Array.isArray(native.fusionMetadata) ? native.fusionMetadata : [])
          .find(dim => dim?.key === 'Effort' && Number.isSafeInteger(dim.order) && typeof dim.name === 'string' && dim.name);
        // The Effort name comes from the uid token (else the observed Effort
        // name); the order always comes from the official Effort space, with a
        // reserved-collision-free hash order for names the official card lacks
        // — an observed order lives in another space (GLM High=1 vs official
        // High=3) and would split same-named values in the picker.
        const effortName = token ? NATIVE_EFFORT_NAMES[token] : (eff ? eff.name : '');
        if (effortName) {
          let effortOrder = officialEffortOrders.get(effortName);
          if (!Number.isSafeInteger(effortOrder)) {
            effortOrder = stableOrders(new Set([effortName]), new Set(officialEffortOrders.values())).get(effortName);
          }
          record.effortDimension = { order: effortOrder, name: effortName, controlType: 1 };
        }
        // An official family admits any member whose uid carries a tier token —
        // officially declared uids, Fast siblings (-fast/-priority) and extra
        // tiers the card never declared (-none). A tokenless outsider cannot be
        // slotted into an Effort value and stays a single-member row.
        if (officialDim && token) {
          record.leadDimension = officialDim;
          record.familyKey = `base:${baseUid}`;
        } else {
          record.familyKey = officialDim ? `uid:${native.uid}` : `base:${baseUid}`;
        }
        record.leadBaseLabel = leadFamilyLabel(native.label);
        record.familyLabelBase = record.leadBaseLabel;
        leads.set(native.uid, record);
      }
    }
    if (sideCandidate) sidekicks.set(native.uid, officialSidekick || { ...native, dimension: undefined });
  }
  return { eligibleNativeLeads: leads, eligibleNativeSidekicks: sidekicks };
}

function roleRefs(config = {}, role) {
  const exclusions = new Set((Array.isArray(config.roleExclusions?.[role]) ? config.roleExclusions[role] : []).map(refKey).filter(Boolean));
  const inclusions = new Set((Array.isArray(config.roleInclusions?.[role]) ? config.roleInclusions[role] : []).map(refKey).filter(Boolean));
  return { exclusions, inclusions };
}

function roleSelected(ref, refs, defaultSelected) {
  const key = refKey(ref);
  if (!key || refs.exclusions.has(key)) return false;
  return defaultSelected || refs.inclusions.has(key);
}

// One pure pass over the observation both catalog builders share. It keeps the
// two hidden-uid semantics the callers use side by side — the catalog reads the
// direct blacklist while the role list works with the family-expanded one — and
// caches each builder's official/additional role discovery separately, because
// the two sets produce different eligibility results. No module-level state:
// each call recomputes from its arguments and callers reuse the object only
// within one operation.
function analyzeRoles(config = {}, nativeModels = [], allowedUids = null) {
  const allowed = normalizeAllowedUids(allowedUids);
  const hidden = new Set(Array.isArray(config.hiddenNativeModelUids) ? config.hiddenNativeModelUids : []);
  const hiddenExpanded = expandHiddenByFamily(hidden, nativeModels, entry => entry && entry.uid, entry => (entry && entry.familyUid) || '');
  const catalogOfficialRoles = discoverOfficialRoles(nativeModels, hidden, config);
  const catalogAdditional = discoverAdditionalNativeRoles(nativeModels, hidden, catalogOfficialRoles);
  const roleOfficialRoles = discoverOfficialRoles(nativeModels, hiddenExpanded, config, allowed);
  const roleAdditional = discoverAdditionalNativeRoles(nativeModels, hiddenExpanded, roleOfficialRoles, allowed);
  return {
    allowed, hidden, hiddenExpanded,
    catalog: { officialRoles: catalogOfficialRoles, additionalRoles: catalogAdditional },
    roleList: { officialRoles: roleOfficialRoles, additionalRoles: roleAdditional },
  };
}

function buildRoleLists(config = {}, nativeModels = [], allowedUids = null, analysis = null) {
  const allowed = analysis ? analysis.allowed : normalizeAllowedUids(allowedUids);
  const hiddenSet = analysis ? analysis.hiddenExpanded : expandHiddenByFamily(
    new Set(Array.isArray(config.hiddenNativeModelUids) ? config.hiddenNativeModelUids : []),
    nativeModels, entry => entry && entry.uid, entry => (entry && entry.familyUid) || '');
  const officialRoles = analysis ? analysis.roleList.officialRoles : discoverOfficialRoles(nativeModels, hiddenSet, config, allowed);
  const { eligibleNativeLeads, eligibleNativeSidekicks } = analysis ? analysis.roleList.additionalRoles
    : discoverAdditionalNativeRoles(nativeModels, hiddenSet, officialRoles, allowed);
  const strictSidekickUids = new Set(officialRoles.eligibleNativeSidekicks.keys());
  const leadRefs = roleRefs(config, 'lead');
  const sidekickRefs = roleRefs(config, 'sidekick');

  const providers = Array.isArray(config.providers) ? config.providers : [];
  const leadList = [], sidekickList = [];
  const seenLeadKeys = new Set(), seenSidekickKeys = new Set();

  for (const provider of providers) {
    if (!provider || typeof provider.id !== 'string') continue;
    const providerEnabled = provider.enabled !== false;
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      if (!model || typeof model.id !== 'string') continue;
      const ref = { providerId: provider.id, model: model.id };
      const key = refKey(ref);
      const prefix = provider.name || provider.id, sourceLabel = model.label || model.id;
      const label = sourceLabel.startsWith(prefix + ' · ') ? sourceLabel : `${prefix} · ${sourceLabel}`;
      const available = providerEnabled && model.enabled !== false;
      const variantCount = Array.isArray(model.efforts) && model.efforts.length ? model.efforts.length : 1;

      if (!seenLeadKeys.has(key)) {
        seenLeadKeys.add(key);
        leadList.push({
          ref, label, native: false, variantCount,
          available, selected: available && roleSelected(ref, leadRefs, true),
          defaultSelected: available,
          ...(available ? {} : { disabled: true, reason: providerEnabled ? '已在模型列表中停用' : '供应商已停用' }),
        });
      }
      if (!seenSidekickKeys.has(key)) {
        seenSidekickKeys.add(key);
        sidekickList.push({
          ref, label, native: false, variantCount,
          available, selected: available && roleSelected(ref, sidekickRefs, true),
          defaultSelected: available,
          ...(available ? {} : { disabled: true, reason: providerEnabled ? '已在模型列表中停用' : '供应商已停用' }),
        });
      }
    }
  }

  // Leads are effort series: every native member groups by its uid's family
  // base — official families additionally admit their Fast Mode siblings and
  // keep the official dimension name. A family is excluded when any member
  // uid is excluded and selected when official or any member uid was
  // included/saved.
  const leadFamilies = new Map();
  for (const nativeLead of eligibleNativeLeads.values()) {
    const key = nativeLead.familyKey || `uid:${nativeLead.uid}`;
    let family = leadFamilies.get(key);
    if (!family) leadFamilies.set(key, family = { official: false, order: Infinity, members: [], label: '' });
    family.members.push(nativeLead);
    const dim = nativeLead.leadDimension;
    if (dim && Number.isSafeInteger(dim.order)) {
      family.official = true;
      family.order = dim.order;
      family.label = dim.name || nativeLead.uid;
    }
  }
  const orderedFamilies = [...leadFamilies.values()].map(family => {
    family.members.sort((a, b) => a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);
    family.uids = family.members.map(member => member.uid);
    if (!family.label) family.label = family.members[0].familyLabelBase || family.members[0].label || family.members[0].uid;
    return family;
  }).sort((a, b) => a.order - b.order || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  // Two different families must never share a label — a stripped label that
  // collides falls back to the member's own label, then to a uid suffix.
  const usedLeadLabels = new Set(leadList.map(item => item.label));
  for (const family of orderedFamilies) {
    if (usedLeadLabels.has(family.label)) {
      const ownLabel = family.members.length === 1 ? (family.members[0].label || '') : '';
      family.label = ownLabel && !usedLeadLabels.has(ownLabel) ? ownLabel : `${family.label} (${family.uids[0]})`;
    }
    usedLeadLabels.add(family.label);
    const repUid = family.uids[0];
    const ref = { nativeUid: repUid };
    const key = refKey(ref);
    const memberKeys = family.uids.map(uid => refKey({ nativeUid: uid }));
    for (const member of memberKeys) seenLeadKeys.add(member);
    // An exclusion on any member turns the family off entirely; an exclusion
    // also lifts the explicit-include pin, or a stale member inclusion would
    // keep a deselected family floating in the expanded list.
    const memberExcluded = memberKeys.some(member => leadRefs.exclusions.has(member));
    leadList.push({
      ref, label: family.label, native: true, ...(family.official ? { official: true } : {}),
      available: true, defaultSelected: family.official, memberUids: family.uids,
      selected: !memberExcluded &&
        (family.official || memberKeys.some(member => leadRefs.inclusions.has(member))),
      explicitIncluded: !memberExcluded &&
        memberKeys.some(member => leadRefs.inclusions.has(member)),
    });
  }

  for (const nativeSidekick of eligibleNativeSidekicks.values()) {
    const ref = { nativeUid: nativeSidekick.uid };
    const key = refKey(ref);
    seenSidekickKeys.add(key);
    const official = strictSidekickUids.has(nativeSidekick.uid);
    sidekickList.push({
      ref, label: nativeSidekick.label || nativeSidekick.uid, native: true,
      ...(official ? { official: true } : {}),
      available: true, selected: roleSelected(ref, sidekickRefs, official),
      defaultSelected: official, memberUids: [nativeSidekick.uid],
      explicitIncluded: !sidekickRefs.exclusions.has(key) &&
        sidekickRefs.inclusions.has(key),
    });
  }

  for (const ref of Array.isArray(config.roleExclusions?.lead) ? config.roleExclusions.lead : []) {
    const key = refKey(ref);
    if (!key || seenLeadKeys.has(key)) continue;
    seenLeadKeys.add(key);
    leadList.push({
      ref, label: ref.nativeUid || ((ref.providerId || '') + ' · ' + (ref.model || '')),
      native: !!ref.nativeUid, available: false, selected: false, defaultSelected: false,
      disabled: true, reason: '当前未在可用列表中',
    });
  }
  for (const ref of Array.isArray(config.roleExclusions?.sidekick) ? config.roleExclusions.sidekick : []) {
    const key = refKey(ref);
    if (!key || seenSidekickKeys.has(key)) continue;
    seenSidekickKeys.add(key);
    sidekickList.push({
      ref, label: ref.nativeUid || ((ref.providerId || '') + ' · ' + (ref.model || '')),
      native: !!ref.nativeUid, available: false, selected: false, defaultSelected: false,
      disabled: true, reason: '当前未在可用列表中',
    });
  }
  for (const ref of Array.isArray(config.roleInclusions?.lead) ? config.roleInclusions.lead : []) {
    const key = refKey(ref);
    if (!key || seenLeadKeys.has(key)) continue;
    seenLeadKeys.add(key);
    leadList.push({
      ref, label: ref.nativeUid || ((ref.providerId || '') + ' · ' + (ref.model || '')),
      native: !!ref.nativeUid, available: false, selected: false, defaultSelected: false, explicitIncluded: true,
      disabled: true, reason: '当前未在可用列表中',
    });
  }
  for (const ref of Array.isArray(config.roleInclusions?.sidekick) ? config.roleInclusions.sidekick : []) {
    const key = refKey(ref);
    if (!key || seenSidekickKeys.has(key)) continue;
    seenSidekickKeys.add(key);
    sidekickList.push({
      ref, label: ref.nativeUid || ((ref.providerId || '') + ' · ' + (ref.model || '')),
      native: !!ref.nativeUid, available: false, selected: false, defaultSelected: false, explicitIncluded: true,
      disabled: true, reason: '当前未在可用列表中',
    });
  }

  return { lead: leadList, sidekick: sidekickList,
    reservedLeadOrders: officialRoles.reservedLeadOrders, reservedSidekickOrders: officialRoles.reservedOrders };
}

/** Build a secret-free catalog. Provider credentials stay solely in caller configuration. */
module.exports = { analyzeRoles, discoverOfficialRoles, discoverAdditionalNativeRoles, roleRefs, roleSelected, buildRoleLists };

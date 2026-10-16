'use strict';

const crypto = require('node:crypto');
const { parseFields, fields, str, num, s, v, m } = require('./protocol/wire.cjs');
const { modelEfforts, modelSupportsImages } = require('./model-capabilities.cjs');

const OWN_GROUP = 'Devin Fusion BYOK';
const SIDEKICK_HARNESSES = ['swe-1p6', 'swe-1p5'];
const ownUid = uid => typeof uid === 'string' && /^(?:dfbyok-|fusion-dfbyok-)/.test(uid);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'model';
const concat = parts => Buffer.concat(parts);
const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647 ? value : fallback;
function refKey(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return '';
  const hasNative = typeof ref.nativeUid === 'string' && ref.nativeUid.length > 0 && ref.nativeUid.length <= 256 && !ownUid(ref.nativeUid);
  const hasProvider = typeof ref.providerId === 'string' && typeof ref.model === 'string' && ref.providerId.length > 0 && ref.model.length > 0;
  if (hasNative && !ref.providerId && !ref.model) return JSON.stringify(['native', ref.nativeUid]);
  if (hasProvider && !ref.nativeUid) return JSON.stringify(['provider', ref.providerId, ref.model]);
  return '';
}

function stableOrders(keys, reserved) {
  const result = new Map(), used = new Set(reserved || []);
  for (const key of [...new Set(keys)].sort()) {
    let order = 0x10000000 + (parseInt(digest(key).slice(0, 8), 16) % 0x10000000);
    while (used.has(order)) order = order === 0x1fffffff ? 0x10000000 : order + 1;
    result.set(key, order); used.add(order);
  }
  return result;
}

// A native uid ends with its effort tier slug, optionally followed by a fast
// marker (-fast / -priority); a scale qualifier (-1m) may sit after the tier.
// Everything before that is the family base, with the qualifier kept on it.
// Bare uids whose label carries a tier (`swe-1-7` is "SWE-1.7 Max") keep
// themselves as the base — the label, not the uid, decides the tier for them.
const NATIVE_EFFORT_SUFFIX = /-(none|minimal|low|medium|high|xhigh|max|ultra)(?:-fast|-priority)?$/;
function leadFamilyBase(uid) {
  const scale = /-(\d+m)$/.exec(uid);
  const head = scale ? uid.slice(0, -scale[0].length) : uid;
  const base = head.replace(NATIVE_EFFORT_SUFFIX, '') || head;
  return scale ? base + scale[0] : base;
}
function leadFamilyTier(uid) {
  const head = uid.replace(/-\d+m$/, '');
  return (head.match(NATIVE_EFFORT_SUFFIX) || [])[1] || '';
}

// Display names a uid tier token maps to. `none` is "No Thinking" on native
// models (glm-5-2-none, gpt-6-sol-none), distinct from the BYOK "None".
const NATIVE_EFFORT_NAMES = { none: 'No Thinking', minimal: 'Minimal', low: 'Low', medium: 'Medium',
  high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' };

// A family label is the member label with trailing effort/Fast/Thinking
// markers stripped; members of one family share that base.
const NATIVE_LABEL_SUFFIX = /(?:\s+(?:No Thinking|None|Minimal|Low|Medium|High|XHigh|Max|Ultra|Fast|Thinking))+$/;
function leadFamilyLabel(label) {
  const scale = /\s+(\d+M)$/i.exec(label || '');
  const head = scale ? label.slice(0, -scale[0].length) : label;
  const stripped = (typeof head === 'string' ? head : '').replace(NATIVE_LABEL_SUFFIX, '').trim();
  return (stripped || head || label) + (scale ? ' ' + scale[1] : '');
}

function effortMetadata(effort) {
  const names = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' };
  const orders = { none: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5, ultra: 6, minimal: 7 };
  const key = effort || 'none';
  return { order: orders[key] ?? 100 + parseInt(digest(key).slice(0, 6), 16), name: names[key] || key, controlType: 1 };
}

// A dimension value is encoded exactly as declared: an absent `order`/`name`/
// `controlType` stays absent on the wire. That matters for the two informational
// dimensions — the official card writes `Fast Mode` with only a controlType and
// `Recommended Sidekick` with only a name, and the picker dedupes dimension
// values by `order`, so writing an explicit 0 there puts our entries in a
// separate bucket and surfaces controls the official catalog never shows.
function encodeFamily(family) {
  return concat([s(1, family.modelFamilyLabel), ...family.entries.map(entry => m(2,
    concat([s(1, entry.key), m(2, concat([
      ...(entry.value.order === undefined ? [] : [v(1, entry.value.order)]),
      ...(entry.value.name === undefined ? [] : [s(2, entry.value.name)]),
      ...(entry.value.controlType === undefined ? [] : [v(3, entry.value.controlType)]),
    ]))])))]);
}

function encodeConfig(config) {
  const info = config.modelInfo;
  const features = info.modelFeatures;
  const infoRaw = concat([
    v(3, info.modelType), v(4, info.maxTokens),
    m(6, concat([v(8, 1), ...(features.supportsImages ? [v(11, 1)] : []), v(12, 1),
      ...(features.supportsThinking ? [v(15, 1)] : []), v(21, 1)])),
    v(13, info.maxOutputTokens), s(17, info.modelUid), s(18, info.inferenceServerUrl),
    ...info.harnessUids.map(uid => s(20, uid)),
    ...(info.displayOption ? [v(22, info.displayOption)] : []),
    s(23, info.modelFamilyUid), ...(info.isModelRouter ? [v(25, 1)] : []),
  ]);
  return concat([s(1, config.label), ...(config.supportsImages ? [v(5, 1)] : []),
    v(10, config.provider), v(18, config.maxTokens),
    s(22, config.modelUid), m(23, infoRaw), m(30, encodeFamily(config.modelFamilyMetadata))]);
}

function configFor({ uid, label, family, familyUid, contextWindow, maxOutputTokens, effort, fusion, supportsImages, inferenceServerUrl, kind, harnessUids }) {
  const json = {
    label, modelUid: uid, provider: fusion ? 1 : 2,
    maxTokens: contextWindow, supportsImages: !!supportsImages,
    modelInfo: {
      modelUid: uid, modelType: 2, maxTokens: contextWindow,
      maxOutputTokens,
      inferenceServerUrl,
      harnessUids: harnessUids ?? (fusion ? ['fusion'] : [...SIDEKICK_HARNESSES]),
      displayOption: fusion ? 3 : 0, modelFamilyUid: familyUid, isModelRouter: !!fusion,
      modelFeatures: { zeroShotCapable: true, supportsImages: !!supportsImages, supportsToolCalls: true,
        supportsParallelToolCalls: true, supportsThinking: !!effort && effort !== 'none' },
    },
    modelFamilyMetadata: family,
  };
  return { uid, label, effort, kind: kind || (fusion ? 'fusion' : 'model'), json, raw: encodeConfig(json) };
}

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

// Hidden semantics are family-level: a hidden uid takes down every sibling
// sharing its familyUid, so a variant first observed after the blacklist was
// written cannot leak back into the picker. Entries without a family stay
// uid-scoped. `entries` supplies uid/family pairs via the given accessors.
function expandHiddenByFamily(hiddenSet, entries, uidOf, familyOf) {
  if (!hiddenSet.size) return hiddenSet;
  const families = new Map();
  for (const entry of entries) {
    const uid = uidOf(entry), family = familyOf(entry);
    if (uid && family) families.set(uid, family);
  }
  const hiddenFamilies = new Set();
  for (const uid of hiddenSet) { const family = families.get(uid); if (family) hiddenFamilies.add(family); }
  if (!hiddenFamilies.size) return hiddenSet;
  const expanded = new Set(hiddenSet);
  for (const [uid, family] of families) if (hiddenFamilies.has(family)) expanded.add(uid);
  return expanded;
}

// A non-empty allowlist (team settings f7, pre-injection) is authoritative:
// a native uid outside it is a retired/entitlement leftover — selectable
// neither standalone nor inside a Fusion combination, since the emitted
// combo registers only when its native side is already in f7. Absent or
// empty means "not observed yet" and restricts nothing.
function normalizeAllowedUids(allowedUids) {
  if (allowedUids instanceof Set) return allowedUids.size ? allowedUids : null;
  return Array.isArray(allowedUids) && allowedUids.length ? new Set(allowedUids) : null;
}
function buildRoleLists(config = {}, nativeModels = [], allowedUids = null) {
  const allowed = normalizeAllowedUids(allowedUids);
  const hiddenSet = expandHiddenByFamily(
    new Set(Array.isArray(config.hiddenNativeModelUids) ? config.hiddenNativeModelUids : []),
    nativeModels, entry => entry && entry.uid, entry => (entry && entry.familyUid) || '');
  const officialRoles = discoverOfficialRoles(nativeModels, hiddenSet, config, allowed);
  const { eligibleNativeLeads, eligibleNativeSidekicks } = discoverAdditionalNativeRoles(nativeModels, hiddenSet, officialRoles, allowed);
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
function buildCatalog(config = {}, nativeModels = [], allowedUids = null) {
  if (config.enabled === false) {
    return { models: [], routes: {}, fusions: {}, sidekicks: [], hiddenNativeModelUids: [], hiddenFusionUids: [] };
  }
  const models = [], routes = {}, fusions = {}, leads = [];
  const inferenceServerUrl = config.inferenceServerUrl || 'https://server.codeium.com';
  const inferenceUrl = new URL(inferenceServerUrl);
  if (!['http:', 'https:'].includes(inferenceUrl.protocol) || inferenceUrl.username || inferenceUrl.password) {
    throw new Error('Invalid inference server URL');
  }
  const providers = Array.isArray(config.providers) ? config.providers.filter(provider => provider && provider.enabled !== false) : [];
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
  const officialRoles = discoverOfficialRoles(nativeModels, hiddenSet, config);
  const { eligibleNativeLeads: additionalNativeLeads, eligibleNativeSidekicks: additionalNativeSidekicks } =
    discoverAdditionalNativeRoles(nativeModels, hiddenSet, officialRoles);
  const { eligibleNativeLeads, eligibleNativeSidekicks, hiddenFusionUids } = officialRoles;

  // Labels also identify entries in native sort groups. Disambiguate providers
  // with equal display names without changing stable routing identities.
  const familyKeys = new Map();
  for (const lead of leads) {
    if (!familyKeys.has(lead.familyLabel)) familyKeys.set(lead.familyLabel, new Set());
    familyKeys.get(lead.familyLabel).add(lead.key);
  }
  for (const lead of leads) if (familyKeys.get(lead.familyLabel).size > 1) lead.familyLabel += ` (${lead.providerId}/${lead.model})`;
  for (const lead of leads) {
    const effort = effortMetadata(lead.effort);
    models.push(configFor({ ...lead, label: lead.familyLabel + (lead.effort ? ` ${effort.name}` : ''),
      familyUid: 'dfbyok-family-' + digest(lead.key).slice(0, 16),
      family: { modelFamilyLabel: lead.familyLabel, entries: [{ key: 'Effort', value: effort }] } }));
  }

  const roleSelection = buildRoleLists(config, nativeModels, allowedUids);
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
  const pairs = [], customLeadNames = new Set(), customSideSlots = new Map();
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
      if (!(lead.native && lead.leadDimension)) customLeadNames.add(leadDim);
      if (!(sidekick.native && sidekick.dimension)) {
        customSideSlots.set(sideDim, {
          base: sidekick.native ? `native:${sidekick.uid}` : `byok:${sidekick.key}`,
          slot: effortMetadata(sidekick.effort).order,
        });
      }
      pairs.push({ lead, sidekick, leadDim, sideDim, uid });
    }
  }
  // Custom dimension values take hash-derived orders well above the official
  // range. Sequential orders would shift whenever the selected set changes,
  // and stale entries kept in the CLI cache carry their old order — two
  // different names landing on the same order make the picker drop one
  // silently (it dedupes dimension values by order). Sidekick values hash per
  // FAMILY and take consecutive slots inside it (sorted by effort tier), so a
  // model's variants stay adjacent in the dropdown instead of scattering.
  const leadOrders = stableOrders(customLeadNames, roleSelection.reservedLeadOrders);
  const sideBaseOrders = stableOrders([...customSideSlots.values()].map(v => v.base),
    roleSelection.reservedSidekickOrders);
  const sideGroups = new Map();
  for (const [name, v] of customSideSlots) {
    if (!sideGroups.has(v.base)) sideGroups.set(v.base, []);
    sideGroups.get(v.base).push({ name, slot: v.slot });
  }
  const sideOrders = new Map(), usedSideOrders = new Set(roleSelection.reservedSidekickOrders);
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
const OBSERVE_SOURCE = { GetCliModelConfigs: 'cli', GetCascadeModelConfigs: 'cascade', GetCommandModelConfigs: 'command', GetUserStatus: 'entitlement' };
function rpcShape(rpc) {
  let value = typeof rpc === 'string' ? rpc : rpc?.path || rpc?.name || '';
  try { if (value.includes('://')) value = new URL(value).pathname; } catch { return null; }
  value = value.split('?')[0];
  const method = value.slice(value.lastIndexOf('/') + 1);
  if (method === 'GetUserStatus') return { status: true, field: 1, sorts: true, source: OBSERVE_SOURCE[method] };
  if (['GetCliModelConfigs', 'GetCascadeModelConfigs', 'GetCommandModelConfigs'].includes(method)) return { status: false, sorts: method === 'GetCascadeModelConfigs', source: OBSERVE_SOURCE[method] };
  return null;
}

function rewriteMessage(data, number, transform, create = false) {
  const parsed = parseFields(data), matches = parsed.filter(field => field.number === number);
  if (matches.length > 1 || matches.some(field => field.wire !== 2)) throw new Error('Ambiguous catalog message');
  if (!matches.length) return create ? concat([data, m(number, transform(Buffer.alloc(0)))]) : data;
  return concat(parsed.map(field => field.number === number ? m(number, transform(field.value)) : field.raw));
}

// The server marks Fusion combinations the account cannot use as disabled.
// Report every native `fusion-` router uid and which are locked so assignment
// interception can fall back to the configured combination without affecting
// entries that remain enabled. Observation failures must never break rewriting.
function reportFusionStatus(entries, isJson, report) {
  if (typeof report !== 'function') return;
  try {
    const seen = [], locked = [];
    for (const entry of entries) {
      const uid = isJson ? entry?.modelUid ?? entry?.model_uid : str(entry, 22);
      if (typeof uid !== 'string' || !uid.startsWith('fusion-') || ownUid(uid)) continue;
      seen.push(uid);
      if (isJson ? entry.disabled === true : num(entry, 4) === 1) locked.push(uid);
    }
    if (seen.length) report(locked, seen);
  } catch {}
}

function protoUid(entry) {
  const uids = parseFields(entry).filter(field => field.number === 22);
  if (uids.length !== 1 || uids[0].wire !== 2) return '';
  return uids[0].value.toString('utf8');
}

// Inner field 23 is the server's family identifier — entries sharing it are
// one model with a tier selector and toggles (glm-5.2 groups all six uids).
// Absent or malformed just means "no family", never an invalid entry.
function metaFamilyUid(inner) {
  const fams = inner.filter(field => field.number === 23);
  if (fams.length !== 1 || fams[0].wire !== 2) return '';
  const value = fams[0].value.toString('utf8').trim();
  return value && value.length <= 128 ? value : '';
}

function protoFamilyUid(entry) {
  const infos = parseFields(entry).filter(field => field.number === 23);
  if (infos.length !== 1 || infos[0].wire !== 2) return '';
  try { return metaFamilyUid(parseFields(infos[0].value)); } catch { return ''; }
}

function protoDisabled(entry) {
  const flags = parseFields(entry).filter(field => field.number === 4);
  if (!flags.length) return false;
  if (flags.length !== 1 || flags[0].wire !== 0) return true;
  return Number(flags[0].value) !== 0;
}

function protoMetadata(entry) {
  const infos = parseFields(entry).filter(field => field.number === 23);
  if (infos.length !== 1 || infos[0].wire !== 2) return { harnessUids: [], isModelRouter: false };
  try {
    const inner = parseFields(infos[0].value);
    const harnesses = inner.filter(field => field.number === 20);
    if (harnesses.some(field => field.wire !== 2)) return { harnessUids: [], isModelRouter: false };
    const routers = inner.filter(field => field.number === 25);
    if (routers.length > 1 || routers.some(field => field.wire !== 0)) return { harnessUids: [], isModelRouter: false };
    const maxTokensFields = inner.filter(field => field.number === 4);
    const maxOutputFields = inner.filter(field => field.number === 13);
    const featuresFields = inner.filter(field => field.number === 6);
    let maxTokens, maxOutputTokens, supportsImages = false;
    if (maxTokensFields.length === 1 && maxTokensFields[0].wire === 0) {
      const val = Number(maxTokensFields[0].value);
      if (Number.isSafeInteger(val) && val > 0) maxTokens = val;
    }
    if (maxOutputFields.length === 1 && maxOutputFields[0].wire === 0) {
      const val = Number(maxOutputFields[0].value);
      if (Number.isSafeInteger(val) && val > 0) maxOutputTokens = val;
    }
    if (featuresFields.length === 1 && featuresFields[0].wire === 2) {
      const featInner = parseFields(featuresFields[0].value);
      const imgFields = featInner.filter(f => f.number === 11);
      if (imgFields.length === 1 && imgFields[0].wire === 0 && Number(imgFields[0].value) === 1) {
        supportsImages = true;
      }
    }
    const familyUid = metaFamilyUid(inner);
    // Inner field 22 is the proto DisplayOption enum (verified against the
    // official renderer): 0/absent UNSPECIFIED → standard picker, 1 ARENA,
    // 2 BATTLE_GROUP_ONLY, 3 MODEL_ROUTER, 4 QUICK_REVIEW, 5 MIMIC,
    // 6 HIDDEN_TOOL, 7 COMPACTOR, 8 MODERN_AGENT_CHAT → standard picker
    // ("Devin Local only" outside it). Everything except 0/absent and 8
    // routes to a non-picker surface or is invisible outright.
    const kinds = inner.filter(field => field.number === 22);
    let kind;
    if (kinds.length === 1 && kinds[0].wire === 0) {
      const value = Number(kinds[0].value);
      if (Number.isSafeInteger(value)) kind = value;
    }
    return {
      harnessUids: harnesses.map(field => field.value.toString('utf8')),
      isModelRouter: routers.length === 1 && Number(routers[0].value) !== 0,
      ...(maxTokens ? { maxTokens } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(supportsImages ? { supportsImages: true } : {}),
      ...(familyUid ? { familyUid } : {}),
      ...(kind !== undefined ? { kind } : {}),
    };
  } catch { return { harnessUids: [], isModelRouter: false }; }
}

const CANONICAL_FAMILY_KEYS = new Set(['Lead', 'Effort', 'Sidekick', 'Fast Mode', 'Recommended Sidekick']);

function protoFusionMetadata(entry) {
  const families = parseFields(entry).filter(field => field.number === 30);
  if (!families.length) return null;
  if (families.length !== 1 || families[0].wire !== 2) return null;
  try {
    const parts = parseFields(families[0].value);
    if (parts.some(field => field.number === 2 && field.wire !== 2)) return null;
    const entries = [];
    const keys = new Set();
    for (const field of parts.filter(field => field.number === 2)) {
      const item = parseFields(field.value);
      const keyFields = item.filter(part => part.number === 1);
      if (keyFields.length !== 1 || keyFields[0].wire !== 2) return null;
      const key = keyFields[0].value.toString('utf8');
      // Non-canonical control dimensions (Reasoning Effort, 1M Context,
      // Thinking, Prompt Cache Retention, Speed) are kept: the settings page
      // reads them to describe the family, and role/emission logic only ever
      // reads the canonical names so extra keys cannot leak into it.
      if (keys.has(key)) return null;
      keys.add(key);
      const valFields = item.filter(part => part.number === 2);
      if (valFields.length !== 1 || valFields[0].wire !== 2) return null;
      const dims = parseFields(valFields[0].value);
      const orders = dims.filter(part => part.number === 1);
      const names = dims.filter(part => part.number === 2);
      const controls = dims.filter(part => part.number === 3);
      // Official entries omit order on informational dims (e.g. Recommended
      // Sidekick): treat a missing order as 0 instead of rejecting the entry.
      if (orders.length > 1 || (orders.length === 1 && orders[0].wire !== 0)) return null;
      if (names.length > 1 || names.some(part => part.wire !== 2)) return null;
      if (controls.length > 1 || controls.some(part => part.wire !== 0)) return null;
      const order = orders.length ? Number(orders[0].value) : 0;
      const name = names.length ? names[0].value.toString('utf8') : '';
      const controlType = controls.length ? Number(controls[0].value) : 0;
      if (!Number.isSafeInteger(order) || order < 0 || order > 0x7fffffff) return null;
      if (!Number.isSafeInteger(controlType) || controlType < 0 || controlType > 0x7fffffff) return null;
      if (CANONICAL_FAMILY_KEYS.has(key) && key !== 'Fast Mode' && !name) return null;
      entries.push({ key, order, name, controlType });
    }
    return entries.length ? entries : null;
  } catch { return null; }
}

function extractSidekickDimension(entries) {
  if (!Array.isArray(entries)) return null;
  const sidekick = entries.find(e => e.key === 'Sidekick');
  if (!sidekick || !sidekick.name) return null;
  const fastMode = entries.find(e => e.key === 'Fast Mode');
  return { order: sidekick.order, name: sidekick.name, fastModeOrder: fastMode ? fastMode.order : 0 };
}

function protoSidekick(entry) {
  return extractSidekickDimension(protoFusionMetadata(entry));
}

function jsonAliasValue(object, camel, snake) {
  const hasCamel = has(object, camel), hasSnake = has(object, snake);
  if (hasCamel && hasSnake && JSON.stringify(object[camel]) !== JSON.stringify(object[snake])) return { conflict: true };
  return { value: hasCamel ? object[camel] : object[snake], present: hasCamel || hasSnake };
}

function jsonMetadata(entry) {
  const empty = { harnessUids: [], isModelRouter: false };
  const info = jsonAliasValue(entry, 'modelInfo', 'model_info');
  if (info.conflict || !info.present || !info.value || typeof info.value !== 'object' || Array.isArray(info.value)) return empty;
  const harness = jsonAliasValue(info.value, 'harnessUids', 'harness_uids');
  const router = jsonAliasValue(info.value, 'isModelRouter', 'is_model_router');
  if (harness.conflict || router.conflict) return empty;
  if (harness.present && (!Array.isArray(harness.value) || harness.value.some(value => typeof value !== 'string'))) return empty;
  if (router.present && typeof router.value !== 'boolean') return empty;
  const maxTokens = jsonAliasValue(info.value, 'maxTokens', 'max_tokens');
  const maxOutputTokens = jsonAliasValue(info.value, 'maxOutputTokens', 'max_output_tokens');
  const features = jsonAliasValue(info.value, 'modelFeatures', 'model_features');
  let supportsImages = false;
  if (!features.conflict && features.present && features.value && typeof features.value === 'object' && !Array.isArray(features.value)) {
    const img = jsonAliasValue(features.value, 'supportsImages', 'supports_images');
    if (!img.conflict && img.present && img.value === true) supportsImages = true;
  }
  const family = jsonAliasValue(info.value, 'modelFamilyUid', 'model_family_uid');
  const familyUid = !family.conflict && family.present && typeof family.value === 'string'
    ? family.value.trim() : '';
  return {
    harnessUids: harness.present ? harness.value : [],
    isModelRouter: router.value === true,
    ...(!maxTokens.conflict && maxTokens.present && Number.isSafeInteger(maxTokens.value) && maxTokens.value > 0 ? { maxTokens: maxTokens.value } : {}),
    ...(!maxOutputTokens.conflict && maxOutputTokens.present && Number.isSafeInteger(maxOutputTokens.value) && maxOutputTokens.value > 0 ? { maxOutputTokens: maxOutputTokens.value } : {}),
    ...(supportsImages ? { supportsImages: true } : {}),
    ...(familyUid && familyUid.length <= 128 ? { familyUid } : {}),
  };
}

function jsonFusionMetadata(entry) {
  const meta = jsonAliasValue(entry, 'modelFamilyMetadata', 'model_family_metadata');
  if (meta.conflict || !meta.present || !meta.value || typeof meta.value !== 'object' || Array.isArray(meta.value)) return null;
  const list = meta.value.entries;
  if (!Array.isArray(list)) return null;
  const entries = [];
  const keys = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.key !== 'string') return null;
    const key = item.key;
    if (keys.has(key)) return null;
    keys.add(key);
    const value = item.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const control = jsonAliasValue(value, 'controlType', 'control_type');
    if (control.conflict || (control.present && (!Number.isSafeInteger(control.value) || control.value < 0 || control.value > 0x7fffffff))) return null;
    if (value.order !== undefined && (!Number.isSafeInteger(value.order) || value.order < 0 || value.order > 0x7fffffff)) return null;
    if (value.name !== undefined && typeof value.name !== 'string') return null;
    const name = typeof value.name === 'string' ? value.name : '';
    const controlType = control.present ? control.value : 0;
    if (CANONICAL_FAMILY_KEYS.has(key) && key !== 'Fast Mode' && !name) return null;
    entries.push({ key, order: value.order ?? 0, name, controlType });
  }
  return entries.length ? entries : null;
}

function jsonSidekick(entry) {
  return extractSidekickDimension(jsonFusionMetadata(entry));
}

function nativeEntries(entries, isJson, source, pickerLabels) {
  const seen = [];
  for (const entry of entries) {
    let uid, label, disabled, meta, dimension, fusionMeta, listed;
    if (isJson) {
      uid = nativeUid(entry);
      label = typeof entry?.label === 'string' ? entry.label : '';
      disabled = has(entry, 'disabled') ? entry.disabled !== false : false;
      meta = jsonMetadata(entry);
      fusionMeta = jsonFusionMetadata(entry);
      dimension = extractSidekickDimension(fusionMeta);
    } else {
      uid = protoUid(entry);
      label = str(entry, 1);
      disabled = protoDisabled(entry);
      meta = protoMetadata(entry);
      fusionMeta = protoFusionMetadata(entry);
      dimension = extractSidekickDimension(fusionMeta);
      // Top-level field 6 marks legacy entitlement rows the picker still lists
      // (GPT-4.1/GPT-4o); its absence on an otherwise identical row (o3) is how
      // the picker drops retired models.
      listed = num(entry, 6) === 1;
    }
    if (typeof uid !== 'string' || !uid || uid.length > 256 || ownUid(uid)) continue;
    seen.push({
      uid, label, disabled, harnessUids: meta.harnessUids, isModelRouter: meta.isModelRouter,
      ...(dimension ? { sidekickDimension: dimension } : {}),
      ...(fusionMeta ? { fusionMetadata: fusionMeta } : {}),
      ...(meta.kind !== undefined ? { kind: meta.kind } : {}),
      ...(listed ? { listed: true } : {}),
      ...(meta.maxTokens ? { maxTokens: meta.maxTokens } : {}),
      ...(meta.maxOutputTokens ? { maxOutputTokens: meta.maxOutputTokens } : {}),
      ...(meta.supportsImages ? { supportsImages: true } : {}),
      ...(meta.familyUid ? { familyUid: meta.familyUid } : {}),
      ...(source ? { sources: [source] } : {}),
      ...(pickerLabels ? { pickerListed: pickerLabels.has(label) } : {}),
    });
  }
  return seen;
}

function reportNativeModels(entries, isJson, report, source) {
  if (typeof report !== 'function') return;
  try { const seen = nativeEntries(entries, isJson, source); if (seen.length) report(seen); } catch {}
}

function defaultFusion(catalog) {
  const uid = catalog?.lastFusionSelection;
  if (typeof uid !== 'string' || !has(catalog?.fusions, uid)) return null;
  const fusion = catalog.fusions[uid];
  return fusion?.sidekickNative === false && fusion?.leadNative !== true && has(catalog?.routes, fusion.leadUid) && has(catalog?.routes, fusion.sidekickUid) ? fusion : null;
}

function augmentProtoList(data, catalog, hasSorts = true, onFusionStatus, onNativeModels, source) {
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const parsed = parseFields(data), existingLabels = new Set(models.map(model => model.label));
  const entries = parsed.filter(field => field.number === 1 && field.wire === 2).map(field => field.value);
  reportFusionStatus(entries, false, onFusionStatus);
  reportNativeModels(entries, false, onNativeModels, source);
  const hiddenNative = expandHiddenByFamily(new Set(catalog.hiddenNativeModelUids || []), entries, protoUid, protoFamilyUid);
  const hiddenFusion = new Set(catalog.hiddenFusionUids || []);
  const matrixUids = catalog.matrixUids instanceof Set ? catalog.matrixUids : new Set(catalog.matrixUids || []);
  const retainedLabels = new Set(models.map(model => model.label));
  const hiddenLabels = new Set();
  const preserved = [];
  for (const field of parsed) {
    if (field.number === 1 && field.wire === 2) {
      const uid = protoUid(field.value), label = str(field.value, 1);
      if (ownUid(uid) || matrixUids.has(uid)) { existingLabels.add(label); continue; }
      // Entries we emitted but no longer emit (config changed, uid drifted)
      // look like official fusions yet are dead weight: they keep stale
      // dimension values alive and can shadow current ones when the picker
      // dedupes by order. Official fusion entries always carry capability
      // records (field 32); our emit never does, so an f32-less `fusion-*`
      // entry is safely ours to drop. Fresh entries are re-added below.
      if (uid.startsWith('fusion-') && !fields(field.value, 32).length) continue;
      if (hiddenNative.has(uid)) { if (label) hiddenLabels.add(label); continue; }
      if (hiddenFusion.has(uid)) { if (label) hiddenLabels.add(label); continue; }
      retainedLabels.add(label);
    }
    preserved.push(field);
  }
  for (const label of hiddenLabels) if (retainedLabels.has(label)) hiddenLabels.delete(label);
  const labels = models.map(model => model.label);
  const groups = [{ name: OWN_GROUP, items: models.filter(model => model.kind === 'model') }]
    .filter(group => group.items.length).map(group => concat([s(1, group.name), ...group.items.map(model => s(2, model.label))]));
  let sorts = 0;
  const result = preserved.map(field => {
    if (!hasSorts || field.number !== 2 || field.wire !== 2) return field.raw;
    sorts++;
    const parts = parseFields(field.value).filter(part => {
      if (part.number !== 2 || part.wire !== 2 || str(part.value, 1) !== OWN_GROUP) return true;
      return !parseFields(part.value).filter(value => value.number === 2 && value.wire === 2)
        .every(value => existingLabels.has(value.value.toString('utf8')));
    });
    const position = parts.findIndex(part => part.number === 2 && part.wire === 2);
    const rewritten = parts.map(part => {
      if (!hiddenLabels.size || part.number !== 2 || part.wire !== 2) return part;
      const inner = parseFields(part.value);
      const kept = inner.filter(value => !(value.number === 2 && value.wire === 2 && hiddenLabels.has(value.value.toString('utf8'))));
      return kept.length === inner.length ? part : { raw: m(2, concat(kept.map(value => value.raw))) };
    });
    if (labels.length) rewritten.splice(position < 0 ? rewritten.length : position, 0, ...groups.map(group => ({ raw: m(2, group) })));
    return m(2, concat(rewritten.map(part => part.raw)));
  });
  const own = models.map(model => m(1, model.raw));
  result.splice(Math.max(preserved.findIndex(field => field.number === 1 && field.wire === 2), 0), 0, ...own);
  if (hasSorts && !sorts && labels.length) result.push(m(2, concat([s(1, OWN_GROUP), ...groups.map(group => m(2, group))])));
  return concat(result);
}

function jsonKey(object, camel, snake) { return has(object, snake) && !has(object, camel) ? snake : camel; }
function nativeUid(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '';
  const camel = entry.modelUid, snake = entry.model_uid;
  if (has(entry, 'modelUid') && has(entry, 'model_uid') && camel !== snake) return '';
  const uid = camel ?? snake;
  return typeof uid === 'string' ? uid : '';
}
function augmentJsonList(data, catalog, hasSorts = true, onFusionStatus, onNativeModels, source) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid catalog JSON');
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const modelsKey = jsonKey(data, 'clientModelConfigs', 'client_model_configs');
  const sortsKey = jsonKey(data, 'clientModelSorts', 'client_model_sorts');
  const existing = data[modelsKey] || [], sorts = data[sortsKey] || [];
  if (!Array.isArray(existing) || !Array.isArray(sorts)) throw new Error('Invalid catalog list');
  reportFusionStatus(existing, true, onFusionStatus);
  reportNativeModels(existing, true, onNativeModels, source);
  const hiddenNative = expandHiddenByFamily(new Set(catalog.hiddenNativeModelUids || []), existing, nativeUid,
    model => jsonMetadata(model).familyUid || '');
  const hiddenFusion = new Set(catalog.hiddenFusionUids || []);
  const matrixUids = catalog.matrixUids instanceof Set ? catalog.matrixUids : new Set(catalog.matrixUids || []);
  const labels = models.map(model => model.label), existingLabels = new Set(labels);
  const retainedLabels = new Set(labels);
  const hiddenLabels = new Set();
  const kept = [];
  for (const model of existing) {
    const uid = nativeUid(model);
    if (ownUid(uid) || matrixUids.has(uid)) { existingLabels.add(model?.label); continue; }
    if (hiddenNative.has(uid)) { if (typeof model.label === 'string') hiddenLabels.add(model.label); continue; }
    if (hiddenFusion.has(uid)) { if (typeof model.label === 'string') hiddenLabels.add(model.label); continue; }
    if (typeof model?.label === 'string') retainedLabels.add(model.label);
    kept.push(model);
  }
  for (const label of hiddenLabels) if (retainedLabels.has(label)) hiddenLabels.delete(label);
  const groups = [{ groupName: OWN_GROUP, modelLabels: models.filter(model => model.kind === 'model').map(model => model.label) }]
    .filter(group => group.modelLabels.length);
  const append = sort => ({ ...sort, groups: [...groups, ...(sort.groups || []).map(value => {
    const labelsKey = has(value, 'modelLabels') ? 'modelLabels' : has(value, 'model_labels') ? 'model_labels' : '';
    if (!labelsKey || !Array.isArray(value[labelsKey]) || !hiddenLabels.size) return value;
    const keptLabels = value[labelsKey].filter(label => !hiddenLabels.has(label));
    return keptLabels.length === value[labelsKey].length ? value : { ...value, [labelsKey]: keptLabels };
  }).filter(value =>
    (value.groupName ?? value.group_name) !== OWN_GROUP || !(value.modelLabels ?? value.model_labels ?? []).every(label => existingLabels.has(label)))] });
  return { ...data,
    [modelsKey]: [...models.map(model => structuredClone(model.json)), ...kept],
    ...(hasSorts ? { [sortsKey]: sorts.length ? sorts.map(append) : (labels.length ? [{ name: OWN_GROUP, groups }] : sorts) } : {}),
  };
}

/** Accept decoded wire messages; framing/compression is exclusively the caller's responsibility. */
function augmentCatalog(data, { rpc, format = {}, catalog, onFusionStatus, onNativeModels, onSkip } = {}) {
  // Reported when the payload is left untouched for a reason the caller could
  // not infer from the bytes: silently returning the input looks exactly like
  // "nothing to do" and hid a shape mismatch that made every in-place cache
  // rewrite a no-op while the refresh still reported success.
  const skip = code => { try { onSkip?.(code, rpc); } catch {} };
  // `GetCliTeamSettings` carries its whole injection in the allowlist rewrite,
  // so it reports through the same channel as the catalog shapes below.
  if (rpc === '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings') return augmentLocalModelChoices(data, format, catalog, skip);
  const shape = rpcShape(rpc);
  if (!shape || !catalog) return data;
  if (!catalog.models?.length && !catalog.hiddenNativeModelUids?.length && !catalog.hiddenFusionUids?.length &&
      typeof onFusionStatus !== 'function' && typeof onNativeModels !== 'function') return data;
  try {
    if (format.json === true) {
      if (!shape.status) return augmentJsonList(data, catalog, shape.sorts, onFusionStatus, onNativeModels, shape.source);
      const statusKey = jsonKey(data, 'userStatus', 'user_status'), status = data?.[statusKey];
      if (!status || typeof status !== 'object' || Array.isArray(status)) return data;
      const configKey = jsonKey(status, 'cascadeModelConfigData', 'cascade_model_config_data');
      return { ...data, [statusKey]: { ...status, [configKey]: augmentJsonList(status[configKey] || {}, catalog, true, onFusionStatus, onNativeModels, shape.source) } };
    }
    if (!Buffer.isBuffer(data)) return data;
    if (!shape.status) return augmentProtoList(data, catalog, shape.sorts, onFusionStatus, onNativeModels, shape.source);
    const parsed = parseFields(data);
    const wrapped = parsed.filter(field => field.number === shape.field);
    // `GetUserStatus` has two shapes. The bridge repeats back the
    // `GetUserStatusResponse` envelope, whose field 1 is a `user_status` message
    // carrying the model list at *its* field 33; the CLI persists the bare
    // `UserStatus` message instead, where field 1 is the `pro` boolean and the
    // list already sits at field 33 of the payload. Field 1's wire type is the
    // only discriminator between them.
    if (wrapped.length !== 1 || wrapped[0].wire !== 2) {
      const list = parsed.filter(field => field.number === 33);
      if (list.length !== 1 || list[0].wire !== 2) { skip('shape-unrecognized'); return data; }
      // `create: false` keeps a payload that merely resembles a status — the
      // malformed inputs the callers already rely on returning untouched — from
      // gaining a model list it never had.
      return rewriteMessage(data, 33, value => augmentProtoList(value, catalog, true, onFusionStatus, onNativeModels, shape.source), false);
    }
    return rewriteMessage(data, shape.field, status => rewriteMessage(status, 33, value => augmentProtoList(value, catalog, true, onFusionStatus, onNativeModels, shape.source), true));
  } catch { skip('transform-failed'); return data; }
}

// Fusion entries we emitted but no longer do are indistinguishable from the
// official catalog by uid shape (they mirror `fusion-<a>-sidekick-<b>`). The
// reliable discriminator is structural: official fusion entries always carry
// capability records (field 32), our emit never writes that field. Scans the
// model-entry lists of either known payload shape (flat clientModelConfigs or
// the user_status nesting) and returns f32-less `fusion-*` uids that are safe
// to drop.
//
// "Safe" is deliberately conservative. A uid that is merely absent from the
// current emit is NOT stale: our emit set shrinks whenever a native model's
// observation is incomplete (the Sidekick dimensions arrive late), and dropping
// by absence alone deleted 131 valid combinations in one pass (2026-10-14).
// An entry is reported only when it can never be served again:
//   - its uid no longer splits into a lead/sidekick pair (a malformed leftover)
//   - one of its sides is no longer a known uid at all (the model is gone or
//     the BYOK uid digest changed with the configuration)
//   - one of its sides was explicitly turned off for that role, because then it
//     must stop feeding dimension values into the picker
// Callers must pass the object form `{ emitted, known, excluded }`; the
// historical positional set implied "not emitted means stale", which deleted
// perfectly servable combinations. A wrong argument type throws TypeError
// instead of degrading into "everything is stale".
// `known` is mandatory and must be non-empty for the same reason: it is the
// only real discriminator below, so an absent (or empty) set silently restores
// the absence semantics. `excluded` may stay optional — its default is the
// conservative side.
function staleFusionUids(data, options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || options instanceof Set) {
    throw new TypeError('staleFusionUids requires { emitted, known, excluded }');
  }
  const known = options.known instanceof Set ? options.known : Array.isArray(options.known) ? new Set(options.known) : null;
  if (!known || !known.size) {
    throw new TypeError('staleFusionUids requires a non-empty `known` set');
  }
  const emitted = options.emitted instanceof Set ? options.emitted : new Set(options.emitted || []);
  const excluded = options.excluded || {};
  const stale = [];
  const scan = buffer => {
    const uid = protoUid(buffer);
    if (!uid.startsWith('fusion-') || emitted.has(uid) || fields(buffer, 32).length) return;
    const marker = uid.lastIndexOf('-sidekick-');
    if (marker <= 'fusion-'.length) { stale.push(uid); return; }
    const leadUid = uid.slice('fusion-'.length, marker), sidekickUid = uid.slice(marker + '-sidekick-'.length);
    if (!leadUid || !sidekickUid || leadUid.endsWith('-fast')) { stale.push(uid); return; }
    const dead = (uid, role) => !known.has(uid) || (excluded[role] instanceof Set && excluded[role].has(uid));
    if (dead(leadUid, 'lead') || dead(sidekickUid, 'sidekick')) stale.push(uid);
  };
  // The payload itself is scanned alongside every field-1 message it carries:
  // the flat CLI-configs list keeps its entries at the top level, the
  // `GetUserStatusResponse` envelope nests them under field 1 → 33, and the bare
  // `UserStatus` message the CLI caches (field 1 is the `pro` boolean) keeps them
  // at field 33 of the payload itself. Scanning only the envelope made the cached
  // shape invisible, so its stale entries could never be retired.
  try {
    for (const body of [data, ...parseFields(data).filter(field => field.number === 1 && field.wire === 2).map(field => field.value)]) {
      scan(body);
      try {
        for (const list of parseFields(body).filter(field => field.number === 33 && field.wire === 2)) {
          for (const entry of parseFields(list.value).filter(field => field.number === 1 && field.wire === 2)) scan(entry.value);
        }
      } catch { /* not a status envelope — the flat scan above already ran */ }
    }
  } catch { /* unparseable payloads simply report no stale entries */ }
  return stale;
}

// Sort sections (field 2 in a catalog list message) carry the picker's actual
// layout: named groups of model *labels*. A label present there renders as a
// picker row when its uid is also allowlisted; catalog entries whose label
// never appears (SWE-check, review rows) are unreachable through the picker.
function protoPickerLabels(fields) {
  const labels = new Set();
  for (const section of fields.filter(field => field.number === 2 && field.wire === 2)) {
    try {
      for (const group of parseFields(section.value).filter(part => part.number === 2 && part.wire === 2)) {
        for (const label of parseFields(group.value).filter(part => part.number === 2 && part.wire === 2)) {
          labels.add(label.value.toString('utf8'));
        }
      }
    } catch {}
  }
  return labels.size ? labels : null;
}

function jsonPickerLabels(payload) {
  const sorts = payload[jsonKey(payload, 'clientModelSorts', 'client_model_sorts')];
  if (!Array.isArray(sorts)) return null;
  const labels = new Set();
  for (const sort of sorts) {
    const groups = sort?.groups;
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const list = group?.modelLabels ?? group?.model_labels;
      if (!Array.isArray(list)) continue;
      for (const label of list) if (typeof label === 'string') labels.add(label);
    }
  }
  return labels.size ? labels : null;
}

function collectNativeModels(data, { rpc, format = {} } = {}) {
  const shape = rpcShape(rpc);
  if (!shape) return [];
  try {
    if (format.json === true) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
      let payload = data;
      if (shape.status) {
        const status = data[jsonKey(data, 'userStatus', 'user_status')];
        if (!status || typeof status !== 'object' || Array.isArray(status)) return [];
        payload = status[jsonKey(status, 'cascadeModelConfigData', 'cascade_model_config_data')] || {};
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
      const list = payload[jsonKey(payload, 'clientModelConfigs', 'client_model_configs')];
      const picker = shape.sorts ? jsonPickerLabels(payload) : null;
      return Array.isArray(list) ? nativeEntries(list, true, shape.source, picker) : [];
    }
    if (!Buffer.isBuffer(data)) return [];
    if (!shape.status) {
      const parsed = parseFields(data);
      const picker = shape.sorts ? protoPickerLabels(parsed) : null;
      return nativeEntries(parsed.filter(field => field.number === 1 && field.wire === 2).map(field => field.value), false, shape.source, picker);
    }
    const statuses = parseFields(data).filter(field => field.number === 1);
    if (statuses.length !== 1 || statuses[0].wire !== 2) return [];
    const lists = parseFields(statuses[0].value).filter(field => field.number === 33);
    if (lists.length !== 1 || lists[0].wire !== 2) return [];
    const inner = parseFields(lists[0].value);
    return nativeEntries(inner.filter(field => field.number === 1 && field.wire === 2).map(field => field.value), false, shape.source, protoPickerLabels(inner));
  } catch { return []; }
}

// GetCliTeamSettings carries the account's allowed model uid list (proto field
// 7, JSON allowedModelUids) — the authoritative gate for whether an official
// model appears in a picker at all. Catalog payloads keep retired models and
// even reference them from sort groups, so catalog presence alone cannot tell
// a picker row from a dangling entitlement leftover. Returns null when the
// payload carries no restriction: an absent or empty list means unrestricted.
function collectAllowedUids(data, { rpc, format = {} } = {}) {
  let value = typeof rpc === 'string' ? rpc : rpc?.path || rpc?.name || '';
  try { if (value.includes('://')) value = new URL(value).pathname; } catch { return null; }
  if (value.split('?')[0] !== '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings') return null;
  try {
    if (format.json === true) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
      const key = jsonKey(data, 'allowedModelUids', 'allowed_model_uids');
      const list = data[key];
      if (!Array.isArray(list) || !list.length) return null;
      const uids = list.filter(uid => typeof uid === 'string' && uid && uid.length <= 256);
      return uids.length === list.length ? uids : null;
    }
    if (!Buffer.isBuffer(data)) return null;
    const uids = [];
    for (const field of parseFields(data)) {
      if (field.number !== 7) continue;
      if (field.wire !== 2) return null;
      uids.push(field.value.toString('utf8'));
    }
    return uids.length ? uids : null;
  } catch { return null; }
}

// The CLI intersects the model catalog with its configured choices. Register
// only locally routed BYOK models; native choices and every other setting stay
// byte-identical. A native Sidekick must already be in the native choice list.
function augmentLocalModelChoices(data, format, catalog, skip = () => {}) {
  if (!catalog?.models?.length) return data;
  try {
    const key = format.json ? jsonKey(data, 'allowedModelUids', 'allowed_model_uids') : null;
    const parsed = format.json ? null : parseFields(data);
    const entries = format.json ? data[key] : parsed.filter(f => f.number === 7).map(f => {
      if (f.wire !== 2) throw new Error('Invalid model choice');
      return f.value.toString('utf8');
    });
    // An absent or empty list is unrestricted; do not turn it into a restriction.
    if (entries === undefined || Array.isArray(entries) && entries.length === 0) return data;
    if (!Array.isArray(entries) || entries.some(uid => typeof uid !== 'string')) { skip('shape-unrecognized'); return data; }
    const matrixUids = catalog.matrixUids instanceof Set ? catalog.matrixUids : new Set(catalog.matrixUids || []);
    const isOwn = uid => ownUid(uid) || matrixUids.has(uid);
    const native = new Set(entries.filter(uid => !isOwn(uid)));
    const additions = catalog.models.filter(model => {
      if (!isOwn(model.uid)) return false;
      if (Object.hasOwn(catalog.routes, model.uid)) return true;
      const fusion = catalog.fusions[model.uid];
      if (!fusion) return false;
      if (fusion.leadNative) {
        if (!native.has(fusion.leadUid)) return false;
        return fusion.sidekickNative ? native.has(fusion.sidekickUid) : ownUid(fusion.sidekickUid) && Object.hasOwn(catalog.routes, fusion.sidekickUid);
      }
      return ownUid(fusion.leadUid) && Object.hasOwn(catalog.routes, fusion.leadUid) &&
        (fusion.sidekickNative ? native.has(fusion.sidekickUid) : ownUid(fusion.sidekickUid) && Object.hasOwn(catalog.routes, fusion.sidekickUid));
    }).map(model => model.uid);
    if (format.json) return { ...data, [key]: [...entries.filter(uid => !isOwn(uid)), ...additions] };
    return concat([...parsed.filter(f => !(f.number === 7 && isOwn(f.value.toString('utf8')))).map(f => f.raw), ...additions.map(uid => s(7, uid))]);
  } catch { skip('transform-failed'); return data; }
}

function assignmentUid(data, format, field, camel, snake) {
  if (format.json === true) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid assignment');
    if (has(data, camel) && has(data, snake) && data[camel] !== data[snake]) throw new Error('Ambiguous assignment');
    const value = data[camel] ?? data[snake] ?? '';
    if (typeof value !== 'string') throw new Error('Invalid assignment uid');
    return value;
  }
  const values = parseFields(data).filter(value => value.number === field);
  if (values.length > 1 || values.some(value => value.wire !== 2)) throw new Error('Ambiguous assignment');
  return values[0]?.value.toString('utf8') || '';
}

function resolveAssignment(data, format = {}, catalog, lockedFusionUids) {
  try {
    const router = assignmentUid(data, format, 2, 'modelRouterUid', 'model_router_uid');
    const leadRouter = assignmentUid(data, format, 6, 'fusionLeadRouterUid', 'fusion_lead_router_uid');
    const uid = leadRouter || router;
    let fusion = has(catalog?.fusions, uid) ? catalog.fusions[uid] : null;
    let redirected = false;
    // A locked official Fusion selection (free account) falls back to the
    // configured combination; enabled official entries keep their native path.
    if (!fusion && uid.startsWith('fusion-') && !ownUid(uid) && lockedFusionUids instanceof Set && lockedFusionUids.has(uid)) {
      fusion = defaultFusion(catalog);
      redirected = !!fusion;
    }
    // The picker may allow combinations we never emitted (e.g. a BYOK lead
    // with an official sidekick outside our pools). Split official-shaped
    // uids instead of failing. Fast-mode variants are refused: BYOK has no
    // fast capability, so downgrading silently would fake success.
    if (!fusion) {
      const marker = typeof uid === 'string' ? uid.lastIndexOf('-sidekick-') : -1;
      if (marker > 'fusion-'.length && uid.startsWith('fusion-')) {
        const leadUid = uid.slice('fusion-'.length, marker), sidekickUid = uid.slice(marker + '-sidekick-'.length);
        if (sidekickUid && !leadUid.endsWith('-fast')) {
          const leadNative = !ownUid(leadUid), sidekickNative = !ownUid(sidekickUid);
          fusion = { uid, label: uid, leadUid, sidekickUid, leadNative, sidekickNative,
            ...(leadNative ? { leadHarnessUids: catalog?.nativeLeadHarnessUids?.get(leadUid) } : {}),
            ...(sidekickNative ? { sidekickHarnessUids: catalog?.nativeHarnessUids?.get(sidekickUid) } : {}) };
        }
      }
    }
    if (!fusion) return null;
    const modelUid = leadRouter ? fusion.sidekickUid : fusion.leadUid;
    if (leadRouter) {
      if (fusion.sidekickNative) {
        if (!Array.isArray(fusion.sidekickHarnessUids) || !fusion.sidekickHarnessUids.length) return null;
      } else if (!has(catalog.routes, modelUid)) return null;
    } else {
      if (fusion.leadNative) {
        if (!Array.isArray(fusion.leadHarnessUids) || !fusion.leadHarnessUids.length) return null;
      } else if (!has(catalog.routes, modelUid)) return null;
    }
    let harnessUids;
    if (leadRouter) {
      harnessUids = fusion.sidekickNative ? fusion.sidekickHarnessUids : [...SIDEKICK_HARNESSES];
    } else {
      harnessUids = fusion.leadNative ? fusion.leadHarnessUids : ['fusion'];
    }
    const result = format.json === true ? { assignment: { modelUid, harnessUids } }
      : m(1, concat([s(2, modelUid), ...harnessUids.map(harness => s(3, harness))]));
    if (redirected) Object.defineProperty(result, 'redirectedFrom', { value: uid });
    return result;
  } catch { return null; }
}

module.exports = { buildCatalog, augmentCatalog, resolveAssignment, collectNativeModels, collectAllowedUids, buildRoleLists, refKey, staleFusionUids };

'use strict';
const crypto = require('node:crypto');
const { s, v, m } = require('../protocol/wire.cjs');

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
function nativeUid(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '';
  const camel = entry.modelUid, snake = entry.model_uid;
  if (has(entry, 'modelUid') && has(entry, 'model_uid') && camel !== snake) return '';
  const uid = camel ?? snake;
  return typeof uid === 'string' ? uid : '';
}
module.exports = { OWN_GROUP, SIDEKICK_HARNESSES, ownUid, has, digest, slug, concat, positive, refKey, stableOrders, NATIVE_EFFORT_SUFFIX, leadFamilyBase, leadFamilyTier, NATIVE_EFFORT_NAMES, NATIVE_LABEL_SUFFIX, leadFamilyLabel, effortMetadata, encodeFamily, encodeConfig, configFor, expandHiddenByFamily, normalizeAllowedUids, nativeUid };

'use strict';
const crypto = require('node:crypto');

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

const NATIVE_ORDER_BASE = 0x10000000;
const NATIVE_ORDER_SPAN = 0x08000000;
const BYOK_ORDER_BASE = 0x20000000;
const BYOK_PROVIDER_STRIDE = 0x10000;
const BYOK_MODEL_STRIDE = 0x40;
const BYOK_PROVIDER_LIMIT = 0x1000;
const BYOK_MODEL_LIMIT = 0x400;

function stableOrders(keys, reserved) {
  const result = new Map(), used = new Set(reserved || []);
  for (const key of [...new Set(keys)].sort()) {
    let order = NATIVE_ORDER_BASE + (parseInt(digest(key).slice(0, 8), 16) % NATIVE_ORDER_SPAN);
    while (used.has(order)) order = order === NATIVE_ORDER_BASE + NATIVE_ORDER_SPAN - 1 ? NATIVE_ORDER_BASE : order + 1;
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
// A lead uid is fast when the observed Fast Mode dimension says so
// (`observedFastUids`), or — absent any explicit observation — its suffix
// marks it (-fast on Claude, -priority on GPT). An explicit non-fast
// observation wins over the suffix guess: `swe-1-6-fast`'s Speed variant is a
// legitimate series, not Fast Mode. Shared by the emission filter, the stale
// probe and assignment so all three agree on what must never resolve.
// Sidekicks are never fast-gated.
function isFastLeadUid(uid, observedFastUids, observedNonFastUids) {
  if (typeof uid !== 'string') return false;
  if (observedFastUids?.has(uid)) return true;
  if (observedNonFastUids?.has(uid)) return false;
  return uid.endsWith('-fast') || uid.endsWith('-priority');
}
function nativeUid(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '';
  const camel = entry.modelUid, snake = entry.model_uid;
  if (has(entry, 'modelUid') && has(entry, 'model_uid') && camel !== snake) return '';
  const uid = camel ?? snake;
  return typeof uid === 'string' ? uid : '';
}
module.exports = { OWN_GROUP, SIDEKICK_HARNESSES, ownUid, has, digest, slug, concat, positive, refKey,
  NATIVE_ORDER_BASE, NATIVE_ORDER_SPAN, BYOK_ORDER_BASE, BYOK_PROVIDER_STRIDE, BYOK_MODEL_STRIDE,
  BYOK_PROVIDER_LIMIT, BYOK_MODEL_LIMIT, stableOrders,
  NATIVE_EFFORT_SUFFIX, leadFamilyBase, leadFamilyTier, NATIVE_EFFORT_NAMES, NATIVE_LABEL_SUFFIX, leadFamilyLabel, effortMetadata, expandHiddenByFamily, normalizeAllowedUids, nativeUid, isFastLeadUid };

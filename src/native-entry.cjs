'use strict';
// Shared canonical shape for one observed native catalog entry and for the
// team-settings allowlist. Pure leaf: every consumer that turns a wire/cache
// record into the internal representation normalizes through here so the
// activation observer, the backend cache, the endpoint reader and the payload
// extractor cannot drift apart on field bounds or coercion.

function normalizeNativeEntry(entry) {
  if (!entry || typeof entry.uid !== 'string' || !entry.uid || entry.uid.length > 256) return null;
  const dimension = entry.sidekickDimension;
  return { uid: entry.uid, label: typeof entry.label === 'string' ? entry.label.slice(0, 512) : '',
    disabled: entry.disabled === true, isModelRouter: entry.isModelRouter === true,
    harnessUids: Array.isArray(entry.harnessUids)
      ? entry.harnessUids.filter(value => typeof value === 'string' && value.length <= 256).slice(0, 64) : [],
    ...(dimension && typeof dimension === 'object'
      ? { sidekickDimension: { order: dimension.order, name: dimension.name, fastModeOrder: dimension.fastModeOrder } } : {}),
    ...(Array.isArray(entry.fusionMetadata) ? { fusionMetadata: entry.fusionMetadata } : {}),
    ...(Number.isSafeInteger(entry.kind) ? { kind: entry.kind } : {}),
    ...(entry.listed === true ? { listed: true } : {}),
    ...(typeof entry.pickerListed === 'boolean' ? { pickerListed: entry.pickerListed } : {}),
    ...(entry.maxTokens ? { maxTokens: entry.maxTokens } : {}),
    ...(entry.maxOutputTokens ? { maxOutputTokens: entry.maxOutputTokens } : {}),
    ...(entry.supportsImages ? { supportsImages: true } : {}),
    ...(typeof entry.familyUid === 'string' && entry.familyUid && entry.familyUid.length <= 128 ? { familyUid: entry.familyUid } : {}),
    ...(Array.isArray(entry.sources)
      ? { sources: entry.sources.filter(value => typeof value === 'string' && value.length <= 32).slice(0, 8) } : {}) };
}

// The team settings allowlist is a complete-set verdict: whichever response
// arrived last defines what the account may select. Replacing wholesale (never
// union) keeps retired uids retired.
function normalizeAllowedUids(uids) {
  if (!Array.isArray(uids)) return [];
  const seen = new Set();
  for (const uid of uids) {
    if (typeof uid !== 'string' || !uid || uid.length > 256 || /^(?:fusion-)?dfbyok-/.test(uid)) continue;
    seen.add(uid);
  }
  return [...seen].sort();
}

module.exports = { normalizeNativeEntry, normalizeAllowedUids };

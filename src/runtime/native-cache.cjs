'use strict';
const fs = require('node:fs');

const CACHE_VERSION = 1;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const MAX_FUTURE_SKEW_MS = 60 * 60 * 1000;

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

function normalizedList(entries) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set(), models = [];
  for (const entry of entries) {
    const normalized = normalizeNativeEntry(entry);
    if (!normalized || seen.has(normalized.uid)) continue;
    seen.add(normalized.uid);
    models.push(normalized);
    if (models.length >= MAX_ENTRIES) break;
  }
  return models;
}

// The same uid arrives through several channels (the persisted cache, the CLI's
// traffic, the native extension's traffic) and their entries are not equally
// complete: a seeded entry predates whatever the next observation learned, and
// the channels disagree about which fields carry the Fusion family metadata.
// Keeping the richer form prevents a stale copy from silently downgrading the
// catalog — a dimension-less entry makes every native Sidekick unresolvable, so
// the mirrored combinations disappear from the picker and the CLI cache refresh
// then deletes them as unemitted (2026-10-14).
function mergeNativeEntry(prior, incoming) {
  if (!prior) return incoming;
  if (!incoming) return prior;
  const carried = {};
  if (prior.sidekickDimension && !incoming.sidekickDimension) carried.sidekickDimension = prior.sidekickDimension;
  if (prior.fusionMetadata && !incoming.fusionMetadata) carried.fusionMetadata = prior.fusionMetadata;
  if (prior.harnessUids?.length && !incoming.harnessUids?.length) carried.harnessUids = prior.harnessUids;
  if (prior.familyUid && !incoming.familyUid) carried.familyUid = prior.familyUid;
  if (prior.kind !== undefined && incoming.kind === undefined) carried.kind = prior.kind;
  if (prior.listed === true && incoming.listed !== true) carried.listed = prior.listed;
  // A sorts-carrying observation delivers a fresh verdict (listed or not); a
  // flat-catalog observation leaves the prior verdict untouched.
  if (prior.pickerListed !== undefined && incoming.pickerListed === undefined) carried.pickerListed = prior.pickerListed;
  const merged = Object.keys(carried).length ? { ...incoming, ...carried } : { ...incoming };
  // Observation sources accumulate: a uid seen through any catalog keeps every
  // surface it was ever observed on, so picker classification stays truthful.
  const sources = new Set([...(prior.sources || []), ...(incoming.sources || [])]);
  if (sources.size) merged.sources = [...sources].slice(0, 8);
  return merged;
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

function loadNativeCache(file, { now = Date.now, ttlMs = DEFAULT_TTL_MS, readFile = fs.readFileSync } = {}) {
  const empty = { models: [], allowedUids: [] };
  try {
    const parsed = JSON.parse(readFile(file, 'utf8'));
    if (parsed?.version !== CACHE_VERSION || !Array.isArray(parsed.models)) return empty;
    const savedAt = Date.parse(parsed.savedAt);
    if (!Number.isFinite(savedAt)) return empty;
    const age = now() - savedAt;
    if (age > ttlMs || age < -MAX_FUTURE_SKEW_MS) return empty;
    return { models: normalizedList(parsed.models), allowedUids: normalizeAllowedUids(parsed.allowedUids) };
  } catch { return empty; }
}

function saveNativeCache(file, entries, { now = Date.now, allowedUids,
  writeFile = fs.writeFileSync, rename = fs.renameSync, unlink = fs.rmSync } = {}) {
  const tmp = file + '.tmp';
  try {
    const payload = { version: CACHE_VERSION, savedAt: new Date(now()).toISOString(), models: normalizedList(entries) };
    const allowed = normalizeAllowedUids(allowedUids);
    if (allowed.length) payload.allowedUids = allowed;
    writeFile(tmp, JSON.stringify(payload), { mode: 0o600 });
    rename(tmp, file);
    return true;
  } catch {
    try { unlink(tmp, { force: true }); } catch {}
    return false;
  }
}

module.exports = { CACHE_VERSION, DEFAULT_TTL_MS, MAX_ENTRIES, normalizeNativeEntry, normalizeAllowedUids, mergeNativeEntry, loadNativeCache, saveNativeCache };

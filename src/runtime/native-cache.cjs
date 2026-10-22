'use strict';
const fs = require('node:fs');
const { normalizeNativeEntry, normalizeAllowedUids, mergeNativeEntry } = require('../native-entry.cjs');

const CACHE_VERSION = 1;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const MAX_FUTURE_SKEW_MS = 60 * 60 * 1000;

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

// mergeNativeEntry lives in native-entry.cjs — the canonical-shape module —
// and is re-exported here only so existing importers keep working. New code
// should take it from native-entry.cjs directly.

function loadNativeCache(file, { now = Date.now, ttlMs = DEFAULT_TTL_MS, readFile = fs.readFileSync } = {}) {
  const empty = { models: [], allowedUids: [], allowedMode: 'restricted' };
  try {
    const parsed = JSON.parse(readFile(file, 'utf8'));
    if (parsed?.version !== CACHE_VERSION || !Array.isArray(parsed.models)) return empty;
    const savedAt = Date.parse(parsed.savedAt);
    if (!Number.isFinite(savedAt)) return empty;
    const age = now() - savedAt;
    if (age > ttlMs || age < -MAX_FUTURE_SKEW_MS) return empty;
    return { models: normalizedList(parsed.models), allowedUids: normalizeAllowedUids(parsed.allowedUids),
      allowedMode: parsed.allowedMode === 'unrestricted' ? 'unrestricted' : 'restricted' };
  } catch { return empty; }
}

function saveNativeCache(file, entries, { now = Date.now, allowedUids, allowedMode,
  writeFile = fs.writeFileSync, rename = fs.renameSync, unlink = fs.rmSync } = {}) {
  const tmp = file + '.tmp';
  try {
    const payload = { version: CACHE_VERSION, savedAt: new Date(now()).toISOString(), models: normalizedList(entries) };
    const allowed = normalizeAllowedUids(allowedUids);
    if (allowed.length) payload.allowedUids = allowed;
    // Only 'unrestricted' is persisted: a missing key reads as restricted, so
    // upgrading never silently lifts a restriction the old cache encoded.
    if (allowedMode === 'unrestricted') payload.allowedMode = 'unrestricted';
    writeFile(tmp, JSON.stringify(payload), { mode: 0o600 });
    rename(tmp, file);
    return true;
  } catch {
    try { unlink(tmp, { force: true }); } catch {}
    return false;
  }
}

module.exports = { CACHE_VERSION, DEFAULT_TTL_MS, MAX_ENTRIES, normalizeNativeEntry, normalizeAllowedUids, mergeNativeEntry, loadNativeCache, saveNativeCache };

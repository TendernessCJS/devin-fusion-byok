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
    ...(entry.maxTokens ? { maxTokens: entry.maxTokens } : {}),
    ...(entry.maxOutputTokens ? { maxOutputTokens: entry.maxOutputTokens } : {}),
    ...(entry.supportsImages ? { supportsImages: true } : {}) };
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

function loadNativeCache(file, { now = Date.now, ttlMs = DEFAULT_TTL_MS, readFile = fs.readFileSync } = {}) {
  try {
    const parsed = JSON.parse(readFile(file, 'utf8'));
    if (parsed?.version !== CACHE_VERSION || !Array.isArray(parsed.models)) return [];
    const savedAt = Date.parse(parsed.savedAt);
    if (!Number.isFinite(savedAt)) return [];
    const age = now() - savedAt;
    if (age > ttlMs || age < -MAX_FUTURE_SKEW_MS) return [];
    return normalizedList(parsed.models);
  } catch { return []; }
}

function saveNativeCache(file, entries, { now = Date.now,
  writeFile = fs.writeFileSync, rename = fs.renameSync, unlink = fs.rmSync } = {}) {
  const tmp = file + '.tmp';
  try {
    const payload = { version: CACHE_VERSION, savedAt: new Date(now()).toISOString(), models: normalizedList(entries) };
    writeFile(tmp, JSON.stringify(payload), { mode: 0o600 });
    rename(tmp, file);
    return true;
  } catch {
    try { unlink(tmp, { force: true }); } catch {}
    return false;
  }
}

module.exports = { CACHE_VERSION, DEFAULT_TTL_MS, MAX_ENTRIES, normalizeNativeEntry, loadNativeCache, saveNativeCache };

'use strict';
const fs = require('node:fs');
const { rootIdentity, controlFile } = require('../contract.cjs');
const { PORT } = require('../port.cjs');
const { withConnectionRetry } = require('./retry.cjs');
const { normalizeNativeEntry, normalizeAllowedUids } = require('../../models/native-entry.cjs');
// Upstream observations only: our own uids are never part of the native
// catalog, and the reader rejects a payload containing them outright. Both the
// reader's validation and the push payload derive from this one predicate so the
// two sides cannot drift apart.
const isUpstreamUid = uid => typeof uid === 'string' && !!uid && uid.length <= 256 && !/^(?:fusion-)?dfbyok-/.test(uid);
async function readOnce({ root, port, signal, request }) {
  const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000);
  const base = 'http://127.0.0.1:' + port;
  const read = async (url, headers) => {
    const response = await request(url, { signal: timeout, headers, redirect: 'error' });
    if (!response.ok) throw new Error('native_catalog_unavailable');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new Error('native_catalog_too_large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const health = await read(base + '/health');
  const expected = rootIdentity(root);
  if (health.service !== expected.service || health.rootId !== expected.rootId || !health.instanceId) throw new Error('native_catalog_identity');
  if (health.nativeModelsProtocol !== 1) return { status: 'unsupported', models: [] };
  const control = JSON.parse(fs.readFileSync(controlFile(root), 'utf8'));
  if (control.rootId !== health.rootId || control.instanceId !== health.instanceId || control.sourceId !== health.sourceId || !/^[a-f0-9]{64}$/.test(control.token || '')) throw new Error('native_catalog_identity');
  const data = await read(base + '/_runtime/native-models', { authorization: 'Bearer ' + control.token });
  if (data.instanceId !== health.instanceId || !Array.isArray(data.models)) throw new Error('native_catalog_identity');
  const models = data.models.map(entry => {
    if (!entry || !isUpstreamUid(entry.uid) ||
      typeof entry.disabled !== 'boolean' || typeof entry.isModelRouter !== 'boolean' || !Array.isArray(entry.harnessUids) ||
      entry.harnessUids.some(uid => typeof uid !== 'string')) throw new Error('native_catalog_invalid');
    const next = { uid: entry.uid, label: typeof entry.label === 'string' ? entry.label : entry.uid,
      disabled: entry.disabled, isModelRouter: entry.isModelRouter, harnessUids: entry.harnessUids };
    const d = entry.sidekickDimension;
    if (d && Number.isSafeInteger(d.order) && d.order >= 0 && d.order <= 0x7fffffff && typeof d.name === 'string' && d.name &&
      (d.fastModeOrder === undefined || Number.isSafeInteger(d.fastModeOrder) && d.fastModeOrder >= 0))
      next.sidekickDimension = { order: d.order, name: d.name, fastModeOrder: d.fastModeOrder };
    if (entry.fusionMetadata !== undefined) {
      if (!Array.isArray(entry.fusionMetadata)) throw new Error('native_catalog_invalid');
      const validMeta = [];
      const seenKeys = new Set();
      for (const item of entry.fusionMetadata) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.key !== 'string' ||
            !Number.isSafeInteger(item.order) || item.order < 0 || item.order > 0x7fffffff ||
            typeof item.name !== 'string' ||
            (item.controlType !== undefined && (!Number.isSafeInteger(item.controlType) || item.controlType < 0 || item.controlType > 0x7fffffff)) ||
            seenKeys.has(item.key)) {
          throw new Error('native_catalog_invalid');
        }
        seenKeys.add(item.key);
        validMeta.push({ key: item.key, order: item.order, name: item.name, controlType: item.controlType ?? 0 });
      }
      next.fusionMetadata = validMeta;
    }
    if (Number.isSafeInteger(entry.maxTokens) && entry.maxTokens > 0) next.maxTokens = entry.maxTokens;
    if (Number.isSafeInteger(entry.maxOutputTokens) && entry.maxOutputTokens > 0) next.maxOutputTokens = entry.maxOutputTokens;
    if (entry.supportsImages === true) next.supportsImages = true;
    if (typeof entry.familyUid === 'string' && entry.familyUid && entry.familyUid.length <= 128) next.familyUid = entry.familyUid;
    if (Number.isSafeInteger(entry.kind)) next.kind = entry.kind;
    if (entry.listed === true) next.listed = true;
    if (typeof entry.pickerListed === 'boolean') next.pickerListed = entry.pickerListed;
    if (Array.isArray(entry.sources)) {
      const sources = entry.sources.filter(value => typeof value === 'string' && value.length <= 32).slice(0, 8);
      if (sources.length) next.sources = sources;
    }
    // The strict checks above decide whether the entry is trusted at all; the
    // shared normalizer then produces the same canonical shape every other
    // consumer serves.
    return normalizeNativeEntry(next);
  });
  const allowedUids = normalizeAllowedUids(data.allowedUids);
  const allowedMode = data.allowedMode === 'unrestricted' ? 'unrestricted' : 'restricted';
  return { status: models.length ? 'ready' : 'empty', models, allowedUids, allowedMode };
}
async function readNativeModels({ root, port = PORT, signal, request = fetch }) {
  return withConnectionRetry(() => readOnce({ root, port, signal, request }), { signal });
}
// Hands this host's observations to the backend so both sides serve the same
// catalog. It matters because the two sides see the same upstream catalog
// through different channels: this process only learns from the CLI's traffic,
// whose payloads can lack the Fusion family metadata, while the host reads the
// native extension's traffic. Without the push, the CLI's own cache keeps
// winning (24 combinations) against the host's richer view (155) and the picker
// loses every native Sidekick pairing until the host rewrites the cache.
// Best-effort by design: the caller treats any failure as "not pushed" and keeps
// relying on its own view, which is already the richer one.
async function pushNativeModels({ root, models, allowedUids, allowedMode, revision, port = PORT, signal, request = fetch }) {
  if (!Array.isArray(models) || !models.length) return { pushed: 0, reason: 'empty' };
  const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000);
  const base = 'http://127.0.0.1:' + port;
  let health;
  try {
    const response = await request(base + '/health', { signal: timeout, redirect: 'error' });
    if (!response.ok) return { pushed: 0, reason: 'unavailable' };
    health = await response.json();
  } catch { return { pushed: 0, reason: 'unavailable' }; }
  const expected = rootIdentity(root);
  if (health.service !== expected.service || health.rootId !== expected.rootId || !health.instanceId) return { pushed: 0, reason: 'identity' };
  // An older backend has no ingest endpoint; skipping is the correct outcome.
  if (health.nativeModelsIngest !== 1) return { pushed: 0, reason: 'unsupported' };
  let control;
  try { control = JSON.parse(fs.readFileSync(controlFile(root), 'utf8')); } catch { return { pushed: 0, reason: 'identity' }; }
  if (control.rootId !== health.rootId || control.instanceId !== health.instanceId || control.sourceId !== health.sourceId ||
    !/^[a-f0-9]{64}$/.test(control.token || '')) return { pushed: 0, reason: 'identity' };
  const payload = models.filter(entry => entry && isUpstreamUid(entry.uid));
  if (!payload.length) return { pushed: 0, reason: 'empty' };
  try {
    const response = await request(base + '/_runtime/native-models', {
      method: 'POST', signal: timeout, redirect: 'error',
      headers: { authorization: 'Bearer ' + control.token, 'content-type': 'application/json' },
      body: JSON.stringify({ models: payload,
        allowedMode: allowedMode === 'unrestricted' ? 'unrestricted' : 'restricted',
        ...(Number.isSafeInteger(revision) && revision >= 0 ? { revision } : {}),
        ...(Array.isArray(allowedUids) && allowedUids.length ? { allowedUids: allowedUids.filter(uid => isUpstreamUid(uid)) } : {}) }),
    });
    if (!response.ok) return { pushed: 0, reason: 'rejected' };
    const result = await response.json();
    if (result.instanceId !== health.instanceId) return { pushed: 0, reason: 'identity' };
    return { pushed: payload.length, count: result.count, improved: result.improved === true, revision: result.revision };
  } catch { return { pushed: 0, reason: 'unavailable' }; }
}
module.exports = { readNativeModels, pushNativeModels, isUpstreamUid };

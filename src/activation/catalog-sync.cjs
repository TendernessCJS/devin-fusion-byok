'use strict';
const { readNativeModels, pushNativeModels, isUpstreamUid } = require('../runtime/native-models.cjs');
const { mergeNativeEntry } = require('../runtime/native-cache.cjs');

function installCatalogSync({ deps, shared }) {
  const { lifecycle, config, log } = deps;
  const PUSH_INTERVAL_MS = 5 * 1000;
  // The gate must describe what is actually sent, not some proxy for it. Keying
  // it off the local bridge observations looked equivalent but was not: on the
  // first refresh the backend can answer with nothing yet, so an empty payload
  // claimed the key and the immediately following meaningful refresh was then
  // judged "unchanged" and skipped — the push silently never happened (only the
  // previous successful push, whose timing differed, hid it).
  const pushPayload = () => [...shared.nativeModels.values()].filter(entry => isUpstreamUid(entry?.uid));
  const pushKey = () => shared.localNativeModels.size + ':' + pushPayload().length + ':' + shared.nativeAllowedUids.size + ':' +
    pushPayload().filter(entry => entry.sidekickDimension || entry.fusionMetadata).length;
  shared.pushToBackend = () => {
    if (lifecycle.activationDisposed || config().enabled === false || shared.pushTimer !== undefined) return;
    // Nothing to offer yet: do not spend the key on an empty payload, or the
    // first useful observation will look unchanged.
    if (!pushPayload().length) return;
    const key = pushKey();
    if (key === shared.lastPushKey) return;
    const wait = Math.max(0, shared.lastPushAt + PUSH_INTERVAL_MS - Date.now());
    shared.pushTimer = setTimeout(() => {
      shared.pushTimer = undefined;
      if (lifecycle.activationDisposed || config().enabled === false) return;
      shared.lastPushAt = Date.now();
      shared.lastPushKey = key;
      pushNativeModels({ root: deps.root, models: pushPayload(), allowedUids: [...shared.nativeAllowedUids] })
        .then(result => {
          if (result?.pushed) log('native-push', { pushed: result.pushed, count: result.count, improved: result.improved === true });
          else if (result?.reason && result.reason !== 'empty') log('native-push-skip', { reason: result.reason });
        })
        .catch(() => {});
    }, wait);
    shared.pushTimer.unref?.();
  };
  shared.refreshNativeModels = () => {
    if (lifecycle.activationDisposed || config().enabled === false) return Promise.resolve();
    if (shared.syncPending) return shared.syncPending;
    const generation = lifecycle.activationGeneration;
    const abort = new AbortController(); shared.syncAbort = abort;
    shared.syncPending = (async () => {
      let result;
      try { result = await readNativeModels({ root: deps.root, signal: abort.signal }); }
      catch { result = { status: 'unavailable', models: [] }; }
      if (abort.signal.aborted || generation !== lifecycle.activationGeneration || lifecycle.activationDisposed || config().enabled === false) return;
      shared.nativeCatalogStatus = result.status;
      shared.nativeModels.clear();
      // Both channels observe the same upstream catalog from different sides —
      // the backend sees the CLI's traffic, this host sees the native
      // extension's — and their copies are not equally complete. Merge instead
      // of letting the last one win: a dimension-less copy makes every native
      // Sidekick unresolvable and the mirrored combinations vanish.
      for (const entry of shared.localNativeModels.values()) shared.nativeModels.set(entry.uid, entry);
      for (const entry of result.models) shared.nativeModels.set(entry.uid, mergeNativeEntry(shared.nativeModels.get(entry.uid), entry));
      if (Array.isArray(result.allowedUids) && result.allowedUids.length) shared.nativeAllowedUids = new Set(result.allowedUids);
      try { await shared.management?.publish(); } catch {}
      shared.updateStatusBar();
      if (shared.nativeModels.size !== shared.nativeSyncSize) { shared.nativeSyncSize = shared.nativeModels.size; log('native-sync', { count: shared.nativeSyncSize }); }
      shared.pickerRefresh?.changed?.();
      shared.checkCliCaches?.();
      shared.pushToBackend();
    })().finally(() => { if (shared.syncAbort === abort) { shared.syncAbort = undefined; shared.syncPending = undefined; } });
    return shared.syncPending;
  };
  shared.startNativeSync = () => {
    lifecycle.stopNativeSync?.();
    lifecycle.stopNativeSync = () => { clearInterval(shared.syncTimer); shared.syncAbort?.abort(); shared.syncAbort = undefined; shared.syncPending = undefined;
      if (shared.pushTimer !== undefined) { clearTimeout(shared.pushTimer); shared.pushTimer = undefined; } };
    shared.syncTimer = setInterval(() => { void shared.refreshNativeModels(); }, 3000); shared.syncTimer.unref?.();
    void shared.refreshNativeModels();
  };
  shared.observeNativeModels = entries => {
    if (!Array.isArray(entries)) return;
    let changed = false;
    for (const entry of entries) {
      if (!entry || typeof entry.uid !== 'string' || !entry.uid) continue;
      const dimension = entry.sidekickDimension;
      const next = { uid: entry.uid, label: typeof entry.label === 'string' ? entry.label : '', disabled: entry.disabled === true,
        isModelRouter: entry.isModelRouter === true,
        harnessUids: Array.isArray(entry.harnessUids) ? entry.harnessUids.filter(value => typeof value === 'string') : [],
        ...(dimension && typeof dimension === 'object'
          ? { sidekickDimension: { order: dimension.order, name: dimension.name, fastModeOrder: dimension.fastModeOrder } } : {}),
        ...(Array.isArray(entry.fusionMetadata) ? { fusionMetadata: entry.fusionMetadata } : {}),
        ...(entry.maxTokens ? { maxTokens: entry.maxTokens } : {}),
        ...(entry.maxOutputTokens ? { maxOutputTokens: entry.maxOutputTokens } : {}),
        ...(entry.supportsImages ? { supportsImages: true } : {}),
        ...(Number.isSafeInteger(entry.kind) ? { kind: entry.kind } : {}),
        ...(entry.listed === true ? { listed: true } : {}),
        ...(typeof entry.pickerListed === 'boolean' ? { pickerListed: entry.pickerListed } : {}),
        ...(Array.isArray(entry.sources)
          ? { sources: entry.sources.filter(value => typeof value === 'string' && value.length <= 32).slice(0, 8) } : {}) };
      const previous = shared.nativeModels.get(next.uid);
      const merged = mergeNativeEntry(previous, next);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(merged)) {
        shared.localNativeModels.set(next.uid, merged); shared.nativeModels.set(next.uid, merged); changed = true;
      }
    }
    if (changed && !lifecycle.activationDisposed) try {
      void shared.management?.publish()?.catch(() => {}); shared.updateStatusBar(); shared.pickerRefresh?.changed?.(); shared.checkCliCaches?.();
      shared.pushToBackend();
    } catch {}
  };
}

module.exports = { installCatalogSync };

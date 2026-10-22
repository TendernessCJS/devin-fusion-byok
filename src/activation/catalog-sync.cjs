'use strict';
const { readNativeModels, pushNativeModels, isUpstreamUid } = require('../runtime/native-models.cjs');
const { mergeNativeEntry, normalizeNativeEntry, normalizeAllowedUids } = require('../native-entry.cjs');

function installCatalogSync({ deps, shared }) {
  const { lifecycle, config, log } = deps;
  const PUSH_INTERVAL_MS = 5 * 1000;
  const ALLOWED_UNRESTRICTED_STREAK = 3;
  shared.nativeAllowedMode = 'restricted';
  shared.nativeAllowedEmptyStreak = 0;
  // The push gate tracks what was actually accepted, not what was attempted:
  // shared.nativeRevision increments whenever the local catalog or the allowed
  // uid set changes, and lastPushedRevision advances only after a push the
  // backend accepted. A failed or skipped attempt therefore retries on the
  // next refresh instead of silently pinning the revision it claimed.
  const pushPayload = () => [...shared.nativeModels.values()].filter(entry => isUpstreamUid(entry?.uid));
  // This host's own observations, kept across refreshes. The published view
  // (shared.nativeModels) is rebuilt from this pool plus the backend's copy on
  // every refresh, so the view stays derived instead of becoming a second
  // store that can drift from the channel that produced it.
  const observed = new Map();
  // One fan-out for "the published catalog changed". Both channels must go
  // through it: a hand-rolled subset is how the `native-sync` size log ended up
  // missing on the observation channel while the refresh channel logged it,
  // which made that counter under-report.
  const commit = ({ bumpRevision }) => {
    if (lifecycle.activationDisposed) return Promise.resolve();
    if (bumpRevision) shared.nativeRevision += 1;
    const published = Promise.resolve(shared.management?.publish()).catch(() => {});
    shared.updateStatusBar();
    if (shared.nativeModels.size !== shared.nativeSyncSize) { shared.nativeSyncSize = shared.nativeModels.size; log('native-sync', { count: shared.nativeSyncSize }); }
    shared.pickerRefresh?.changed?.();
    shared.checkCliCaches?.();
    shared.pushToBackend();
    return published;
  };
  shared.pushToBackend = () => {
    if (lifecycle.activationDisposed || config().enabled === false || shared.pushTimer !== undefined) return;
    // Nothing to offer yet: an empty payload must not advance the pushed
    // revision, or the first useful observation will look unchanged.
    if (!pushPayload().length) return;
    const forced = shared.nativePushStale === true;
    if (!forced && !(shared.nativeRevision > shared.lastPushedRevision)) return;
    const wait = Math.max(0, shared.lastPushAt + PUSH_INTERVAL_MS - Date.now());
    shared.pushTimer = setTimeout(() => {
      shared.pushTimer = undefined;
      if (lifecycle.activationDisposed || config().enabled === false) return;
      shared.lastPushAt = Date.now();
      shared.nativePushStale = false;
      const revision = shared.nativeRevision;
      pushNativeModels({ root: deps.root, models: pushPayload(), allowedUids: [...shared.nativeAllowedUids], allowedMode: shared.nativeAllowedMode, revision })
        .then(result => {
          if (result?.pushed) {
            if (revision > shared.lastPushedRevision) shared.lastPushedRevision = revision;
            if (result.revision !== undefined && result.revision !== revision) {
              log('native-push-revision-mismatch', { sent: revision, echoed: result.revision });
            }
            log('native-push', { pushed: result.pushed, count: result.count, improved: result.improved === true });
          } else if (result?.reason && result.reason !== 'empty') log('native-push-skip', { reason: result.reason });
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
      // A failed read is not an empty catalog. Rebuilding from an unavailable
      // answer publishes 0 entries for as long as a backend swap takes
      // (measured 12s across a source-identity change), which the picker and
      // the status bar render as "no models". Only an authoritative answer
      // (ready/empty/unsupported) may replace the view; the entries at risk are
      // the backend-sourced ones, since locally observed ones are re-added below.
      if (result.status === 'unavailable' && shared.nativeModels.size) {
        log('native-refresh-retained', { status: result.status, count: shared.nativeModels.size });
        await commit({ bumpRevision: false });
        return;
      }
      // A refresh rebuilds the merged view from scratch, so the revision bump
      // needs a content comparison against the previous map — same
      // JSON.stringify yardstick observeNativeModels already uses.
      const previousByUid = new Map([...shared.nativeModels].map(([uid, entry]) => [uid, JSON.stringify(entry)]));
      shared.nativeModels.clear();
      // Both channels observe the same upstream catalog from different sides —
      // the backend sees the CLI's traffic, this host sees the native
      // extension's — and their copies are not equally complete. Merge instead
      // of letting the last one win: a dimension-less copy makes every native
      // Sidekick unresolvable and the mirrored combinations vanish.
      for (const entry of observed.values()) shared.nativeModels.set(entry.uid, entry);
      // Uids this host observed itself are decided by the host copy: the
      // backend's older entry must not downgrade label/disabled. Backend-only
      // entries are adopted with the backend copy as incoming, so fields the
      // host never saw (kind/familyUid/sources) are still carried.
      for (const entry of result.models) {
        const prior = shared.nativeModels.get(entry.uid);
        shared.nativeModels.set(entry.uid, observed.has(entry.uid) ? mergeNativeEntry(entry, prior) : mergeNativeEntry(prior, entry));
      }
      let changed = shared.nativeModels.size !== previousByUid.size;
      if (!changed) {
        for (const [uid, entry] of shared.nativeModels) {
          if (previousByUid.get(uid) !== JSON.stringify(entry)) { changed = true; break; }
        }
      }
      // Once this host has an authoritative allowlist (its own observation, or
      // one cold-start adoption below), a backend echo is advisory only: an
      // older copy must not roll the set back. A mismatch is logged once per
      // divergence spell; an empty echo additionally means the backend lost the
      // list, which arms a forced repush.
      if (Array.isArray(result.allowedUids)) {
        const echoMode = result.allowedMode === 'unrestricted' ? 'unrestricted' : 'restricted';
        const next = new Set(result.allowedUids);
        const same = next.size === shared.nativeAllowedUids.size && ![...next].some(uid => !shared.nativeAllowedUids.has(uid));
        if (shared.nativeAllowedObserved === true) {
          if (echoMode === 'restricted' && next.size === 0) {
            // Unrestricted hosts read an empty echo as agreement, not loss.
            if (shared.nativeAllowedMode === 'restricted' && shared.nativeAllowedUids.size > 0 && shared.nativePushStale !== true) {
              shared.nativePushStale = true;
              log('native-allowed-backend-lost', { count: shared.nativeAllowedUids.size });
            }
          } else shared.nativePushStale = false;
          if (!same) {
            if (shared.nativeAllowedDiverged !== true) {
              shared.nativeAllowedDiverged = true;
              log('native-allowed-diverged', { host: shared.nativeAllowedUids.size, backend: next.size });
            }
          } else shared.nativeAllowedDiverged = false;
        } else if (echoMode === 'unrestricted') {
          if (shared.nativeAllowedMode !== 'unrestricted' || shared.nativeAllowedUids.size) changed = true;
          shared.nativeAllowedMode = 'unrestricted';
          shared.nativeAllowedUids = new Set();
          shared.nativeAllowedObserved = true;
        } else if (next.size) {
          if (!same) { shared.nativeAllowedUids = next; changed = true; }
          shared.nativeAllowedObserved = true;
        }
      }
      await commit({ bumpRevision: changed });
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
  shared.observeAllowedUids = observation => {
    if (lifecycle.activationDisposed || config().enabled === false) return;
    if (observation?.kind === 'unrestricted') {
      // "Empty" is a weak signal (proto3 cannot tell absent from present-but-
      // empty), so flipping to unrestricted requires a streak; a restricted
      // observation below restores in a single pass. A host that never saw a
      // restricted verdict ignores the streak entirely — the backend's
      // cold-start echo is its only way to learn it is unrestricted.
      if (shared.nativeAllowedMode === 'unrestricted') return;
      shared.nativeAllowedEmptyStreak += 1;
      if (shared.nativeAllowedObserved !== true || shared.nativeAllowedEmptyStreak < ALLOWED_UNRESTRICTED_STREAK) return;
      shared.nativeAllowedEmptyStreak = 0;
      const cleared = shared.nativeAllowedUids.size;
      shared.nativeAllowedUids = new Set();
      shared.nativeAllowedMode = 'unrestricted';
      shared.nativeAllowedObserved = true;
      log('native-allowed-cleared', { cleared });
      void commit({ bumpRevision: true });
      return;
    }
    shared.nativeAllowedEmptyStreak = 0;
    const normalized = normalizeAllowedUids(observation?.uids || []);
    if (!normalized.length) return;
    if (shared.nativeAllowedMode === 'unrestricted') shared.nativeAllowedMode = 'restricted';
    if (normalized.length === shared.nativeAllowedUids.size && normalized.every(uid => shared.nativeAllowedUids.has(uid))) return;
    shared.nativeAllowedUids = new Set(normalized);
    shared.nativeAllowedObserved = true;
    void commit({ bumpRevision: true });
  };
  shared.observeNativeModels = entries => {
    if (!Array.isArray(entries)) return;
    let changed = false;
    for (const entry of entries) {
      const next = normalizeNativeEntry(entry);
      if (!next) continue;
      const previous = shared.nativeModels.get(next.uid);
      const merged = mergeNativeEntry(previous, next);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(merged)) {
        observed.set(next.uid, merged); shared.nativeModels.set(next.uid, merged); changed = true;
      }
    }
    if (changed && !lifecycle.activationDisposed) try { void commit({ bumpRevision: true }); } catch {}
  };
}

module.exports = { installCatalogSync };

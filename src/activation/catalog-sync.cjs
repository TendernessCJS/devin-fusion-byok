'use strict';
const { readNativeModels, pushNativeModels, isUpstreamUid } = require('../runtime/host/native-models.cjs');
const { mergeNativeEntry, normalizeNativeEntry, normalizeAllowedUids } = require('../models/native-entry.cjs');

function createCatalogSync({ root, config, lifecycleView, log, onChange, pushIntervalMs = 5000 }) {
  const ALLOWED_UNRESTRICTED_STREAK = 3;
  const nativeModels = new Map();
  // Complete-set verdict from team settings: whichever observation arrived
  // last decides which official uids the account may actually select.
  let nativeAllowedUids = new Set();
  let nativeAllowedMode = 'restricted', nativeAllowedEmptyStreak = 0;
  let nativeAllowedObserved = false, nativeAllowedDiverged = false;
  let nativeCatalogStatus = 'loading', nativeAuthoritative = false;
  let nativeRevision = 0, lastPushedRevision = 0, nativeSyncSize = -1;
  let nativePushStale = false;
  let pushTimer, lastPushAt = 0;
  let syncAbort, syncPending, syncTimer;
  // The push gate tracks what was actually accepted, not what was attempted:
  // nativeRevision increments whenever the local catalog or the allowed
  // uid set changes, and lastPushedRevision advances only after a push the
  // backend accepted. A failed or skipped attempt therefore retries on the
  // next refresh instead of silently pinning the revision it claimed.
  const pushPayload = () => [...nativeModels.values()].filter(entry => isUpstreamUid(entry?.uid));
  // This host's own observations, kept across refreshes. The published view
  // (nativeModels) is rebuilt from this pool plus the backend's copy on
  // every refresh, so the view stays derived instead of becoming a second
  // store that can drift from the channel that produced it.
  const observed = new Map();
  // One fan-out for "the published catalog changed". Both channels must go
  // through it: a hand-rolled subset is how the `native-sync` size log ended up
  // missing on the observation channel while the refresh channel logged it,
  // which made that counter under-report.
  const commit = ({ bumpRevision }) => {
    if (lifecycleView.isDisposed()) return Promise.resolve();
    if (bumpRevision) { nativeRevision += 1; }
    if (nativeModels.size !== nativeSyncSize) { nativeSyncSize = nativeModels.size; log('native-sync', { count: nativeSyncSize }); }
    const published = Promise.resolve(onChange?.()).catch(() => {});
    pushToBackend();
    return published;
  };
  const markUnsupported = () => { nativeCatalogStatus = 'unsupported'; };
  const pushToBackend = () => {
    if (!lifecycleView.isLive() || pushTimer !== undefined) return;
    // Nothing to offer yet: an empty payload must not advance the pushed
    // revision, or the first useful observation will look unchanged.
    if (!pushPayload().length) return;
    const forced = nativePushStale === true;
    if (!forced && !(nativeRevision > lastPushedRevision)) return;
    const wait = Math.max(0, lastPushAt + pushIntervalMs - Date.now());
    pushTimer = setTimeout(() => {
      pushTimer = undefined;
      if (!lifecycleView.isLive()) return;
      lastPushAt = Date.now();
      nativePushStale = false;
      const revision = nativeRevision;
      pushNativeModels({ root, models: pushPayload(), allowedUids: [...nativeAllowedUids], allowedMode: nativeAllowedMode, revision })
        .then(result => {
          if (result?.pushed) {
            if (revision > lastPushedRevision) lastPushedRevision = revision;
            if (result.revision !== undefined && result.revision !== revision) {
              log('native-push-revision-mismatch', { sent: revision, echoed: result.revision });
            }
            log('native-push', { pushed: result.pushed, count: result.count, improved: result.improved === true });
          } else if (result?.reason && result.reason !== 'empty') log('native-push-skip', { reason: result.reason });
        })
        .catch(() => {});
    }, wait);
    pushTimer.unref?.();
  };
  const refresh = () => {
    if (!lifecycleView.isLive()) return Promise.resolve();
    if (syncPending) return syncPending;
    const generation = lifecycleView.generation();
    const abort = new AbortController(); syncAbort = abort;
    syncPending = (async () => {
      let result;
      try { result = await readNativeModels({ root, signal: abort.signal }); }
      catch { result = { status: 'unavailable', models: [] }; }
      if (abort.signal.aborted || lifecycleView.isSuperseded(generation) || lifecycleView.isDisposed()) return;
      nativeCatalogStatus = result.status;
      // The first transition into an authoritative state must bump the
      // revision even when the models are identical: the activation-time cache
      // check ran additive-only before this point, and the owed retirement
      // has to be triggered exactly once when authority arrives.
      const authoritative = result.status === 'ready' || result.status === 'empty' || result.status === 'unsupported';
      const authorityFlip = authoritative && nativeAuthoritative !== true;
      nativeAuthoritative = authoritative;
      // A failed read is not an empty catalog. Rebuilding from an unavailable
      // answer publishes 0 entries for as long as a backend swap takes
      // (measured 12s across a source-identity change), which the picker and
      // the status bar render as "no models". Only an authoritative answer
      // (ready/empty/unsupported) may replace the view; the entries at risk are
      // the backend-sourced ones, since locally observed ones are re-added below.
      if (result.status === 'unavailable' && nativeModels.size) {
        log('native-refresh-retained', { status: result.status, count: nativeModels.size });
        await commit({ bumpRevision: authorityFlip });
        return;
      }
      // A refresh rebuilds the merged view from scratch, so the revision bump
      // needs a content comparison against the previous map — same
      // JSON.stringify yardstick observeModels already uses.
      const previousByUid = new Map([...nativeModels].map(([uid, entry]) => [uid, JSON.stringify(entry)]));
      nativeModels.clear();
      // Both channels observe the same upstream catalog from different sides —
      // the backend sees the CLI's traffic, this host sees the native
      // extension's — and their copies are not equally complete. Merge instead
      // of letting the last one win: a dimension-less copy makes every native
      // Sidekick unresolvable and the mirrored combinations vanish.
      for (const entry of observed.values()) nativeModels.set(entry.uid, entry);
      // Uids this host observed itself are decided by the host copy: the
      // backend's older entry must not downgrade label/disabled. Backend-only
      // entries are adopted with the backend copy as incoming, so fields the
      // host never saw (kind/familyUid/sources) are still carried.
      for (const entry of result.models) {
        const prior = nativeModels.get(entry.uid);
        nativeModels.set(entry.uid, observed.has(entry.uid) ? mergeNativeEntry(entry, prior) : mergeNativeEntry(prior, entry));
      }
      let changed = authorityFlip || nativeModels.size !== previousByUid.size;
      if (!changed) {
        for (const [uid, entry] of nativeModels) {
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
        const same = next.size === nativeAllowedUids.size && ![...next].some(uid => !nativeAllowedUids.has(uid));
        if (nativeAllowedObserved === true) {
          if (echoMode === 'restricted' && next.size === 0) {
            // Unrestricted hosts read an empty echo as agreement, not loss.
            if (nativeAllowedMode === 'restricted' && nativeAllowedUids.size > 0 && nativePushStale !== true) {
              nativePushStale = true;
              log('native-allowed-backend-lost', { count: nativeAllowedUids.size });
            }
          } else nativePushStale = false;
          if (!same) {
            if (nativeAllowedDiverged !== true) {
              nativeAllowedDiverged = true;
              log('native-allowed-diverged', { host: nativeAllowedUids.size, backend: next.size });
            }
          } else nativeAllowedDiverged = false;
        } else if (echoMode === 'unrestricted') {
          if (nativeAllowedMode !== 'unrestricted' || nativeAllowedUids.size) changed = true;
          nativeAllowedMode = 'unrestricted';
          nativeAllowedUids = new Set();
          nativeAllowedObserved = true;
        } else if (next.size) {
          if (!same) { nativeAllowedUids = next; changed = true; }
          nativeAllowedObserved = true;
        }
      }
      await commit({ bumpRevision: changed });
    })().finally(() => { if (syncAbort === abort) { syncAbort = undefined; syncPending = undefined; } });
    return syncPending;
  };
  const start = () => {
    stop();
    syncTimer = setInterval(() => { void refresh(); }, 3000); syncTimer.unref?.();
    void refresh();
  };
  const stop = () => {
    clearInterval(syncTimer); syncTimer = undefined;
    syncAbort?.abort(); syncAbort = undefined; syncPending = undefined;
    if (pushTimer !== undefined) { clearTimeout(pushTimer); pushTimer = undefined; }
  };
  const observeAllowed = observation => {
    if (!lifecycleView.isLive()) return;
    if (observation?.kind === 'unrestricted') {
      // "Empty" is a weak signal (proto3 cannot tell absent from present-but-
      // empty), so flipping to unrestricted requires a streak; a restricted
      // observation below restores in a single pass. A host that never saw a
      // restricted verdict ignores the streak entirely — the backend's
      // cold-start echo is its only way to learn it is unrestricted.
      if (nativeAllowedMode === 'unrestricted') return;
      nativeAllowedEmptyStreak += 1;
      if (nativeAllowedObserved !== true || nativeAllowedEmptyStreak < ALLOWED_UNRESTRICTED_STREAK) return;
      nativeAllowedEmptyStreak = 0;
      const cleared = nativeAllowedUids.size;
      nativeAllowedUids = new Set();
      nativeAllowedMode = 'unrestricted';
      nativeAllowedObserved = true;
      log('native-allowed-cleared', { cleared });
      void commit({ bumpRevision: true });
      return;
    }
    nativeAllowedEmptyStreak = 0;
    const normalized = normalizeAllowedUids(observation?.uids || []);
    if (!normalized.length) return;
    if (nativeAllowedMode === 'unrestricted') nativeAllowedMode = 'restricted';
    if (normalized.length === nativeAllowedUids.size && normalized.every(uid => nativeAllowedUids.has(uid))) return;
    nativeAllowedUids = new Set(normalized);
    nativeAllowedObserved = true;
    void commit({ bumpRevision: true });
  };
  const observeModels = entries => {
    if (!Array.isArray(entries)) return;
    let changed = false;
    for (const entry of entries) {
      const next = normalizeNativeEntry(entry);
      if (!next) continue;
      const previous = nativeModels.get(next.uid);
      const merged = mergeNativeEntry(previous, next);
      // Source authority registers on every valid observation — even one equal
      // to the current entry — so a later stale backend copy cannot win. Only
      // a real content change republishes or bumps the revision.
      observed.set(next.uid, merged);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(merged)) {
        nativeModels.set(next.uid, merged); changed = true;
      }
    }
    if (changed && !lifecycleView.isDisposed()) try { void commit({ bumpRevision: true }); } catch {}
  };
  const read = () => ({ models: structuredClone([...nativeModels.values()]), allowedUids: new Set(nativeAllowedUids),
    allowedMode: nativeAllowedMode, status: nativeCatalogStatus });
  const diagnostics = () => ({ revision: nativeRevision, lastPushedRevision, pushStale: nativePushStale,
    authoritative: nativeAuthoritative, syncSize: nativeSyncSize,
    allowedObserved: nativeAllowedObserved, allowedDiverged: nativeAllowedDiverged, emptyStreak: nativeAllowedEmptyStreak });
  return { read, observeModels, observeAllowed, refresh, markUnsupported, start, stop, diagnostics };
}

module.exports = { createCatalogSync };

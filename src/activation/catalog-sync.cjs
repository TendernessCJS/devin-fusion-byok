'use strict';
const { readNativeModels, pushNativeModels, isUpstreamUid } = require('../runtime/host/native-models.cjs');
const { mergeNativeEntry, normalizeNativeEntry, normalizeAllowedUids } = require('../models/native-entry.cjs');
const { live, superseded } = require('./liveness.cjs');

function installCatalogSync({ deps, shared, onChange }) {
  const { lifecycle, config, log, stores } = deps;
  const PUSH_INTERVAL_MS = 5 * 1000;
  const ALLOWED_UNRESTRICTED_STREAK = 3;
  stores.nativeCatalog.nativeAllowedMode = 'restricted';
  stores.nativeCatalog.nativeAllowedEmptyStreak = 0;
  // The push gate tracks what was actually accepted, not what was attempted:
  // stores.nativeCatalog.nativeRevision increments whenever the local catalog or the allowed
  // uid set changes, and lastPushedRevision advances only after a push the
  // backend accepted. A failed or skipped attempt therefore retries on the
  // next refresh instead of silently pinning the revision it claimed.
  const pushPayload = () => [...stores.nativeCatalog.nativeModels.values()].filter(entry => isUpstreamUid(entry?.uid));
  // This host's own observations, kept across refreshes. The published view
  // (stores.nativeCatalog.nativeModels) is rebuilt from this pool plus the backend's copy on
  // every refresh, so the view stays derived instead of becoming a second
  // store that can drift from the channel that produced it.
  const observed = new Map();
  // One fan-out for "the published catalog changed". Both channels must go
  // through it: a hand-rolled subset is how the `native-sync` size log ended up
  // missing on the observation channel while the refresh channel logged it,
  // which made that counter under-report.
  const commit = ({ bumpRevision }) => {
    if (lifecycle.activationDisposed) return Promise.resolve();
    if (bumpRevision) { stores.nativeCatalog.nativeRevision += 1; lifecycle.publication?.changed(); }
    if (stores.nativeCatalog.nativeModels.size !== stores.nativeCatalog.nativeSyncSize) { stores.nativeCatalog.nativeSyncSize = stores.nativeCatalog.nativeModels.size; log('native-sync', { count: stores.nativeCatalog.nativeSyncSize }); }
    const published = Promise.resolve(onChange?.()).catch(() => {});
    stores.nativeCatalog.pushToBackend();
    return published;
  };
  stores.nativeCatalog.pushToBackend = () => {
    if (!live(lifecycle, config) || stores.nativeCatalog.pushTimer !== undefined) return;
    // Nothing to offer yet: an empty payload must not advance the pushed
    // revision, or the first useful observation will look unchanged.
    if (!pushPayload().length) return;
    const forced = stores.nativeCatalog.nativePushStale === true;
    if (!forced && !(stores.nativeCatalog.nativeRevision > stores.nativeCatalog.lastPushedRevision)) return;
    const wait = Math.max(0, stores.nativeCatalog.lastPushAt + PUSH_INTERVAL_MS - Date.now());
    stores.nativeCatalog.pushTimer = setTimeout(() => {
      stores.nativeCatalog.pushTimer = undefined;
      if (!live(lifecycle, config)) return;
      stores.nativeCatalog.lastPushAt = Date.now();
      stores.nativeCatalog.nativePushStale = false;
      const revision = stores.nativeCatalog.nativeRevision;
      pushNativeModels({ root: deps.root, models: pushPayload(), allowedUids: [...stores.nativeCatalog.nativeAllowedUids], allowedMode: stores.nativeCatalog.nativeAllowedMode, revision })
        .then(result => {
          if (result?.pushed) {
            if (revision > stores.nativeCatalog.lastPushedRevision) stores.nativeCatalog.lastPushedRevision = revision;
            if (result.revision !== undefined && result.revision !== revision) {
              log('native-push-revision-mismatch', { sent: revision, echoed: result.revision });
            }
            log('native-push', { pushed: result.pushed, count: result.count, improved: result.improved === true });
          } else if (result?.reason && result.reason !== 'empty') log('native-push-skip', { reason: result.reason });
        })
        .catch(() => {});
    }, wait);
    stores.nativeCatalog.pushTimer.unref?.();
  };
  stores.nativeCatalog.refreshNativeModels = () => {
    if (!live(lifecycle, config)) return Promise.resolve();
    if (stores.nativeCatalog.syncPending) return stores.nativeCatalog.syncPending;
    const generation = lifecycle.activationGeneration;
    const abort = new AbortController(); stores.nativeCatalog.syncAbort = abort;
    stores.nativeCatalog.syncPending = (async () => {
      let result;
      try { result = await readNativeModels({ root: deps.root, signal: abort.signal }); }
      catch { result = { status: 'unavailable', models: [] }; }
      if (abort.signal.aborted || superseded(lifecycle, config, generation) || lifecycle.activationDisposed) return;
      stores.nativeCatalog.nativeCatalogStatus = result.status;
      // The first transition into an authoritative state must bump the
      // revision even when the models are identical: the activation-time cache
      // check ran additive-only before this point, and the owed retirement
      // has to be triggered exactly once when authority arrives.
      const authoritative = result.status === 'ready' || result.status === 'empty' || result.status === 'unsupported';
      const authorityFlip = authoritative && stores.nativeCatalog.nativeAuthoritative !== true;
      stores.nativeCatalog.nativeAuthoritative = authoritative;
      // A failed read is not an empty catalog. Rebuilding from an unavailable
      // answer publishes 0 entries for as long as a backend swap takes
      // (measured 12s across a source-identity change), which the picker and
      // the status bar render as "no models". Only an authoritative answer
      // (ready/empty/unsupported) may replace the view; the entries at risk are
      // the backend-sourced ones, since locally observed ones are re-added below.
      if (result.status === 'unavailable' && stores.nativeCatalog.nativeModels.size) {
        log('native-refresh-retained', { status: result.status, count: stores.nativeCatalog.nativeModels.size });
        await commit({ bumpRevision: authorityFlip });
        return;
      }
      // A refresh rebuilds the merged view from scratch, so the revision bump
      // needs a content comparison against the previous map — same
      // JSON.stringify yardstick observeNativeModels already uses.
      const previousByUid = new Map([...stores.nativeCatalog.nativeModels].map(([uid, entry]) => [uid, JSON.stringify(entry)]));
      stores.nativeCatalog.nativeModels.clear();
      // Both channels observe the same upstream catalog from different sides —
      // the backend sees the CLI's traffic, this host sees the native
      // extension's — and their copies are not equally complete. Merge instead
      // of letting the last one win: a dimension-less copy makes every native
      // Sidekick unresolvable and the mirrored combinations vanish.
      for (const entry of observed.values()) stores.nativeCatalog.nativeModels.set(entry.uid, entry);
      // Uids this host observed itself are decided by the host copy: the
      // backend's older entry must not downgrade label/disabled. Backend-only
      // entries are adopted with the backend copy as incoming, so fields the
      // host never saw (kind/familyUid/sources) are still carried.
      for (const entry of result.models) {
        const prior = stores.nativeCatalog.nativeModels.get(entry.uid);
        stores.nativeCatalog.nativeModels.set(entry.uid, observed.has(entry.uid) ? mergeNativeEntry(entry, prior) : mergeNativeEntry(prior, entry));
      }
      let changed = authorityFlip || stores.nativeCatalog.nativeModels.size !== previousByUid.size;
      if (!changed) {
        for (const [uid, entry] of stores.nativeCatalog.nativeModels) {
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
        const same = next.size === stores.nativeCatalog.nativeAllowedUids.size && ![...next].some(uid => !stores.nativeCatalog.nativeAllowedUids.has(uid));
        if (stores.nativeCatalog.nativeAllowedObserved === true) {
          if (echoMode === 'restricted' && next.size === 0) {
            // Unrestricted hosts read an empty echo as agreement, not loss.
            if (stores.nativeCatalog.nativeAllowedMode === 'restricted' && stores.nativeCatalog.nativeAllowedUids.size > 0 && stores.nativeCatalog.nativePushStale !== true) {
              stores.nativeCatalog.nativePushStale = true;
              log('native-allowed-backend-lost', { count: stores.nativeCatalog.nativeAllowedUids.size });
            }
          } else stores.nativeCatalog.nativePushStale = false;
          if (!same) {
            if (stores.nativeCatalog.nativeAllowedDiverged !== true) {
              stores.nativeCatalog.nativeAllowedDiverged = true;
              log('native-allowed-diverged', { host: stores.nativeCatalog.nativeAllowedUids.size, backend: next.size });
            }
          } else stores.nativeCatalog.nativeAllowedDiverged = false;
        } else if (echoMode === 'unrestricted') {
          if (stores.nativeCatalog.nativeAllowedMode !== 'unrestricted' || stores.nativeCatalog.nativeAllowedUids.size) changed = true;
          stores.nativeCatalog.nativeAllowedMode = 'unrestricted';
          stores.nativeCatalog.nativeAllowedUids = new Set();
          stores.nativeCatalog.nativeAllowedObserved = true;
        } else if (next.size) {
          if (!same) { stores.nativeCatalog.nativeAllowedUids = next; changed = true; }
          stores.nativeCatalog.nativeAllowedObserved = true;
        }
      }
      await commit({ bumpRevision: changed });
    })().finally(() => { if (stores.nativeCatalog.syncAbort === abort) { stores.nativeCatalog.syncAbort = undefined; stores.nativeCatalog.syncPending = undefined; } });
    return stores.nativeCatalog.syncPending;
  };
  stores.nativeCatalog.startNativeSync = () => {
    lifecycle.stopNativeSync?.();
    lifecycle.stopNativeSync = () => { clearInterval(stores.nativeCatalog.syncTimer); stores.nativeCatalog.syncAbort?.abort(); stores.nativeCatalog.syncAbort = undefined; stores.nativeCatalog.syncPending = undefined;
      if (stores.nativeCatalog.pushTimer !== undefined) { clearTimeout(stores.nativeCatalog.pushTimer); stores.nativeCatalog.pushTimer = undefined; } };
    stores.nativeCatalog.syncTimer = setInterval(() => { void stores.nativeCatalog.refreshNativeModels(); }, 3000); stores.nativeCatalog.syncTimer.unref?.();
    void stores.nativeCatalog.refreshNativeModels();
  };
  stores.nativeCatalog.observeAllowedUids = observation => {
    if (!live(lifecycle, config)) return;
    if (observation?.kind === 'unrestricted') {
      // "Empty" is a weak signal (proto3 cannot tell absent from present-but-
      // empty), so flipping to unrestricted requires a streak; a restricted
      // observation below restores in a single pass. A host that never saw a
      // restricted verdict ignores the streak entirely — the backend's
      // cold-start echo is its only way to learn it is unrestricted.
      if (stores.nativeCatalog.nativeAllowedMode === 'unrestricted') return;
      stores.nativeCatalog.nativeAllowedEmptyStreak += 1;
      if (stores.nativeCatalog.nativeAllowedObserved !== true || stores.nativeCatalog.nativeAllowedEmptyStreak < ALLOWED_UNRESTRICTED_STREAK) return;
      stores.nativeCatalog.nativeAllowedEmptyStreak = 0;
      const cleared = stores.nativeCatalog.nativeAllowedUids.size;
      stores.nativeCatalog.nativeAllowedUids = new Set();
      stores.nativeCatalog.nativeAllowedMode = 'unrestricted';
      stores.nativeCatalog.nativeAllowedObserved = true;
      log('native-allowed-cleared', { cleared });
      void commit({ bumpRevision: true });
      return;
    }
    stores.nativeCatalog.nativeAllowedEmptyStreak = 0;
    const normalized = normalizeAllowedUids(observation?.uids || []);
    if (!normalized.length) return;
    if (stores.nativeCatalog.nativeAllowedMode === 'unrestricted') stores.nativeCatalog.nativeAllowedMode = 'restricted';
    if (normalized.length === stores.nativeCatalog.nativeAllowedUids.size && normalized.every(uid => stores.nativeCatalog.nativeAllowedUids.has(uid))) return;
    stores.nativeCatalog.nativeAllowedUids = new Set(normalized);
    stores.nativeCatalog.nativeAllowedObserved = true;
    void commit({ bumpRevision: true });
  };
  stores.nativeCatalog.observeNativeModels = entries => {
    if (!Array.isArray(entries)) return;
    let changed = false;
    for (const entry of entries) {
      const next = normalizeNativeEntry(entry);
      if (!next) continue;
      const previous = stores.nativeCatalog.nativeModels.get(next.uid);
      const merged = mergeNativeEntry(previous, next);
      // Source authority registers on every valid observation — even one equal
      // to the current entry — so a later stale backend copy cannot win. Only
      // a real content change republishes or bumps the revision.
      observed.set(next.uid, merged);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(merged)) {
        stores.nativeCatalog.nativeModels.set(next.uid, merged); changed = true;
      }
    }
    if (changed && !lifecycle.activationDisposed) try { void commit({ bumpRevision: true }); } catch {}
  };
}

module.exports = { installCatalogSync };

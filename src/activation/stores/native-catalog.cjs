'use strict';
function createNativeCatalogState() {
  return {
    nativeModels: new Map(),
    // Complete-set verdict from team settings: whichever observation arrived
    // last decides which official uids the account may actually select.
    nativeAllowedUids: new Set(),
    nativeAllowedMode: 'restricted', nativeAllowedEmptyStreak: 0,
    nativeAllowedObserved: false, nativeAllowedDiverged: false,
    nativeCatalogStatus: 'loading', nativeAuthoritative: false,
    nativeRevision: 0, lastPushedRevision: 0, nativeSyncSize: -1,
    nativePushStale: false,
    pushTimer: undefined, lastPushAt: 0,
    pushToBackend: undefined, refreshNativeModels: undefined,
    startNativeSync: undefined, observeNativeModels: undefined, observeAllowedUids: undefined,
    syncAbort: undefined, syncPending: undefined, syncTimer: undefined,
  };
}
module.exports = { createNativeCatalogState };

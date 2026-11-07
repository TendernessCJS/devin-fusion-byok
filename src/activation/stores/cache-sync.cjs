'use strict';
function createCacheSyncState() {
  return { cliCacheReport: null, cliCacheDeferred: false, ownShapeSignature: undefined, hiddenNativeSignature: undefined };
}
module.exports = { createCacheSyncState };

'use strict';
function createCacheSyncState() {
  return { cliCacheReport: null, cliCacheDeferred: false, pickerRefresh: undefined, ownShapeSignature: undefined, hiddenNativeSignature: undefined };
}
module.exports = { createCacheSyncState };

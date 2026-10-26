'use strict';
function createCacheSyncState() {
  return { cliCacheReport: null, cliCacheDeferred: false, pickerRefresh: undefined };
}
module.exports = { createCacheSyncState };

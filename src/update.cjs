'use strict';
// Facade: implementation lives in ./update/updater.cjs; public surface unchanged.
const state = require('./update/updater.cjs');
module.exports = {
  REPOSITORY: state.REPOSITORY, PAGE: state.PAGE, compareVersions: state.compareVersions,
  parseVersion: state.parseVersion, releaseInfo: state.releaseInfo, allowedUrl: state.allowedUrl,
  requestBytes: state.requestBytes, verifyPackage: state.verifyPackage,
  createUpdater: state.createUpdater, createUpdateHost: state.createUpdateHost
};

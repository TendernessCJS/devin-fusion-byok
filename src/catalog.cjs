'use strict';
// Facade: implementation lives in ./catalog/*.cjs; public surface unchanged.
const { buildCatalog } = require('./catalog/build.cjs');
const { augmentCatalog, collectNativeModels, collectAllowedUids, staleFusionUids } = require('./catalog/augment.cjs');
const { resolveAssignment } = require('./catalog/assignment.cjs');
const { analyzeRoles, buildRoleLists } = require('./catalog/roles.cjs');
const { refKey } = require('./catalog/identity.cjs');
module.exports = { buildCatalog, augmentCatalog, resolveAssignment, collectNativeModels, collectAllowedUids, analyzeRoles, buildRoleLists, refKey, staleFusionUids };

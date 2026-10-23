'use strict';
const fs = require('node:fs');
const { BACKEND_URL } = require('../runtime/port.cjs');

function readConfig(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function defaultConfig() { return { enabled: true, providers: [] }; }
// Retired keys: everything the named-preset pipeline used to own, plus empty
// role override maps. The one-shot migration that lifted saved presets into
// `roleInclusions` has run everywhere this fork is installed (verified against
// the live config), so these are dead weight now — and a dead key with no
// cleanup path would sit in a user's config forever with no way to remove it
// from the panel.
function pruneRetiredKeys(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  let changed = false;
  for (const key of ['sidekicks', 'fusionPresets', 'defaultFusionUid', 'fusionMatrix']) {
    if (!Object.hasOwn(config, key)) continue;
    delete config[key];
    changed = true;
  }
  for (const key of ['roleExclusions', 'roleInclusions']) {
    if (!Object.hasOwn(config, key)) continue;
    const value = config[key];
    const roles = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    if (!roles || Object.values(roles).every(list => !Array.isArray(list) || list.length === 0)) { delete config[key]; changed = true; }
  }
  // inferenceServerUrl is derived from the runtime port, so a persisted copy
  // equal to the derived value is redundant and pruned; a different value is a
  // deliberate manual override and must survive.
  if (config.inferenceServerUrl === BACKEND_URL) { delete config.inferenceServerUrl; changed = true; }
  return changed;
}
module.exports = { readConfig, defaultConfig, pruneRetiredKeys };

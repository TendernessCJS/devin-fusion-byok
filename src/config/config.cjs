'use strict';
const fs = require('node:fs');

function readConfig(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function defaultConfig() { return { enabled: true, providers: [] }; }
function pruneLegacyUpdateProxy(config) {
  if (!Object.prototype.hasOwnProperty.call(config, 'updateProxy')) return false;
  delete config.updateProxy;
}
module.exports = { readConfig, defaultConfig, pruneLegacyUpdateProxy };

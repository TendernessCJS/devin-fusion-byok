'use strict';
const fs = require('node:fs');

function readConfig(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function defaultConfig() { return { enabled: true, providers: [] }; }
module.exports = { readConfig, defaultConfig };

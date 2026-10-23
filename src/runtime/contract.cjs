'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const SERVICE = 'devin-fusion-byok';
const VERSION = require('../../package.json').version;
const MANAGEMENT_PROTOCOL = 1;
function rootIdentity(root) {
  return { service: SERVICE, version: VERSION,
    rootId: crypto.createHash('sha256').update(path.resolve(root)).digest('hex') };
}
function controlFile(root) { return path.join(root, 'runtime-control.json'); }
module.exports = { SERVICE, VERSION, MANAGEMENT_PROTOCOL, rootIdentity, controlFile };

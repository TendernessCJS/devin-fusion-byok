'use strict';
const fs = require('node:fs');
const path = require('node:path');

function readConfig(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function defaultConfig() { return { enabled: true, providers: [] }; }
// An empty root starts a new install. A marker lets later activations keep
// normal config recovery without treating unmarked legacy bytes as current.
function admitStorage(root) {
  const marker = path.join(root, '.clean-install-v1');
  const admitted = () => {
    try { return fs.lstatSync(marker).isDirectory(); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  if (admitted()) return true;
  if (fs.readdirSync(root).length !== 0) return admitted();
  try { fs.mkdirSync(marker, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') return admitted(); throw error; }
  return true;
}
module.exports = { readConfig, defaultConfig, admitStorage };

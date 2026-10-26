'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BUILD_FILE = 'host-build.json';
const SKIP_DIRS = new Set(['node_modules', '.git']);

function sourceFiles(root) {
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name)); }
      else if (entry.name.endsWith('.cjs')) out.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, 'src'));
  return out.sort();
}

function hostBuildId(root) {
  const files = sourceFiles(root);
  if (!files.length) throw new Error('host_sources_missing');
  const hash = crypto.createHash('sha256');
  for (const name of files) hash.update(name).update('\0').update(fs.readFileSync(path.join(root, name))).update('\0');
  return { id: hash.digest('hex'), files: files.length };
}

function publishHostBuild({ root, extensionPath, version }) {
  try {
    const build = hostBuildId(extensionPath);
    const record = { ...build, version, extension: extensionPath, writtenAt: new Date().toISOString() };
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const target = path.join(root, BUILD_FILE), temporary = target + '.' + process.pid;
    fs.writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, target);
    return record;
  } catch { return null; }
}

module.exports = { hostBuildId, publishHostBuild, BUILD_FILE };

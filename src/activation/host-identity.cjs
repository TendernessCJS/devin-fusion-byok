'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BUILD_DIR = 'host-builds';
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

// One record per activation: the disk scan is diagnostic evidence of which
// sources were on disk at activate time, not a proof of the loaded modules.
function publishHostBuild({ root, extensionPath, version, activatedAt }) {
  let temporary, ownsTemporary = false;
  try {
    const build = hostBuildId(extensionPath);
    const instanceId = crypto.randomUUID();
    const recordFile = path.join(BUILD_DIR, `${process.pid}-${instanceId}.json`).split(path.sep).join('/');
    const record = { ...build, version, extension: extensionPath, writtenAt: new Date().toISOString(),
      pid: process.pid, instanceId, activatedAt: activatedAt || new Date().toISOString(),
      kind: 'disk-source-snapshot', recordFile };
    const dir = path.join(root, BUILD_DIR);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    temporary = path.join(dir, `${process.pid}-${instanceId}.tmp`);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    ownsTemporary = true;
    try { fs.writeFileSync(fd, JSON.stringify(record) + '\n'); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, path.join(root, recordFile));
    ownsTemporary = false;
    return record;
  } catch {
    if (ownsTemporary) try { fs.unlinkSync(temporary); } catch {}
    return null;
  }
}

module.exports = { hostBuildId, publishHostBuild, BUILD_DIR };

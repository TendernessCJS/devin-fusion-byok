'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { USAGE_REJECTIONS } = require('./context-state.cjs');
// Diagnostics exist for a human reading them after something went wrong, not for
// a live dashboard, so the write only has to stay recent enough to be useful.
// At the original 2s cadence every window left a file behind forever — 192 had
// accumulated, one per process that ever activated the extension.
const WRITE_INTERVAL_MS = 15000;
const SWEEP_INTERVAL_MS = 60000;
// A file is residue only when its owner is gone *and* nothing has touched it for
// a while. The age check is what protects a live window (its file is rewritten
// every write interval) and it also stops PID reuse from preserving a dead file
// or a freshly created one from being swept before its owner starts writing.
const STALE_AFTER_MS = 10 * 60 * 1000;
const FILE_NAME = /^(\d+)\.json$/;
function isRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}
function createContextDiagnostics({ root, version, readStatus, snapshot, pid = process.pid, intervalMs = WRITE_INTERVAL_MS }) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('Invalid process ID');
  const directory = path.join(root, 'context-diagnostics');
  const file = path.join(directory, `${pid}.json`), temporary = file + '.tmp';
  let disposed = false;
  function refresh() {
    try {
      const status = readStatus() || {}, sessions = snapshot() || [];
      const data = { schemaVersion: 1, pluginVersion: /^\d+\.\d+\.\d+$/.test(version) ? version : 'unknown', pid,
        writtenAt: new Date().toISOString(), state: disposed ? 'disposed' : ['observing', 'disabled', 'disposed'].includes(status.state) ? status.state : 'unavailable' };
      for (const key of ['connections', 'registrations', 'sessionUpdates', 'usageUpdates', 'acceptedUsageUpdates', 'rejectedUsageUpdates']) data[key] = Number.isSafeInteger(status[key]) && status[key] >= 0 ? status[key] : null;
      data.usageRejections = {};
      for (const key of USAGE_REJECTIONS) {
        const count = status.usageRejections?.[key];
        data.usageRejections[key] = Number.isSafeInteger(count) && count >= 0 ? count : null;
      }
      data.leadSessions = sessions.filter(session => session.lead).length;
      data.subagentUsages = sessions.reduce((total, session) => total + (session.subagents?.length || 0), 0);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(directory).isSymbolicLink()) return false;
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, JSON.stringify(data) + '\n'); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
      return true;
    } catch { return false; }
  }
  // Only names this module could have written are candidates, so the directory
  // stays safe to place beside anything else.
  function sweep() {
    try {
      const cutoff = Date.now() - STALE_AFTER_MS;
      for (const name of fs.readdirSync(directory)) {
        const owned = FILE_NAME.exec(name);
        if (!owned && !name.endsWith('.tmp')) continue;
        if (owned && Number(owned[1]) === pid) continue;
        const target = path.join(directory, name);
        try {
          if (fs.statSync(target).mtimeMs >= cutoff) continue;
          if (owned && isRunning(Number(owned[1]))) continue;
        } catch { continue; }
        fs.rmSync(target, { force: true });
      }
      return true;
    } catch { return false; }
  }
  const timer = setInterval(refresh, intervalMs); timer.unref?.();
  const sweeper = setInterval(sweep, SWEEP_INTERVAL_MS); sweeper.unref?.();
  refresh(); sweep();
  return { refresh, sweep, dispose() { if (disposed) return; disposed = true; clearInterval(timer); clearInterval(sweeper); refresh(); } };
}
module.exports = { createContextDiagnostics, STALE_AFTER_MS };

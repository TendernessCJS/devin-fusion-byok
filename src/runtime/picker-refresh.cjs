'use strict';

// The model picker is fed by two answers the extension can only rewrite, not
// push: the renderer catalog (GetUserStatus) and the CLI session options
// (GetCliModelConfigs). To refresh them the extension must trigger Devin's own
// re-fetch. The lightweight devin.reloadAcpConnections command (the native
// extension uses it after auth changes) reloads the ACP registry; executing it
// counts as success because sessions spawn lazily and cli-cache refresh
// already guarantees the data the next session reads. The ACP observer only
// records whether a fresh session arrived in time. Heavier paths that spawn a
// new conversation were removed: they fired on every reload whenever no ACP
// session happened to appear inside the verify window. A second refresh inside
// the CLI cache window would still see the stale list, so the delay is kept.
const LIGHT_COMMANDS = ['devin.reloadAcpConnections'];
const DEBOUNCE_MS = 1500;
const CLI_CACHE_MS = 65 * 1000;
const VERIFY_TIMEOUT_MS = 8000;
const VERIFY_POLL_MS = 250;

function signatureOf(models) {
  return (Array.isArray(models) ? models : []).map(model =>
    typeof model === 'string' ? model : `${model?.uid ?? ''}\u0000${model?.label ?? ''}`).sort().join('\u0001');
}

function createPickerRefresh({ executeCommand, readModels, log = () => {}, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout, debounceMs = DEBOUNCE_MS, cliCacheMs = CLI_CACHE_MS,
  lightCommands = LIGHT_COMMANDS, observe, applied, verifyTimeoutMs = VERIFY_TIMEOUT_MS,
  pollMs = VERIFY_POLL_MS, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (typeof executeCommand !== 'function' || typeof readModels !== 'function') throw new TypeError('executeCommand and readModels are required');
  let last, timer, lastRun = -Infinity, disposed = false;
  function read() {
    try { return signatureOf(readModels()); } catch { return undefined; }
  }
  async function run() {
    timer = undefined;
    if (disposed) return;
    lastRun = now();
    const canVerify = typeof observe === 'function' && typeof applied === 'function';
    for (const command of lightCommands) {
      let token;
      if (canVerify) { try { token = observe(); } catch { token = undefined; } }
      try { await executeCommand(command); } catch { continue; }
      log('picker-refresh', { command });
      if (canVerify) {
        const deadline = now() + verifyTimeoutMs;
        const rounds = Math.ceil(verifyTimeoutMs / pollMs) + 1;
        let ok = false;
        for (let i = 0; i < rounds && !disposed; i++) {
          try { ok = applied(token) === true; } catch { ok = false; }
          if (ok) break;
          if (now() >= deadline) break;
          await wait(pollMs);
        }
        if (!ok) log('picker-refresh-unverified', { command });
      }
      return;
    }
    log('picker-refresh-unavailable');
  }
  return {
    prime() { last = read(); },
    changed() {
      if (disposed) return false;
      const current = read();
      if (current === undefined || current === last) return false;
      last = current;
      if (timer !== undefined) cancel(timer);
      // A second refresh inside the CLI cache window would not re-fetch its
      // model list, so defer it until the cache is stale again.
      const delay = Math.max(debounceMs, lastRun + cliCacheMs - now());
      timer = schedule(() => { run().catch(() => {}); }, delay);
      return true;
    },
    // External invalidation (e.g. a stale CLI cache was renamed aside) can fix
    // the picker without changing the observed catalog signature, so a forced
    // run bypasses the signature comparison of changed().
    force() {
      if (disposed) return false;
      if (timer !== undefined) cancel(timer);
      timer = schedule(() => { run().catch(() => {}); }, debounceMs);
      return true;
    },
    dispose() { disposed = true; if (timer !== undefined) cancel(timer); timer = undefined; },
  };
}

module.exports = { createPickerRefresh, signatureOf };

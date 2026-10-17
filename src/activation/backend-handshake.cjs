'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runtimeIdentity, controlFile, PORT, MANAGEMENT_PROTOCOL } = require('../runtime/backend.cjs');
const { RuntimeError, pause, compareVersion } = require('./errors.cjs');

async function ensureBackend({ root, extensionPath, signal, log = () => {}, port = PORT, onCompatibleRuntime }, dependencies = {}) {
  const request = dependencies.fetch || fetch;
  const spawnRuntime = dependencies.spawn || spawn;
  const wait = dependencies.sleep || pause;
  const base = 'http://127.0.0.1:' + port;
  let started = false, startupPolls = 0, warnedBusy = false, controlFailures = 0, compatibleNotified = false;
  const timeout = ms => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  for (;;) {
    if (signal?.aborted) throw new RuntimeError('cancelled');
    // Re-read source hashes so windows running the same package version converge
    // on the files currently installed, even after a same-version reinstall.
    const expected = runtimeIdentity(root, true);
    let response;
    try { response = await request(base + '/health', { signal: timeout(1000) }); } catch {}
    if (signal?.aborted) throw new RuntimeError('cancelled');
    if (!response) {
      if (!started) {
        let failed = false;
        try {
          const child = spawnRuntime(process.execPath, [path.join(extensionPath, 'src/runtime/backend.cjs'), root], {
            detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          });
          child.once('error', () => { failed = true; }); child.unref();
        } catch { throw new RuntimeError('startup_failed'); }
        started = true;
        await wait(100, signal);
        if (failed) throw new RuntimeError('startup_failed');
        continue;
      }
      if (++startupPolls >= 50) throw new RuntimeError('startup_failed');
      await wait(100, signal); continue;
    }
    let health;
    try { if (!response.ok) throw new Error(); health = await response.json(); }
    catch { throw new RuntimeError('port_in_use'); }
    if (health?.service !== expected.service) throw new RuntimeError('port_in_use');
    if (health.rootId && health.rootId !== expected.rootId) throw new RuntimeError('different_storage');
    if (compareVersion(health.version, expected.version) > 0) throw new RuntimeError('newer_runtime');
    if (health.version === expected.version && health.sourceId === expected.sourceId && health.rootId === expected.rootId && !health.draining) return health;
    if (health.managementProtocol !== MANAGEMENT_PROTOCOL || !health.instanceId || !health.rootId ||
        !Number.isSafeInteger(health.activeRequests) || health.activeRequests < 0) throw new RuntimeError('legacy_runtime');
    if (!compatibleNotified && !health.draining && !signal?.aborted &&
        (health.version !== expected.version || health.sourceId !== expected.sourceId)) {
      compatibleNotified = true;
      try { onCompatibleRuntime?.(health); } catch {}
    }
    if (health.activeRequests > 0 || health.draining) {
      if (!warnedBusy) { log('runtime-update-waiting', { activeRequests: health.activeRequests }); warnedBusy = true; }
      await wait(health.draining ? 100 : 1000, signal); continue;
    }
    let control;
    try { control = JSON.parse(fs.readFileSync(controlFile(root), 'utf8')); } catch {}
    if (!control || control.instanceId !== health.instanceId || control.rootId !== health.rootId ||
        control.sourceId !== health.sourceId || !/^[a-f0-9]{64}$/.test(control.token || '')) {
      if (++controlFailures > 3) throw new RuntimeError('control_unavailable');
      await wait(100, signal); continue;
    }
    controlFailures = 0;
    try {
      const stopped = await request(base + '/_runtime/shutdown', { method: 'POST',
        headers: { authorization: 'Bearer ' + control.token }, signal: timeout(2000) });
      if (stopped.status === 403) throw new RuntimeError('control_unavailable');
      if (![200, 409, 503].includes(stopped.status)) throw new RuntimeError('legacy_runtime');
      await stopped.body?.cancel();
    } catch (error) { if (error instanceof RuntimeError) throw error; }
    // A second window may have stopped the old process or started the replacement
    // concurrently. Recheck identity before attempting to launch anything.
    started = false; startupPolls = 0;
    await wait(100, signal);
  }
}

module.exports = { ensureBackend };

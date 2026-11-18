'use strict';
const fs = require('node:fs');
const { safeError } = require('./errors.cjs');

// One reconcile entry for every path that can change what the extension should
// be doing: the panel's own writes (afterChange) and an external edit of the
// config file (the watcher). Both project the config into the same small state
// and take the same job, so a local write followed by its watcher echo cannot
// pause the goal twice or reset the auto-continue budget twice.
function createConfigSync({ config, configFile, vscode, context, log, runtime, selection, continuation, changed, publish }) {
  const project = current => ({
    enabled: current.enabled !== false,
    goal: current.enabled !== false && current.goalEnabled === true,
    autoError: current.autoContinueOnProviderError === true,
    autoPlan: current.autoContinueUntilPlanComplete === true,
  });
  let applied = null, revision = 0, disposed = false, started = false, preferenceSubscription;
  const alive = () => !disposed && runtime.isDisposed?.() !== true;

  // Synchronous by design: the goal suspension and the one-shot auto-continue
  // reset must land before any await, even when enabling is still hanging on a
  // backend handshake. Only a real state change fires; false -> true never
  // resumes on its own.
  const commit = () => {
    const next = project(config());
    const previous = applied;
    applied = next;
    revision += 1;
    if (next.goal === false && (previous === null || previous.goal === true)) {
      try { continuation.suspend({ reason: 'disabled' }); } catch { log('goal-suspend-failed'); }
    }
    if (previous === null ? (next.autoError || next.autoPlan)
      : (next.autoError !== previous.autoError || next.autoPlan !== previous.autoPlan)) {
      try { continuation.resetAutoContinue(); } catch { log('auto-continue-reset-failed'); }
    }
    return revision;
  };

  // The job belongs to the revision that started it: a newer reconcile, a
  // dispose or a disabled session makes every remaining step a no-op, so a
  // stale task can never write settings, publish, or re-enable after disable.
  const run = async ticket => {
    if (!alive() || ticket !== revision) return;
    if (config().enabled === false) await runtime.disable();
    else {
      await runtime.ensureEnabled();
      if (!alive() || ticket !== revision || config().enabled === false) return;
      await selection.reconcileSelection();
      if (!alive() || ticket !== revision || config().enabled === false) return;
      await selection.reconcilePreference();
    }
    if (!alive() || ticket !== revision) return;
    changed();
    // A publish that throws or rejects is a diagnostics failure, never a failed
    // configuration write: the panel refresh must not turn a committed change
    // into an operation error.
    try { void Promise.resolve(publish()).catch(() => {}); } catch {}
  };

  const reportSafe = error => {
    const safe = safeError(error);
    if (safe.code !== 'cancelled') log('error', { code: safe.code });
  };

  // Throws when the config cannot be read, so an awaiting caller (the panel's
  // afterChange) reports a real failure instead of a silent success. The watcher
  // is the only entry that turns it into a log line.
  const reconcile = () => {
    if (!alive()) return Promise.resolve();
    return run(commit());
  };

  const afterChange = async type => {
    log('config-after-change', { type });
    return reconcile();
  };

  const onConfigChanged = () => {
    if (!alive()) return;
    log('config-watch-change');
    // The synchronous read of the config happens here, so the goal suspension
    // still lands before any await; only the resulting job is asynchronous.
    try { const job = reconcile(); void job.catch(reportSafe); }
    catch { log('configuration-read-error'); }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    revision += 1;
    try { fs.unwatchFile(configFile, onConfigChanged); } catch {}
    try { preferenceSubscription?.dispose?.(); } catch {}
    preferenceSubscription = undefined;
  };

  const start = () => {
    if (started || !alive()) return;
    started = true;
    applied = project(config());
    fs.watchFile(configFile, { interval: 500, persistent: false }, onConfigChanged);
    preferenceSubscription = vscode.workspace.onDidChangeConfiguration?.(event => {
      if (typeof event?.affectsConfiguration === 'function' && !event.affectsConfiguration('devin.acp.agentPreferences')) return;
      if (!alive()) return;
      // A preference edit only re-converges the selection; it does not re-run
      // the enable/disable pipeline. The promise is handed back so a caller can
      // await the convergence.
      try {
        return Promise.resolve(selection.reconcilePreference()).catch(error => {
          const safe = safeError(error);
          if (safe.code !== 'cancelled') log('preference-sync-failed', { code: safe.code });
        });
      } catch (error) {
        const safe = safeError(error);
        if (safe.code !== 'cancelled') log('preference-sync-failed', { code: safe.code });
        return undefined;
      }
    });
    context.subscriptions.push({ dispose });
  };
  return { afterChange, start, dispose };
}

module.exports = { createConfigSync };

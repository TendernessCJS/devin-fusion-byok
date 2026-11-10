'use strict';
const fs = require('node:fs');
const { safeError } = require('./errors.cjs');
function createConfigSync({ config, configFile, vscode, context, log, runtime, selection, continuation, changed, publish }) {
  const afterChange = async type => {
    if (type === 'setEnabled' && config().enabled === false) await runtime.disable();
    else if (type === 'setGoalEnabled') { if (config().goalEnabled !== true) { try { continuation.suspend({ reason: 'disabled' }); } catch { log('goal-suspend-failed'); } } }
    else if (type === 'setAutoContinue' || type === 'setAutoContinueUntilPlanComplete') continuation.resetAutoContinue();
    else if (type === 'setUpdateProxy') {}
    else if (config().enabled !== false) { await runtime.ensureEnabled(); await selection.reconcileSelection(); }
    log('config-after-change', { type });
    changed();
  };
  let lastAutoError, lastAutoPlan;
  const onConfigChanged = () => {
    try {
      log('config-watch-change');
      const currentConfig = config();
      const currentAutoError = currentConfig.autoContinueOnProviderError === true;
      const currentAutoPlan = currentConfig.autoContinueUntilPlanComplete === true;
      if (currentAutoError !== lastAutoError || currentAutoPlan !== lastAutoPlan) {
        lastAutoError = currentAutoError;
        lastAutoPlan = currentAutoPlan;
        continuation.resetAutoContinue();
      }
      if (currentConfig.enabled === false) void runtime.disable().catch(() => log('disable-cleanup-error'));
      else {
        void runtime.ensureEnabled().catch(error => { const safe = safeError(error); if (safe.code !== 'cancelled') log('error', { code: safe.code }); });
        void selection.reconcilePreference();
        changed?.();
      }
      void publish()?.catch(() => {});
    }
    catch { log('configuration-read-error'); }
  };
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    lastAutoError = config().autoContinueOnProviderError === true;
    lastAutoPlan = config().autoContinueUntilPlanComplete === true;
    fs.watchFile(configFile, { interval: 500, persistent: false }, onConfigChanged);
    context.subscriptions.push({ dispose: () => fs.unwatchFile(configFile, onConfigChanged) });
    const preferenceSubscription = vscode.workspace.onDidChangeConfiguration?.(event => {
      if (typeof event?.affectsConfiguration === 'function' && !event.affectsConfiguration('devin.acp.agentPreferences')) return;
      return selection.reconcilePreference();
    });
    if (preferenceSubscription) context.subscriptions.push(preferenceSubscription);
  };
  return { afterChange, start };
}

module.exports = { createConfigSync };

'use strict';
const fs = require('node:fs');
const { safeError } = require('./errors.cjs');
const { teardown } = require('./teardown.cjs');

function createConfigSync({ deps, shared, changed, publish }) {
  const { lifecycle, config, configFile, vscode, context, log } = deps;
  const afterChange = async type => {
    if (type === 'setEnabled' && config().enabled === false) await shared.disable();
    else if (type === 'setGoalEnabled') { if (config().goalEnabled !== true) { try { lifecycle.goalController?.suspend({ reason: 'disabled' }); } catch { log('goal-suspend-failed'); } } }
    else if (type === 'setAutoContinue' || type === 'setAutoContinueUntilPlanComplete') lifecycle.resetAutoContinue?.();
    else if (type === 'setUpdateProxy') {}
    else if (config().enabled !== false) { await shared.ensureEnabled(); await shared.reconcileSelection(); }
    changed();
  };
  let lastAutoError, lastAutoPlan;
  const onConfigChanged = () => {
    try {
      const currentConfig = config();
      const currentAutoError = currentConfig.autoContinueOnProviderError === true;
      const currentAutoPlan = currentConfig.autoContinueUntilPlanComplete === true;
      if (currentAutoError !== lastAutoError || currentAutoPlan !== lastAutoPlan) {
        lastAutoError = currentAutoError;
        lastAutoPlan = currentAutoPlan;
        lifecycle.resetAutoContinue?.();
      }
      if (currentConfig.enabled === false) void teardown(lifecycle).catch(() => log('disable-cleanup-error'));
      else {
        void shared.ensureEnabled().catch(error => { const safe = safeError(error); if (safe.code !== 'cancelled') log('error', { code: safe.code }); });
        void shared.reconcilePreference();
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
      return shared.reconcilePreference();
    });
    if (preferenceSubscription) context.subscriptions.push(preferenceSubscription);
  };
  return { afterChange, start };
}

module.exports = { createConfigSync };

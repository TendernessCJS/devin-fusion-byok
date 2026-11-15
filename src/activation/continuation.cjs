'use strict';
const path = require('node:path');
const { installAutoContinue } = require('../runtime/host/auto-continue.cjs');
const { installGoalContinue } = require('../goal/continue-hook.cjs');
const { createGoalController } = require('../goal/controller.cjs');
const { translator } = require('../i18n/index.cjs');

function createContinuation({ root, extensionPath, nativeMain, config, vscode, isLive, log, t = translator() }) {
  let goalContinue, autoContinue, controller;
  const start = () => {
    try {
      if (nativeMain) {
        // Goal mode is opt-in: /goal is neither advertised nor intercepted until the user turns it on.
        goalContinue = installGoalContinue({
          nativeMainPath: nativeMain,
          isEnabled: () => isLive() && config().goalEnabled === true,
          t
        });
        autoContinue = installAutoContinue({
          nativeMainPath: nativeMain,
          isEnabled: () => config().enabled !== false && (config().autoContinueOnProviderError === true || config().autoContinueUntilPlanComplete === true),
          getOptions: () => ({
            onProviderError: config().autoContinueOnProviderError === true,
            untilPlanComplete: config().autoContinueUntilPlanComplete === true
          }),
          isSessionSuppressed: sessionId => controller ? controller.ownsSession(sessionId) : false,
          onStopped: data => {
            if (data?.reason === 'plan-attempt-limit') {
              return vscode.window.showWarningMessage(t('notify.autoContinuePlanLimit'));
            }
            return vscode.window.showWarningMessage(t('notify.autoContinueProviderLimit'));
          },
          log
        });
      } else {
        log('auto-continue-unavailable');
      }
    } catch {
      log('auto-continue-unavailable');
    }
    if (goalContinue) {
      try {
        controller = createGoalController({
          root,
          transport: {
            dispatch: request => goalContinue.dispatch(request),
            cancel: sessionId => goalContinue.cancel(sessionId),
            sessions: () => goalContinue.sessions(),
            sessionStatus: sessionId => goalContinue.sessionStatus(sessionId),
            setListener: listener => goalContinue.setListener(listener),
            setCommandHandler: handler => goalContinue.setCommandHandler(handler),
            setGoalOwned: (sessionId, owned) => {
              if (owned) cancelAutoContinueSession(sessionId);
              return goalContinue.setGoalOwned(sessionId, owned);
            }
          },
          isEnabled: () => isLive() && config().goalEnabled === true,
          isTrusted: () => vscode.workspace.isTrusted !== false,
          reportCliPath: path.join(extensionPath, 'src/goal/report.cjs'),
          log,
          t
        });
      } catch { controller = undefined; log('goal-controller-unavailable'); }
    }
  };
  const suspend = ({ reason } = {}) => { try { controller?.suspend({ reason }); } catch {} };
  const resetAutoContinue = () => { autoContinue?.reset(); };
  const cancelAutoContinueSession = sessionId => autoContinue?.cancelSession?.(sessionId);
  const dispose = () => {
    try { controller?.dispose(); } catch {}
    controller = undefined;
    try { goalContinue?.dispose(); } catch {}
    goalContinue = undefined;
    try { autoContinue?.dispose(); } catch {}
    autoContinue = undefined;
  };
  const autoContinueStatus = () => autoContinue ? (autoContinue.status().connections > 0 ? 'attached' : 'waiting') : 'unavailable';
  const autoContinueDetails = () => autoContinue?.status();
  const goalController = () => controller;
  return { start, suspend, resetAutoContinue, cancelAutoContinueSession, dispose, autoContinueStatus, autoContinueDetails, goalController };
}

module.exports = { createContinuation };

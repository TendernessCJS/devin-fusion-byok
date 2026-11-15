'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const { updateConfig, applyKeyDelta } = require('../config/store.cjs');
const { createManager } = require('../panel/manager.cjs');
const { statusTooltip } = require('../panel/status-text.cjs');
const { safeError } = require('./errors.cjs');
const { checkInjectionHealth } = require('../runtime/host/injection-health.cjs');
const { PORT } = require('../runtime/port.cjs');
const { translator } = require('../i18n/index.cjs');

function createPanelHost({ vscode, context, config, configFile, root, log, output, catalog, catalogSync, cacheSync, selection, continuation, runtime, afterChange, t = translator() }) {
  let statusBar, manager, contextObserver, controller;
  const open = () => controller?.open();
  const publish = () => controller?.publish();
  const publishUpdates = () => controller?.publishUpdates?.();
  const updateStatusBar = () => {
    try {
      if (!statusBar) return;
      statusBar.tooltip = statusTooltip({
        enabled: config().enabled !== false,
        nativeModelCount: catalogSync.read().models.length,
        cacheErrorCount: cacheSync.report()?.errors?.length ?? 0,
        matrixCount: catalog().matrixUids?.size ?? 0,
        t,
      });
    } catch {}
  };
  const install = () => {
    statusBar = vscode.window.createStatusBarItem?.(vscode.StatusBarAlignment?.Right ?? 2, 20);
    if (statusBar) {
      statusBar.text = 'Fusion BYOK'; statusBar.tooltip = t('status.initial');
      statusBar.command = 'devinFusionByok.openPanel'; statusBar.show(); context.subscriptions.push(statusBar);
    }
    updateStatusBar();
    cacheSync.check();
    const readHealth = () => checkInjectionHealth({
      enabled: config().enabled !== false,
      backendStatus: runtime().backendStatus(),
      bridgeState: runtime().status()?.state,
      bridgeHook: runtime().status()?.httpHook,
      envValue: (() => { try { return vscode.workspace.getConfiguration('devin.acp').get('agentEnv')?.['devin-cli']?.WINDSURF_API_SERVER_URL ?? null; } catch { return null; } })(),
      expectedEnv: 'http://127.0.0.1:' + PORT,
      cliCache: cacheSync.report(),
      acpObserved: runtime().acpObservation().seq,
      acpOwnModels: runtime().acpObservation().ownModels,
      t,
    });
    manager = createManager({ t, read: config, write: (next, baseline) => updateConfig(configFile, doc => applyKeyDelta(doc, next, baseline)),
      acpOwnModels: () => runtime().acpObservation().ownModels,
      nativeModels: () => catalogSync.read().models, nativeAllowedUids: () => catalogSync.read().allowedUids, refreshNativeModels: () => catalogSync.refresh(), nativeCatalogStatus: () => catalogSync.read().status,
      backendStatus: () => runtime().backendStatus(),
      autoContinueStatus: () => continuation.autoContinueStatus(),
      refreshCliCaches: () => cacheSync.refresh(), cliCacheStatus: () => cacheSync.report(),
      nativeContract: () => runtime().nativeContract(),
      health: readHealth,
      selectFusion: uid => selection.saveFusionChoice(uid),
      afterChange });
    const updater = require('../update.cjs').createUpdateHost({ vscode, context,
      proxy: () => config().updateProxy,
      onChange: () => publishUpdates() });
    // safeError rebuilds the message in the display language; codes stay as they are.
    const displayError = error => safeError(error, t);
    controller = require('../panel/controller.cjs').createPanelController({ vscode, context, manager, safeError: displayError, updater, t,
      fastContext: require('../fast-context/config-ui.cjs').createFastContextHost({ vscode, context, t }),
      restartApp: () => { log('app-restart-requested'); return require('../runtime/host/app-restart.cjs').restartApp({ vscode, spawn, logFile: path.join(root, 'restart.log'), userData: path.resolve(root, '..', '..', '..') }); },
      reloadWindow: () => { log('window-reload-requested'); return vscode.commands.executeCommand('workbench.action.reloadWindow'); },
      readMonitor: () => require('../runtime/host/monitor-client.cjs').readMonitor({ root }) });
    try {
      const native = vscode.extensions.getExtension('codeium.windsurf');
      if (native?.extensionPath && native.packageJSON?.main) {
        contextObserver = require('../runtime/host/context-observer.cjs').installContextObserver({
          nativeMainPath: path.resolve(native.extensionPath, native.packageJSON.main), isEnabled: () => runtime().isLive() });
        context.subscriptions.push(contextObserver);
      }
      require('../panel/context-view.cjs').createContextUi({ vscode, context, t,
        snapshot: () => contextObserver?.snapshot() || [], catalog,
        nativeLabels: () => new Map(catalogSync.read().models.map(entry => [entry.uid, entry.label])),
        focused: () => contextObserver?.focused?.() || null,
        isEnabled: () => runtime().isLive(),
        readMonitor: () => require('../runtime/host/monitor-client.cjs').readMonitor({ root }) });
    } catch { log('context-observer-unavailable'); }
    context.subscriptions.push(require('../runtime/host/context-diagnostics.cjs').createContextDiagnostics({
      root, version: require('../../package.json').version,
      readStatus: () => contextObserver?.status(), snapshot: () => contextObserver?.snapshot() || [], readHealth
    }));
    try {
      require('../panel/goal-view.cjs').createGoalUi({ vscode, context, t,
        controller: {
          snapshot: () => continuation.goalController() ? continuation.goalController().snapshot() : {
            enabled: config().enabled !== false, trusted: vscode.workspace.isTrusted !== false,
            storeError: 'goal-controller-unavailable', corruptGoals: 0, sessions: [], goals: []
          },
          start: payload => continuation.goalController().start(payload),
          pause: payload => continuation.goalController().pause(payload),
          resume: payload => continuation.goalController().resume(payload),
          accept: payload => continuation.goalController().accept(payload),
          archive: payload => continuation.goalController().archive(payload)
        },
        isEnabled: () => runtime().isLive(),
        isTrusted: () => vscode.workspace.isTrusted !== false,
        safeError: displayError });
    } catch { log('goal-ui-unavailable'); }
  };
  return { install, open, publish, publishUpdates, updateStatusBar };
}

module.exports = { createPanelHost };

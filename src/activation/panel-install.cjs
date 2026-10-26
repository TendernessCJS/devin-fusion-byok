'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const { updateConfig, applyKeyDelta } = require('../config/store.cjs');
const { live } = require('./liveness.cjs');
const { createManager } = require('../panel/manager.cjs');
const { statusTooltip } = require('../panel/status-text.cjs');
const { safeError } = require('./errors.cjs');
const { checkInjectionHealth } = require('../runtime/host/injection-health.cjs');
const { PORT } = require('../runtime/port.cjs');

function installPanel({ deps, shared, cacheSync, afterChange }) {
  const { lifecycle, config, configFile, vscode, context, log, catalog, stores } = deps;
  stores.panel.statusBar = vscode.window.createStatusBarItem?.(vscode.StatusBarAlignment?.Right ?? 2, 20);
  if (stores.panel.statusBar) {
    stores.panel.statusBar.text = 'Fusion BYOK'; stores.panel.statusBar.tooltip = '管理供应商、模型列表与 Fusion 组合';
    stores.panel.statusBar.command = 'devinFusionByok.openPanel'; stores.panel.statusBar.show(); context.subscriptions.push(stores.panel.statusBar);
  }
  stores.panel.updateStatusBar = () => {
    try {
      if (!stores.panel.statusBar) return;
      stores.panel.statusBar.tooltip = statusTooltip({
        enabled: config().enabled !== false,
        nativeModelCount: stores.nativeCatalog.nativeModels.size,
        cacheErrorCount: stores.cacheSync.cliCacheReport?.errors?.length ?? 0,
        matrixCount: catalog().matrixUids?.size ?? 0,
      });
    } catch {}
  };
  cacheSync.check();
  const readHealth = () => checkInjectionHealth({
    enabled: config().enabled !== false,
    backendStatus: shared.backendStatus,
    bridgeState: lifecycle.connection?.status?.state,
    bridgeHook: lifecycle.connection?.status?.httpHook,
    envValue: (() => { try { return vscode.workspace.getConfiguration('devin.acp').get('agentEnv')?.['devin-cli']?.WINDSURF_API_SERVER_URL ?? null; } catch { return null; } })(),
    expectedEnv: 'http://127.0.0.1:' + PORT,
    cliCache: stores.cacheSync.cliCacheReport,
    desktopCatalog: lifecycle.publication?.status()?.state,
    acpObserved: stores.acpObservation.seq,
    acpOwnModels: stores.acpObservation.ownModels,
  });
  stores.panel.manager = createManager({ read: config, write: (next, baseline) => updateConfig(configFile, doc => applyKeyDelta(doc, next, baseline)),
    nativeModels: () => [...stores.nativeCatalog.nativeModels.values()], nativeAllowedUids: () => stores.nativeCatalog.nativeAllowedUids, refreshNativeModels: () => stores.nativeCatalog.refreshNativeModels(), nativeCatalogStatus: () => stores.nativeCatalog.nativeCatalogStatus,
    backendStatus: () => shared.backendStatus,
    autoContinueStatus: () => shared.autoContinue ? (shared.autoContinue.status().connections > 0 ? 'attached' : 'waiting') : 'unavailable',
    refreshCliCaches: () => cacheSync.refresh(), cliCacheStatus: () => stores.cacheSync.cliCacheReport,
    refreshDesktopCatalog: async () => { lifecycle.publication?.changed({ force: true }); await shared.management?.publish(); },
    desktopCatalogStatus: () => lifecycle.publication?.status() || null,
    nativeContract: () => lifecycle.nativeContract || null,
    health: readHealth,
    selectFusion: uid => shared.saveFusionChoice(uid),
    afterChange });
  const updater = require('../update.cjs').createUpdateHost({ vscode, context,
    proxy: () => config().updateProxy,
    onChange: () => shared.management?.publishUpdates?.() });
  shared.management = require('../panel/controller.cjs').createPanelController({ vscode, context, manager: stores.panel.manager, safeError, updater,
    fastContext: require('../fast-context/config-ui.cjs').createFastContextHost({ vscode, context }),
    restartApp: () => { log('app-restart-requested'); return require('../runtime/host/app-restart.cjs').restartApp({ vscode, spawn, logFile: path.join(deps.root, 'restart.log'), userData: path.resolve(deps.root, '..', '..', '..') }); },
    reloadWindow: () => { log('window-reload-requested'); return vscode.commands.executeCommand('workbench.action.reloadWindow'); },
    readMonitor: () => require('../runtime/host/monitor-client.cjs').readMonitor({ root: deps.root }) });
  try {
    const native = vscode.extensions.getExtension('codeium.windsurf');
    if (native?.extensionPath && native.packageJSON?.main) {
      stores.panel.contextObserver = require('../runtime/host/context-observer.cjs').installContextObserver({
        nativeMainPath: path.resolve(native.extensionPath, native.packageJSON.main), isEnabled: () => live(lifecycle, config) });
      context.subscriptions.push(stores.panel.contextObserver);
    }
    require('../panel/context-view.cjs').createContextUi({ vscode, context,
      snapshot: () => stores.panel.contextObserver?.snapshot() || [], catalog,
      nativeLabels: () => new Map([...stores.nativeCatalog.nativeModels.values()].map(entry => [entry.uid, entry.label])),
      focused: () => stores.panel.contextObserver?.focused?.() || null,
      isEnabled: () => live(lifecycle, config),
      readMonitor: () => require('../runtime/host/monitor-client.cjs').readMonitor({ root: deps.root }) });
  } catch { log('context-observer-unavailable'); }
  context.subscriptions.push(require('../runtime/host/context-diagnostics.cjs').createContextDiagnostics({
    root: deps.root, version: require('../../package.json').version,
    readStatus: () => stores.panel.contextObserver?.status(), snapshot: () => stores.panel.contextObserver?.snapshot() || [], readHealth
  }));
  try {
    require('../panel/goal-view.cjs').createGoalUi({ vscode, context,
      controller: {
        snapshot: () => lifecycle.goalController ? lifecycle.goalController.snapshot() : {
          enabled: config().enabled !== false, trusted: vscode.workspace.isTrusted !== false,
          storeError: 'goal-controller-unavailable', corruptGoals: 0, sessions: [], goals: []
        },
        start: payload => lifecycle.goalController.start(payload),
        pause: payload => lifecycle.goalController.pause(payload),
        resume: payload => lifecycle.goalController.resume(payload),
        accept: payload => lifecycle.goalController.accept(payload),
        archive: payload => lifecycle.goalController.archive(payload)
      },
      isEnabled: () => live(lifecycle, config),
      isTrusted: () => vscode.workspace.isTrusted !== false,
      safeError });
  } catch { log('goal-ui-unavailable'); }
}

module.exports = { installPanel };

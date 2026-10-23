'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const { updateConfig, applyKeyDelta } = require('../config/store.cjs');
const { createManager } = require('../panel/manager.cjs');
const { safeError } = require('./errors.cjs');
const { checkInjectionHealth } = require('../runtime/host/injection-health.cjs');
const { PORT } = require('../runtime/port.cjs');

function installPanel({ deps, shared, cacheSync, afterChange }) {
  const { lifecycle, config, configFile, vscode, context, log, catalog } = deps;
  shared.statusBar = vscode.window.createStatusBarItem?.(vscode.StatusBarAlignment?.Right ?? 2, 20);
  if (shared.statusBar) {
    shared.statusBar.text = 'Fusion BYOK'; shared.statusBar.tooltip = '管理供应商、模型列表与 Fusion 组合';
    shared.statusBar.command = 'devinFusionByok.openPanel'; shared.statusBar.show(); context.subscriptions.push(shared.statusBar);
  }
  shared.updateStatusBar = () => {
    try {
      if (!shared.statusBar) return;
      if (config().enabled === false) { shared.statusBar.tooltip = 'Fusion BYOK：已停用，点击打开面板启用'; return; }
      if (!shared.nativeModels.size) {
        shared.statusBar.tooltip = 'Fusion BYOK：还没收到官方模型——打开一次模型选择器后会自动同步，或点击打开面板手动刷新';
        return;
      }
      if (shared.cliCacheReport?.errors?.length) {
        shared.statusBar.tooltip = `Fusion BYOK：${shared.cliCacheReport.errors.length} 个 CLI 缓存文件写入失败，点击打开面板查看详情`;
        return;
      }
      shared.statusBar.tooltip = `Fusion BYOK：运行中 · 已镜像 Fusion 组合 ${catalog().matrixUids?.size ?? 0} 条，点击打开面板`;
    } catch {}
  };
  cacheSync.check();
  const readHealth = () => checkInjectionHealth({
    enabled: config().enabled !== false,
    backendStatus: shared.backendStatus,
    bridgeState: lifecycle.connection?.status?.state,
    envValue: (() => { try { return vscode.workspace.getConfiguration('devin.acp').get('agentEnv')?.['devin-cli']?.WINDSURF_API_SERVER_URL ?? null; } catch { return null; } })(),
    expectedEnv: 'http://127.0.0.1:' + PORT,
    cliCache: shared.cliCacheReport,
    acpObserved: shared.acpObservationSeq,
    acpOwnModels: shared.acpOwnModels,
  });
  shared.manager = createManager({ read: config, write: (next, baseline) => updateConfig(configFile, doc => applyKeyDelta(doc, next, baseline)),
    nativeModels: () => [...shared.nativeModels.values()], nativeAllowedUids: () => shared.nativeAllowedUids, refreshNativeModels: shared.refreshNativeModels, nativeCatalogStatus: () => shared.nativeCatalogStatus,
    backendStatus: () => shared.backendStatus,
    autoContinueStatus: () => shared.autoContinue ? (shared.autoContinue.status().connections > 0 ? 'attached' : 'waiting') : 'unavailable',
    refreshCliCaches: () => cacheSync.refresh(), cliCacheStatus: () => shared.cliCacheReport, health: readHealth,
    selectFusion: shared.saveFusionChoice,
    afterChange });
  const updater = require('../update.cjs').createUpdateHost({ vscode, context,
    proxy: () => config().updateProxy,
    onChange: () => shared.management?.publishUpdates?.() });
  shared.management = require('../panel/controller.cjs').createPanelController({ vscode, context, manager: shared.manager, safeError, updater,
    fastContext: require('../fast-context/config-ui.cjs').createFastContextHost({ vscode, context }),
    restartApp: () => { log('app-restart-requested'); return require('../runtime/host/app-restart.cjs').restartApp({ vscode, spawn, logFile: path.join(deps.root, 'restart.log'), userData: path.resolve(deps.root, '..', '..', '..') }); },
    reloadWindow: () => { log('window-reload-requested'); return vscode.commands.executeCommand('workbench.action.reloadWindow'); },
    readMonitor: () => require('../runtime/host/monitor-client.cjs').readMonitor({ root: deps.root }) });
  try {
    const native = vscode.extensions.getExtension('codeium.windsurf');
    if (native?.extensionPath && native.packageJSON?.main) {
      shared.contextObserver = require('../runtime/host/context-observer.cjs').installContextObserver({
        nativeMainPath: path.resolve(native.extensionPath, native.packageJSON.main), isEnabled: () => !lifecycle.activationDisposed && config().enabled !== false });
      context.subscriptions.push(shared.contextObserver);
    }
    require('../panel/context-view.cjs').createContextUi({ vscode, context,
      snapshot: () => shared.contextObserver?.snapshot() || [], catalog,
      nativeLabels: () => new Map([...shared.nativeModels.values()].map(entry => [entry.uid, entry.label])),
      focused: () => shared.contextObserver?.focused?.() || null,
      isEnabled: () => !lifecycle.activationDisposed && config().enabled !== false,
      readMonitor: () => require('../runtime/host/monitor-client.cjs').readMonitor({ root: deps.root }) });
  } catch { log('context-observer-unavailable'); }
  context.subscriptions.push(require('../runtime/host/context-diagnostics.cjs').createContextDiagnostics({
    root: deps.root, version: require('../../package.json').version,
    readStatus: () => shared.contextObserver?.status(), snapshot: () => shared.contextObserver?.snapshot() || [], readHealth
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
      isEnabled: () => !lifecycle.activationDisposed && config().enabled !== false,
      isTrusted: () => vscode.workspace.isTrusted !== false,
      safeError });
  } catch { log('goal-ui-unavailable'); }
}

module.exports = { installPanel };

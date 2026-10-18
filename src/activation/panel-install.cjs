'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { writeConfig } = require('../config.cjs');
const { staleFusionUids, augmentCatalog } = require('../catalog.cjs');
const { createManager } = require('../panel/manager.cjs');
const { createPickerRefresh } = require('../runtime/picker-refresh.cjs');
const { defaultDir: cliCacheDir, refreshStaleCliCaches } = require('../runtime/cli-cache.cjs');
const { safeError } = require('./errors.cjs');
const { teardown } = require('./teardown.cjs');
const { checkInjectionHealth } = require('../runtime/health.cjs');
const { PORT } = require('../runtime/backend.cjs');

function installPanel({ deps, shared }) {
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
  shared.pickerRefresh = createPickerRefresh({ log,
    // devin.reloadAcpConnections drops every ACP connection on execution —
    // users see "ACP connection closed" and a conversation-area reload, and a
    // window reload follows it by ~5-35s (observed 2026-10-14). The in-place
    // CLI cache rewrite already guarantees what the next session reads, so no
    // command is wired in here; keep the module for signature tracking/tests.
    lightCommands: [],
    executeCommand: command => vscode.commands.executeCommand(command),
    readModels: () => catalog().models,
    observe: () => shared.acpObservationSeq,
    applied: token => shared.acpObservationSeq > token && shared.acpOwnModels > 0 });
  shared.pickerRefresh.prime();
  context.subscriptions.push(shared.pickerRefresh);
  // The CLI intersects its picker with per-identity caches under
  // ~/.cache/devin/cli; a cache written before a config change keeps the old
  // uid digests and drops the affected entries. This CLI never re-fetches a
  // missing file, so stale caches are refreshed in place by rewriting the
  // payload through the same augmentation the backend applies.
  shared.checkCliCaches = ({ force = false } = {}) => {
    try {
      if (config().enabled === false) return shared.cliCacheReport;
      const current = catalog();
      const expectedUids = current.models.map(model => model.uid);
      if (!expectedUids.length) return shared.cliCacheReport;
      const emittedFusionUids = new Set(Object.keys(current.fusions || {}));
      const knownUids = new Set([...Object.keys(current.routes || {}), ...emittedFusionUids, ...shared.nativeModels.keys()]);
      const excludedUids = role => {
        const set = new Set();
        for (const ref of Array.isArray(config().roleExclusions?.[role]) ? config().roleExclusions[role] : []) {
          if (typeof ref?.nativeUid === 'string') { set.add(ref.nativeUid); continue; }
          for (const [uid, route] of Object.entries(current.routes || {})) {
            if (route.providerId === ref?.providerId && route.model === ref?.model) set.add(uid);
          }
        }
        return set;
      };
      const excluded = { lead: excludedUids('lead'), sidekick: excludedUids('sidekick') };
      const result = refreshStaleCliCaches({ dir: cliCacheDir(), expectedUids, force,
        staleProbe: payload => staleFusionUids(payload, { emitted: emittedFusionUids, known: knownUids, excluded }),
        augment: (payload, rpc, report) => augmentCatalog(payload, { rpc, format: { json: false }, catalog: current, onSkip: report }) });
      // The report is part of panel state, and panel state is deduplicated by
      // its JSON. Restamping `at` on every automatic check made each 3s sync
      // look like a change, so the panel re-rendered forever — killing the
      // focused search box and resetting every list scroll. Record the moment
      // the outcome was established instead, and keep the previous object when
      // the outcome is unchanged (only a manual, forced check always restamps).
      const summary = { checked: result.checked, refreshed: result.refreshed,
        skipped: result.skipped || [], errors: result.errors || [] };
      const previous = shared.cliCacheReport && JSON.stringify({ checked: shared.cliCacheReport.checked,
        refreshed: shared.cliCacheReport.refreshed, skipped: shared.cliCacheReport.skipped, errors: shared.cliCacheReport.errors });
      if (force || previous !== JSON.stringify(summary)) shared.cliCacheReport = { at: new Date().toISOString(), ...summary };
      if (result.refreshed.length) log('cli-cache-refreshed', { files: result.refreshed, force });
      for (const skip of result.skipped || []) log('cli-cache-skip', { name: skip.name, reason: skip.reason });
      for (const error of result.errors || []) log('cli-cache-write-error', { name: error.name, code: error.code });
    } catch (error) { log('cli-cache-check-failed', { code: error?.code || 'unknown' }); }
    return shared.cliCacheReport;
  };
  // Manual counterpart of the automatic check: the panel button exists so a
  // user whose picker looks stale can force the rewrite now instead of waiting
  // for the next config change or native sync. It is forced because the
  // automatic check only sees uid presence, while a payload can be complete and
  // still carry out-of-date entries (a changed dimension shape, a stale
  // label) — exactly the case the button is for.
  const refreshCliCaches = async () => {
    const report = shared.checkCliCaches({ force: true });
    await shared.management?.publish();
    return report;
  };
  shared.checkCliCaches();
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
  shared.manager = createManager({ read: config, write: current => writeConfig(configFile, current),
    nativeModels: () => [...shared.nativeModels.values()], nativeAllowedUids: () => shared.nativeAllowedUids, refreshNativeModels: shared.refreshNativeModels, nativeCatalogStatus: () => shared.nativeCatalogStatus,
    backendStatus: () => shared.backendStatus,
    autoContinueStatus: () => shared.autoContinue ? (shared.autoContinue.status().connections > 0 ? 'attached' : 'waiting') : 'unavailable',
    refreshCliCaches, cliCacheStatus: () => shared.cliCacheReport, health: readHealth,
    selectFusion: shared.saveFusionChoice,
    afterChange: async type => {
      if (type === 'setEnabled' && config().enabled === false) await shared.disable();
      else if (type === 'setAutoContinue' || type === 'setAutoContinueUntilPlanComplete') lifecycle.resetAutoContinue?.();
      else if (type === 'setUpdateProxy') {}
      else if (config().enabled !== false) { await shared.ensureEnabled(); await shared.reconcileSelection(); }
      shared.pickerRefresh.changed();
      shared.checkCliCaches();
    } });
  const updater = require('../update.cjs').createUpdateHost({ vscode, context,
    proxy: () => config().updateProxy,
    onChange: () => shared.management?.publishUpdates?.() });
  shared.management = require('../panel/controller.cjs').createPanelController({ vscode, context, manager: shared.manager, safeError, updater,
    fastContext: require('../fast-context/config-ui.cjs').createFastContextHost({ vscode, context }),
    restartApp: () => { log('app-restart-requested'); return require('../runtime/app-restart.cjs').restartApp({ vscode, spawn, logFile: path.join(deps.root, 'restart.log'), userData: path.resolve(deps.root, '..', '..', '..') }); },
    reloadWindow: () => { log('window-reload-requested'); return vscode.commands.executeCommand('workbench.action.reloadWindow'); },
    readMonitor: () => require('../runtime/monitor-client.cjs').readMonitor({ root: deps.root }) });
  try {
    const native = vscode.extensions.getExtension('codeium.windsurf');
    if (native?.extensionPath && native.packageJSON?.main) {
      shared.contextObserver = require('../runtime/context-observer.cjs').installContextObserver({
        nativeMainPath: path.resolve(native.extensionPath, native.packageJSON.main), isEnabled: () => !lifecycle.activationDisposed && config().enabled !== false });
      context.subscriptions.push(shared.contextObserver);
    }
    require('../panel/context-view.cjs').createContextUi({ vscode, context,
      snapshot: () => shared.contextObserver?.snapshot() || [], catalog,
      nativeLabels: () => new Map([...shared.nativeModels.values()].map(entry => [entry.uid, entry.label])),
      focused: () => shared.contextObserver?.focused?.() || null,
      isEnabled: () => !lifecycle.activationDisposed && config().enabled !== false,
      readMonitor: () => require('../runtime/monitor-client.cjs').readMonitor({ root: deps.root }) });
  } catch { log('context-observer-unavailable'); }
  context.subscriptions.push(require('../runtime/context-diagnostics.cjs').createContextDiagnostics({
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
  shared.lastAutoError = config().autoContinueOnProviderError === true;
  shared.lastAutoPlan = config().autoContinueUntilPlanComplete === true;
  const onConfigChanged = () => {
    try {
      const currentConfig = config();
      const currentAutoError = currentConfig.autoContinueOnProviderError === true;
      const currentAutoPlan = currentConfig.autoContinueUntilPlanComplete === true;
      if (currentAutoError !== shared.lastAutoError || currentAutoPlan !== shared.lastAutoPlan) {
        shared.lastAutoError = currentAutoError;
        shared.lastAutoPlan = currentAutoPlan;
        lifecycle.resetAutoContinue?.();
      }
      if (currentConfig.enabled === false) void teardown(lifecycle).catch(() => log('disable-cleanup-error'));
      else {
        void shared.ensureEnabled().catch(error => { const safe = safeError(error); if (safe.code !== 'cancelled') log('error', { code: safe.code }); });
        void shared.reconcilePreference();
      }
      void shared.management.publish()?.catch(() => {});
    }
    catch { log('configuration-read-error'); }
  };
  fs.watchFile(configFile, { interval: 500, persistent: false }, onConfigChanged);
  context.subscriptions.push({ dispose: () => fs.unwatchFile(configFile, onConfigChanged) });
  const preferenceSubscription = vscode.workspace.onDidChangeConfiguration?.(event => {
    if (typeof event?.affectsConfiguration === 'function' && !event.affectsConfiguration('devin.acp.agentPreferences')) return;
    return shared.reconcilePreference();
  });
  if (preferenceSubscription) context.subscriptions.push(preferenceSubscription);
}

module.exports = { installPanel };

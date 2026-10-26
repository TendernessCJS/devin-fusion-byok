'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { defaultConfig, pruneRetiredKeys, readConfig } = require('./config/config.cjs');
const { readDoc, updateConfig, archiveCorrupt, recoverFromBackup } = require('./config/store.cjs');
const { buildCatalog } = require('./catalog.cjs');
const { installAutoContinue } = require('./runtime/host/auto-continue.cjs');
const { installGoalContinue } = require('./goal/continue-hook.cjs');
const { createGoalController } = require('./goal/controller.cjs');
const { ensureBackend } = require('./activation/backend-handshake.cjs');
const { safeError } = require('./activation/errors.cjs');
const { live } = require('./activation/liveness.cjs');
const { installCatalogSync } = require('./activation/catalog-sync.cjs');
const { installCacheSync } = require('./activation/cache-sync.cjs');
const { createConfigSync } = require('./activation/config-sync.cjs');
const { installEnable } = require('./activation/enable.cjs');
const { installCommands } = require('./activation/commands.cjs');
const { installPanel } = require('./activation/panel-install.cjs');
const { teardown } = require('./activation/teardown.cjs');
const { createNativeCatalogState } = require('./activation/stores/native-catalog.cjs');
const { createCacheSyncState } = require('./activation/stores/cache-sync.cjs');
const { createAcpObservationState } = require('./activation/stores/acp-observation.cjs');
// Shared lifecycle state across activate/teardown/deactivate.
const lifecycle = { stopNativeSync: undefined, stopAutoContinue: undefined, resetAutoContinue: undefined,
  cancelAutoContinueSession: undefined, stopGoalContinue: undefined, goalController: undefined,
  connection: undefined, acpObserver: undefined, authStatus: undefined, publication: undefined,
  nativeRefresh: undefined, log: undefined, runtimeWaitAbort: undefined,
  restoreOnHostDisable: undefined,
  activationGeneration: 0, reconcileHalted: true, activationDisposed: true };

async function activate(context) {
  lifecycle.activationDisposed = false;
  const output = vscode.window.createOutputChannel('Devin Fusion BYOK');
  context.subscriptions.push(output);
  const log = (event, data) => output.appendLine(JSON.stringify({ time: new Date().toISOString(), event, ...(data || {}) }));
  const root = context.globalStorageUri.fsPath, configFile = path.join(root, 'config.json');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(configFile)) updateConfig(configFile, doc => Object.assign(doc, defaultConfig()));
  try {
    readDoc(configFile);
  } catch (error) {
    if (error?.code !== 'config_corrupt') throw error;
    const recovered = recoverFromBackup(configFile);
    if (recovered) {
      const { configRevision: _ignored, ...rest } = recovered.doc;
      const result = updateConfig(configFile, doc => Object.assign(doc, rest), { fromEmpty: true });
      log('config-recovered-from-backup', { revision: result.revision });
      vscode.window.showWarningMessage('Fusion BYOK：配置文件已损坏，已从备份恢复。');
    } else {
      archiveCorrupt(configFile);
      updateConfig(configFile, doc => Object.assign(doc, defaultConfig()), { fromEmpty: true });
      log('config-reset-corrupt');
      vscode.window.showErrorMessage('Fusion BYOK：配置文件已损坏，已重置为默认配置。');
    }
  }
  const config = () => readConfig(configFile);
  const nativeMain = (() => {
    try {
      const native = vscode.extensions.getExtension('codeium.windsurf');
      return native?.extensionPath && native.packageJSON?.main
        ? path.resolve(native.extensionPath, native.packageJSON.main) : null;
    } catch { return null; }
  })();
  const installContinuation = () => {
    try {
      if (nativeMain) {
        // Goal mode is opt-in: /goal is neither advertised nor intercepted until the user turns it on.
        shared.goalContinue = installGoalContinue({
          nativeMainPath: nativeMain,
          isEnabled: () => live(lifecycle, config) && config().goalEnabled === true
        });
        shared.autoContinue = installAutoContinue({
          nativeMainPath: nativeMain,
          isEnabled: () => config().enabled !== false && (config().autoContinueOnProviderError === true || config().autoContinueUntilPlanComplete === true),
          getOptions: () => ({
            onProviderError: config().autoContinueOnProviderError === true,
            untilPlanComplete: config().autoContinueUntilPlanComplete === true
          }),
          isSessionSuppressed: sessionId => lifecycle.goalController ? lifecycle.goalController.ownsSession(sessionId) : false,
          onStopped: () => vscode.window.showWarningMessage('服务商持续返回错误，已停止自动继续（上限为 5 次或 10 分钟）。请检查服务商状态后手动继续对话。'),
          log
        });
      } else {
        log('auto-continue-unavailable');
      }
    } catch {
      log('auto-continue-unavailable');
    }
    if (shared.goalContinue) {
      try {
        lifecycle.goalController = createGoalController({
          root,
          transport: {
            dispatch: request => shared.goalContinue.dispatch(request),
            cancel: sessionId => shared.goalContinue.cancel(sessionId),
            sessions: () => shared.goalContinue.sessions(),
            sessionStatus: sessionId => shared.goalContinue.sessionStatus(sessionId),
            setListener: listener => shared.goalContinue.setListener(listener),
            setCommandHandler: handler => shared.goalContinue.setCommandHandler(handler),
            setGoalOwned: (sessionId, owned) => {
              if (owned) lifecycle.cancelAutoContinueSession?.(sessionId);
              return shared.goalContinue.setGoalOwned(sessionId, owned);
            }
          },
          isEnabled: () => live(lifecycle, config) && config().goalEnabled === true,
          isTrusted: () => vscode.workspace.isTrusted !== false,
          reportCliPath: path.join(context.extensionPath, 'src/goal/report.cjs'),
          log
        });
      } catch { lifecycle.goalController = undefined; log('goal-controller-unavailable'); }
    }
    lifecycle.stopAutoContinue = () => { shared.autoContinue?.dispose(); shared.autoContinue = undefined; };
    lifecycle.resetAutoContinue = () => { shared.autoContinue?.reset(); };
    lifecycle.cancelAutoContinueSession = sessionId => shared.autoContinue?.cancelSession?.(sessionId);
    lifecycle.stopGoalContinue = () => {
      try { lifecycle.goalController?.dispose(); } catch {}
      lifecycle.goalController = undefined;
      try { shared.goalContinue?.dispose(); } catch {}
      shared.goalContinue = undefined;
    };
  };
  // Shared slots: each installer assigns the ones it owns, while other
  // installer segments (and enable/teardown) read them — so the declarations
  // live in this activate scope, not inside any single installer.
  const stores = {
    nativeCatalog: createNativeCatalogState(),
    cacheSync: createCacheSyncState(),
    acpObservation: createAcpObservationState(),
  };
  const shared = {
    goalContinue: undefined, autoContinue: undefined,
    management: undefined, manager: undefined,
    backendStatus: 'stopped',
    contextObserver: undefined,
    ensureEnabled: undefined, disablePromise: undefined,
    saveFusionChoice: undefined, reconcilePreference: undefined,
    disable: undefined, reconcileSelection: undefined,
    statusBar: undefined, updateStatusBar: undefined,
  };
  installContinuation();
  const catalog = () => { const current = config(); return buildCatalog(current.enabled === false ? { ...current, providers: [] } : current, [...stores.nativeCatalog.nativeModels.values()], stores.nativeCatalog.nativeAllowedUids); };
  const pruneConfig = () => {
    try {
      if (updateConfig(configFile, current => pruneRetiredKeys(current)).changed) log('config-pruned');
    } catch { log('config-prune-failed'); }
  };
  pruneConfig();
  const run = fn => async () => { try { await fn(); } catch (error) {
    const safe = safeError(error);
    if (safe.code === 'cancelled') return;
    log('error', { code: safe.code }); vscode.window.showErrorMessage('Fusion BYOK：' + safe.message);
  } };
  const deps = { lifecycle, config, configFile, vscode, context, log, catalog, nativeMain, root, output, run, stores };
  lifecycle.log = log;
  lifecycle.nativeRefresh = () => vscode.commands.executeCommand('devin.refreshUserStatus');
  const createPublication = () => require('./activation/catalog-publication.cjs').createCatalogPublication({
    getCatalog: catalog, refreshUserStatus: lifecycle.nativeRefresh,
    isCurrent: () => live(lifecycle, config),
    log });
  lifecycle.publication = createPublication();
  const cacheSync = installCacheSync({ deps, shared, publish: () => shared.management?.publish() });
  installCatalogSync({ deps, shared, onChange: () => {
    const published = Promise.resolve(shared.management?.publish()).catch(() => {});
    shared.updateStatusBar();
    cacheSync.changed();
    return published;
  } });
  installEnable({ deps, shared });
  installCommands({ deps, shared });
  const configSync = createConfigSync({ deps, shared,
    changed: () => { cacheSync.changed(); lifecycle.publication?.changed(); },
    publish: () => shared.management.publish() });
  installPanel({ deps, shared, cacheSync, afterChange: configSync.afterChange });
  configSync.start();
  if (config().enabled !== false) await run(shared.ensureEnabled)();
  return { status: () => lifecycle.connection?.status, autoContinue: () => shared.autoContinue?.status() };
}

async function deactivate() {
  lifecycle.activationDisposed = true;
  lifecycle.stopAutoContinue?.(); lifecycle.stopAutoContinue = undefined;
  lifecycle.stopGoalContinue?.(); lifecycle.stopGoalContinue = undefined;
  await teardown(lifecycle);
  const restore = lifecycle.restoreOnHostDisable; lifecycle.restoreOnHostDisable = undefined;
  try { await restore?.(); } catch {}
}

module.exports = { activate, deactivate, ensureBackend, safeError };

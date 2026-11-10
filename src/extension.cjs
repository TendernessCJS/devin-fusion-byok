'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { defaultConfig, readConfig } = require('./config/config.cjs');
const { readDoc, updateConfig, archiveCorrupt, recoverFromBackup } = require('./config/store.cjs');
const { buildCatalog } = require('./catalog.cjs');
const { ensureBackend } = require('./activation/backend-handshake.cjs');
const { safeError } = require('./activation/errors.cjs');
const { createCatalogSync } = require('./activation/catalog-sync.cjs');
const { createSettingsOwner } = require('./activation/settings-owner.cjs');
const { createSelection } = require('./activation/selection.cjs');
const { createCacheSync } = require('./activation/cache-sync.cjs');
const { createConfigSync } = require('./activation/config-sync.cjs');
const { createRuntimeSession } = require('./activation/enable.cjs');
const { createContinuation } = require('./activation/continuation.cjs');
const { installCommands } = require('./activation/commands.cjs');
const { createPanelHost } = require('./activation/panel-install.cjs');
const { publishHostBuild } = require('./activation/host-identity.cjs');
// Only the currently active session is reachable for deactivate(); every
// service below is constructed per activate call, so a re-activated extension
// never inherits state from a previous instance.
let activeSession;

async function activate(context) {
  const activatedAt = new Date().toISOString();
  const output = vscode.window.createOutputChannel('Devin Fusion BYOK');
  context.subscriptions.push(output);
  const log = (event, data) => output.appendLine(JSON.stringify({ time: new Date().toISOString(), event, ...(data || {}) }));
  const root = context.globalStorageUri.fsPath, configFile = path.join(root, 'config.json');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const build = publishHostBuild({ root, extensionPath: context.extensionPath, version: context.extension?.packageJSON?.version, activatedAt });
  log('host-build', build ? { id: build.id.slice(0, 12), files: build.files, version: build.version,
    pid: build.pid, instanceId: build.instanceId, activatedAt: build.activatedAt, recordFile: build.recordFile, kind: build.kind } : { unavailable: true });
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
  const run = fn => async () => { try { await fn(); } catch (error) {
    const safe = safeError(error);
    if (safe.code === 'cancelled') return;
    log('error', { code: safe.code }); vscode.window.showErrorMessage('Fusion BYOK：' + safe.message);
  } };
  let session;
  const settingsOwner = createSettingsOwner({ root, extensionPath: context.extensionPath, vscode,
    globalState: context.globalState, isLive: () => session.isLive() });
  let catalogSync;
  const catalog = () => { const current = config(); const native = catalogSync.read();
    return buildCatalog(current.enabled === false ? { ...current, providers: [] } : current, native.models, native.allowedUids); };
  let panel;
  catalogSync = createCatalogSync({ root, config, log,
    lifecycleView: {
      isLive: () => session.isLive(),
      isDisposed: () => session.isDisposed(),
      generation: () => session.generation(),
      isSuperseded: generation => session.isSuperseded(generation),
    },
    onChange: () => {
      const published = Promise.resolve(panel.publish()).catch(() => {});
      panel.updateStatusBar();
      cacheSync.changed();
      return published;
    } });
  const selection = createSelection({ config, configFile, catalog, settingsOwner,
    isLive: () => session.isLive(), isReconcileHalted: () => session.isReconcileHalted(), log,
    publish: () => panel.publish() });
  const continuation = createContinuation({ root, extensionPath: context.extensionPath, nativeMain,
    config, vscode, isLive: () => session.isLive(), log });
  const cacheSync = createCacheSync({ config, catalog, readNativeCatalog: () => catalogSync.read(), log,
    publish: () => panel.publish() });
  let configSync;
  panel = createPanelHost({ vscode, context, config, configFile, root, log, output, catalog, catalogSync,
    cacheSync, selection, continuation, runtime: () => session,
    afterChange: type => configSync.afterChange(type) });
  session = createRuntimeSession({ root, extensionPath: context.extensionPath, subscriptions: context.subscriptions,
    config, configFile, vscode, context, nativeMain, log, catalog, catalogSync, settingsOwner,
    selection, continuation, onPublish: () => panel.publish() });
  activeSession = session;
  continuation.start();
  session.prepareHostSupport();
  installCommands({ vscode, context, config, catalog, output, log, run, runtime: session, selection, panel });
  const configChanged = () => {
    try { cacheSync.changed(); } catch (error) { log('cache-sync-error', { code: error?.code || error?.message || 'unknown' }); }
  };
  configSync = createConfigSync({ config, configFile, vscode, context, log, runtime: session,
    selection, continuation, changed: configChanged, publish: () => panel.publish() });
  panel.install();
  configSync.start();
  if (config().enabled !== false) await run(session.ensureEnabled)();
  return { status: () => session.status(), autoContinue: () => continuation.autoContinueDetails() };
}

async function deactivate() {
  const session = activeSession; activeSession = undefined;
  await session?.deactivate();
}

module.exports = { activate, deactivate, ensureBackend, safeError };

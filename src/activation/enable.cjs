'use strict';
const path = require('node:path');
const { readReceipt, remember, saveReceipt, valueAt } = require('../lifecycle/owned-settings.cjs');
const { installLsInjection } = require('../runtime/host/ls-injection.cjs');
const { createLsBridge } = require('../runtime/bridge.cjs');
const { installAcpObserver } = require('../runtime/host/acp-observer.cjs');
const { BACKEND_URL } = require('../runtime/port.cjs');
const { ensureBackend } = require('./backend-handshake.cjs');
const { globalSetting } = require('./settings.cjs');
const { safeError } = require('./errors.cjs');

// A configured http.proxy routes this window, so the managed CLI env must exempt
// loopback or devin-cli cannot reach the local backend or the LS bridge. Read
// the global value first: merged workspace settings are never copied into global
// settings, and the effective value is only a fallback for the window case.
function loopbackExemption(vscode) {
  let proxy;
  try {
    const http = vscode.workspace.getConfiguration('http');
    proxy = http?.inspect?.('proxy')?.globalValue;
    if (typeof proxy !== 'string' || !proxy.trim()) proxy = http?.get?.('proxy');
  } catch {}
  return typeof proxy === 'string' && proxy.trim() ? '127.0.0.1,localhost,::1' : null;
}

function installEnable({ deps, shared }) {
  const { lifecycle, config, vscode, context, log, catalog, nativeMain } = deps;
  let enableQueue = Promise.resolve();
  shared.ensureEnabled = () => {
    const operation = enableQueue.then(() => {
      if (lifecycle.activationDisposed || config().enabled === false || lifecycle.connection) return;
      return enable();
    });
    enableQueue = operation.catch(() => {});
    return operation;
  };
  async function enable() {
    const generation = ++lifecycle.activationGeneration;
    lifecycle.runtimeWaitAbort?.abort();
    const waiting = new AbortController(); lifecycle.runtimeWaitAbort = waiting;
    shared.backendStatus = 'starting';
    let compatible;
    const compatibleReady = new Promise(resolve => { compatible = resolve; });
    const upgrade = ensureBackend({ root: deps.root, extensionPath: context.extensionPath, signal: waiting.signal, log,
      onCompatibleRuntime: health => {
        if (waiting.signal.aborted) return;
        log('runtime-update-pending', { version: health.version });
        shared.backendStatus = 'running'; void shared.management?.publish()?.catch(() => {});
        compatible(health);
      } });
    void upgrade.finally(() => { if (lifecycle.runtimeWaitAbort === waiting) lifecycle.runtimeWaitAbort = undefined; })
      .catch(error => { const code = safeError(error).code; if (code !== 'cancelled') log('runtime-upgrade-error', { code }); });
    upgrade.then(() => { shared.backendStatus = 'running'; void shared.management?.publish()?.catch(() => {}); },
      error => { const code = safeError(error).code; if (code !== 'cancelled') { shared.backendStatus = code; void shared.management?.publish()?.catch(() => {}); } });
    await Promise.race([upgrade, compatibleReady]);
    if (generation !== lifecycle.activationGeneration || config().enabled === false) return;
    lifecycle.reconcileHalted = false;
    const settings = vscode.workspace.getConfiguration('devin.acp');
    const existing = globalSetting(settings, 'agentEnv');
    const previous = { ...(existing['devin-cli'] || {}) };
    const desired = { WINDSURF_API_SERVER_URL: BACKEND_URL };
    const noProxy = loopbackExemption(vscode);
    if (noProxy) desired.NO_PROXY = noProxy;
    const saved = { ...context.globalState.get('savedEnv', {}) }, managed = context.globalState.get('managedEnv', {});
    const receipt = readReceipt(deps.root, context.extensionPath);
    // Migrate this extension's experimental proxy settings without changing any
    // values the user subsequently edited.
    for (const [key, value] of Object.entries(managed)) if (!(key in desired) && previous[key] === value) {
      if (saved[key] == null) delete previous[key]; else previous[key] = saved[key];
    }
    for (const key of Object.keys(desired)) if (!(key in saved)) saved[key] = previous[key] ?? null;
    for (const [key, value] of Object.entries(desired)) {
      const current = valueAt({ 'devin.acp.agentEnv': existing }, ['devin.acp.agentEnv', 'devin-cli', key]);
      const legacy = managed[key] === current.value && Object.hasOwn(saved, key)
        ? saved[key] == null ? { exists: false } : { exists: true, value: saved[key] } : undefined;
      remember(receipt, ['devin.acp.agentEnv', 'devin-cli', key], current, value, legacy);
    }
    // Commit recovery information before changing the user's settings.
    saveReceipt(receipt);
    await context.globalState.update('savedEnv', saved);
    await context.globalState.update('managedEnv', desired);
    if (Object.keys(managed).some(k => !(k in desired)) || Object.entries(desired).some(([k, v]) => previous[k] !== v)) await settings.update('agentEnv', { ...existing, 'devin-cli': { ...previous, ...desired } }, vscode.ConfigurationTarget.Global);
    if (generation !== lifecycle.activationGeneration || config().enabled === false) return;
    await shared.reconcilePreference();
    if (generation !== lifecycle.activationGeneration || config().enabled === false) return;
    const native = vscode.extensions.getExtension('codeium.windsurf');
    if (!native) throw new Error('未找到 Devin 原生扩展');
    const injected = await installLsInjection({ nativeMainPath: path.resolve(native.extensionPath, native.packageJSON.main),
      createBridge: (port, extra) => createLsBridge(port, { ...extra, getCatalog: catalog, log, onNativeModels: shared.observeNativeModels,
        onAllowedUids: shared.observeAllowedUids }), log });
    if (generation !== lifecycle.activationGeneration || config().enabled === false || lifecycle.activationDisposed) {
      try { await injected.dispose(); } catch {}
      return;
    }
    lifecycle.connection = injected;
    try { if (nativeMain) { lifecycle.acpObserver?.dispose?.(); lifecycle.acpObserver = installAcpObserver({ nativeMainPath: nativeMain, log, onModels: counts => { shared.acpObservationSeq++; shared.acpOwnModels = counts.ownModels; } }); } }
    catch { log('acp-observer-error'); }
    shared.startNativeSync();
    log('activated', { nativeVersion: native.packageJSON.version, storage: deps.root });
  }
}

module.exports = { installEnable };

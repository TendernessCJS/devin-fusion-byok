'use strict';
const path = require('node:path');
const { readReceipt, remember, saveReceipt, valueAt } = require('../lifecycle/owned-settings.cjs');
const { live, superseded } = require('./liveness.cjs');
const { installLsInjection } = require('../runtime/host/ls-injection.cjs');
const { createLsBridge } = require('../runtime/bridge.cjs');
const { installAcpObserver } = require('../runtime/host/acp-observer.cjs');
const { installAuthStatusInjection } = require('../runtime/host/auth-status.cjs');
const { pushUpstream } = require('../runtime/host/upstream.cjs');
const { recordUnknownCatalog } = require('../runtime/host/observations.cjs');
const { BACKEND_URL } = require('../runtime/port.cjs');
const { ensureBackend } = require('./backend-handshake.cjs');
const { globalSetting } = require('./settings.cjs');
const { safeError, RuntimeError } = require('./errors.cjs');

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

const { checkNativeContract } = require('./native-contract.cjs');

// The backend's forward target follows the native `codeium.apiServerUrl`
// setting (default https://server.codeium.com → null = reset). Only the URL
// crosses; credentials never do. This is the single writer — auth-status must
// not push the same value through its own path.
function readApiServerUrl(vscode) {
  let value;
  try { value = vscode.workspace.getConfiguration('codeium')?.get?.('apiServerUrl'); } catch { return null; }
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
async function pushConfiguredUpstream({ root, vscode, log }) {
  try {
    const result = await pushUpstream({ root, origin: readApiServerUrl(vscode) });
    // Success is logged too: a silent success makes "did the push happen?"
    // unanswerable from the log. Only the custom flag is recorded — never the host.
    if (result.ok) log('upstream-push', { ok: true, custom: result.custom === true });
    else log('upstream-push', { ok: false, reason: result.reason, ...(result.code ? { code: result.code } : {}) });
  } catch { log('upstream-push', { ok: false, reason: 'unavailable' }); }
}

function installEnable({ deps, shared }) {
  const { lifecycle, config, vscode, context, log, catalog, nativeMain, stores, managedSettings } = deps;
  let enableQueue = Promise.resolve();
  shared.ensureEnabled = () => {
    const operation = enableQueue.then(async () => {
      // A disable in flight owns the teardown until its restore verdict lands:
      // enabling now must wait it out instead of installing hooks that the old
      // finally block would strip again underneath.
      const disabling = shared.disablePromise;
      if (disabling) { try { await disabling; } catch {} }
      if (!live(lifecycle, config) || lifecycle.connection) return;
      return enable();
    });
    enableQueue = operation.catch(() => {});
    return operation;
  };
  async function enable() {
    managedSettings.open();
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
    if (superseded(lifecycle, config, generation)) return;
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
    // Commit recovery information before changing the user's settings. The
    // whole write leg is one critical section: a disable that lands mid-write
    // drains it before restoring, and one already draining cancels it.
    try {
      await managedSettings.critical(async () => {
        saveReceipt(receipt);
        await context.globalState.update('savedEnv', saved);
        await context.globalState.update('managedEnv', desired);
        if (Object.keys(managed).some(k => !(k in desired)) || Object.entries(desired).some(([k, v]) => previous[k] !== v)) await settings.update('agentEnv', { ...existing, 'devin-cli': { ...previous, ...desired } }, vscode.ConfigurationTarget.Global);
      });
      // The preference write registers through saveFusionChoice's own gate
      // entry instead of nesting inside this critical section.
      if (superseded(lifecycle, config, generation)) return;
      await shared.reconcilePreference();
    } catch (error) {
      if (error?.code === 'cancelled') throw new RuntimeError('cancelled');
      throw error;
    }
    if (superseded(lifecycle, config, generation)) return;
    const native = vscode.extensions.getExtension('codeium.windsurf');
    if (!native) throw new Error('未找到 Devin 原生扩展');
    const injected = await installLsInjection({ nativeMainPath: path.resolve(native.extensionPath, native.packageJSON.main),
      createBridge: (port, extra) => createLsBridge(port, { ...extra, getCatalog: catalog, log, onNativeModels: stores.nativeCatalog.observeNativeModels,
        onAllowedUids: stores.nativeCatalog.observeAllowedUids,
        onUnknownCatalog: method => { log('catalog-rpc-unknown', { rpc: method }); recordUnknownCatalog(deps.root, method); } }), log });
    if (superseded(lifecycle, config, generation) || lifecycle.activationDisposed) {
      try { await injected.dispose(); } catch {}
      return;
    }
    lifecycle.connection = injected;
    // Backend is ready now: align its forward target with the configured
    // apiServerUrl, and keep it aligned on later setting changes. The
    // subscription is registered once per extension context, not per enable.
    void pushConfiguredUpstream({ root: deps.root, vscode, log });
    if (!lifecycle.upstreamSubscription) {
      lifecycle.upstreamSubscription = vscode.workspace.onDidChangeConfiguration?.(event => {
        if (typeof event?.affectsConfiguration === 'function' && !event.affectsConfiguration('codeium.apiServerUrl')) return;
        if (!live(lifecycle, config)) return;
        return pushConfiguredUpstream({ root: deps.root, vscode, log });
      });
      if (lifecycle.upstreamSubscription) context.subscriptions.push(lifecycle.upstreamSubscription);
    }
    // The publication coordinator owns every refresh of the stored desktop
    // catalog; the hook only reports what each native call actually carried.
    lifecycle.publication ??= require('./catalog-publication.cjs').createCatalogPublication({
      getCatalog: catalog, refreshUserStatus: lifecycle.nativeRefresh,
      isCurrent: () => live(lifecycle, config),
      log });
    // Pin the publisher this generation's events belong to: a previous
    // hook's late native settle must never confirm a newer coordinator.
    const publisher = lifecycle.publication;
    const publish = event => {
      if (generation !== lifecycle.activationGeneration || lifecycle.publication !== publisher) return;
      try { publisher?.observe(event); } catch {}
    };
    try {
      lifecycle.authStatus?.dispose?.();
      lifecycle.authStatus = installAuthStatusInjection({ nativeMainPath: nativeMain, getCatalog: catalog, log,
        isEnabled: () => !superseded(lifecycle, config, generation) && !lifecycle.activationDisposed,
        onNativeModels: entries => { try { stores.nativeCatalog.observeNativeModels?.(entries); } catch {} },
        onPublication: publish });
      // A foreign wrapper that won the method after our install leaves the hook
      // deaf — surface it as the same degraded state as a missing hook instead
      // of waiting for the watchdog to notice.
      if (lifecycle.authStatus?.shadowed?.()) publish({ phase: 'failed', code: 'hook-unavailable' });
      // The stored authStatus was written before this hook existed (or by a
      // window where it is absent); the first publication republishes the
      // merged catalog instead of waiting for the next scheduled native write.
      publisher?.changed();
    } catch {
      log('auth-status-injection-unavailable');
      publish({ phase: 'failed', code: 'hook-unavailable' });
    }
    try { if (nativeMain) { lifecycle.acpObserver?.dispose?.(); lifecycle.acpObserver = installAcpObserver({ nativeMainPath: nativeMain, log, onModels: counts => { stores.acpObservation.seq++; stores.acpObservation.ownModels = counts.ownModels; } }); } }
    catch { log('acp-observer-error'); }
    stores.nativeCatalog.startNativeSync();
    log('activated', { nativeVersion: native.packageJSON.version, storage: deps.root });
    // Post-activation drift probe: async and unobserved by the flow; the
    // result is surfaced through `lifecycle.nativeContract` for the panel.
    void checkNativeContract({
      extensionPath: native.extensionPath,
      cacheFile: path.join(deps.root, 'native-contract.json'),
      log
    }).then(result => { lifecycle.nativeContract = result; }).catch(() => {});
  }
}

module.exports = { installEnable };

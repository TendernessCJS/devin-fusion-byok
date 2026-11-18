'use strict';
const path = require('node:path');
const { live, superseded } = require('./liveness.cjs');
const { installLsInjection } = require('../runtime/host/ls-injection.cjs');
const { createLsBridge } = require('../runtime/bridge.cjs');
const { installAcpObserver } = require('../runtime/host/acp-observer.cjs');
const { installAuthStatusInjection } = require('../runtime/host/auth-status.cjs');
const { pushUpstream } = require('../runtime/host/upstream.cjs');
const { pushProxy } = require('../runtime/host/proxy.cjs');
const { readProxySettings } = require('./proxy-settings.cjs');
const { recordUnknownCatalog } = require('../runtime/host/observations.cjs');
const { resolveEffectiveOriginWhenAvailable } = require('./effective-origin.cjs');
const { ensureBackend } = require('./backend-handshake.cjs');
const { safeError, RuntimeError } = require('./errors.cjs');
const { translator } = require('../i18n/index.cjs');
const { describeError, createRemoteSupport, probeRemoteSupport } = require('./remote-support.cjs');
const { updateConfig } = require('../config/store.cjs');
const { isHostDisabled } = require('../lifecycle/host-disabled.cjs');
const { teardown } = require('./teardown.cjs');

const { checkNativeContract } = require('./native-contract.cjs');

// The backend's forward target follows the effective upstream origin, resolved
// the same way the native config derives `codeium.apiServerUrl` (LS arg →
// portal → default). Only the URL crosses; credentials never do. This is the
// single writer — auth-status must not push the same value through its own path.
// The resolution window converges late (the LS spawns ~1s after activation),
// so triggers are generation-guarded and successful pushes are deduplicated:
// a repeat trigger that resolves to the same (origin, source) sends no POST.
// A commit belongs to the trigger that produced it: the generation is checked
// again after the resolution window and once more when the turn to publish
// arrives, and commits are serialised so an older trigger's POST can never land
// after a newer one. The signal aborts an in-flight POST on supersede/disable.
function serializePush(state, task) {
  const previous = state?.upstreamPushChain || Promise.resolve();
  const run = previous.then(task, task);
  if (state) state.upstreamPushChain = run.then(() => {}, () => {});
  return run;
}

async function pushConfiguredUpstream({ root, vscode, log, state, signal, shouldContinue = () => true, isLive = () => true }) {
  // A liveness check that can no longer be answered (storage gone, config
  // unreadable) is indistinguishable from a dead activation — never publish.
  const cancelled = () => {
    try { return Boolean(signal?.aborted) || !shouldContinue(); }
    catch { return true; }
  };
  // A cancelled trigger is observable exactly once — without it "no new push"
  // cannot be told apart from a dedupe hit, which deliberately stays silent.
  let skipLogged = false;
  const skipped = () => {
    if (skipLogged) return;
    skipLogged = true;
    let reason = 'superseded';
    try { if (!isLive()) reason = 'disabled'; } catch { reason = 'disabled'; }
    log('upstream-push-skipped', { reason });
  };
  // A resolver reporting LS rows it could not adopt is observable once per
  // trigger: the bundle/origin codes are the whole story, never the values.
  let rejectedLogged = false;
  const onDiag = info => {
    if (rejectedLogged) return;
    rejectedLogged = true;
    log('origin-ls-rejected', { dropped: info?.dropped });
  };
  try {
    const effective = await resolveEffectiveOriginWhenAvailable({ vscode, signal, shouldContinue, onDiag });
    if (cancelled()) { skipped(); return; }
    // The dedupe key lives in memory only — compared, never logged or written.
    const key = `${state?.activationGeneration}${effective.origin ?? ''}${effective.source}`;
    return await serializePush(state, async () => {
      if (cancelled()) { skipped(); return; }
      if (state && state.upstreamPushedKey === key) return;
      // The POST commits remote state we cannot read back: invalidate the
      // dedupe key before sending so a cancelled or failed push never leaves
      // the key claiming a state the backend may not hold.
      if (state) state.upstreamPushedKey = undefined;
      const result = await pushUpstream({ root, origin: effective.origin, source: effective.source, signal });
      if (cancelled()) { skipped(); return; }
      if (result.ok && state) state.upstreamPushedKey = key;
      // Success is logged too: a silent success makes "did the push happen?"
      // unanswerable from the log. Only flags and enums are recorded — never the host.
      if (result.ok) log('upstream-push', { ok: true, custom: result.custom === true, source: effective.source });
      else log('upstream-push', { ok: false, reason: result.reason, source: effective.source, ...(result.code ? { code: result.code } : {}), ...(result.detail ? { detail: result.detail } : {}) });
    });
  } catch { if (!cancelled()) log('upstream-push', { ok: false, reason: 'unavailable' }); else skipped(); }
}

// The proxy push mirrors the upstream push's discipline — own generation,
// abort, serialised chain, memory-only dedupe key — but the payload is the
// compiled-at-host config object, and the key is its JSON (never logged).
// The key is invalidated before the real POST and only re-recorded on
// confirmed success, so an A→B→A sequence can never dedupe the second A.
async function pushConfiguredProxy({ root, vscode, log, state, signal, shouldContinue = () => true, isLive = () => true, env = process.env }) {
  if (!isLive()) return { ok: false, reason: 'disabled' };
  try { state.proxyPushAbort?.abort(); } catch {}
  const generation = (state.proxyPushGeneration = (state.proxyPushGeneration || 0) + 1);
  const controller = new AbortController();
  state.proxyPushAbort = controller;
  const cancelled = () =>
    (signal?.aborted ?? false) || controller.signal.aborted || !shouldContinue() ||
    state.proxyPushGeneration !== generation || !isLive();
  const composite = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const previous = state.proxyPushChain || Promise.resolve();
  const run = previous.then(async () => {
    try {
      if (cancelled()) return { ok: false, reason: 'superseded' };
      const { config: proxyConfig, source } = readProxySettings(vscode, env);
      const key = JSON.stringify(proxyConfig);
      if (state.proxyPushedKey === key) return { ok: true, source, skipped: 'dedupe', config: proxyConfig };
      state.proxyPushedKey = undefined;
      const result = await pushProxy({ root, config: proxyConfig, source, signal: composite });
      if (cancelled()) return { ok: false, reason: 'superseded' };
      if (result.ok) state.proxyPushedKey = key;
      log('proxy-push', { ok: result.ok === true, reason: result.reason, source });
      // The accepted config rides along for the environment write only: it is
      // memory-only, never logged, and never part of pushProxy's own result.
      return result.ok ? { ...result, config: proxyConfig } : result;
    } catch { return { ok: false, reason: 'sync_error' }; }
  });
  state.proxyPushChain = run.then(() => {}, () => {});
  state.proxyLatestResult = run;
  return run;
}

function createRuntimeSession({ root, extensionPath, subscriptions, config, configFile, vscode, context, nativeMain, log, catalog, catalogSync, settingsOwner, selection, continuation, onPublish, env = process.env, t = translator() }) {
  const state = {
    activationDisposed: false, activationGeneration: 0, reconcileHalted: true,
    connection: undefined, acpObserver: undefined, authStatus: undefined,
    remoteSupport: undefined, nativeContract: undefined, runtimeWaitAbort: undefined,
    upstreamPushGeneration: 0, upstreamPushAbort: undefined, upstreamPushChain: undefined,
    upstreamPushedKey: undefined, upstreamSubscription: undefined,
    proxyPushGeneration: 0, proxyPushAbort: undefined, proxyPushChain: undefined,
    proxyLatestResult: undefined, proxyPushedKey: undefined, proxySubscription: undefined,
  };
  let backendStatus = 'stopped', disablePromise = null, enableQueue = Promise.resolve();
  let acpSeq = 0, acpOwnModels = 0;
  const isLive = () => live(state, config);
  const isDisposed = () => state.activationDisposed;
  const isSuperseded = generation => superseded(state, config, generation);
  const generation = () => state.activationGeneration;
  const isReconcileHalted = () => state.reconcileHalted;
  const status = () => state.connection?.status;
  const backendStatusValue = () => backendStatus;
  const acpObservation = () => ({ seq: acpSeq, ownModels: acpOwnModels });
  const nativeContract = () => state.nativeContract || null;
  const publishPanel = () => { try { void Promise.resolve(onPublish?.()).catch(() => {}); } catch {} };

  const prepareHostSupport = () => {
    // Remote windows keep this extension UI-side while the native extension
    // lives on the remote: catalog injection is impossible there, so remote
    // support only wraps the remote extension's ssh spawn / authority resolver
    // to establish a reverse tunnel back to the local backend. The wrappers
    // must be in place before the window resolves its remote authority, hence
    // the eager start inside remote windows only: a local window needs no
    // tunnel and must not install process-level patches it can never use.
    const remoteWindow = Boolean(vscode.env?.remoteName);
    let remoteSupport;
    try {
      remoteSupport = createRemoteSupport({ vscode, root, nativeMain, log,
        isEnabled: () => isLive() });
    } catch (error) { log('remote-support-unavailable', describeError(error)); }
    state.remoteSupport = remoteSupport;
    if (config().enabled !== false && remoteWindow) void remoteSupport?.start();
    // Local windows keep the wrappers out but still report whether this host can
    // be patched at all — otherwise the first remote window is where it fails.
    else if (config().enabled !== false) void probeRemoteSupport({ vscode, root, nativeMain, log });
  };

  const ensureEnabled = () => {
    const operation = enableQueue.then(async () => {
      // A disable in flight owns the teardown until its restore verdict lands:
      // enabling now must wait it out instead of installing hooks that the old
      // finally block would strip again underneath.
      const disabling = disablePromise;
      if (disabling) { try { await disabling; } catch {} }
      if (!isLive()) return;
      const existing = state.connection;
      if (existing) {
        // A remote connection that lost its tunnel retries the tunnel alone —
        // backend and settings are already in place.
        if (existing.status?.state === 'unavailable' && typeof existing.retry === 'function') return existing.retry();
        return;
      }
      return enable();
    });
    enableQueue = operation.catch(() => {});
    return operation;
  };

  async function enable() {
    settingsOwner.openWrites();
    const generation = ++state.activationGeneration;
    state.runtimeWaitAbort?.abort();
    const waiting = new AbortController(); state.runtimeWaitAbort = waiting;
    backendStatus = 'starting';
    let compatible;
    const compatibleReady = new Promise(resolve => { compatible = resolve; });
    const upgrade = ensureBackend({ root, extensionPath, signal: waiting.signal, log,
      onCompatibleRuntime: health => {
        if (waiting.signal.aborted) return;
        log('runtime-update-pending', { version: health.version });
        // Early compatibility only releases enable() when the running copy can
        // already answer the proxy gate — a stale backend without a policy
        // 503s every forward, so the window keeps waiting for the replacement.
        if (health.proxyProtocol !== 1 || health.proxyReady !== true) return;
        backendStatus = 'running'; publishPanel();
        compatible(health);
      } });
    void upgrade.finally(() => { if (state.runtimeWaitAbort === waiting) state.runtimeWaitAbort = undefined; })
      .catch(error => { const code = safeError(error).code; if (code !== 'cancelled') log('runtime-upgrade-error', { code }); });
    // A late rejection must not overwrite state owned by a newer generation or
    // a disabled session — no unconditional 'running' write exists here: the
    // status only flips after the proxy gate below actually converges.
    upgrade.then(() => {},
      error => {
        if (state.activationGeneration !== generation || !isLive()) return;
        const code = safeError(error).code;
        if (code !== 'cancelled') { backendStatus = code; publishPanel(); }
      });
    let retriggerUpstream;
    // One convergence discipline for every sync: enqueue, then keep reading
    // the newest settled result. A superseded intermediate generation is not
    // a failure — the latest settled result is authoritative.
    const syncProxy = async ({ force = false } = {}) => {
      if (force) state.proxyPushedKey = undefined;
      void pushConfiguredProxy({ root, vscode, log, state, env, signal: waiting.signal,
        shouldContinue: () => !isSuperseded(generation) && config().enabled !== false, isLive });
      let selected, result;
      do {
        selected = state.proxyLatestResult;
        result = await selected;
      } while (!isSuperseded(generation) && isLive() && selected !== state.proxyLatestResult);
      return result;
    };
    const outcome = await Promise.race([
      upgrade.then(health => ({ health, final: true })),
      compatibleReady.then(health => ({ health, final: false })),
    ]);
    if (isSuperseded(generation)) return;
    if (!outcome.final) {
      // Serving on the old instance while the replacement warms up. The new
      // backend starts proxy-cold, so its arrival must force a fresh sync even
      // when the config bytes are identical — the in-memory dedupe key belongs
      // to whichever instance last answered, never to the config.
      const seenGeneration = generation;
      upgrade.then(() => {
        if (waiting.signal.aborted || isSuperseded(seenGeneration) || !isLive() || config().enabled === false) return;
        return syncProxy({ force: true });
      }).then(result => {
        if (!result || isSuperseded(seenGeneration) || !isLive()) return;
        if (result.ok) {
          backendStatus = 'running'; publishPanel();
          // The replacement owns upstream routing now; re-converge the native
          // upstream push for this generation.
          state.upstreamPushedKey = undefined;
          try { Promise.resolve(retriggerUpstream?.()).catch(() => {}); } catch {}
        } else {
          backendStatus = 'proxy_unavailable'; publishPanel();
          log('proxy-push', { ok: false, reason: result.reason, phase: 'upgrade' });
        }
      }, () => {});
    }
    // The first proxy sync is a hard gate: the backend refuses every upstream
    // forward until a policy lands, so an unsynchronised start must surface as
    // an error instead of silently writing hooks/env on a crippled runtime.
    // Remote windows share this local backend, so they sync too.
    const proxyResult = await syncProxy({ force: true });
    if (isSuperseded(generation)) return;
    if (!proxyResult.ok) throw new RuntimeError('proxy_unavailable');
    // The subscription lives before the remote/native split so remote windows
    // (which share this backend) get hot updates too. workspace-level values
    // are never read: every event re-resolves the global value, and an
    // identical result dedupes against the in-memory key. The managed CLI env
    // follows the policy the backend actually accepted — a rejected policy
    // leaves the previous environment in place rather than announcing a bypass
    // list the runtime does not honour.
    try { state.proxySubscription?.dispose?.(); } catch {}
    const onConfigChange = vscode.workspace?.onDidChangeConfiguration;
    if (typeof onConfigChange === 'function') {
      try {
        state.proxySubscription = onConfigChange.call(vscode.workspace, event => {
          if (event?.affectsConfiguration?.('http.proxy') || event?.affectsConfiguration?.('http.noProxy') ||
              event?.affectsConfiguration === undefined) {
            if (isDisposed() || !isLive() || config().enabled === false) return;
            // Returning the promise keeps the handler awaitable in tests; the
            // host ignores listener return values.
            return (async () => {
              const result = await syncProxy();
              if (!result?.ok || isSuperseded(generation) || !isLive()) return;
              await settingsOwner.applyEnvironment(result.config);
            })().catch(error => {
              if (safeError(error).code !== 'cancelled') log('proxy-environment-sync-failed');
            });
          }
        });
      } catch {}
    }
    // The first push raced any concurrent config edit; one closing read +
    // dedupe closes that window. enable() waits for the newest settled result
    // before env writes — a superseded intermediate run is not a failure, but
    // the latest settled result is authoritative.
    const latest = await syncProxy();
    if (isSuperseded(generation)) return;
    if (!latest.ok) throw new RuntimeError('proxy_unavailable');
    backendStatus = 'running'; publishPanel();
    state.reconcileHalted = false;
    try {
      await settingsOwner.applyEnvironment(latest.config);
      // The preference write registers through saveFusionChoice's own gate
      // entry instead of nesting inside this critical section.
      if (isSuperseded(generation)) return;
      await selection.reconcilePreference();
    } catch (error) {
      if (error?.code === 'cancelled') throw new RuntimeError('cancelled');
      throw error;
    }
    if (isSuperseded(generation)) return;
    const native = vscode.extensions.getExtension('codeium.windsurf');
    if (!native) {
      if (!vscode.env?.remoteName) throw new Error('未找到 Devin 原生扩展'); // i18n-data: matched by activation/errors.cjs safeError
      // Remote window: the native extension runs on the remote side, so no
      // catalog injection is possible — the only deliverable here is the
      // reverse tunnel plus the agentEnv write that already happened above.
      let remoteState = 'connecting';
      const support = state.remoteSupport;
      let connecting = null;
      const connect = () => {
        if (!support) { remoteState = 'unavailable'; return Promise.reject(new Error('remote_support_unavailable')); }
        if (remoteState === 'disposed' || state.connection !== connection) return Promise.resolve();
        if (connecting) return connecting;
        remoteState = 'connecting';
        connecting = (async () => {
          try {
            await support.start();
            await support.ensureCurrentRemoteWindowTunnel();
            if (remoteState === 'disposed' || state.connection !== connection) return;
            remoteState = 'ready';
          } catch (error) {
            if (remoteState !== 'disposed' && state.connection === connection) remoteState = 'unavailable';
            log('remote-tunnel-unavailable', describeError(error));
            throw error;
          } finally { connecting = null; }
        })();
        return connecting;
      };
      const connection = state.connection = {
        get status() { return { state: remoteState, tunnels: support?.status?.() || [] }; },
        retry() { return connect(); },
        dispose() { remoteState = 'disposed'; },
      };
      // No LS bridge and no auth-status hook run on this side, so the desktop
      // catalog can never be observed here: say so instead of polling forever.
      catalogSync.markUnsupported();
      if (!support) remoteState = 'unavailable';
      else void connect().catch(() => {});
      log('activated-remote', { tunnel: Boolean(support) });
      return;
    }
    const injected = await installLsInjection({ nativeMainPath: path.resolve(native.extensionPath, native.packageJSON.main),
      createBridge: (port, extra) => createLsBridge(port, { ...extra, getCatalog: catalog, log, onNativeModels: catalogSync.observeModels,
        onAllowedUids: catalogSync.observeAllowed,
        onUnknownCatalog: method => { log('catalog-rpc-unknown', { rpc: method }); recordUnknownCatalog(root, method); } }), log });
    if (isSuperseded(generation) || state.activationDisposed) {
      try { await injected.dispose(); } catch {}
      return;
    }
    state.connection = injected;
    // Backend is ready now: align its forward target with the effective
    // upstream origin, and keep it aligned on later setting changes. The
    // subscription is registered once per extension context, not per enable.
    const triggerPush = () => {
      // A newer trigger supersedes any in-flight resolution window.
      const pushGeneration = (state.upstreamPushGeneration = (state.upstreamPushGeneration || 0) + 1);
      try { state.upstreamPushAbort?.abort(); } catch {}
      const controller = new AbortController();
      state.upstreamPushAbort = controller;
      return pushConfiguredUpstream({ root, vscode, log, state, signal: controller.signal,
        shouldContinue: () => isLive() && state.upstreamPushGeneration === pushGeneration,
        isLive });
    };
    retriggerUpstream = () => { state.upstreamPushedKey = undefined; triggerPush(); };
    void triggerPush();
    if (!state.upstreamSubscription) {
      state.upstreamSubscription = vscode.workspace.onDidChangeConfiguration?.(event => {
        const sources = ['codeium.apiServerUrl', 'devin.portalUrl', 'windsurf.portalUrl', 'windsurf.serviceUrl'];
        if (typeof event?.affectsConfiguration === 'function' && !sources.some(s => event.affectsConfiguration(s))) return;
        if (!isLive()) return;
        return triggerPush();
      });
      if (state.upstreamSubscription) subscriptions.push(state.upstreamSubscription);
    }
    try {
      state.authStatus?.dispose?.();
      state.authStatus = installAuthStatusInjection({ nativeMainPath: nativeMain, getCatalog: catalog, log,
        isEnabled: () => !isSuperseded(generation) && !state.activationDisposed,
        onNativeModels: entries => { try { catalogSync.observeModels(entries); } catch {} } });
      // A foreign wrapper that won the method after our install leaves the hook
      // deaf; there is no publication status to degrade anymore, so the only
      // channel left is the output-channel event.
      if (state.authStatus?.shadowed?.()) log('auth-status-shadowed');
    } catch {
      log('auth-status-injection-unavailable');
    }
    try { if (nativeMain) { state.acpObserver?.dispose?.(); state.acpObserver = installAcpObserver({ nativeMainPath: nativeMain, log, onModels: counts => { acpSeq++; acpOwnModels = counts.ownModels; } }); } }
    catch { log('acp-observer-error'); }
    catalogSync.start();
    log('activated', { nativeVersion: native.packageJSON.version, storage: root });
    // Post-activation drift probe: async and unobserved by the flow; the
    // result is surfaced through `state.nativeContract` for the panel.
    void checkNativeContract({
      extensionPath: native.extensionPath,
      cacheFile: path.join(root, 'native-contract.json'),
      log
    }).then(result => { state.nativeContract = result; }).catch(() => {});
  }

  // Every disable path (panel switch, disable command, external enabled=false
  // edit) serializes through the same in-flight promise so a config watcher
  // firing mid-teardown cannot start a second teardown in parallel.
  const disable = () => {
    disablePromise ??= (async () => {
      try { continuation.suspend({ reason: 'disabled' }); } catch { log('goal-suspend-failed'); }
      backendStatus = 'stopped';
      updateConfig(configFile, current => { if (current.enabled === false) return false; current.enabled = false; return true; });
      const drained = await settingsOwner.drainWrites();
      if (!drained) log('managed-settings-drain-timeout');
      // Owned settings restore must run even when the LS bridge dispose threw —
      // a broken bridge can never orphan the user's environment values.
      try { await teardown(state, { continuation, catalogSync }); }
      finally { await settingsOwner.restore({ keepReceipt: drained === false }); }
      if (drained) vscode.window.showInformationMessage(t('notify.disabled'));
      else vscode.window.showWarningMessage(t('notify.disabledPending'));
    })().finally(() => { disablePromise = null; });
    return disablePromise;
  };

  const deactivate = async () => {
    state.activationDisposed = true;
    continuation.dispose();
    // Closing the gate here ends the window for new managed writes and waits for
    // the one that is running; a queued write is cancelled by the same drain.
    // A plain reload or quit still keeps the shared settings — only a host
    // disable restores them.
    const drained = await settingsOwner.drainWrites();
    if (!drained) log('managed-settings-drain-timeout', { phase: 'deactivate' });
    try { await teardown(state, { continuation, catalogSync }); }
    finally {
      // Disabling in the extension manager restarts the extension host and never
      // runs the disable command; without this the native CLI keeps pointing at
      // a runtime that no longer starts.
      try {
        if (isHostDisabled({ storageRoot: root })) {
          await settingsOwner.restore({ keepReceipt: drained === false });
          log(drained ? 'host-disabled-settings-restored' : 'host-disabled-settings-restore-pending');
        }
      } catch {}
    }
  };

  return { ensureEnabled, disable, deactivate, prepareHostSupport,
    isLive, isDisposed, isSuperseded, generation, isReconcileHalted,
    status, backendStatus: backendStatusValue, acpObservation, nativeContract };
}

module.exports = { createRuntimeSession };

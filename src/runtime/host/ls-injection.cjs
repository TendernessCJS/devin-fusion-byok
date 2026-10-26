'use strict';

const { createRequire } = require('node:module');
const { urlToHttpOptions } = require('node:url');

const INSTANCE = Symbol.for('devin-fusion-byok.ls-injection.v1');
const HEARTBEAT = '/exa.language_server_pb.LanguageServerService/Heartbeat';
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function portNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

// The official extension sends this one RPC every second, even when installed
// after its language server started. Do not inspect its headers or payload.
function heartbeatPort(args) {
  const first = args[0];
  let options;
  if (typeof first === 'string' || first instanceof URL) {
    const url = typeof first === 'string' ? new URL(first) : first;
    options = { ...urlToHttpOptions(url) };
    if (args[1] && typeof args[1] === 'object') {
      const override = args[1];
      // Deliberately copy only addressing fields, never headers or body.
      for (const key of ['protocol', 'hostname', 'host', 'port', 'path', 'method', 'socketPath']) {
        if (key in override) options[key] = override[key];
      }
    }
  } else if (first && typeof first === 'object') {
    options = first;
  } else {
    return null;
  }
  if (options.socketPath || (options.protocol ?? 'http:') !== 'http:' ||
      String(options.method ?? 'GET').toUpperCase() !== 'POST' || options.path !== HEARTBEAT) return null;
  const host = String(options.hostname ?? options.host ?? 'localhost').toLowerCase().replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return null;
  return portNumber(options.port);
}

/**
 * Route the window's renderer LS clients through owned per-port HTTP bridges.
 * The main LS port (learned via setPort or Heartbeat) and every child LS port
 * (learned via setChildLanguageServerInfo) each get their own bridge, kept in a
 * port-keyed map instead of a single active slot: switching ports no longer
 * cuts in-flight requests. Idle bridges are reclaimed after ttlMs without
 * activity (a setPort/child-info call pointing at them, or a request forwarded
 * through them via the bridge's onActivity callback). An explicit setPort to a
 * different port still retires the previous main bridge immediately, because
 * the renderer just declared a new main LS.
 * createBridge(originalPort, { onActivity }) must return { port, close() }.
 * No app files, auth state, settings, or process environment are changed here.
 */
async function installLsInjection({ nativeMainPath, createBridge, log = () => {},
    ttlMs = DEFAULT_TTL_MS, clock } = {}) {
  if (typeof nativeMainPath !== 'string' || typeof createBridge !== 'function') {
    throw new TypeError('nativeMainPath and createBridge are required');
  }
  // The extension host gives every extension its own `vscode` API object, so
  // this must require from the native entry's path to reach the object the
  // native extension actually calls — without executing or rewriting its
  // bundle. `http` is the opposite: the host intercepts only `vscode`, so this
  // is Node's single shared builtin and the patch below applies to every
  // extension in this host process. That is accepted because the wrapper only
  // reads addressing fields for one loopback POST path and passes every other
  // call straight through; the cost of a third-party wrapper layered on top is
  // a deaf heartbeat fallback (see `httpHook`), never a broken request.
  const nativeRequire = createRequire(nativeMainPath);
  const http = nativeRequire('http');
  const api = nativeRequire('vscode').windsurfLanguageServer;
  if (!api || typeof api.setPort !== 'function' || typeof http.request !== 'function') {
    throw new Error('Native language-server injection API is unavailable');
  }
  if (api[INSTANCE]) return api[INSTANCE];

  const now = typeof clock?.now === 'function' ? () => clock.now() : () => Date.now();
  // Sandbox realms may lack timers entirely; without an injected clock the
  // idle reclaim simply does not arm, which is no worse than the old behavior.
  const hasTimers = typeof setTimeout === 'function';
  const setTimer = typeof clock?.setTimeout === 'function'
    ? (fn, ms) => clock.setTimeout(fn, ms)
    : hasTimers ? (fn, ms) => setTimeout(fn, ms) : () => null;
  const clearTimer = typeof clock?.clearTimeout === 'function'
    ? handle => clock.clearTimeout(handle)
    : hasTimers ? handle => clearTimeout(handle) : () => {};

  const requestDescriptor = Object.getOwnPropertyDescriptor(http, 'request');
  const setPortDescriptor = Object.getOwnPropertyDescriptor(api, 'setPort');
  const childInfoDescriptor = typeof api.setChildLanguageServerInfo === 'function'
    ? Object.getOwnPropertyDescriptor(api, 'setChildLanguageServerInfo') : null;
  const originalRequest = http.request;
  const originalSetPort = api.setPort;
  const originalSetChildInfo = api.setChildLanguageServerInfo;
  let disposed = false;
  let disposePromise;
  let originalPort = null;
  let pendingCount = 0;
  let state = 'waiting';
  const bridges = new Map();
  const creating = new Map();
  const setters = new Map();
  const childSetters = new Map();
  const childPorts = new Set();
  const proxyPorts = new Set();
  const closed = new WeakSet();
  let shadowReported = false;

  function report(message) {
    try { log(message); } catch (_) { /* Diagnostics cannot break native RPCs. */ }
  }

  // `http.request` is host-wide (see above), so another extension can wrap over
  // ours; the heartbeat fallback then goes deaf while the setPort path still
  // works. Report the transition once instead of waiting for a silent stall.
  function noteHook() {
    if (disposed || shadowReported || http.request === request) return;
    shadowReported = true;
    report('ls-http-hook-shadowed');
  }

  async function close(bridge) {
    if (!bridge || typeof bridge !== 'object' || closed.has(bridge)) return;
    closed.add(bridge);
    try {
      if (typeof bridge.close === 'function') await bridge.close();
    } catch (_) {
      report('ls bridge close failed');
    } finally {
      proxyPorts.delete(portNumber(bridge.port));
    }
  }

  function arm(entry) {
    entry.timer = setTimer(() => { void expire(entry.port); }, ttlMs);
    entry.timer?.unref?.();
  }

  function touch(port) {
    const entry = bridges.get(port);
    if (!entry) return;
    entry.lastUsed = now();
    if (entry.timer) clearTimer(entry.timer);
    arm(entry);
  }

  async function expire(port) {
    const entry = bridges.get(port);
    if (!entry) return;
    // The current main bridge is the port the renderer is actively pointed
    // at: its lifetime is governed by setPort and dispose, never by the idle
    // TTL. The TTL only reclaims child-LS and superseded bridges.
    if (entry.main && entry.port === originalPort) { arm(entry); return; }
    // A request may have raced the timer; re-arm instead of closing a live bridge.
    if (now() - entry.lastUsed < ttlMs) { arm(entry); return; }
    bridges.delete(port);
    report(`ls bridge expired ${port} -> ${entry.bridgePort}`);
    await close(entry.bridge);
  }

  function publish(entry) {
    if (disposed) return;
    if (entry.main && entry.port === originalPort) {
      const setter = setters.get(entry.port) || { thisArg: api, extraArgs: [] };
      Reflect.apply(originalSetPort, setter.thisArg, [entry.bridgePort, ...setter.extraArgs]);
    }
    const child = childSetters.get(entry.port);
    if (child) {
      try {
        Reflect.apply(originalSetChildInfo, child.thisArg,
          [{ ...child.args[0], port: entry.bridgePort }, ...child.args.slice(1)]);
      } catch (_) { /* Replay best-effort; the next native call rewrites again. */ }
    }
  }

  function ensureBridge(port, { main = false } = {}) {
    if (disposed || !port || proxyPorts.has(port)) return;
    if (main) {
      originalPort = port;
      // A newer main observation supersedes earlier pending main creations:
      // their late bridges are closed unpublished, exactly as before.
      for (const attempt of creating.values()) {
        if (attempt.main && attempt.port !== port) attempt.superseded = true;
      }
      const existing = bridges.get(port);
      if (existing) {
        existing.main = true;
        touch(port);
        state = 'ready';
        return;
      }
    } else if (bridges.has(port)) {
      touch(port);
      return;
    }
    if (creating.has(port)) {
      if (main) creating.get(port).main = true;
      return;
    }
    const attempt = { port, main, superseded: false };
    creating.set(port, attempt);
    pendingCount++;
    state = 'connecting';
    report('ls port observed ' + port);
    Promise.resolve().then(() => {
      if (disposed || attempt.superseded) return null;
      return createBridge(port, { onActivity: () => touch(port) });
    }).then(async bridge => {
      if (!bridge) {
        if (!disposed && !attempt.superseded) throw new Error('Missing LS bridge');
        return;
      }
      const bridgePort = portNumber(bridge.port);
      if (!bridgePort || bridgePort === port || typeof bridge.close !== 'function') {
        await close(bridge);
        throw new Error('Invalid LS bridge');
      }
      if (disposed || attempt.superseded) {
        await close(bridge);
        return;
      }
      proxyPorts.add(bridgePort);
      const entry = { port, bridge, bridgePort, main: attempt.main, lastUsed: now(), timer: null };
      bridges.set(port, entry);
      arm(entry);
      try {
        publish(entry);
      } catch (error) {
        bridges.delete(port);
        if (entry.timer) clearTimer(entry.timer);
        await close(bridge);
        throw error;
      }
      state = 'ready';
      report(`ls bridge ready ${port} -> ${bridgePort}`);
    }).catch(() => {
      if (!disposed && !attempt.superseded) {
        state = 'error';
        report(`ls bridge unavailable for ${port}`);
      }
    }).finally(() => {
      pendingCount--;
      creating.delete(port);
    });
  }

  function request(...args) {
    const result = Reflect.apply(originalRequest, this, args);
    try {
      const port = heartbeatPort(args);
      if (port) ensureBridge(port, { main: !childPorts.has(port) });
    } catch (_) { /* Leave malformed native calls unchanged. */ }
    return result;
  }

  function setPort(...args) {
    noteHook();
    const port = portNumber(args[0]);
    const nativePort = port && !proxyPorts.has(port);
    const entry = nativePort ? bridges.get(port) : null;
    const forwarded = !disposed && entry ? [entry.bridgePort, ...args.slice(1)] : args;
    const result = Reflect.apply(originalSetPort, this, forwarded);
    if (!disposed && nativePort) {
      setters.set(port, { thisArg: this, extraArgs: args.slice(1) });
      if (port !== originalPort) {
        // Explicit main-port switch: the old main LS is gone, so its bridge is
        // retired eagerly rather than left to idle out.
        const previous = bridges.get(originalPort);
        if (previous?.main) {
          previous.main = false;
          bridges.delete(originalPort);
          if (previous.timer) clearTimer(previous.timer);
          void close(previous.bridge);
        }
      }
      ensureBridge(port, { main: true });
      if (entry) touch(port);
    }
    return result;
  }

  function setChildLanguageServerInfo(...args) {
    noteHook();
    const info = args[0];
    const port = info && typeof info === 'object' ? portNumber(info.port) : null;
    const nativePort = port && !proxyPorts.has(port);
    const entry = nativePort ? bridges.get(port) : null;
    const forwarded = !disposed && entry
      ? [{ ...info, port: entry.bridgePort }, ...args.slice(1)] : args;
    const result = Reflect.apply(originalSetChildInfo, this, forwarded);
    if (!disposed && nativePort) {
      childPorts.add(port);
      childSetters.set(port, { thisArg: this, args });
      if (entry) touch(port);
      else ensureBridge(port, { main: false });
    }
    return result;
  }

  function restore(target, name, wrapper, descriptor, value) {
    if (target[name] !== wrapper) return false;
    if (descriptor) Object.defineProperty(target, name, descriptor);
    else {
      delete target[name];
      if (target[name] !== value) target[name] = value;
    }
    return true;
  }

  const handle = {
    get status() {
      return Object.freeze({ state, httpHook: disposed ? 'released' : http.request === request ? 'installed' : 'shadowed',
        originalPort, proxyPort: bridges.get(originalPort)?.bridgePort ?? null,
        pending: pendingCount, bridges: bridges.size });
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      state = 'disposed';
      for (const attempt of creating.values()) attempt.superseded = true;
      restore(http, 'request', request, requestDescriptor, originalRequest);
      restore(api, 'setPort', setPort, setPortDescriptor, originalSetPort);
      if (childInfoDescriptor) {
        restore(api, 'setChildLanguageServerInfo', setChildLanguageServerInfo, childInfoDescriptor, originalSetChildInfo);
      }
      if (api[INSTANCE] === handle) delete api[INSTANCE];
      const entries = [...bridges.values()];
      if (entries.some(entry => entry.main && entry.port === originalPort)) {
        // If another extension has wrapped ours, retain that wrapper and ask it
        // to restore the native port. Our disposed wrapper simply passes through.
        const setter = setters.get(originalPort) || { thisArg: api, extraArgs: [] };
        try { Reflect.apply(api.setPort, setter.thisArg, [originalPort, ...setter.extraArgs]); }
        catch (_) { report('ls original port restore failed'); }
      }
      // Pending creations are invalidated immediately. Their completion closes
      // the returned bridge without publishing it, even after disposal returns.
      bridges.clear();
      for (const entry of entries) if (entry.timer) clearTimer(entry.timer);
      disposePromise = Promise.all(entries.map(entry => close(entry.bridge))).then(() => {});
      return disposePromise;
    },
  };

  try {
    http.request = request;
    api.setPort = setPort;
    if (childInfoDescriptor) api.setChildLanguageServerInfo = setChildLanguageServerInfo;
    Object.defineProperty(api, INSTANCE, { value: handle, configurable: true });
  } catch (error) {
    restore(http, 'request', request, requestDescriptor, originalRequest);
    restore(api, 'setPort', setPort, setPortDescriptor, originalSetPort);
    if (childInfoDescriptor) {
      restore(api, 'setChildLanguageServerInfo', setChildLanguageServerInfo, childInfoDescriptor, originalSetChildInfo);
    }
    throw error;
  }
  report('ls injection waiting for native port');
  return handle;
}

module.exports = { installLsInjection };

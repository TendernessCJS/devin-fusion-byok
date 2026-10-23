'use strict';
const { createRequire } = require('node:module');

// Mechanical plumbing shared by the ACP instrumentation modules: one way to
// resolve the native registration API, one way to undo a wrapper. Callers keep
// their own eligibility rules, state machines, instance symbols and error
// identities — this only removes the duplicated boilerplate.

function loadAcpApi(nativeMainPath, errorMessage = 'Native ACP registration API is unavailable') {
  if (typeof nativeMainPath !== 'string' || !nativeMainPath) throw new TypeError('nativeMainPath is required');
  const api = createRequire(nativeMainPath)('vscode')?.windsurfAcp;
  if (!api || typeof api.registerConnection !== 'function') throw new Error(errorMessage);
  return api;
}

// Undo a wrapper only while it is still installed: a method someone else
// replaced in the meantime is left untouched, and a method that was inherited
// (no own descriptor) is removed again rather than frozen as an own property.
function restoreMember(target, key, wrapper, descriptor) {
  if (target[key] !== wrapper) return;
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else delete target[key];
}

// Unified injection orchestration: the three ACP instrumentation modules used
// to wrap `api.registerConnection` independently, and each patched connectors
// on its own. Attachment order on a connector did not mirror install order
// (auto attached innermost, observer outermost regardless of which installed
// first), so dispose order could strand a wrapper that was never on top when
// its own restoreMember ran. The registry wraps `api.registerConnection` once,
// attaches layers to each connector strictly in priority order, and detaches
// strictly in reverse attach order. Removing a layer that is not on top marks
// it inactive — its wrapper must already be inert via the module's own
// disposed flag — and the layer is physically detached later, when it becomes
// the outermost remaining layer on that connector.
const REGISTRY = Symbol.for('devin-fusion-byok.acp-registry.v1');
const REGISTRIES = new WeakMap();

function createAcpRegistry(api, { log } = {}) {
  const existing = api[REGISTRY] || REGISTRIES.get(api);
  // Later installers may carry the logger even when an earlier one created
  // the registry (goal/auto install before the observer in production).
  if (existing) { existing.addLogger(log); return existing; }

  const loggers = new Set();
  const layers = new Map();
  const attachments = new Map();
  let wrapped = false;
  let shadowReported = false;
  let registrationDescriptor = null;
  let originalRegister = null;

  function sortedLayers() {
    return [...layers.values()].sort((a, b) => a.priority - b.priority);
  }

  function unwrap() {
    if (!wrapped) return;
    // A third-party wrapper on top of ours cannot be removed safely: the
    // registry intentionally stays resident as a zero-layer pass-through
    // rather than re-wrapping on the next addLayer (which would capture the
    // foreign wrapper — itself chained back into us — as originalRegister and
    // recurse forever). Do not add retry-uninstall logic here.
    if (api.registerConnection !== registerConnection) {
      if (!shadowReported) {
        shadowReported = true;
        for (const logger of loggers) {
          try { logger('acp-registry-shadowed'); } catch {}
        }
      }
      return;
    }
    restoreMember(api, 'registerConnection', registerConnection, registrationDescriptor);
    wrapped = api.registerConnection === registerConnection;
  }

  function detachConnector(connector) {
    const stack = attachments.get(connector);
    if (!stack) return;
    attachments.delete(connector);
    for (let index = stack.length - 1; index >= 0; index--) {
      const layer = stack[index];
      try { layer.detach(connector); } catch {}
      layer.connectors.delete(connector);
      if (!layer.active && layer.connectors.size === 0) layers.delete(layer.id);
    }
    if (layers.size === 0) unwrap();
  }

  // Remove contiguous inactive layers from the top of this connector's stack.
  function drain(connector) {
    const stack = attachments.get(connector);
    if (!stack) return;
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.active) break;
      try { top.detach(connector); } catch {}
      top.connectors.delete(connector);
      stack.pop();
      if (top.connectors.size === 0) layers.delete(top.id);
    }
    if (!stack.length) attachments.delete(connector);
    if (layers.size === 0) unwrap();
  }

  function registerConnection(connector, ...rest) {
    const attached = [];
    for (const layer of sortedLayers()) {
      if (!layer.active) continue;
      let token;
      try { token = layer.attach(connector); } catch { continue; }
      if (!token) continue;
      attached.push(layer);
      layer.connectors.add(connector);
    }
    let stack = attachments.get(connector);
    if (attached.length) {
      if (!stack) { stack = []; attachments.set(connector, stack); }
      stack.push(...attached);
    }
    let registration;
    try {
      registration = Reflect.apply(originalRegister, this, [connector, ...rest]);
    } catch (error) {
      for (let index = attached.length - 1; index >= 0; index--) {
        try { attached[index].detach(connector); } catch {}
        attached[index].connectors.delete(connector);
        stack.pop();
      }
      if (stack && !stack.length) attachments.delete(connector);
      throw error;
    }
    if (attached.length && registration && typeof registration.dispose === 'function') {
      const originalDispose = registration.dispose;
      const disposeWrapper = function (...disposeArgs) {
        detachConnector(connector);
        return Reflect.apply(originalDispose, this, disposeArgs);
      };
      try { registration.dispose = disposeWrapper; }
      catch { detachConnector(connector); }
    }
    return registration;
  }

  function ensureWrapped() {
    if (wrapped) return;
    registrationDescriptor = Object.getOwnPropertyDescriptor(api, 'registerConnection');
    originalRegister = api.registerConnection;
    api.registerConnection = registerConnection;
    wrapped = true;
  }

  const registry = {
    addLogger(logger) {
      if (typeof logger === 'function') loggers.add(logger);
    },
    addLayer({ id, priority = 0, attach, detach } = {}) {
      if (layers.has(id)) throw new Error(`Duplicate ACP injection layer id: ${id}`);
      if (typeof attach !== 'function' || typeof detach !== 'function') {
        throw new TypeError('ACP injection layers require attach/detach functions');
      }
      const layer = { id, priority, attach, detach, active: true, connectors: new Set() };
      layers.set(id, layer);
      ensureWrapped();
      let removed = false;
      return {
        remove() {
          if (removed) return;
          removed = true;
          layer.active = false;
          for (const connector of [...layer.connectors]) drain(connector);
          if (layer.connectors.size === 0) layers.delete(id);
          if (layers.size === 0) unwrap();
        },
        status() {
          return { id, priority: layer.priority, attached: layer.active, connectors: layer.connectors.size };
        },
      };
    },
    inspect() {
      return sortedLayers().map(layer => ({
        id: layer.id, priority: layer.priority,
        connectors: layer.connectors.size, attached: layer.active,
      }));
    },
    // True while our registerConnection wrapper is installed but a third
    // party has wrapped over it: the registry is live yet cannot unwind.
    shadowed() {
      return wrapped && api.registerConnection !== registerConnection;
    },
  };

  try {
    Object.defineProperty(api, REGISTRY, { value: registry, configurable: true, writable: true });
  } catch {
    REGISTRIES.set(api, registry);
  }
  registry.addLogger(log);
  return registry;
}

module.exports = { loadAcpApi, restoreMember, createAcpRegistry };

'use strict';

const { loadAcpApi, restoreMember, createAcpRegistry } = require('./acp-hook.cjs');

const INSTANCE = Symbol.for('devin-fusion-byok.acp-observer.v1');
const METHODS = new Set(['session/new', 'session/load', 'session/resume', 'session/set_config_option']);

function modelCounts(source, rpc) {
  const options = Array.isArray(source) ? source
    : Array.isArray(source?.configOptions) ? source.configOptions : [];
  const values = [];
  let modelSelectors = 0;
  for (const option of options) {
    if (option?.category !== 'model' || option.type !== 'select') continue;
    modelSelectors++;
    for (const entry of Array.isArray(option.options) ? option.options : []) {
      const entries = Array.isArray(entry?.options) ? entry.options : [entry];
      for (const value of entries) if (typeof value?.value === 'string') values.push(value.value);
    }
  }
  const unique = [...new Set(values)];
  const plainModels = unique.filter(value => value.startsWith('dfbyok-')).length;
  const fusionModels = unique.filter(value => value.startsWith('fusion-dfbyok-')).length;
  return Object.freeze({ rpc, configOptions: options.length, modelSelectors, models: values.length,
    uniqueModels: unique.length, ownModels: plainModels + fusionModels, plainModels, fusionModels });
}

/**
 * Observe future native ACP registrations without issuing agent requests.
 * Logs only method names and model counts; never requests, response bodies,
 * session IDs, labels, model UID values, metadata, or credentials.
 */
function installAcpObserver({ nativeMainPath, log = () => {}, onModels } = {}) {
  if (typeof nativeMainPath !== 'string' || !nativeMainPath || typeof log !== 'function') {
    throw new TypeError('nativeMainPath and a log function are required');
  }
  const api = loadAcpApi(nativeMainPath);
  if (api[INSTANCE]) return api[INSTANCE];

  const registry = createAcpRegistry(api, { log });
  const records = new Map();
  let disposed = false, responses = 0, last = null, lastUpdate = null;

  function observe(response, rpc) {
    if (disposed) return;
    try {
      const counts = modelCounts(response, rpc);
      responses++;
      last = counts;
      lastUpdate = rpc;
      try { log('acp-models', counts); } catch (_) { /* Diagnostics cannot affect native requests. */ }
      if (typeof onModels === 'function') { try { onModels(counts); } catch (_) {} }
    } catch (_) { /* Malformed diagnostics are ignored; native responses remain untouched. */ }
  }

  function wrapConnection(connection) {
    if (!connection || records.has(connection) || typeof connection.sendRequest !== 'function') return;
    const descriptor = Object.getOwnPropertyDescriptor(connection, 'sendRequest');
    const forwardDescriptor = typeof connection.forwardClientRequest === 'function'
      ? Object.getOwnPropertyDescriptor(connection, 'forwardClientRequest')
      : null;
    const original = connection.sendRequest;
    const originalForward = connection.forwardClientRequest;
    function sendRequest(...args) {
      const result = Reflect.apply(original, this, args);
      try {
        // Read only the method discriminator. In particular never inspect the
        // authentication payload or any other request params.
        const rpc = args[0]?.method;
        if (!disposed && METHODS.has(rpc)) {
          if (result && typeof result.then === 'function') {
            result.then(value => { observe(value, rpc); }, () => {});
          } else observe(result, rpc);
        }
      } catch (_) { /* Preserve original return values, throws and rejections. */ }
      return result;
    }
    // session/update notifications only observe the update discriminator and
    // its configOptions array; all other payloads pass through unread.
    function forwardClientRequest(...args) {
      const result = Reflect.apply(originalForward, this, args);
      try {
        const update = args[0]?.params?.update;
        if (!disposed && update?.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
          observe(update.configOptions, 'config_option_update');
        }
      } catch (_) { /* Preserve original return values, throws and rejections. */ }
      return result;
    }
    try {
      connection.sendRequest = sendRequest;
      if (connection.sendRequest !== sendRequest) return;
    } catch (_) { return; /* A frozen native connector can still register normally. */ }
    const record = { descriptor, sendRequest };
    if (forwardDescriptor) {
      try {
        connection.forwardClientRequest = forwardClientRequest;
        if (connection.forwardClientRequest === forwardClientRequest) {
          record.forwardDescriptor = forwardDescriptor;
          record.forwardWrapper = forwardClientRequest;
        }
      } catch (_) { /* The forwarder stays unread rather than blocking attach. */ }
    }
    records.set(connection, record);
  }

  const layer = registry.addLayer({
    id: 'acp-observer',
    priority: 30,
    attach(connection) {
      if (records.has(connection)) return null;
      wrapConnection(connection);
      return records.has(connection) ? connection : null;
    },
    detach(connection) {
      const record = records.get(connection);
      if (!record) return;
      try { restoreMember(connection, 'sendRequest', record.sendRequest, record.descriptor); } catch (_) {}
      if (record.forwardWrapper) {
        try { restoreMember(connection, 'forwardClientRequest', record.forwardWrapper, record.forwardDescriptor); } catch (_) {}
      }
      records.delete(connection);
    },
  });

  const handle = {
    get status() {
      return Object.freeze({ state: disposed ? 'disposed' : 'observing', connections: records.size, responses, last, lastUpdate, shadowed: registry.shadowed() });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      layer.remove();
      if (api[INSTANCE] === handle) delete api[INSTANCE];
    },
  };
  try { Object.defineProperty(api, INSTANCE, { value: handle, configurable: true }); }
  catch (error) { layer.remove(); throw error; }
  return handle;
}

module.exports = { installAcpObserver };

'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readConfig } = require('../config/config.cjs');
const { buildCatalog, resolveAssignment } = require('../catalog.cjs');
const wire = require('../protocol/wire.cjs');
const { parseChat } = require('../protocol/native-chat-codec.cjs');
const { serveChat } = require('../protocol/inference.cjs');
const { createCacheSupport } = require('../protocol/cache-support.cjs');
const { forward, collect } = require('./bridge.cjs');
const { createRuntimeControl } = require('./backend-control.cjs');
const { normalizeNativeEntry, loadNativeCache, saveNativeCache, normalizeAllowedUids } = require('./native-cache.cjs');
const { mergeNativeEntry } = require('../models/native-entry.cjs');
const { PORT } = require('./port.cjs');
const { DEFAULT_UPSTREAM, resolveUpstreamOrigin } = require('./upstream-origin.cjs');
const { VERSION, MANAGEMENT_PROTOCOL, controlFile } = require('./contract.cjs');
const { runtimeIdentity } = require('./source-identity.cjs');
const API_PREFIX = '/exa.api_server_pb.ApiServerService/';
// The AssignModelRequest field table, verified against the 3.11.228 descriptor:
// f1 metadata, f2 model_router_uid, f3 cascade_id, f5 chat_message_prompt,
// f6 fusion_lead_router_uid. `assignment_jwt` is deliberately absent — it is a
// ModelAssignment *response* field, so seeing it in a request is the real drift
// signal (the client starting to demand a token we never mint).
const KNOWN_ASSIGN_FIELDS = new Set([1, 2, 3, 5, 6]);
const KNOWN_ASSIGN_KEYS = new Set(['metadata', 'modelRouterUid', 'model_router_uid', 'cascadeId', 'cascade_id',
  'chatMessagePrompt', 'chat_message_prompt', 'fusionLeadRouterUid', 'fusion_lead_router_uid']);
// Upstream origin validation lives in ./upstream-origin.cjs so the host-side
// resolver (activation/effective-origin.cjs) shares the exact same rules.
// Capability flag for POST /_runtime/native-models. Kept separate from
// nativeModelsProtocol so the read contract stays unchanged: a host talking to
// an older backend simply sees no flag and skips pushing instead of erroring.
const NATIVE_MODELS_INGEST = 1;
const MAX_INGEST_ENTRIES = 5000;
// Upper bound for the shutdown waits that overlap real work (in-flight requests,
// monitor flush). Generous enough that ordinary drains finish first, short enough
// that a stuck one cannot turn SIGTERM into a no-op.
const DRAIN_TIMEOUT_MS = 5000;
// Closing the listening socket only waits for connections to fall away: no
// request work overlaps it (`draining` already refuses new ones), so it gets a
// much shorter bound. Sharing the drain budget kept a lingering socket from
// costing a full five seconds of refused requests on every runtime handover.
const SOCKET_CLOSE_TIMEOUT_MS = 1000;

async function startBackend({ root, port = PORT, log = () => {}, drainTimeoutMs = DRAIN_TIMEOUT_MS,
  socketCloseTimeoutMs = SOCKET_CLOSE_TIMEOUT_MS }) {
  const identity = runtimeIdentity(root);
  const instanceId = crypto.randomUUID();
  const controlToken = crypto.randomBytes(32).toString('hex');
  // Per runtime, not module-scoped: two backends in one process (tests, a dev
  // instance) must not share a pushed origin.
  let upstreamOrigin = DEFAULT_UPSTREAM;
  let monitor;
  try {
    const { createMonitor } = require('../monitor/store.cjs');
    monitor = createMonitor({ root });
  } catch { log('monitor-unavailable'); }
  const cacheSupport = createCacheSupport({ root });
  const recordMetrics = data => {
    if (!monitor) return;
    try { monitor.record(data); } catch {}
  };
  let activeRequests = 0;
  let draining = false;
  let closing;
  const drainedWaiters = [];
  let resolveStopped;
  const stopped = new Promise(resolve => { resolveStopped = resolve; });
  const configFile = path.join(root, 'config.json');
  const config = () => readConfig(configFile);
  const observedNatives = new Map();
  const allowedUids = new Set();
  let allowedMode = 'restricted';
  const nativeCacheFile = path.join(root, 'native-cache.json');
  let observedSize = 0;
  try {
    const seeded = loadNativeCache(nativeCacheFile);
    for (const entry of seeded.models) observedNatives.set(entry.uid, entry);
    allowedMode = seeded.allowedMode === 'unrestricted' ? 'unrestricted' : 'restricted';
    if (allowedMode !== 'unrestricted') for (const uid of seeded.allowedUids) allowedUids.add(uid);
    if (seeded.models.length) { observedSize = observedNatives.size; log('native-cache-load', { count: observedSize, allowed: allowedUids.size }); }
  } catch {}
  let cacheTimer;
  function flushNativeCache() {
    if (cacheTimer !== undefined) { clearTimeout(cacheTimer); cacheTimer = undefined; }
    try { saveNativeCache(nativeCacheFile, [...observedNatives.values()], { allowedUids: [...allowedUids], allowedMode }); } catch {}
  }
  // Waiting for a drain is not the same as being able to wait forever. A
  // half-read SSE stream can leave a request that never settles — the response
  // is neither finished nor closed — so `release()` never runs, the drain never
  // completes, and `close()`/`stopped` never resolve. That is what made SIGTERM
  // a no-op (its handler awaits `close()`) and left an orphan backend that only
  // SIGKILL could remove. Bounded waits keep shutdown finite; whatever is still
  // open is force-closed afterwards.
  function waitForDrain(ms) {
    if (activeRequests === 0) return Promise.resolve(true);
    return new Promise(resolve => {
      let timer;
      const waiter = () => { clearTimeout(timer); resolve(true); };
      timer = setTimeout(() => {
        const index = drainedWaiters.indexOf(waiter);
        if (index >= 0) drainedWaiters.splice(index, 1);
        resolve(false);
      }, ms);
      timer.unref?.();
      drainedWaiters.push(waiter);
    });
  }
  // Bounded too: an abandoned queue is already unwritable, and blocking the exit
  // on it would reintroduce the hang this whole path exists to avoid.
  async function closeMonitor(ms) {
    if (!monitor) return true;
    let timer;
    const bound = new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); timer.unref?.(); });
    try {
      return await Promise.race([Promise.resolve(monitor.close()).then(() => true, () => true), bound]);
    } catch { return true; } finally { clearTimeout(timer); }
  }
  function scheduleNativeCacheSave() {
    if (cacheTimer !== undefined) return;
    cacheTimer = setTimeout(() => { cacheTimer = undefined; flushNativeCache(); }, 2000);
    cacheTimer.unref?.();
  }
  // Persisted copies must converge to the richest observation, not just to the
  // newest uid set: a seeded entry can lack the Fusion family metadata that a
  // later observation carries, and gating the save on the entry count alone
  // (a full seed never changes it) meant that improvement was never written —
  // every restart re-seeded the poorer form and the mirrored combinations
  // flipped between complete and empty.
  const onNativeModels = entries => {
    if (!Array.isArray(entries)) return;
    let improved = false;
    for (const entry of entries) {
      const normalized = normalizeNativeEntry(entry);
      if (!normalized) continue;
      const prior = observedNatives.get(normalized.uid);
      const merged = mergeNativeEntry(prior, normalized);
      const dimsOf = value => JSON.stringify([value.sidekickDimension ?? null, value.fusionMetadata ?? null]);
      if (!prior || prior.disabled !== merged.disabled || prior.label !== merged.label ||
        dimsOf(prior) !== dimsOf(merged)) improved = true;
      observedNatives.set(normalized.uid, merged);
    }
    const grew = observedNatives.size !== observedSize;
    if (grew) { observedSize = observedNatives.size; log('native-observed', { count: observedSize }); }
    if (grew || improved) scheduleNativeCacheSave();
  };
  // Team settings publish the account's selectable uid set. It is a complete
  // list, so each observation replaces the previous one outright — a retired
  // model (o3 next to GPT-4.1) must drop out rather than linger in a union.
  let allowedEmptyStreak = 0;
  const onAllowedUids = observation => {
    const mode = observation?.kind === 'unrestricted' ? 'unrestricted' : 'restricted';
    const next = normalizeAllowedUids(observation?.uids || []);
    if (mode === 'restricted' && !next.length) return;
    // A confirmed submission (control POST, or a debounced raw verdict below)
    // always resets the raw streak, even when it changes nothing.
    allowedEmptyStreak = 0;
    if (mode === allowedMode && next.length === allowedUids.size && next.every(uid => allowedUids.has(uid))) return;
    allowedMode = mode;
    allowedUids.clear();
    for (const uid of next) allowedUids.add(uid);
    log('native-allowed', { count: allowedUids.size, mode: allowedMode });
    scheduleNativeCacheSave();
  };
  // The raw CLI channel is weaker than a confirmed host submission: an empty
  // verdict needs three consecutive sightings before it may lift a
  // restriction, while a restricted verdict applies at once and a malformed
  // observation (null) only resets the streak.
  const onObservedAllowedUids = observation => {
    if (observation?.kind === 'unrestricted') {
      allowedEmptyStreak += 1;
      if (allowedEmptyStreak < 3) return;
      allowedEmptyStreak = 0;
      onAllowedUids(observation);
      return;
    }
    allowedEmptyStreak = 0;
    if (observation?.kind === 'restricted') onAllowedUids(observation);
  };
  const getCatalog = () => { const current = config(); return buildCatalog(current.enabled === false ? { ...current, providers: [] } : current, [...observedNatives.values()], allowedMode === 'unrestricted' ? null : allowedUids); };
  // Official Fusion uids observed as disabled in catalog responses. Entries
  // that later appear enabled are removed so Pro accounts keep native Fusion.
  // Persisted so a saved locked preference still redirects when a fresh
  // session assigns before the first catalog pass of this process.
  const lockedFusionFile = path.join(root, 'locked-fusion.json');
  const lockedFusion = new Set();
  try {
    for (const uid of JSON.parse(fs.readFileSync(lockedFusionFile, 'utf8')))
      if (typeof uid === 'string' && uid.startsWith('fusion-')) lockedFusion.add(uid);
  } catch {}
  const onFusionStatus = (locked, seen) => {
    const keep = new Set(locked);
    let changed = false;
    for (const uid of seen) {
      if (keep.has(uid)) { if (!lockedFusion.has(uid)) { lockedFusion.add(uid); changed = true; } }
      else changed = lockedFusion.delete(uid) || changed;
    }
    if (changed) {
      try { fs.writeFileSync(lockedFusionFile, JSON.stringify([...lockedFusion]), { mode: 0o600 }); } catch {}
      log('fusion-status', { locked: lockedFusion.size, seen: seen.length });
    }
  };
  // Ingest the extension host's observations. The two sides see the same
  // upstream catalog through different channels and their copies are not
  // equally complete: this process only learns from the CLI's traffic, whose
  // payloads can lack the Fusion family metadata, while the host reads the
  // native extension's traffic. Without this the CLI's own cache keeps winning
  // (24 combinations) against the host's richer view (155), and the picker
  // loses every native Sidekick pairing until the host rewrites the cache.
  const ingest = entries => {
    if (!Array.isArray(entries) || entries.length > MAX_INGEST_ENTRIES) return null;
    let accepted = 0, improved = false;
    for (const entry of entries) {
      const normalized = normalizeNativeEntry(entry);
      // Never store our own entries: the host's reader treats a served dfbyok
      // uid as an invalid catalog and would fail every refresh.
      if (!normalized || /^(?:fusion-)?dfbyok-/.test(normalized.uid)) continue;
      accepted++;
      const prior = observedNatives.get(normalized.uid);
      const merged = mergeNativeEntry(prior, normalized);
      if (!prior || JSON.stringify(prior) !== JSON.stringify(merged)) improved = true;
      observedNatives.set(normalized.uid, merged);
    }
    if (observedNatives.size !== observedSize) {
      observedSize = observedNatives.size;
      log('native-observed', { count: observedSize, source: 'host' });
      improved = true;
    }
    if (improved) scheduleNativeCacheSave();
    return { accepted, count: observedNatives.size, improved };
  };
  const control = createRuntimeControl({
    identity, instanceId, controlToken,
    managementProtocol: MANAGEMENT_PROTOCOL, nativeModelsProtocol: 1, nativeModelsIngest: NATIVE_MODELS_INGEST,
    monitorProtocol: monitor ? 1 : 0,
    getActiveRequests: () => activeRequests, getDraining: () => draining, setDraining: value => { draining = value; },
    monitor, getNativeModels: () => [...observedNatives.values()], getAllowedUids: () => [...allowedUids].sort(), getAllowedMode: () => allowedMode,
    ingest, onAllowedUids, close,
    upstreamProtocol: 1,
    resolveUpstream: resolveUpstreamOrigin,
    setUpstream: resolved => {
      upstreamOrigin = resolved ?? DEFAULT_UPSTREAM;
      // Only the boolean reaches the log: the origin string can carry a
      // tenant host name, which is exactly what must never be recorded.
      const custom = upstreamOrigin !== DEFAULT_UPSTREAM;
      log('upstream-origin', { custom });
      return custom;
    },
  });
  const handle = async (request, response) => {
    const incoming = new URL(request.url, 'https://server.codeium.com');
    const rpc = incoming.pathname;
    const target = new URL(upstreamOrigin + rpc + incoming.search);
    // Forwarded traffic shares the process log; the client port lets each event
    // be traced back to the connecting process afterwards (lsof -i TCP:<port>).
    const forwardLog = (event, fields) => log(event, { ...fields, peerPort: request.socket?.remotePort });
    if (request.method !== 'POST' || ![API_PREFIX + 'AssignModel', API_PREFIX + 'GetChatMessage'].includes(rpc)) {
      forward(request, response, target, { rpc, getCatalog, log: forwardLog, onFusionStatus, onNativeModels, onAllowedUids: onObservedAllowedUids }); return;
    }
    let body;
    try {
      body = await collect(request);
      const format = wire.decode(body, request.headers);
      const current = config(), catalog = buildCatalog(current.enabled === false ? { ...current, providers: [] } : current, [...observedNatives.values()], allowedMode === 'unrestricted' ? null : allowedUids);
      if (rpc.endsWith('/AssignModel')) {
        // Anything outside the AssignModelRequest table above means the client
        // started sending intent we never modeled. Observation only: field
        // numbers or key names, never values, and never a rejection.
        const unknownAssignFields = () => {
          try {
            if (format.json) return Object.keys(format.data).filter(key => !KNOWN_ASSIGN_KEYS.has(key));
            return wire.parseFields(format.data).map(field => field.number).filter(number => !KNOWN_ASSIGN_FIELDS.has(number));
          } catch { return []; }
        };
        const unknown = unknownAssignFields();
        if (unknown.length) log('assignment-request-unknown', { fields: unknown });
        const resolved = resolveAssignment(format.data, format, catalog, lockedFusion);
        if (resolved) {
          const output = wire.encode(resolved, { ...format, gzip: false, compressed: false });
          response.writeHead(200, { 'content-type': format.type, 'content-length': output.length, 'connect-protocol-version': '1' });
          response.end(output);
          if (resolved.redirectedFrom) log('assignment-redirect', { from: resolved.redirectedFrom, bytes: output.length });
          else log('assignment', { bytes: output.length });
          return;
        }
      } else {
        const chat = parseChat(format.data);
        const route = Object.hasOwn(catalog.routes, chat.modelUid) ? catalog.routes[chat.modelUid] : undefined;
        if (route) {
          const provider = current.providers.find(p => p.id === route.providerId);
          if (!provider) throw new Error('Provider missing');
          const abort = new AbortController();
          response.on('close', () => { if (!response.writableFinished) abort.abort(); });
          log('inference', { model: route.model, effort: route.effort, tools: chat.tools.map(t => t.name) });
          await serveChat({ request: chat, route, provider, res: response, signal: abort.signal,
            log: ({ event, ...data }) => log(event, data), onMetrics: recordMetrics, cacheSupport });
          return;
        }
      }
    } catch (error) {
      log('request-error', { code: 'request_failed', rpc: rpc.split('/').pop() });
      if (response.headersSent) { response.end(); return; }
      // Malformed data must never select a default provider.
    }
    if (body) forward(request, response, target, { body, rpc, getCatalog, log: forwardLog, onFusionStatus, onNativeModels, onAllowedUids: onObservedAllowedUids });
    else { response.writeHead(502); response.end(); }
  };
  const server = http.createServer((request, response) => {
    if (request.headers.origin) { response.writeHead(403); response.end(); return; }
    if (control(request, response)) return;
    if (draining) {
      response.writeHead(503); response.end(); return;
    }
    if (!/^\/exa\.[a-z_]+\.[A-Za-z]+Service\/[A-Za-z]+(?:\?|$)/.test(request.url)) {
      response.writeHead(404); response.end(); return;
    }
    activeRequests++;
    let responseSettled = false, handlerSettled = false, settled = false;
    const release = () => {
      if (settled || !responseSettled || !handlerSettled) return;
      settled = true; activeRequests--;
      if (!activeRequests) while (drainedWaiters.length) drainedWaiters.shift()();
    };
    response.once('finish', () => { responseSettled = true; release(); });
    response.once('close', () => { responseSettled = true; release(); });
    handle(request, response).catch(() => {
      log('request-error', { code: 'request_failed' });
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }).finally(() => { handlerSettled = true; release(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stateFile = controlFile(root), temporary = stateFile + '.' + instanceId;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ ...identity, instanceId, token: controlToken }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, stateFile);
  } catch (error) { fs.rmSync(temporary, { force: true }); server.close(); throw error; }
  function close() {
    if (closing) return closing;
    draining = true;
    closing = (async () => {
      flushNativeCache();
      if (!await waitForDrain(drainTimeoutMs)) log('drain-timeout', { activeRequests });
      if (!await closeMonitor(drainTimeoutMs)) log('monitor-close-timeout');
      const releaseControlFile = () => {
        try {
          if (JSON.parse(fs.readFileSync(stateFile, 'utf8')).instanceId === instanceId) fs.unlinkSync(stateFile);
        } catch { /* Another runtime may already own the control file. */ }
      };
      // `server.close()` waits for every connection to end, so a lingering
      // keep-alive or half-written request keeps the port bound and `stopped`
      // pending. Bound it, then force the rest closed: an idle-only sweep is not
      // enough, and the process must always reach `stopped` so its exit path runs.
      // Sampled before the sweep so the event says how much was still attached.
      const attached = () => new Promise(resolve => {
        let settled = false, timer;
        const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
        timer = setTimeout(() => finish(null), 100);
        timer.unref?.();
        try { server.getConnections((error, count) => finish(error ? null : count)); } catch { finish(null); }
      });
      const closed = await new Promise(resolve => {
        let timer;
        server.close(() => { clearTimeout(timer); releaseControlFile(); resolve(true); });
        server.closeIdleConnections?.();
        timer = setTimeout(async () => {
          const connections = await attached();
          server.closeAllConnections?.();
          releaseControlFile();
          resolve(connections === null ? {} : { connections });
        }, socketCloseTimeoutMs);
        timer.unref?.();
      });
      if (closed !== true) log('close-timeout', closed);
      resolveStopped();
    })();
    return closing;
  }
  log('ready', { port: server.address().port, version: VERSION });
  return { port: server.address().port, close, stopped };
}
if (require.main === module) {
  const root = process.argv[2];
  if (!root) process.exit(2);
  const logFile = path.join(root, 'runtime.log');
  const log = (event, data = {}) => {
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2 * 1024 * 1024) fs.renameSync(logFile, logFile + '.previous');
      fs.appendFileSync(logFile, JSON.stringify({ time: new Date().toISOString(), event, ...data }) + '\n', { mode: 0o600 });
    } catch {}
  };
  startBackend({ root, log }).then(backend => {
    backend.stopped.then(() => process.exit(0));
    for (const name of ['SIGTERM', 'SIGINT']) process.on(name, () => backend.close().then(() => process.exit(0)));
  }).catch(error => {
    if (error.code === 'EADDRINUSE') { log('backend-adopted', { code: 'port_in_use' }); process.exit(0); }
    log('startup-error', { code: 'startup_failed' }); process.exit(1);
  });
}
module.exports = { startBackend, runtimeIdentity, controlFile, PORT, VERSION, MANAGEMENT_PROTOCOL, DEFAULT_UPSTREAM, resolveUpstreamOrigin };

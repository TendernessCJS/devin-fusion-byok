'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readConfig } = require('../config.cjs');
const { buildCatalog, resolveAssignment } = require('../catalog.cjs');
const wire = require('../protocol/wire.cjs');
const { parseChat } = require('../protocol/chat.cjs');
const { serveChat } = require('../protocol/responses.cjs');
const { forward, collect } = require('./bridge.cjs');
const { normalizeNativeEntry, mergeNativeEntry, loadNativeCache, saveNativeCache, normalizeAllowedUids } = require('./native-cache.cjs');
const PORT = 39842;
const VERSION = require('../../package.json').version;
const API_PREFIX = '/exa.api_server_pb.ApiServerService/';
const SERVICE = 'devin-fusion-byok';
const MANAGEMENT_PROTOCOL = 1;
// Capability flag for POST /_runtime/native-models. Kept separate from
// nativeModelsProtocol so the read contract stays unchanged: a host talking to
// an older backend simply sees no flag and skips pushing instead of erroring.
const NATIVE_MODELS_INGEST = 1;
const MAX_INGEST_ENTRIES = 5000;
// Upper bound for each shutdown wait (in-flight requests, monitor flush, socket
// closure). Generous enough that ordinary drains finish first, short enough that
// a stuck one cannot turn SIGTERM into a no-op.
const DRAIN_TIMEOUT_MS = 5000;
const SOURCE_FILES = ['../../package.json', 'backend.cjs', 'bridge.cjs', 'monitor.cjs', 'monitor-stats.cjs', 'native-cache.cjs', '../config.cjs', '../proxy.cjs', '../update.cjs', '../catalog.cjs', '../model-capabilities.cjs', '../protocol/wire.cjs', '../protocol/chat.cjs', '../protocol/responses.cjs', '../protocol/anthropic.cjs'];
function sourceId() {
  const hash = crypto.createHash('sha256');
  for (const name of SOURCE_FILES) hash.update(name).update('\0').update(fs.readFileSync(path.resolve(__dirname, name))).update('\0');
  return hash.digest('hex');
}
const LOADED_SOURCE_ID = sourceId();
function runtimeIdentity(root, freshSource = false) {
  return { service: SERVICE, version: VERSION, sourceId: freshSource ? sourceId() : LOADED_SOURCE_ID,
    rootId: crypto.createHash('sha256').update(path.resolve(root)).digest('hex') };
}
function controlFile(root) { return path.join(root, 'runtime-control.json'); }

async function startBackend({ root, port = PORT, log = () => {}, drainTimeoutMs = DRAIN_TIMEOUT_MS }) {
  const identity = runtimeIdentity(root);
  const instanceId = crypto.randomUUID();
  const controlToken = crypto.randomBytes(32).toString('hex');
  let monitor;
  try {
    const { createMonitor } = require('./monitor.cjs');
    monitor = createMonitor({ root });
  } catch { log('monitor-unavailable'); }
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
  const nativeCacheFile = path.join(root, 'native-cache.json');
  let observedSize = 0;
  try {
    const seeded = loadNativeCache(nativeCacheFile);
    for (const entry of seeded.models) observedNatives.set(entry.uid, entry);
    for (const uid of seeded.allowedUids) allowedUids.add(uid);
    if (seeded.models.length) { observedSize = observedNatives.size; log('native-cache-load', { count: observedSize, allowed: allowedUids.size }); }
  } catch {}
  let cacheTimer;
  function flushNativeCache() {
    if (cacheTimer !== undefined) { clearTimeout(cacheTimer); cacheTimer = undefined; }
    try { saveNativeCache(nativeCacheFile, [...observedNatives.values()], { allowedUids: [...allowedUids] }); } catch {}
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
  const onAllowedUids = uids => {
    const next = normalizeAllowedUids(uids);
    if (!next.length) return;
    if (next.length === allowedUids.size && next.every(uid => allowedUids.has(uid))) return;
    allowedUids.clear();
    for (const uid of next) allowedUids.add(uid);
    log('native-allowed', { count: allowedUids.size });
    scheduleNativeCacheSave();
  };
  const getCatalog = () => { const current = config(); return buildCatalog(current.enabled === false ? { ...current, providers: [] } : current, [...observedNatives.values()], allowedUids); };
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
  const authorized = request => {
    const provided = typeof request.headers.authorization === 'string' ? request.headers.authorization : '';
    const expected = 'Bearer ' + controlToken;
    return Buffer.byteLength(provided) === Buffer.byteLength(expected) &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  };
  const handle = async (request, response) => {
    const incoming = new URL(request.url, 'https://server.codeium.com');
    const rpc = incoming.pathname;
    const target = new URL(rpc + incoming.search, 'https://server.codeium.com');
    if (request.method !== 'POST' || ![API_PREFIX + 'AssignModel', API_PREFIX + 'GetChatMessage'].includes(rpc)) {
      forward(request, response, target, { getCatalog, log, onFusionStatus, onNativeModels, onAllowedUids }); return;
    }
    let body;
    try {
      body = await collect(request);
      const format = wire.decode(body, request.headers);
      const current = config(), catalog = buildCatalog(current.enabled === false ? { ...current, providers: [] } : current, [...observedNatives.values()], allowedUids);
      if (rpc.endsWith('/AssignModel')) {
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
            log: ({ event, ...data }) => log(event, data), onMetrics: recordMetrics });
          return;
        }
      }
    } catch (error) {
      log('request-error', { code: 'request_failed', rpc: rpc.split('/').pop() });
      if (response.headersSent) { response.end(); return; }
      // Malformed data must never select a default provider.
    }
    if (body) forward(request, response, target, { body, getCatalog, log, onFusionStatus, onNativeModels, onAllowedUids });
    else { response.writeHead(502); response.end(); }
  };
  const server = http.createServer((request, response) => {
    if (request.headers.origin) { response.writeHead(403); response.end(); return; }
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ...identity, pid: process.pid, instanceId, managementProtocol: MANAGEMENT_PROTOCOL, nativeModelsProtocol: 1, nativeModelsIngest: NATIVE_MODELS_INGEST, monitorProtocol: monitor ? 1 : 0, activeRequests, draining })); return;
    }
    if (request.method === 'GET' && request.url === '/_runtime/monitor') {
      if (!authorized(request)) { response.writeHead(403); response.end(); return; }
      Promise.resolve().then(() => monitor?.snapshot()).then(snapshot => {
        if (response.destroyed) return;
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ instanceId, snapshot: snapshot || null }));
      }).catch(() => { if (!response.destroyed) { response.writeHead(503); response.end(); } });
      return;
    }
    if (request.method === 'GET' && request.url === '/_runtime/native-models') {
      if (!authorized(request)) { response.writeHead(403); response.end(); return; }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ instanceId, models: [...observedNatives.values()], allowedUids: [...allowedUids].sort() })); return;
    }
    if (request.method === 'POST' && request.url === '/_runtime/native-models') {
      if (!authorized(request)) { response.writeHead(403); response.end(); return; }
      collect(request).then(body => {
        if (body.length > 4 * 1024 * 1024) throw new Error('too_large');
        const payload = JSON.parse(body.toString('utf8'));
        const result = ingest(payload?.models);
        if (result && Array.isArray(payload?.allowedUids)) onAllowedUids(payload.allowedUids);
        if (!result) throw new Error('invalid');
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ instanceId, ...result }));
      }).catch(() => {
        if (response.destroyed) return;
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ instanceId, error: 'invalid_payload' }));
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/_runtime/shutdown') {
      if (!authorized(request)) { response.writeHead(403); response.end(); return; }
      if (activeRequests > 0) {
        response.writeHead(409, { 'content-type': 'application/json' }); response.end(JSON.stringify({ activeRequests })); return;
      }
      // Check and transition synchronously. A request racing the health check
      // either makes shutdown busy or is rejected before work starts.
      draining = true;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.once('finish', () => { close(); });
      response.end('{"stopping":true}');
      return;
    }
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
      // keep-alive or stream keeps the port bound and `stopped` pending. Bound
      // it, then force the rest closed: an idle-only sweep is not enough, and
      // the process must always reach `stopped` so its exit path runs.
      const closed = await new Promise(resolve => {
        let timer;
        server.close(() => { clearTimeout(timer); releaseControlFile(); resolve(true); });
        server.closeIdleConnections?.();
        timer = setTimeout(() => {
          server.closeAllConnections?.();
          releaseControlFile();
          resolve(false);
        }, drainTimeoutMs);
        timer.unref?.();
      });
      if (!closed) log('close-timeout');
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
  }).catch(error => { log('startup-error', { code: error.code === 'EADDRINUSE' ? 'port_in_use' : 'startup_failed' }); process.exit(error.code === 'EADDRINUSE' ? 0 : 1); });
}
module.exports = { startBackend, runtimeIdentity, controlFile, PORT, VERSION, MANAGEMENT_PROTOCOL };

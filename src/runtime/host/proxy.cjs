'use strict';
const fs = require('node:fs');
const http = require('node:http');
const { rootIdentity, controlFile } = require('../contract.cjs');
const { PORT } = require('../port.cjs');
const { isConnectionFailure } = require('./retry.cjs');

const MAX_RESPONSE_BYTES = 64 * 1024;
const SAFE_SOURCES = new Set(['settings', 'environment', 'none']);

// Control-plane transport via the public ClientRequest *constructor*. The
// extension host may patch http.request/http.get under proxySupport:override,
// which would silently route this bearer-token call through the user's proxy;
// constructing the request directly keeps the token on 127.0.0.1. agent:false
// gives every attempt a fresh TCP connection (same-port handover races), and
// redirects are never followed — a 3xx answer is a failed attempt.
function httpFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    const abortError = () => Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
    let request;
    try {
      request = new http.ClientRequest(url, {
        method: init.method || 'GET', agent: false, headers: init.headers,
      }, response => {
        const chunks = [];
        let length = 0;
        response.on('data', chunk => {
          length += chunk.length;
          if (length > MAX_RESPONSE_BYTES) { request.destroy(abortError()); return; }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          done(null, { ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode, json: async () => JSON.parse(text), text: async () => text });
        });
        response.on('error', error => done(error));
        response.on('aborted', () => done(abortError()));
        response.resume();
      });
    } catch (error) { return done(error); }
    const onAbort = () => request.destroy(abortError());
    request.on('error', error => done(error));
    if (init.signal?.aborted) { request.destroy(abortError()); return; }
    init.signal?.addEventListener('abort', onAbort, { once: true });
    request.on('close', () => init.signal?.removeEventListener('abort', onAbort));
    request.end(init.body);
  });
}

// Pushes the compiled-at-host proxy config to the running backend. Only the
// policy payload crosses this channel — and only `ok`/safe reason enums ever
// come back out, so a proxy URL or its credentials can never land in the log.
async function attempt({ root, config, port = PORT, signal, request = httpFetch }) {
  const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000);
  const base = 'http://127.0.0.1:' + port;
  let health;
  try {
    const response = await request(base + '/health', { signal: timeout, redirect: 'error' });
    if (!response.ok) return { ok: false, reason: 'unavailable' };
    health = await response.json();
  } catch (error) {
    if (isConnectionFailure(error)) throw error;
    return { ok: false, reason: 'unavailable' };
  }
  const expected = rootIdentity(root);
  if (health.service !== expected.service || !health.instanceId) return { ok: false, reason: 'identity', detail: 'service' };
  if (health.rootId !== expected.rootId) return { ok: false, reason: 'identity', detail: 'root' };
  // An older backend has no proxy endpoint; 'unsupported' is a terminal
  // answer, never a silent success.
  if (health.proxyProtocol !== 1) return { ok: false, reason: 'unsupported' };
  let control;
  try { control = JSON.parse(fs.readFileSync(controlFile(root), 'utf8')); } catch { return { ok: false, reason: 'identity', detail: 'control', retriable: true }; }
  if (control.rootId !== health.rootId) return { ok: false, reason: 'identity', detail: 'root' };
  if (control.instanceId !== health.instanceId) return { ok: false, reason: 'identity', detail: 'instance', retriable: true };
  // sourceId must be a real 64-hex digest on both sides — two undefined fields
  // comparing equal must never authenticate a bearer exchange.
  if (!/^[a-f0-9]{64}$/.test(control.sourceId || '') || !/^[a-f0-9]{64}$/.test(health.sourceId || '') ||
      control.sourceId !== health.sourceId) return { ok: false, reason: 'identity', detail: 'source', retriable: true };
  if (!/^[a-f0-9]{64}$/.test(control.token || '')) return { ok: false, reason: 'identity', detail: 'token', retriable: true };
  try {
    const response = await request(base + '/_runtime/proxy', {
      method: 'POST', signal: timeout, redirect: 'error',
      headers: { authorization: 'Bearer ' + control.token, 'content-type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (response.status === 404) return { ok: false, reason: 'unsupported' };
    if (!response.ok) return { ok: false, reason: response.status === 400 ? 'invalid' : 'rejected' };
    const result = await response.json();
    if (result.instanceId !== health.instanceId) return { ok: false, reason: 'identity', detail: 'post-instance', retriable: true };
    if (result.ready !== true) return { ok: false, reason: 'invalid' };
    return { ok: true, ready: true };
  } catch (error) {
    if (isConnectionFailure(error)) throw error;
    return { ok: false, reason: 'unavailable' };
  }
}
const RETRY_PAUSES = [100, 250, 500];
function wait(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    let timer;
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
async function pushProxy(options) {
  let result;
  for (let index = 0; index <= RETRY_PAUSES.length; index++) {
    if (options.signal?.aborted) { result ??= { ok: false, reason: 'unavailable' }; break; }
    try { result = await attempt(options); }
    catch (error) {
      const code = error?.cause?.code ?? error?.code;
      if (index === RETRY_PAUSES.length || options.signal?.aborted) { result = { ok: false, reason: 'unavailable', code: String(code) }; break; }
      await wait(RETRY_PAUSES[index], options.signal);
      continue;
    }
    if (!result?.retriable || index === RETRY_PAUSES.length || options.signal?.aborted) break;
    await wait(RETRY_PAUSES[index], options.signal);
  }
  if (result) {
    delete result.retriable;
    // `source` echoes into logs — clamp to the enum even if a caller improvised.
    if (SAFE_SOURCES.has(options?.source)) result.source = options.source;
  }
  return result;
}
module.exports = { pushProxy, httpFetch };

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { rootIdentity, controlFile } = require('../contract.cjs');
const { PORT } = require('../port.cjs');
const { isConnectionFailure } = require('./retry.cjs');
// Control-plane default transport. The previous backend shares our port, so a
// pooled socket in this process can answer with the *old* instance's /health
// while the control file already belongs to the new one — and headers cannot
// disable pooling (undici ignores `connection: 'close'` for reuse, verified on
// Node 24). `agent: false` gives every attempt an independent TCP connection,
// shrinking "old instance answered" to a genuine timing window.
function httpFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: init.method || 'GET', agent: false, headers: init.headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode, json: async () => JSON.parse(text), text: async () => text });
      });
      response.on('error', reject);
    });
    // Abort must surface as a connection-layer error so the retry loop
    // recognizes it; request.destroy(error) emits that exact error. The error
    // listener goes on first: an already-aborted signal destroys before the
    // request ever connects, and an unhandled 'error' would crash the host.
    const aborted = () => Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
    const onAbort = () => request.destroy(aborted());
    request.on('error', reject);
    if (init.signal?.aborted) { request.destroy(aborted()); return; }
    init.signal?.addEventListener('abort', onAbort, { once: true });
    request.on('close', () => init.signal?.removeEventListener('abort', onAbort));
    request.end(init.body);
  });
}
// Pushes the native `codeium.apiServerUrl` value to the backend so forwarded
// RPCs follow the account's real upstream instead of the public SaaS default.
// Only the URL ever crosses this channel — credentials never do. Best-effort:
// a failure just means the backend keeps its default target.
// Connection-layer failures must reach the retry loop, so they are rethrown
// here instead of being flattened into 'unavailable'. The activation push lands
// exactly in the window where a freshly installed backend replaces the running
// one on the same port.
async function attempt({ root, origin, port = PORT, signal, request = httpFetch }) {
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
  // `detail` is a stable enum for diagnosis — values never leave the process.
  // A foreign service/root is a real mismatch — never retryable. But the
  // instance pair (control file vs health) can disagree legitimately for the
  // few hundred ms a same-port handover takes, so that class is retriable.
  if (health.service !== expected.service || !health.instanceId) return { ok: false, reason: 'identity', detail: 'service' };
  if (health.rootId !== expected.rootId) return { ok: false, reason: 'identity', detail: 'root' };
  // An older backend has no upstream endpoint; skipping is the correct outcome.
  if (health.upstreamProtocol !== 1) return { ok: false, reason: 'unsupported' };
  let control;
  try { control = JSON.parse(fs.readFileSync(controlFile(root), 'utf8')); } catch { return { ok: false, reason: 'identity', detail: 'control', retriable: true }; }
  if (control.rootId !== health.rootId) return { ok: false, reason: 'identity', detail: 'root' };
  if (control.instanceId !== health.instanceId) return { ok: false, reason: 'identity', detail: 'instance', retriable: true };
  if (control.sourceId !== health.sourceId) return { ok: false, reason: 'identity', detail: 'source', retriable: true };
  if (!/^[a-f0-9]{64}$/.test(control.token || '')) return { ok: false, reason: 'identity', detail: 'token', retriable: true };
  try {
    const response = await request(base + '/_runtime/upstream', {
      method: 'POST', signal: timeout, redirect: 'error',
      headers: { authorization: 'Bearer ' + control.token, 'content-type': 'application/json' },
      body: JSON.stringify({ origin: origin ?? null }),
    });
    if (!response.ok) return { ok: false, reason: response.status === 400 ? 'invalid' : 'rejected' };
    const result = await response.json();
    if (result.instanceId !== health.instanceId) return { ok: false, reason: 'identity', detail: 'post-instance', retriable: true };
    return { ok: true, custom: result.custom === true };
  } catch (error) {
    if (isConnectionFailure(error)) throw error;
    return { ok: false, reason: 'unavailable' };
  }
}
const RETRY_PAUSES = [100, 250, 500];
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function pushUpstream(options) {
  let result;
  for (let index = 0; index <= RETRY_PAUSES.length; index++) {
    try { result = await attempt(options); }
    catch (error) {
      const code = error?.cause?.code ?? error?.code;
      if (index === RETRY_PAUSES.length || options.signal?.aborted) { result = { ok: false, reason: 'unavailable', code: String(code) }; break; }
      await wait(RETRY_PAUSES[index]);
      continue;
    }
    // A retriable identity mismatch is the same handover race as a dead socket:
    // the health answer arrived, it just described the old instance. It shares
    // the same bounded pauses — four attempts total.
    if (!result?.retriable || index === RETRY_PAUSES.length || options.signal?.aborted) break;
    await wait(RETRY_PAUSES[index]);
  }
  // `retriable` is internal control flow only — it must never reach the log or
  // the receipt, so strip it explicitly rather than relying on the shape.
  if (result) delete result.retriable;
  // The host's own log line goes to the extension output channel, which is never
  // persisted, so a later reader cannot tell whether a push happened at all.
  // Record the outcome in a receipt next to the control file: same payload rules
  // as the log — the boolean and the reason only, never the origin.
  try {
    fs.writeFileSync(path.join(options.root, 'upstream-push.json'),
      JSON.stringify({ at: new Date().toISOString(), ...result }));
  } catch {}
  return result;
}
module.exports = { pushUpstream, httpFetch };

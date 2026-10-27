'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { rootIdentity, controlFile } = require('../contract.cjs');
const { PORT } = require('../port.cjs');
const { isConnectionFailure } = require('./retry.cjs');
// Pushes the native `codeium.apiServerUrl` value to the backend so forwarded
// RPCs follow the account's real upstream instead of the public SaaS default.
// Only the URL ever crosses this channel — credentials never do. Best-effort:
// a failure just means the backend keeps its default target.
// Connection-layer failures must reach the retry loop, so they are rethrown
// here instead of being flattened into 'unavailable'. The activation push lands
// exactly in the window where a freshly installed backend replaces the running
// one on the same port, where a pooled keep-alive socket is already dead.
async function attempt({ root, origin, port = PORT, signal, request = fetch }) {
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
  if (health.service !== expected.service || health.rootId !== expected.rootId || !health.instanceId) return { ok: false, reason: 'identity' };
  // An older backend has no upstream endpoint; skipping is the correct outcome.
  if (health.upstreamProtocol !== 1) return { ok: false, reason: 'unsupported' };
  let control;
  try { control = JSON.parse(fs.readFileSync(controlFile(root), 'utf8')); } catch { return { ok: false, reason: 'identity' }; }
  if (control.rootId !== health.rootId || control.instanceId !== health.instanceId || control.sourceId !== health.sourceId ||
    !/^[a-f0-9]{64}$/.test(control.token || '')) return { ok: false, reason: 'identity' };
  try {
    const response = await request(base + '/_runtime/upstream', {
      method: 'POST', signal: timeout, redirect: 'error',
      headers: { authorization: 'Bearer ' + control.token, 'content-type': 'application/json' },
      body: JSON.stringify({ origin: origin ?? null }),
    });
    if (!response.ok) return { ok: false, reason: response.status === 400 ? 'invalid' : 'rejected' };
    const result = await response.json();
    if (result.instanceId !== health.instanceId) return { ok: false, reason: 'identity' };
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
    try { result = await attempt(options); break; }
    catch (error) {
      const code = error?.cause?.code ?? error?.code;
      if (index === RETRY_PAUSES.length || options.signal?.aborted) { result = { ok: false, reason: 'unavailable', code: String(code) }; break; }
      if (index < RETRY_PAUSES.length) await wait(RETRY_PAUSES[index]);
    }
  }
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
module.exports = { pushUpstream };

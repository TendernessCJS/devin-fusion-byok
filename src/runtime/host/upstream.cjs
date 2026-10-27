'use strict';
const fs = require('node:fs');
const { rootIdentity, controlFile } = require('../contract.cjs');
const { PORT } = require('../port.cjs');
// Pushes the native `codeium.apiServerUrl` value to the backend so forwarded
// RPCs follow the account's real upstream instead of the public SaaS default.
// Only the URL ever crosses this channel — credentials never do. Best-effort:
// a failure just means the backend keeps its default target.
async function pushUpstream({ root, origin, port = PORT, signal, request = fetch }) {
  const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000);
  const base = 'http://127.0.0.1:' + port;
  let health;
  try {
    const response = await request(base + '/health', { signal: timeout, redirect: 'error' });
    if (!response.ok) return { ok: false, reason: 'unavailable' };
    health = await response.json();
  } catch { return { ok: false, reason: 'unavailable' }; }
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
  } catch { return { ok: false, reason: 'unavailable' }; }
}
module.exports = { pushUpstream };

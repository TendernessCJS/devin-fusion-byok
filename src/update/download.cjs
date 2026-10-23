'use strict';
const { directFetch } = require('../network/direct-fetch.cjs');
// Member access keeps a single allowlist entry point: tests swap it for local
// fixtures, and resolving through the module means both transports honour it.
const policy = require('./url-policy.cjs');
const { proxyRequestBytes } = require('./proxy-transport.cjs');

async function requestBytes(url, { limit, signal, fetchImpl, timeout = 30000, proxy = null }) {
  if (proxy) return proxyRequestBytes(url, { proxy, limit, signal, timeout });
  fetchImpl ??= directFetch;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeout);
  try {
    for (let hops = 0; hops <= 5; hops++) {
      const target = policy.allowedUrl(url);
      const response = await fetchImpl(target.href, { signal: controller.signal, redirect: 'manual', headers: { 'User-Agent': 'devin-fusion-byok', Accept: 'application/vnd.github+json' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location'); if (!location) throw Error('redirect');
        url = new URL(location, target).href; continue;
      }
      if (response.status !== 200 || Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw Error('http'); }
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > limit || controller.signal.aborted) { await reader.cancel(); throw Error('size'); }
        chunks.push(Buffer.from(value));
      }
      if (controller.signal.aborted) throw Error('aborted');
      return Buffer.concat(chunks);
    }
    throw Error('redirect');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

module.exports = { requestBytes, proxyRequestBytes };

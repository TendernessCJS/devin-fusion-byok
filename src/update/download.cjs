'use strict';
const { directFetch } = require('../network/direct-fetch.cjs');
const { proxyFor, compileProxyPolicy } = require('../network/proxy-policy.cjs');
const { request } = require('./proxy-transport.cjs');
const { transferBytes } = require('./transfer.cjs');

// No proxy configured anywhere: every hop is DIRECT. Kept as a compiled
// snapshot so the routing call below never special-cases "no policy".
const DIRECT_POLICY = compileProxyPolicy({ httpProxy: '', httpsProxy: '', noProxy: [] });

// One transferBytes loop owns the hop budget, total timeout and size limit.
// noProxy is re-evaluated per redirect target against the *same* snapshot —
// settings are not re-read mid-transfer and a proxy failure never falls back.
async function requestBytes(url, { limit, signal, fetchImpl, timeout = 30000, proxyPolicy = DIRECT_POLICY, connect }) {
  fetchImpl ??= directFetch;
  return transferBytes(url, { limit, signal, timeout, open: async (target, { signal }) => {
    const via = proxyFor(proxyPolicy, target);
    if (via) {
      const response = await request(target, { proxy: via, signal, connect });
      return {
        status: response.statusCode,
        location: response.headers.location,
        length: response.headers['content-length'],
        body: response,
        cancel: () => { response.destroy(); }
      };
    }
    const response = await fetchImpl(target.href, { signal, redirect: 'manual', headers: { 'User-Agent': 'devin-fusion-byok', Accept: 'application/vnd.github+json' } });
    const reader = response.body ? response.body.getReader() : null;
    return {
      status: response.status,
      location: response.headers.get('location'),
      length: response.headers.get('content-length'),
      body: reader && { async *[Symbol.asyncIterator]() {
        for (;;) { const { done, value } = await reader.read(); if (done) return; yield Buffer.from(value); }
      } },
      cancel: () => (reader ? reader.cancel() : Promise.resolve())
    };
  } });
}

module.exports = { requestBytes };

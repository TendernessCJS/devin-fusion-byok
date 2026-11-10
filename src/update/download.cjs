'use strict';
const { directFetch } = require('../network/direct-fetch.cjs');
const { proxyRequestBytes } = require('./proxy-transport.cjs');
const { transferBytes } = require('./transfer.cjs');

async function requestBytes(url, { limit, signal, fetchImpl, timeout = 30000, proxy = null }) {
  if (proxy) return proxyRequestBytes(url, { proxy, limit, signal, timeout });
  fetchImpl ??= directFetch;
  return transferBytes(url, { limit, signal, timeout, open: async (target, { signal }) => {
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

module.exports = { requestBytes, proxyRequestBytes };

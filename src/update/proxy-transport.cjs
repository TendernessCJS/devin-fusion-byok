'use strict';
const tls = require('node:tls');
const { createRequest } = require('../network/client-request.cjs');
const { tunnel } = require('../network/proxy-tunnel.cjs');
const { transferBytes } = require('./transfer.cjs');

function request(target, { proxy, signal, connect }) {
  const secure = target.protocol === 'https:';
  const port = target.port || (secure ? 443 : 80);
  const options = {
    host: target.hostname, port, method: 'GET', path: target.pathname + target.search,
    headers: { 'User-Agent': 'devin-fusion-byok', Accept: 'application/vnd.github+json', Host: target.host },
    createConnection: (opts, cb) => {
      tunnel(proxy, target.hostname, port, { signal, connect })
        .then(socket => cb(null, secure ? tls.connect({ socket, servername: target.hostname }) : socket))
        .catch(cb);
    }
  };
  return new Promise((resolve, reject) => {
    const req = createRequest(secure, options, resolve);
    req.once('error', reject);
    const onAbort = () => { req.destroy(); reject(Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.once('close', () => signal?.removeEventListener('abort', onAbort));
    req.end();
  });
}

async function proxyRequestBytes(url, { proxy, limit, signal, timeout = 30000, connect }) {
  return transferBytes(url, { limit, signal, timeout, open: async (target, { signal }) => {
    const response = await request(target, { proxy, signal, connect });
    return {
      status: response.statusCode,
      location: response.headers.location,
      length: response.headers['content-length'],
      body: response,
      cancel: () => { response.destroy(); }
    };
  } });
}

module.exports = { request, proxyRequestBytes };

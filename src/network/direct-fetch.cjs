'use strict';
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { Readable, pipeline } = require('node:stream');
const { createRequest } = require('./client-request.cjs');

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

function directFetch(url, { headers = {}, signal, redirect = 'error' } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch { return reject(new TypeError('fetch failed')); }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return reject(new TypeError('fetch failed'));
    if (!['error', 'manual'].includes(redirect)) return reject(new TypeError('fetch failed'));
    const secure = target.protocol === 'https:';
    const agent = secure ? new https.Agent({ keepAlive: false, rejectUnauthorized: true }) : new http.Agent({ keepAlive: false });
    let req, incoming, done = false;
    const onBodyAbort = () => { incoming?.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
    const finish = (error, value) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        signal?.removeEventListener('abort', onBodyAbort);
        incoming?.destroy(); req?.destroy(); agent.destroy();
        reject(error);
      } else resolve(value);
    };
    const onAbort = () => finish(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const onReqError = error => { if (done) { incoming?.destroy(error); return; } finish(error); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    try {
      req = createRequest(secure, {
        hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || (secure ? 443 : 80),
        path: target.pathname + target.search, method: 'GET', agent,
        headers: { 'Accept-Encoding': 'gzip, deflate, br', ...headers },
      }, response => {
        incoming = response;
        try {
          incoming.once('error', () => {});
          signal?.addEventListener('abort', onBodyAbort, { once: true });
          incoming.once('close', () => { signal?.removeEventListener('abort', onBodyAbort); agent.destroy(); });
          const outputHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            for (const each of Array.isArray(value) ? value : [value]) outputHeaders.append(name, each);
          }
          if (REDIRECT_STATUSES.includes(response.statusCode) && redirect === 'error') {
            response.resume(); finish(new TypeError('redirected')); return;
          }
          if ([101, 204, 205, 304].includes(response.statusCode)) {
            response.resume();
            finish(null, new Response(null, { status: response.statusCode, headers: outputHeaders }));
            return;
          }
          const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
          let source = response;
          if (encoding && encoding !== 'identity') {
            const decoder = encoding === 'gzip' ? zlib.createGunzip()
              : encoding === 'deflate' ? zlib.createInflate()
              : encoding === 'br' ? zlib.createBrotliDecompress() : null;
            if (!decoder) { response.resume(); finish(new TypeError('encoding')); return; }
            pipeline(response, decoder, () => {});
            source = decoder;
            outputHeaders.delete('content-encoding');
            outputHeaders.delete('content-length');
          }
          finish(null, new Response(Readable.toWeb(source), { status: response.statusCode, headers: outputHeaders }));
        } catch (error) { finish(error); }
      });
      req.once('error', onReqError);
      req.end();
    } catch (error) { finish(error); }
  });
}

module.exports = { directFetch };

'use strict';
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const { Duplex, Readable, pipeline } = require('node:stream');
const zlib = require('node:zlib');

function parseProxy(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try { url = new URL(value); } catch { throw Error('proxy'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw Error('proxy');
  if (!url.hostname || (url.port && (!/^\d+$/.test(url.port) || Number(url.port) > 65535))) throw Error('proxy');
  let authorization;
  if (url.username || url.password) {
    try { authorization = 'Basic ' + Buffer.from(decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password), 'utf8').toString('base64'); }
    catch { throw Error('proxy'); }
  }
  return { url, authorization };
}

function openConnection(proxy) {
  const port = Number(proxy.url.port) || (proxy.url.protocol === 'https:' ? 443 : 80);
  return proxy.url.protocol === 'https:'
    ? tls.connect({ host: proxy.url.hostname, port, servername: proxy.url.hostname })
    : net.connect({ host: proxy.url.hostname, port });
}

function tunnel(proxy, host, port, { timeout = 30000, signal, connect = openConnection } = {}) {
  return new Promise((resolve, reject) => {
    let socket, done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      socket?.removeListener('data', onData); socket?.removeListener('error', onError);
      socket?.removeListener('end', onEarlyClose); socket?.removeListener('close', onEarlyClose);
      if (error) { socket?.destroy(); reject(error); } else resolve(value);
    };
    const onAbort = () => finish(Error('aborted'));
    const onError = error => finish(signal?.aborted ? Error('aborted') : error);
    const onEarlyClose = () => finish(Error('proxy'));
    const timer = timeout ? setTimeout(() => finish(Error('aborted')), timeout) : null;
    timer?.unref?.();
    const onData = chunk => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) { if (head.length > 16384) finish(Error('proxy')); return; }
      const statusLine = head.subarray(0, end).toString('latin1').split('\r\n', 1)[0];
      const rest = head.subarray(end + 4);
      const match = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(statusLine);
      if (!match || match[1] !== '200') return finish(Error('proxy: ' + statusLine));
      socket.removeListener('data', onData);
      if (rest.length) {
        // A flowing socket drops unshift()ed bytes before the consumer attaches;
        // wrap it so the leftover head and live traffic both reach the parser.
        const shim = new Duplex({
          write: (chunk, encoding, callback) => { if (socket.write(chunk)) callback(); else socket.once('drain', callback); },
          read: () => {},
          final: callback => socket.end(callback)
        });
        const feed = chunk => { if (!shim.push(chunk)) socket.pause(); };
        socket.on('data', feed);
        socket.once('end', () => shim.push(null));
        socket.once('close', () => shim.destroy());
        socket.once('error', error => shim.destroy(error));
        shim.once('close', () => { socket.removeListener('data', feed); socket.destroy(); });
        shim.push(rest);
        return finish(null, shim);
      }
      finish(null, socket);
    };
    let head = Buffer.alloc(0);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return finish(Error('aborted'));
    try { socket = connect(proxy); } catch (error) { return finish(error); }
    socket.once('error', onError);
    socket.once('end', onEarlyClose);
    socket.once('close', onEarlyClose);
    socket.on('data', onData);
    const target = host + ':' + port;
    const lines = ['CONNECT ' + target + ' HTTP/1.1', 'Host: ' + target];
    if (proxy.authorization) lines.push('Proxy-Authorization: ' + proxy.authorization);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
  });
}

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
    const req = (secure ? https : http).request(options, resolve);
    req.once('error', reject);
    const onAbort = () => { req.destroy(); reject(Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.once('close', () => signal?.removeEventListener('abort', onAbort));
    req.end();
  });
}

async function proxyRequestBytes(url, { proxy, limit, signal, timeout = 30000, connect }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeout);
  try {
    for (let hops = 0; hops <= 5; hops++) {
      const target = require('./update.cjs').allowedUrl(url);
      let response;
      try { response = await request(target, { proxy, signal: controller.signal, connect }); }
      catch (error) { if (controller.signal.aborted) throw Error('aborted'); throw error; }
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy();
        const location = response.headers.location; if (!location) throw Error('redirect');
        url = new URL(location, target).href; continue;
      }
      if (response.statusCode !== 200 || Number(response.headers['content-length']) > limit) { response.destroy(); throw Error('http'); }
      const chunks = []; let size = 0;
      try {
        for await (const chunk of response) {
          size += chunk.length;
          if (size > limit || controller.signal.aborted) { response.destroy(); throw Error('size'); }
          chunks.push(Buffer.from(chunk));
        }
      } catch (error) { if (controller.signal.aborted) throw Error('aborted'); throw error; }
      if (controller.signal.aborted) throw Error('aborted');
      return Buffer.concat(chunks);
    }
    throw Error('redirect');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

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
      req = (secure ? https : http).request({
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

module.exports = { parseProxy, tunnel, proxyRequestBytes, directFetch };

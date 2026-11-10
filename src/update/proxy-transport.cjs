'use strict';
const net = require('node:net');
const tls = require('node:tls');
const { Duplex } = require('node:stream');
const { createRequest } = require('../network/client-request.cjs');
const { transferBytes } = require('./transfer.cjs');

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

module.exports = { tunnel, request, proxyRequestBytes };

'use strict';
const net = require('node:net');
const tls = require('node:tls');
const { Duplex } = require('node:stream');

function openConnection(proxy) {
  const port = Number(proxy.url.port) || (proxy.url.protocol === 'https:' ? 443 : 80);
  // URL.hostname keeps the brackets on IPv6 literals; the dialers want them off.
  const host = proxy.url.hostname.replace(/^\[|\]$/g, '');
  return proxy.url.protocol === 'https:'
    ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
    : net.connect({ host, port });
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
      // The cap counts complete headers, not buffered bytes: a single chunk
      // carrying 17KB of header plus its terminator is still over the limit.
      if ((end === -1 && head.length > 16384) || (end !== -1 && end + 4 > 16384)) return finish(Error('proxy'));
      if (end === -1) return;
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
          // Once the consumer drains below the high-water mark, resume the
          // paused source socket — a no-op read() stalls the tunnel forever.
          read: () => { socket.resume(); },
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
    // CONNECT authority-form needs brackets around IPv6 literals.
    const target = (host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host) + ':' + port;
    const lines = ['CONNECT ' + target + ' HTTP/1.1', 'Host: ' + target];
    if (proxy.authorization) lines.push('Proxy-Authorization: ' + proxy.authorization);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
  });
}

module.exports = { openConnection, tunnel };

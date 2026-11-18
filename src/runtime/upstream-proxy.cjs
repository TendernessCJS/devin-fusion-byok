'use strict';
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { openConnection, tunnel } = require('../network/proxy-tunnel.cjs');
const { proxyFor } = require('../network/proxy-policy.cjs');

// A request-scoped agent whose createConnection tunnels through the compiled
// proxy before the TLS handshake. keepAlive stays off: the socket is owned by
// this one request, so agent.destroy() (or the abort signal) kills a CONNECT
// or TLS handshake still in flight without touching pooled state. There is no
// DIRECT fallback — a tunnel failure is a request failure.
function createForwardAgent(target, policy, { signal, timeoutMs, connect, secureOptions } = {}) {
  const proxy = proxyFor(policy, target);
  if (!proxy) return null;
  const secure = target.protocol === 'https:';
  const port = Number(target.port) || (secure ? 443 : 80);
  const host = (target.hostname || '').replace(/^\[|\]$/g, '');
  const Base = secure ? https.Agent : http.Agent;
  const pending = new Set();       // every owned socket until handed over
  const handshakes = new Set();    // settle callbacks still owed a verdict
  let destroyed = false;
  const track = socket => {
    pending.add(socket);
    socket.once('close', () => pending.delete(socket));
    return socket;
  };
  class UpstreamProxyAgent extends Base {
    createConnection(options, callback) {
      if (destroyed) return callback(new Error('aborted'));
      let called = false;
      const finish = (error, socket) => {
        if (called) return;
        called = true;
        handshakes.delete(finish);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        callback(error, socket);
      };
      const killAll = () => { for (const socket of pending) socket.destroy(); };
      // No timeout may mean "wait forever" for a caller, never for a handshake:
      // a silent TLS peer must not pin the request.
      const limit = timeoutMs ?? 10000;
      const timer = setTimeout(() => { killAll(); finish(new Error('aborted')); }, limit);
      // The abort settles the callback *and* kills in-flight sockets.
      const onAbort = () => { killAll(); finish(new Error('aborted')); };
      if (signal?.aborted) return finish(new Error('aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      const removeAbort = () => signal?.removeEventListener('abort', onAbort);
      const done = (error, socket) => { removeAbort(); if (error) socket?.destroy(); finish(error, socket); };
      handshakes.add(finish);
      // Wrap the dial so the CONNECT-phase socket joins `pending` before the
      // tunnel promise resolves — otherwise destroy() could not reach a
      // handshake still in flight.
      const dial = connect ? p => track(connect(p)) : p => track(openConnection(p));
      tunnel(proxy, host, port, { signal, timeout: limit, connect: dial })
        .then(raw => {
          if (called || destroyed) { raw.destroy(); return; }
          track(raw);
          if (!secure) return done(null, raw);
          const sock = tls.connect({
            socket: raw,
            host,
            // SNI is meaningless (and illegal) for literal IPs.
            servername: net.isIP(host) ? undefined : host,
            rejectUnauthorized: true,
            // Test injection surface: `ca` may extend the trust store; nothing
            // else is accepted — callers cannot weaken verification.
            ...(secureOptions?.ca ? { ca: secureOptions.ca } : {}),
          });
          track(sock);
          // The handshake's listeners are torn down on every verdict — success
          // hands a clean socket to the ClientRequest, failure/close settles the
          // callback and destroys every owned socket.
          const cleanup = () => {
            sock.removeListener('error', onError);
            sock.removeListener('secureConnect', onSecure);
            sock.removeListener('close', onEarlyClose);
          };
          const onError = error => { cleanup(); done(error, sock); };
          const onSecure = () => { cleanup(); done(null, sock); };
          const onEarlyClose = () => { cleanup(); done(new Error('aborted'), sock); };
          sock.once('error', onError);
          sock.once('secureConnect', onSecure);
          sock.once('close', onEarlyClose);
        })
        .catch(done);
    }
    destroy() {
      if (destroyed) return;
      destroyed = true;
      const error = new Error('aborted');
      for (const settle of [...handshakes]) settle(error);
      for (const socket of pending) socket.destroy();
      pending.clear();
      super.destroy();
    }
  }
  return new UpstreamProxyAgent({ keepAlive: false });
}

module.exports = { createForwardAgent };

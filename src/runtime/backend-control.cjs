'use strict';
const crypto = require('node:crypto');
const { collect } = require('./bridge.cjs');

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function createRuntimeControl({ identity, instanceId, controlToken, managementProtocol, nativeModelsProtocol, nativeModelsIngest, monitorProtocol,
  getActiveRequests, getDraining, setDraining, monitor, getNativeModels, getAllowedUids, ingest, onAllowedUids, close }) {
  const authorized = request => {
    const provided = typeof request.headers.authorization === 'string' ? request.headers.authorization : '';
    const expected = 'Bearer ' + controlToken;
    return Buffer.byteLength(provided) === Buffer.byteLength(expected) &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  };

  return function handle(request, response) {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ...identity, pid: process.pid, instanceId, managementProtocol, nativeModelsProtocol,
        nativeModelsIngest, monitorProtocol, activeRequests: getActiveRequests(), draining: getDraining() }));
      return true;
    }
    if (request.method === 'GET' && request.url === '/_runtime/monitor') {
      if (!authorized(request)) { response.writeHead(403); response.end(); return true; }
      Promise.resolve().then(() => monitor?.snapshot()).then(snapshot => {
        if (response.destroyed) return;
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ instanceId, snapshot: snapshot || null }));
      }).catch(() => { if (!response.destroyed) { response.writeHead(503); response.end(); } });
      return true;
    }
    if (request.method === 'GET' && request.url === '/_runtime/native-models') {
      if (!authorized(request)) { response.writeHead(403); response.end(); return true; }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ instanceId, models: getNativeModels(), allowedUids: getAllowedUids() }));
      return true;
    }
    if (request.method === 'POST' && request.url === '/_runtime/native-models') {
      if (!authorized(request)) { response.writeHead(403); response.end(); return true; }
      collect(request).then(body => {
        if (body.length > MAX_BODY_BYTES) throw new Error('too_large');
        const payload = JSON.parse(body.toString('utf8'));
        const result = ingest(payload?.models);
        if (result && Array.isArray(payload?.allowedUids)) onAllowedUids(payload.allowedUids);
        if (!result) throw new Error('invalid');
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ instanceId, ...result }));
      }).catch(() => {
        if (response.destroyed) return;
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ instanceId, error: 'invalid_payload' }));
      });
      return true;
    }
    if (request.method === 'POST' && request.url === '/_runtime/shutdown') {
      if (!authorized(request)) { response.writeHead(403); response.end(); return true; }
      if (getActiveRequests() > 0) {
        response.writeHead(409, { 'content-type': 'application/json' }); response.end(JSON.stringify({ activeRequests: getActiveRequests() }));
        return true;
      }
      // Check and transition synchronously. A request racing the health check
      // either makes shutdown busy or is rejected before work starts.
      setDraining(true);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.once('finish', () => { close(); });
      response.end('{"stopping":true}');
      return true;
    }
    return false;
  };
}

module.exports = { createRuntimeControl };

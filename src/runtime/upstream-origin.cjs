'use strict';
const { PORT } = require('./port.cjs');
// The upstream every non-intercepted RPC forwards to. The default mirrors the
// native `codeium.apiServerUrl` default; a configured value is pushed by the
// host over POST /_runtime/upstream. Memory only — never persisted, and the
// host pushes again after every backend restart.
const DEFAULT_UPSTREAM = 'https://server.codeium.com';
// Normalizes a configured apiServerUrl, or returns null for "reset to
// default". Throws TypeError('invalid_origin') on anything else. Loopback is
// the only http: exception, and the backend's own address is rejected so a
// misconfigured origin cannot turn forwarding into a loop.
function resolveUpstreamOrigin(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.length || value.length > 2048) throw new TypeError('invalid_origin');
  let url;
  try { url = new URL(value); } catch { throw new TypeError('invalid_origin'); }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new TypeError('invalid_origin');
  if (url.username || url.password) throw new TypeError('invalid_origin');
  if (url.search || url.hash) throw new TypeError('invalid_origin');
  if (url.host === '127.0.0.1:' + PORT || url.host === 'localhost:' + PORT) throw new TypeError('invalid_origin');
  return url.origin + url.pathname.replace(/\/+$/, '');
}
module.exports = { DEFAULT_UPSTREAM, resolveUpstreamOrigin };

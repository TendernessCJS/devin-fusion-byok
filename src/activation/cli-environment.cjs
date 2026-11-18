'use strict';
const { BACKEND_URL } = require('../runtime/port.cjs');
const { compileProxyPolicy } = require('../network/proxy-policy.cjs');

// The managed devin-cli environment is a projection of the user's proxy policy,
// never a rewrite of it: the CLI must reach the local backend directly, so a
// configured proxy adds a bypass list made of the user's own no-proxy entries
// plus loopback. Both NO_PROXY spellings get the same value — clients disagree
// about which one they read, and a lowercase-only bypass would silently route
// the CLI through the user's proxy.
function buildCliEnvironment({ proxyConfig, original = {} }) {
  // Validating here keeps one authority for what a legal policy is; the error
  // never carries a value.
  compileProxyPolicy(proxyConfig);
  const desired = { WINDSURF_API_SERVER_URL: BACKEND_URL };
  if (!proxyConfig.httpProxy.trim() && !proxyConfig.httpsProxy.trim()) return desired;
  const seen = new Set(), tokens = [];
  const append = raw => {
    if (raw === undefined) return;
    if (typeof raw !== 'string') throw Object.assign(new Error('proxy_invalid'), { code: 'proxy_invalid' });
    for (const piece of raw.split(',')) {
      const token = piece.trim(), key = token.toLowerCase();
      if (token && !seen.has(key)) { seen.add(key); tokens.push(token); }
    }
  };
  for (const item of proxyConfig.noProxy) append(item);
  // Only the user's existing bypass entries are copied through: their CIDR and
  // wildcard semantics stay untouched, and no proxy address is promoted into
  // the managed environment.
  append(original.NO_PROXY);
  append(original.no_proxy);
  for (const item of ['127.0.0.1', 'localhost', '::1']) append(item);
  desired.NO_PROXY = desired.no_proxy = tokens.join(',');
  return desired;
}

module.exports = { buildCliEnvironment };

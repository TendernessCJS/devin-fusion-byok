'use strict';
// Pure proxy-policy leaf shared by the runtime forwarder and the update path:
// shape validation, noProxy parsing/matching and per-target route selection.
// Owns no sockets and imports nothing beyond node builtins + proxy-config.
const net = require('node:net');
const { parseProxy } = require('./proxy-config.cjs');
const MAX_URL_LENGTH = 8192;
const MAX_NOPROXY_ITEMS = 512;
const MAX_NOPROXY_ITEM_LENGTH = 1024;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const invalid = () => Object.assign(new Error('proxy_invalid'), { code: 'proxy_invalid' });

// One policy snapshot per control push: compiled once, frozen, and compared
// only by identity afterwards — the URL (and its credentials) never leaves it.
function validateProxyUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_URL_LENGTH) throw invalid();
  let parsed;
  try { parsed = parseProxy(trimmed); } catch { throw invalid(); }
  if (!parsed) return null;
  const { url } = parsed;
  // CONNECT tunnels carry no path: anything beyond `/` (or userinfo, which is
  // the one allowed extra component) is a different kind of address.
  if (url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) throw invalid();
  return Object.freeze({ url, authorization: parsed.authorization });
}

function parseNoProxyToken(item) {
  if (!item || item.length > MAX_NOPROXY_ITEM_LENGTH) throw invalid();
  if (item === '*') return { any: true };
  let host = item, port;
  if (item.startsWith('[')) {
    const end = item.indexOf(']');
    if (end === -1) throw invalid();
    host = item.slice(1, end);
    const rest = item.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(':')) throw invalid();
      port = parsePort(rest.slice(1));
    }
    if (net.isIP(host) !== 6) throw invalid();
    host = normalizeV6(host);
  } else {
    const colons = item.split(':').length - 1;
    if (colons === 1) {
      const [name, p] = item.split(':');
      if (!name) throw invalid();
      host = name; port = parsePort(p);
    } else if (colons > 1) {
      // A bare IPv6 literal such as ::1 is a host, never a host:port pair —
      // splitting on ':' at this point is the old bug where ::1 silently
      // failed to match anything.
      if (net.isIP(item) !== 6) throw invalid();
      host = normalizeV6(item);
    }
  }
  if (host === '*') return { any: true, port };
  const suffix = host.startsWith('*.') ? host.slice(2) : host.startsWith('.') ? host.slice(1) : null;
  const domain = suffix ?? host;
  if (suffix === null && (net.isIP(host) === 4 || host.includes(':'))) {
    return { host, port }; // literal address: exact match only
  }
  if (suffix === null && host.includes('*')) throw invalid();
  if (!isDomain(domain)) throw invalid();
  // A bare hostname (gf.com.cn) exempts itself *and* its subdomains, while
  // literal addresses only match byte-for-byte — notgf.com.cn must never
  // inherit gf.com.cn's exemption.
  return { domain, port };
}

function isDomain(value) {
  if (!value || value.length > 253 || value.endsWith('.')) return false;
  return value.split('.').every(label => DOMAIN_LABEL.test(label));
}

function parsePort(text) {
  if (!/^\d+$/.test(text)) throw invalid();
  const port = Number(text);
  if (port < 1 || port > 65535) throw invalid();
  return port;
}

function normalizeV6(value) {
  // Canonical form: eight lowercase hex groups — `::1`, `0:0:0:0:0:0:0:1` and
  // `2001:DB8::1`-style spellings of the same address all collapse to it.
  const v = value.toLowerCase();
  const v4 = v.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  let head = v;
  const tail = v4 ? [((+v4[1] << 8) | +v4[2]).toString(16), ((+v4[3] << 8) | +v4[4]).toString(16)] : [];
  if (v4) head = v.slice(0, v4.index).replace(/:$/, '');
  const halves = head.split('::');
  const groups = halves.length === 2
    ? [...(halves[0] ? halves[0].split(':') : []),
       ...Array(8 - (halves[0] ? halves[0].split(':').length : 0) - (halves[1] ? halves[1].split(':').length : 0) - tail.length).fill('0'),
       ...(halves[1] ? halves[1].split(':') : []), ...tail]
    : [...head.split(':'), ...tail];
  return groups.map(g => g.padStart(4, '0')).join(':');
}
const LOOPBACK_V6 = normalizeV6('::1');

function compileProxyPolicy(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw invalid();
  for (const key of Object.keys(config)) if (!['httpProxy', 'httpsProxy', 'noProxy'].includes(key)) throw invalid();
  for (const key of ['httpProxy', 'httpsProxy']) if (typeof config[key] !== 'string') throw invalid();
  if (!Array.isArray(config.noProxy)) throw invalid();
  if (config.noProxy.length > MAX_NOPROXY_ITEMS) throw invalid();
  const rules = [];
  for (const raw of config.noProxy) {
    // Every item must be a string — a number here is a malformed config, not
    // something to stringify. Comma-joined items expand to independent tokens
    // and every token is validated, so a leading `*` cannot smuggle garbage.
    if (typeof raw !== 'string') throw invalid();
    for (const piece of raw.toLowerCase().split(',')) {
      const token = piece.trim();
      if (!token) continue;
      rules.push(Object.freeze(parseNoProxyToken(token)));
    }
  }
  return Object.freeze({
    httpProxy: validateProxyUrl(config.httpProxy),
    httpsProxy: validateProxyUrl(config.httpsProxy),
    noProxy: Object.freeze(rules),
  });
}

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
function bypasses(host, port, rules) {
  host = host.toLowerCase();
  const bare = host.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || LOOPBACK_V4.test(bare) ||
      (net.isIP(bare) === 6 && normalizeV6(bare) === LOOPBACK_V6)) return true;
  for (const rule of rules) {
    if (rule.port !== undefined && rule.port !== port) continue;
    if (rule.any) return true;
    if (rule.host && (net.isIP(bare) === 6 ? normalizeV6(bare) : bare) === rule.host) return true;
    if (rule.domain && (host === rule.domain || host.endsWith('.' + rule.domain))) return true;
  }
  return false;
}

function proxyFor(policy, target) {
  if (!policy) return null;
  const secure = target.protocol === 'https:';
  const port = Number(target.port) || (secure ? 443 : 80);
  const host = (target.hostname || '').replace(/^\[|\]$/g, '');
  if (bypasses(host, port, policy.noProxy)) return null;
  // No cross-protocol fallback: an explicit empty httpsProxy means DIRECT for
  // HTTPS targets, not "reuse the HTTP proxy". The host-side env fallback
  // (HTTPS_PROXY ?? HTTP_PROXY) already happened before compilation.
  return secure ? policy.httpsProxy : policy.httpProxy;
}

module.exports = { compileProxyPolicy, proxyFor };

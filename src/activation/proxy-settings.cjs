'use strict';
// Reads the user's effective proxy configuration for the backend control push.
// Only user-level (globalLocalValue ?? globalValue) values count: workspace
// values may hold a per-project proxy the shared local backend must not
// adopt, and the merged `get` result hides where a value came from.
// The raw inspected value is returned untyped — http.noProxy legitimately
// arrives as a string[] in the real configuration API, and coercing it to a
// string here would silently lose every entry.
function inspectGlobal(vscode, key) {
  try {
    const view = vscode?.workspace?.getConfiguration?.('http');
    const inspected = view?.inspect?.(key);
    return inspected?.globalLocalValue ?? inspected?.globalValue;
  } catch { return undefined; }
}

function readProxySettings(vscode, env = process.env) {
  const configuredRaw = inspectGlobal(vscode, 'proxy');
  // A set-but-non-string http.proxy is a malformed configuration, not "empty" —
  // surface it so the pushed config fails compile instead of silently going DIRECT.
  if (configuredRaw !== undefined && typeof configuredRaw !== 'string') {
    return { config: { httpProxy: configuredRaw, httpsProxy: configuredRaw, noProxy: [] }, source: 'settings' };
  }
  const configured = typeof configuredRaw === 'string' ? configuredRaw.trim() : '';
  const configuredNoProxy = inspectGlobal(vscode, 'noProxy');
  const source = configured ? 'settings' : (env.HTTP_PROXY || env.http_proxy || env.HTTPS_PROXY || env.https_proxy ? 'environment' : 'none');
  const envHttp = env.HTTP_PROXY || env.http_proxy || '';
  const envHttps = env.HTTPS_PROXY || env.https_proxy || envHttp;
  // A non-empty http.proxy applies to both hop types; environment variables
  // keep their classic precedence (HTTPS target falls back to HTTP_PROXY).
  // ALL_PROXY and PAC URLs are deliberately ignored: neither maps onto a
  // single CONNECT proxy safely.
  const config = {
    httpProxy: configured || envHttp,
    httpsProxy: configured || envHttps,
    noProxy: [],
  };
  const seen = new Set();
  const push = value => {
    // noProxy may be a real string[] (each item still comma-expandable) or a
    // legacy comma string. String(array) is never used — it would smuggle
    // every element into one token.
    const items = Array.isArray(value) ? value : [value];
    for (const entry of items) {
      // Non-strings are passed through verbatim so compileProxyPolicy rejects
      // them (proxy_invalid) instead of dropping them silently.
      if (typeof entry !== 'string') { config.noProxy.push(entry); continue; }
      for (const piece of entry.split(',')) {
        const item = piece.trim();
        if (!item) continue;
        const key = item.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        config.noProxy.push(item);
      }
    }
  };
  // Unset sources must not push at all — pushing `undefined` would land a null
  // in the serialized noProxy array and every backend would reject the policy.
  if (configuredNoProxy !== undefined) push(configuredNoProxy);
  const envNoProxy = env.NO_PROXY ?? env.no_proxy;
  if (envNoProxy !== undefined) push(envNoProxy);
  // Loopback is unconditional bypass regardless of where the proxy came from.
  for (const item of ['localhost', '127.0.0.1', '::1']) {
    if (!seen.has(item)) { seen.add(item); config.noProxy.push(item); }
  }
  return { config, source };
}

module.exports = { readProxySettings };

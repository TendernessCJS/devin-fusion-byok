'use strict';
const { readKey } = require('./auth.cjs');
const { authorize } = require('./web.cjs');
const { translator } = require('../i18n/index.cjs');

// Account check for the control panel. It reads the local Devin login, exchanges
// it for a short-lived user token and reads the account policy. Only per-capability
// booleans and a reason code are kept; the credential is never returned.
// The reason codes this check can report. Their copy is fc.check.<code> in
// src/i18n; CHECK_MESSAGES keeps the original zh-CN text under the same
// export for existing callers, and the panel translates per display language.
const CHECK_CODES = ['ok', 'web_search_disabled', 'unauthenticated', 'fast_context_disabled', 'credentials_unavailable', 'insecure_tls_configuration', 'unavailable'];
const CHECK_MESSAGES = Object.freeze(Object.fromEntries(CHECK_CODES.map(code => [code, translator()('fc.check.' + code)])));
const KNOWN = new Set(Object.keys(CHECK_MESSAGES));

function createSelfCheck({ loadKey = readKey, verify = options => authorize(options) } = {}) {
  let result;
  async function run() {
    try {
      const { codeSearch = true, webSearch = false } = await verify({ key: loadKey() }) || {};
      const ok = Boolean(codeSearch && webSearch);
      result = { ok, reason: ok ? 'ok' : webSearch ? 'unavailable' : 'web_search_disabled',
        capabilities: { code: Boolean(codeSearch), web: Boolean(webSearch) }, at: Date.now() };
    } catch (error) {
      const code = String(error?.message || '');
      const reason = KNOWN.has(code) && code !== 'ok' ? code : 'unavailable';
      // A team ban only blocks code search when it is the reported reason; other failures leave both unknown.
      result = { ok: false, reason, capabilities: { code: reason === 'fast_context_disabled' ? false : null, web: null }, at: Date.now() };
    }
    return result;
  }
  return { run, state: () => result, message: code => CHECK_MESSAGES[KNOWN.has(code) ? code : 'unavailable'] };
}

module.exports = { createSelfCheck, CHECK_MESSAGES };

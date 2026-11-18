'use strict';
const { ModelDiscoveryError, discoveryNotice } = require('../models/discovery-error.cjs');
const { translator } = require('../i18n/index.cjs');

// The copy for each code is errors.runtime.<code> in src/i18n.
const RUNTIME_CODES = new Set(['port_in_use', 'different_storage', 'legacy_runtime', 'newer_runtime', 'control_unavailable', 'startup_failed', 'cancelled', 'proxy_unavailable']);
const runtimeMessage = (code, t) => RUNTIME_CODES.has(code) ? t('errors.runtime.' + code) : undefined;
// error.message itself stays the zh-CN copy: it is never shown directly (safeError
// rebuilds the text in the display language) and keeping it stable keeps logs
// and older callers unchanged.
class RuntimeError extends Error {
  constructor(code) { super(runtimeMessage(code, translator())); this.code = code; }
}
// These messages are thrown as plain Errors by models/discovery.cjs and
// activation/enable.cjs and matched here as an allow-list of safe-to-show
// text. They are signals, not copy: the match stays on the original Chinese,
// and only the text shown to the user is translated.
const CONFIGURATION_MESSAGES = new Map([
  ['API 地址必须以 http:// 或 https:// 开头', 'errors.baseUrlScheme'], // i18n-data: thrown by models/discovery.cjs
  ['API 未返回模型列表', 'errors.noModelList'], // i18n-data: thrown by models/discovery.cjs
  ['未找到 Devin 原生扩展', 'errors.nativeMissing'], // i18n-data: thrown by activation/enable.cjs
]);
const DISCOVERY_MESSAGE = /^获取模型失败：HTTP ([1-5]\d{2})$/; // i18n-data: ModelDiscoveryError text from models/discovery-error.cjs
function safeError(error, t = translator()) {
  if (error instanceof RuntimeError) return { code: error.code, message: runtimeMessage(error.code, t) };
  if (error instanceof ModelDiscoveryError) {
    const notice = discoveryNotice(error.status, t);
    if (notice) return { code: 'provider_http_error', message: notice };
    return { code: 'operation_failed', message: t('errors.operationFailed') };
  }
  const message = typeof error?.message === 'string' ? error.message : '';
  const http = DISCOVERY_MESSAGE.exec(message);
  if (http) return { code: 'provider_http_error', message: t('errors.discovery.http', { status: http[1] }) };
  if (CONFIGURATION_MESSAGES.has(message)) return { code: 'configuration_error', message: t(CONFIGURATION_MESSAGES.get(message)) };
  return { code: 'operation_failed', message: t('errors.operationFailed') };
}

module.exports = { RuntimeError, safeError };

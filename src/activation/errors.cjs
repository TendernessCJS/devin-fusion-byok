'use strict';
const { ModelDiscoveryError, discoveryNotice } = require('../models/discovery-error.cjs');

const RUNTIME_ERRORS = {
  port_in_use: '本地连接端口已被其他程序占用。',
  different_storage: '该端口属于另一套插件配置，未更改它的连接服务。',
  legacy_runtime: '旧版连接服务不支持安全升级，请关闭旧版服务后重试。',
  newer_runtime: '另一窗口已加载更新版插件，请重新加载当前窗口。',
  control_unavailable: '无法验证本地连接服务的归属，请重新加载窗口后重试。',
  startup_failed: '本地连接服务启动失败，请查看状态日志。',
  cancelled: '操作已取消。',
};
class RuntimeError extends Error {
  constructor(code) { super(RUNTIME_ERRORS[code]); this.code = code; }
}
function safeError(error) {
  if (error instanceof RuntimeError) return { code: error.code, message: RUNTIME_ERRORS[error.code] };
  if (error instanceof ModelDiscoveryError) {
    const notice = discoveryNotice(error.status);
    if (notice) return { code: 'provider_http_error', message: notice };
    return { code: 'operation_failed', message: '操作失败，请检查接口配置和连接状态。' };
  }
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/^获取模型失败：HTTP [1-5]\d{2}$/.test(message)) return { code: 'provider_http_error', message };
  if (['API 地址必须以 http:// 或 https:// 开头', 'API 未返回模型列表', '未找到 Devin 原生扩展'].includes(message)) return { code: 'configuration_error', message };
  return { code: 'operation_failed', message: '操作失败，请检查接口配置和连接状态。' };
}

module.exports = { RUNTIME_ERRORS, RuntimeError, safeError };

'use strict';
// 404/405 means the route itself is absent — common for gateways that only proxy
// inference. Name the escape hatch instead of leaving a bare status the user
// reads as "no model list here". Any other status keeps the plain message: it
// says nothing about whether the route exists.
function discoveryNotice(status) {
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) return null;
  if (status === 404 || status === 405) {
    return `获取模型失败：HTTP ${status}（该供应商可能未提供 /models，可在供应商卡片里用「手动添加」录入模型）`;
  }
  return '获取模型失败：HTTP ' + status;
}
class ModelDiscoveryError extends Error {
  constructor(status) {
    super(discoveryNotice(status) || '获取模型失败：HTTP ' + status);
    this.code = 'model_discovery_http';
    this.status = status;
  }
}
module.exports = { ModelDiscoveryError, discoveryNotice };

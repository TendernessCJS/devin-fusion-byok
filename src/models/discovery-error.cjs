'use strict';
const { translator } = require('../i18n/index.cjs');
// 404/405 means the route itself is absent — common for gateways that only proxy
// inference. Name the escape hatch instead of leaving a bare status the user
// reads as "no model list here". Any other status keeps the plain message: it
// says nothing about whether the route exists.
// `t` picks the display language; the default (zh-CN) is also the error's own
// message, which activation/errors.cjs matches on.
function discoveryNotice(status, t = translator()) {
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) return null;
  if (status === 404 || status === 405) return t('errors.discovery.routeMissing', { status });
  return t('errors.discovery.http', { status });
}
class ModelDiscoveryError extends Error {
  constructor(status) {
    super(discoveryNotice(status) || translator()('errors.discovery.http', { status }));
    this.code = 'model_discovery_http';
    this.status = status;
  }
}
module.exports = { ModelDiscoveryError, discoveryNotice };

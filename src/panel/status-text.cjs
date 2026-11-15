'use strict';
const { translator } = require('../i18n/index.cjs');
// The status bar is the only always-visible runtime signal, so its wording is a
// pure decision kept out of the vscode wiring and covered on its own. Precedence
// is fixed: disabled wins, then missing native models, then cache write errors.
function statusTooltip({ enabled, nativeModelCount, cacheErrorCount, matrixCount, t = translator() }) {
  if (enabled === false) return t('status.disabled');
  if (!nativeModelCount) return t('status.noNativeModels');
  if (cacheErrorCount) return t('status.cacheErrors', { count: cacheErrorCount });
  return t('status.running', { count: matrixCount });
}

module.exports = { statusTooltip };

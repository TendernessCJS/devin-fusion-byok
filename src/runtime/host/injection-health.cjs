'use strict';
const { translator } = require('../../i18n/index.cjs');

// Injection-surface health for the settings panel and context diagnostics.
// Runs in the extension host (panel-install wires it), so it must stay free of
// backend-only imports and never be added to SOURCE_FILES.
//
// The result feeds panel state, which is deduplicated by JSON.stringify: every
// field must be fully determined by the inputs — no timestamps, no counters,
// nothing that changes between identical calls. The display language is an
// input too (`t`): label and hint are panel copy; context-diagnostics keeps
// only id and state, so its file never depends on the language.
function checkInjectionHealth({ enabled = true, backendStatus, bridgeState, bridgeHook, envValue, expectedEnv, cliCache, acpObserved = 0, acpOwnModels = 0, t = translator() } = {}) {
  const items = [];
  const label = id => t('health.' + id);
  if (enabled === false) {
    for (const id of ['backend', 'bridge', 'env', 'cache', 'acp']) {
      items.push({ id, label: label(id), state: 'unknown', hint: t('health.disabled') });
    }
    return { ok: true, items };
  }
  const backendState = backendStatus === 'running' ? 'ok'
    : (backendStatus === 'starting' || backendStatus === undefined) ? 'unknown' : 'bad';
  items.push({ id: 'backend', label: label('backend'), state: backendState,
    hint: t('health.backend.hint') });
  // A shadowed http hook outranks the raw bridge state: the setPort path still
  // works, but the heartbeat fallback is deaf, so even 'ready' is degraded.
  const bridgeStatus = bridgeHook === 'shadowed' ? 'bad'
    : bridgeState === 'ready' ? 'ok'
    : (bridgeState === undefined || bridgeState === 'waiting' || bridgeState === 'connecting') ? 'unknown' : 'bad';
  items.push({ id: 'bridge', label: label('bridge'), state: bridgeStatus,
    hint: bridgeStatus === 'bad' && bridgeHook === 'shadowed' ? t('health.bridge.shadowed') : t('health.bridge.hint') });
  const envState = envValue === expectedEnv && typeof envValue === 'string' && typeof expectedEnv === 'string' ? 'ok' : 'bad';
  items.push({ id: 'env', label: label('env'), state: envState,
    hint: t('health.env.hint') });
  const coverage = cliCache && typeof cliCache === 'object' ? cliCache.coverage : undefined;
  const writeFailed = Array.isArray(cliCache?.errors) && cliCache.errors.length > 0;
  const unsupported = Array.isArray(coverage?.unsupported) && coverage.unsupported.length > 0;
  const unchecked = !cliCache || typeof cliCache !== 'object' || !coverage || coverage.dirState !== 'ok';
  const cacheState = unchecked ? 'unknown' : (writeFailed || unsupported) ? 'bad' : 'ok';
  const cacheHint = writeFailed ? t('health.cache.writeFailed')
    : unsupported ? t('health.cache.unsupported')
    : unchecked ? t('health.cache.unchecked')
    : t('health.cache.writeFailed');
  items.push({ id: 'cache', label: label('cache'), state: cacheState, hint: cacheHint });
  const acpState = acpObserved > 0 ? (acpOwnModels > 0 ? 'ok' : 'bad') : 'unknown';
  items.push({ id: 'acp', label: label('acp'), state: acpState,
    hint: t('health.acp.hint') });
  return { ok: items.every(item => item.state !== 'bad'), items };
}

module.exports = { checkInjectionHealth };

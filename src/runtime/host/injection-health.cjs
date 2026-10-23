'use strict';

// Injection-surface health for the settings panel and context diagnostics.
// Runs in the extension host (panel-install wires it), so it must stay free of
// backend-only imports and never be added to SOURCE_FILES.
//
// The result feeds panel state, which is deduplicated by JSON.stringify: every
// field must be fully determined by the inputs — no timestamps, no counters,
// nothing that changes between identical calls.
function checkInjectionHealth({ enabled = true, backendStatus, bridgeState, envValue, expectedEnv, cliCache, acpObserved = 0, acpOwnModels = 0 } = {}) {
  const items = [];
  if (enabled === false) {
    for (const [id, label] of [['backend', '后台服务'], ['bridge', '目录桥'], ['env', '推理入口'], ['cache', 'CLI 缓存'], ['acp', '会话模型']]) {
      items.push({ id, label, state: 'unknown', hint: '插件已停用。' });
    }
    return { ok: true, items };
  }
  const backendState = backendStatus === 'running' ? 'ok'
    : (backendStatus === 'starting' || backendStatus === undefined) ? 'unknown' : 'bad';
  items.push({ id: 'backend', label: '后台服务', state: backendState,
    hint: '后台服务未运行：打开面板查看错误，或「停用并恢复连接」后重新启用。' });
  const bridgeStatus = bridgeState === 'ready' ? 'ok'
    : (bridgeState === undefined || bridgeState === 'waiting' || bridgeState === 'connecting') ? 'unknown' : 'bad';
  items.push({ id: 'bridge', label: '目录桥', state: bridgeStatus,
    hint: '目录桥未建立：重新加载窗口；仍失败时查看「输出」面板的 Devin Fusion BYOK 通道。' });
  const envState = envValue === expectedEnv && typeof envValue === 'string' && typeof expectedEnv === 'string' ? 'ok' : 'bad';
  items.push({ id: 'env', label: '推理入口', state: envState,
    hint: '推理入口被改写：检查设置里的 devin.acp.agentEnv，其他扩展或手工改动会覆盖它。' });
  const cacheState = !cliCache || typeof cliCache !== 'object' ? 'unknown'
    : (Array.isArray(cliCache.errors) && cliCache.errors.length > 0) ? 'bad' : 'ok';
  items.push({ id: 'cache', label: 'CLI 缓存', state: cacheState,
    hint: 'CLI 缓存写入失败：在面板点「刷新缓存」，仍失败时查看输出通道。' });
  const acpState = acpObserved > 0 ? (acpOwnModels > 0 ? 'ok' : 'bad') : 'unknown';
  items.push({ id: 'acp', label: '会话模型', state: acpState,
    hint: '会话已建立但没观测到本插件的模型条目：新建对话；仍无则重新加载窗口。' });
  return { ok: items.every(item => item.state !== 'bad'), items };
}

module.exports = { checkInjectionHealth };

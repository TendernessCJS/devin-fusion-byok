'use strict';

// Injection-surface health for the settings panel and context diagnostics.
// Runs in the extension host (panel-install wires it), so it must stay free of
// backend-only imports and never be added to SOURCE_FILES.
//
// The result feeds panel state, which is deduplicated by JSON.stringify: every
// field must be fully determined by the inputs — no timestamps, no counters,
// nothing that changes between identical calls.
function checkInjectionHealth({ enabled = true, backendStatus, bridgeState, bridgeHook, envValue, expectedEnv, cliCache, desktopCatalog, acpObserved = 0, acpOwnModels = 0 } = {}) {
  const items = [];
  if (enabled === false) {
    for (const [id, label] of [['backend', '后台服务'], ['bridge', '目录桥'], ['env', '推理入口'], ['cache', 'CLI 缓存'], ['catalog', '桌面目录'], ['acp', '会话模型']]) {
      items.push({ id, label, state: 'unknown', hint: '插件已停用。' });
    }
    return { ok: true, items };
  }
  const backendState = backendStatus === 'running' ? 'ok'
    : (backendStatus === 'starting' || backendStatus === undefined) ? 'unknown' : 'bad';
  items.push({ id: 'backend', label: '后台服务', state: backendState,
    hint: '后台服务未运行：打开面板查看错误，或「停用并恢复连接」后重新启用。' });
  // A shadowed http hook outranks the raw bridge state: the setPort path still
  // works, but the heartbeat fallback is deaf, so even 'ready' is degraded.
  const bridgeStatus = bridgeHook === 'shadowed' ? 'bad'
    : bridgeState === 'ready' ? 'ok'
    : (bridgeState === undefined || bridgeState === 'waiting' || bridgeState === 'connecting') ? 'unknown' : 'bad';
  items.push({ id: 'bridge', label: '目录桥', state: bridgeStatus,
    hint: bridgeStatus === 'bad' && bridgeHook === 'shadowed'
      ? '目录桥被其他扩展的 http 包装遮蔽：桥端口重发仍有效，但心跳兜底已失效。重新加载窗口后仍复现时，查看输出通道的 ls-http-hook-shadowed。'
      : '目录桥未建立：重新加载窗口；仍失败时查看「输出」面板的 Devin Fusion BYOK 通道。' });
  const envState = envValue === expectedEnv && typeof envValue === 'string' && typeof expectedEnv === 'string' ? 'ok' : 'bad';
  items.push({ id: 'env', label: '推理入口', state: envState,
    hint: '推理入口被改写：检查设置里的 devin.acp.agentEnv，其他扩展或手工改动会覆盖它。' });
  const coverage = cliCache && typeof cliCache === 'object' ? cliCache.coverage : undefined;
  const writeFailed = Array.isArray(cliCache?.errors) && cliCache.errors.length > 0;
  const unsupported = Array.isArray(coverage?.unsupported) && coverage.unsupported.length > 0;
  const unchecked = !cliCache || typeof cliCache !== 'object' || !coverage || coverage.dirState !== 'ok';
  const cacheState = unchecked ? 'unknown' : (writeFailed || unsupported) ? 'bad' : 'ok';
  const cacheHint = writeFailed ? 'CLI 缓存写入失败：在面板点「刷新缓存」，仍失败时查看输出通道。'
    : unsupported ? '发现未知代际的 CLI 缓存文件，当前插件未适配，未做处理：请更新插件后重试。'
    : unchecked ? 'CLI 缓存尚未检查或缓存目录不可读：在面板点「刷新缓存」执行一次检查。'
    : 'CLI 缓存写入失败：在面板点「刷新缓存」，仍失败时查看输出通道。';
  items.push({ id: 'cache', label: 'CLI 缓存', state: cacheState, hint: cacheHint });
  // The desktop catalog is 'ok' only while the current emit has a confirmed
  // native commit; unconfirmed, logged-out and unchecked states are unknown.
  const catalogState = desktopCatalog === 'ready' ? 'ok'
    : (desktopCatalog === 'degraded' || desktopCatalog === 'unsupported') ? 'bad' : 'unknown';
  const catalogHint = desktopCatalog === 'degraded' ? '桌面模型目录同步失败：在面板点「刷新模型目录」，仍失败时查看输出通道。'
    : desktopCatalog === 'unsupported' ? '当前环境不支持桌面目录发布。'
    : '桌面模型目录尚未确认：在面板点「刷新模型目录」触发一次提交。';
  items.push({ id: 'catalog', label: '桌面目录', state: catalogState, hint: catalogHint });
  const acpState = acpObserved > 0 ? (acpOwnModels > 0 ? 'ok' : 'bad') : 'unknown';
  items.push({ id: 'acp', label: '会话模型', state: acpState,
    hint: '会话已建立但没观测到本插件的模型条目：新建对话；仍无则重新加载窗口。' });
  return { ok: items.every(item => item.state !== 'bad'), items };
}

module.exports = { checkInjectionHealth };

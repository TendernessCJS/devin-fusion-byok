'use strict';
// The status bar is the only always-visible runtime signal, so its wording is a
// pure decision kept out of the vscode wiring and covered on its own. Precedence
// is fixed: disabled wins, then missing native models, then cache write errors.
function statusTooltip({ enabled, nativeModelCount, cacheErrorCount, matrixCount }) {
  if (enabled === false) return 'Fusion BYOK：已停用，点击打开面板启用';
  if (!nativeModelCount) return 'Fusion BYOK：还没收到官方模型——打开一次模型选择器后会自动同步，或点击打开面板手动刷新';
  if (cacheErrorCount) return `Fusion BYOK：${cacheErrorCount} 个 CLI 缓存文件写入失败，点击打开面板查看详情`;
  return `Fusion BYOK：运行中 · 已镜像 Fusion 组合 ${matrixCount} 条，点击打开面板`;
}

module.exports = { statusTooltip };

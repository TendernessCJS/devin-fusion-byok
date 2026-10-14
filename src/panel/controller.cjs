'use strict';
const crypto = require('node:crypto');
const { renderPanel } = require('./view.cjs');
const { PanelInputError } = require('./model.cjs');
function createPanelController({ vscode, context, manager, safeError, updater, restartApp, fastContext, readMonitor = async () => ({ status: 'unsupported', snapshot: null }) }) {
  let panel;
  let monitorPending = false;
  const refreshMonitor = async () => {
    if (!panel || panel.visible === false || monitorPending) return;
    const target = panel;
    monitorPending = true;
    try {
      let result;
      try { result = await readMonitor(); } catch { result = { status: 'unavailable', snapshot: null }; }
      if (panel === target) await target.webview.postMessage({ type: 'monitor-state', result });
    } finally { monitorPending = false; }
  };
  let disposed = false;
  let lastState;
  let stateQueue = Promise.resolve();
  const postState = (target, state, { force = false } = {}) => {
    const job = stateQueue.then(async () => {
      if (disposed || target !== panel) return false;
      const encoded = JSON.stringify(state);
      if (!force && encoded === lastState) return true;
      const delivered = await target.webview.postMessage({ type: 'state', state });
      if (delivered && !disposed && target === panel) lastState = encoded;
      return delivered;
    });
    stateQueue = job.then(() => {}, () => {});
    return job;
  };
  const publishUpdates = () => panel && updater ? panel.webview.postMessage({ type: 'update-state', state: updater.snapshot() }) : undefined;
  const publish = () => panel ? postState(panel, manager.state()) : undefined;
  const FAST_CONTEXT_ERRORS = { fast_context_root_not_allowed: '只能选择已打开的项目或在此处选择的文件夹。',
    fast_context_root_missing: '该文件夹不存在或无法访问，请重新选择。', fast_context_untrusted: '请先信任工作区，再复制 Fast Context 配置。' };
  async function handleFastContext(target, message) {
    const post = value => target.webview.postMessage(value);
    if (!fastContext) { await post({ type: 'fast-context-result', ok: false, text: '当前环境不支持 Fast Context 配置。' }); return; }
    let selected;
    try {
      if (message.type === 'fastContext.pick') selected = await fastContext.pick() || undefined;
      else if (message.type === 'fastContext.copy') {
        const kind = message.payload?.kind === 'config' ? 'config' : 'prompt';
        await fastContext.copy(kind, message.payload?.root);
        await post({ type: 'fast-context-result', ok: true, text: kind === 'prompt' ? '提示词已复制，粘贴给其他 Harness 里的 Agent 即可。' : '配置 JSON 已复制。' });
      } else if (message.type !== 'fastContext.state') return;
    } catch (error) {
      await post({ type: 'fast-context-result', ok: false, text: FAST_CONTEXT_ERRORS[error?.message] || safeError(error).message });
    }
    await post({ type: 'fast-context-state', state: fastContext.state(), selected });
  }
  function open() {
    if (disposed) return;
    if (panel) { panel.reveal(); void publish(); return; }
    panel = vscode.window.createWebviewPanel('devinFusionByok.management', 'Fusion BYOK 控制面板', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    lastState = undefined;
    const current = panel;
    panel.webview.html = renderPanel({ nonce: crypto.randomBytes(24).toString('base64'), cspSource: panel.webview.cspSource });
    const messages = panel.webview.onDidReceiveMessage(async message => {
      if (!message || typeof message.id !== 'string' || message.id.length > 100 || typeof message.type !== 'string') return;
      if (message.type === 'monitor.refresh') { await refreshMonitor(); return; }
      if (message.type.startsWith('fastContext.')) { await handleFastContext(current, message); return; }
      try {
        if (message.type === 'window.reload') {
          const choice = await vscode.window.showWarningMessage('重载窗口会中断当前窗口正在进行的对话，但不会关闭应用、也不影响其他窗口。确定现在重载吗？', { modal: true }, '重载');
          if (choice === '重载') {
            try { await vscode.commands.executeCommand('workbench.action.reloadWindow'); }
            catch { throw new PanelInputError('无法重载窗口，请从命令面板执行 Developer: Reload Window。'); }
          }
          await current.webview.postMessage({ type: 'result', id: message.id, ok: true, cancelled: choice !== '重载' });
          return;
        }
        if (message.type === 'app.restart') {
          if (typeof restartApp !== 'function') throw new PanelInputError('当前环境不支持重启 Devin。');
          const choice = await vscode.window.showWarningMessage('重启 Devin 会关闭所有窗口并中断正在进行的对话，之后会自动重新打开（通常几秒，失败会自动重试）。确定现在重启吗？', { modal: true }, '重启');
          if (choice === '重启') {
            try { await restartApp(); }
            catch { throw new PanelInputError('无法自动重启 Devin，请手动退出后重新打开。'); }
          }
          await current.webview.postMessage({ type: 'result', id: message.id, ok: true, cancelled: choice !== '重启' });
          return;
        }
        if (message.type === 'goal.open') {
          await vscode.commands.executeCommand('devinFusionByok.goal');
          await current.webview.postMessage({ type: 'result', id: message.id, ok: true });
          return;
        }
        if (message.type.startsWith('update.') && updater) {
          if (message.type === 'update.check') await updater.check({ force: true });
          else if (message.type === 'update.install') await updater.installUpdate();
          else if (message.type === 'update.ignore') await updater.ignore();
          else if (message.type === 'update.auto' && typeof message.payload?.enabled === 'boolean') await updater.setAutoCheck(message.payload.enabled);
          else if (message.type === 'update.release') await vscode.env.openExternal(vscode.Uri.parse(updater.snapshot().releaseUrl));
          else if (message.type === 'update.proxy') {
            await manager.dispatch('setUpdateProxy', { value: message.payload?.value });
            await postState(current, manager.state(), { force: true });
            await updater.check({ force: true });
          }
          await publishUpdates();
          return;
        }
        const state = await manager.dispatch(message.type, message.payload);
        await postState(current, state, { force: message.type === 'ready' });
        await current.webview.postMessage({ type: 'result', id: message.id, ok: true });
      } catch (error) {
        const text = error instanceof PanelInputError ? error.message : safeError(error).message;
        await current.webview.postMessage({ type: 'result', id: message.id, ok: false, error: text });
        try { await postState(current, manager.state()); } catch {}
      }
    });
    const timer = setInterval(() => { void refreshMonitor().catch(() => {}); }, 5000);
    timer.unref?.();
    void refreshMonitor().catch(() => {});
    const closing = panel.onDidDispose(() => { clearInterval(timer); messages.dispose(); closing.dispose(); if (panel === current) panel = undefined; });
  }
  context.subscriptions.push({ dispose() { disposed = true; panel?.dispose(); } });
  return { open, publish, publishUpdates };
}
module.exports = { createPanelController };

'use strict';
const crypto = require('node:crypto');
const { renderPanel } = require('./view.cjs');
const { PanelInputError } = require('./manager.cjs');
const { translator, LANGUAGE_CHOICES } = require('../i18n/index.cjs');
// language: { choice(): string, set(choice): Promise } — the panel's language
// option; absent in hosts (and tests) that only render a fixed locale.
function createPanelController({ vscode, context, manager, safeError, updater, restartApp, reloadWindow, fastContext, readMonitor = async () => ({ status: 'unsupported', snapshot: null }), t = translator(), language = null }) {
  let panel;
  let monitorPending = false;
  const refreshMonitor = async () => {
    if (!panel || panel.visible === false || monitorPending) return;
    const target = panel;
    monitorPending = true;
    try {
      let result;
      try { result = await readMonitor(); } catch { result = { status: 'unavailable', snapshot: null }; }
      if (result?.snapshot) result = { ...result, providers: (manager.state().providers || []).map(({ id, name }) => ({ id, name })) };
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
  // Keyed by the error codes config-ui.cjs throws; the copy lives in src/i18n.
  const FAST_CONTEXT_ERRORS = new Set(['fast_context_root_not_allowed', 'fast_context_root_missing', 'fast_context_untrusted',
    'fast_context_check_required', 'fast_context_not_enabled', 'fast_context_unavailable']);
  const FAST_CONTEXT_COPIED = { prompt: 'fc.copied.prompt', json: 'fc.copied.json' };
  async function handleFastContext(target, message) {
    const post = value => target.webview.postMessage(value);
    if (!fastContext) { await post({ type: 'fast-context-result', ok: false, text: t('fc.error.unsupported') }); return; }
    const kind = Object.hasOwn(FAST_CONTEXT_COPIED, message.payload?.kind) ? message.payload.kind : 'prompt';
    let selected;
    try {
      if (message.type === 'fastContext.check') {
        const result = await fastContext.selfCheck();
        await post({ type: 'fast-context-result', check: true, ok: result.ok, text: fastContext.checkMessage(result.reason) });
      } else if (message.type === 'fastContext.enable') {
        await fastContext.setEnabled(message.payload?.enabled === true);
      } else if (message.type === 'fastContext.preview') {
        await post({ type: 'fast-context-preview', kind, root: message.payload?.root, text: fastContext.preview(kind, message.payload?.root) });
        return;
      } else if (message.type === 'fastContext.pick') selected = await fastContext.pick() || undefined;
      else if (message.type === 'fastContext.copy') {
        await fastContext.copy(kind, message.payload?.root);
        await post({ type: 'fast-context-result', ok: true, text: t(FAST_CONTEXT_COPIED[kind]) });
      } else if (message.type !== 'fastContext.state') return;
    } catch (error) {
      const text = FAST_CONTEXT_ERRORS.has(error?.message) ? t('fc.error.' + error.message) : safeError(error).message;
      if (message.type === 'fastContext.preview') { await post({ type: 'fast-context-preview', kind, root: message.payload?.root, text: '', error: text }); return; }
      await post({ type: 'fast-context-result', check: message.type === 'fastContext.check', enable: message.type === 'fastContext.enable', ok: false, text });
    }
    await post({ type: 'fast-context-state', state: fastContext.state(), selected });
  }
  const languageChoice = () => { try { return language?.choice() || 'auto'; } catch { return 'auto'; } };
  const render = target => {
    target.title = t('panel.title');
    target.webview.html = renderPanel({ nonce: crypto.randomBytes(24).toString('base64'), locale: t.locale, languageChoice: languageChoice() });
  };
  // Re-render an open panel in the current language. The page reloads and
  // sends 'ready' again, which forces a fresh state; the webview's saved tab
  // and provider (vscode.setState) are kept by the host across the reload.
  function relocalize() {
    if (disposed || !panel) return;
    lastState = undefined;
    render(panel);
  }
  function open() {
    if (disposed) return;
    if (panel) { panel.reveal(); void publish(); return; }
    panel = vscode.window.createWebviewPanel('devinFusionByok.management', t('panel.title'), vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    lastState = undefined;
    const current = panel;
    render(panel);
    const messages = panel.webview.onDidReceiveMessage(async message => {
      if (!message || typeof message.id !== 'string' || message.id.length > 100 || typeof message.type !== 'string') return;
      if (message.type === 'monitor.refresh') { await refreshMonitor(); return; }
      if (message.type.startsWith('fastContext.')) { await handleFastContext(current, message); return; }
      try {
        if (message.type === 'window.reload') {
          if (typeof reloadWindow !== 'function') throw new PanelInputError(t('panel.reload.unsupported'));
          // The modal returns the label it was given; compare against the same value.
          const confirmLabel = t('panel.reload.confirm');
          const choice = await vscode.window.showWarningMessage(t('panel.reload.prompt'), { modal: true }, confirmLabel);
          if (choice === confirmLabel) {
            try { await reloadWindow(); }
            catch { throw new PanelInputError(t('panel.reload.failed')); }
          }
          await current.webview.postMessage({ type: 'result', id: message.id, ok: true, cancelled: choice !== confirmLabel });
          return;
        }
        if (message.type === 'app.restart') {
          if (typeof restartApp !== 'function') throw new PanelInputError(t('panel.restart.unsupported'));
          const confirmLabel = t('panel.restart.confirm');
          const choice = await vscode.window.showWarningMessage(t('panel.restart.prompt'), { modal: true }, confirmLabel);
          if (choice === confirmLabel) {
            try { await restartApp(); }
            catch (error) {
              if (error?.message === 'restart_unsupported') throw new PanelInputError(t('panel.restart.unsupported'));
              throw new PanelInputError(t('panel.restart.failed'));
            }
          }
          await current.webview.postMessage({ type: 'result', id: message.id, ok: true, cancelled: choice !== confirmLabel });
          return;
        }
        if (message.type === 'setLanguage') {
          const choice = message.payload?.choice;
          if (!language || typeof language.set !== 'function') throw new PanelInputError(t('settings.language.unavailable'));
          if (!LANGUAGE_CHOICES.includes(choice)) throw new PanelInputError(t('settings.language.invalid'));
          // When the resolved language changes, set() re-renders this panel and
          // the result below lands on the new page, which ignores the unknown
          // id; otherwise the same page gets it and shows its toast. A failed
          // write reaches the page that asked, through the catch below.
          await language.set(choice);
          await current.webview.postMessage({ type: 'result', id: message.id, ok: true });
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
  return { open, publish, publishUpdates, relocalize };
}
module.exports = { createPanelController };

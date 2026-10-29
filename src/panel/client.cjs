'use strict';
function panelClient(createModelsView, createFusionView, createSettingsView, vscode, normalizeBaseUrlPath, modelEfforts) {
  'use strict';
  // Nodes recreated by render() cannot be found through the document after the
  // rebuild, so remember the live nodes here: typing must survive a state push.
  const focusTargets = new Map();
  const scrollTargets = new Map();
  const pending = new Map();
  const saved = vscode.getState() || {};
  const TAB_IDS = ['models', 'fusion', 'usage', 'goal', 'fastcontext', 'settings'];
  let serial = 0;
  let state;
  let busy = false;
  let toastTimer;
  const selection = {
    providerId: saved.providerId || '',
    tab: saved.tab || 'models',
    modelSearch: '',
    nativeSearch: '',
    nativeFilter: 'available',
    roleSearch: { lead: '', sidekick: '' },
    roleMoreOpen: { lead: false, sidekick: false },
  };

  function button(text, action, variant = 'secondary') {
    return element('button', { type: 'button', text, class: variant, onclick: action });
  }

  // A switch saves immediately and flips back when the host rejects the change.
  function switchInput(checked, label, save, disabled = false) {
    return element('input', { type: 'checkbox', role: 'switch', class: 'switch', checked, disabled, 'aria-label': label,
      onchange: event => {
        const value = event.target.checked;
        Promise.resolve(save(value)).then(ok => { if (ok === false) event.target.checked = !value; });
      } });
  }

  function remember() { vscode.setState({ providerId: selection.providerId, tab: selection.tab }); }

  function notice(message, tone) {
    const node = byId('status');
    clearTimeout(toastTimer);
    node.replaceChildren();
    node.dataset.tone = tone || '';
    node.hidden = !message;
    if (!message) return;
    node.append(element('span', { text: message }));
    if (tone === 'error') node.append(element('button', { type: 'button', class: 'quiet', text: '×', 'aria-label': '关闭提示', onclick: () => notice('') }));
    if (tone === 'success') toastTimer = setTimeout(() => notice(''), 2500);
  }

  const controls = () => document.querySelectorAll('main button:not(.tab), main input, main select');
  // The original disabled state of every locked control lives here, not on the
  // node: a state update that arrives while a request is in flight (the host
  // posts state before the result) re-applies the lock from render(), and a
  // node-born copy of the original would be overwritten with `true` at that
  // moment — the control would then be restored to `true` and stay dead for the
  // rest of the panel's life. Recorded once per node, on first lock.
  const lockedControls = new Map();

  function lockControls() {
    for (const node of controls()) {
      if (!lockedControls.has(node)) lockedControls.set(node, node.disabled);
      node.disabled = true;
    }
  }

  function unlockControls() {
    for (const [node, disabled] of lockedControls) node.disabled = disabled;
    lockedControls.clear();
  }

  function setBusy(value) {
    busy = value;
    byId('main').setAttribute('aria-busy', String(value));
    if (value) lockControls(); else unlockControls();
  }

  function request(type, payload = {}) {
    const id = 'panel-' + Date.now() + '-' + (++serial);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error('操作等待超时，请稍后重试。'));
      }, 90000);
      pending.set(id, { resolve, reject, timeout });
      vscode.postMessage({ id, type, payload });
    });
  }

  async function run(action, progress, success) {
    if (busy) return false;
    setBusy(true);
    notice(progress || '正在保存…');
    try {
      await action();
      notice(success || '已保存，新对话中生效。', 'success');
      return true;
    } catch (error) {
      notice(error.message || '操作失败，请重试。', 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const off = () => state?.enabled === false;
  const currentProvider = () => state?.providers?.find(provider => provider.id === selection.providerId);
  const hostOf = url => { try { return new URL(url).host; } catch { return url; } };

  function showTab(next) {
    selection.tab = TAB_IDS.includes(next) ? next : 'models';
    remember();
    for (const node of document.querySelectorAll('.tab')) node.setAttribute('aria-selected', String(node.dataset.tab === selection.tab));
    for (const id of TAB_IDS) byId('view-' + id).hidden = id !== selection.tab;
    if (selection.tab === 'usage') vscode.postMessage({ id: 'monitor-refresh', type: 'monitor.refresh' });
    if (selection.tab === 'fastcontext') vscode.postMessage({ id: 'fc-refresh', type: 'fastContext.state' });
  }

  function openDialog(title) {
    const dialog = byId('editor-dialog');
    if (dialog.open) dialog.close();
    dialog.replaceChildren(element('h2', { id: 'dialog-title', text: title }));
    const form = element('form', { autocomplete: 'off' });
    dialog.append(form);
    return { dialog, form };
  }

  function field(label, control, hint) {
    return element('label', { class: 'field' }, element('span', { class: 'field-title', text: label }), control,
      hint ? element('span', { class: 'hint', text: hint }) : null);
  }

  function input(value, attributes = {}) {
    const node = element('input', { type: 'text', ...attributes });
    node.value = value == null ? '' : String(value);
    return node;
  }

  function finishDialog(dialog, form, submitText, onSubmit, extraButton, successText) {
    const error = element('p', { class: 'dialog-error', role: 'alert' });
    const cancel = button('取消', () => dialog.close());
    const submit = element('button', { type: 'submit', text: submitText });
    form.append(error, element('div', { class: 'dialog-actions' }, extraButton || null, element('span', { class: 'spacer' }), cancel, submit));
    let saving = false;
    const preventCancelWhileSaving = event => { if (saving) event.preventDefault(); };
    dialog.addEventListener('cancel', preventCancelWhileSaving);
    dialog.addEventListener('close', () => {
      dialog.removeEventListener('cancel', preventCancelWhileSaving);
      for (const node of form.querySelectorAll('input[type="password"]')) node.value = '';
    }, { once: true });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving || busy || !form.reportValidity()) return;
      saving = true;
      error.textContent = '';
      const locked = [...form.querySelectorAll('input, select, button')].map(node => [node, node.disabled]);
      for (const [node] of locked) node.disabled = true;
      setBusy(true);
      try {
        await onSubmit();
        dialog.close();
        notice(successText || '已保存，新对话中生效。', 'success');
      } catch (failure) {
        error.textContent = failure.message || '保存失败，请重试。';
      } finally {
        saving = false;
        for (const [node, disabled] of locked) node.disabled = disabled;
        setBusy(false);
      }
    });
    dialog.showModal();
    return submit;
  }

  function confirmDialog(title, message, onConfirm) {
    const { dialog, form } = openDialog(title);
    form.append(element('p', { class: 'confirm-text', text: message }));
    finishDialog(dialog, form, '删除', onConfirm, null, '已删除。').classList.add('danger');
  }

  // Deleting lives inside each editor so list rows stay uncluttered.
  function deleteButton(dialog, title, message, onConfirm) {
    return element('button', { type: 'button', class: 'danger', text: '删除', onclick: () => { dialog.close(); confirmDialog(title, message, onConfirm); } });
  }

  const ui = {
    state: () => state,
    busy: () => busy,
    off,
    selection,
    request,
    run,
    notice,
    remember,
    element,
    byId,
    button,
    switchInput,
    input,
    field,
    openDialog,
    finishDialog,
    confirmDialog,
    deleteButton,
    focusTargets,
    scrollTargets,
    currentProvider,
    hostOf,
    normalizeBaseUrlPath,
    modelEfforts,
  };
  const modelsView = createModelsView(ui);
  const fusionView = createFusionView(ui);
  const settingsView = createSettingsView(ui);

  function render() {
    if (!state) return;
    if (!state.providers.some(provider => provider.id === selection.providerId)) selection.providerId = state.providers[0]?.id || '';
    remember();
    const active = document.activeElement;
    let focusedKey = '';
    for (const [key, node] of focusTargets) if (node === active) focusedKey = key;
    const caret = focusedKey && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const scrolls = new Map([...scrollTargets].map(([key, node]) => [key, node.scrollTop]));
    const pageTop = document.scrollingElement ? document.scrollingElement.scrollTop : null;
    byId('plugin-enabled').checked = !off();
    byId('plugin-enabled').disabled = false;
    byId('add-provider').disabled = false;
    byId('disabled-banner').hidden = !off();
    byId('goal-enabled').checked = state.goalEnabled === true;
    byId('goal-enabled').disabled = off();
    byId('goal-enabled-label').textContent = state.goalEnabled === true ? '已开启' : '已关闭';
    modelsView.render();
    settingsView.render();
    fusionView.render();
    for (const [key, top] of scrolls) { const node = scrollTargets.get(key); if (node) node.scrollTop = top; }
    if (pageTop !== null) document.scrollingElement.scrollTop = pageTop;
    if (busy) lockControls();
    if (!focusedKey) return;
    // Never pull focus back into a webview the user has left (the panel can stay
    // alive while hidden — retainContextWhenHidden — and stealing focus from the
    // editor would be worse than losing it here).
    if (document.hasFocus && document.hasFocus() === false) return;
    const node = focusTargets.get(focusedKey);
    if (!node || node.disabled) return;
    node.focus();
    if (caret) try { node.setSelectionRange(caret[0], caret[1]); } catch {}
  }

  for (const node of document.querySelectorAll('.tab')) node.addEventListener('click', () => showTab(node.dataset.tab));
  modelsView.bind();
  settingsView.bind();
  const setEnabled = value => run(() => request('setEnabled', { enabled: value }), value ? '正在启用…' : '正在停用…', value ? '已启用。' : '已停用。');
  byId('plugin-enabled').addEventListener('change', event => {
    const value = event.target.checked;
    setEnabled(value).then(ok => { if (!ok) event.target.checked = !value; });
  });
  byId('enable-now').addEventListener('click', () => setEnabled(true));
  byId('goal-enabled').addEventListener('change', event => {
    const value = event.target.checked;
    run(() => request('setGoalEnabled', { enabled: value }), value ? '正在开启目标模式…' : '正在关闭目标模式…',
      value ? '目标模式已开启，新的对话里可以使用 /goal。' : '目标模式已关闭。').then(ok => { if (!ok) event.target.checked = !value; });
  });
  byId('open-goal').addEventListener('click', () => {
    request('goal.open').catch(error => notice(error.message || '无法打开目标进度。', 'error'));
  });
  byId('reload-window').addEventListener('click', async () => {
    if (busy) return;
    try { await request('window.reload'); }
    catch (error) { notice(error.message || '重载失败，请从命令面板执行 Developer: Reload Window。', 'error'); }
  });
  byId('restart-devin').addEventListener('click', async () => {
    if (busy) return;
    try {
      const result = await request('app.restart');
      if (!result?.cancelled) notice('正在关闭并重启 Devin（通常几秒后自动重开，失败会自动重试）…', 'success');
    } catch (error) { notice(error.message || '重启失败，请手动退出后重新打开 Devin。', 'error'); }
  });
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'state' && message.state && Array.isArray(message.state.providers)) {
      const initial = !state;
      state = message.state;
      render();
      if (initial) byId('main').setAttribute('aria-busy', 'false');
    } else if (message.type === 'result') {
      const operation = pending.get(message.id);
      if (!operation) return;
      pending.delete(message.id);
      clearTimeout(operation.timeout);
      if (message.ok) operation.resolve({ cancelled: message.cancelled === true });
      else operation.reject(new Error(typeof message.error === 'string' ? message.error : '操作失败，请重试。'));
    }
  });
  showTab(selection.tab);
  request('ready').catch(error => notice(error.message, 'error'));
}

module.exports = { panelClient };

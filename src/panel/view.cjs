'use strict';
const { modelSupportsImages } = require('../model-capabilities.cjs');
const { normalizeBaseUrlPath } = require('./base-url.cjs');
const { monitorMarkup, monitorScript } = require('./monitor-view.cjs');
const { updateMarkup, updateScript } = require('./update-view.cjs');
const { fastContextMarkup, fastContextScript } = require('./fast-context-view.cjs');
const { baseStyles } = require('./theme.cjs');

function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

const TABS = [['models', '模型'], ['fusion', 'Fusion'], ['usage', '用量'], ['goal', 'Goal', 'Beta'], ['fastcontext', 'Fast Context'], ['settings', '设置']];

function goalMarkup() {
  const code = text => `<code class="cmd">${text}</code>`;
  const rows = [
    ['/goal 要达成的目标', '在当前对话启动目标，这条消息就是第一轮。已有目标时会替换旧目标。'],
    ['/goal', '查看当前目标、状态、已运行轮数和最近进展。'],
    ['/goal pause', '暂停自动推进。'],
    ['/goal resume', '继续推进；已到运行上限时再追加 10 轮（总共最多 100 轮）。'],
    ['/goal clear', '清除当前目标。']
  ].map(([command, text]) => `<div class="row"><div class="row-main"><span class="row-title">${code(command)}</span><span class="row-sub">${text}</span></div></div>`).join('');
  return `<div class="goal-doc">
      <div class="section-head"><h2>Goal <span class="badge beta">Beta</span></h2><button id="open-goal" class="secondary" type="button">查看目标进度</button></div>
      <p>让模型围绕一个目标一轮轮自动工作，直到它提交带证据的完成报告。在 Devin 聊天框里直接输入命令即可，不需要在这里设置。</p>
      <h3 class="mt">命令</h3>
      <div class="list">${rows}</div>
      <h3 class="mt">怎么写目标</h3>
      <p>把“怎样算做完”直接写进这句话，最好能用命令或文件验证。例如：${code('/goal 让 test/auth 里的测试全部通过，并保持 lint 干净')}</p>
      <h3 class="mt">它会怎么运行</h3>
      <ul>
        <li>每轮结束前，模型用插件提供的报告命令提交状态：有进展、等待你的输入、受阻，或已完成。</li>
        <li>提交“有进展”后自动开始下一轮；提交“已完成”并附上证据后，目标自动结束并进入历史。模型只在文字里说“做完了”不算。</li>
        <li>你在进行中插话，目标会让出这一轮，你这轮结束后自动接着推进；模型等你回答时，你回复后也会自动继续。</li>
        <li>默认最多 10 轮。遇到权限确认、运行被取消、连续两轮没有报告、连续三轮进展相同、窗口重新加载时会停下，用 ${code('/goal resume')} 继续。</li>
      </ul>
      <h3 class="mt">注意</h3>
      <ul>
        <li>这是测试版，还在收集真实使用反馈。</li>
        <li>每一轮都是一次正常的模型调用，会按你的供应商计费。${code('/goal')}、${code('/goal pause')} 等查看和控制命令也会产生一次很短的模型回复。</li>
        <li>完成报告来自模型本身，关键结果请自己再核对一下。</li>
      </ul>
    </div>`;
}


function renderPanel({ nonce, cspSource }) {
  const safeNonce = escapeAttribute(nonce);
  const tabs = TABS.map(([id, label, tag], index) => `<button id="tab-${id}" class="tab" type="button" role="tab" aria-controls="view-${id}" aria-selected="${index === 0}" data-tab="${id}">${label}${tag ? ` <span class="badge beta">${tag}</span>` : ''}</button>`).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${safeNonce}'; script-src 'nonce-${safeNonce}'; img-src ${escapeAttribute(cspSource || "'none'")}; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none';">
  <title>Fusion BYOK</title>
  <style nonce="${safeNonce}">${baseStyles()}
    :root { color-scheme: light dark; }
    body { --page-top: 0; }
    main { max-width: 960px; margin: 0 auto; }
    .topbar { position: sticky; top: 0; z-index: 5; background: var(--bg); border-bottom: 1px solid var(--border); margin: 0 calc(-1 * var(--page-x)) 20px; padding: 14px var(--page-x) 0; }
    .topbar-row .actions { gap: 14px; }
    .topbar-row { max-width: 960px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .tabs { max-width: 960px; margin: 10px auto 0; display: flex; gap: 4px; }
    .tab { background: transparent; color: var(--muted); border: 0; border-bottom: 2px solid transparent; border-radius: 0; padding: 6px 12px 8px; min-height: 0; }
    .tab:hover { background: transparent; color: var(--vscode-foreground, #ddd); }
    .tab[aria-selected="true"] { color: var(--vscode-foreground, #ddd); border-bottom-color: var(--accent); }
    .toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; white-space: nowrap; }
    .banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; margin-bottom: 16px; border: 1px solid var(--warn); border-radius: var(--radius-container); }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; min-height: 28px; }
    .list { border: 1px solid var(--border); border-radius: var(--radius-container); overflow: hidden; }
    .row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; min-height: 48px; }
    .row.compact { min-height: 0; padding: 6px 14px; }
    label.row { cursor: pointer; }
    .row + .row, .row + details, details > .row { border-top: 1px solid var(--border); }
    .vendor-head { padding: 10px 14px 4px; font-size: 11px; font-weight: 600; color: var(--muted); }
    .vendor-head + .row { border-top: none; }
    .vendor-head:not(:first-child) { border-top: 1px solid var(--border); }
    .row-main { flex: 1; min-width: 0; }
    .row-title { display: block; overflow-wrap: anywhere; }
    .row-sub { display: block; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    button.link-title { display: block; padding: 0; min-height: 0; border: 0; background: transparent; color: inherit; text-align: left; white-space: normal; overflow-wrap: anywhere; }
    button.link-title:hover { background: transparent; text-decoration: underline; }
    .badge { font-size: 11px; padding: 1px 8px; border-radius: var(--radius-pill); background: var(--accent); color: var(--vscode-button-foreground, #fff); white-space: nowrap; }
    .badge.beta { background: transparent; color: var(--accent); border: 1px solid var(--accent); font-size: 10px; padding: 0 6px; vertical-align: 1px; }
    .goal-doc { max-width: 760px; }
    .goal-doc ul { padding-left: 20px; margin: 6px 0; }
    .goal-doc li { margin: 4px 0; }
    code.cmd { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; padding: 1px 5px; border-radius: 4px; background: var(--vscode-textCodeBlock-background, #2b2b2b); overflow-wrap: anywhere; }
    .empty { padding: 32px 16px; text-align: center; color: var(--muted); }
    .empty button { margin-top: 12px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; align-items: center; }
    .toolbar input[type="search"] { flex: 1 1 200px; width: auto; }
    .models-layout { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 16px; align-items: start; }
    .provider-nav { display: grid; gap: 2px; }
    button.provider-item { display: block; text-align: left; width: 100%; padding: 8px 10px; white-space: normal; color: inherit; background: transparent; border-color: transparent; }
    button.provider-item:hover { background: var(--hover); }
    button.provider-item.selected { background: var(--vscode-list-inactiveSelectionBackground, #37373d); }
    .provider-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; min-height: 28px; }
    .scroll { max-height: 440px; overflow: auto; }
    details.fold > summary { cursor: pointer; padding: 8px 14px; color: var(--muted); list-style: none; }
    details.fold > summary::-webkit-details-marker { display: none; }
    details.fold > summary::before { content: '▸ '; }
    details.fold[open] > summary::before { content: '▾ '; }
    details.group { border: 1px solid var(--border); border-radius: 6px; margin-top: 12px; }
    details.group > summary { cursor: pointer; padding: 12px 14px; font-weight: 600; list-style: none; display: flex; justify-content: space-between; gap: 12px; }
    details.group > summary::-webkit-details-marker { display: none; }
    details.group > summary::after { content: '▸'; color: var(--muted); font-weight: 400; }
    details.group[open] > summary::after { content: '▾'; }
    details.group > summary .hint { font-weight: 400; margin-left: auto; }
    .group-body { padding: 0 14px 14px; }
    .role-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .setting { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; }
    .setting + .setting { border-top: 1px solid var(--border); }
    .toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 20; max-width: min(560px, calc(100vw - 32px)); display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-radius: var(--radius-container); border: 1px solid var(--border); background: var(--vscode-editorWidget-background, #252526); box-shadow: 0 4px 16px var(--vscode-widget-shadow, #0006); }
    .toast[data-tone="error"] { border-color: var(--vscode-inputValidation-errorBorder, #be1100); color: var(--error); }
    .toast[data-tone="success"] { color: var(--ok); }
    .monitor-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
    .monitor-controls select { width: auto; max-width: 320px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .monitor-pager { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
    #monitor-diagnostics { white-space: pre-line; overflow-wrap: anywhere; }
    #monitor-date-controls:not([hidden]) { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; max-width: 100%; }
    #monitor-date-controls label { display: inline-flex; gap: 4px; align-items: center; }
    #monitor-date-controls input { width: auto; }
    #update-proxy { width: 200px; flex: 0 1 auto; min-width: 120px; max-width: 200px; }
    .monitor-table-wrap { overflow: auto; max-height: 480px; border: 1px solid var(--border); border-radius: var(--radius-container); }
    .monitor-table { border-collapse: collapse; white-space: nowrap; width: 100%; font-variant-numeric: tabular-nums; }
    .monitor-table td, .monitor-table th { padding: 7px 10px; border-bottom: 1px solid var(--border); text-align: left; }
    .monitor-table th { position: sticky; top: 0; background: var(--bg); font-weight: 500; color: var(--muted); }
    #usage-monitor:not(.detailed) .extra { display: none; }
    .update-notes { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin: 8px 0 0; }
    .warn.pending { color: var(--muted); }
    dialog { width: min(500px, calc(100vw - 28px)); max-height: calc(100vh - 40px); overflow: auto; margin: auto; padding: 20px; border: 1px solid var(--border); border-radius: var(--radius-overlay); color: var(--vscode-foreground, #ddd); background: var(--bg); box-shadow: 0 8px 28px var(--vscode-widget-shadow, #0006); }
    dialog::backdrop { background: #0007; }
    dialog h2 { font-size: 16px; margin-bottom: 16px; }
    .field { display: block; margin-bottom: 12px; }
    .field-title { display: block; margin-bottom: 4px; }
    .field .hint { display: block; margin-top: 4px; }
    .url-preview { word-break: break-all; font-family: var(--vscode-editor-font-family, monospace); }
    .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    dialog details.fold > summary { padding: 4px 0; margin-bottom: 8px; }
    .dialog-actions { display: flex; align-items: center; gap: 8px; margin-top: 16px; }
    .dialog-error { color: var(--error); overflow-wrap: anywhere; }
    .confirm-text { white-space: pre-line; overflow-wrap: anywhere; }
    .import-picker .scroll { max-height: min(320px, 40vh); }
    @media (max-width: 700px) {
      body { --page-x: 16px; }
      .topbar { margin: 0 calc(-1 * var(--page-x)) 16px; padding: 12px var(--page-x) 0; }
      .models-layout, .role-grid { grid-template-columns: 1fr; }
      .provider-nav { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
      .field-grid { grid-template-columns: 1fr; gap: 0; }
    }
  </style>
</head>
<body>
  <main id="main" aria-busy="true">
    <header class="topbar">
      <div class="topbar-row"><h1>Fusion BYOK</h1><div class="actions"><button id="reload-window" class="secondary" type="button" title="应用插件改动或刷新模型选择器时使用。会中断当前窗口正在进行的对话，但不关闭应用、不影响其他窗口，比重启 Devin 快。">重载窗口</button><button id="restart-devin" class="secondary" type="button" title="重载窗口仍无效时使用。会关闭所有窗口并中断正在进行的对话，之后自动重新打开（通常几秒，失败会自动重试）。">重启 Devin</button><label class="toggle"><span class="muted">启用</span><input id="plugin-enabled" class="switch" type="checkbox" role="switch" aria-label="启用插件" disabled></label></div></div>
      <nav class="tabs" role="tablist" aria-label="面板分区">${tabs}</nav>
    </header>
    <div id="disabled-banner" class="banner" hidden><span>插件已停用：导入的模型不会出现在新对话里，官方 Fusion 卡片里也不会有本插件的条目。</span><button id="enable-now" type="button">启用</button></div>
    <section id="view-models" role="tabpanel" aria-labelledby="tab-models">
      <div class="models-layout">
        <div><div class="section-head"><h2>供应商</h2><button id="add-provider" class="quiet" type="button" disabled>添加</button></div><nav id="providers" class="provider-nav" aria-label="供应商列表"></nav></div>
        <div id="models"></div>
      </div>
    </section>
    <section id="view-fusion" role="tabpanel" aria-labelledby="tab-fusion" hidden>
      <div class="section-head"><h2>Fusion 可选模型</h2><span id="role-count" class="hint"></span></div>
      <p id="fusion-summary" class="hint mb"></p>
      <p class="hint mb">这里启用的模型会出现在 Devin 官方 Fusion 卡片的 Lead / Sidekick 下拉里；Lead 按系列（Effort 档位）成组，官方默认项已可用，无需手动添加。停用后模型从下拉移除，相关组合同时失效——正在使用的组合请在 Fusion 卡片里重新选择。</p>
      <div class="role-grid"><div id="role-lead"></div><div id="role-sidekick"></div></div>
    </section>
    <section id="view-usage" role="tabpanel" aria-labelledby="tab-usage" hidden>${monitorMarkup()}</section>
    <section id="view-goal" role="tabpanel" aria-labelledby="tab-goal" hidden>${goalMarkup()}</section>
    <section id="view-fastcontext" role="tabpanel" aria-labelledby="tab-fastcontext" hidden>${fastContextMarkup()}</section>
    <section id="view-settings" role="tabpanel" aria-labelledby="tab-settings" hidden>
      <div id="settings-general"></div>
      <details id="native-group" class="group"><summary>官方模型显示<span id="native-count" class="hint"></span></summary><div class="group-body" id="native-models"></div></details>
      <details id="cache-group" class="group"><summary>CLI 缓存<span id="cache-hint" class="hint"></span></summary><div class="group-body">
        <p class="hint mb">模型选择器读的是 Devin CLI 在 <code class="cmd">~/.cache/devin/cli</code> 下的缓存文件（按账号身份区分）。配置改过后如果下拉里少条目或出现已删除的模型，点「刷新缓存」原地重写——原文件保留为 <code class="cmd">.bak</code>，不删除。</p>
        <div class="actions"><button id="refresh-cache" type="button">刷新缓存</button><span id="cache-report" class="hint"></span></div>
      </div></details>
      ${updateMarkup()}
    </section>
  </main>
  <div id="status" class="toast" role="status" aria-live="polite" hidden></div>
  <dialog id="editor-dialog" aria-labelledby="dialog-title"></dialog>
  <script nonce="${safeNonce}">const vscode = acquireVsCodeApi(); (${panelClient.toString()})(${modelSupportsImages.toString()}, vscode, ${normalizeBaseUrlPath.toString()}); ${monitorScript()} ${updateScript()} ${fastContextScript()}</script>
</body>
</html>`;
}

function panelClient(modelSupportsImages, vscode, normalizeBaseUrlPath) {
  'use strict';
  const byId = id => document.getElementById(id);
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
  let providerId = saved.providerId || '';
  let tab = saved.tab || 'models';
  let modelSearch = '';
  let nativeSearch = '';
  let toastTimer;
  const roleSearch = { lead: '', sidekick: '' };
  const roleMoreOpen = { lead: false, sidekick: false };

  function element(tag, attributes, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes || {})) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value ?? '');
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'checked' || key === 'disabled' || key === 'required' || key === 'readOnly' || key === 'hidden' || key === 'open') node[key] = Boolean(value);
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child == null) continue;
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

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

  function remember() { vscode.setState({ providerId, tab }); }

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
  const currentProvider = () => state?.providers?.find(provider => provider.id === providerId);
  const hostOf = url => { try { return new URL(url).host; } catch { return url; } };

  function showTab(next) {
    tab = TAB_IDS.includes(next) ? next : 'models';
    remember();
    for (const node of document.querySelectorAll('.tab')) node.setAttribute('aria-selected', String(node.dataset.tab === tab));
    for (const id of TAB_IDS) byId('view-' + id).hidden = id !== tab;
    if (tab === 'usage') vscode.postMessage({ id: 'monitor-refresh', type: 'monitor.refresh' });
    if (tab === 'fastcontext') vscode.postMessage({ id: 'fc-refresh', type: 'fastContext.state' });
  }

  function render() {
    if (!state) return;
    if (!state.providers.some(provider => provider.id === providerId)) providerId = state.providers[0]?.id || '';
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
    renderProviders();
    renderModels();
    renderGeneral();
    renderRoles();
    renderNative();
    renderCache();
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

  function renderProviders() {
    const container = byId('providers');
    container.replaceChildren();
    if (!state.providers.length) {
      container.append(element('p', { class: 'hint', text: '还没有供应商。' }));
      return;
    }
    for (const provider of state.providers) {
      const on = provider.models.filter(model => model.enabled !== false).length;
      container.append(element('button', {
        type: 'button', class: 'provider-item' + (provider.id === providerId ? ' selected' : ''),
        'aria-current': provider.id === providerId ? 'true' : 'false',
        onclick: () => {
          if (busy || providerId === provider.id) return;
          providerId = provider.id;
          modelSearch = '';
          remember();
          renderProviders();
          renderModels();
        }
      }, element('span', { class: 'row-title', text: provider.name }),
      element('span', { class: 'row-sub', text: provider.enabled === false ? '已停用' : on + ' 个模型' })));
    }
  }

  function renderModels() {
    const container = byId('models');
    const provider = currentProvider();
    container.replaceChildren();
    if (!provider) {
      container.append(element('div', { class: 'list' }, element('div', { class: 'empty' },
        element('p', { text: '添加一个 OpenAI 或 Anthropic 兼容的 API，就能在 Devin 里用它的模型。' }),
        button('添加供应商', () => providerDialog(), ''))));
      return;
    }
    const format = { 'openai-responses': 'Responses', anthropic: 'Anthropic Messages' }[provider.apiFormat] || 'Chat Completions';
    container.append(element('div', { class: 'provider-head' },
      element('div', { class: 'row-main' }, element('h2', { text: provider.name }),
        element('span', { class: 'row-sub', text: hostOf(provider.baseUrl) + ' · ' + format + (provider.keyConfigured ? '' : ' · 未填密钥') })),
      element('div', { class: 'actions' },
        switchInput(provider.enabled !== false, '启用供应商 ' + provider.name,
          value => run(() => request('setProviderEnabled', { id: provider.id, enabled: value }))),
        button('编辑', () => providerDialog(provider), 'quiet'))));
    if (provider.enabled === false) container.append(element('p', { class: 'warn mb', text: '已停用，这里的模型不会出现在新对话里。' }));
    const search = element('input', { type: 'search', placeholder: '搜索模型', 'aria-label': '搜索导入的模型',
      oninput: event => { modelSearch = event.target.value; renderModelRows(); } });
    search.value = modelSearch;
    focusTargets.set('model-search', search);
    const importButton = button('导入模型', () => run(async () => {
      await request('refreshModels', { providerId: provider.id });
      importDialog(provider.id);
    }, '正在获取模型列表…', '请勾选要导入的模型。'), '');
    container.append(element('div', { class: 'toolbar' }, provider.models.length ? search : element('span', { class: 'spacer' }),
      importButton, button('手动添加', () => modelDialog(provider))));
    const list = element('div', { id: 'model-list', class: 'list scroll', 'aria-label': '模型列表' });
    scrollTargets.set('model-list', list);
    container.append(list);
    renderModelRows();
  }

  function visibleModels() {
    const query = modelSearch.trim().toLocaleLowerCase();
    return (currentProvider()?.models || []).filter(model => !query || (model.id + ' ' + (model.label || '')).toLocaleLowerCase().includes(query));
  }

  function renderModelRows() {
    const container = byId('model-list');
    if (!container) return;
    const provider = currentProvider();
    container.replaceChildren();
    const models = visibleModels();
    if (!models.length) {
      container.append(element('div', { class: 'empty', text: provider.models.length ? '没有匹配的模型。' : '还没有模型，点「导入模型」从供应商获取。' }));
      return;
    }
    if (models.length > 1) {
      const bulk = value => {
        const changes = models.filter(model => (model.enabled !== false) !== value).map(model => ({ id: model.id, enabled: value }));
        if (changes.length) run(() => request('updateModels', { providerId: provider.id, changes }));
      };
      container.append(element('div', { class: 'row compact' },
        element('span', { class: 'row-main hint', text: models.filter(model => model.enabled !== false).length + ' / ' + models.length + ' 已启用' }),
        button('全部启用', () => bulk(true), 'quiet'), button('全部停用', () => bulk(false), 'quiet')));
    }
    for (const model of models) {
      const name = model.label || model.id;
      container.append(element('div', { class: 'row' },
        element('div', { class: 'row-main' },
          element('button', { type: 'button', class: 'link-title', text: name, 'aria-label': '编辑模型 ' + name, onclick: () => modelDialog(provider, model) }),
          name !== model.id ? element('span', { class: 'row-sub mono', text: model.id }) : null),
        switchInput(model.enabled !== false, '启用模型 ' + name,
          value => run(() => request('updateModels', { providerId: provider.id, changes: [{ id: model.id, enabled: value }] })))));
    }
  }

  function renderGeneral() {
    const container = byId('settings-general');
    container.replaceChildren();
    const setting = (title, sub, control) => element('div', { class: 'setting' },
      element('div', { class: 'row-main' }, element('span', { class: 'row-title', text: title }), sub ? element('span', { class: 'row-sub', text: sub }) : null), control);
    const status = state.autoContinueStatus === 'attached' ? null
      : state.autoContinueStatus === 'waiting' ? '还没连上会话：重新加载窗口并新建对话后生效。'
      : '自动继续当前不可用，请在「输出」面板的 Devin Fusion BYOK 通道查看日志。';
    container.append(element('div', { class: 'section-head' }, element('h2', { text: '自动继续' })),
      element('div', { class: 'list' },
        setting('服务商出错时自动重试', '临时错误打断回复时自动发送 continue。按量计费的服务商可能多扣费。',
          switchInput(state.autoContinueOnProviderError === true, '服务商出错时自动重试',
            value => run(() => request('setAutoContinue', { enabled: value })), off())),
        setting('待办没做完时自动继续', '会话里还有未完成的 Plan 时自动推进，随时可以手动停止。',
          switchInput(state.autoContinueUntilPlanComplete === true, '待办没做完时自动继续',
            value => run(() => request('setAutoContinueUntilPlanComplete', { enabled: value })), off()))),
      element('p', { class: 'warn mt', text: status || '', hidden: !status }));
  }

  const FUSION_SOURCES = { mirrored: '插件镜像', official: '官方', unresolved: '已不在可用列表' };
  // Live status for the Fusion tab: how many combinations this extension
  // mirrors into the official card, plus the last combination the card was
  // seen holding. Read-only — the card itself stays the source of truth.
  function fusionSummary() {
    const last = state.lastFusion;
    return '已镜像 ' + (state.fusionCount || 0) + ' 条组合；' + (last && last.uid
      ? '最近一次使用：' + (last.label || last.uid) + '（' + (FUSION_SOURCES[last.source] || '未知') + '）'
      : '还没有在 Fusion 卡片里选过组合');
  }

  function renderRoles() {
    const lists = state.roleLists || {};
    const on = role => (lists[role] || []).filter(item => item.selected).length;
    byId('role-count').textContent = 'Lead ' + on('lead') + ' · Sidekick ' + on('sidekick');
    byId('fusion-summary').textContent = fusionSummary();
    for (const role of ['lead', 'sidekick']) {
      const container = byId('role-' + role);
      const name = role === 'lead' ? 'Lead' : 'Sidekick';
      container.replaceChildren();
      const search = element('input', { type: 'search', placeholder: '搜索', 'aria-label': '搜索 ' + name + ' 模型',
        oninput: event => { roleSearch[role] = event.target.value; renderRoleRows(role); } });
      search.value = roleSearch[role];
      focusTargets.set('role-search-' + role, search);
      const list = element('div', { id: role + '-role-list', class: 'list scroll', 'aria-label': name + ' 模型列表' });
      scrollTargets.set(role + '-role-list', list);
      container.append(element('h3', { text: name }), element('div', { class: 'toolbar' }, search), list);
      renderRoleRows(role);
    }
  }

  function renderRoleRows(role) {
    const container = byId(role + '-role-list');
    if (!container) return;
    const name = role === 'lead' ? 'Lead' : 'Sidekick';
    const query = roleSearch[role].trim().toLocaleLowerCase();
    const list = state.roleLists?.[role] || [];
    const rows = list.filter(item => !query || item.label.toLocaleLowerCase().includes(query));
    container.replaceChildren();
    const row = item => element('div', { class: 'row' },
      element('div', { class: 'row-main' }, element('span', { class: 'row-title', text: item.label }),
        item.native ? element('span', { class: 'row-sub', text: '官方' }) : null),
      item.available ? switchInput(item.selected === true, '在 ' + name + ' 中启用 ' + item.label,
        value => run(() => request('setRoleModel', { role, model: item.ref, enabled: value })), off())
        : element('span', { class: 'hint', text: item.reason || '不可用' }));
    const main = query ? rows : rows.filter(item => !item.native || item.defaultSelected || item.selected || item.explicitIncluded);
    const extra = query ? [] : rows.filter(item => item.native && !item.defaultSelected && !item.selected && !item.explicitIncluded);
    for (const item of main) container.append(row(item));
    if (extra.length) {
      const details = element('details', { class: 'fold', open: roleMoreOpen[role] }, element('summary', { text: '更多官方模型（' + extra.length + '）' }));
      details.addEventListener('toggle', () => { roleMoreOpen[role] = details.open; });
      for (const item of extra) details.append(row(item));
      container.append(details);
    }
    if (!rows.length) container.append(element('div', { class: 'empty', text: list.length ? '没有匹配的模型。' : '暂无可选模型。' }));
  }

  function renderCache() {
    const report = state.cliCache;
    const hint = byId('cache-hint'), detail = byId('cache-report');
    hint.textContent = report && report.at ? '最近 ' + new Date(report.at).toLocaleTimeString('zh-CN', { hour12: false }) : '';
    detail.replaceChildren();
    if (!report) { detail.append(document.createTextNode('还没有记录，点一次「刷新缓存」即可。')); return; }
    const parts = [];
    if (report.refreshed?.length) parts.push('已重写 ' + report.refreshed.map(name => name.split('.')[0]).join('、'));
    for (const skip of report.skipped || []) parts.push(skip.name.split('.')[0] + ' 无需重写（' + skip.reason + '）');
    for (const error of report.errors || []) parts.push(error.name.split('.')[0] + ' 写入失败（' + error.code + '）');
    if (!report.checked) parts.push('没有找到本插件写入的缓存文件');
    else if (!parts.length) parts.push('检查了 ' + report.checked + ' 个文件，内容已是最新');
    detail.append(document.createTextNode(parts.join('；')));
  }

  function renderNative() {
    const container = byId('native-models');
    container.replaceChildren();
    const all = state.nativeFamilies || [];
    const visible = all.filter(family => !family.hidden && !family.internal).length;
    const hiddenCount = all.filter(family => family.hidden).length;
    const internalCount = all.filter(family => family.internal).length;
    byId('native-count').textContent = all.length
      ? visible + ' / ' + all.length + ' 个系列' + (hiddenCount ? ' · 已隐藏 ' + hiddenCount : '') + (internalCount ? ' · 内部 ' + internalCount : '') : '';
    const search = element('input', { type: 'search', placeholder: '搜索官方模型', 'aria-label': '搜索官方模型',
      oninput: event => { nativeSearch = event.target.value; renderNativeRows(); } });
    search.value = nativeSearch;
    focusTargets.set('native-search', search);
    const list = element('div', { id: 'native-list', class: 'list scroll', 'aria-label': '官方模型列表' });
    scrollTargets.set('native-list', list);
    container.append(element('p', { class: 'hint mb', text: '停用的系列会从 Devin 模型列表隐藏，也不再出现在「Fusion」页候选中；仅本机生效，不影响账号。' }),
      element('div', { class: 'toolbar' }, search, button('刷新', () => run(() => request('refreshNativeModels'), '正在同步官方模型…', '已同步。'))),
      list);
    renderNativeRows();
  }

  function renderNativeRows() {
    const container = byId('native-list');
    if (!container) return;
    container.replaceChildren();
    const all = state.nativeFamilies || [];
    const query = nativeSearch.trim().toLocaleLowerCase();
    const families = all.filter(family => !query ||
      (family.label + ' ' + (family.vendor || '') + ' ' + family.members.map(member => member.uid + ' ' + member.label).join(' ')).toLocaleLowerCase().includes(query));
    if (!families.length) {
      container.append(element('div', { class: 'empty', text: all.length ? '没有匹配的模型。' : ({ loading: '正在同步官方模型…', unsupported: '当前后台版本暂不支持同步。', unavailable: '无法连接插件本地服务，请点刷新重试。', empty: '还没收到官方模型，打开一次 Devin 的模型选择器后再刷新。' }[state.nativeCatalogStatus] || '还没收到官方模型，请点刷新重试。') }));
      return;
    }
    function nativeRow(family) {
      const sub = family.variants > 1 ? [family.variants + ' 个变体'] : [];
      if (family.efforts.length) sub.push('Effort ' + family.efforts.join(' / '));
      if (family.toggles.length) sub.push(...family.toggles);
      if (!family.members.some(member => member.eligible)) sub.push('不可用作 Fusion Lead/Sidekick');
      return element('div', { class: 'row' },
        element('div', { class: 'row-main' }, element('span', { class: 'row-title', text: family.label }),
          element('span', { class: 'row-sub', text: sub.join(' · ') })),
        switchInput(!family.hidden, family.variants > 1 ? '在列表中显示 ' + family.label + ' 的 ' + family.variants + ' 个变体' : '在列表中显示 ' + family.label,
          show => run(() => request('setNativeModelHidden', { uids: family.members.map(member => member.uid), hidden: !show })), off() || family.internal === true));
    }
    const groups = new Map();
    for (const family of families) {
      if (family.internal) continue;
      const vendor = family.vendor || '其他';
      if (!groups.has(vendor)) groups.set(vendor, []);
      groups.get(vendor).push(family);
    }
    for (const [vendor, group] of groups) {
      container.append(element('div', { class: 'vendor-head', text: vendor + ' · ' + group.length + ' 个系列' }));
      for (const family of group) container.append(nativeRow(family));
    }
    // Retired leftovers, review/check rows and router cards (Adaptive/Fusion
    // render in the picker but are routing surfaces, not models) are folded
    // into a collapsed internal section under the picker groups.
    const internal = families.filter(family => family.internal);
    if (internal.length) {
      const details = element('details', { class: 'fold', open: !!query },
        element('summary', { text: '内部条目 · ' + internal.length + ' · 退役与路由/内部用途' }));
      for (const family of internal) details.append(nativeRow(family));
      container.append(details);
    }
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

  function importDialog(providerId) {
    const candidates = state.importCandidates;
    if (!candidates || candidates.providerId !== providerId) throw new Error('模型列表已失效，请重新获取。');
    const { dialog, form } = openDialog('导入模型');
    form.classList.add('import-picker');
    const selected = new Set();
    const search = input('', { type: 'search', placeholder: '搜索模型', 'aria-label': '搜索可导入的模型' });
    const list = element('div', { class: 'list scroll', 'aria-label': '可导入的模型列表' });
    const count = element('span', { class: 'hint', role: 'status' });
    let submit;
    const visible = () => {
      const query = search.value.trim().toLocaleLowerCase();
      return candidates.models.filter(model => (model.id + ' ' + model.label).toLocaleLowerCase().includes(query));
    };
    const updateCount = () => {
      count.textContent = '已选 ' + selected.size + ' / 共 ' + candidates.models.length;
      if (submit) submit.disabled = selected.size === 0;
    };
    const renderRows = () => {
      list.replaceChildren();
      for (const model of visible()) {
        const checkbox = element('input', { type: 'checkbox', checked: model.imported || selected.has(model.id), disabled: model.imported,
          onchange: event => { if (event.target.checked) selected.add(model.id); else selected.delete(model.id); updateCount(); } });
        list.append(element('label', { class: 'row' }, checkbox,
          element('span', { class: 'row-main' }, element('span', { class: 'row-title', text: model.label }),
            model.label !== model.id ? element('span', { class: 'row-sub mono', text: model.id }) : null),
          model.imported ? element('span', { class: 'hint', text: '已导入' }) : null));
      }
      if (!list.childElementCount) list.append(element('p', { class: 'empty', text: candidates.models.length ? '没有匹配的模型。' : '供应商没有返回模型。' }));
      updateCount();
    };
    search.addEventListener('input', renderRows);
    form.append(element('div', { class: 'toolbar' }, search),
      element('div', { class: 'toolbar' }, button('全选', () => {
        for (const model of visible()) if (!model.imported) selected.add(model.id);
        renderRows();
      }, 'quiet'), button('清空', () => { selected.clear(); renderRows(); }, 'quiet'), element('span', { class: 'spacer' }), count), list);
    submit = finishDialog(dialog, form, '导入', () => request('importModels', { providerId, token: candidates.token, ids: [...selected] }), null, '已导入。');
    renderRows();
  }

  function providerDialog(provider) {
    const { dialog, form } = openDialog(provider ? '编辑供应商' : '添加供应商');
    const name = input(provider?.name, { required: true, maxlength: 80, placeholder: '例如：OpenRouter' });
    const baseUrl = input(provider?.baseUrl, { type: 'url', required: true, placeholder: 'https://example.com/v1', spellcheck: 'false' });
    const apiFormat = element('select', { 'aria-label': 'API 类型' },
      element('option', { value: 'openai-responses', text: 'OpenAI Responses' }),
      element('option', { value: 'openai', text: 'OpenAI Chat Completions' }),
      element('option', { value: 'anthropic', text: 'Anthropic Messages' }));
    apiFormat.value = provider?.apiFormat || 'openai-responses';
    const apiKey = input('', { type: 'password', autocomplete: 'new-password', placeholder: provider?.keyConfigured ? '留空则不修改' : '', spellcheck: 'false' });
    const urlField = field('API 地址', baseUrl, '只填域名时会自动补上 /v1；地址里已写了 /v1（或 /v4、/v1beta 等版本号）就按原样使用。');
    const urlPreview = element('span', { class: 'hint url-preview' });
    urlField.append(urlPreview);
    const refreshPreview = () => {
      let url;
      try { url = new URL(baseUrl.value.trim()); } catch { url = null; }
      urlPreview.replaceChildren();
      if (!url || !['http:', 'https:'].includes(url.protocol)) return;
      const base = url.origin + normalizeBaseUrlPath(url.pathname);
      const path = { openai: '/chat/completions', anthropic: '/messages' }[apiFormat.value] || '/responses';
      urlPreview.append('实际请求：' + base + path, element('br'), '获取模型：' + base + '/models');
    };
    baseUrl.addEventListener('input', refreshPreview);
    apiFormat.addEventListener('change', refreshPreview);
    refreshPreview();
    form.append(field('名称', name), urlField, field('API 类型', apiFormat), field('API 密钥', apiKey));
    const remove = provider ? deleteButton(dialog, '删除供应商？', '会一并移除“' + provider.name + '”导入的模型；用到它们的 Fusion 组合会失效。',
      () => request('deleteProvider', { id: provider.id })) : null;
    finishDialog(dialog, form, '保存', () => {
      const payload = { name: name.value.trim(), baseUrl: baseUrl.value.trim(), apiFormat: apiFormat.value };
      if (provider) payload.id = provider.id;
      if (apiKey.value.trim()) payload.apiKey = apiKey.value.trim();
      return request('saveProvider', payload);
    }, remove);
  }

  function modelDialog(provider, model) {
    const { dialog, form } = openDialog(model ? '编辑模型' : '手动添加模型');
    const id = input(model?.id, { required: true, readOnly: Boolean(model), maxlength: 256, placeholder: '供应商的模型 ID', spellcheck: 'false' });
    const label = input(model?.label || '', { maxlength: 160, placeholder: '留空使用模型 ID' });
    const contextWindow = input(model?.contextWindow || 272000, { type: 'number', min: 1, step: 1, required: true });
    const maxOutputTokens = input(model?.maxOutputTokens || 131072, { type: 'number', min: 1, step: 1, required: true });
    const efforts = input((model?.efforts || []).join(', '), { placeholder: 'low, medium, high', spellcheck: 'false' });
    const effortMode = element('select', { 'aria-label': '思考档位' },
      element('option', { value: 'auto', text: '自动' }),
      element('option', { value: 'manual', text: '手动填写' }),
      element('option', { value: 'none', text: '不指定' }));
    effortMode.value = model?.effortMode || (model?.efforts?.length ? 'manual' : 'auto');
    const manual = field('档位列表', efforts, '用逗号分隔。');
    manual.hidden = effortMode.value !== 'manual';
    effortMode.addEventListener('change', () => { manual.hidden = effortMode.value !== 'manual'; });
    form.append(field('模型 ID', id), field('显示名称', label),
      element('details', { class: 'fold', open: effortMode.value === 'manual' }, element('summary', { text: '高级' }),
        element('div', { class: 'field-grid' }, field('上下文（tokens）', contextWindow), field('最大输出（tokens）', maxOutputTokens)),
        field('思考档位', effortMode, '自动：GPT/o 系列与较新的 Claude Opus/Sonnet 提供 Low、Medium、High、XHigh、Max，能否生效取决于供应商。'), manual));
    const remove = model ? deleteButton(dialog, '删除模型？', '从“' + provider.name + '”移除“' + (model.label || model.id) + '”，之后可以重新导入。',
      () => request('updateModels', { providerId: provider.id, changes: [], removeIds: [model.id] })) : null;
    finishDialog(dialog, form, model ? '保存' : '添加', () => {
      const saved = { id: id.value.trim(), label: label.value.trim() || id.value.trim(),
        contextWindow: Number(contextWindow.value), maxOutputTokens: Number(maxOutputTokens.value), effortMode: effortMode.value,
        efforts: effortMode.value === 'auto' ? [] : [...new Set(efforts.value.split(/[,，\s]+/).map(value => value.trim()).filter(Boolean))] };
      if (model) return request('updateModels', { providerId: provider.id, changes: [{ ...saved, supportsImages: true }] });
      return request('addModel', { providerId: provider.id, model: { ...saved, enabled: true } });
    }, remove);
  }

  for (const node of document.querySelectorAll('.tab')) node.addEventListener('click', () => showTab(node.dataset.tab));
  byId('add-provider').addEventListener('click', () => providerDialog());
  const setEnabled = value => run(() => request('setEnabled', { enabled: value }), value ? '正在启用…' : '正在停用…', value ? '已启用。' : '已停用。');
  byId('plugin-enabled').addEventListener('change', event => {
    const value = event.target.checked;
    setEnabled(value).then(ok => { if (!ok) event.target.checked = !value; });
  });
  byId('enable-now').addEventListener('click', () => setEnabled(true));
  byId('refresh-cache').addEventListener('click', () => run(() => request('refreshCliCaches'), '正在刷新缓存…', '缓存已检查。'));
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
  showTab(tab);
  request('ready').catch(error => notice(error.message, 'error'));
}

module.exports = { renderPanel };

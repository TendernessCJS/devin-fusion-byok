'use strict';
const { modelEfforts } = require('../models/capabilities.cjs');
const { normalizeBaseUrlPath } = require('./base-url.cjs');
const { monitorMarkup, monitorScript } = require('./monitor-view.cjs');
const { updateScript } = require('./update-view.cjs');
const { fastContextMarkup, fastContextScript, fastContextStyles } = require('./fast-context-view.cjs');
const { pageMarkup: modelsMarkup, createModelsView } = require('./models-view.cjs');
const { pageMarkup: fusionMarkup, createFusionView } = require('./fusion-view.cjs');
const { pageMarkup: settingsMarkup, createSettingsView } = require('./settings-view.cjs');
const { panelClient } = require('./client.cjs');
const { baseStyles } = require('./theme.cjs');
const { escapeAttribute, domHelpersSource, markupText } = require('./dom.cjs');
const { translator, browserSource } = require('../i18n/index.cjs');

const TABS = ['models', 'fusion', 'usage', 'goal', 'fastcontext', 'settings'];

function goalMarkup(t) {
  const h = markupText(t);
  const code = text => `<code class="cmd">${escapeAttribute(text)}</code>`;
  const rows = [
    [t('goalDoc.cmd.start'), 'goalDoc.cmd.startHelp'],
    ['/goal', 'goalDoc.cmd.statusHelp'],
    ['/goal pause', 'goalDoc.cmd.pauseHelp'],
    ['/goal resume', 'goalDoc.cmd.resumeHelp'],
    ['/goal clear', 'goalDoc.cmd.clearHelp']
  ].map(([command, key]) => `<div class="row"><div class="row-main"><span class="row-title">${code(command)}</span><span class="row-sub">${h(key)}</span></div></div>`).join('');
  return `<div class="goal-doc">
      <div class="section-head"><h2>${h('goalDoc.title')}</h2><div class="actions"><button id="open-goal" class="secondary" type="button">${h('goalDoc.openProgress')}</button><label class="toggle"><span class="muted" id="goal-enabled-label">${h('goalDoc.switchOff')}</span><input id="goal-enabled" class="switch" type="checkbox" role="switch" aria-label="${h('goalDoc.switchAria')}" disabled></label></div></div>
      <p>${h('goalDoc.intro', { command: '<code class="cmd">/goal</code>' })}</p>
      <h3 class="mt">${h('goalDoc.commands')}</h3>
      <div class="list">${rows}</div>
      <h3 class="mt">${h('goalDoc.writingTitle')}</h3>
      <p>${h('goalDoc.writingBody', { example: code(t('goalDoc.writingExample')) })}</p>
      <h3 class="mt">${h('goalDoc.runTitle')}</h3>
      <ul>
        <li>${h('goalDoc.run1')}</li>
        <li>${h('goalDoc.run2')}</li>
        <li>${h('goalDoc.run3')}</li>
        <li>${h('goalDoc.run4', { resume: code('/goal resume') })}</li>
      </ul>
      <h3 class="mt">${h('goalDoc.notesTitle')}</h3>
      <ul>
        <li>${h('goalDoc.note1', { status: code('/goal'), pause: code('/goal pause') })}</li>
        <li>${h('goalDoc.note2')}</li>
      </ul>
    </div>`;
}


// locale defaults to zh-CN, the original copy: a caller that passes none
// (the existing tests, any older wiring) renders exactly what it did before.
function renderPanel({ nonce, locale = 'zh-CN' }) {
  const t = translator(locale);
  const safeNonce = escapeAttribute(nonce);
  return `<!doctype html>
<html lang="${escapeAttribute(t.locale)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${safeNonce}'; script-src 'nonce-${safeNonce}'; img-src 'none'; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none';">
  <title>Fusion BYOK</title>
  <style nonce="${safeNonce}">${baseStyles()}${panelStyles()}${fastContextStyles()}</style>
</head>
${panelMarkup(t)}
  <script nonce="${safeNonce}">${panelScript(t.locale)}</script>
</body>
</html>`;
}

function panelStyles() {
  return `
    :root { color-scheme: light dark; }
    body { --page-top: 0; }
    main { max-width: 960px; margin: 0 auto; }
    .topbar { position: sticky; top: 0; z-index: 5; background: var(--bg); border-bottom: 1px solid var(--border); margin: 0 calc(-1 * var(--page-x)) 20px; padding: 14px var(--page-x) 0; }
    .topbar-row .actions { gap: 14px; }
    .topbar-row { max-width: 960px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .tabs { max-width: 960px; margin: 10px auto 0; display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; }
    .tab { flex: none; }
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
    .filter-pills { display: inline-flex; flex-wrap: wrap; gap: 4px; }
    button.pill { min-height: 24px; padding: 2px 10px; font-size: 12px; border-radius: 12px; color: var(--muted); background: transparent; border: 1px solid var(--border); }
    button.pill:hover { color: var(--vscode-foreground, #ddd); background: var(--hover); }
    button.pill.active { color: var(--vscode-button-foreground, #fff); background: var(--accent); border-color: var(--accent); }
    .models-layout { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 16px; align-items: start; }
    .provider-nav { display: grid; gap: 2px; }
    .provider-item { display: flex; align-items: center; gap: 4px; border-radius: var(--radius-control); }
    button.provider-select { flex: 1; min-width: 0; display: block; text-align: left; padding: 8px 10px; white-space: normal; color: inherit; background: transparent; border-color: transparent; }
    .provider-item:hover { background: var(--hover); }
    .provider-item.selected { background: var(--vscode-list-inactiveSelectionBackground, #37373d); }
    .order-move { display: flex; flex-direction: column; }
    .order-move button { min-height: 0; padding: 0 5px; line-height: 1.1; font-size: 11px; color: var(--muted); background: transparent; border-color: transparent; }
    .order-move button:hover { background: var(--hover); }
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
    .list-head { padding: 12px 14px; font-weight: 600; border-bottom: 1px solid var(--border); }
    .list-note { margin: 0; padding: 10px 14px; border-top: 1px solid var(--border); }
    #settings-general > .hint + .hint { margin-top: 4px; }
    .cache-toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
    #cache-report { margin: 0; line-height: 1.6; }
    #cache-report:empty { display: none; }
    .toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 20; max-width: min(560px, calc(100vw - 32px)); display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-radius: var(--radius-container); border: 1px solid var(--border); background: var(--vscode-editorWidget-background, #252526); box-shadow: 0 4px 16px var(--vscode-widget-shadow, #0006); }
    .toast[data-tone="error"] { border-color: var(--vscode-inputValidation-errorBorder, #be1100); color: var(--error); }
    .toast[data-tone="success"] { color: var(--ok); }
    .toast button.quiet { color: inherit; padding: 0 2px; font-size: 14px; line-height: 1; }
    .toast button.quiet:hover { background: transparent; opacity: .7; }
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
      .provider-nav .order-move { flex-direction: row; }
      .provider-nav .move-glyph { display: inline-block; transform: rotate(-90deg); }
      .field-grid { grid-template-columns: 1fr; gap: 0; }
    }
  `;
}

function panelMarkup(t) {
  const h = markupText(t);
  const tabs = TABS.map((id, index) => `<button id="tab-${id}" class="tab" type="button" role="tab" aria-controls="view-${id}" aria-selected="${index === 0}" data-tab="${id}">${h('panel.tab.' + id)}</button>`).join('');
  return `<body>
  <main id="main" aria-busy="true">
    <header class="topbar">
      <div class="topbar-row"><h1>Fusion BYOK</h1><div class="actions"><button id="reload-window" class="secondary" type="button" title="${h('panel.reload.title')}">${h('panel.reload')}</button><button id="restart-devin" class="secondary" type="button" title="${h('panel.restart.title')}">${h('panel.restart')}</button><label class="toggle"><span class="muted">${h('panel.enabled')}</span><input id="plugin-enabled" class="switch" type="checkbox" role="switch" aria-label="${h('panel.enabledAria')}" disabled></label></div></div>
      <nav class="tabs" role="tablist" aria-label="${h('panel.tabsAria')}">${tabs}</nav>
    </header>
    <div id="disabled-banner" class="banner" hidden><span>${h('panel.disabledBanner')}</span><button id="enable-now" type="button">${h('panel.enableNow')}</button></div>
    <section id="view-models" role="tabpanel" aria-labelledby="tab-models">${modelsMarkup(t)}</section>
    <section id="view-fusion" role="tabpanel" aria-labelledby="tab-fusion" hidden>${fusionMarkup(t)}</section>
    <section id="view-usage" role="tabpanel" aria-labelledby="tab-usage" hidden>${monitorMarkup(t)}</section>
    <section id="view-goal" role="tabpanel" aria-labelledby="tab-goal" hidden>${goalMarkup(t)}</section>
    <section id="view-fastcontext" role="tabpanel" aria-labelledby="tab-fastcontext" hidden>${fastContextMarkup(t)}</section>
    <section id="view-settings" role="tabpanel" aria-labelledby="tab-settings" hidden>${settingsMarkup(t)}</section>
  </main>
  <div id="status" class="toast" role="status" aria-live="polite" hidden></div>
  <dialog id="editor-dialog" aria-labelledby="dialog-title"></dialog>`;
}

function panelScript(locale) {
  // The i18n prelude sits beside the dom helpers at the top level of the one
  // <script>, so every serialized view below resolves t() from that scope.
  return `${domHelpersSource()}${browserSource(locale, ['common.', 'client.', 'goalDoc.', 'models.', 'fusion.', 'settings.'])}const vscode = acquireVsCodeApi(); (${panelClient.toString()})(${createModelsView.toString()}, ${createFusionView.toString()}, ${createSettingsView.toString()}, vscode, ${normalizeBaseUrlPath.toString()}, ${modelEfforts.toString()}); ${monitorScript(locale)} ${updateScript(locale)} ${fastContextScript(locale)}`;
}


module.exports = { renderPanel };

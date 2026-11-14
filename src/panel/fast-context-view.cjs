'use strict';
const { domHelpersSource, markupText } = require('./dom.cjs');
const { translator, browserSource } = require('../i18n/index.cjs');
const CAPABILITIES = [['code', 'code_search'], ['web', 'web_search'], ['read', 'web_read_url']];
const FORMATS = ['prompt', 'json'];

function fastContextStyles() {
  return `
    .fc { max-width: 820px; }
    .fc-lead { color: var(--muted); margin-bottom: 18px; }
    .fc-caps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .fc-cap { border: 1px solid var(--border); border-radius: 6px; padding: 12px 14px; min-width: 0; }
    .fc-cap-head { display: flex; align-items: center; gap: 8px; }
    .fc-cap-name { font-weight: 600; }
    .fc-cap code { margin-left: auto; }
    .fc-cap p { color: var(--muted); font-size: 12px; margin-top: 6px; }
    .fc-state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; margin-top: 8px; color: var(--muted); }
    .fc-state::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--border); flex: none; }
    .fc-state[data-state="yes"] { color: var(--ok); }
    .fc-state[data-state="yes"]::before { background: var(--ok); }
    .fc-state[data-state="no"] { color: var(--warn); }
    .fc-state[data-state="no"]::before { background: var(--warn); }
    .fc-checkline { display: flex; align-items: center; gap: 10px; margin-top: 8px; min-height: 20px; }
    .fc-step { margin-top: 26px; }
    .fc-step.locked .fc-body { opacity: .45; pointer-events: none; }
    .fc-switch { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 6px; }
    .fc-pill { font-size: 11px; padding: 1px 8px; border-radius: 9px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
    .fc-pill[data-on="true"] { color: var(--ok); border-color: var(--ok); }
    .fc-step-title { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .fc-step-title h3 { margin: 0; font-size: 14px; line-height: 20px; }
    .fc-num { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; font-size: 11px; font-weight: 600; line-height: 1; color: var(--vscode-button-foreground, #fff); background: var(--accent); flex: none; }
    .fc-root { display: flex; gap: 8px; }
    .fc-root select { flex: 1; min-width: 0; }
    .fc-seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--border); border-radius: 6px; padding: 2px; gap: 2px; }
    .fc-seg button { color: var(--muted); background: transparent; border-color: transparent; min-height: 26px; padding: 2px 12px; }
    .fc-seg button:hover { color: var(--vscode-foreground, #ddd); background: var(--hover); }
    .fc-seg button[aria-pressed="true"] { color: var(--vscode-foreground, #ddd); background: var(--vscode-list-inactiveSelectionBackground, #37373d); }
    .fc-format-hint { margin: 8px 0; }
    .fc-code { position: relative; }
    .fc-code pre { padding-right: 88px; }
    .fc-code button { position: absolute; top: 8px; right: 8px; }
    .fc-notes { margin-top: 26px; }
    .fc-notes ul { padding-left: 20px; margin: 4px 14px 12px; }
    .fc-notes li { margin: 4px 0; color: var(--muted); }
    @media (max-width: 700px) { .fc-caps { grid-template-columns: 1fr; } .fc-root { flex-direction: column; } }`;
}

function fastContextMarkup(t = translator()) {
  const h = markupText(t);
  const caps = CAPABILITIES.map(([id, tool]) => `<div class="fc-cap">
          <div class="fc-cap-head"><span class="fc-cap-name">${h('fc.cap.' + id)}</span><code class="cmd">${tool}</code></div>
          <p>${h('fc.cap.' + id + '.help')}</p>
          <span class="fc-state" id="fc-cap-${id}" data-state="unknown">${h('fc.unchecked')}</span>
        </div>`).join('');
  const formats = FORMATS.map((id, index) => `<button type="button" data-format="${id}" aria-pressed="${index === 0}">${h('fc.format.' + id)}</button>`).join('');
  return `<div id="fast-context" class="fc">
      <div class="section-head"><h2>${h('fc.title')}</h2><span id="fc-pill" class="fc-pill" data-on="false">${h('fc.off')}</span></div>
      <p class="fc-lead">${h('fc.lead')}</p>

      <div class="fc-step">
        <div class="fc-step-title"><span class="fc-num">1</span><h3>${h('fc.step1')}</h3><span class="spacer"></span><button id="fc-check" class="secondary" type="button">${h('fc.check')}</button></div>
        <div class="fc-caps">${caps}</div>
        <div class="fc-checkline"><span id="fc-check-result" class="hint" role="status" aria-live="polite">${h('fc.checkPrivacy')}</span></div>
      </div>

      <div class="fc-step locked" id="fc-step-enable">
        <div class="fc-step-title"><span class="fc-num">2</span><h3>${h('fc.step2')}</h3></div>
        <div class="fc-switch">
          <div class="row-main"><span class="row-title">${h('fc.allow')}</span><span class="row-sub" id="fc-enable-hint">${h('fc.enableLocked')}</span></div>
          <input id="fc-enabled" class="switch" type="checkbox" role="switch" aria-label="${h('fc.step2')}" disabled>
        </div>
      </div>

      <div class="fc-step locked" id="fc-step-connect">
        <div class="fc-step-title"><span class="fc-num">3</span><h3>${h('fc.step3')}</h3></div>
        <div class="fc-body">
          <div class="fc-root"><select id="fc-root" aria-label="${h('fc.rootAria')}"></select><button id="fc-pick" class="secondary" type="button">${h('fc.pick')}</button></div>
          <p class="hint mt">${h('fc.rootHint')}</p>
          <p id="fc-status" class="warn" role="status"></p>
          <div class="fc-seg mt" role="group" aria-label="${h('fc.formatAria')}">${formats}</div>
          <p id="fc-format-hint" class="hint fc-format-hint"></p>
          <div class="fc-code"><pre id="fc-preview" class="code-block" tabindex="0"></pre><button id="fc-copy" type="button">${h('fc.copy')}</button></div>
          <p id="fc-result" class="hint mt" role="status" aria-live="polite"></p>
        </div>
      </div>

      <details class="group fc-notes"><summary>${h('fc.notes')}</summary>
        <ul>
          <li>${h('fc.note1')}</li>
          <li>${h('fc.note2')}</li>
          <li>${h('fc.note3')}</li>
          <li>${h('fc.note4')}</li>
          <li>${h('fc.note5')}</li>
        </ul>
      </details>
    </div>`;
}

function fastContextScript(locale) {
  return `
  (() => {
    ${domHelpersSource('    ')}
    ${browserSource(locale, ['common.', 'fc.'])}
    const FORMAT_HINTS = Object.fromEntries(${JSON.stringify(FORMATS)}.map(id => [id, t('fc.format.' + id + '.hint')]));
    let snapshot = null, format = 'prompt', previewKey = '', enableError = '';
    const selected = () => byId('root', 'fc-').value;
    const send = (type, payload) => vscode.postMessage({ id: 'fc-' + Date.now(), type: 'fastContext.' + type, payload });
    function setCap(id, value, yes, no) {
      const node = byId('cap-' + id, 'fc-');
      node.dataset.state = value === true ? 'yes' : value === false ? 'no' : 'unknown';
      node.textContent = value === true ? yes : value === false ? no : t('fc.unchecked');
    }
    function renderCheck(check) {
      const caps = check?.capabilities || {};
      setCap('code', caps.code, t('fc.capYes'), t('fc.capNo'));
      setCap('web', caps.web, t('fc.capYes'), t('fc.capOff'));
      setCap('read', caps.web, t('fc.capYes'), t('fc.capOff'));
      if (check?.at) byId('check', 'fc-').title = t('fc.lastCheck', { time: new Date(check.at).toLocaleString() });
    }
    function requestPreview() {
      const root = selected();
      byId('format-hint', 'fc-').textContent = FORMAT_HINTS[format] || '';
      if (!snapshot?.enabled) { byId('preview', 'fc-').textContent = t('fc.previewOff'); byId('copy', 'fc-').disabled = true; return; }
      if (!root) { byId('preview', 'fc-').textContent = t('fc.previewNoRoot'); byId('copy', 'fc-').disabled = true; return; }
      previewKey = format + '\\n' + root;
      send('preview', { kind: format, root });
    }
    function renderSwitch() {
      const on = Boolean(snapshot?.enabled);
      const eligible = snapshot?.check?.capabilities?.code === true;
      byId('enabled', 'fc-').checked = on;
      byId('enabled', 'fc-').disabled = !on && !eligible;
      byId('step-enable', 'fc-').classList.toggle('locked', !on && !eligible);
      byId('step-connect', 'fc-').classList.toggle('locked', !on);
      byId('pill', 'fc-').dataset.on = String(on);
      byId('pill', 'fc-').textContent = on ? t('fc.on') : t('fc.off');
      byId('enable-hint', 'fc-').className = enableError ? 'row-sub warn' : 'row-sub';
      byId('enable-hint', 'fc-').textContent = enableError || (on ? t('fc.enabledHint')
        : eligible ? t('fc.eligibleHint') : t('fc.enableLocked'));
    }
    function render(keep) {
      renderSwitch();
      const select = byId('root', 'fc-');
      const previous = keep || select.value;
      select.replaceChildren();
      for (const root of snapshot.roots) {
        const option = document.createElement('option');
        option.value = root.path; option.textContent = root.name + ' · ' + root.path;
        select.append(option);
      }
      if (snapshot.roots.some(root => root.path === previous)) select.value = previous;
      const empty = !snapshot.roots.length;
      byId('copy', 'fc-').disabled = empty || !snapshot.trusted || !snapshot.enabled;
      const warnings = [];
      if (!snapshot.trusted) warnings.push(t('fc.warnUntrusted'));
      if (empty) warnings.push(t('fc.warnNoRoot'));
      if (!snapshot.nodeFound) warnings.push(t('fc.warnNoNode'));
      byId('status', 'fc-').textContent = warnings.join(' ');
      requestPreview();
    }
    for (const button of document.querySelectorAll('.fc-seg [data-format]')) {
      button.addEventListener('click', () => {
        format = button.dataset.format;
        for (const other of document.querySelectorAll('.fc-seg [data-format]')) other.setAttribute('aria-pressed', String(other === button));
        byId('result', 'fc-').textContent = '';
        requestPreview();
      });
    }
    byId('enabled', 'fc-').addEventListener('change', () => {
      const on = byId('enabled', 'fc-').checked;
      byId('enabled', 'fc-').disabled = true;
      enableError = '';
      send('enable', { enabled: on });
    });
    byId('root', 'fc-').addEventListener('change', requestPreview);
    byId('pick', 'fc-').addEventListener('click', () => send('pick'));
    byId('copy', 'fc-').addEventListener('click', () => send('copy', { kind: format, root: selected() }));
    byId('check', 'fc-').addEventListener('click', () => {
      byId('check', 'fc-').disabled = true;
      byId('check', 'fc-').textContent = t('fc.checking');
      byId('check-result', 'fc-').className = 'hint';
      byId('check-result', 'fc-').textContent = t('fc.checkingDetail');
      send('check');
    });
    window.addEventListener('message', event => {
      const message = event.data;
      if (message?.type === 'fast-context-preview') {
        if (message.kind + '\\n' + message.root !== previewKey) return;
        byId('preview', 'fc-').textContent = message.error || message.text || '';
        byId('copy', 'fc-').disabled = Boolean(message.error) || !snapshot?.trusted || !snapshot?.enabled;
        return;
      }
      if (message?.type === 'fast-context-result') {
        if (message.enable) { enableError = message.text || ''; return; }
        const result = byId(message.check ? 'check-result' : 'result', 'fc-');
        result.textContent = message.text || '';
        result.className = message.ok ? 'hint' : 'warn';
        if (message.check) { byId('check', 'fc-').disabled = false; byId('check', 'fc-').textContent = t('fc.recheck'); }
        return;
      }
      if (message?.type !== 'fast-context-state' || !message.state) return;
      snapshot = message.state;
      render(message.selected);
      renderCheck(snapshot.check);
    });
    send('state');
  })();`;
}
module.exports = { fastContextMarkup, fastContextScript, fastContextStyles };

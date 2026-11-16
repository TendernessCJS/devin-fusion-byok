'use strict';
const { domHelpersSource, markupText } = require('./dom.cjs');
const { translator, browserSource } = require('../i18n/index.cjs');
function updateMarkup(t = translator()) {
  const h = markupText(t);
  return `<div class="list mt"><div class="setting"><div class="row-main"><span class="row-title">${h('update.title')}</span><span id="update-status" class="row-sub" role="status">${h('update.notChecked')}</span></div><div class="actions"><button id="update-install" type="button" hidden>${h('update.install')}</button><button id="update-ignore" class="quiet" type="button" hidden>${h('update.ignore')}</button><button id="update-check" class="secondary" type="button">${h('update.check')}</button></div></div><div class="setting"><label class="toggle"><input id="update-auto" type="checkbox">${h('update.auto')}</label><button id="update-release" class="quiet" type="button">${h('update.release')}</button></div><div class="setting"><div class="row-main"><span class="row-title">${h('update.proxy')}</span><span class="row-sub">${h('update.proxyHint')}</span></div><div class="actions nowrap"><input id="update-proxy" type="text" placeholder="http://127.0.0.1:7897" autocomplete="off" spellcheck="false"><button id="update-proxy-save" class="secondary" type="button">${h('common.save')}</button></div></div><pre id="update-notes" class="update-notes setting" hidden></pre></div>`;
}
function updateScript(locale) {
  return `(() => {
    ${domHelpersSource('    ')}
    ${browserSource(locale, ['common.', 'update.'])}
    const send = (action, payload) => vscode.postMessage({ id: 'update-' + action, type: 'update.' + action, payload });
    for (const action of ['check','install','ignore','release']) byId(action, 'update-').addEventListener('click', () => send(action));
    byId('auto', 'update-').addEventListener('change', () => send('auto', { enabled: byId('auto', 'update-').checked }));
    byId('proxy-save', 'update-').addEventListener('click', () => send('proxy', { value: byId('proxy', 'update-').value.trim() }));
    byId('proxy', 'update-').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); byId('proxy-save', 'update-').click(); } });
    window.addEventListener('message', event => {
      if (event.data?.type !== 'update-state') return;
      const s = event.data.state;
      const labels = { idle:'', checking:t('update.phase.checking'), error:t('update.phase.error'), available:t('update.phase.available', { version: s.latestVersion || '' }), ahead:t('update.phase.ahead'), current:t('update.phase.current'), installing:t('update.phase.installing'), installed:t('update.phase.installed') };
      // s.error is copy produced by src/update/updater.cjs, which this change leaves untouched.
      byId('status', 'update-').textContent = t('update.current', { version: s.currentVersion }) + (labels[s.phase] ? ' · ' + labels[s.phase] : '') + (s.ignored ? t('update.ignored') : '') + (s.error ? ' · ' + s.error : '');
      const notes = s.phase === 'available' ? (s.notes || '') + (!s.canInstall ? '\\n' + t('update.manualInstall') : '') : '';
      byId('notes', 'update-').textContent = notes.trim();
      byId('notes', 'update-').hidden = !notes.trim();
      byId('auto', 'update-').checked = s.autoCheck;
      if (document.activeElement !== byId('proxy', 'update-')) byId('proxy', 'update-').value = s.proxy || '';
      byId('install', 'update-').hidden = !s.canInstall;
      byId('install', 'update-').disabled = !s.canInstall;
      byId('ignore', 'update-').hidden = s.phase !== 'available';
      byId('check', 'update-').disabled = ['checking','installing','installed'].includes(s.phase);
    });
    send('state');
  })();`;
}
module.exports = { updateMarkup, updateScript };

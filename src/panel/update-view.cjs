'use strict';
const { domHelpersSource } = require('./dom.cjs');
function updateMarkup() {
  return `<div class="list mt"><div class="setting"><div class="row-main"><span class="row-title">插件更新</span><span id="update-status" class="row-sub" role="status">尚未检查</span></div><div class="actions"><button id="update-install" type="button" hidden>安装更新</button><button id="update-ignore" class="quiet" type="button" hidden>忽略此版本</button><button id="update-check" class="secondary" type="button">检查更新</button></div></div><div class="setting"><label class="toggle"><input id="update-auto" type="checkbox">自动检查更新</label><button id="update-release" class="quiet" type="button">发布页面</button></div><div class="setting"><div class="row-main"><span class="row-title">更新代理</span><span class="row-sub">仅用于检查与安装更新，不影响模型请求；留空则更新也直连。</span></div><div class="actions nowrap"><input id="update-proxy" type="text" placeholder="http://127.0.0.1:7897" autocomplete="off" spellcheck="false"><button id="update-proxy-save" class="secondary" type="button">保存</button></div></div><pre id="update-notes" class="update-notes setting" hidden></pre></div>`;
}
function updateScript() {
  return `(() => {
    ${domHelpersSource('    ')}
    const send = (action, payload) => vscode.postMessage({ id: 'update-' + action, type: 'update.' + action, payload });
    for (const action of ['check','install','ignore','release']) byId(action, 'update-').addEventListener('click', () => send(action));
    byId('auto', 'update-').addEventListener('change', () => send('auto', { enabled: byId('auto', 'update-').checked }));
    byId('proxy-save', 'update-').addEventListener('click', () => send('proxy', { value: byId('proxy', 'update-').value.trim() }));
    byId('proxy', 'update-').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); byId('proxy-save', 'update-').click(); } });
    window.addEventListener('message', event => {
      if (event.data?.type !== 'update-state') return;
      const s = event.data.state;
      const labels = { idle:'', checking:'正在检查…', error:'检查失败', available:'有新版本 ' + (s.latestVersion || ''), ahead:'高于最新正式版', current:'已是最新', installing:'正在安装…', installed:'已安装，新建窗口或重载后生效' };
      byId('status', 'update-').textContent = '当前 ' + s.currentVersion + (labels[s.phase] ? ' · ' + labels[s.phase] : '') + (s.ignored ? '（已忽略）' : '') + (s.error ? ' · ' + s.error : '');
      const notes = s.phase === 'available' ? (s.notes || '') + (!s.canInstall ? '\\n暂不支持直接安装，请打开发布页面下载。' : '') : '';
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

'use strict';
const crypto = require('node:crypto');
const { baseStyles } = require('./theme.cjs');
const { timing, usageIsInconsistent } = require('../monitor/stats.cjs');
const { domHelpersSource } = require('./dom.cjs');
const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
const seconds = value => typeof value === 'number' && Number.isFinite(value) ? (value / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 }) + ' s' : '—';
const clock = value => { const stamp = Date.parse(value); if (!Number.isFinite(stamp)) return null; const date = new Date(stamp); return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0'); };
function contextDetails(session, monitor, catalog) {
  const usage = value => value ? `${number(value.used)} / ${number(value.size)} token · ${number(value.used / value.size * 100)}%` : '—';
  const label = uid => catalog?.models?.find(model => model.uid === uid)?.label || uid || '—';
  const fusion = catalog?.fusions?.[session?.modelUid];
  const rows = [{ key: 'model', label: '模型', value: label(session?.modelUid) }, { key: 'context', label: '主上下文', value: usage(session?.lead) },
    { key: 'turn', label: '本轮耗时 · 含等待', value: seconds(session?.turn?.durationMs) }];
  if (fusion) rows.push({ key: 'lead', label: '配置主模型', value: label(fusion.leadUid) }, { key: 'sidekick', label: '配置副模型', value: label(fusion.sidekickUid) });
  for (const subagent of session?.subagents || []) rows.push({ key: 'subagent:' + JSON.stringify([subagent.parentAgentId, subagent.runId]),
    label: '子代理 · ' + (subagent.parentAgentId || '—') + (subagent.runId ? ' · ' + String(subagent.runId).slice(0, 8) : ''), value: usage(subagent),
    title: `${subagent.parentAgentId} / ${subagent.runId ?? '—'}` });
  const matching = session ? monitor?.sessions?.filter(item => item.sessionId === session.sessionId) || [] : [];
  const sessionTitle = matching.length === 1 ? matching[0].title || null : null;
  const records = matching.length === 1 ? matching[0].records || [] : [];
  const latest = records.reduce((best, record) => Number.isFinite(Date.parse(record.startedAt)) && (!best || Date.parse(record.startedAt) > Date.parse(best.startedAt)) ? record : best, null);
  // The tps metric exists only for tool-free successful requests, and tool use is
  // the norm for agent traffic (measured: 92% of this machine's records), so reading
  // it off the newest request left the tile blank nearly always. Mirror the usage
  // page (summarize from monitor stats): show the latest eligible sample, and when that
  // sample is older than the newest request say so in visible text — this panel's
  // tooltips do not render on hover, so a title alone would not be seen.
  const tpsSample = records.filter(record => record.schemaVersion >= 2 && record.status === 'success' && !usageIsInconsistent(record) && timing(record.tps) !== null)
    .reduce((best, record) => !best || Date.parse(record.startedAt) >= Date.parse(best.startedAt) ? record : best, null);
  const tpsAt = tpsSample ? clock(tpsSample.startedAt) : null;
  const tpsFromLatest = Boolean(tpsSample && latest && Date.parse(tpsSample.startedAt) === Date.parse(latest.startedAt));
  const tpsLabel = '正文 TPS（不含工具）';
  const tpsTitle = '正文 TPS = 非工具输出 token ÷ 解码耗时；含工具或 reasoning 分项不明的请求不计算。' +
    (!tpsSample ? '当前保留记录中没有有效样本。'
      : !tpsAt ? '当前显示最近一条有效样本，其时间无法解析。'
      : '当前显示最近一条有效样本（' + tpsAt + '）' + (tpsFromLatest ? '，即最近一次请求。' : '，早于最近一次请求。'));
  const state = { success: '成功', error: '失败', cancelled: '已取消' };
  const request = [{ key: 'request', label: '最近请求', value: latest ? `${latest.model || '—'} · ${state[latest.status] || latest.status || '—'}` : '—' }];
  for (const [key, label] of [['durationMs', '请求耗时'], ['firstResponseMs', '首响应数据'], ['firstTextMs', '正文首字'], ['firstOutputMs', '首输出'], ['gatewayTps', '首响应后吞吐 TPS'], ['tps', tpsLabel], ['inputTokens', '输入 token'], ['outputTokens', '输出 token'], ['cachedTokens', '缓存 token'], ['reasoningTokens', '推理 token']]) {
    if (key === 'tps') { request.push({ key, label: tpsFromLatest || !tpsAt ? tpsLabel : tpsLabel + ' · 最近有效 ' + tpsAt, value: number(tpsSample?.tps), title: tpsTitle }); continue; }
    request.push({ key, label, value: key.endsWith('Ms') ? seconds(latest?.[key]) : number(latest?.[key]) });
  }
  const lines = [...rows, ...request].map(row => `${row.label}：${row.value}`);
  const tooltip = [rows[0], rows[1], ...request.slice(0, 7)].map(row => `${row.label}：${row.value}`).join('\n');
  const ratio = session?.lead?.size > 0 ? session.lead.used / session.lead.size : null;
  return { percent: ratio === null ? null : Math.max(0, Math.min(100, ratio * 100)), rows, request, lines, tooltip, sessionTitle };
}
function contextHtml(nonce) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">${baseStyles()}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:12px}#sessions{width:auto;max-width:65%}.usage{display:flex;align-items:center;gap:10px;white-space:nowrap}svg{width:32px;height:32px;transform:rotate(-90deg);color:var(--vscode-progressBar-background)}circle{fill:none;stroke:currentColor;stroke-width:3}.track{opacity:.18}#percent{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
</style></head><body><div class="toolbar"><div class="usage"><svg viewBox="0 0 40 40" aria-label="上下文占用"><circle class="track" cx="20" cy="20" r="16"/><circle id="fill" cx="20" cy="20" r="16" stroke-dasharray="100.531" stroke-dashoffset="100.531"/></svg><span id="percent">—</span></div><select id="sessions" aria-label="选择上下文会话"></select></div><p id="empty" class="hint" hidden>还没有可观察的会话。打开一个对话后，这里会显示上下文占用与最近请求指标。</p><h3 id="contextTitle">会话与上下文</h3><div id="context" class="tiles"></div><h3 id="requestTitle" class="mt">最近请求指标</h3><div id="request" class="tiles"></div><script nonce="${nonce}">${contextScript()}</script></body></html>`;
}
function contextScript() {
  return `${domHelpersSource()}const vscode=acquireVsCodeApi();let items=[],sessionKeys='';let pluginEnabled=true;const selector=document.getElementById('sessions');const grids=new Map();
function grid(id,rows){const root=document.getElementById(id);let cells=grids.get(id);const keys=JSON.stringify(rows.map(row=>row.key));if(!cells||cells.keys!==keys){root.replaceChildren();cells={keys,nodes:[]};for(const row of rows){const cell=document.createElement('div'),label=document.createElement('div'),value=document.createElement('div');cell.className='tile';label.className='tile-label';value.className='tile-value';cell.append(label,value);root.append(cell);cells.nodes.push({cell,label,value});}grids.set(id,cells);}rows.forEach((row,i)=>{const nodes=cells.nodes[i];text(nodes.label,row.label);text(nodes.value,row.value);if(nodes.cell.title!==(row.title||''))nodes.cell.title=row.title||'';});}
function render(){const item=items.find(x=>x.sessionId===selector.value);const percent=item?.percent;
text(document.getElementById('percent'),percent==null?'—':percent.toFixed(1)+'%');
const fill=document.getElementById('fill'),offset=String(100.531*(1-(percent??0)/100));if(fill.getAttribute('stroke-dashoffset')!==offset)fill.setAttribute('stroke-dashoffset',offset);
const empty=!item||!item.sessionId;
text(document.getElementById('empty'),pluginEnabled?'还没有可观察的会话。打开一个对话后，这里会显示上下文占用与最近请求指标。':'插件已停用，暂不观察上下文。请在控制面板启用。');
document.getElementById('empty').hidden=!empty;selector.hidden=empty;
for(const id of ['contextTitle','requestTitle','context','request'])document.getElementById(id).hidden=empty;
if(empty)return;
grid('context',item.rows||[]);grid('request',item.request||[]);}
selector.addEventListener('change',()=>{render();vscode.postMessage({type:'selectSession',sessionId:selector.value});});window.addEventListener('message',event=>{if(event.data?.type!=='context')return;const previous=selector.value;pluginEnabled=event.data.enabled!==false;items=event.data.items;const keys=JSON.stringify(items.map(x=>x.sessionId).sort());if(keys!==sessionKeys){sessionKeys=keys;selector.replaceChildren();for(const item of items){const option=document.createElement('option');option.value=item.sessionId;option.title=item.sessionId;selector.append(option);}if(items.some(x=>x.sessionId===previous))selector.value=previous;}for(const option of selector.children){const item=items.find(x=>x.sessionId===option.value);text(option,item?.label||'暂无会话');}if(items.some(x=>x.sessionId===event.data.selectedSessionId))selector.value=event.data.selectedSessionId;render();});vscode.postMessage({type:'ready'});`;
}
function createContextUi({ vscode, context, snapshot, readMonitor, catalog, nativeLabels, isEnabled = () => true, focused = () => null }) {
  let panel, disposed = false, pending = null, monitor = null, lastRead = -Infinity, shown = false, lastPayload = null, selectedSessionId = null, nextSessionLabel = 0, followedAt = 0;
  const sessionLabels = new Map();
  const item = vscode.window.createStatusBarItem?.(vscode.StatusBarAlignment?.Right ?? 2, 19);
  if (item) item.command = 'devinFusionByok.contextDetails';
  function post(values, force) {
    if (!panel || panel.visible === false) return;
    const message = { type: 'context', items: values, selectedSessionId, enabled: isEnabled() };
    const payload = JSON.stringify(message);
    if (force || payload !== lastPayload) { lastPayload = payload; panel.webview.postMessage(message); }
  }
  function refresh(force = false) {
    if (disposed) return;
    if (!isEnabled()) { monitor = null; selectedSessionId = null; sessionLabels.clear(); nextSessionLabel = 0; if (shown) { item?.hide(); shown = false; } post([], force); return; }
    // A session the app merely prepares or restores (session/new, session/load)
    // carries a model uid but no usage at all: rendering it produced an
    // all-dash「会话 N」tile, and since loading counts as focus the follow could
    // even select it away from the session the user is working in.
    const sessions = snapshot().filter(session => session.lead || session.subagents?.length || session.turn),
      currentCatalog = catalog();
    // Own emitted models win: contextDetails' label() takes the first match,
    // so native observation labels are appended after the catalog's entries.
    const labels = nativeLabels?.() || new Map();
    const view = labels.size ? { ...currentCatalog, models: [...(currentCatalog.models || []), ...[...labels].map(([uid, label]) => ({ uid, label }))] } : currentCatalog;
    for (const id of sessionLabels.keys()) if (!sessions.some(session => session.sessionId === id)) sessionLabels.delete(id);
    const values = sessions.map(session => {
      if (!sessionLabels.has(session.sessionId)) sessionLabels.set(session.sessionId, ++nextSessionLabel);
      const details = contextDetails(session, monitor, view);
      const title = details.sessionTitle || `会话 ${sessionLabels.get(session.sessionId)}`;
      return { sessionId: session.sessionId, label: `${title} · ${details.rows[0].value}`, ...details };
    });
    // Follow the app-focused session: a new focus event wins once, then the
    // user's manual pick holds until Devin focuses something else again.
    const focus = focused();
    if (focus && focus.at > followedAt && values.some(value => value.sessionId === focus.sessionId)) {
      followedAt = focus.at;
      selectedSessionId = focus.sessionId;
    }
    if (!values.some(value => value.sessionId === selectedSessionId)) selectedSessionId = values[0]?.sessionId ?? null;
    const latest = values.find(value => value.sessionId === selectedSessionId) || contextDetails(null);
    if (!values.length) values.push({ sessionId: '', ...latest });
    if (item) {
      const text = '$(circle-outline) 上下文' + (latest.percent === null ? ' —' : ' ' + latest.percent.toFixed(0) + '%');
      if (item.text !== text) item.text = text;
      if (item.tooltip !== latest.tooltip) item.tooltip = latest.tooltip;
      if (!shown) { item.show(); shown = true; }
    }
    post(values, force);
    if (!pending && Date.now() - lastRead >= 5000) {
      lastRead = Date.now();
      pending = Promise.resolve().then(readMonitor).then(result => { if (!disposed && isEnabled()) monitor = result?.snapshot || null; }, () => { monitor = null; }).finally(() => { pending = null; });
    }
  }
  function open() {
    if (disposed) return;
    if (panel) { panel.reveal(); refresh(true); return; }
    panel = vscode.window.createWebviewPanel('devinFusionByok.context', 'Fusion 上下文与性能', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    lastPayload = null;
    const current = panel;
    current.webview.html = contextHtml(crypto.randomBytes(24).toString('hex'));
    const listener = current.webview.onDidReceiveMessage(message => {
      if (message?.type === 'ready') refresh(true);
      if (message?.type === 'selectSession' && isEnabled() && snapshot().some(session => session.sessionId === message.sessionId)) { selectedSessionId = message.sessionId; refresh(); }
    });
    const visibility = current.onDidChangeViewState?.(() => { if (current.visible) refresh(true); });
    const closing = current.onDidDispose(() => { listener.dispose(); visibility?.dispose(); closing.dispose(); if (panel === current) { panel = null; lastPayload = null; } });
  }
  const command = vscode.commands.registerCommand('devinFusionByok.contextDetails', open);
  const timer = setInterval(() => { try { refresh(); } catch {} }, 1000); timer.unref?.();
  const handle = { dispose() { disposed = true; clearInterval(timer); command.dispose(); item?.dispose(); panel?.dispose(); }, refresh };
  context.subscriptions.push(handle); refresh(); return handle;
}
module.exports = { contextDetails, contextHtml, contextScript, createContextUi };

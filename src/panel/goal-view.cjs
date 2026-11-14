'use strict';
const crypto = require('node:crypto');
const { baseStyles } = require('./theme.cjs');
const { domHelpersSource, markupText } = require('./dom.cjs');
const { translator, browserSource } = require('../i18n/index.cjs');

// Goal status and reason codes (goal/store.cjs, goal/controller.cjs); the copy
// for each is goal.status.<code> / goal.reason.<code> in src/i18n.
const STATUS_CODES = ['active', 'paused', 'waiting', 'blocked', 'limited', 'review', 'completed'];
const SESSION_CODES = ['idle', 'busy', 'unknown'];
const REASON_CODES = ['review', 'missing-report', 'max-runs', 'no-progress', 'user-paused', 'manual-prompt', 'session-busy',
  'session-unavailable', 'session-not-idle', 'reloaded', 'disposed', 'disabled', 'missing-goal', 'dispatch-failed',
  'store-write-failed', 'capability-failed', 'ownership-lost', 'run-ended-unknown', 'cancelled', 'refusal', 'permission',
  'session-inactive', 'disconnected', 'interrupted', 'suspended', 'accepted', 'achieved'];
function goalScript(locale) {
  const labels = (codes, prefix) => `Object.fromEntries(${JSON.stringify(codes)}.map(code=>[code,t('${prefix}'+code)]))`;
  return `${domHelpersSource()}${browserSource(locale, ['common.', 'goal.'])}const vscode=acquireVsCodeApi();let state=null,errorText='',notice='',sessions=[],selectedSession='';
const STATUS_LABELS=${labels(STATUS_CODES, 'goal.status.')},REASON_LABELS=${labels(REASON_CODES, 'goal.reason.')},SESSION_LABELS=${labels(SESSION_CODES, 'goal.session.')};
const el=byId;

function statusText(goal){const base=STATUS_LABELS[goal.status]||goal.status;
if(goal.locked)return base+t('goal.lockedSuffix');
const reason=goal.reason?(REASON_LABELS[goal.reason]||goal.reason):'';return reason?base+' · '+reason:base;}
function option(value,label){const o=document.createElement('option');o.value=value;o.textContent=label;return o;}
function sessionLabel(id){const session=sessions.find(s=>s.sessionId===id);const label=session?.title||id;
return sessions.filter(s=>(s.title||s.sessionId)===label).length>1?label+' · '+id:label;}
function render(){if(!state)return;el('enabled').textContent=state.enabled?t('goal.enabled'):t('goal.disabled');
el('trusted').textContent=state.trusted?t('goal.trusted'):t('goal.untrusted');
el('storeError').textContent=state.storeError?t('goal.storeError',{error:state.storeError}):'';
el('corrupt').textContent=state.corruptGoals?t('goal.corrupt',{count:state.corruptGoals}):'';
el('error').textContent=errorText;el('notice').textContent=notice;
sessions=state.sessions||[];
const list=el('goals');list.replaceChildren();
if(!(state.goals||[]).length){const empty=document.createElement('p');empty.className='hint mt';
empty.textContent=!state.enabled?t('goal.emptyDisabled'):!state.trusted?t('goal.emptyUntrusted'):t('goal.empty');
list.append(empty);}
for(const goal of state.goals||[]){const item=document.createElement('div');item.className='goal';
const head=document.createElement('div');head.className='goalhead';head.textContent=statusText(goal)+' · '+sessionLabel(goal.sessionId);item.append(head);
const meta=document.createElement('div');meta.className='meta';meta.textContent=t('goal.meta',{runs:goal.runsStarted,max:goal.maxRuns,revision:goal.revision})+(goal.archived?t('goal.archivedSuffix'):'');item.append(meta);
const objective=document.createElement('pre');objective.textContent=t('goal.objective',{objective:goal.objective})+(goal.criteria&&goal.criteria!==goal.objective?'\\n'+t('goal.criteria',{criteria:goal.criteria}):'');item.append(objective);
const evidence=document.createElement('div');evidence.className='evidence';
if(!goal.evidence.length)evidence.textContent=t('goal.noEvidence');
for(const entry of goal.evidence){const line=document.createElement('pre');line.textContent='['+entry.status+'] '+entry.evidence;evidence.append(line);}
item.append(evidence);
const actions=document.createElement('div');actions.className='actions';
const act=(type,label,variant,extra,needsConfirm)=>{const b=document.createElement('button');b.textContent=label;
b.className=variant;
b.disabled=!!goal.locked;b.onclick=()=>send(type,Object.assign({id:goal.id},extra||{}),needsConfirm);actions.append(b);};
if(!goal.locked){if(goal.status==='active')act('goal.pause',t('goal.pause'),'secondary');
else if(!goal.archived&&goal.status!=='completed')act('goal.resume',t('goal.resume'),'secondary',{},false);
if(goal.status==='review')act('goal.accept',t('goal.accept'),'',{},true);
if(!goal.archived)act('goal.archive',t('goal.archive'),'danger',{},goal.status==='active');}
item.append(actions);list.append(item);}
const history=el('history');history.replaceChildren();
el('historyTitle').hidden=!(state.history||[]).length;
for(const goal of state.history||[]){const line=document.createElement('pre');line.textContent='['+goal.status+'] '+sessionLabel(goal.sessionId)+' · '+t('goal.revision',{revision:goal.revision})+'\\n'+goal.objective;history.append(line);}}
function send(type,payload,needsConfirm){const id=String(Math.random());errorText='';notice='';el('error').textContent='';el('notice').textContent='';
vscode.postMessage({type,id,payload,confirm:needsConfirm===true});}
window.addEventListener('message',event=>{const data=event.data;if(!data)return;
if(data.type==='goal-state'){state=data.state;render();return;}
if(data.type==='goal-result'){if(!data.ok){errorText=data.error||t('goal.failed');}else{notice=data.notice||'';}render();}});
el('refresh').onclick=()=>send('goal.refresh',{});
vscode.postMessage({type:'goal.ready',id:String(Math.random()),payload:{}});`;
}

function goalHtml(nonce, locale = 'zh-CN') {
  const t = translator(locale);
  const h = markupText(t);
  return `<!DOCTYPE html><html lang="${t.locale}"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">${baseStyles()}label{display:block;margin-top:12px}.goal{border:1px solid var(--border);border-radius:var(--radius-container);padding:12px 14px;margin-top:12px}.goalhead{font-weight:600}.meta{opacity:.8}.evidence{border-left:2px solid var(--border);padding-left:8px;margin-top:6px}.actions{margin-top:12px}.notice{color:var(--muted)}</style></head><body><h2>Fusion BYOK Goal</h2><p class="hint">${h('goal.intro', { command: '<b>' + h('goalDoc.cmd.start') + '</b>' })}<br>${h('goal.commandsLine')}</p><p>${h('goal.pluginLabel')}<span id="enabled">${h('common.unknown')}</span> · <span id="trusted">${h('common.unknown')}</span></p><p id="storeError" class="error mt" role="status"></p><p id="corrupt" class="error mt" role="status"></p><div class="actions"><button id="refresh" class="secondary">${h('common.refresh')}</button></div><p id="error" class="error mt" role="status"></p><p id="notice" class="notice mt" role="status"></p><div id="goals"></div><h3 id="historyTitle" class="mt">${h('goal.history')}</h3><div id="history"></div><script nonce="${nonce}">${goalScript(t.locale)}</script></body></html>`;
}

function createGoalUi({ vscode, context, controller, isEnabled = () => true, isTrusted = () => true, t = translator(), safeError = () => ({ message: t('goal.failed') }) }) {
  let panel, disposed = false;
  const item = vscode.window.createStatusBarItem?.(vscode.StatusBarAlignment?.Right ?? 2, 18);
  function refreshStatusBar() {
    if (!item) return;
    let count = 0;
    try { count = (controller.snapshot().goals || []).filter(goal => !goal.archived).length; } catch {}
    item.text = '$(target) Goal' + (count ? ' ' + count : '');
    item.tooltip = t('goal.statusBarTooltip');
    item.command = 'devinFusionByok.goal';
    item.show();
  }
  function state() {
    try { return controller.snapshot(); }
    catch { return { enabled: isEnabled(), trusted: isTrusted(), storeError: 'unavailable', corruptGoals: 0, sessions: [], goals: [], history: [] }; }
  }
  async function confirm(message) {
    if (typeof vscode.window.showWarningMessage !== 'function') return false;
    // The modal returns the label it was given; compare against the same value.
    const confirmLabel = t('goal.confirm');
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
    return choice === confirmLabel;
  }
  async function askRunLimit(goal) {
    if (typeof vscode.window.showInputBox !== 'function') return null;
    const answer = await vscode.window.showInputBox({
      title: t('goal.raiseLimitTitle'),
      prompt: t('goal.raiseLimitPrompt', { runs: goal.runsStarted }),
      value: String(Math.min(100, Math.max(goal.runsStarted + 1, goal.maxRuns))),
      validateInput: value => {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) return t('goal.raiseLimitRange');
        if (parsed <= goal.runsStarted) return t('goal.raiseLimitAbove', { runs: goal.runsStarted });
        return null;
      }
    });
    if (answer === undefined || answer === null || answer === '') return null;
    const parsed = Number(answer);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100 || parsed <= goal.runsStarted) return null;
    return parsed;
  }
  async function handleMessage(message) {
    if (!message || typeof message.type !== 'string' || typeof message.id !== 'string' || message.id.length > 100) return;
    const target = panel;
    if (!target) return;
    if (message.type === 'goal.ready' || message.type === 'goal.refresh') {
      await target.webview.postMessage({ type: 'goal-state', state: state() });
      return;
    }
    const payload = message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload) ? message.payload : {};
    let result;
    try {
      if (message.type === 'goal.start') result = controller.start(payload);
      else if (message.type === 'goal.pause') result = controller.pause(payload);
      else if (message.type === 'goal.resume') {
        const goal = (state().goals || []).find(item => item.id === payload.id);
        if (goal && goal.runsStarted >= goal.maxRuns) {
          const answer = await askRunLimit(goal);
          if (answer === null) return;
          payload.maxRuns = answer;
        }
        result = controller.resume(payload);
      } else if (message.type === 'goal.accept') {
        if (!(await confirm(t('goal.acceptConfirm')))) return;
        result = controller.accept(payload);
      } else if (message.type === 'goal.archive') {
        const goal = (state().goals || []).find(item => item.id === payload.id);
        if (goal && goal.status === 'active' && !(await confirm(t('goal.archiveConfirm')))) return;
        result = controller.archive(payload);
      } else return;
      await target.webview.postMessage({ type: 'goal-result', id: message.id, ok: true });
      await target.webview.postMessage({ type: 'goal-state', state: state() });
    } catch (error) {
      const text = error?.code ? error.message : safeError(error).message;
      await target.webview.postMessage({ type: 'goal-result', id: message.id, ok: false, error: text });
      try { await target.webview.postMessage({ type: 'goal-state', state: state() }); } catch {}
    }
    refreshStatusBar();
  }
  function open() {
    if (disposed) return;
    if (panel) { panel.reveal(); return; }
    panel = vscode.window.createWebviewPanel('devinFusionByok.goal', 'Fusion BYOK Goal', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    const current = panel;
    current.webview.html = goalHtml(crypto.randomBytes(24).toString('base64'), t.locale);
    const listener = current.webview.onDidReceiveMessage(message => { void handleMessage(message); });
    const closing = current.onDidDispose(() => { listener.dispose(); closing.dispose(); if (panel === current) panel = undefined; });
  }
  const command = vscode.commands.registerCommand('devinFusionByok.goal', open);
  const timer = setInterval(() => {
    if (disposed || !panel) return;
    refreshStatusBar();
    try { void panel.webview.postMessage({ type: 'goal-state', state: state() }); } catch {}
  }, 3000);
  timer.unref?.();
  const handle = { dispose() { disposed = true; clearInterval(timer); command.dispose(); item?.dispose(); panel?.dispose(); }, refresh: refreshStatusBar };
  context.subscriptions.push(handle);
  refreshStatusBar();
  return handle;
}

module.exports = { createGoalUi, goalHtml, goalScript };
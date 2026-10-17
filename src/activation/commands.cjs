'use strict';
const { writeConfig } = require('../config.cjs');
const { readReceipt, remember, saveReceipt, valueAt, restoreObject, permitted } = require('../lifecycle/owned-settings.cjs');
const { globalSetting } = require('./errors.cjs');
const { teardown } = require('./teardown.cjs');

function installCommands({ deps, shared }) {
  const { lifecycle, config, configFile, vscode, context, log, catalog, run } = deps;
  const refresh = async () => {
    shared.management.open();
    vscode.window.showInformationMessage('请选择供应商，点击「导入模型」，勾选要导入的模型后确认。');
  };
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.refreshModels', run(refresh)));
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.openPanel', run(async () => shared.management.open())));
  require('../fast-context/config-ui.cjs').registerFastContext({ vscode, context });
  shared.saveFusionChoice = async uid => {
    const settings = vscode.workspace.getConfiguration('devin.acp'); const preferences = globalSetting(settings, 'agentPreferences');
    const receipt = readReceipt(deps.root, context.extensionPath), keys = ['devin.acp.agentPreferences', 'devin-cli', 'model'];
    remember(receipt, keys, valueAt({ 'devin.acp.agentPreferences': preferences }, keys), uid);
    saveReceipt(receipt);
    await settings.update('agentPreferences', { ...preferences, 'devin-cli': { ...(preferences['devin-cli'] || {}), model: uid } }, vscode.ConfigurationTarget.Global);
    rememberFusion(uid);
    await shared.management?.publish();
  };
  // Memory of the combination this extension serves (matrix entries included).
  // It is what a locked official selection falls back to, and what an emptied
  // preference is restored from — so it is recorded whenever one is chosen, but
  // recording it never re-writes the preference itself.
  const rememberFusion = uid => {
    if (!Object.hasOwn(catalog().fusions, uid)) return false;
    const current = config();
    if (current.lastFusionSelection === uid) return false;
    current.lastFusionSelection = uid;
    writeConfig(configFile, current);
    return true;
  };
  // The remembered combination is also the fallback served when a locked
  // official Fusion entry is selected, so it is kept only while it resolves.
  const rememberedFusion = () => {
    const currentCatalog = catalog(), uid = currentCatalog.lastFusionSelection;
    return typeof uid === 'string' && Object.hasOwn(currentCatalog.fusions, uid) ? uid : '';
  };
  let reconcileQueue = Promise.resolve();
  shared.reconcilePreference = () => {
    const operation = reconcileQueue.then(async () => {
      if (lifecycle.reconcileHalted || config().enabled === false) return;
      const current = globalSetting(vscode.workspace.getConfiguration('devin.acp'), 'agentPreferences')['devin-cli']?.model;
      // Any fusion-shaped selection is legitimate — the official card's own
      // combinations and our mirrored ones alike — so it is only remembered,
      // never rewritten: the picker value the user sees must stay what they
      // (or Devin) chose.
      if (typeof current === 'string' && current.startsWith('fusion-')) {
        rememberFusion(current);
        return;
      }
      if (typeof current === 'string' && current) return;
      const remembered = rememberedFusion();
      if (remembered) await shared.saveFusionChoice(remembered);
    }).catch(() => log('preference-reconcile-error'));
    reconcileQueue = operation;
    return operation;
  };
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.selectFusion', run(async () => {
    const choices = catalog().models.filter(model => model.kind === 'matrix').map(model => ({ label: model.label || model.uid, uid: model.uid }));
    if (!choices.length) { shared.management?.open(); vscode.window.showInformationMessage('Fusion 组合在 Devin 的模型选择器里选（打开 Fusion 卡片）；控制面板的「Fusion」页用来决定哪些模型能出现在那张卡片的下拉里。'); return; }
    const choice = await vscode.window.showQuickPick(choices, { title: '选择 Fusion 组合', matchOnDescription: true }); if (!choice) return;
    await shared.saveFusionChoice(choice.uid);
    vscode.window.showInformationMessage('Fusion 模型已保存，请新建 Devin Local 会话。');
  })));
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.status', () => { log('status', { runtime: lifecycle.connection?.status, models: config().providers.map(p => ({ name: p.name, models: p.models.length })) }); deps.output.show(true); }));
  shared.disable = async () => {
    try { lifecycle.goalController?.suspend({ reason: 'disabled' }); } catch { log('goal-suspend-failed'); }
    shared.backendStatus = 'stopped';
    const current = config(); current.enabled = false; writeConfig(configFile, current);
    await teardown(lifecycle);
    const settings = vscode.workspace.getConfiguration('devin.acp');
    const snapshot = { 'devin.acp.agentEnv': globalSetting(settings, 'agentEnv'), 'devin.acp.agentPreferences': globalSetting(settings, 'agentPreferences') };
    const receipt = readReceipt(deps.root, context.extensionPath);
    const managed = context.globalState.get('managedEnv', {}), saved = context.globalState.get('savedEnv', {});
    // Older releases kept the backup in globalState only. Migrate only values
    // with an actual saved original; an unknown original is never guessed.
    for (const [key, value] of Object.entries(managed)) {
      const keys = ['devin.acp.agentEnv', 'devin-cli', key];
      if (permitted(keys) && Object.hasOwn(saved, key) && !receipt.changes.some(change => JSON.stringify(change.path) === JSON.stringify(keys))) {
        remember(receipt, keys, valueAt(snapshot, keys), value, saved[key] == null ? { exists: false } : { exists: true, value: saved[key] });
      }
    }
    saveReceipt(receipt);
    const restored = restoreObject(snapshot, receipt.changes);
    for (const key of ['agentEnv', 'agentPreferences']) if (JSON.stringify(snapshot['devin.acp.' + key]) !== JSON.stringify(restored.value['devin.acp.' + key])) {
      await settings.update(key, restored.value['devin.acp.' + key], vscode.ConfigurationTarget.Global);
    }
    receipt.changes = []; saveReceipt(receipt);
    await context.globalState.update('savedEnv', undefined);
    await context.globalState.update('managedEnv', undefined);
    vscode.window.showInformationMessage('Fusion BYOK 已停用，原生连接已恢复。');
  };
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.disable', run(shared.disable)));
  shared.reconcileSelection = async () => {
    const settings = vscode.workspace.getConfiguration('devin.acp');
    const preferences = globalSetting(settings, 'agentPreferences'), current = preferences['devin-cli']?.model;
    const isOwnSelection = uid => typeof uid === 'string' &&
      (/^(?:fusion-)?dfbyok-/.test(uid) || (catalog().matrixUids instanceof Set && catalog().matrixUids.has(uid)));
    if (!isOwnSelection(current) || catalog().models.some(model => model.uid === current)) return;
    const receipt = readReceipt(deps.root, context.extensionPath);
    const changes = receipt.changes.filter(change => change.path[0] === 'devin.acp.agentPreferences');
    const restored = restoreObject({ 'devin.acp.agentPreferences': preferences }, changes).value['devin.acp.agentPreferences'];
    if (isOwnSelection(restored['devin-cli']?.model)) delete restored['devin-cli'].model;
    await settings.update('agentPreferences', restored, vscode.ConfigurationTarget.Global);
  };
}

module.exports = { installCommands };

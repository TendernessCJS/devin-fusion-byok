'use strict';
const { updateConfig } = require('../config/store.cjs');
const { readReceipt, remember, saveReceipt, valueAt, restoreObject, permitted } = require('../lifecycle/owned-settings.cjs');
const { globalSetting } = require('./settings.cjs');
const { teardown } = require('./teardown.cjs');
const { isHostDisabled } = require('../lifecycle/host-disabled.cjs');
const { live } = require('./liveness.cjs');
const { RuntimeError } = require('./errors.cjs');

function installCommands({ deps, shared }) {
  const { lifecycle, config, configFile, vscode, context, log, catalog, run, managedSettings } = deps;
  // Every settings write goes through the gate so a disable can drain it before
  // restoring; writes attempted after close are cancelled rather than landing
  // on top of the restored values.
  const managedWrite = async fn => {
    if (!live(lifecycle, config)) throw new RuntimeError('cancelled');
    try { return await managedSettings.critical(fn); }
    catch (error) { if (error?.code === 'cancelled') throw new RuntimeError('cancelled'); throw error; }
  };
  const refresh = async () => {
    shared.management.open();
    vscode.window.showInformationMessage('请选择供应商，点击「导入模型」，勾选要导入的模型后确认。');
  };
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.refreshModels', run(refresh)));
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.openPanel', run(async () => shared.management.open())));
  require('../fast-context/config-ui.cjs').registerFastContext({ vscode, context });
  shared.saveFusionChoice = async uid => {
    await managedWrite(async () => {
      const settings = vscode.workspace.getConfiguration('devin.acp'); const preferences = globalSetting(settings, 'agentPreferences');
      const receipt = readReceipt(deps.root, context.extensionPath), keys = ['devin.acp.agentPreferences', 'devin-cli', 'model'];
      remember(receipt, keys, valueAt({ 'devin.acp.agentPreferences': preferences }, keys), uid);
      saveReceipt(receipt);
      await settings.update('agentPreferences', { ...preferences, 'devin-cli': { ...(preferences['devin-cli'] || {}), model: uid } }, vscode.ConfigurationTarget.Global);
    });
    // Publishing must not stretch the drain budget, and a choice that landed
    // while disabling is restored anyway — skip the side effects then.
    if (!live(lifecycle, config)) return;
    rememberFusion(uid);
    await shared.management?.publish();
  };
  // Memory of the combination this extension serves (matrix entries included).
  // It is what a locked official selection falls back to, and what an emptied
  // preference is restored from — so it is recorded whenever one is chosen, but
  // recording it never re-writes the preference itself.
  const rememberFusion = uid => {
    if (!Object.hasOwn(catalog().fusions, uid)) return false;
    const { changed } = updateConfig(configFile, current => {
      if (current.lastFusionSelection === uid) return false;
      current.lastFusionSelection = uid;
      return true;
    });
    return changed;
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
    }).catch(error => { if (error?.code !== 'cancelled') log('preference-reconcile-error'); });
    reconcileQueue = operation;
    return operation;
  };
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.selectFusion', run(async () => {
    const choices = catalog().models.filter(model => model.kind === 'matrix').map(model => ({ label: model.label || model.uid, uid: model.uid }));
    if (!choices.length) { shared.management?.open(); vscode.window.showInformationMessage('Fusion 组合在 Devin 的模型选择器里选（打开 Fusion 卡片）；控制面板的「Fusion」页用来决定哪些模型能出现在那张卡片的下拉里。'); return; }
    const choice = await vscode.window.showQuickPick(choices, { title: '选择 Fusion 组合', matchOnDescription: true }); if (!choice) return;
    await shared.saveFusionChoice(choice.uid);
    vscode.window.showInformationMessage('已保存插件组合设置；请在 Devin 模型选择器确认选择（当前会话可能保留此前选择）。');
  })));
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.status', () => { log('status', { runtime: lifecycle.connection?.status, models: config().providers.map(p => ({ name: p.name, models: p.models.length })) }); deps.output.show(true); }));
  // Restores only the settings values this extension wrote and the user has not
  // changed since, using the receipt. Does not touch the plugin's own enabled flag.
  const restoreOwnedSettings = async ({ keepReceipt = false } = {}) => {
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
    // A drain timeout leaves an enable write possibly still in flight; keep the
    // receipt and saved originals so a later restore still has the evidence.
    if (!keepReceipt) {
      receipt.changes = []; saveReceipt(receipt);
      await context.globalState.update('savedEnv', undefined);
      await context.globalState.update('managedEnv', undefined);
    }
  };
  // Every disable path (panel switch, disable command, external enabled=false
  // edit) serializes through the same in-flight promise so a config watcher
  // firing mid-teardown cannot start a second teardown in parallel.
  let disablePromise = null;
  shared.disable = () => {
    disablePromise ??= (async () => {
      try { lifecycle.goalController?.suspend({ reason: 'disabled' }); } catch { log('goal-suspend-failed'); }
      shared.backendStatus = 'stopped';
      updateConfig(configFile, current => { if (current.enabled === false) return false; current.enabled = false; return true; });
      const drained = await managedSettings.drain();
      if (!drained) log('managed-settings-drain-timeout');
      // Owned settings restore must run even when the LS bridge dispose threw —
      // a broken bridge can never orphan the user's environment values.
      let verdict;
      try { verdict = await teardown(lifecycle, { restore: true }); }
      finally { await restoreOwnedSettings({ keepReceipt: drained === false }); }
      if (drained) vscode.window.showInformationMessage(verdict?.ok
        ? 'Fusion BYOK 已停用，原生连接已恢复。'
        : 'Fusion BYOK 已停用，连接设置已恢复；桌面模型目录恢复尚未确认。');
      else vscode.window.showWarningMessage('Fusion BYOK 已停用，但设置写入等待超时；恢复尚未确认，已保留恢复记录，请稍后重试停用。');
    })().finally(() => { disablePromise = null; shared.disablePromise = undefined; });
    // Exposed so ensureEnabled can wait out an in-flight restore instead of
    // installing hooks the old teardown finally would strip again.
    shared.disablePromise = disablePromise;
    return disablePromise;
  };
  // Disabling in the extension manager restarts the extension host and never runs
  // the disable command; without this the native CLI keeps pointing at a runtime
  // that no longer starts. A plain reload or quit keeps the shared settings.
  // deactivate() only reaches `lifecycle`, so the hook lives on that slot.
  lifecycle.restoreOnHostDisable = async () => {
    if (!isHostDisabled({ storageRoot: deps.root })) return;
    const drained = await managedSettings.drain();
    if (!drained) log('managed-settings-drain-timeout', { phase: 'host-disable' });
    await restoreOwnedSettings({ keepReceipt: drained === false });
    log(drained ? 'host-disabled-settings-restored' : 'host-disabled-settings-restore-pending');
  };
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.disable', run(shared.disable)));
  shared.reconcileSelection = async () => {
    if (!live(lifecycle, config)) return;
    await managedWrite(async () => {
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
    });
  };
}

module.exports = { installCommands };

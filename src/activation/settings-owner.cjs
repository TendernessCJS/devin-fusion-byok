'use strict';
const { readReceipt, remember, saveReceipt, valueAt, restoreObject, permitted } = require('../lifecycle/owned-settings.cjs');
const { globalSetting } = require('./settings.cjs');
const { RuntimeError } = require('./errors.cjs');
const { createManagedSettingsGate } = require('./managed-settings.cjs');
const { BACKEND_URL } = require('../runtime/port.cjs');

// A configured http.proxy routes this window, so the managed CLI env must exempt
// loopback or devin-cli cannot reach the local backend or the LS bridge. Read
// the global value first: merged workspace settings are never copied into global
// settings, and the effective value is only a fallback for the window case.
function loopbackExemption(vscode) {
  let proxy;
  try {
    const http = vscode.workspace.getConfiguration('http');
    proxy = http?.inspect?.('proxy')?.globalValue;
    if (typeof proxy !== 'string' || !proxy.trim()) proxy = http?.get?.('proxy');
  } catch {}
  return typeof proxy === 'string' && proxy.trim() ? '127.0.0.1,localhost,::1' : null;
}

function createSettingsOwner({ root, extensionPath, vscode, globalState, isLive }) {
  const gate = createManagedSettingsGate();
  // Every settings write goes through the gate so a disable can drain it before
  // restoring; writes attempted after close are cancelled rather than landing
  // on top of the restored values.
  const write = async fn => {
    if (!isLive()) throw new RuntimeError('cancelled');
    try { return await gate.critical(fn); }
    catch (error) { if (error?.code === 'cancelled') throw new RuntimeError('cancelled'); throw error; }
  };
  const openWrites = () => gate.open();
  const drainWrites = () => gate.drain();
  const applyEnvironment = async () => {
    const settings = vscode.workspace.getConfiguration('devin.acp');
    const existing = globalSetting(settings, 'agentEnv');
    const previous = { ...(existing['devin-cli'] || {}) };
    const desired = { WINDSURF_API_SERVER_URL: BACKEND_URL };
    const noProxy = loopbackExemption(vscode);
    if (noProxy) desired.NO_PROXY = noProxy;
    const saved = { ...globalState.get('savedEnv', {}) }, managed = globalState.get('managedEnv', {});
    const receipt = readReceipt(root, extensionPath);
    // Migrate this extension's experimental proxy settings without changing any
    // values the user subsequently edited.
    for (const [key, value] of Object.entries(managed)) if (!(key in desired) && previous[key] === value) {
      if (saved[key] == null) delete previous[key]; else previous[key] = saved[key];
    }
    for (const key of Object.keys(desired)) if (!(key in saved)) saved[key] = previous[key] ?? null;
    for (const [key, value] of Object.entries(desired)) {
      const current = valueAt({ 'devin.acp.agentEnv': existing }, ['devin.acp.agentEnv', 'devin-cli', key]);
      const legacy = managed[key] === current.value && Object.hasOwn(saved, key)
        ? saved[key] == null ? { exists: false } : { exists: true, value: saved[key] } : undefined;
      remember(receipt, ['devin.acp.agentEnv', 'devin-cli', key], current, value, legacy);
    }
    // Commit recovery information before changing the user's settings. The
    // whole write leg is one critical section: a disable that lands mid-write
    // drains it before restoring, and one already draining cancels it.
    await gate.critical(async () => {
      saveReceipt(receipt);
      await globalState.update('savedEnv', saved);
      await globalState.update('managedEnv', desired);
      if (Object.keys(managed).some(k => !(k in desired)) || Object.entries(desired).some(([k, v]) => previous[k] !== v)) await settings.update('agentEnv', { ...existing, 'devin-cli': { ...previous, ...desired } }, vscode.ConfigurationTarget.Global);
    });
  };
  const saveModel = async uid => write(async () => {
    const settings = vscode.workspace.getConfiguration('devin.acp'); const preferences = globalSetting(settings, 'agentPreferences');
    const receipt = readReceipt(root, extensionPath), keys = ['devin.acp.agentPreferences', 'devin-cli', 'model'];
    remember(receipt, keys, valueAt({ 'devin.acp.agentPreferences': preferences }, keys), uid);
    saveReceipt(receipt);
    await settings.update('agentPreferences', { ...preferences, 'devin-cli': { ...(preferences['devin-cli'] || {}), model: uid } }, vscode.ConfigurationTarget.Global);
  });
  const modelPreference = () => globalSetting(vscode.workspace.getConfiguration('devin.acp'), 'agentPreferences')['devin-cli']?.model;
  const reconcileSelection = async currentCatalog => write(async () => {
    const settings = vscode.workspace.getConfiguration('devin.acp');
    const preferences = globalSetting(settings, 'agentPreferences'), current = preferences['devin-cli']?.model;
    const isOwnSelection = uid => typeof uid === 'string' &&
      (/^(?:fusion-)?dfbyok-/.test(uid) || (currentCatalog.matrixUids instanceof Set && currentCatalog.matrixUids.has(uid)));
    if (!isOwnSelection(current) || currentCatalog.models.some(model => model.uid === current)) return;
    const receipt = readReceipt(root, extensionPath);
    const changes = receipt.changes.filter(change => change.path[0] === 'devin.acp.agentPreferences');
    const restored = restoreObject({ 'devin.acp.agentPreferences': preferences }, changes).value['devin.acp.agentPreferences'];
    if (isOwnSelection(restored['devin-cli']?.model)) delete restored['devin-cli'].model;
    await settings.update('agentPreferences', restored, vscode.ConfigurationTarget.Global);
  });
  // Restores only the settings values this extension wrote and the user has not
  // changed since, using the receipt. Does not touch the plugin's own enabled flag.
  const restore = async ({ keepReceipt = false } = {}) => {
    const settings = vscode.workspace.getConfiguration('devin.acp');
    const snapshot = { 'devin.acp.agentEnv': globalSetting(settings, 'agentEnv'), 'devin.acp.agentPreferences': globalSetting(settings, 'agentPreferences') };
    const receipt = readReceipt(root, extensionPath);
    const managed = globalState.get('managedEnv', {}), saved = globalState.get('savedEnv', {});
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
      await globalState.update('savedEnv', undefined);
      await globalState.update('managedEnv', undefined);
    }
  };
  return { openWrites, drainWrites, applyEnvironment, saveModel, modelPreference, reconcileSelection, restore };
}

module.exports = { createSettingsOwner };

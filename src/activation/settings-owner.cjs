'use strict';
const { readReceipt, remember, saveReceipt, valueAt, restoreObject, permitted } = require('../lifecycle/owned-settings.cjs');
const { globalSetting } = require('./settings.cjs');
const { RuntimeError } = require('./errors.cjs');
const { createManagedSettingsGate } = require('./managed-settings.cjs');
const { buildCliEnvironment } = require('./cli-environment.cjs');
const { readProxySettings } = require('./proxy-settings.cjs');

function createSettingsOwner({ root, extensionPath, vscode, globalState, isLive, env = process.env }) {
  const gate = createManagedSettingsGate();
  // Every settings write goes through the gate so a disable can drain it before
  // restoring; writes attempted after close are cancelled rather than landing
  // on top of the restored values.
  const write = async fn => {
    if (!isLive()) throw new RuntimeError('cancelled');
    // The liveness check is repeated when the entry finally runs: a queued
    // write accepted before a disable must not land after the restore.
    try {
      return await gate.critical(() => {
        if (!isLive()) throw new RuntimeError('cancelled');
        return fn();
      });
    } catch (error) { if (error?.code === 'cancelled') throw new RuntimeError('cancelled'); throw error; }
  };
  const openWrites = () => gate.open();
  const drainWrites = () => gate.drain();
  // The whole leg — reading the current settings, deriving the originals, the
  // receipt, the globalState backups and the settings write — runs inside one
  // critical entry. Reading a snapshot outside the gate would let a queued
  // writer commit an originals map computed from a document that no longer
  // exists.
  // `proxyConfig` is the raw configuration the backend already accepted, handed
  // in by the caller so this write cannot observe a newer, unaccepted policy: a
  // queued writer must apply the snapshot its own operation settled on. Only an
  // independent caller omits it and lets the owner read the live settings.
  const applyEnvironment = async proxyConfig => write(async () => {
    const settings = vscode.workspace.getConfiguration('devin.acp');
    const existing = globalSetting(settings, 'agentEnv');
    const previous = { ...(existing['devin-cli'] || {}) };
    const receipt = readReceipt(root, extensionPath);
    const saved = { ...globalState.get('savedEnv', {}) };
    const managed = globalState.get('managedEnv', {});
    // What the user's own environment would be if this extension had never
    // written: receipt first, then the older globalState-only backups. Starting
    // from here (not from the current values) is what stops a shrinking proxy
    // bypass list from accumulating every host it ever contained.
    const original = { ...(restoreObject({ 'devin.acp.agentEnv': existing }, receipt.changes)
      .value['devin.acp.agentEnv']?.['devin-cli'] || {}) };
    const recorded = key => receipt.changes.some(change =>
      JSON.stringify(change.path) === JSON.stringify(['devin.acp.agentEnv', 'devin-cli', key]));
    for (const [key, value] of Object.entries(managed)) {
      // A receipt entry is authoritative for its original even when that value
      // happens to equal the managed string; the older globalState backup only
      // fills the gap where the receipt has no record at all.
      if (recorded(key)) continue;
      if (original[key] === value && Object.hasOwn(saved, key)) {
        if (saved[key] == null) delete original[key]; else original[key] = saved[key];
      }
    }
    let desired;
    try {
      const snapshot = proxyConfig === undefined ? readProxySettings(vscode, env).config : proxyConfig;
      desired = buildCliEnvironment({ proxyConfig: snapshot, original });
    }
    catch { throw new RuntimeError('proxy_unavailable'); }
    // A managed key that is no longer desired goes back to the user's own value
    // only while the setting still holds what we last wrote; a later user edit
    // is theirs.
    for (const [key, value] of Object.entries(managed)) {
      if (key in desired || previous[key] !== value) continue;
      if (Object.hasOwn(original, key)) previous[key] = original[key]; else delete previous[key];
    }
    // Always refreshed, not only on first management: with the receipt gone the
    // legacy backup is the only path back to what the user last set.
    for (const key of Object.keys(desired)) {
      saved[key] = Object.hasOwn(original, key) ? original[key] : null;
    }
    // `remember` keeps a receipt entry's first original while the setting still
    // holds the managed value, and adopts the user's own edit otherwise — so a
    // mid-management NO_PROXY edit survives the next restore.
    for (const [key, value] of Object.entries(desired)) {
      const current = valueAt({ 'devin.acp.agentEnv': existing }, ['devin.acp.agentEnv', 'devin-cli', key]);
      const legacy = Object.hasOwn(managed, key) && managed[key] === current.value && Object.hasOwn(saved, key)
        ? saved[key] == null ? { exists: false } : { exists: true, value: saved[key] } : undefined;
      remember(receipt, ['devin.acp.agentEnv', 'devin-cli', key], current, value, legacy);
    }
    // Commit recovery information before changing the user's settings. The
    // whole write leg is one critical section: a disable that lands mid-write
    // drains it before restoring, and one already draining cancels it.
    saveReceipt(receipt);
    await globalState.update('savedEnv', saved);
    await globalState.update('managedEnv', desired);
    if (Object.keys(managed).some(k => !(k in desired)) || Object.entries(desired).some(([k, v]) => previous[k] !== v)) await settings.update('agentEnv', { ...existing, 'devin-cli': { ...previous, ...desired } }, vscode.ConfigurationTarget.Global);
  });
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

'use strict';
const { updateConfig } = require('../config/store.cjs');

function createSelection({ config, configFile, catalog, settingsOwner, isLive, isReconcileHalted, log, publish }) {
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
  const saveFusionChoice = async uid => {
    await settingsOwner.saveModel(uid);
    // Publishing must not stretch the drain budget, and a choice that landed
    // while disabling is restored anyway — skip the side effects then.
    if (!isLive()) return;
    rememberFusion(uid);
    await publish?.();
  };
  let reconcileQueue = Promise.resolve();
  const reconcilePreference = () => {
    const operation = reconcileQueue.then(async () => {
      if (isReconcileHalted() || config().enabled === false) return;
      const current = settingsOwner.modelPreference();
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
      if (remembered) await saveFusionChoice(remembered);
    }).catch(error => { if (error?.code !== 'cancelled') log('preference-reconcile-error'); });
    reconcileQueue = operation;
    return operation;
  };
  const reconcileSelection = async () => {
    if (!isLive()) return;
    await settingsOwner.reconcileSelection(catalog());
  };
  return { saveFusionChoice, reconcilePreference, reconcileSelection };
}

module.exports = { createSelection };

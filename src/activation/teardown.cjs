'use strict';

async function teardown(lifecycle) {
  try { lifecycle.goalController?.suspend({ reason: 'disabled' }); } catch {}
  lifecycle.resetAutoContinue?.();
  lifecycle.stopNativeSync?.(); lifecycle.stopNativeSync = undefined;
  lifecycle.activationGeneration++; lifecycle.runtimeWaitAbort?.abort(); lifecycle.reconcileHalted = true;
  if (lifecycle.connection) { const current = lifecycle.connection; lifecycle.connection = undefined; await current.dispose(); }
  try { lifecycle.acpObserver?.dispose?.(); } catch {}
  lifecycle.acpObserver = undefined;
}

module.exports = { teardown };

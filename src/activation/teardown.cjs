'use strict';

// Tears down the activated state: hooks, bridge, observers. The auth hook is
// deactivated first so no native call in the teardown window is still being
// rewritten; the wrapper member itself is restored in the finally below.
async function teardown(lifecycle) {
  try { lifecycle.goalController?.suspend({ reason: 'disabled' }); } catch {}
  lifecycle.resetAutoContinue?.();
  lifecycle.stopNativeSync?.(); lifecycle.stopNativeSync = undefined;
  lifecycle.activationGeneration++; lifecycle.runtimeWaitAbort?.abort(); lifecycle.reconcileHalted = true;
  try { lifecycle.upstreamPushAbort?.abort(); } catch {}
  const auth = lifecycle.authStatus;
  if (auth) {
    // Deactivating makes the wrapper inert before the LS bridge dispose runs;
    // it must not depend on that bridge being alive.
    try { auth.deactivate?.(); } catch {}
  }
  try {
    if (lifecycle.connection) { const current = lifecycle.connection; lifecycle.connection = undefined; await current.dispose(); }
  } finally {
    try { lifecycle.acpObserver?.dispose?.(); } catch {}
    lifecycle.acpObserver = undefined;
    try { lifecycle.authStatus?.dispose?.(); } catch {}
    lifecycle.authStatus = undefined;
    try { lifecycle.remoteSupport?.stop?.(); } catch {}
  }
}

module.exports = { teardown };

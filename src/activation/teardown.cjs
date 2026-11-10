'use strict';

// Tears down the activated state: hooks, bridge, observers. The auth hook is
// deactivated first so no native call in the teardown window is still being
// rewritten; the wrapper member itself is restored in the finally below.
async function teardown(state, { continuation, catalogSync }) {
  try { continuation.suspend({ reason: 'disabled' }); } catch {}
  continuation.resetAutoContinue();
  catalogSync.stop();
  state.activationGeneration++; state.runtimeWaitAbort?.abort(); state.reconcileHalted = true;
  try { state.upstreamPushAbort?.abort(); } catch {}
  const auth = state.authStatus;
  if (auth) {
    // Deactivating makes the wrapper inert before the LS bridge dispose runs;
    // it must not depend on that bridge being alive.
    try { auth.deactivate?.(); } catch {}
  }
  try {
    if (state.connection) { const current = state.connection; state.connection = undefined; await current.dispose(); }
  } finally {
    try { state.acpObserver?.dispose?.(); } catch {}
    state.acpObserver = undefined;
    try { state.authStatus?.dispose?.(); } catch {}
    state.authStatus = undefined;
    try { state.remoteSupport?.stop?.(); } catch {}
  }
}

module.exports = { teardown };

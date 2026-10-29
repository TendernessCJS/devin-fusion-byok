'use strict';

// `restore` is the explicit-disable path only: after the hook stops augmenting
// it observes one passthrough native refresh to verify the stored catalog
// carries no residual own entries before the wrapper comes off. A plain
// deactivate/reload skips that refresh entirely — no new network work on the
// way out. Everything waits on a bound: an unverified restore is logged as
// 'restore-unverified', never claimed and never replayed.
// Returns a structured catalog verdict: {ok, code} — 'restored' only when the
// passthrough probe actually confirmed a clean store; every other outcome
// (no hook, failed drain, timeout, unverified payload) is unverified. A plain
// unload passes restore:false and skips network work entirely.
async function teardown(lifecycle, { restore = false } = {}) {
  const verdict = { ok: false, code: 'restore-not-requested' };
  try { lifecycle.goalController?.suspend({ reason: 'disabled' }); } catch {}
  lifecycle.resetAutoContinue?.();
  lifecycle.stopNativeSync?.(); lifecycle.stopNativeSync = undefined;
  lifecycle.activationGeneration++; lifecycle.runtimeWaitAbort?.abort(); lifecycle.reconcileHalted = true;
  try { lifecycle.upstreamPushAbort?.abort(); } catch {}
  try { lifecycle.publication?.dispose?.(); lifecycle.publication = undefined; } catch {}
  const auth = lifecycle.authStatus;
  if (auth) {
    // Deactivating makes the wrapper inert before the LS bridge dispose runs;
    // it must not depend on that bridge being alive.
    try { auth.deactivate?.(); } catch {}
    if (restore && typeof lifecycle.nativeRefresh === 'function') {
      let drained = false;
      try { drained = typeof auth.drain === 'function' ? await auth.drain({ timeoutMs: 10000 }) : true; } catch { drained = false; }
      if (drained && typeof auth.restore === 'function') {
        try {
          const probe = await auth.restore({ command: lifecycle.nativeRefresh, timeoutMs: 10000 });
          verdict.ok = probe?.ok === true;
          verdict.code = probe?.code || 'restore-unverified';
        } catch { verdict.code = 'restore-unverified'; }
      } else {
        verdict.code = 'restore-unverified';
      }
      if (!verdict.ok) lifecycle.log?.('desktop-catalog-restore', { code: verdict.code });
    }
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
  return verdict;
}

module.exports = { teardown };

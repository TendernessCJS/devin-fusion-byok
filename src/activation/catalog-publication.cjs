'use strict';
const { catalogSignature } = require('../catalog.cjs');

const MERGE_MS = 1500;
const RETRY_MS = 5000;
const WATCHDOG_MS = 10000;
const MAX_ATTEMPTS_PER_SIGNATURE = 2;
const WINDOW_MS = 60000;
const MAX_ATTEMPTS_PER_WINDOW = 6;
const CONFIRM_MS = 5000;

// The single coordinator for publishing the merged catalog into the stored
// desktop auth status. A content change schedules one coalesced refresh
// command; the command completing is never the confirmation — only the auth
// hook's `applied` event carrying the same signature proves the native API
// accepted this exact emit. The in-flight lock is owned by the command object
// itself and is released only by that command's settle: hook events (matching
// `applied` included) never release it, because the command may still land a
// write after an earlier event was observed. Automatic attempts are budgeted
// (2 per target, 6 per rolling minute) so a broken path degrades instead of
// hammering.
//
// Call ordering is tracked by the hook's monotonically increasing callId: a
// `cleared` watermark retires every earlier call (a pre-logout commit can never
// restore `ready`, only a post-clear matching `applied` can), and a commit whose
// signature differs from the current target may have overwritten the store — a
// `ready` that turns out to describe foreign bytes is conservatively revoked as
// `stale-commit` and the target is repaired within the same budgets.
// Event contract: 'attempt' carries the call's emit signature (null when the
// call passed through unverified); 'failed' gains `nativeApplied: true` when
// the native write itself landed but the emit could not be verified — the
// store's content is then unknown, while a plain native failure wrote nothing.
function createCatalogPublication({ getCatalog, refreshUserStatus, isCurrent = () => true, log = () => {}, clock } = {}) {
  const now = () => (clock?.now ? clock.now() : Date.now());
  const setTimer = (fn, ms) => (clock?.set ? clock.set(fn, ms) : setTimeout(fn, ms));
  const clearTimer = handle => {
    if (handle === undefined || handle === null) return;
    if (clock?.clear) clock.clear(handle); else clearTimeout(handle);
  };

  const supported = typeof refreshUserStatus === 'function';
  let disposed = false;
  let state = supported ? 'pending' : 'unsupported';
  let code = supported ? undefined : 'refresh-unavailable';
  let target = null;          // { signature, attempts } — kept after ready
  let inFlight = null;        // command token — released only by its own settle
  let manualQueued = false;   // a force: true waiting for the lock
  let mergeTimer, retryTimer, watchdogTimer, confirmTimer;
  const window = [];          // timestamps of automatic attempts (rolling 60s)
  const calls = new Map();    // callId -> signature, hook calls not yet settled
  let clearWatermark = 0;     // callId of the most recent `cleared`
  let committed = null;       // { callId, signature } of the latest observed commit
  let waitingAuth = false;    // sign-out pause: a flag, not a state, so a
                              // watchdog downgrade can never re-arm auto work

  const setState = (next, nextCode) => { state = next; code = nextCode; };

  function pruneWindow() {
    const cutoff = now() - WINDOW_MS;
    while (window.length && window[0] <= cutoff) window.shift();
  }

  function scheduleRetry() {
    if (disposed || !target) return;
    if (waitingAuth) return;
    if (target.attempts >= MAX_ATTEMPTS_PER_SIGNATURE) { setState('degraded', 'attempt-budget'); return; }
    clearTimer(retryTimer);
    retryTimer = setTimer(() => { retryTimer = undefined; attempt(false); }, RETRY_MS);
  }

  // A commit observed with a different signature means the store now holds
  // foreign bytes: any earlier `ready` described them, so it is revoked and
  // the current target is re-published within the existing budgets.
  function repair() {
    try { log('desktop-catalog-stale-commit', { signature: target?.signature }); } catch {}
    if (!inFlight) attempt(false);
    // attempt() may have issued a command (state 'pending') or refused through
    // the budget ('degraded') — keep that verdict and just tag the cause.
    if (state === 'pending') code = 'stale-commit';
    else if (state !== 'degraded') setState('pending', 'stale-commit');
  }

  // The store is confirmed only when the latest commit matches the current
  // target and no pending call could still overwrite it with other content.
  function reevaluate() {
    if (!target || !committed) return;
    if (committed.callId <= clearWatermark) return;
    if (committed.signature !== target.signature) return;
    for (const signature of calls.values()) if (signature !== committed.signature) return;
    setState('ready');
  }

  function settle(token, ok) {
    if (inFlight !== token) return;
    inFlight = null;
    clearTimer(watchdogTimer); watchdogTimer = undefined;
    if (disposed) return;
    // The lock frees before anything else, so a queued manual always runs —
    // even when this command failed.
    if (manualQueued) { manualQueued = false; attempt(true); return; }
    // A newer target queued behind this command goes out by the automatic
    // budget whether the command resolved, rejected or was manual.
    if (target && target.signature !== token.signature) { attempt(false); return; }
    if (!ok) {
      // A confirmed commit already stands: the late rejection cannot undo it.
      if (state === 'ready') return;
      // A manual command earns no automatic retry — it degrades, never
      // re-queues and never spends the automatic budget.
      if (token.manual) { setState('degraded', 'command-failed'); return; }
      scheduleRetry();
      return;
    }
    if (target && state !== 'ready') {
      // Settlement is never confirmation: every emit — manual or automatic —
      // gets the same bounded window for its matching applied event.
      clearTimer(confirmTimer);
      confirmTimer = setTimer(() => {
        confirmTimer = undefined;
        if (!target || target.signature !== token.signature || state === 'ready') return;
        if (token.manual) setState('degraded', 'manual-unconfirmed');
        else scheduleRetry();
      }, CONFIRM_MS);
    }
  }

  function attempt(manual) {
    if (disposed || !target) return;
    if (inFlight) { if (manual) manualQueued = true; return; }
    // Signed out: the target stays queued but no automatic loop runs; an
    // explicit user force may still fire one manual request.
    if (waitingAuth && !manual) return;
    if (manual) manualQueued = false;
    clearTimer(mergeTimer); mergeTimer = undefined;
    clearTimer(retryTimer); retryTimer = undefined;
    clearTimer(confirmTimer); confirmTimer = undefined;
    if (!isCurrent()) { setState('unsupported', 'inactive'); return; }
    if (!manual) {
      pruneWindow();
      if (target.attempts >= MAX_ATTEMPTS_PER_SIGNATURE || window.length >= MAX_ATTEMPTS_PER_WINDOW) {
        setState('degraded', 'attempt-budget');
        try { log('desktop-catalog-budget', { signature: target.signature }); } catch {}
        return;
      }
      target.attempts += 1;
      window.push(now());
    }
    const token = { signature: target.signature, manual };
    inFlight = token;
    clearTimer(watchdogTimer);
    watchdogTimer = setTimer(() => {
      watchdogTimer = undefined;
      // A command that never settles is reported as degraded, but the lock is
      // NOT released: releasing it would start a parallel refresh while this
      // one may still land a write.
      if (inFlight === token) {
        // The lock is NOT released — the report must not overwrite the
        // signed-out pause into something that can restart automatic work.
        if (!waitingAuth) setState('degraded', 'command-watchdog');
        try { log('desktop-catalog-watchdog', { signature: token.signature }); } catch {}
      }
    }, WATCHDOG_MS);
    setState('pending');
    let outcome, threw = true;
    try { outcome = refreshUserStatus(); threw = false; } catch { outcome = null; }
    // A synchronous throw is a command failure like any rejection — it must not
    // masquerade as a completed call, so it follows the failure settle path.
    if (threw) { settle(token, false); return; }
    Promise.resolve(outcome).then(() => settle(token, true), () => settle(token, false));
  }

  const changed = ({ force = false } = {}) => {
    if (disposed || !supported) return status();
    if (!isCurrent()) { setState('unsupported', 'inactive'); return status(); }
    let signature;
    try { signature = catalogSignature(getCatalog()); } catch { signature = null; }
    if (signature === null) { setState('degraded', 'signature-unavailable'); return status(); }
    const different = !target || target.signature !== signature;
    if (different) {
      target = { signature, attempts: 0 };
      if (!waitingAuth) setState('pending');
    }
    if (force) {
      clearTimer(mergeTimer); mergeTimer = undefined;
      clearTimer(retryTimer); retryTimer = undefined;
      clearTimer(confirmTimer); confirmTimer = undefined;
      manualQueued = true;
      if (!inFlight) {
        mergeTimer = setTimer(() => {
          mergeTimer = undefined;
          if (manualQueued) { manualQueued = false; attempt(true); }
        }, MERGE_MS);
      }
      return status();
    }
    if (!different || waitingAuth) return status();
    clearTimer(retryTimer); retryTimer = undefined;
    clearTimer(confirmTimer); confirmTimer = undefined;
    if (mergeTimer) { clearTimer(mergeTimer); mergeTimer = undefined; }
    mergeTimer = setTimer(() => {
      mergeTimer = undefined;
      attempt(manualQueued);
    }, MERGE_MS);
    return status();
  };

  const observe = event => {
    if (disposed || !event || typeof event !== 'object') return;
    const { phase, signature, code: eventCode, callId } = event;
    // The hook-unavailable diagnostic is the only event allowed without a
    // positive integer callId; every real hook call carries one.
    if (phase === 'failed' && eventCode === 'hook-unavailable') { setState('degraded', 'hook-unavailable'); return; }
    if (!Number.isSafeInteger(callId) || callId <= 0) return;
    if (phase === 'attempt') {
      calls.set(callId, signature ?? null);
      // A call carrying a different emit (or none) may still overwrite the
      // store while in flight — `ready` must wait out its settle.
      if (state === 'ready' && signature !== target?.signature) setState('pending');
      return;
    }
    if (phase === 'cleared') {
      // Sign-out retires every earlier confirmation: pre-clear commits are
      // inert, and the target stays queued for the next confirmed call.
      clearWatermark = Math.max(clearWatermark, callId);
      committed = null;
      waitingAuth = true;
      clearTimer(mergeTimer); mergeTimer = undefined;
      clearTimer(retryTimer); retryTimer = undefined;
      clearTimer(confirmTimer); confirmTimer = undefined;
      manualQueued = false;
      setState('waiting-auth');
      return;
    }
    if (phase === 'applied') {
      calls.delete(callId);
      if (callId <= clearWatermark) {
        if (!waitingAuth && target) { committed = null; repair(); }
        return;
      }
      committed = { callId, signature };
      // A real post-clear commit is the only thing that ends the sign-out
      // pause — a pre-clear call that settles late can never lift it.
      waitingAuth = false;
      if (!target) return;
      if (signature === target.signature) { reevaluate(); return; }
      // A foreign commit landed: ours is not what the store holds.
      repair();
      return;
    }
    if (phase === 'failed') {
      calls.delete(callId);
      if (!target || waitingAuth) return;
      if (event.nativeApplied === true) {
        // The native write landed but the emit was never verified: the store's
        // content is unknown now, so the committed signature must not stand.
        committed = null;
        repair();
        return;
      }
      // A true native failure wrote nothing; with the call gone the committed
      // signature may already match — re-evaluate instead of degrading.
      reevaluate();
    }
  };

  const status = () => Object.freeze(code === undefined ? { state } : { state, code });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimer(mergeTimer); mergeTimer = undefined;
    clearTimer(retryTimer); retryTimer = undefined;
    clearTimer(watchdogTimer); watchdogTimer = undefined;
    clearTimer(confirmTimer); confirmTimer = undefined;
  };

  return { changed, observe, status, dispose };
}

module.exports = { createCatalogPublication };

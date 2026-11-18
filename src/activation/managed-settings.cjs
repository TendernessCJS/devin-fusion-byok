'use strict';
// Serializes the enable-time managed settings writes against disable-time
// restore: a write that has started must finish before teardown restores, and
// a write that starts after close must fail instead of landing afterwards.
// Entries run strictly one at a time in arrival order — the receipt and the
// globalState backups are read inside the critical section, so two concurrent
// writers must never observe the same snapshot.
function createManagedSettingsGate({ timeoutMs = 5000 } = {}) {
  let closed = false, epoch = 0;
  let tail = Promise.resolve();
  const inFlight = new Set();
  const cancelled = () => Object.assign(new Error('cancelled'), { code: 'cancelled' });
  const critical = fn => {
    if (closed) throw cancelled();
    const accepted = epoch;
    const pending = tail.then(() => {
      // A drain before this entry started cancels it; a drain after it started
      // only waits for it (closed turns true, but the body already runs).
      if (closed || accepted !== epoch) throw cancelled();
      return fn();
    });
    tail = pending.catch(() => {});
    inFlight.add(pending);
    pending.finally(() => inFlight.delete(pending)).catch(() => {});
    return pending;
  };
  // Every accepted entry is drained — queued ones settle as cancelled, the one
  // already running is allowed to finish. The timeout only bounds an entry that
  // is still working; the timer never outlives the wait.
  const drain = async () => {
    closed = true;
    epoch += 1;
    if (!inFlight.size) return true;
    let timer;
    // The timer is a real handle: a drain must reach its verdict on time even
    // when nothing else keeps the loop alive, and it is cleared the moment every
    // entry settles.
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
    try {
      return await Promise.race([Promise.allSettled([...inFlight]).then(() => true), timeout]);
    } finally { clearTimeout(timer); }
  };
  const open = () => { closed = false; epoch += 1; };
  return { open, critical, drain };
}

module.exports = { createManagedSettingsGate };

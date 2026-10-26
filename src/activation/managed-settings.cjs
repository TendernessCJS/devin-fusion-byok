'use strict';
// Serializes the enable-time managed settings writes against disable-time
// restore: a write that has started must finish before teardown restores, and
// a write that starts after close must fail instead of landing afterwards.
function createManagedSettingsGate({ timeoutMs = 5000 } = {}) {
  let closed = false;
  const inFlight = new Set();
  const open = () => { closed = false; };
  const critical = fn => {
    if (closed) { const error = new Error('cancelled'); error.code = 'cancelled'; throw error; }
    const pending = (async () => fn())();
    inFlight.add(pending);
    pending.finally(() => inFlight.delete(pending)).catch(() => {});
    return pending;
  };
  const drain = async () => {
    closed = true;
    const deadline = Date.now() + timeoutMs;
    while (inFlight.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      const finished = await Promise.race([
        Promise.allSettled([...inFlight]).then(() => true),
        new Promise(resolve => setTimeout(resolve, remaining)).then(() => false),
      ]);
      if (!finished) return false;
    }
    return true;
  };
  return { open, critical, drain };
}

module.exports = { createManagedSettingsGate };

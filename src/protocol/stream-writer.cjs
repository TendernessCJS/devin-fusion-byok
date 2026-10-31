'use strict';

// One-shot frame transport for a connect+proto response. Each write() flushes
// exactly one frame; when the kernel buffer fills it waits for a single drain
// with a deadline. Drain, close, error and abort all settle that wait exactly
// once, and every exit path removes its own listeners and timer. No queue and
// no retries — the caller awaits each write in order.
function createStreamWriter({ res, signal = null, timeoutMs = 120000, onTimeout = null }) {
  let disposed = false;
  const pendings = new Set();
  const closedError = () => new Error('Client closed');
  const gone = () => disposed || signal?.aborted || res.destroyed || res.writableEnded;

  function settle(entry, fn, value) {
    if (entry.done) return;
    entry.done = true;
    pendings.delete(entry);
    if (entry.timer) clearTimeout(entry.timer);
    res.off('drain', entry.drained);
    res.off('close', entry.closed);
    res.off('error', entry.closed);
    signal?.removeEventListener('abort', entry.closed);
    fn(value);
  }

  async function write(buffer) {
    if (gone()) throw closedError();
    if (res.write(buffer)) return;
    await new Promise((resolve, reject) => {
      const entry = {
        reject,
        timer: null,
        done: false,
        drained: () => settle(entry, resolve),
        closed: () => settle(entry, reject, closedError()),
      };
      res.once('drain', entry.drained);
      res.once('close', entry.closed);
      res.once('error', entry.closed);
      signal?.addEventListener('abort', entry.closed, { once: true });
      entry.timer = setTimeout(() => {
        try { onTimeout?.({ timeoutMs }); } catch { /* Diagnostics cannot fail the request. */ }
        try { res.destroy?.(); } catch { /* The socket may already be gone. */ }
        const err = closedError();
        err.code = 'client_backpressure_timeout';
        settle(entry, reject, err);
      }, timeoutMs);
      entry.timer.unref?.();
      pendings.add(entry);
      // The client may have left between res.write() and listener setup.
      if (gone()) settle(entry, reject, closedError());
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const entry of [...pendings]) settle(entry, entry.reject, closedError());
  }

  return { write, dispose };
}

module.exports = { createStreamWriter };

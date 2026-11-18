'use strict';
// Shared transfer policy for both self-update transports. The allowlist is
// resolved through ./url-policy.cjs with member access, so a test that swaps
// `allowedUrl` reaches both transports.
//
// `open(target, { signal })` adapts one transport and resolves
// `{ status, location, length, body, cancel, rateLimitRemaining }`: `body` is
// an async iterable of Buffers (null when the response carries none), `cancel`
// releases it, and `rateLimitRemaining` is the provider's
// x-ratelimit-remaining header value when the transport exposes one.
const policy = require('./url-policy.cjs');

class TransferError extends Error {
  constructor(code, status, rateLimitRemaining) {
    super(code);
    this.code = code;
    if (code === 'http' && Number.isInteger(status) && status >= 100 && status <= 599) {
      this.status = status;
      this.rateLimited = status === 429 || (status === 403 && rateLimitRemaining === '0');
    }
  }
}

const cancel = async response => { try { await response.cancel(); } catch {} };

async function transferBytes(url, { limit, signal, timeout = 30000, open }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeout);
  try {
    for (let hops = 0; hops <= 5; hops++) {
      if (controller.signal.aborted) throw new TransferError('aborted');
      let target;
      try { target = policy.allowedUrl(url); } catch { throw new TransferError('url'); }
      let response;
      try { response = await open(target, { signal: controller.signal }); }
      catch (error) { if (controller.signal.aborted) throw new TransferError('aborted'); throw error; }
      if (controller.signal.aborted) { await cancel(response); throw new TransferError('aborted'); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await cancel(response);
        const location = response.location; if (!location) throw new TransferError('redirect');
        try { url = new URL(location, target).href; }
        catch { throw new TransferError('redirect'); }
        continue;
      }
      if (response.status !== 200) { await cancel(response); throw new TransferError('http', response.status, response.rateLimitRemaining); }
      if (Number(response.length) > limit) { await cancel(response); throw new TransferError('size'); }
      const chunks = []; let size = 0;
      try {
        for await (const chunk of response.body) {
          if (controller.signal.aborted) { await cancel(response); throw new TransferError('aborted'); }
          size += chunk.length;
          if (size > limit) { await cancel(response); throw new TransferError('size'); }
          chunks.push(Buffer.from(chunk));
        }
      } catch (error) { if (controller.signal.aborted) throw new TransferError('aborted'); throw error; }
      if (controller.signal.aborted) throw new TransferError('aborted');
      return Buffer.concat(chunks);
    }
    throw new TransferError('redirect');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

module.exports = { transferBytes, TransferError };

'use strict';
// Shared transfer policy for both self-update transports. The allowlist is
// resolved through ./url-policy.cjs with member access, so a test that swaps
// `allowedUrl` reaches both transports.
//
// `open(target, { signal })` adapts one transport and resolves
// `{ status, location, length, body, cancel }`: `body` is an async iterable of
// Buffers (null when the response carries none) and `cancel` releases it.
const policy = require('./url-policy.cjs');

async function transferBytes(url, { limit, signal, timeout = 30000, open }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeout);
  try {
    for (let hops = 0; hops <= 5; hops++) {
      const target = policy.allowedUrl(url);
      let response;
      try { response = await open(target, { signal: controller.signal }); }
      catch (error) { if (controller.signal.aborted) throw Error('aborted'); throw error; }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.cancel();
        const location = response.location; if (!location) throw Error('redirect');
        url = new URL(location, target).href; continue;
      }
      if (response.status !== 200 || Number(response.length) > limit) { await response.cancel(); throw Error('http'); }
      const chunks = []; let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > limit || controller.signal.aborted) { await response.cancel(); throw Error('size'); }
          chunks.push(Buffer.from(chunk));
        }
      } catch (error) { if (controller.signal.aborted) throw Error('aborted'); throw error; }
      if (controller.signal.aborted) throw Error('aborted');
      return Buffer.concat(chunks);
    }
    throw Error('redirect');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

module.exports = { transferBytes };

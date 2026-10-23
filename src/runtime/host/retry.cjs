'use strict';
const CONNECTION_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);
function isConnectionFailure(error) {
  const code = error?.cause?.code ?? error?.code;
  return typeof code === 'string' && CONNECTION_CODES.has(code);
}
async function withConnectionRetry(operation, { attempts = 2, signal } = {}) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await operation(); }
    catch (error) {
      last = error;
      if (!isConnectionFailure(error) || signal?.aborted) throw error;
    }
  }
  throw last;
}
module.exports = { isConnectionFailure, withConnectionRetry };

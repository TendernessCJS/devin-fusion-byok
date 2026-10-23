'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isConnectionFailure, withConnectionRetry } = require('../src/runtime/host/retry.cjs');

test('isConnectionFailure reads the code directly and through error.cause', () => {
  assert.equal(isConnectionFailure(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
  assert.equal(isConnectionFailure(Object.assign(new Error('reset'), { cause: { code: 'UND_ERR_SOCKET' } })), true,
    'undici wraps the socket error in cause');
  for (const error of [undefined, null, new Error('plain'), { code: 42 }, { code: 'native_catalog_identity' }]) {
    assert.equal(isConnectionFailure(error), false, String(error?.code ?? error));
  }
});

test('a dropped keep-alive socket is retried once and then succeeds', async () => {
  let calls = 0;
  const value = await withConnectionRetry(async () => {
    if (++calls === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    return 'catalog';
  });
  assert.equal(value, 'catalog');
  assert.equal(calls, 2, 'one retry is enough for the reused-socket race');
});

test('validation failures are never retried and keep their exact identity', async () => {
  // Only connection-layer failures are retried: an identity or availability
  // verdict must never be masked as a transient blip or turned into a success.
  for (const code of ['native_catalog_identity', 'monitor_identity', 'native_catalog_unavailable']) {
    const error = Object.assign(new Error(code), { code });
    let calls = 0;
    await assert.rejects(withConnectionRetry(async () => { calls++; throw error; }), thrown => thrown === error);
    assert.equal(calls, 1, code + ' is not retried');
  }
});

test('an aborted signal stops the retry and surfaces the original error', async () => {
  const controller = new AbortController();
  const error = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
  let calls = 0;
  await assert.rejects(withConnectionRetry(async () => { calls++; controller.abort(); throw error; },
    { signal: controller.signal }), thrown => thrown === error);
  assert.equal(calls, 1, 'no retry once the caller aborted');
});

test('exhausted attempts rethrow the last connection failure', async () => {
  const errors = ['ECONNRESET', 'EPIPE'].map(code => Object.assign(new Error(code), { code }));
  let calls = 0;
  await assert.rejects(withConnectionRetry(async () => { throw errors[calls++]; }, { attempts: 2 }),
    thrown => thrown === errors[1]);
  assert.equal(calls, 2);
});

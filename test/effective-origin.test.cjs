'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveEffectiveOrigin } = require('../src/activation/effective-origin.cjs');

const ps = lines => async () => ({ stdout: lines.join('\n') });
const vscode = sections => ({ workspace: { getConfiguration: name => ({ get: key => sections[name]?.[key] }) } });
const LS = pid => `${pid} /x/language_server_macos_arm --api_server_url `;

test('a single LS process yields its --api_server_url argument', async () => {
  const r = await resolveEffectiveOrigin({ vscode: vscode({}), exec: ps([LS(100) + 'https://tenant.example.com']) });
  assert.deepEqual(r, { origin: 'https://tenant.example.com', source: 'ls-arg' });
});

test('the newest LS process wins when several are running', async () => {
  const r = await resolveEffectiveOrigin({ vscode: vscode({}), exec: ps([LS(200) + 'https://old.example.com', LS(900) + 'https://new.example.com']) });
  assert.deepEqual(r, { origin: 'https://new.example.com', source: 'ls-arg' });
});

test('a flag without a value falls through to portal', async () => {
  const v = vscode({ devin: { portalUrl: 'https://portal.example.com' } });
  const diags = [];
  const r = await resolveEffectiveOrigin({ vscode: v, exec: ps(['9 /x/language_server_macos_arm --api_server_url']), onDiag: info => diags.push(info) });
  assert.deepEqual(r, { origin: 'https://portal.example.com/_route/api_server', source: 'portal' });
  // An LS row that carries no usable value is still a rejected source, and
  // reporting an empty code list would say nothing about why.
  assert.deepEqual(diags, [{ dropped: ['flag'] }]);
});

test('no LS and a portal setting derives the route origin without a trailing slash', async () => {
  const v = vscode({ windsurf: { portalUrl: 'https://portal.example.com/' } });
  const r = await resolveEffectiveOrigin({ vscode: v, exec: ps([]) });
  assert.deepEqual(r, { origin: 'https://portal.example.com/_route/api_server', source: 'portal' });
});

test('windsurf.serviceUrl is the portal fallback', async () => {
  const v = vscode({ windsurf: { serviceUrl: 'https://svc.example.com' } });
  const r = await resolveEffectiveOrigin({ vscode: v, exec: ps([]) });
  assert.deepEqual(r, { origin: 'https://svc.example.com/_route/api_server', source: 'portal' });
});

test('no LS and no portal resets to the default upstream', async () => {
  const r = await resolveEffectiveOrigin({ vscode: vscode({}), exec: ps([]) });
  assert.deepEqual(r, { origin: null, source: 'default' });
});

test('an invalid LS argument is not adopted and falls back', async () => {
  const r = await resolveEffectiveOrigin({ vscode: vscode({}), exec: ps([LS(5) + 'http://evil.example.com']) });
  assert.deepEqual(r, { origin: null, source: 'default' });
});

test('a ps failure falls back without throwing', async () => {
  const r = await resolveEffectiveOrigin({ vscode: vscode({}), exec: async () => { throw new Error('ps failed'); } });
  assert.deepEqual(r, { origin: null, source: 'default' });
});

const { resolveEffectiveOriginWhenAvailable } = require('../src/activation/effective-origin.cjs');

test('a command line merely naming the binary mid-string is not an LS candidate', async () => {
  const lines = [
    '900 node -e "language_server_macos_arm --api_server_url https://evil-loopback.invalid"',
    '100 /Applications/Devin.app/bin/language_server_macos_arm --api_server_url https://real.example.com',
  ];
  const r = await resolveEffectiveOrigin({ vscode: vscode({}), exec: ps(lines) });
  assert.deepEqual(r, { origin: 'https://real.example.com', source: 'ls-arg' });
});

test('a newest candidate with an invalid argument falls to the next candidate', async () => {
  const lines = [
    '900 /x/language_server_macos_arm --api_server_url http://evil.example.com',
    '100 /x/language_server_macos_arm --api_server_url https://good.example.com',
  ];
  const r = await resolveEffectiveOrigin({ vscode: vscode({}), exec: ps(lines) });
  assert.deepEqual(r, { origin: 'https://good.example.com', source: 'ls-arg' });
});

const HOST_EXEC = '/Applications/Devin.app/Contents/MacOS/Devin';
const HOST_LS = pid => `${pid} /Applications/Devin.app/Contents/Resources/app/extensions/windsurf/bin/language_server_macos_arm --api_server_url `;

test('an LS process outside the host bundle cannot win on pid alone', async () => {
  const lines = [
    '900 /tmp/other-app/language_server_macos_arm --api_server_url https://unrelated.example.com',
    HOST_LS(100) + 'https://real.example.com',
  ];
  const r = await resolveEffectiveOrigin({ vscode: vscode({}), exec: ps(lines), execPath: HOST_EXEC });
  assert.deepEqual(r, { origin: 'https://real.example.com', source: 'ls-arg' });
});

test('an LS path merely mentioned in another process\'s arguments is not a source', async () => {
  const v = vscode({ devin: { portalUrl: 'https://portal.example.com' } });
  const lines = [
    '900 node /tmp/run.cjs /Applications/Devin.app/bin/language_server_macos_arm --api_server_url https://evil.example.com',
  ];
  const r = await resolveEffectiveOrigin({ vscode: v, exec: ps(lines), execPath: HOST_EXEC });
  assert.deepEqual(r, { origin: 'https://portal.example.com/_route/api_server', source: 'portal' });
});

test('a foreign-bundle LS alone falls through to the portal', async () => {
  const v = vscode({ devin: { portalUrl: 'https://portal.example.com' } });
  const lines = [
    '900 /tmp/other-app/language_server_macos_arm --api_server_url https://unrelated.example.com',
  ];
  const r = await resolveEffectiveOrigin({ vscode: v, exec: ps(lines), execPath: HOST_EXEC });
  assert.deepEqual(r, { origin: 'https://portal.example.com/_route/api_server', source: 'portal' });
});

test('a foreign-bundle LS reports dropped:bundle through onDiag', async () => {
  const diags = [];
  const lines = ['900 /tmp/other-app/language_server_macos_arm --api_server_url https://unrelated.example.com'];
  const r = await resolveEffectiveOrigin({ vscode: vscode({}), exec: ps(lines), execPath: HOST_EXEC,
    onDiag: info => diags.push(info) });
  assert.equal(r.source, 'default');
  assert.deepEqual(diags, [{ dropped: ['bundle'] }]);
});

test('an LS whose api_server_url is rejected reports dropped:origin', async () => {
  const diags = [];
  const lines = [HOST_LS(100) + 'http://evil.example.com'];
  const r = await resolveEffectiveOrigin({ vscode: vscode({}), exec: ps(lines), execPath: HOST_EXEC,
    onDiag: info => diags.push(info) });
  assert.equal(r.source, 'default');
  assert.deepEqual(diags, [{ dropped: ['origin'] }]);
});

test('an adopted LS never calls onDiag', async () => {
  const diags = [];
  const lines = [HOST_LS(100) + 'https://real.example.com'];
  const r = await resolveEffectiveOrigin({ vscode: vscode({}), exec: ps(lines), execPath: HOST_EXEC,
    onDiag: info => diags.push(info) });
  assert.equal(r.source, 'ls-arg');
  assert.deepEqual(diags, []);
});

test('the convergence window re-resolves until a non-default source appears', async () => {
  const waited = [];
  const seen = [ps([]), ps([LS(7) + 'https://late.example.com'])];
  const exec = async (...a) => seen.shift()(...a);
  const r = await resolveEffectiveOriginWhenAvailable({
    vscode: vscode({}), exec, delays: [10, 20, 30], sleep: async ms => waited.push(ms),
  });
  assert.equal(r.source, 'ls-arg');
  assert.deepEqual(waited, [10], 'the window stops at the first non-default result');
});

test('all-default resolutions run exactly 1 + delays.length passes', async () => {
  let calls = 0;
  const waited = [];
  const r = await resolveEffectiveOriginWhenAvailable({
    vscode: vscode({}), exec: async () => { calls++; return { stdout: '' }; },
    delays: [10, 20, 30], sleep: async ms => waited.push(ms),
  });
  assert.deepEqual(r, { origin: null, source: 'default' });
  assert.equal(calls, 4);
  assert.deepEqual(waited, [10, 20, 30]);
});

test('a throwing exec resolves to default inside the window too', async () => {
  const r = await resolveEffectiveOriginWhenAvailable({
    vscode: vscode({}), exec: async () => { throw new Error('ps'); }, delays: [5], sleep: async () => {},
  });
  assert.deepEqual(r, { origin: null, source: 'default' });
});

test('a false shouldContinue stops the window without sleeping again', async () => {
  let calls = 0, sleeps = 0;
  const r = await resolveEffectiveOriginWhenAvailable({
    vscode: vscode({}), exec: async () => { calls++; return { stdout: '' }; },
    delays: [10, 20], sleep: async () => { sleeps++; }, shouldContinue: () => false,
  });
  assert.equal(r.source, 'default');
  assert.equal(calls, 0, 'a dead window never spawns ps');
  assert.equal(sleeps, 0);
});

test('a pre-aborted signal never runs ps or reads the portal', async () => {
  let calls = 0, reads = 0;
  const controller = new AbortController();
  controller.abort();
  const v = { workspace: { getConfiguration: () => ({ get: () => { reads++; return 'https://portal.example.com'; } }) } };
  const r = await resolveEffectiveOriginWhenAvailable({
    vscode: v, exec: async () => { calls++; return { stdout: '' }; },
    signal: controller.signal, delays: [10], sleep: async () => {},
  });
  assert.deepEqual(r, { origin: null, source: 'default' });
  assert.equal(calls, 0);
  assert.equal(reads, 0);
});

test('an abort during the default sleep resolves promptly', async () => {
  const controller = new AbortController();
  let calls = 0;
  const keepalive = setInterval(() => {}, 250); // the default timer is unref'd
  try {
    const started = Date.now();
    setTimeout(() => controller.abort(), 20).unref();
    const r = await resolveEffectiveOriginWhenAvailable({
      vscode: vscode({}), exec: async () => { calls++; return { stdout: '' }; },
      signal: controller.signal, delays: [10000],
    });
    const elapsed = Date.now() - started;
    assert.equal(r.source, 'default');
    assert.equal(calls, 1, 'no re-resolution after abort');
    assert.ok(elapsed < 1000, `abort must interrupt the sleep, waited ${elapsed}ms`);
  } finally { clearInterval(keepalive); }
});

test('the signal reaches execFile and an aborted resolution does not re-check', async () => {
  const controller = new AbortController();
  const seen = [];
  let calls = 0, portalReads = 0;
  // Abort from inside the pending exec — not on a guessed timer — so the test
  // proves the signal reaches the real execFile options.
  const exec = (file, args, options) => {
    calls++;
    seen.push({ file, signal: options?.signal });
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' }));
      }, { once: true });
      setImmediate(() => controller.abort());
    });
  };
  const keepalive = setInterval(() => {}, 250);
  try {
    const v = { workspace: { getConfiguration: () => ({ get: () => { portalReads++; return 'https://portal.example.com'; } }) } };
    const r = await resolveEffectiveOriginWhenAvailable({
      vscode: v, exec, signal: controller.signal, delays: [50], sleep: async () => {},
    });
    assert.equal(calls, 1, 'no further ps after abort');
    assert.equal(seen[0].file, '/bin/ps');
    assert.ok(seen[0].signal instanceof AbortSignal, 'execFile receives the caller signal');
    assert.equal(seen[0].signal.aborted, true);
    assert.equal(portalReads, 0, 'an aborted resolution never falls back to the portal');
    assert.equal(r.source, 'default');
  } finally { clearInterval(keepalive); }
});

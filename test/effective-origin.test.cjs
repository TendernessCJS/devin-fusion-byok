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
  const r = await resolveEffectiveOrigin({ vscode: v, exec: ps(['9 /x/language_server_macos_arm --api_server_url']) });
  assert.deepEqual(r, { origin: 'https://portal.example.com/_route/api_server', source: 'portal' });
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
  assert.equal(calls, 1);
  assert.equal(sleeps, 0);
});

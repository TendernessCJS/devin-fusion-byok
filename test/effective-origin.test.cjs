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

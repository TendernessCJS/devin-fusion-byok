'use strict';
// The managed devin-cli environment must always be able to reach the local
// backend. A configured proxy therefore projects into NO_PROXY (both spellings)
// while the user's own bypass entries are carried through untouched; with no
// proxy at all the extension manages no bypass key, so its owner can withdraw
// the value it wrote earlier.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCliEnvironment } = require('../src/activation/cli-environment.cjs');

const BACKEND = 'http://127.0.0.1:39842';
const tokens = value => String(value).split(',').map(entry => entry.trim()).filter(Boolean);
const DIRECT = { httpProxy: '', httpsProxy: '', noProxy: [] };
const PROXY = { httpProxy: 'http://127.0.0.1:7897', httpsProxy: 'http://127.0.0.1:7897', noProxy: [] };

test('without a proxy the environment carries only the backend URL', () => {
  const desired = buildCliEnvironment({ proxyConfig: DIRECT, original: { NO_PROXY: 'corp.example', KEEP: 'k' } });
  assert.deepEqual(desired, { WINDSURF_API_SERVER_URL: BACKEND },
    'no bypass key is created when nothing routes through a proxy');
  assert.equal('NO_PROXY' in desired, false);
  assert.equal('no_proxy' in desired, false);
});

test('a configured proxy bypasses loopback under both variable spellings', () => {
  const desired = buildCliEnvironment({ proxyConfig: PROXY, original: { KEEP: 'k' } });
  assert.equal(desired.WINDSURF_API_SERVER_URL, BACKEND);
  assert.equal(desired.NO_PROXY, desired.no_proxy, 'clients disagree about case, so both must agree');
  for (const host of ['127.0.0.1', 'localhost', '::1']) assert.ok(tokens(desired.NO_PROXY).includes(host));
  assert.equal(desired.KEEP, undefined, 'unrelated original keys are not promoted into the managed env');
});

test('the policy bypass list, both original spellings and loopback merge without duplicates', () => {
  const desired = buildCliEnvironment({
    proxyConfig: {
      httpProxy: 'http://127.0.0.1:7897', httpsProxy: 'http://127.0.0.1:7897',
      noProxy: ['gf.com.cn', 'gf.com.cn', ' LOCALHOST ', 'intranet.example:8080'],
    },
    original: { NO_PROXY: 'corp.example,GF.com.cn', no_proxy: 'lower.example,corp.example' },
  });
  const merged = tokens(desired.NO_PROXY);
  assert.deepEqual(merged, ['gf.com.cn', 'LOCALHOST', 'intranet.example:8080', 'corp.example', 'lower.example',
    '127.0.0.1', '::1'], 'first spelling wins, later case variants are dropped');
  assert.equal(desired.no_proxy, desired.NO_PROXY);
  assert.ok(!merged.includes('gf.com.cn'.toUpperCase()), 'case-insensitive dedupe keeps one form');
});

test('a bypass entry with CIDR or wildcard text is carried through verbatim', () => {
  const desired = buildCliEnvironment({ proxyConfig: PROXY,
    original: { NO_PROXY: '10.0.0.0/8,*.internal.example' } });
  const merged = tokens(desired.NO_PROXY);
  assert.ok(merged.includes('10.0.0.0/8'));
  assert.ok(merged.includes('*.internal.example'));
});

test('the managed environment never carries a proxy address', () => {
  const desired = buildCliEnvironment({ proxyConfig: PROXY, original: {} });
  const serialized = JSON.stringify(desired);
  assert.doesNotMatch(serialized, /http:\/\/(?!127\.0\.0\.1:39842)/, 'only the backend URL is an address here');
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'])
    assert.equal(name in desired, false, name + ' is never written by the extension');
});

test('a non-string original defect is reported as proxy_invalid without echoing the value', () => {
  for (const original of [{ NO_PROXY: 42 }, { no_proxy: { hosts: ['x'] } }]) {
    assert.throws(() => buildCliEnvironment({ proxyConfig: PROXY, original }),
      error => error.code === 'proxy_invalid' && error.message === 'proxy_invalid',
      'the error carries a fixed code, never the offending value');
  }
});

test('an invalid policy is rejected by the shared compiler', () => {
  for (const proxyConfig of [{ ...PROXY, httpProxy: 'socks5://127.0.0.1:9' }, { ...PROXY, noProxy: [7] },
    { httpProxy: 'http://127.0.0.1:7897', httpsProxy: '' }]) {
    assert.throws(() => buildCliEnvironment({ proxyConfig, original: {} }),
      error => error.code === 'proxy_invalid');
  }
});

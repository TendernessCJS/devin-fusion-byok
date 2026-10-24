'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, releaseInfo, allowedUrl, createUpdater, requestBytes, verifyPackage, PAGE } = require('../src/update.cjs');
const release = version => ({ tag_name: 'v' + version, assets: [{ name: `devin-fusion-byok-${version}.vsix`, size: 10, digest: 'sha256:' + 'a'.repeat(64), browser_download_url: `${PAGE}/download/v${version}/devin-fusion-byok-${version}.vsix` }] });
function setup(extra = {}) {
  const data = new Map(); let calls = 0;
  const updater = createUpdater({ currentVersion: '0.3.33', globalState: { get: (k, d) => data.has(k) ? data.get(k) : d, update: async (k, v) => data.set(k, v) }, request: async () => { calls++; return Buffer.from(JSON.stringify(release('0.3.34'))); }, ...extra });
  return { updater, data, calls: () => calls };
}
test('stable versions compare numerically and reject invalid versions', () => {
  assert.equal(compareVersions('0.3.9', '0.3.33'), -1);
  assert.equal(compareVersions('0.3.33', '0.3.33'), 0);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  for (const v of ['1.0.0-beta', '01.0.0', 'x', '99999999999999999999.0.0']) assert.throws(() => compareVersions(v, '1.0.0'));
});
test('release accepts exact trusted artifact only', () => {
  assert.equal(releaseInfo(release('0.3.34')).installable, true);
  for (const flags of [{ draft: true }, { prerelease: true }, { tag_name: 'v1.0.0-beta' }]) assert.throws(() => releaseInfo({ ...release('0.3.34'), ...flags }));
  const noDigest = release('0.3.34'); delete noDigest.assets[0].digest;
  assert.equal(releaseInfo(noDigest).installable, false);
  const wrong = release('0.3.34'); wrong.assets[0].browser_download_url = 'https://evil.example/a.vsix';
  assert.equal(releaseInfo(wrong).installable, false);
  assert.equal(releaseInfo({ ...release('0.3.34'), assets: [] }).installable, false);
});
test('redirect policy rejects untrusted schemes credentials hosts and ports', () => {
  for (const url of ['http://github.com/a', 'https://github.com.evil.test/a', 'https://user:pass@github.com/a', 'https://github.com:8443/a']) assert.throws(() => allowedUrl(url));
  assert.equal(allowedUrl('https://release-assets.githubusercontent.com/a').hostname, 'release-assets.githubusercontent.com');
});
test('checks coalesce throttle persist and manual checks bypass', async () => {
  const { updater, calls } = setup();
  await Promise.all([updater.check(), updater.check()]); assert.equal(calls(), 1);
  assert.equal(updater.snapshot().phase, 'available');
  await updater.check(); assert.equal(calls(), 1);
  await updater.check({ force: true }); assert.equal(calls(), 2);
  await updater.ignore(); assert.equal(updater.snapshot().ignored, true);
  await updater.setAutoCheck(false); assert.equal(updater.snapshot().autoCheck, false);
  updater.dispose(); await updater.check({ force: true }); assert.equal(calls(), 2);
});
test('lower and equal versions never offer installation', async () => {
  for (const [version, phase] of [['0.3.23', 'ahead'], ['0.3.33', 'current']]) {
    const { updater } = setup({ request: async () => Buffer.from(JSON.stringify(release(version))) });
    await updater.check(); assert.equal(updater.snapshot().phase, phase); assert.equal(updater.snapshot().canInstall, false); updater.dispose();
  }
});
test('network failure is not latest and does not leak error details', async () => {
  const { updater } = setup({ request: async () => { throw Error('secret signed url'); } });
  await updater.check(); assert.equal(updater.snapshot().phase, 'error'); assert.doesNotMatch(JSON.stringify(updater.snapshot()), /secret/); updater.dispose();
});
test('cancelled confirmation never downloads or installs', async () => {
  let installs = 0; const { updater, calls } = setup({ confirm: async () => false, install: async () => installs++ });
  await updater.check(); await updater.installUpdate(); assert.equal(calls(), 1); assert.equal(installs, 0); updater.dispose();
});
test('transport enforces HTTP status byte limits redirect restrictions and timeout', async () => {
  const url = 'https://api.github.com/a';
  for (const response of [new Response('bad', { status: 429 }), new Response('12345'), new Response('', { status: 302, headers: { location: 'https://evil.test/x' } })]) {
    await assert.rejects(requestBytes(url, { limit: 4, fetchImpl: async () => response }));
  }
  await assert.rejects(requestBytes(url, { limit: 10, timeout: 10, fetchImpl: (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('timeout')))) }));
  assert.equal((await requestBytes(url, { limit: 10, fetchImpl: async () => new Response('ok') })).toString(), 'ok');
});
test('both package manifests must match trusted identity', async () => {
  const pkg = { name: 'devin-fusion-byok', publisher: 'local', version: '1.0.0' };
  const run = xml => async (_, args) => ({ stdout: args[2].endsWith('.json') ? JSON.stringify(pkg) : xml });
  await verifyPackage('file', '1.0.0', run('<Identity Id="devin-fusion-byok" Publisher="local" Version="1.0.0"/>'));
  for (const xml of ['<Identity Id="other" Publisher="local" Version="1.0.0"/>', '<!DOCTYPE x><Identity/>', '<Identity/><Identity/>']) await assert.rejects(verifyPackage('file', '1.0.0', run(xml)));
  await assert.rejects(verifyPackage('file', '1.0.1', run('<Identity/>')));
});
test('install validates hash size and package, supports retry, preserves file until installer exits', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-test-'));
  try {
    const bytes = Buffer.from('test artifact'); const info = release('0.3.34');
    info.assets[0].size = bytes.length; info.assets[0].digest = 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
    let wrong = true, fail = true, installs = 0, verified = 0;
    const { updater } = setup({ storagePath: root, confirm: async () => true,
      request: async url => url.includes('/latest') ? Buffer.from(JSON.stringify(info)) : wrong ? Buffer.from('bad') : bytes,
      verify: async () => { verified++; }, install: async ({ path: file }) => { installs++; assert.equal(fs.existsSync(file), true); if (fail) throw Error('private'); }
    });
    await updater.check(); await updater.installUpdate(); assert.equal(installs, 0); assert.equal(verified, 0);
    wrong = false; await updater.installUpdate(); assert.equal(installs, 1); assert.equal(updater.snapshot().phase, 'available');
    fail = false; await Promise.all([updater.installUpdate(), updater.installUpdate()]); assert.equal(installs, 2); assert.equal(updater.snapshot().phase, 'installed');
    assert.deepEqual(fs.readdirSync(root), []); updater.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('disposed pending checks cannot publish or notify, preferences suppress automatic work', async () => {
  let resolve, notified = 0;
  const { updater } = setup({ request: () => new Promise(r => { resolve = r; }), notify: () => notified++ });
  const pending = updater.check(); updater.dispose(); resolve(Buffer.from(JSON.stringify(release('0.3.34')))); await pending;
  assert.equal(notified, 0); assert.equal(updater.snapshot().latestVersion, null);
  const other = setup(); await other.updater.setAutoCheck(false); await other.updater.check(); assert.equal(other.calls(), 0);
  await other.updater.check({ force: true }); assert.equal(other.calls(), 1); other.updater.dispose();
});
test('controller routes updates separately from model settings and only opens trusted snapshot URL', async () => {
  const { createPanelController } = require('../src/panel/controller.cjs');
  const posts = [], actions = []; let receive, close;
  const disposable = { dispose() {} };
  const panel = { webview: { postMessage: async m => posts.push(m), onDidReceiveMessage: fn => { receive = fn; return disposable; } }, onDidDispose: fn => { close = fn; return disposable; }, dispose: () => close() };
  const state = { releaseUrl: PAGE };
  const updater = { snapshot: () => state, check: async o => actions.push(['check', o.force]), installUpdate: async () => actions.push(['install']), ignore: async () => actions.push(['ignore']), setAutoCheck: async enabled => actions.push(['auto', enabled]) };
  const dispatched = [];
  const controller = createPanelController({ vscode: { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel }, Uri: { parse: x => x }, env: { openExternal: async url => actions.push(['url', url]) } }, context: { subscriptions: [] },
    manager: { state: () => ({}), dispatch: async (type, payload) => { dispatched.push([type, payload]); if (type !== 'setUpdateProxy') throw Error('must not touch model settings'); return {}; } }, safeError: () => ({ message: 'error' }), updater });
  controller.open();
  for (const type of ['state','check','install','ignore','auto','release']) await receive({ id: type, type: 'update.' + type, payload: { enabled: false, url: 'https://evil.test' } });
  await receive({ id: 'proxy', type: 'update.proxy', payload: { value: 'http://127.0.0.1:7897' } });
  assert.deepEqual(actions, [['check', true], ['install'], ['ignore'], ['auto', false], ['url', state.releaseUrl], ['check', true]]);
  assert.deepEqual(dispatched, [['setUpdateProxy', { value: 'http://127.0.0.1:7897' }]],
    'update.proxy routes to the dedicated action, never to a same-named model setting');
  assert.equal(posts.filter(p => p.type === 'update-state').length, 7); panel.dispose();
});
test('requestBytes accepts content-length exactly at the limit and enforces streamed size', async () => {
  const url = 'https://api.github.com/a';
  assert.equal((await requestBytes(url, { limit: 5, fetchImpl: async () => new Response('12345') })).toString(), '12345');
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([120, 120])); controller.enqueue(new Uint8Array([120, 120])); controller.close(); } });
  await assert.rejects(requestBytes(url, { limit: 3, fetchImpl: async () => new Response(stream) }), error => error.message === 'size');
});

test('requestBytes follows five redirects and rejects the sixth without a seventh request', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (calls.length <= 5) return new Response(null, { status: 302, headers: { location: 'https://api.github.com/r' + calls.length } });
    return new Response('done');
  };
  assert.equal((await requestBytes('https://api.github.com/r0', { limit: 10, fetchImpl })).toString(), 'done');
  assert.equal(calls.length, 6, 'five hops plus the final request');
  calls.length = 0;
  const looping = async url => { calls.push(url); return new Response(null, { status: 302, headers: { location: 'https://api.github.com/x' } }); };
  await assert.rejects(requestBytes('https://api.github.com/x', { limit: 10, fetchImpl: looping }), error => error.message === 'redirect');
  assert.equal(calls.length, 6, 'the seventh request is never issued');
});

test('requestBytes rejects a redirect without Location and honours pre-call and mid-read aborts', async () => {
  await assert.rejects(requestBytes('https://api.github.com/x', { limit: 10, fetchImpl: async () => new Response(null, { status: 302 }) }),
    error => error.message === 'redirect');
  const pre = new AbortController(); pre.abort();
  await assert.rejects(requestBytes('https://api.github.com/x', { limit: 10, signal: pre.signal,
    fetchImpl: () => { throw Error('must not be called'); } }));
  const mid = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream({
    async pull(controller) { mid.abort(); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(requestBytes('https://api.github.com/x', { limit: 10, signal: mid.signal,
    fetchImpl: async () => new Response(stream) }));
  assert.ok(cancelled, 'aborting mid-read cancels the body reader');
});

test('requests without a proxy keep using the injected fetch implementation', async () => {
  let calls = 0;
  const body = await requestBytes('https://api.github.com/x', { limit: 10, fetchImpl: async () => { calls++; return new Response('ok'); } });
  assert.equal(body.toString(), 'ok');
  assert.equal(calls, 1);
});
test('a configured proxy is parsed once and handed to the request layer', async () => {
  const seen = [];
  const { updater } = setup({ proxy: () => 'http://user:pass@127.0.0.1:7897',
    request: async (url, options) => { seen.push(options.proxy); return Buffer.from(JSON.stringify(release('0.3.34'))); } });
  await updater.check();
  assert.equal(updater.snapshot().phase, 'available');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url.hostname, '127.0.0.1');
  assert.equal(seen[0].url.port, '7897');
  assert.equal(seen[0].authorization, 'Basic ' + Buffer.from('user:pass').toString('base64'));
  updater.dispose();
});
test('an invalid updateProxy fails the check without any network request', async () => {
  let calls = 0;
  const { updater } = setup({ proxy: () => 'socks5://127.0.0.1:9', request: async () => { calls++; return Buffer.from('{}'); } });
  await updater.check();
  assert.equal(updater.snapshot().phase, 'error');
  assert.match(updater.snapshot().error, /updateProxy/);
  assert.equal(calls, 0);
  updater.dispose();
});
test('update view is plain text and does not expose release payload as HTML', () => {
  const { updateMarkup, updateScript } = require('../src/panel/update-view.cjs');
  assert.match(updateMarkup(), /update-install/); assert.match(updateMarkup(), /class="actions nowrap"/);
  assert.match(updateScript(), /textContent/); assert.doesNotMatch(updateScript(), /innerHTML/);
  assert.doesNotThrow(() => new Function('vscode', updateScript()));
});

test('pressing Enter in the proxy field saves it like the button', () => {
  const { updateScript } = require('../src/panel/update-view.cjs');
  const posts = [], elements = new Map();
  const stub = () => ({ listeners: {}, value: ' http://127.0.0.1:7897 ', checked: false, hidden: false,
    disabled: false, textContent: '', addEventListener(name, listener) { this.listeners[name] = listener; },
    click() { this.listeners.click?.(); } });
  const document = { getElementById: id => { if (!elements.has(id)) elements.set(id, stub()); return elements.get(id); },
    activeElement: null };
  new Function('vscode', 'document', 'window', updateScript())(
    { postMessage: message => posts.push(message) }, document, { addEventListener() {} });
  elements.get('update-proxy').listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(posts.find(message => message.type === 'update.proxy').payload, { value: 'http://127.0.0.1:7897' });
});

test('requestBytes defaults to directFetch without touching the ambient fetch', async t => {
  const path = require('node:path');
  const { createSandboxLoader } = require('./helpers/sandbox.cjs');
  const calls = [];
  const loader = createSandboxLoader({ filename: path.resolve(__dirname, '../src/update/updater.cjs'),
    overrides: { [path.resolve(__dirname, '../src/network/direct-fetch.cjs')]: {
      directFetch: async (url, options) => { calls.push({ url, redirect: options?.redirect }); return new Response('ok'); } } } });
  t.after(() => loader.assertStubsUsed('update default transport'));
  t.mock.method(globalThis, 'fetch', () => { throw Error('ambient fetch must not be used'); });
  const body = await loader.module.exports.requestBytes('https://api.github.com/x', { limit: 10 });
  assert.equal(body.toString(), 'ok');
  assert.deepEqual(calls, [{ url: 'https://api.github.com/x', redirect: 'manual' }],
    'the direct transport is the default; the sandbox has no ambient fetch at all');
});

test('snapshot echoes a masked proxy for editing without leaking credentials', async () => {
  const secret = 'http://user:s3cret-token@127.0.0.1:7897';
  const { updater } = setup({ proxy: () => '  ' + secret + '  ', request: async () => { throw new Error('boom'); } });
  assert.equal(updater.snapshot().proxy, 'http://***@127.0.0.1:7897', 'credentials are masked before reaching the panel');
  const { updater: plain } = setup({ proxy: () => ' http://127.0.0.1:8080 ' });
  assert.equal(plain.snapshot().proxy, 'http://127.0.0.1:8080', 'credential-free proxies echo verbatim');
  plain.dispose();
  await updater.check();
  const snap = updater.snapshot();
  assert.equal(snap.phase, 'error');
  assert.doesNotMatch(JSON.stringify(snap), /s3cret-token|user:/);
  updater.dispose();
});

test('snapshot proxy falls back to empty on non-strings and getter failures', () => {
  const { updater: throwing } = setup({ proxy: () => { throw new Error('config read failed'); } });
  assert.equal(throwing.snapshot().proxy, '');
  throwing.dispose();
  const { updater: numeric } = setup({ proxy: () => 42 });
  assert.equal(numeric.snapshot().proxy, '');
  numeric.dispose();
});

test('src/update.cjs stays a pure compatibility facade over update/updater.cjs', () => {
  const facade = require('../src/update.cjs');
  const impl = require('../src/update/updater.cjs');
  assert.deepEqual(Object.keys(facade), Object.keys(impl));
  assert.equal(facade.REPOSITORY, impl.REPOSITORY);
  assert.equal(facade.PAGE, impl.PAGE);
  for (const key of ['compareVersions', 'parseVersion', 'releaseInfo', 'allowedUrl', 'requestBytes', 'verifyPackage', 'createUpdater', 'createUpdateHost'])
    assert.equal(facade[key], impl[key]);
});

test('createUpdateHost installs through execFile argv and never a shell string', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'),
    crypto = require('node:crypto'), { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-host-'));
  const appRoot = path.join(dir, 'app');
  fs.mkdirSync(path.join(appRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'bin', 'devin-desktop'), '#!/bin/sh\n');
  const storage = path.join(dir, 'storage');
  // A real zip is required: verifyPackage runs the genuine /usr/bin/unzip.
  const stage = path.join(dir, 'stage');
  fs.mkdirSync(path.join(stage, 'extension'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'extension', 'package.json'),
    JSON.stringify({ name: 'devin-fusion-byok', publisher: 'local', version: '9.9.9' }));
  fs.writeFileSync(path.join(stage, 'extension.vsixmanifest'),
    '<?xml version="1.0"?><PackageManifest><Identity Id="devin-fusion-byok" Publisher="local" Version="9.9.9"/></PackageManifest>');
  const vsix = path.join(dir, 'devin-fusion-byok-9.9.9.vsix');
  execFileSync('/usr/bin/zip', ['-q', '-r', vsix, '.'], { cwd: stage });
  const bytes = fs.readFileSync(vsix);
  const pkg = require('../package.json');
  const releaseBody = JSON.stringify({ tag_name: 'v9.9.9', assets: [{ name: 'devin-fusion-byok-9.9.9.vsix',
    size: bytes.length, digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'),
    browser_download_url: `${PAGE}/download/v9.9.9/devin-fusion-byok-9.9.9.vsix` }] });
  const calls = [];
  const run = async (file, argv, options) => { calls.push([file, argv, options]); return { stdout: '', stderr: '' }; };
  const { createUpdateHost } = require('../src/update/updater.cjs');
  const updater = createUpdateHost({
    vscode: { env: { appRoot },
      commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
      window: { showWarningMessage: async () => '安装更新', showInformationMessage: async () => undefined } },
    context: { globalState: { get: (k, d) => d, update: async () => {} },
      globalStorageUri: { fsPath: storage }, subscriptions: [] },
    onChange() {}, proxy: () => '', run,
    request: async url => url.includes('/download/') ? bytes : Buffer.from(releaseBody)
  });
  try {
    await updater.check();
    assert.equal(updater.snapshot().canInstall, true, 'a newer digest-verified release is installable');
    await updater.installUpdate();
    assert.equal(updater.snapshot().phase, 'installed');
    assert.equal(calls.length, 1, 'install ran exactly once');
    const [file, argv, options] = calls[0];
    assert.ok(path.isAbsolute(file) && file.endsWith('/bin/devin-desktop'), 'argv0 is the packaged CLI path');
    assert.ok(Array.isArray(argv), 'arguments must stay an array, never a shell string');
    assert.equal(argv[0], '--install-extension');
    assert.ok(path.isAbsolute(argv[1]) && argv[1].endsWith('.vsix'), 'argv1 is the downloaded package path');
    assert.equal('shell' in options, false, 'no shell option may ever appear');
  } finally { updater.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

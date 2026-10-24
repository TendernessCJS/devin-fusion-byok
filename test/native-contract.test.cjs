const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { checkNativeContract, scanMarkers, sha256, artifacts, REQUIRED, INFORMATIONAL } = require('../src/activation/native-contract.cjs');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'native-contract-'));

const ALL_CLI = [...REQUIRED.cli, ...INFORMATIONAL.cli];
const ALL_LS = [...REQUIRED.ls, ...INFORMATIONAL.ls];
const ALL_DESKTOP = [...REQUIRED.desktop, ...INFORMATIONAL.desktop];
const ALL_CHAT = [...REQUIRED.chat, ...INFORMATIONAL.chat];

// Production layout: extensionPath is the windsurf extension dir itself
// (what vscode.extensions.getExtension reports), not the devin subdir.
function fakeApp({ cliMarkers = ALL_CLI, lsMarkers = ALL_LS,
    desktopMarkers = ALL_DESKTOP, chatMarkers = ALL_CHAT, version = '3.11.216' } = {}) {
  const root = tmpdir();
  const app = path.join(root, 'Devin.app', 'Contents', 'Resources', 'app');
  const ext = path.join(app, 'extensions', 'windsurf');
  const write = (file, markers) => {
    if (markers === null) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.concat(markers.map(m => Buffer.from(m))));
  };
  write(path.join(ext, 'devin', 'bin', 'devin'), cliMarkers);
  write(path.join(ext, 'bin', 'language_server_macos_arm'), lsMarkers);
  write(path.join(app, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'), desktopMarkers);
  write(path.join(app, 'out', 'vs', 'workbench', 'windsurf-chat-client', 'index.js'), chatMarkers);
  fs.writeFileSync(path.join(app, '..', '..', 'Info.plist'),
    `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key>\n<string>${version}</string></dict></plist>`);
  return { root, extensionPath: ext, cacheFile: path.join(root, 'native-contract.json'),
    files: artifacts(ext) };
}

test('first run scans, reports ok and writes a signature-keyed cache', async () => {
  const { extensionPath, cacheFile, files } = fakeApp();
  const logs = [];
  const result = await checkNativeContract({ extensionPath, cacheFile, log: (k, v) => logs.push([k, v]) });
  assert.equal(result.status, 'ok');
  assert.equal(result.appVersion, '3.11.216');
  assert.deepEqual(logs.map(([k]) => k), ['native-contract-ok']);
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const sig = [files.cli, files.ls, files.desktop, files.chat]
    .map(f => sha256(f));
  const sigJoined = (await Promise.all(sig)).join(':');
  assert.equal(cache.signature, sigJoined);
  assert.equal(Object.keys(cache.stat).length, 4, 'stat covers every artifact');
  assert.deepEqual(result.missing, {});
  assert.equal(cache.status, 'ok');
});

test('a second run reuses the cache without rescanning or logging', async () => {
  const { extensionPath, cacheFile, files } = fakeApp();
  const first = await checkNativeContract({ extensionPath, cacheFile });
  assert.equal(first.status, 'ok');
  // Seed a drift verdict under the same binary signature: all markers are
  // actually present, so a real scan would report ok. 'reused' echoing the
  // seeded missing list proves the cache answered and nothing was rescanned.
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  fs.writeFileSync(cacheFile, JSON.stringify({ ...cache, status: 'drift',
    missing: { cli: ['GetCliModelConfigs'] } }));
  const logs = [];
  const result = await checkNativeContract({ extensionPath, cacheFile, log: (k, v) => logs.push([k, v]) });
  assert.equal(result.reused, true);
  assert.equal(result.status, 'drift', 'the cached verdict is reported, not flattened to reused');
  assert.equal(result.appVersion, '3.11.216');
  assert.deepEqual(result.missing, { cli: ['GetCliModelConfigs'] });
  assert.equal(logs.length, 0);
  // Signature covers the bytes: a changed binary is rescanned, not reused.
  fs.writeFileSync(files.cli, 'changed');
  const drift = await checkNativeContract({ extensionPath, cacheFile });
  assert.notEqual(drift.status, 'reused');
});

test('a missing required marker reports drift with the artifact grouped', async () => {
  const { extensionPath, cacheFile, files } = fakeApp({ lsMarkers: ALL_LS.filter(m => m !== 'cascade_model_config_data') });
  const logs = [];
  const result = await checkNativeContract({ extensionPath, cacheFile, log: (k, v) => logs.push([k, v]) });
  assert.equal(result.status, 'drift');
  assert.deepEqual(result.missing.ls, ['cascade_model_config_data']);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'native-contract-drift');
  assert.ok(logs[0][1].missing.ls.includes('cascade_model_config_data'));
});

test('missing informational markers still pass but are recorded', async () => {
  const { extensionPath, cacheFile, files } = fakeApp({ cliMarkers: ALL_CLI.filter(m => m !== 'max_turn_requests') });
  const logs = [];
  const result = await checkNativeContract({ extensionPath, cacheFile, log: (k, v) => logs.push([k, v]) });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.informational.cli, ['max_turn_requests']);
  assert.equal(logs[0][0], 'native-contract-ok');
});

test('a missing binary reports unavailable, logs once, and writes no cache', async () => {
  const { extensionPath, cacheFile, files } = fakeApp({ cliMarkers: null });
  const logs = [];
  const result = await checkNativeContract({ extensionPath, cacheFile, log: (k, v) => logs.push([k, v]) });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'artifact-missing');
  assert.deepEqual(logs.map(([k]) => k), ['native-contract-unavailable']);
  assert.equal(fs.existsSync(cacheFile), false);
});

test('a corrupt cache file is treated as no cache and rescanned', async () => {
  const { extensionPath, cacheFile, files } = fakeApp();
  fs.writeFileSync(cacheFile, '{ not json');
  const result = await checkNativeContract({ extensionPath, cacheFile });
  assert.equal(result.status, 'ok');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(cache.status, 'ok');
});

test('markers spanning the 4 MB chunk boundary are still found', async () => {
  const { extensionPath, cacheFile, files } = fakeApp({ cliMarkers: [], lsMarkers: [], desktopMarkers: [], chatMarkers: [] });
  const marker = Buffer.from('cascade_model_config_data');
  const file = files.ls;
  // First half of the marker ends exactly at the 4 MB read boundary, second
  // half starts the next chunk: only the overlapping carry finds it whole.
  const filler = Buffer.alloc(4 * 1024 * 1024 - 10, 0x41);
  fs.writeFileSync(file, Buffer.concat([filler, marker, Buffer.alloc(100, 0x42)]));
  const found = await scanMarkers(file, ['cascade_model_config_data']);
  assert.ok(found.has('cascade_model_config_data'), 'a split marker must not be missed');
});

test('non-darwin platforms report unsupported without scanning or logging', async () => {
  const { extensionPath, cacheFile, files } = fakeApp();
  const logs = [];
  const result = await checkNativeContract({ extensionPath, cacheFile, platform: 'linux', log: (k, v) => logs.push([k, v]) });
  assert.equal(result.status, 'unsupported');
  assert.equal(logs.length, 0);
  assert.equal(fs.existsSync(cacheFile), false);
});

test('a matching stat short-circuits before any file read stream opens', async () => {
  const { extensionPath, cacheFile, files } = fakeApp();
  assert.equal((await checkNativeContract({ extensionPath, cacheFile })).status, 'ok');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  fs.writeFileSync(cacheFile, JSON.stringify({ ...cache, status: 'drift', missing: { cli: ['GetUserStatus'] } }));
  let streams = 0;
  const orig = fs.createReadStream;
  fs.createReadStream = (...a) => { streams++; return orig(...a); };
  try {
    const result = await checkNativeContract({ extensionPath, cacheFile });
    assert.equal(result.reused, true);
    assert.equal(result.status, 'drift');
    assert.deepEqual(result.missing, { cli: ['GetUserStatus'] }, 'the seeded verdict echoes back untouched');
    assert.equal(streams, 0, 'a stat hit must not even hash the binaries');
  } finally { fs.createReadStream = orig; }
});

test('an mtime-only change is reused by signature and the stat is restamped', async () => {
  const { extensionPath, cacheFile, files } = fakeApp();
  await checkNativeContract({ extensionPath, cacheFile });
  const cli = files.cli;
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(cli, future, future);
  const result = await checkNativeContract({ extensionPath, cacheFile });
  assert.equal(result.reused, true);
  assert.equal(result.status, 'ok');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(cache.stat.cli[1], fs.statSync(cli).mtimeMs, 'the restamped stat records the new mtime');
});

test('changed binary bytes force a rescan against the real markers', async () => {
  const { extensionPath, cacheFile, files } = fakeApp();
  await checkNativeContract({ extensionPath, cacheFile });
  fs.writeFileSync(files.ls, Buffer.concat(ALL_LS.filter(m => m !== 'cascade_model_config_data').map(m => Buffer.from(m))));
  const result = await checkNativeContract({ extensionPath, cacheFile });
  assert.equal(result.status, 'drift');
  assert.deepEqual(result.missing.ls, ['cascade_model_config_data']);
});

test('a legacy cache without a stat field still reuses on the signature', async () => {
  const { extensionPath, cacheFile, files } = fakeApp();
  await checkNativeContract({ extensionPath, cacheFile });
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  delete cache.stat;
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  const result = await checkNativeContract({ extensionPath, cacheFile });
  assert.equal(result.reused, true);
  assert.equal(result.status, 'ok');
});

test('each artifact is scanned exactly once for both marker tiers', async () => {
  const { extensionPath, cacheFile, files } = fakeApp();
  const scanned = [];
  const orig = fs.createReadStream;
  fs.createReadStream = (file, ...rest) => { scanned.push(String(file)); return orig(file, ...rest); };
  try {
    const result = await checkNativeContract({ extensionPath, cacheFile });
    assert.equal(result.status, 'ok');
    const paths = [files.cli, files.ls, files.desktop, files.chat];
    // Two read streams per artifact (one hash pass + one marker scan) = 8
    // total; a ninth stream would mean a tier was split into a second scan.
    for (const file of paths) assert.equal(scanned.filter(f => f === file).length, 2, file);
  } finally { fs.createReadStream = orig; }
});

test('a cached drift keeps reporting drift on every later activation', async () => {
  const { extensionPath, cacheFile, files } = fakeApp();
  await checkNativeContract({ extensionPath, cacheFile });
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  fs.writeFileSync(cacheFile, JSON.stringify({ ...cache, status: 'drift',
    missing: { cli: ['GetCliModelConfigs'] } }));
  const first = await checkNativeContract({ extensionPath, cacheFile });
  const second = await checkNativeContract({ extensionPath, cacheFile });
  for (const result of [first, second]) {
    assert.equal(result.status, 'drift', 'the panel warning must survive cache hits');
    assert.equal(result.reused, true);
    assert.deepEqual(result.missing, { cli: ['GetCliModelConfigs'] });
  }
});

test('a missing required marker on the desktop bundle reports drift', async () => {
  const { extensionPath, cacheFile, files } = fakeApp({
    desktopMarkers: ALL_DESKTOP.filter(m => m !== 'devin.refreshUserStatus') });
  const result = await checkNativeContract({ extensionPath, cacheFile });
  assert.equal(result.status, 'drift');
  assert.deepEqual(result.missing.desktop, ['devin.refreshUserStatus']);
});

test('a missing chat bundle is drift, not unavailable', async () => {
  const { extensionPath, cacheFile, files } = fakeApp({ chatMarkers: null });
  const logs = [];
  const result = await checkNativeContract({ extensionPath, cacheFile, log: (k, v) => logs.push([k, v]) });
  assert.equal(result.status, 'drift');
  assert.deepEqual(result.missing.chat, ['artifact-missing']);
  assert.equal(logs[0][0], 'native-contract-drift');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(cache.status, 'drift', 'a renamed bundle must stay visible, cached as drift');
});

test('a missing CLI binary still reports unavailable and writes no cache', async () => {
  const { extensionPath, cacheFile, files } = fakeApp({ cliMarkers: null });
  const logs = [];
  const result = await checkNativeContract({ extensionPath, cacheFile, log: (k, v) => logs.push([k, v]) });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'artifact-missing');
  assert.equal(fs.existsSync(cacheFile), false);
});

test('an empty informational tier still scans the artifact once', async () => {
  const { extensionPath, cacheFile, files } = fakeApp();
  const scanned = [];
  const orig = fs.createReadStream;
  fs.createReadStream = (file, ...rest) => { scanned.push(String(file)); return orig(file, ...rest); };
  try {
    const result = await checkNativeContract({ extensionPath, cacheFile });
    assert.equal(result.status, 'ok');
    const desktop = files.desktop;
    assert.equal(scanned.filter(f => f === desktop).length, 2,
      'hash plus one marker pass despite the empty informational tier');
    assert.equal('desktop' in (result.informational || {}), false,
      'no informational entry is produced from an empty marker set');
  } finally { fs.createReadStream = orig; }
});

test('the devin subdir path resolves to the same app root', async () => {
  const { extensionPath } = fakeApp();
  const viaExt = artifacts(extensionPath);
  const viaDevin = artifacts(path.join(extensionPath, 'devin'));
  for (const key of ['appRoot', 'cli', 'ls', 'desktop', 'chat', 'plist'])
    assert.equal(viaDevin[key], viaExt[key], `${key} must resolve identically`);
});

test('an unrecognised layout reports layout-unknown without writing a cache', async () => {
  const dir = tmpdir();
  const logs = [];
  const result = await checkNativeContract({ extensionPath: dir,
    cacheFile: path.join(dir, 'native-contract.json'), log: (k, v) => logs.push([k, v]) });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'layout-unknown');
  assert.deepEqual(logs.map(([k]) => k), ['native-contract-unavailable']);
  assert.equal(fs.existsSync(path.join(dir, 'native-contract.json')), false);
});

test('a missing Fast Context RPC on the LS binary reports drift', async () => {
  const { extensionPath, cacheFile } = fakeApp({ lsMarkers: ALL_LS.filter(m => m !== 'GetUserJwt') });
  const result = await checkNativeContract({ extensionPath, cacheFile });
  assert.equal(result.status, 'drift');
  assert.deepEqual(result.missing.ls, ['GetUserJwt']);
});

test('a fresh scan reports authStore in the result and the cache', async () => {
  const { extensionPath, cacheFile } = fakeApp();
  let probeCalls = 0;
  const result = await checkNativeContract({ extensionPath, cacheFile,
    probeAuthStore: () => { probeCalls++; return 'present'; } });
  assert.equal(probeCalls, 1);
  assert.equal(result.authStore, 'present');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(cache.authStore, 'present');
});

test('a reused verdict never opens the credential store', async () => {
  const { extensionPath, cacheFile } = fakeApp();
  await checkNativeContract({ extensionPath, cacheFile });
  let probeCalls = 0;
  const result = await checkNativeContract({ extensionPath, cacheFile,
    probeAuthStore: () => { probeCalls++; return 'present'; } });
  assert.equal(result.reused, true);
  assert.equal(probeCalls, 0, 'the stat fast path must not touch the database');
});

test('a failing authStore probe degrades to unknown without failing the run', async () => {
  const { extensionPath, cacheFile } = fakeApp();
  const result = await checkNativeContract({ extensionPath, cacheFile,
    probeAuthStore: () => { throw Error('sqlite gone'); } });
  assert.equal(result.status, 'ok');
  assert.equal(result.authStore, 'unknown');
});

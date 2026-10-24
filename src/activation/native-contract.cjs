// Read-only drift probe: after a Devin upgrade the private ACP contract
// (RPC names, protobuf fields, cache generations, stopReason enums) may
// change while our tests stay green. Scanning the shipped binaries for
// marker strings lets an upgrade self-report drift instead of needing a
// manual reverse-engineering pass. Never throws to the caller; quiet on ok.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { credentialPath } = require('../fast-context/auth.cjs');

const REQUIRED = {
  cli: ['GetCliModelConfigs', 'GetUserStatus', 'GetCliTeamSettings'],
  // GetUserJwt / GetWebSearchResults back the external Fast Context MCP: the
  // hardcoded field numbers in src/fast-context/web.cjs fail loudly when the
  // names go, but we want to know before that failure reaches users.
  ls: ['cascade_model_config_data', 'GetUserJwt', 'GetWebSearchResults'],
  desktop: ['devin.refreshUserStatus', 'cascade_model_config_data'],
  chat: ['cognition.ai/auth', 'cognition.ai/subagent_context']
};
const INFORMATIONAL = {
  cli: ['model_configs_v6', 'max_turn_requests', 'end_turn', 'refusal'],
  ls: ['GetUserStatus'],
  desktop: [],
  chat: ['cognition.ai/finishedOutcome', 'cognition.ai/abort', 'cognition.ai/clientMessageId']
};

const CHUNK = 4 * 1024 * 1024;
const OVERLAP = 64;
const SIZE_CAP = 400 * 1024 * 1024;
// Bump whenever the marker tables or probe semantics change: cached verdicts
// are keyed on probe, otherwise an old 'ok' would be reused forever and new
// markers would never be scanned.
const PROBE_VERSION = 1;

const ARTIFACT_KEYS = ['cli', 'ls', 'desktop', 'chat'];
const APP_ANCHOR = path.join('out', 'vs', 'workbench', 'workbench.desktop.main.js');

// The extension path we are handed is the *windsurf extension dir*, not the
// `devin` subdir and not a fixed number of levels below the app root. Anchor
// on a file that only exists under the real app root instead of counting `..`.
function findAppRoot(extensionPath) {
  let dir = path.resolve(extensionPath);
  for (let i = 0; i <= 6; i++) {
    if (fs.existsSync(path.join(dir, APP_ANCHOR))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function artifacts(extensionPath) {
  const appRoot = findAppRoot(extensionPath);
  const empty = { appRoot: null, cli: null, ls: null, desktop: null, chat: null, plist: null };
  if (!appRoot) return empty;
  return {
    appRoot,
    cli: path.join(appRoot, 'extensions', 'windsurf', 'devin', 'bin', 'devin'),
    ls: path.join(appRoot, 'extensions', 'windsurf', 'bin', 'language_server_macos_arm'),
    desktop: path.join(appRoot, APP_ANCHOR),
    chat: path.join(appRoot, 'out', 'vs', 'workbench', 'windsurf-chat-client', 'index.js'),
    plist: path.join(appRoot, '..', '..', 'Info.plist')
  };
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function scanMarkers(file, markers) {
  return new Promise(resolve => {
    const found = new Set();
    const pending = new Set(markers);
    let carry = Buffer.alloc(0);
    const stream = fs.createReadStream(file, { highWaterMark: CHUNK });
    const done = () => { stream.destroy(); resolve(found); };
    stream.on('data', chunk => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      for (const marker of pending) if (buf.indexOf(marker) !== -1) { pending.delete(marker); found.add(marker); }
      carry = buf.subarray(Math.max(0, buf.length - OVERLAP));
      if (!pending.size) return done();
    });
    stream.on('end', () => resolve(found));
    stream.on('error', () => resolve(found));
  });
}

// `windsurfAuthStatus` is a data-plane contract: absent from every binary
// (probes cannot see it), yet auth.cjs reads it from the credential store.
// Report-only — never drift, never logged, value never leaves the DB.
function authStoreStatus({ platform = process.platform, home, env } = {}) {
  try {
    const dbPath = credentialPath({ platform, home, env });
    if (!fs.existsSync(dbPath)) return 'missing';
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT 1 AS x FROM ItemTable WHERE key = 'windsurfAuthStatus'").get();
      return row ? 'present' : 'missing';
    } finally { db.close(); }
  } catch { return 'unknown'; }
}

function appVersionOf(plist) {
  try {
    const text = fs.readFileSync(plist, 'utf8');
    const m = text.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    return m ? m[1] : null;
  } catch { return null; }
}

function writeCache(file, value) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function checkNativeContract({ extensionPath, cacheFile, log = () => {}, platform = process.platform, probeAuthStore = authStoreStatus } = {}) {
  if (platform !== 'darwin') return { status: 'unsupported' };
  try {
    const files = artifacts(extensionPath);
    if (!files.appRoot) {
      // Same contract as a missing CLI: an unrecognised layout is an
      // environment problem, never a contract drift and never cached.
      log('native-contract-unavailable', { code: 'layout-unknown' });
      return { status: 'unavailable', code: 'layout-unknown' };
    }
    // Missing desktop/chat bundles are drift, not unavailable: a renamed or
    // split bundle means an integration surface we can no longer verify, and
    // that must stay visible. cli/ls absence keeps the old unavailable path.
    const stat = {}, missing = {}, informational = {};
    for (const key of ARTIFACT_KEYS) {
      let st = null;
      try { st = fs.statSync(files[key]); } catch {}
      const absent = !st || !st.isFile();
      const oversized = st && st.isFile() && st.size > SIZE_CAP;
      if (!absent && !oversized) { stat[key] = [st.size, st.mtimeMs]; continue; }
      const code = absent ? 'artifact-missing' : 'too-large';
      if (key === 'cli' || key === 'ls') {
        log('native-contract-unavailable', { code });
        return { status: 'unavailable', code };
      }
      missing[key] = [code];
    }
    let cache = null;
    try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
    const cacheOk = cache && cache.probe === PROBE_VERSION && (cache.status === 'ok' || cache.status === 'drift');
    if (cacheOk && cache.stat && JSON.stringify(cache.stat) === JSON.stringify(stat)) {
      return { status: cache.status, reused: true, appVersion: cache.appVersion,
        missing: cache.missing || {}, informational: cache.informational || {} };
    }
    const hashes = [];
    for (const key of ARTIFACT_KEYS) if (stat[key]) hashes.push(await sha256(files[key]));
    const signature = hashes.join(':');
    if (cacheOk && cache.signature === signature) {
      // Bytes identical under a new mtime: reused, and the stat is restamped
      // so the next activation short-circuits before hashing.
      try { writeCache(cacheFile, { ...cache, stat }); } catch {}
      return { status: cache.status, reused: true, appVersion: cache.appVersion,
        missing: cache.missing || {}, informational: cache.informational || {} };
    }
    for (const key of ARTIFACT_KEYS) {
      if (!stat[key]) continue;
      const found = await scanMarkers(files[key], [...REQUIRED[key], ...INFORMATIONAL[key]]);
      const reqMiss = REQUIRED[key].filter(m => !found.has(m));
      if (reqMiss.length) missing[key] = (missing[key] || []).concat(reqMiss);
      const infoMiss = INFORMATIONAL[key].filter(m => !found.has(m));
      if (infoMiss.length) informational[key] = infoMiss;
    }
    const status = Object.keys(missing).length ? 'drift' : 'ok';
    const appVersion = appVersionOf(files.plist);
    // Runs only on a real scan — the stat/signature fast paths never open the DB.
    let authStore;
    try { authStore = probeAuthStore({ platform }); } catch { authStore = 'unknown'; }
    if (!['present', 'missing', 'unknown'].includes(authStore)) authStore = 'unknown';
    try {
      writeCache(cacheFile, { signature, stat, probe: PROBE_VERSION, appVersion, checkedAt: Date.now(), status, missing, informational, authStore });
    } catch {}
    if (status === 'drift') log('native-contract-drift', { appVersion, missing, informational });
    else log('native-contract-ok', { appVersion });
    return { status, reused: false, appVersion, missing, informational, authStore };
  } catch {
    log('native-contract-unavailable', { code: 'probe-failed' });
    return { status: 'unavailable', code: 'probe-failed' };
  }
}

module.exports = { PROBE_VERSION, REQUIRED, INFORMATIONAL, artifacts, findAppRoot, authStoreStatus, sha256, scanMarkers, checkNativeContract };

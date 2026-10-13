'use strict';
const fs = require('node:fs');
const path = require('node:path');

const WAIT_SECONDS = 90;   // how long to wait for the app to exit before giving up
const SETTLE_SECONDS = 3; // small settle only; the risky window is covered by retries, not blind waiting
const ROUNDS = 10;
const VERIFY_SECONDS = 3;
const LAUNCHCTL = '/bin/launchctl';
const JOB_PREFIX = 'devin-fusion-byok-restart-';

// Resolve `/Applications/Devin.app` from `<bundle>/Contents/Resources/app`.
function appBundle(appRoot) {
  if (typeof appRoot !== 'string' || !appRoot) return '';
  const bundle = path.resolve(appRoot, '..', '..', '..');
  return bundle.endsWith('.app') ? bundle : '';
}

function quote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

// A detached helper waits for the main executable to exit, then reopens the
// bundle. If the quit is cancelled it gives up instead of relaunching later.
// macOS `pgrep` skips its own ancestors, and this helper always runs inside the
// app's process tree, so pgrep can never observe the app it waits for. List the
// executable paths instead; `comm` rather than `command` because the helper's
// own arguments contain the bundle path.
function appProbe(bundle) {
  return `/bin/ps -Ao comm= | /usr/bin/grep -qF ${quote(`${bundle}/Contents/MacOS/`)}`;
}

function appExecutable(bundle) {
  return path.join(bundle, 'Contents/MacOS', path.basename(bundle).replace(/\.app$/, ''));
}

// Early rounds relaunch in place; the middle ones force `open -n` to dodge
// LaunchServices deduplicating the relaunch request; the last ones exec the
// executable directly like Electron's `app.relaunch()` does. A directly
// spawned process never registers with LaunchServices (Dock icon and window
// restoration are left to the app itself), which is why exec comes last.
// Each channel appends its own stdout/stderr to the helper log so a dropped
// LaunchServices error — or the app's own early-exit output — is captured.
function relaunchCommand(bundle, open = '/usr/bin/open', round = 1, rounds = ROUNDS, executable = appExecutable(bundle), logFile = '') {
  const out = logFile ? `>> ${quote(logFile)} 2>&1` : '>/dev/null 2>&1';
  if (round <= Math.ceil(rounds * 0.5)) return `${open} ${quote(bundle)} ${out}`;
  if (round <= Math.ceil(rounds * 0.8)) return `${open} -n ${quote(bundle)} ${out}`;
  return `( /usr/bin/nohup ${quote(executable)} ${out} </dev/null & )`;
}

// The helper is normally spawned by the app, so LaunchServices attributes its
// `open` to the still-winding-down app itself and an early `open` becomes a
// no-op; the freshly spawned process may also self-terminate within ~100ms.
// The app's own `claimInstance` hands over and exits on `EADDRINUSE`
// (measured: 113ms, no window), so a stale IPC handle must be removed before
// launching — the exit probe already proved no live owner exists by then.
// Instances started within ~10s of the old one's exit have been observed to
// self-terminate in ~110ms (real machine, twice: +1.1s and +3.3s; every start
// at +10s or later survived), so the risky window is temporal. But blind
// waiting wastes it: a self-termination is detectable within ~113ms, hence
// the adaptive strategy — a small settle, fast failure detection, and a
// bounded number of retry rounds. If the window was really caused by the
// stale IPC handle this now removes, round 1 succeeds (~5s total); otherwise
// the rounds naturally carry past the window's end — no worse than a fixed
// settle, without the fixed waste. Every liveness hit is confirmed by a
// second probe two seconds later so a transient launch is never mistaken for
// success, and every round probes before opening so `open -n` cannot create a
// duplicate once the app is already back. The `attempt <n> channel=<c>` and
// `confirmed round=<n>` log lines record the winning round and channel, so
// the real threshold stays observable.
function relaunchScript(bundle, waitSeconds = WAIT_SECONDS, open = '/usr/bin/open',
  { settle = SETTLE_SECONDS, rounds = ROUNDS, verify = VERIFY_SECONDS, logFile = '', label = '', userData = '' } = {}) {
  const probe = appProbe(bundle);
  const logFn = logFile
    ? `log() { printf '%s %s\\n' "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> ${quote(logFile)} 2>/dev/null; }`
    : 'log() { :; }';
  const removeLabel = label
    ? `[ -n ${quote(label)} ] && ${LAUNCHCTL} remove ${quote(label)} >/dev/null 2>&1`
    : ':';
  const plain = [], fresh = [], exec = [];
  for (let round = 1; round <= rounds; round++) {
    const band = round <= Math.ceil(rounds * 0.5) ? plain : round <= Math.ceil(rounds * 0.8) ? fresh : exec;
    band.push(round);
  }
  const pattern = band => band.length ? band.join('|') : '*';
  const stale = userData ? `rm -f ${quote(userData)}/*-main.sock ${quote(userData)}/code.lock` : '';
  const caseBody = `case $j in ${pattern(plain)}) chan=open; ${relaunchCommand(bundle, open, 1, rounds, undefined, logFile)}; rc=$? ;; ${pattern(fresh)}) chan=open-new; ${relaunchCommand(bundle, open, Math.ceil(rounds * 0.5) + 1, rounds, undefined, logFile)}; rc=$? ;; ${pattern(exec)}) chan=exec; ${relaunchCommand(bundle, open, rounds, rounds, undefined, logFile)}; rc=$? ;; esac`;
  return [
    'umask 077',
    logFn,
    'log "helper-started pid=$$"',
    'i=0',
    `while ${probe}; do i=$((i+1)); [ $i -gt ${waitSeconds * 2} ] && { log 'quit-cancelled'; ${removeLabel}; exit 0; }; sleep 0.5; done`,
    "log 'app-exited'",
    ...(stale ? [stale, "log 'cleaned-stale'"] : []),
    `sleep ${settle}`,
    'j=0',
    `while [ $j -lt ${rounds} ]; do`,
    '  j=$((j+1))',
    `  if ${probe}; then sleep 2; if ${probe}; then log "confirmed pre-round=$j"; ${removeLabel}; exit 0; fi; fi`,
    ...(stale ? [`  ${stale}`] : []),
    `  ${caseBody}`,
    '  log "attempt $j channel=$chan rc=$rc"',
    '  k=0',
    `  while [ $k -lt ${verify} ]; do`,
    `    if ${probe}; then sleep 2; if ${probe}; then log "confirmed round=$j"; ${removeLabel}; exit 0; fi; log "transient round=$j"; fi`,
    '    sleep 1; k=$((k+1))',
    '  done',
    'done',
    "log 'gave-up'",
    removeLabel,
    'exit 1',
  ].join('\n');
}

async function restartApp({ vscode, spawn, platform = process.platform, appRoot = vscode?.env?.appRoot, logFile = '', userData = '' } = {}) {
  if (platform !== 'darwin') throw new Error('restart_unsupported');
  const bundle = appBundle(appRoot);
  if (!bundle) throw new Error('restart_unsupported');
  if (logFile) {
    try { fs.rmSync(logFile + '.previous', { force: true }); fs.renameSync(logFile, logFile + '.previous'); } catch {}
  }
  const label = JOB_PREFIX + Date.now();
  const script = relaunchScript(bundle, WAIT_SECONDS, '/usr/bin/open', { logFile, label, userData });
  // Registering the helper with launchd detaches it from the app's process
  // tree, so its `open` is attributed to launchd rather than to the app
  // activating itself — the reason the plain `open` used to be a no-op.
  const submitted = await new Promise(resolve => {
    let child;
    try { child = spawn(LAUNCHCTL, ['submit', '-l', label, '--', '/bin/sh', '-c', script], { stdio: 'ignore' }); }
    catch { return resolve(false); }
    if (!child || typeof child.once !== 'function') return resolve(false);
    const timer = setTimeout(() => resolve(false), 1500);
    child.once('exit', code => { clearTimeout(timer); resolve(code === 0); });
  });
  if (!submitted) {
    const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' });
    child.unref?.();
  }
  await vscode.commands.executeCommand('workbench.action.quit');
  return bundle;
}

module.exports = { restartApp, relaunchScript, relaunchCommand, appProbe, appBundle, appExecutable };

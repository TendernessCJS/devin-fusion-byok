'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveUpstreamOrigin } = require('../runtime/upstream-origin.cjs');
const execFileAsync = promisify(execFile);
const sleepDefault = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) { resolve(); return; }
  let timer;
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  timer = setTimeout(done, ms);
  timer.unref?.();
  signal?.addEventListener('abort', done, { once: true });
});
// The native `codeium.apiServerUrl` is a derived value, not a user setting:
// the shipped config getter short-circuits `codeium.*` to the login response
// and portal derivation, so a hand-written settings.json value is silently
// ignored (verified 2026-10-27). Resolve the same chain natively: the newest
// language server's `--api_server_url` argument, then the portal route, then
// the deployment default. The origin string never reaches logs or receipts —
// only `source` may be recorded.
// ps rows are matched on the *command position* (argv[0]): a command line
// merely mentioning the binary path in a later argument (a `node -e` string,
// our own `ps | grep`-style self-match) is not an LS process. When the host
// process path lets us derive an .app bundle, the executable must also live
// under that same bundle — an LS from another installed app must not steer
// this window's upstream. The bundle check is install-level, not window-level:
// two Devin windows of the same install cannot be told apart here. When no
// bundle can be derived (tests, non-macOS hosts) only the command-position
// constraint applies. Only the text after argv[0] is searched for the flag.
// Candidates are tried in pid order, newest first, so one row whose argument
// is invalid cannot hide a legitimate older process.
const LS_EXECUTABLE = /\/language_server_[A-Za-z0-9_]+$/;
const FIRST_ARGUMENT = /^(?:"([^"]*)"|(\S+))/;
function appRootOf(execPath) {
  const at = typeof execPath === 'string' ? execPath.indexOf('.app/') : -1;
  return at > 0 ? execPath.slice(0, at + 5) : null;
}
async function resolveEffectiveOrigin({ vscode, exec = execFileAsync, execPath = process.execPath, signal, onDiag } = {}) {
  if (signal?.aborted) return { origin: null, source: 'default' };
  try {
    const appRoot = appRootOf(execPath);
    const { stdout } = await exec('/bin/ps', ['-Ao', 'pid=,command='], { timeout: 2000, maxBuffer: 1048576, signal });
    if (signal?.aborted) return { origin: null, source: 'default' };
    let lsRows = 0;
    const dropped = new Set();
    const candidates = String(stdout).split('\n')
      .map(line => {
        const row = line.match(/^\s*(\d+)\s+(.*)$/);
        if (!row) return null;
        const command = row[2];
        const first = command.match(FIRST_ARGUMENT);
        const executable = first?.[1] ?? first?.[2];
        if (!executable || !LS_EXECUTABLE.test(executable)) return null;
        lsRows++;
        if (appRoot && !executable.startsWith(appRoot)) { dropped.add('bundle'); return null; }
        const match = command.slice(command.indexOf(executable) + executable.length).match(/--api_server_url[ =](\S+)/);
        if (!match) { dropped.add('flag'); return null; }
        return { pid: parseInt(row[1], 10), value: match[1].trim() };
      })
      .filter(Boolean)
      .sort((a, b) => b.pid - a.pid);
    for (const candidate of candidates) {
      try {
        const origin = resolveUpstreamOrigin(candidate.value);
        if (origin) return { origin, source: 'ls-arg' };
      } catch { dropped.add('origin'); }
    }
    // An LS that exists but could not be adopted is exactly the silent fallback
    // this diagnostic exists for: the caller sees 'portal'/'default' and would
    // otherwise never learn that a source was rejected.
    if (lsRows > 0) try { onDiag?.({ dropped: [...dropped].sort() }); } catch {}
  } catch {}
  // An aborted trigger must not fall through to the portal either — the
  // resolution result is about to be discarded anyway.
  if (signal?.aborted) return { origin: null, source: 'default' };
  let portal;
  try {
    for (const section of ['devin', 'windsurf']) {
      const value = vscode?.workspace?.getConfiguration?.(section)?.get?.('portalUrl');
      if (typeof value === 'string' && value.trim()) { portal = value.trim(); break; }
    }
    if (!portal) {
      const value = vscode?.workspace?.getConfiguration?.('windsurf')?.get?.('serviceUrl');
      if (typeof value === 'string' && value.trim()) portal = value.trim();
    }
  } catch {}
  if (portal) {
    try {
      const origin = resolveUpstreamOrigin(portal.replace(/\/$/, '') + '/_route/api_server');
      if (origin) return { origin, source: 'portal' };
    } catch {}
  }
  return { origin: null, source: 'default' };
}
// Activation runs about a second before the language server spawns, so the
// first resolution commonly lands on 'default' even when an LS-arg origin
// exists. Resolve once, then re-resolve after each delay until a non-default
// source appears or the caller's window closes (shouldContinue === false).
async function resolveEffectiveOriginWhenAvailable({
  vscode, exec, execPath, signal, sleep = sleepDefault, delays = [2000, 5000, 10000], shouldContinue = () => true, onDiag,
} = {}) {
  const stop = () => Boolean(signal?.aborted) || !shouldContinue();
  if (stop()) return { origin: null, source: 'default' };
  let result = await resolveEffectiveOrigin({ vscode, exec, execPath, signal, onDiag });
  for (const delay of delays) {
    if (result.source !== 'default' || stop()) return result;
    await sleep(delay, signal);
    if (stop()) return result;
    result = await resolveEffectiveOrigin({ vscode, exec, execPath, signal, onDiag });
  }
  return result;
}
module.exports = { resolveEffectiveOrigin, resolveEffectiveOriginWhenAvailable };

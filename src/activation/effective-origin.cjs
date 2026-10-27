'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveUpstreamOrigin } = require('../runtime/upstream-origin.cjs');
const execFileAsync = promisify(execFile);
const sleepDefault = ms => new Promise(resolve => { const t = setTimeout(resolve, ms); t.unref?.(); });
// The native `codeium.apiServerUrl` is a derived value, not a user setting:
// the shipped config getter short-circuits `codeium.*` to the login response
// and portal derivation, so a hand-written settings.json value is silently
// ignored (verified 2026-10-27). Resolve the same chain natively: the newest
// language server's `--api_server_url` argument, then the portal route, then
// the deployment default. The origin string never reaches logs or receipts —
// only `source` may be recorded.
// ps lines are matched on the *executable* position (`/language_server_*`),
// not a bare substring — a command line merely mentioning the binary name
// (e.g. our own `ps | grep`-style self-match) must not be picked. Only the
// text after that position is searched for the flag. Candidates are tried in
// pid order, newest first, so one row whose argument is invalid cannot hide a
// legitimate older process.
const LS_EXECUTABLE = /\/language_server_[A-Za-z0-9_]+(?:\s|$)/;
async function resolveEffectiveOrigin({ vscode, exec = execFileAsync } = {}) {
  try {
    const { stdout } = await exec('/bin/ps', ['-Ao', 'pid=,command='], { timeout: 2000, maxBuffer: 1048576 });
    const candidates = String(stdout).split('\n')
      .map(line => {
        const at = line.search(LS_EXECUTABLE);
        if (at < 0) return null;
        const match = line.slice(at).match(/--api_server_url[ =](\S+)/);
        return match ? { pid: parseInt(line, 10), value: match[1].trim() } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.pid - a.pid);
    for (const candidate of candidates) {
      try {
        const origin = resolveUpstreamOrigin(candidate.value);
        if (origin) return { origin, source: 'ls-arg' };
      } catch {}
    }
  } catch {}
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
  vscode, exec, sleep = sleepDefault, delays = [2000, 5000, 10000], shouldContinue = () => true,
} = {}) {
  let result = await resolveEffectiveOrigin({ vscode, exec });
  for (const delay of delays) {
    if (result.source !== 'default' || !shouldContinue()) return result;
    await sleep(delay);
    if (!shouldContinue()) return result;
    result = await resolveEffectiveOrigin({ vscode, exec });
  }
  return result;
}
module.exports = { resolveEffectiveOrigin, resolveEffectiveOriginWhenAvailable };

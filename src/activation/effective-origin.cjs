'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveUpstreamOrigin } = require('../runtime/upstream-origin.cjs');
const execFileAsync = promisify(execFile);
// The native `codeium.apiServerUrl` is a derived value, not a user setting:
// the shipped config getter short-circuits `codeium.*` to the login response
// and portal derivation, so a hand-written settings.json value is silently
// ignored (verified 2026-10-27). Resolve the same chain natively: the newest
// language server's `--api_server_url` argument, then the portal route, then
// the deployment default. The origin string never reaches logs or receipts —
// only `source` may be recorded.
async function resolveEffectiveOrigin({ vscode, exec = execFileAsync } = {}) {
  try {
    const { stdout } = await exec('/bin/ps', ['-Ao', 'pid=,command='], { timeout: 2000, maxBuffer: 1048576 });
    const lines = String(stdout).split('\n')
      .filter(line => line.includes('language_server_macos_arm') && line.includes('--api_server_url'))
      .sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
    const match = lines[0]?.match(/--api_server_url[ =](\S+)/);
    if (match) {
      try {
        const origin = resolveUpstreamOrigin(match[1].trim());
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
module.exports = { resolveEffectiveOrigin };

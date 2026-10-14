'use strict';

// The CLI persists per-identity caches under ~/.cache/devin/cli as JSON
// envelopes ({version, identity_digest, fetched_at_secs, payload}) whose
// payload is a base64 proto body. The model picker intersects those cached
// catalogs with the fresh allowed-uid whitelist, so a cache written before a
// config change keeps the old dfbyok uids and silently drops every entry whose
// uid digest drifted (fusion presets survive because their uid derives only
// from the preset id). Cache entries are regenerable; renaming a stale file
// aside forces the CLI to re-fetch through the backend on its next read.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_NAME = /^(user_status|model_configs_v5|team_settings)\.[0-9a-f]{16}\.bin$/;
const OWN_MARKER = 'dfbyok-';

function defaultDir() { return path.join(os.homedir(), '.cache', 'devin', 'cli'); }

// Lists cache files owned by a backend-routed identity (payload carries at
// least one dfbyok uid) and reports which expected uids each one is missing.
function inspectCliCaches({ dir = defaultDir(), expectedUids = [] } = {}) {
  const expected = [...new Set(expectedUids)].filter(uid => typeof uid === 'string' && uid.includes(OWN_MARKER));
  const entries = [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return { expected, entries, checked: 0 }; }
  for (const name of names) {
    if (!CACHE_NAME.test(name)) continue;
    const file = path.join(dir, name);
    let payload;
    try {
      const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof envelope?.payload !== 'string') continue;
      payload = Buffer.from(envelope.payload, 'base64');
    } catch { continue; }
    const text = payload.toString('latin1');
    if (!text.includes(OWN_MARKER)) continue;
    entries.push({ name, file, missing: expected.filter(uid => !text.includes(uid)) });
  }
  return { expected, entries, checked: entries.length };
}

// Renames every backend-owned cache file that is missing at least one expected
// uid to `<name>.stale`, overwriting a previous aside copy. Files that contain
// no dfbyok marker belong to other identities and are left untouched.
function invalidateStaleCliCaches({ dir = defaultDir(), expectedUids = [] } = {}) {
  const { entries, checked } = inspectCliCaches({ dir, expectedUids });
  const invalidated = [], errors = [];
  for (const entry of entries) {
    if (!entry.missing.length) continue;
    try {
      fs.renameSync(entry.file, entry.file + '.stale');
      invalidated.push(entry.name);
    } catch (error) {
      errors.push({ name: entry.name, code: error?.code || 'rename-failed' });
    }
  }
  return { checked, invalidated, errors };
}

module.exports = { CACHE_NAME, inspectCliCaches, invalidateStaleCliCaches };

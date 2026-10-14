'use strict';

// The CLI persists per-identity caches under ~/.cache/devin/cli as JSON
// envelopes ({version, identity_digest, fetched_at_secs, payload}) whose
// payload is a base64 proto body. The model picker intersects those cached
// catalogs with the fresh allowed-uid whitelist, so a cache written before a
// config change keeps the old dfbyok uids and silently drops every entry whose
// uid digest drifted (fusion presets survive because their uid derives only
// from the preset id). Renaming a stale file aside is NOT viable on this CLI
// version: it never re-fetches a missing model_configs file, so the picker
// stays empty until the file is restored by hand. Instead the payload is
// rewritten in place through the same catalog augmentation the backend
// applies, after verifying the new payload loses no expected uid and gains at
// least one.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_NAME = /^(user_status|model_configs_v5|team_settings)\.[0-9a-f]{16}\.bin$/;
const OWN_MARKER = 'dfbyok-';
const CACHE_RPC = {
  user_status: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
  model_configs_v5: '/exa.language_server_pb.LanguageServerService/GetCliModelConfigs',
  team_settings: '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings',
};

function defaultDir() { return path.join(os.homedir(), '.cache', 'devin', 'cli'); }

function requireDir(dir) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('dir is required');
}

// Lists cache files owned by a backend-routed identity (payload carries at
// least one dfbyok uid) and reports which expected uids each one is missing.
// `dir` is required so no caller can silently aim at the real user cache.
function inspectCliCaches({ dir, expectedUids = [], staleProbe } = {}) {
  requireDir(dir);
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
    let stale = [];
    if (typeof staleProbe === 'function') {
      try { stale = staleProbe(payload) || []; } catch { stale = []; }
    }
    entries.push({ name, file, missing: expected.filter(uid => !text.includes(uid)), stale });
  }
  return { expected, entries, checked: entries.length };
}

let tmpSequence = 0;
function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${++tmpSequence}`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

const presentUids = (payload, expected) => {
  const text = payload.toString('latin1');
  return new Set(expected.filter(uid => text.includes(uid)));
};

// Rewrites stale backend-owned cache files in place: the augmented payload
// must keep every expected uid already present and add at least one, the
// original bytes are kept at `<file>.bak`, and the envelope metadata is
// preserved verbatim. Files without the dfbyok marker belong to other
// identities and are never touched; the primary file is never renamed or
// deleted.
// Rewrites stale backend-owned cache files in place. The augmented payload must
// keep every expected uid already present and differ from the stored bytes —
// adding missing uids, dropping stale emitted entries, or (with `force`)
// refreshing entries whose shape changed while their uids stayed the same, e.g.
// a dimension value that gained an explicit order. `force` is what the panel
// button uses: the automatic check only looks at uid presence, so it cannot see
// a payload that is complete yet out of date.
function refreshStaleCliCaches({ dir, expectedUids = [], staleProbe, augment, force = false } = {}) {
  requireDir(dir);
  const { expected, entries, checked } = inspectCliCaches({ dir, expectedUids, staleProbe });
  const refreshed = [], skipped = [], errors = [];
  const canAugment = typeof augment === 'function';
  for (const entry of entries) {
    if (!force && !entry.missing.length && !(entry.stale || []).length) continue;
    const rpc = CACHE_RPC[entry.name.slice(0, entry.name.indexOf('.'))];
    if (!rpc || !canAugment) { skipped.push({ name: entry.name, reason: 'unsupported' }); continue; }
    let envelope, payload;
    try {
      envelope = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
      payload = Buffer.from(envelope.payload, 'base64');
    } catch (error) { skipped.push({ name: entry.name, reason: 'read-failed' }); continue; }
    let next;
    try { next = augment(payload, rpc); } catch { next = null; }
    if (!Buffer.isBuffer(next) || !next.length) { skipped.push({ name: entry.name, reason: 'augment-failed' }); continue; }
    // Rewrite only when the augmented payload loses no expected uid and actually
    // changes the bytes; an identical payload is the one no-improvement case
    // (it also avoids pointless .bak churn).
    const before = presentUids(payload, expected), after = presentUids(next, expected);
    if (![...before].every(uid => after.has(uid)) || payload.equals(next)) {
      skipped.push({ name: entry.name, reason: 'no-improvement' });
      continue;
    }
    try {
      atomicWrite(entry.file + '.bak', fs.readFileSync(entry.file));
      atomicWrite(entry.file, JSON.stringify({ ...envelope, payload: next.toString('base64') }));
      refreshed.push(entry.name);
    } catch (error) {
      errors.push({ name: entry.name, code: error?.code || 'write-failed' });
    }
  }
  return { checked, refreshed, skipped, errors };
}

module.exports = { CACHE_NAME, OWN_MARKER, CACHE_RPC, defaultDir, inspectCliCaches, refreshStaleCliCaches };

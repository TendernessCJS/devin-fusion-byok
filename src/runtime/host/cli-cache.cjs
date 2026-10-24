'use strict';

// The CLI persists per-identity caches under ~/.cache/devin/cli as JSON
// envelopes ({version, identity_digest, fetched_at_secs, payload}) whose
// payload is a base64 proto body. The model picker intersects those cached
// catalogs with the fresh allowed-uid whitelist, so a cache written before a
// config change keeps the old dfbyok uids and silently drops every entry whose
// uid digest drifted (fusion presets survive because their uid derives only
// from the preset id). Renaming a stale file aside is NOT viable: measured
// 2026-10-24, deleting every model_configs file brought back only the v6
// generation (both identities, within a minute) while v1..v5 stayed gone, and
// which path or trigger performs that rebuild is unconfirmed — so the picker
// can stay empty until the file is restored by hand. Instead the payload is
// rewritten in place through the same catalog augmentation the backend
// applies, after verifying the new payload loses no expected uid and gains at
// least one.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseFields } = require('../../protocol/wire.cjs');
const { validateProtoCatalog, isOwnUid } = require('../../catalog/payload.cjs');

const CACHE_NAME = /^(user_status|team_settings)\.[0-9a-f]{16}\.bin$/;
const OWN_MARKER = 'dfbyok-';
const CACHE_RPC = {
  user_status: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
  model_configs_v5: '/exa.language_server_pb.LanguageServerService/GetCliModelConfigs',
  model_configs_v6: '/exa.language_server_pb.LanguageServerService/GetCliModelConfigs',
  team_settings: '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings',
};
// Every model_configs* filename is a write candidate — v6 is simply the
// generation this CLI currently creates (deleting them all brought back only
// v6, measured 2026-10-24). Writability is decided by the file contents, not
// the generation number: a candidate whose envelope and payload validate is
// supported regardless of its _vN suffix, while JSON-but-malformed candidates
// are flagged for the panel as a future format this build does not adapt.
const MODEL_CONFIGS = /^model_configs(?:_v(\d+))?(?:\.[0-9a-f]{16})?\.bin$/;
const CACHE_PREFIX_RPC = [
  ['model_configs', '/exa.language_server_pb.LanguageServerService/GetCliModelConfigs'],
  ['user_status', '/exa.language_server_pb.LanguageServerService/GetUserStatus'],
  ['team_settings', '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings'],
];
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function rpcFor(name) {
  for (const [prefix, rpc] of CACHE_PREFIX_RPC) if (name.startsWith(prefix)) return rpc;
  return null;
}

function defaultDir() { return path.join(os.homedir(), '.cache', 'devin', 'cli'); }

function requireDir(dir) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('dir is required');
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const isJson = raw => {
  const text = raw.toString('utf8').trimStart();
  if (text.startsWith('{') || text.startsWith('[')) return true;
  try { JSON.parse(text); return true; } catch { return false; }
};
const genOf = match => (match && match[1] ? Number(match[1]) : 1);

// Reads every candidate once and classifies it in a single pass: 'supported'
// files validated end-to-end, 'legacy' model_configs files whose first byte is
// not JSON, 'unsupported' model_configs files that are JSON but fail
// validation, and 'rejected' files that could not even be read. Both the
// coverage report and the rewrite path consume this one classification.
function inspect(dir) {
  let names;
  try { names = fs.readdirSync(dir); }
  catch (error) {
    const dirState = (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') ? 'missing' : 'unreadable';
    return { dirState, items: [] };
  }
  const items = [];
  for (const name of names) {
    // Our own rewrite artifacts are not cache generations.
    if (name.endsWith('.bak') || /\.tmp-\d+-\d+$/.test(name)) continue;
    const modelConfigs = MODEL_CONFIGS.exec(name);
    if (!modelConfigs && !CACHE_NAME.test(name)) {
      if (name.startsWith('model_configs')) items.push({ name, bucket: 'unsupported', generation: null });
      continue;
    }
    const file = path.join(dir, name);
    const read = readSupported(file, name);
    if (read.code) {
      const invalid = read.code === 'unsupported-envelope' || read.code === 'malformed-payload' || read.code === 'shape-unrecognized';
      if (modelConfigs && invalid && read.raw && isJson(read.raw)) items.push({ name, bucket: 'unsupported', generation: genOf(modelConfigs), reason: read.code });
      else if (modelConfigs && invalid) items.push({ name, bucket: 'legacy', generation: genOf(modelConfigs) });
      else if (invalid && read.raw && isJson(read.raw)) items.push({ name, bucket: 'unsupported', generation: null, reason: read.code });
      else items.push({ name, bucket: 'rejected', reason: read.code });
      continue;
    }
    items.push({ name, file, kind: name.slice(0, name.indexOf('.')), modelConfigs,
      generation: modelConfigs ? genOf(modelConfigs) : undefined, read, bucket: 'supported' });
  }
  return { dirState: 'ok', items };
}

function coverageOf({ dirState, items }) {
  let supported = 0;
  const legacy = [], unsupported = [], generations = [];
  for (const item of items) {
    if (item.bucket === 'supported') {
      supported += 1;
      if (item.modelConfigs) generations.push({ generation: item.generation, name: item.name,
        fetchedAt: item.read.envelope.fetched_at_secs,
        own: (item.read.uids || []).some(isOwnUid) });
    } else if (item.bucket === 'legacy') legacy.push({ name: item.name, generation: item.generation });
    else if (item.bucket === 'unsupported') unsupported.push({ name: item.name, generation: item.generation });
  }
  legacy.sort(byName); unsupported.sort(byName); generations.sort(byName);
  let current;
  for (const entry of generations) {
    if (!current || entry.generation > current.generation ||
        (entry.generation === current.generation && entry.fetchedAt > current.fetchedAt)) {
      current = { generation: entry.generation, name: entry.name, fetchedAt: entry.fetchedAt };
    }
  }
  return { dirState, supported, legacy, unsupported, generations, current,
    dynamic: generations.some(entry => entry.generation > 6) };
}

// Directory coverage: which cache generations exist on disk and which of them
// this build can rewrite. The result feeds panel state, so it is fully
// determined by the directory contents — no timestamps or counters.
function inspectCliCacheCoverage({ dir } = {}) {
  requireDir(dir);
  return coverageOf(inspect(dir));
}

// Reads a candidate file and validates the JSON envelope plus the protobuf
// payload shape before anything is derived from it. Returns either
// {envelope, payload, raw, uids} or {code, raw?} with a stable reason the panel
// can show: 'read-failed', 'too-large' (the file is never read),
// 'unsupported-envelope' (JSON/version/identity/base64 do not match the known
// envelope contract), 'malformed-payload' (the decoded bytes do not parse or
// the list shape is empty where a catalog is mandatory) or
// 'shape-unrecognized' (entries exist but are not real model/uid records).
// Writability is decided by these bytes alone — a valid envelope at any
// generation is writable; arbitrary dfbyok-looking text proves nothing, only
// a real f22/f7 uid does.
const KIND_RPC = [
  ['model_configs', '/exa.language_server_pb.LanguageServerService/GetCliModelConfigs', false],
  ['user_status', '/exa.language_server_pb.LanguageServerService/GetUserStatus', true],
];
function readSupported(file, kind) {
  let stat;
  try { stat = fs.statSync(file); } catch { return { code: 'read-failed' }; }
  if (stat.size > MAX_CACHE_BYTES) return { code: 'too-large' };
  let raw;
  try { raw = fs.readFileSync(file); } catch { return { code: 'read-failed' }; }
  let envelope;
  try { envelope = JSON.parse(raw.toString('utf8')); } catch { return { code: 'unsupported-envelope', raw }; }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.version !== 1 ||
    typeof envelope.identity_digest !== 'string' || !envelope.identity_digest ||
    !Number.isSafeInteger(envelope.fetched_at_secs) ||
    typeof envelope.payload !== 'string' || !(envelope.payload === '' ? kind.startsWith('model_configs') : STRICT_BASE64.test(envelope.payload))) {
    return { code: 'unsupported-envelope', raw };
  }
  const payload = Buffer.from(envelope.payload, 'base64');
  // A zero-byte flat payload is the legal default-empty model list — it
  // carries no uid, never earns write access, and stays out of diagnostics.
  if (!payload.length && kind.startsWith('model_configs')) return { envelope, payload, raw, uids: [] };
  const verdict = validatePayload(kind, payload, false);
  if (!verdict.ok) return { code: verdict.code, raw };
  return { envelope, payload, raw, uids: verdict.uids };
}

// The one per-kind payload gate, shared by the initial read and the
// post-augment recheck: an empty model_configs list is only legal on output
// (the last own entry being retired), never on input.
function validatePayload(kind, payload, allowEmptyConfigs) {
  const modelKind = KIND_RPC.find(([prefix]) => kind.startsWith(prefix));
  if (modelKind) {
    const verdict = validateProtoCatalog(payload, { rpc: modelKind[1], allowEmpty: modelKind[2] || allowEmptyConfigs });
    return verdict.ok ? { ok: true, uids: verdict.uids } : { ok: false, code: verdict.code };
  }
  // team_settings: the allowlist lives at f7 wire2 — every f7 must be a
  // string; an absent list is the legal "unrestricted" shape, never malformed.
  if (kind.startsWith('team_settings')) {
    let parsed;
    try { parsed = parseFields(payload); } catch { return { code: 'malformed-payload' }; }
    const uids = [];
    for (const field of parsed) {
      if (field.number !== 7) continue;
      if (field.wire !== 2) return { code: 'shape-unrecognized' };
      uids.push(field.value.toString('utf8'));
    }
    return { ok: true, uids };
  }
  return { ok: false, code: 'shape-unrecognized' };
}

// Own uids actually inside a payload (real f22/f7 values, never label text).
function ownedIn(kind, payload, expected) {
  const verdict = validatePayload(kind, payload, true);
  if (!verdict.ok) return { own: [], present: new Set() };
  const uids = new Set(verdict.uids);
  return { own: verdict.uids.filter(isOwnUid), present: new Set(expected.filter(uid => uids.has(uid))) };
}

// Lists cache files owned by a backend-routed identity (payload carries at
// least one dfbyok uid) and reports which expected uids each one is missing.
// Retirement (removing stored own entries) requires the caller to assert the
// native catalog is authoritative; `retire: false` means additive-only and
// must never delete an already-present own uid.
// Supported files that fail envelope/payload validation land in `rejected`
// instead — they are reported and left alone, never treated as ours.
// `dir` is required so no caller can silently aim at the real user cache.
function inspectCliCaches({ dir, expectedUids = [], staleProbe, retire = true } = {}) {
  requireDir(dir);
  const expected = [...new Set(expectedUids)].filter(uid => typeof uid === 'string' && uid.includes(OWN_MARKER));
  const entries = [], rejected = [];
  const scanned = inspect(dir);
  if (scanned.dirState !== 'ok') {
    return { expected, entries, rejected, checked: 0,
      coverage: coverageOf({ dirState: scanned.dirState, items: [] }) };
  }
  const coverage = coverageOf(scanned);
  for (const item of scanned.items) {
    if (item.bucket === 'rejected' || item.bucket === 'unsupported' && item.reason) {
      rejected.push({ name: item.name, reason: item.reason }); continue;
    }
    if (item.bucket !== 'supported') continue;
    const ownUids = (item.read.uids || []).filter(isOwnUid);
    if (!ownUids.length) continue;
    let stale = [];
    if (retire !== false) {
      if (typeof staleProbe === 'function') {
        try { stale = staleProbe(item.read.payload) || []; } catch { stale = []; }
      }
      // Own uids present in the stored list but absent from the current emit
      // are stale by definition — this is what retires the last own entry,
      // and it fires even when `expected` is empty.
      stale = [...new Set([...stale, ...ownUids.filter(uid => !expected.includes(uid))])];
    }
    const present = new Set(item.read.uids || []);
    entries.push({ name: item.name, file: item.file, kind: item.kind,
      missing: expected.filter(uid => !present.has(uid)), stale });
  }
  return { expected, entries, rejected, checked: entries.length, coverage };
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

const presentUids = (kind, payload, expected) => ownedIn(kind, payload, expected).present;

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
// `augment(payload, rpc, report)` gets a `report(code)` it can call when it
// leaves a payload untouched for a reason uid presence cannot express (the
// shape it assumed does not match the stored bytes); that code reaches the
// panel instead of being flattened into `no-improvement`.
// The rewrite is a compare-then-replace, never a blind overwrite: the payload is
// re-read first and must still hold the exact bytes that were augmented, so a
// file the CLI refreshed in the meantime is left for the next pass instead of
// losing whatever it stored.
function refreshStaleCliCaches({ dir, expectedUids = [], staleProbe, augment, force = false, retire = true } = {}) {
  requireDir(dir);
  const { expected, entries, rejected, checked, coverage } = inspectCliCaches({ dir, expectedUids, staleProbe, retire });
  const refreshed = [], errors = [];
  const skipped = rejected.map(entry => ({ name: entry.name, reason: entry.reason }));
  const canAugment = typeof augment === 'function';
  for (const entry of entries) {
    if (!force && !entry.missing.length && !(entry.stale || []).length) continue;
    const rpc = rpcFor(entry.name);
    if (!rpc || !canAugment) { skipped.push({ name: entry.name, reason: 'unsupported' }); continue; }
    // Re-read and re-validate before augmenting: the file can have been replaced
    // between the directory scan and now, and a payload that no longer matches
    // the known envelope contract must not be written back over.
    const read = readSupported(entry.file, entry.kind);
    if (read.code) { skipped.push({ name: entry.name, reason: read.code }); continue; }
    const { envelope, payload, raw } = read;
    // `augment(payload, rpc, report)` may call `report(code)` to say why it left
    // the payload alone. Without that signal an untouched payload is
    // indistinguishable from a completed one.
    let next, reported = [];
    try { next = augment(payload, rpc, code => { if (typeof code === 'string') reported.push(code); }); } catch { next = null; }
    if (!Buffer.isBuffer(next)) { skipped.push({ name: entry.name, reason: reported[0] || 'augment-failed' }); continue; }
    // A zero-byte flat result is legal only for the last-own retirement on a
    // model_configs file whose stored uids were all ours — anything else that
    // shrinks to nothing is a transform failure, never a write.
    if (!next.length) {
      const flat = entry.kind.startsWith('model_configs');
      const beforeCheck = flat ? validatePayload(entry.kind, payload, true) : { ok: false };
      const retireable = retire !== false && flat && expected.length === 0 && beforeCheck.ok &&
        beforeCheck.uids.length > 0 && beforeCheck.uids.every(isOwnUid);
      if (!retireable) { skipped.push({ name: entry.name, reason: reported[0] || 'transform-failed' }); continue; }
    }
    // The augmented bytes must be a real catalog too: a malformed or
    // uid-impersonating result is refused, never written.
    const nextCheck = validatePayload(entry.kind, next, expected.length === 0);
    if (!nextCheck.ok) { skipped.push({ name: entry.name, reason: nextCheck.code || 'transform-failed' }); continue; }
    // The non-retirement guard is a hard gate on the final bytes, independent
    // of whatever the augmenter did: when the caller has not asserted the
    // native catalog is authoritative, no stored own uid may leave the file.
    if (retire === false) {
      const ownBefore = validatePayload(entry.kind, payload, true);
      const after = new Set(nextCheck.uids);
      if (ownBefore.ok && ownBefore.uids.some(uid => isOwnUid(uid) && !after.has(uid))) {
        skipped.push({ name: entry.name, reason: 'retire-withheld' }); continue;
      }
    }
    // An emptied list is legitimate only when the emit is empty AND every uid
    // the output dropped was ours — losing native entries is never a rewrite.
    if (!nextCheck.uids.length && expected.length === 0) {
      const beforeCheck = validatePayload(entry.kind, payload, true);
      if (!beforeCheck.ok || beforeCheck.uids.some(uid => !isOwnUid(uid))) {
        skipped.push({ name: entry.name, reason: 'transform-failed' }); continue;
      }
    }
    // Rewrite only when the augmented payload loses no expected uid and actually
    // changes the bytes; an identical payload is the one no-improvement case
    // (it also avoids pointless .bak churn).
    const before = presentUids(entry.kind, payload, expected), after = presentUids(entry.kind, next, expected);
    if (![...before].every(uid => after.has(uid)) || payload.equals(next)) {
      // `no-improvement` must mean "nothing left to do". When the augmenter
      // reported a skip and expected uids are still absent afterwards the
      // rewrite could not do its job, and calling that "nothing to do" is what
      // hid a shape bug where every `user_status` rewrite was a silent no-op.
      const stalled = reported.length && expected.some(uid => !after.has(uid));
      skipped.push({ name: entry.name, reason: stalled ? reported[0] : 'no-improvement' });
      continue;
    }
    try {
      // The CLI owns these files too: it fetches the augmented catalog through
      // the bridge and persists it on its own schedule, so the bytes we augmented
      // can already be superseded by the time this lands. Overwriting a fresher
      // payload with an augmentation of an older one would drop whatever it just
      // stored, and the check runs on every native sync, so a changed file is
      // simply left for the next pass. The window is the few microseconds between
      // this read and the rename below.
      let current;
      try { current = fs.readFileSync(entry.file); }
      catch { errors.push({ name: entry.name, code: 'read-failed' }); continue; }
      if (!current.equals(raw)) { skipped.push({ name: entry.name, reason: 'concurrent-write' }); continue; }
      // The CLI can rewrite the file into an all-native catalog between the
      // scan and now; re-check ownership on the bytes we are about to replace.
      try {
        const freshEnvelope = JSON.parse(current.toString('utf8'));
        const freshOwned = ownedIn(entry.kind, Buffer.from(freshEnvelope.payload, 'base64'), expected);
        if (!freshOwned.own.length) { skipped.push({ name: entry.name, reason: 'concurrent-write' }); continue; }
      } catch { skipped.push({ name: entry.name, reason: 'concurrent-write' }); continue; }
      // `.bak` is the payload this rewrite was derived from, not a fresh read
      // that may already belong to a newer generation.
      atomicWrite(entry.file + '.bak', raw);
      atomicWrite(entry.file, JSON.stringify({ ...envelope, payload: next.toString('base64') }));
      refreshed.push(entry.name);
    } catch (error) {
      errors.push({ name: entry.name, code: error?.code || 'write-failed' });
    }
  }
  return { checked, refreshed, skipped, errors, coverage };
}

module.exports = { CACHE_NAME, OWN_MARKER, CACHE_RPC, MAX_CACHE_BYTES, defaultDir, rpcFor,
  inspectCliCacheCoverage, inspectCliCaches, refreshStaleCliCaches };

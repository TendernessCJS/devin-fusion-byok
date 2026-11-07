'use strict';

const { createRequire } = require('node:module');
const { augmentCatalog, collectNativeModels, validateProtoCatalog } = require('../../catalog.cjs');
const { isUpstreamUid } = require('./native-models.cjs');
const { restoreMember } = require('./acp-hook.cjs');

const INSTANCE = Symbol.for('devin-fusion-byok.auth-status.v1');
const USER_STATUS_RPC = '/exa.language_server_pb.LanguageServerService/GetUserStatus';

// Diagnostic only: raw marker occurrences. A uid appears once per model entry
// and again inside sort groups, so this signals presence, not entry count.
function ownMarkers(buffer) {
  return (buffer.toString('latin1').match(/(?:fusion-)?dfbyok-/g) || []).length;
}

// The new agent window's picker filters ACP configOptions against the stored
// `userStatus.cascadeModelConfigData`; the store is written through
// `windsurfAuth.setAuthStatus`, so rewriting it here is the one interception
// point that reaches the picker regardless of which transport fetched the
// status. `userStatusProtoBinaryBase64` is the bare UserStatus message (model
// list at f33); the command allowlist field is deliberately left untouched.
// This wrapper now has exactly three jobs: rewrite the stored userStatus so
// the picker sees the merged catalog, observe native entries back into the
// catalog sync, and counter-observe our own entries. The publication
// confirmation chain died with Devin 3.12.17 — the desktop command it
// refreshed through no longer exists — so calls settle without emitting any
// coordination events.
function installAuthStatusInjection({ nativeMainPath, getCatalog, log = () => {},
  isEnabled = () => true, onNativeModels } = {}) {
  if (typeof nativeMainPath !== 'string' || !nativeMainPath || typeof getCatalog !== 'function') {
    throw new TypeError('nativeMainPath and a getCatalog function are required');
  }
  const nativeRequire = createRequire(nativeMainPath);
  const api = nativeRequire('vscode')?.windsurfAuth;
  if (!api || typeof api.setAuthStatus !== 'function') {
    throw new Error('Native windsurfAuth injection API is unavailable');
  }
  if (api[INSTANCE]) return api[INSTANCE];

  const descriptor = Object.getOwnPropertyDescriptor(api, 'setAuthStatus');
  const original = api.setAuthStatus;
  let disposed = false, active = true, calls = 0, rewrites = 0;

  const enabled = () => {
    if (disposed || !active) return false;
    try { return isEnabled() !== false; } catch { return false; }
  };

  // Feeds freshly observed upstream entries back to the catalog sync before
  // the catalog snapshot is taken — the observation may enrich the catalog
  // synchronously, and the snapshot must describe what this call actually
  // rewrites against. Only entries this extension cannot have emitted are
  // eligible: upstream uids minus the emitted matrix combinations.
  function collect(value) {
    try {
      const encoded = value?.userStatusProtoBinaryBase64;
      if (typeof encoded !== 'string' || !encoded) return;
      const observed = collectNativeModels(Buffer.from(encoded, 'base64'), { rpc: USER_STATUS_RPC, format: {} });
      const matrixUids = getCatalog()?.matrixUids;
      const foreign = observed.filter(entry => isUpstreamUid(entry?.uid) &&
        !(matrixUids && typeof matrixUids.has === 'function' && matrixUids.has(entry.uid)));
      if (foreign.length) try { onNativeModels?.(foreign); } catch {}
    } catch {}
  }

  // The rewrite decision needs the current catalog only; no signature is
  // computed anymore now that nothing confirms a publication.
  function snapshot() {
    try { return getCatalog(); } catch { return null; }
  }

  // The committed bytes must provably contain the emit: every target model's
  // uid resolves to its exact raw entry and no directly hidden uid survives.
  // Verifying the output (not the input) is what lets a legitimately
  // idempotent payload pass through unrewritten.
  function verify(next, catalog) {
    const verdict = validateProtoCatalog(next, { rpc: USER_STATUS_RPC, allowEmpty: true });
    if (!verdict.ok) return { ok: false, code: verdict.code };
    const models = Array.isArray(catalog?.models) ? catalog.models : [];
    const hidden = new Set([...(catalog?.hiddenNativeModelUids || []), ...(catalog?.hiddenFusionUids || [])]);
    const present = new Map();
    for (let index = 0; index < verdict.entries.length; index++) present.set(verdict.uids[index], verdict.entries[index]);
    for (const model of models) {
      const entry = present.get(model.uid);
      if (!entry || !Buffer.isBuffer(model.raw) || !entry.equals(model.raw)) return { ok: false, code: 'emit-unverified' };
    }
    for (const uid of hidden) if (present.has(uid)) return { ok: false, code: 'emit-unverified' };
    return { ok: true, entries: verdict.entries, uids: verdict.uids };
  }

  function augment(value, catalog) {
    const encoded = value.userStatusProtoBinaryBase64;
    const payload = Buffer.from(encoded, 'base64');
    if (!payload.length) return { ok: false, code: 'malformed-payload' };
    const skipped = [];
    let next;
    try {
      next = augmentCatalog(payload, { rpc: USER_STATUS_RPC, format: {}, catalog, retireOwn: true,
        onSkip: code => { if (typeof code === 'string') skipped.push(code); } });
    } catch { return { ok: false, code: 'transform-failed' }; }
    if (skipped.length) return { ok: false, code: skipped[0] };
    if (!Buffer.isBuffer(next) || !next.length) return { ok: false, code: 'transform-failed' };
    const checked = verify(next, catalog);
    if (!checked.ok) return { ok: false, code: checked.code };
    return { ok: true, next };
  }

  function setAuthStatus(...args) {
    calls++;
    const input = args[0];
    const encoded = input && typeof input === 'object' && !Array.isArray(input) ? input.userStatusProtoBinaryBase64 : null;
    if (typeof encoded === 'string' && encoded && enabled()) {
      collect(input);
      const catalog = snapshot();
      const rewritten = augment(input, catalog);
      // A transform that cannot produce verifiable bytes degrades to the
      // untouched call: the native write still runs, nothing is rewritten.
      if (rewritten.ok && !nextEquals(input, rewritten.next)) {
        rewrites++;
        try {
          log('auth-status', { before: Buffer.from(encoded, 'base64').length, after: rewritten.next.length,
            beforeOwn: ownMarkers(Buffer.from(encoded, 'base64')), afterOwn: ownMarkers(rewritten.next) });
        } catch {}
        args = [{ ...input, userStatusProtoBinaryBase64: rewritten.next.toString('base64') }, ...args.slice(1)];
      }
    }
    return Reflect.apply(original, this, args);
  }

  function nextEquals(input, next) {
    try { return Buffer.from(input.userStatusProtoBinaryBase64, 'base64').equals(next); } catch { return false; }
  }

  const handle = {
    get status() {
      return Object.freeze({ state: disposed ? 'disposed' : active ? 'observing' : 'passthrough', calls, rewrites });
    },
    // The wrapper is shadowed when another extension overwrote ours after
    // installation; callers treat that like the hook being unavailable.
    shadowed() { try { return api.setAuthStatus !== setAuthStatus; } catch { return true; } },
    // Stops augmenting but keeps the wrapper installed: calls in the disable
    // window pass through untouched until dispose restores the member.
    deactivate() { active = false; },
    dispose() {
      if (disposed) return;
      disposed = true; active = false;
      try { restoreMember(api, 'setAuthStatus', setAuthStatus, descriptor); } catch {}
      if (api[INSTANCE] === handle) delete api[INSTANCE];
    },
  };

  try {
    api.setAuthStatus = setAuthStatus;
    if (api.setAuthStatus !== setAuthStatus) throw new Error('setAuthStatus could not be wrapped');
    Object.defineProperty(api, INSTANCE, { value: handle, configurable: true });
  } catch (error) {
    try { restoreMember(api, 'setAuthStatus', setAuthStatus, descriptor); } catch {}
    throw error;
  }
  return handle;
}

module.exports = { installAuthStatusInjection };

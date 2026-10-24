'use strict';

const { createRequire } = require('node:module');
const { augmentCatalog, collectNativeModels, catalogSignature, validateProtoCatalog, isOwnUid } = require('../../catalog.cjs');
const { parseFields } = require('../../protocol/wire.cjs');
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
// Every call reports {phase, callId, signature, code?, nativeApplied?} to the
// publication coordinator; events never carry auth objects, payloads or error
// text. Confirmation is earned, not assumed: an output that cannot be verified
// as the emit settles 'failed' with `nativeApplied` instead of 'applied'.
function installAuthStatusInjection({ nativeMainPath, getCatalog, log = () => {},
  isEnabled = () => true, onNativeModels, onPublication } = {}) {
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
  let disposed = false, active = true, calls = 0, rewrites = 0, lastCallId = 0;
  const pending = new Set(), drainWaiters = new Set();
  // Uids this handle demonstrably emitted: every dfbyok-prefixed uid plus the
  // matrix uids it wrote without the official f32 capability record. A
  // passthrough payload still carrying any of them means the store keeps our
  // content — the disable-time restore can never claim success on that basis.
  // Only the uid set is retained: no auth object, payload or credential ever
  // leaves the call.
  const emittedOwnUids = new Set();
  let restoreProbe = null;

  const emit = event => { try { onPublication?.(event); } catch {} };
  const enabled = () => {
    if (disposed || !active) return false;
    try { return isEnabled() !== false; } catch { return false; }
  };

  // Residual detection mirrors the catalog cleanup: a real own uid, or a uid
  // this handle emitted without the official f32 capability record.
  const hasField32 = entry => {
    try { return parseFields(entry).some(field => field.number === 32); } catch { return false; }
  };
  const isResidual = (uid, entry) => isOwnUid(uid) ||
    (emittedOwnUids.has(uid) && !(entry && hasField32(entry)));

  // Feeds freshly observed upstream entries back to the catalog sync before
  // the emit snapshot is taken — the observation may enrich the catalog
  // synchronously, and the snapshot must describe what this call actually
  // publishes. Only entries this extension cannot have emitted are eligible:
  // upstream uids minus the currently emitted matrix combinations.
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

  // One catalog snapshot serves both the signature and the rewrite, so the
  // event cannot describe a different emit than the bytes carry.
  function snapshot() {
    try {
      const catalog = getCatalog();
      return { catalog, signature: catalogSignature(catalog) };
    } catch { return { catalog: null, signature: null }; }
  }

  // The committed bytes must provably contain the emit: every target model's
  // uid resolves to its exact raw entry and no directly hidden uid survives.
  // Verifying the output (not the input) is what lets a legitimately idempotent
  // payload confirm — next.equals(input) alone proves nothing either way.
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
    for (let index = 0; index < verdict.entries.length; index++) {
      const uid = verdict.uids[index];
      if (isOwnUid(uid) ||
          (catalog?.matrixUids?.has?.(uid) && !hasField32(verdict.entries[index]))) emittedOwnUids.add(uid);
    }
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

  function settle(record, phase, code) {
    pending.delete(record);
    if (!pending.size) for (const done of [...drainWaiters]) done();
    // A disposed handle still lets the native promise settle and drains, but
    // must not feed events into whatever coordinator replaced its generation.
    if (disposed) return;
    let publication;
    if (phase === 'applied' && record.confirmable === false) {
      // The native write itself landed but the bytes were never verified as
      // our emit: report the failure with `nativeApplied` so the coordinator
      // treats the store as unknown instead of keeping an earlier `ready`.
      publication = { phase: 'failed', callId: record.callId, signature: null,
        code: record.failCode || 'emit-unverified', nativeApplied: true };
    } else {
      publication = { phase, callId: record.callId, signature: record.signature,
        ...(code ? { code } : {}), nativeApplied: phase === 'applied' };
    }
    emit(publication);
    // Stable observability for real-machine confirmation — phases/ids/flags
    // only, never auth objects, payloads or error text.
    try { log('auth-status-publication', publication); } catch {}
    // Only calls issued after the probe was armed count toward the verdict;
    // an older call settling late must not decide the restore.
    if (restoreProbe && record.callId > restoreProbe.floor) {
      const probe = restoreProbe; restoreProbe = null;
      const verdict = phase !== 'applied' || !record.passthrough || !record.valid || record.residual
        ? { ok: false, code: 'restore-unverified' }
        : { ok: true, code: 'restored' };
      probe.resolve(verdict);
    }
  }

  function track(result, record) {
    if (result && typeof result.then === 'function') {
      pending.add(record);
      // Both callbacks observe the native promise without changing it: the
      // caller still receives the original promise identity, and the derived
      // promise resolves in every branch so nothing rejects unhandled.
      result.then(() => { try { settle(record, 'applied'); } catch {} },
        () => { try { settle(record, 'failed', 'native-call-failed'); } catch {} });
      return;
    }
    try { settle(record, 'applied'); } catch {}
  }

  function setAuthStatus(...args) {
    calls++;
    const callId = ++lastCallId;
    const input = args[0];
    const encoded = input && typeof input === 'object' && !Array.isArray(input) ? input.userStatusProtoBinaryBase64 : null;
    const record = { callId, signature: null, residual: false, passthrough: !enabled(), valid: false, confirmable: true, failCode: null };
    if (typeof encoded !== 'string' || !encoded) {
      // Logout or payload-less write: retire every earlier confirmation and
      // still report the native outcome so a listener sees the call settle.
      emit({ phase: 'cleared', callId, signature: null });
      const result = Reflect.apply(original, this, args);
      track(result, record);
      return result;
    }
    if (!record.passthrough) {
      collect(input);
      const { catalog, signature } = snapshot();
      const rewritten = augment(input, catalog);
      if (rewritten.ok) {
        record.signature = signature;
        if (!nextEquals(input, rewritten.next)) {
          rewrites++;
          try {
            log('auth-status', { before: Buffer.from(encoded, 'base64').length, after: rewritten.next.length,
              beforeOwn: ownMarkers(Buffer.from(encoded, 'base64')), afterOwn: ownMarkers(rewritten.next) });
          } catch {}
          args = [{ ...input, userStatusProtoBinaryBase64: rewritten.next.toString('base64') }, ...args.slice(1)];
        }
      } else {
        // Transform could not produce verifiable bytes: the native call still
        // runs with the untouched input, but its settle must report the
        // failure instead of signing a payload this handle cannot name.
        record.confirmable = false;
        record.failCode = rewritten.code;
      }
    } else {
      // Passthrough mode (deactivation window): the structural scan feeds the
      // disable-time restore verdict — a native payload that is malformed or
      // still carries our entries can never count as a restore.
      const verdict = validateProtoCatalog(Buffer.from(encoded, 'base64'), { rpc: USER_STATUS_RPC, allowEmpty: true });
      record.valid = verdict.ok === true;
      if (record.valid) {
        for (let index = 0; index < verdict.entries.length; index++) {
          if (isResidual(verdict.uids[index], verdict.entries[index])) { record.residual = true; break; }
        }
      }
    }
    emit({ phase: 'attempt', callId, signature: record.signature });
    let result;
    try {
      result = Reflect.apply(original, this, args);
    } catch (error) {
      try { settle(record, 'failed', 'native-call-failed'); } catch {}
      throw error;
    }
    track(result, record);
    return result;
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
    // Stops augmenting but keeps the wrapper installed, so the disable path
    // can observe one passthrough refresh before unhooking.
    deactivate() { active = false; },
    // Resolves true once every tracked native call settled, false on timeout.
    // Dispose wakes waiters too — but reports false, never a claimed drain.
    drain({ timeoutMs = 10000 } = {}) {
      if (disposed) return Promise.resolve(false);
      if (!pending.size) return Promise.resolve(true);
      return new Promise(resolve => {
        const timer = setTimeout(() => { drainWaiters.delete(done); resolve(false); }, timeoutMs);
        const done = () => { clearTimeout(timer); drainWaiters.delete(done); resolve(!disposed); };
        drainWaiters.add(done);
      });
    },
    // One bounded passthrough refresh used to verify the stored catalog no
    // longer carries our entries. `command` performs the native refresh; the
    // verdict resolves 'restored' only when a call issued after the probe was
    // armed lands a structurally valid, own-uid-free payload — anything else
    // (null, malformed, residual, rejected, timed out) is 'restore-unverified'
    // (never a replay, never a sign-out).
    restore({ command, timeoutMs = 10000 } = {}) {
      return new Promise(resolve => {
        const floor = lastCallId;
        const timer = setTimeout(() => { restoreProbe = null; resolve({ ok: false, code: 'restore-timeout' }); }, timeoutMs);
        restoreProbe = { floor, resolve: verdict => { clearTimeout(timer); resolve(verdict); } };
        try { const fired = typeof command === 'function' ? command() : null;
          if (fired && typeof fired.then === 'function') fired.catch(() => {});
          else if (fired === null || fired === undefined) { restoreProbe = null; clearTimeout(timer); resolve({ ok: false, code: 'restore-unverified' }); }
        } catch {
          restoreProbe = null; clearTimeout(timer); resolve({ ok: false, code: 'restore-unverified' });
        }
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true; active = false;
      if (restoreProbe) { const probe = restoreProbe; restoreProbe = null; probe.resolve({ ok: false, code: 'restore-unverified' }); }
      for (const done of [...drainWaiters]) done();
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

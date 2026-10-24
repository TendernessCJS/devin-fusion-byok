'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/runtime/host/auth-status.cjs'), 'utf8');
const NATIVE_MAIN = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/dist/extension.js';
const clone = value => JSON.parse(JSON.stringify(value));
const { s, v, m, parseFields } = require('../src/protocol/wire.cjs');
const realCatalog = require('../src/catalog.cjs');
const cat = (...parts) => Buffer.concat(parts.flat());
const modelEntry = uid => m(1, cat(s(1, uid), s(22, uid)));
// A minimal bare UserStatus: f1 `pro` varint plus the f33 model list container.
const statusPayload = (...uids) => cat(v(1, 1), m(33, cat(uids.map(modelEntry))));

function fixture({ augmentResult, collectResult, catalog = { models: [] }, enabled = true, payload = statusPayload('native-1') } = {}) {
  const paths = [], logs = [], calls = [], publications = [], natives = [];
  const api = { setAuthStatus(...args) { calls.push({ thisArg: this, args }); return 'native-result'; } };
  const augmentCalls = [];
  const augmentCatalog = augmentResult || ((data, options) => {
    augmentCalls.push({ data: Buffer.from(data), options });
    return realCatalog.augmentCatalog(data, options);
  });
  const collectNativeModels = collectResult || (() => []);
  const catalogSignature = realCatalog.catalogSignature;
  const isUpstreamUid = uid => typeof uid === 'string' && !!uid && !/^(?:fusion-)?dfbyok-/.test(uid);
  const createRequire = nativePath => { paths.push(nativePath); return name => {
    assert.equal(name, 'vscode'); return { windsurfAuth: api };
  }; };
  const module = { exports: {} };
  vm.runInNewContext(source, { Buffer, setTimeout, clearTimeout, module, exports: module.exports, require(name) {
    if (name === 'node:module') return { createRequire };
    if (name === '../../catalog.cjs') return { augmentCatalog, collectNativeModels, catalogSignature, validateProtoCatalog: realCatalog.validateProtoCatalog, isOwnUid: realCatalog.isOwnUid };
    if (name === '../../protocol/wire.cjs') return { parseFields };
    if (name === './native-models.cjs') return { isUpstreamUid };
    if (name === './acp-hook.cjs') {
      const hook = { exports: {} };
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/runtime/host/acp-hook.cjs'), 'utf8'),
        { module: hook, exports: hook.exports, require: () => ({ createRequire }) }, { filename: 'acp-hook.cjs' });
      return hook.exports;
    }
    assert.fail('unexpected require ' + name);
  } }, { filename: 'auth-status.cjs' });
  const install = options => module.exports.installAuthStatusInjection({
    nativeMainPath: NATIVE_MAIN, getCatalog: () => catalog,
    log: (event, fields) => logs.push({ event, fields }),
    isEnabled: () => enabled,
    onNativeModels: entries => natives.push(entries),
    onPublication: event => publications.push(event), ...options });
  const status = extra => ({
    apiKey: 'key', apiServerUrl: 'https://server.codeium.com',
    userStatusProtoBinaryBase64: payload.toString('base64'), ...extra });
  return { api, paths, logs, calls, publications, natives, augmentCalls, install, status, payload };
}

test('rewrites the stored userStatus payload through augmentCatalog and preserves call semantics', () => {
  // A catalog with one own model makes the emit change the stored payload;
  // verification then proves the emitted entry is really inside it.
  const ownRaw = cat(s(1, 'own'), s(22, 'dfbyok-own-x'));
  const f = fixture({ catalog: { models: [{ uid: 'dfbyok-own-x', label: 'own', raw: ownRaw }] } });
  const handle = f.install(), receiver = {}, extra = {};
  const input = f.status();
  const result = f.api.setAuthStatus.call(receiver, input, extra);
  assert.equal(result, 'native-result');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].thisArg, receiver);
  const forwarded = f.calls[0].args[0];
  assert.notEqual(forwarded, input);
  assert.equal(forwarded.apiKey, 'key');
  assert.equal(forwarded.apiServerUrl, 'https://server.codeium.com');
  const rewritten = Buffer.from(forwarded.userStatusProtoBinaryBase64, 'base64');
  assert.ok(rewritten.includes(Buffer.from('dfbyok-own-x')), 'the emitted uid lands in the stored payload');
  assert.ok(rewritten.includes(ownRaw), 'the emitted raw entry is preserved verbatim');
  assert.equal(f.calls[0].args[1], extra);
  assert.equal(f.augmentCalls.length, 1);
  assert.equal(f.augmentCalls[0].options.rpc, '/exa.language_server_pb.LanguageServerService/GetUserStatus');
  assert.equal(f.augmentCalls[0].options.retireOwn, true, 'the desktop store retires stale own entries');
  assert.deepEqual(rewritten.equals(f.payload), false);
  const log = f.logs[0];
  assert.equal(log.event, 'auth-status');
  assert.equal(log.fields.before, f.payload.length);
  assert.equal(log.fields.after, rewritten.length);
  assert.equal(log.fields.beforeOwn, 0);
  assert.equal(log.fields.afterOwn, 1);
  assert.equal(handle.status.calls, 1);
  assert.equal(handle.status.rewrites, 1);
  // The caller's object is never mutated.
  assert.equal(Buffer.from(input.userStatusProtoBinaryBase64, 'base64').equals(f.payload), true);
});

test('passes null, missing and unchanged payloads through untouched', () => {
  const f = fixture({ augmentResult: data => data }), handle = f.install();
  f.api.setAuthStatus(null);
  assert.equal(f.calls[0].args[0], null);
  f.api.setAuthStatus({ apiKey: 'key' });
  assert.deepEqual(f.calls[1].args[0], { apiKey: 'key' });
  const same = f.status();
  f.api.setAuthStatus(same);
  assert.equal(f.calls[2].args[0], same);
  assert.equal(handle.status.rewrites, 0);
  assert.equal(f.logs.filter(log => log.event === 'auth-status').length, 0,
    'unchanged payloads never produce a rewrite log');
});

test('a throwing augmenter degrades to pass-through instead of breaking auth', () => {
  const f = fixture({ augmentResult: () => { throw new Error('catalog unavailable'); } });
  const handle = f.install(), input = f.status();
  const result = f.api.setAuthStatus(input);
  assert.equal(result, 'native-result');
  assert.equal(f.calls[0].args[0], input);
  assert.equal(handle.status.rewrites, 0);
});

test('dispose restores the native method and detaches the handle', () => {
  const f = fixture();
  const original = f.api.setAuthStatus;
  const handle = f.install();
  assert.equal(f.install(), handle);
  handle.dispose();
  assert.equal(f.api.setAuthStatus, original);
  const input = f.status();
  f.api.setAuthStatus(input);
  assert.equal(f.calls.at(-1).args[0], input);
  handle.dispose();
});

test('every call reports attempt before the native method and applied after it settles', async () => {
  const f = fixture();
  const deferred = {};
  let release;
  f.api.setAuthStatus = function (...args) { f.calls.push({ thisArg: this, args });
    if (deferred.once) return new Promise(resolve => { release = () => resolve(deferred.once()); });
    return 'native-result'; };
  const handle = f.install();
  const input = f.status();
  f.api.setAuthStatus(input);
  assert.deepEqual(f.publications.map(e => e.phase), ['attempt', 'applied'], 'sync return confirms synchronously');
  assert.equal(f.publications[0].callId, 1);
  assert.equal(typeof f.publications[0].signature, 'string');
  deferred.once = () => 'ok';
  const pending = f.api.setAuthStatus(input);
  assert.equal(f.publications.at(-1).phase, 'attempt');
  assert.equal(f.publications.at(-1).callId, 2);
  release();
  await pending;
  assert.equal(f.publications.at(-1).phase, 'applied');
  assert.equal(f.publications.at(-1).callId, 2);
  // Events carry only a callId, the emit signature and a nativeApplied flag —
  // never a payload, auth object or error detail.
  for (const event of f.publications) {
    const expected = event.phase === 'attempt' ? ['callId', 'phase', 'signature']
      : ['callId', 'nativeApplied', 'phase', 'signature'];
    assert.deepEqual(Object.keys(event).sort(), expected.sort());
    if (event.phase !== 'attempt') assert.equal(typeof event.nativeApplied, 'boolean');
  }
  handle.dispose();
});

test('rejection and sync throw report failed without changing the original semantics', async () => {
  const f = fixture();
  const boom = new Error('native boom');
  let mode = 'reject';
  f.api.setAuthStatus = (...args) => { f.calls.push({ thisArg: f.api, args });
    if (mode === 'reject') return Promise.reject(boom);
    throw boom; };
  f.install();
  const input = f.status();
  const rejected = f.api.setAuthStatus(input);
  await assert.rejects(rejected, boom);
  assert.equal(f.publications.at(-1).phase, 'failed');
  assert.equal(f.publications.at(-1).code, 'native-call-failed');
  mode = 'throw';
  assert.throws(() => f.api.setAuthStatus(input), boom);
  assert.equal(f.publications.at(-1).phase, 'failed');
  assert.equal(f.publications.at(-1).code, 'native-call-failed');
  await Promise.resolve(); // flush the observed rejection handlers
});

test('a null or payload-less write reports cleared and retires confirmation', () => {
  const f = fixture();
  f.install();
  f.api.setAuthStatus(null);
  // Events come from the vm realm, so compare fields rather than deepEqual.
  assert.equal(f.publications.length, 2);
  assert.deepEqual(f.publications.map(e => [e.phase, e.callId, e.signature]),
    [['cleared', 1, null], ['applied', 1, null]],
    'a logout clears earlier confirmation, then the native call still settles');
  f.api.setAuthStatus({ apiKey: 'key' });
  assert.equal(f.publications.at(-2).phase, 'cleared');
  assert.equal(f.publications.at(-1).phase, 'applied');
  assert.equal(f.calls.length, 2, 'the native method still runs on logout');
  assert.equal(f.augmentCalls.length, 0, 'nothing is collected or rewritten on logout');
});

test('observed upstream entries feed back before the emit snapshot; own combos are filtered', () => {
  const f = fixture({
    catalog: { models: [], matrixUids: new Set(['fusion-swe-a-sidekick-swe-b']) },
    collectResult: () => [
      { uid: 'swe-new' }, { uid: 'dfbyok-own' }, { uid: 'fusion-swe-a-sidekick-swe-b' }, { uid: 'fusion-dfbyok-emitted' }],
  });
  const sigs = [];
  let catalogUsed;
  const originalGet = f.install;
  f.install({ onNativeModels: entries => f.natives.push(entries),
    getCatalog: () => { const c = { models: [], matrixUids: new Set(['fusion-swe-a-sidekick-swe-b']) };
      catalogUsed = c; return c; },
    onPublication: event => f.publications.push(event) });
  assert.equal(f.calls.length, 0);
  f.api.setAuthStatus(f.status());
  assert.deepEqual(f.natives.flat().map(e => e.uid), ['swe-new'],
    'upstream uids pass; own uids and emitted matrix combinations are filtered');
});

test('a disabled generation passes calls through unaugmented and unsigned', () => {
  const f = fixture({ enabled: false });
  f.install();
  f.api.setAuthStatus(f.status());
  assert.equal(f.augmentCalls.length, 0, 'isEnabled false means passthrough');
  assert.equal(f.publications[0].signature, null);
  assert.equal(f.publications[0].phase, 'attempt');
  assert.equal(f.publications[1].phase, 'applied');
});

test('deactivate switches to passthrough; drain waits for tracked calls; restore verdict follows the passthrough payload', async () => {
  const f = fixture();
  let release;
  f.api.setAuthStatus = function (...args) { f.calls.push({ thisArg: this, args });
    return new Promise(resolve => { release = () => resolve('ok'); }); };
  const handle = f.install();
  const pending = f.api.setAuthStatus(f.status());
  handle.deactivate();
  assert.equal(handle.status.state, 'passthrough');
  let drained;
  const wait = handle.drain({ timeoutMs: 5000 }).then(v => { drained = v; });
  release(); await pending; await wait;
  assert.equal(drained, true);
  const residualInput = { userStatusProtoBinaryBase64: statusPayload('dfbyok-residual').toString('base64') };
  const verdict = handle.restore({ command: () => { f.api.setAuthStatus(residualInput); return Promise.resolve(); } });
  release(); await verdict.then(v => assert.equal(v.code, 'restore-unverified'));
  const clean = { userStatusProtoBinaryBase64: statusPayload('native-9').toString('base64') };
  const verdict2 = handle.restore({ command: () => { f.api.setAuthStatus(clean); return Promise.resolve(); } });
  release(); await verdict2.then(v => { assert.equal(v.ok, true); assert.equal(v.code, 'restored'); });
  // Structural failures can never be claimed either.
  for (const bad of [Buffer.from('not-proto-at-all'), statusPayload('dfbyok-still-here')]) {
    const outcome = handle.restore({ command: () => { f.api.setAuthStatus({ userStatusProtoBinaryBase64: bad.toString('base64') }); return Promise.resolve(); } });
    release(); await outcome.then(v => assert.equal(v.ok, false));
  }
  handle.dispose();
});

test('an unverifiable or shapeless payload never signs an applied event', () => {
  // v(1,1) alone is legal protobuf but carries no f33 model list: the
  // augmentation cannot prove the emit landed, so the call settles 'failed'
  // with a stable code instead of 'applied' — the native method still ran.
  const f = fixture({ payload: v(1, 1) });
  f.install();
  f.api.setAuthStatus(f.status());
  assert.equal(f.calls.length, 1, 'the native method still executes');
  assert.deepEqual(f.publications.map(e => [e.phase, e.code]),
    [['attempt', undefined], ['failed', 'shape-unrecognized']]);
  assert.equal(f.publications[1].signature, null, 'an unverified emit is never signed');
  const diagnostic = f.logs.find(entry => entry.event === 'auth-status-publication').fields;
  assert.equal(diagnostic.phase, 'failed', 'the log reports the same unverified verdict as the publisher');
  assert.equal(diagnostic.signature, null);
  assert.equal(diagnostic.nativeApplied, true, 'native acknowledgement alone is not emit verification');
});

test('a skipping or throwing transform settles as failed, never applied', () => {
  for (const [name, augmentResult, code] of [
    ['skip', (data, options) => { options.onSkip?.('shape-unrecognized'); return data; }, 'shape-unrecognized'],
    ['throw', () => { throw new Error('catalog unavailable'); }, 'transform-failed'],
  ]) {
    const f = fixture({ augmentResult });
    f.install();
    f.api.setAuthStatus(f.status());
    assert.deepEqual(f.publications.map(e => [e.phase, e.code]),
      [['attempt', undefined], ['failed', code]], name);
    assert.equal(f.calls.length, 1, name + ': native call preserved');
  }
});

test('an idempotent verified payload still confirms with the signature', () => {
  // A payload that already contains the emit is verified as legitimate:
  // unchanged bytes are not a failure when the emit is provably inside them.
  const ownRaw = cat(s(1, 'own'), s(22, 'dfbyok-own-x'));
  const f = fixture({
    catalog: { models: [{ uid: 'dfbyok-own-x', label: 'own', raw: ownRaw }] },
  });
  f.install();
  const emitted = f.calls;
  f.api.setAuthStatus(f.status());
  const rewritten = f.calls[0].args[0];
  assert.notEqual(rewritten, f.status(), 'the first call is augmented');
  // Replay the emitted bytes: the rewrite is idempotent, so the second call
  // forwards them untouched yet still confirms — verification, not equality,
  // is what earned the applied event.
  f.api.setAuthStatus(rewritten);
  assert.equal(f.calls[1].args[0], rewritten, 'unchanged verified bytes pass through untouched');
  assert.deepEqual(f.publications.map(e => e.phase), ['attempt', 'applied', 'attempt', 'applied']);
  assert.equal(typeof f.publications[3].signature, 'string');
  assert.equal(f.publications[3].signature, f.publications[1].signature);
});

test('an emit missing a target entry or keeping a hidden uid never confirms', () => {
  const missing = cat(s(1, 'other'), s(22, 'dfbyok-other'));
  const f = fixture({
    catalog: { models: [{ uid: 'dfbyok-own-x', label: 'own', raw: cat(s(1, 'own'), s(22, 'dfbyok-own-x')) }] },
    augmentResult: () => statusPayload('dfbyok-other'),
  });
  f.install();
  f.api.setAuthStatus(f.status());
  assert.equal(f.publications.at(-1).phase, 'failed');
  assert.equal(f.publications.at(-1).code, 'emit-unverified');

  const hidden = fixture({
    catalog: { models: [], hiddenNativeModelUids: ['native-hidden'] },
    augmentResult: () => statusPayload('native-hidden'),
  });
  hidden.install();
  hidden.api.setAuthStatus(hidden.status());
  assert.equal(hidden.publications.at(-1).phase, 'failed');
  assert.equal(hidden.publications.at(-1).code, 'emit-unverified');
});

test('restore verdicts: null, malformed, residual, rejected and timed-out probes are all unverified', async () => {
  const f = fixture();
  // The native original itself chooses the outcome, so every probe travels
  // through the real wrapper.
  let behavior = 'resolve';
  f.api.setAuthStatus = function (...args) { f.calls.push({ thisArg: this, args });
    if (behavior === 'reject') return Promise.reject(new Error('native fail'));
    if (behavior === 'resolve') return Promise.resolve('native-result');
    return 'native-result'; };
  const handle = f.install();
  handle.deactivate();
  // Payload-less call: unverified.
  let verdict = await handle.restore({ command: () => { f.api.setAuthStatus(null); return Promise.resolve(); } });
  assert.equal(verdict.ok, false);
  // Malformed bytes: unverified.
  verdict = await handle.restore({ command: () => {
    f.api.setAuthStatus({ userStatusProtoBinaryBase64: Buffer.from('junk').toString('base64') });
    return Promise.resolve();
  } });
  assert.equal(verdict.ok, false);
  // Rejected native call: the wrapper sees the native failure and the probe
  // resolves unverified without waiting for the timeout.
  behavior = 'reject';
  verdict = await handle.restore({ command: () => {
    f.api.setAuthStatus({ userStatusProtoBinaryBase64: statusPayload('native-1').toString('base64') }).catch(() => {});
    return Promise.resolve();
  }, timeoutMs: 5000 });
  assert.equal(verdict.ok, false);
  // No call at all within the bound: timeout.
  verdict = await handle.restore({ command: () => Promise.resolve(), timeoutMs: 20 });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal((await verdict).code, 'restore-timeout');
  handle.dispose();
});

test('a passthrough payload containing an emitted matrix uid still counts as residual', async () => {
  // Emit once so the handle records the matrix uid, then deactivate: a
  // passthrough payload still carrying that f32-less fusion entry is residual.
  // A fusion combination whose components carry no dfbyok marker at all is
  // still ours while it lacks the official f32 capability record.
  const uid = 'fusion-native-lead-a-sidekick-native-b';
  const matrixRaw = cat(s(1, 'combo'), s(22, uid));
  const f = fixture({
    catalog: { models: [{ uid, label: 'combo', raw: matrixRaw }], matrixUids: new Set([uid]) },
  });
  f.api.setAuthStatus = (...args) => { f.calls.push({ thisArg: f.api, args }); return 'native-result'; };
  const handle = f.install();
  f.api.setAuthStatus(f.status());
  handle.deactivate();
  const residual = { userStatusProtoBinaryBase64: statusPayload(uid).toString('base64') };
  const verdict = await handle.restore({ command: () => { f.api.setAuthStatus(residual); return Promise.resolve(); } });
  assert.equal(verdict.ok, false, 'a stored emitted fusion uid is still ours');
  // The same uid arriving WITH the official f32 record is a native entry —
  // history of emitting it must not condemn it.
  const official = { userStatusProtoBinaryBase64:
    cat(v(1, 1), m(33, m(1, cat(s(1, 'combo'), s(22, uid), s(32, 'x'))))).toString('base64') };
  const verdict2 = await handle.restore({ command: () => { f.api.setAuthStatus(official); return Promise.resolve(); } });
  assert.equal(verdict2.ok, true, 'an f32-bearing entry is native, never residual');
  handle.dispose();
});

test('drain reports false when dispose interrupts the wait', async () => {
  const f = fixture();
  let release;
  f.api.setAuthStatus = function (...args) { f.calls.push({ thisArg: this, args });
    return new Promise(resolve => { release = resolve; }); };
  const handle = f.install();
  f.api.setAuthStatus(f.status());
  const drained = handle.drain({ timeoutMs: 10000 });
  handle.dispose();
  assert.equal(await drained, false, 'dispose wakes the wait but never claims a drain');
  release();
});

test('validator edge cases: malformed status shapes are refused on the real helper', () => {
  const R = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
  const bad = [
    cat(v(1, 1), v(1, 0), m(33, Buffer.alloc(0))),        // duplicated varint f1
    cat(s(1, 'x'), v(1, 1), m(33, modelEntry('a'))),      // wrong-wire + mixed f1
    cat(v(1, 1), m(1, m(33, modelEntry('a')))),         // valid envelope mixed with bare pro
    m(1, cat(v(1, 1), v(1, 0), m(33, modelEntry('a')))),  // duplicated inner f1
    Buffer.alloc(0), v(1, 1),                            // no f33 container at all
    cat(m(1, cat(v(1, 1), m(33, Buffer.alloc(0)))), m(33, Buffer.alloc(0))), // envelope + bare f33
  ];
  for (const data of bad) assert.equal(realCatalog.validateProtoCatalog(data, { rpc: R, allowEmpty: true }).ok, false);
  assert.equal(realCatalog.validateProtoCatalog(cat(v(1, 1), m(33, Buffer.alloc(0))), { rpc: R, allowEmpty: true }).ok, true,
    'a clean empty f33 container is legal');
  // info single-value repeats, duplicate uids refuse; unknown fields survive.
  const dup = uid => cat([modelEntry(uid), modelEntry(uid)]);
  assert.equal(realCatalog.validateProtoCatalog(cat(dup('a')), { rpc: '/exa.language_server_pb.LanguageServerService/GetCliModelConfigs' }).ok, false);
  const info = m(23, cat(v(4, 100), v(4, 200)));
  assert.equal(realCatalog.validateProtoCatalog(cat(m(1, cat(s(1, 'a'), s(22, 'a'), info))),
    { rpc: '/exa.language_server_pb.LanguageServerService/GetCliModelConfigs' }).ok, false);
  const unknown = m(1, cat(s(1, 'a'), s(22, 'a'), s(41, 'weird')));
  assert.equal(realCatalog.validateProtoCatalog(cat(unknown), { rpc: '/exa.language_server_pb.LanguageServerService/GetCliModelConfigs' }).ok, true);
});

test('isOwnUid honours real own prefixes and never a mid-string marker', () => {
  const { isOwnUid } = realCatalog;
  assert.equal(isOwnUid('native-lookalike-dfbyok-text'), false);
  assert.equal(isOwnUid('dfbyok-a'), true);
  assert.equal(isOwnUid('fusion-native-a-sidekick-dfbyok-b'), true);
  assert.equal(isOwnUid('fusion-native-a-sidekick-native-b'), false);
  assert.equal(isOwnUid('fusion-dfbyok-a-sidekick-native-b'), true);
});

test('a native write that fulfilled but could not be verified revokes ready through a real publisher', async () => {
  const { createCatalogPublication } = require('../src/activation/catalog-publication.cjs');
  const { catalogSignature } = require('../src/catalog/signature.cjs');
  let clock = 0;
  const timers = [], commands = [];
  const clockApi = {
    now: () => clock,
    set: (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t; },
    clear: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  };
  const advance = ms => { clock += ms;
    for (;;) { timers.sort((a, b) => a.at - b.at); const t = timers[0];
      if (!t || t.at > clock) break; timers.shift(); t.fn(); } };
  const micro = () => Promise.resolve();
  const ownRaw = cat(s(1, 'own'), s(22, 'dfbyok-own-x'));
  const catalog = { models: [{ uid: 'dfbyok-own-x', label: 'own', raw: ownRaw }] };
  const pub = createCatalogPublication({ getCatalog: () => catalog,
    refreshUserStatus: () => { commands.push(1); return Promise.resolve(); },
    clock: clockApi, log: () => {} });
  const f = fixture({ catalog });
  f.install({ onPublication: event => pub.observe(event) });
  pub.changed();
  advance(1500); await micro();
  assert.equal(commands.length, 1);
  // The real wrapper emits attempt+applied for a verified emit: ready.
  f.api.setAuthStatus(f.status());
  await micro();

  // A payload the emit cannot verify lands anyway: failed+nativeApplied —
  // the coordinator must stop claiming the store holds our emit and repair.
  f.api.setAuthStatus({ userStatusProtoBinaryBase64: v(1, 1).toString('base64') });
  await micro();
  assert.equal(pub.status().state, 'pending');
  assert.equal(pub.status().code, 'stale-commit');
  assert.equal(commands.length, 2, 'the current target is repaired inside the budget');
});

test('a native promise settling after dispose never emits another publication event', async () => {
  const f = fixture();
  let release;
  f.api.setAuthStatus = function (...args) { f.calls.push({ thisArg: this, args });
    return new Promise(resolve => { release = resolve; }); };
  const handle = f.install();
  f.api.setAuthStatus(f.status());
  assert.equal(f.publications.length, 1, 'attempt emitted');
  handle.dispose();
  release(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.publications.length, 1, 'a post-dispose settle is inert');
});

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
  const paths = [], logs = [], calls = [], natives = [];
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
  vm.runInNewContext(source, { Buffer, module, exports: module.exports, require(name) {
    if (name === 'node:module') return { createRequire };
    if (name === '../../catalog.cjs') return { augmentCatalog, collectNativeModels, catalogSignature, validateProtoCatalog: realCatalog.validateProtoCatalog, isOwnUid: realCatalog.isOwnUid };
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
    onNativeModels: entries => natives.push(entries), ...options });
  const status = extra => ({
    apiKey: 'key', apiServerUrl: 'https://server.codeium.com',
    userStatusProtoBinaryBase64: payload.toString('base64'), ...extra });
  return { api, paths, logs, calls, natives, augmentCalls, install, status, payload };
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

test('observed upstream entries feed back before the emit snapshot; own combos are filtered', () => {
  const f = fixture({
    catalog: { models: [], matrixUids: new Set(['fusion-swe-a-sidekick-swe-b']) },
    collectResult: () => [
      { uid: 'swe-new' }, { uid: 'dfbyok-own' }, { uid: 'fusion-swe-a-sidekick-swe-b' }, { uid: 'fusion-dfbyok-emitted' }],
  });
  let catalogUsed;
  f.install({ onNativeModels: entries => f.natives.push(entries),
    getCatalog: () => { const c = { models: [], matrixUids: new Set(['fusion-swe-a-sidekick-swe-b']) };
      catalogUsed = c; return c; } });
  assert.equal(f.calls.length, 0);
  f.api.setAuthStatus(f.status());
  assert.deepEqual(f.natives.flat().map(e => e.uid), ['swe-new'],
    'upstream uids pass; own uids and emitted matrix combinations are filtered');
});

test('a disabled generation passes calls through unaugmented', () => {
  const f = fixture({ enabled: false });
  f.install();
  const input = f.status();
  const result = f.api.setAuthStatus(input);
  assert.equal(result, 'native-result');
  assert.equal(f.augmentCalls.length, 0, 'isEnabled false means passthrough');
  assert.equal(f.calls[0].args[0], input, 'the call is forwarded untouched');
});

test('deactivate switches the wrapper to passthrough until dispose', () => {
  const f = fixture();
  const original = f.api.setAuthStatus;
  const handle = f.install();
  handle.deactivate();
  assert.equal(handle.status.state, 'passthrough');
  const input = f.status();
  const result = f.api.setAuthStatus(input);
  assert.equal(result, 'native-result', 'the original return value is preserved');
  assert.equal(f.calls.at(-1).args[0], input, 'a deactivated wrapper forwards the call untouched');
  assert.equal(f.augmentCalls.length, 0, 'no rewrite runs while deactivated');
  handle.dispose();
  assert.equal(f.api.setAuthStatus, original);
});

test('a payload the augmentation cannot verify passes through unrewritten', () => {
  // v(1,1) alone is legal protobuf but carries no f33 model list: the
  // augmentation cannot produce verifiable bytes, so the call is forwarded
  // untouched instead of rewritten — the native method still ran.
  const f = fixture({ payload: v(1, 1) });
  f.install();
  const input = f.status();
  const result = f.api.setAuthStatus(input);
  assert.equal(result, 'native-result');
  assert.equal(f.calls.length, 1, 'the native method still executes');
  assert.equal(f.calls[0].args[0], input, 'an unverifiable emit is never rewritten');
});

test('a skipping or throwing transform falls back to the untouched call', () => {
  for (const [name, augmentResult] of [
    ['skip', (data, options) => { options.onSkip?.('shape-unrecognized'); return data; }],
    ['throw', () => { throw new Error('catalog unavailable'); }],
  ]) {
    const f = fixture({ augmentResult });
    f.install();
    const input = f.status();
    const result = f.api.setAuthStatus(input);
    assert.equal(result, 'native-result', name + ': the original return value is preserved');
    assert.equal(f.calls.length, 1, name + ': native call preserved');
    assert.equal(f.calls[0].args[0], input, name + ': forwarded untouched, not rewritten');
  }
});

test('an idempotent verified payload passes through unrewritten', () => {
  // A payload that already contains the emit is verified as legitimate:
  // unchanged bytes are not a failure when the emit is provably inside them.
  const ownRaw = cat(s(1, 'own'), s(22, 'dfbyok-own-x'));
  const f = fixture({
    catalog: { models: [{ uid: 'dfbyok-own-x', label: 'own', raw: ownRaw }] },
  });
  const handle = f.install();
  f.api.setAuthStatus(f.status());
  const rewritten = f.calls[0].args[0];
  assert.notEqual(rewritten, f.status(), 'the first call is augmented');
  assert.equal(handle.status.rewrites, 1);
  // Replay the emitted bytes: the rewrite is idempotent, so the second call
  // forwards them untouched.
  f.api.setAuthStatus(rewritten);
  assert.equal(f.calls[1].args[0], rewritten, 'unchanged verified bytes pass through untouched');
  assert.equal(handle.status.rewrites, 1, 'an idempotent payload is not rewritten twice');
});

test('an emit missing a target entry or keeping a hidden uid is never rewritten', () => {
  const f = fixture({
    catalog: { models: [{ uid: 'dfbyok-own-x', label: 'own', raw: cat(s(1, 'own'), s(22, 'dfbyok-own-x')) }] },
    augmentResult: () => statusPayload('dfbyok-other'),
  });
  f.install();
  const input = f.status();
  f.api.setAuthStatus(input);
  assert.equal(f.calls[0].args[0], input, 'a payload missing a target entry is forwarded untouched');

  const hidden = fixture({
    catalog: { models: [], hiddenNativeModelUids: ['native-hidden'] },
    augmentResult: () => statusPayload('native-hidden'),
  });
  hidden.install();
  const hiddenInput = hidden.status();
  hidden.api.setAuthStatus(hiddenInput);
  assert.equal(hidden.calls[0].args[0], hiddenInput, 'a payload keeping a hidden uid is forwarded untouched');
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

test('a promise returned by the native method keeps its identity through the wrapper', async () => {
  const f = fixture();
  const pending = Promise.resolve('late-result');
  f.api.setAuthStatus = function (...args) { f.calls.push({ thisArg: this, args }); return pending; };
  f.install();
  const returned = f.api.setAuthStatus(f.status());
  assert.equal(returned, pending, 'the original promise identity is preserved');
  assert.equal(await returned, 'late-result');
});

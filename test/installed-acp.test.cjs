'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTurnCompletingPromptResponse } = require('./helpers/installed-acp.cjs');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-acp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function writeBundle(root, source) {
  const bundle = path.join(root, 'extensions', 'windsurf', 'dist', 'extension.js');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.writeFileSync(bundle, source);
  return bundle;
}
const SHAPE = (dep, target) => `function ${dep}(e,t){return"session/prompt"===e.method&&null!=t}function ${target}(e,t){return ${dep}(e,t)&&"stopReason"in t}const x={isTurnCompletingPromptResponse:()=>${target}};`;
const request = { method: 'session/prompt' };

test('a missing application root returns null for the caller to skip', t => {
  const root = path.join(tempRoot(t), 'absent');
  assert.equal(loadTurnCompletingPromptResponse(root), null);
});

test('an existing root without the bundle fails loudly', t => {
  const root = tempRoot(t);
  assert.throws(() => loadTurnCompletingPromptResponse(root), /layout changed.*extension\.js/);
});

test('a root that is a file fails loudly', t => {
  const root = tempRoot(t);
  const file = path.join(root, 'not-a-dir');
  fs.writeFileSync(file, 'x');
  assert.throws(() => loadTurnCompletingPromptResponse(file), /layout changed.*not a directory/);
});

test('a missing or duplicated export binding fails loudly', t => {
  const absent = tempRoot(t);
  writeBundle(absent, 'function A(e,t){return 1}');
  assert.throws(() => loadTurnCompletingPromptResponse(absent), /layout changed.*export binding.*found 0/);
  const dup = tempRoot(t);
  writeBundle(dup, SHAPE('N5', 'P5') + 'const y={isTurnCompletingPromptResponse:()=>P5};');
  assert.throws(() => loadTurnCompletingPromptResponse(dup), /layout changed.*export binding.*found 2/);
});

test('a missing or duplicated target declaration fails loudly', t => {
  const absent = tempRoot(t);
  writeBundle(absent, 'const x={isTurnCompletingPromptResponse:()=>P5};function N5(e,t){return 1}');
  assert.throws(() => loadTurnCompletingPromptResponse(absent), /layout changed.*target predicate declaration.*found 0/);
  const dup = tempRoot(t);
  writeBundle(dup, SHAPE('N5', 'P5') + 'function P5(e,t){return N5(e,t)}');
  assert.throws(() => loadTurnCompletingPromptResponse(dup), /layout changed.*target predicate declaration.*found 2/);
});

test('a missing or duplicated dependency declaration fails loudly', t => {
  const absent = tempRoot(t);
  writeBundle(absent, 'function P5(e,t){return N5(e,t)&&"stopReason"in t}const x={isTurnCompletingPromptResponse:()=>P5};');
  assert.throws(() => loadTurnCompletingPromptResponse(absent), /layout changed.*dependency predicate declaration.*found 0/);
  const dup = tempRoot(t);
  writeBundle(dup, SHAPE('N5', 'P5') + 'function N5(e,t){return 0}');
  assert.throws(() => loadTurnCompletingPromptResponse(dup), /layout changed.*dependency predicate declaration.*found 2/);
});

test('equivalent two-function source under different minified names loads and behaves', t => {
  const root = tempRoot(t);
  writeBundle(root, SHAPE('$x9', 'zQ_2'));
  const predicate = loadTurnCompletingPromptResponse(root);
  assert.equal(predicate(request, {}), false);
  assert.equal(predicate(request, null), false);
  assert.equal(predicate(request, undefined), false);
  assert.equal(predicate(request, { stopReason: 'end_turn' }), true);
  assert.equal(predicate(request, { stopReason: 'max_turn_requests' }), true);
  assert.equal(predicate({ method: 'session/new' }, { stopReason: 'end_turn' }), false);
});

test('a bundle whose top level throws still loads, proving bootstrap never runs', t => {
  const root = tempRoot(t);
  writeBundle(root, 'throw new Error("bundle bootstrap must not run");\n' + SHAPE('N5', 'P5'));
  const predicate = loadTurnCompletingPromptResponse(root);
  assert.equal(predicate(request, { stopReason: 'end_turn' }), true);
});

test('an unreadable or unsupported target body fails loudly', t => {
  const root = tempRoot(t);
  const bundle = writeBundle(root, SHAPE('N5', 'P5'));
  fs.rmSync(bundle);
  fs.mkdirSync(bundle);
  assert.throws(() => loadTurnCompletingPromptResponse(root), /layout changed.*extension\.js/);
  const nested = tempRoot(t);
  writeBundle(nested, 'function N5(e,t){return null!=t}function P5(e,t){if(e){return{}}}const x={isTurnCompletingPromptResponse:()=>P5};');
  assert.throws(() => loadTurnCompletingPromptResponse(nested), /layout changed.*body shape/);
});

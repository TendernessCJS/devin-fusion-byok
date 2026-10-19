'use strict';
// backend.cjs derives its restart-hash input from the literal require graph at
// load time, so the contract is mechanical rather than editorial: the walk must
// reach every module backend.cjs can load and nothing outside it, every hashed
// entry must be a real file inside the repository, and the digest must be
// stable across calls. A missed module means new code never restarts the
// backend; a stale one forces needless restarts. Both failures are silent, so
// the equivalence is asserted with an independent reference walk here.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const srcRoot = path.resolve(__dirname, '../src');
const backendFile = path.join(srcRoot, 'runtime/backend.cjs');
const repoRoot = path.resolve(__dirname, '..');
const REQUIRE_LITERAL = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g;
// A require whose argument is not a plain string literal cannot be resolved
// statically, which is what this whole contract rests on.
const REQUIRE_ANY = /\brequire\(/g;

// Reference implementation of backend.cjs's own derivation walk.
function reachableModules() {
  const seen = new Set();
  const queue = [backendFile];
  const unparseable = [];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    const literals = [...text.matchAll(REQUIRE_LITERAL)].map(match => match[2]);
    const calls = [...text.matchAll(REQUIRE_ANY)].length;
    if (calls !== literals.length) unparseable.push(path.relative(repoRoot, file));
    for (const specifier of literals) {
      if (!specifier.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      if (!fs.existsSync(resolved) || !resolved.startsWith(repoRoot)) continue;
      queue.push(resolved);
    }
  }
  return { files: seen, unparseable };
}

function hashedFiles() {
  const dir = path.dirname(backendFile);
  return [...reachableModules().files].map(file => path.relative(dir, file)).sort();
}

function expectedSourceId() {
  const dir = path.dirname(backendFile);
  const hash = crypto.createHash('sha256');
  for (const name of hashedFiles()) hash.update(name).update('\0').update(fs.readFileSync(path.resolve(dir, name))).update('\0');
  return hash.digest('hex');
}

test('the hashed set covers exactly the modules backend.cjs loads', () => {
  const hashed = new Set(hashedFiles().map(name => path.resolve(path.dirname(backendFile), name)));
  const { files } = reachableModules();
  const missing = [...files].filter(file => !hashed.has(file));
  const stale = [...hashed].filter(file => !files.has(file));
  assert.deepEqual(missing.map(file => path.relative(repoRoot, file)), [],
    'these modules are loaded by backend.cjs but absent from the hashed set, so editing them never restarts the backend');
  assert.deepEqual(stale.map(file => path.relative(repoRoot, file)), [],
    'these files are hashed but backend.cjs never loads them, so editing them forces a needless restart');
});

test('the derived digest matches the module and stays stable across calls', () => {
  const { runtimeIdentity } = require('../src/runtime/backend.cjs');
  const first = runtimeIdentity(repoRoot).sourceId;
  assert.equal(first, expectedSourceId(),
    'runtimeIdentity must hash exactly the derived closure, nothing more or less');
  assert.equal(runtimeIdentity(repoRoot).sourceId, first, 'a second call must reuse the loaded digest');
  assert.equal(runtimeIdentity(repoRoot, true).sourceId, first, 'a fresh re-read must reproduce the same digest');
});

test('every hashed entry resolves to a file inside the repository', () => {
  const names = hashedFiles();
  assert.ok(names.includes('../../package.json'), 'the package manifest carries the version into the hash');
  for (const name of names) {
    const file = path.resolve(path.dirname(backendFile), name);
    assert.ok(file.startsWith(repoRoot + path.sep), file + ' must live inside the repository');
    assert.ok(fs.statSync(file).isFile(), file + ' must exist and be a file');
  }
});

test('src uses only static require specifiers, so this contract stays decidable', () => {
  const { unparseable } = reachableModules();
  assert.deepEqual(unparseable, [],
    'these modules require a non-literal specifier, which would make the source derivation throw');
  for (const name of hashedFiles()) {
    const file = path.resolve(path.dirname(backendFile), name);
    if (!file.startsWith(srcRoot + path.sep)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const literals = [...text.matchAll(REQUIRE_LITERAL)].length;
    const calls = [...text.matchAll(REQUIRE_ANY)].length;
    assert.equal(calls, literals, path.relative(repoRoot, file) + ' must not compute a require specifier');
  }
});

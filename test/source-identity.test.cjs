'use strict';
// SOURCE_FILES is a manual list, but its required content is not a matter of
// opinion: it must describe exactly the modules backend.cjs loads, because it is
// what sourceId() hashes to decide whether a same-version install needs a
// backend restart. A missing entry means new code never runs; a stale entry
// means an unrelated edit forces a needless restart. Both failures are silent,
// so the contract is asserted mechanically in both directions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const srcRoot = path.resolve(__dirname, '../src');
const backendFile = path.join(srcRoot, 'runtime/backend.cjs');
const repoRoot = path.resolve(__dirname, '..');
const REQUIRE_LITERAL = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g;
// A require whose argument is not a plain string literal cannot be resolved
// statically, which is what this whole contract rests on.
const REQUIRE_ANY = /\brequire\(/g;

function hashedFiles() {
  const text = fs.readFileSync(backendFile, 'utf8');
  const literal = text.match(/const SOURCE_FILES = (\[[\s\S]*?\]);/);
  assert.ok(literal, 'backend.cjs must declare SOURCE_FILES as a single array literal');
  const names = vm.runInNewContext('(' + literal[1] + ')');
  assert.ok(Array.isArray(names) && names.length > 0, 'SOURCE_FILES must be a non-empty array');
  for (const name of names) assert.equal(typeof name, 'string');
  assert.equal(new Set(names).size, names.length, 'SOURCE_FILES must not repeat a file');
  return new Set(names.map(name => path.resolve(path.dirname(backendFile), name)));
}

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

test('SOURCE_FILES lists exactly the modules backend.cjs loads', () => {
  const hashed = hashedFiles();
  const { files } = reachableModules();
  const missing = [...files].filter(file => !hashed.has(file));
  const stale = [...hashed].filter(file => !files.has(file));
  assert.deepEqual(missing.map(file => path.relative(repoRoot, file)), [],
    'these modules are loaded by backend.cjs but absent from SOURCE_FILES, so editing them never restarts the backend');
  assert.deepEqual(stale.map(file => path.relative(repoRoot, file)), [],
    'these files are hashed by SOURCE_FILES but backend.cjs never loads them, so editing them forces a needless restart');

});

test('every SOURCE_FILES entry resolves to a file inside the repository', () => {
  for (const file of hashedFiles()) {
    assert.ok(file.startsWith(repoRoot + path.sep), file + ' must live inside the repository');
    assert.ok(fs.statSync(file).isFile(), file + ' must exist and be a file');
  }
});

test('src uses only static require specifiers, so this contract stays decidable', () => {
  const { unparseable } = reachableModules();
  assert.deepEqual(unparseable, [],
    'these modules require a non-literal specifier, which hides dependencies from the SOURCE_FILES contract');
  for (const file of hashedFiles()) {
    if (!file.startsWith(srcRoot + path.sep)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const literals = [...text.matchAll(REQUIRE_LITERAL)].length;
    const calls = [...text.matchAll(REQUIRE_ANY)].length;
    assert.equal(calls, literals, path.relative(repoRoot, file) + ' must not compute a require specifier');
  }
});

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { rootIdentity } = require('./contract.cjs');
// The restart hash must cover exactly the modules this process loads, so the
// list is derived once at load time from the literal require graph instead of
// being maintained by hand — a hand-edited list can silently leave a new module
// out (same-version installs then never restart the backend onto it). A
// non-literal require is undecidable by this walk, so it fails loudly rather
// than shipping a hash that misses a dependency.
const REQUIRE_LITERAL = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g;
const REQUIRE_ANY = /\brequire\(/g;
const REPO_ROOT = path.resolve(__dirname, '../..');
function deriveSourceFiles() {
  const seen = new Set();
  const queue = [path.resolve(__dirname, 'backend.cjs')];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    const literals = [...text.matchAll(REQUIRE_LITERAL)].map(match => match[2]);
    const calls = [...text.matchAll(REQUIRE_ANY)].length;
    if (calls !== literals.length) {
      throw new Error(`backend source hashing requires static require specifiers; found a dynamic require in ${path.relative(REPO_ROOT, file)}`);
    }
    for (const specifier of literals) {
      if (!specifier.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      if (!fs.existsSync(resolved) || !resolved.startsWith(REPO_ROOT)) continue;
      queue.push(resolved);
    }
  }
  return [...seen].map(file => path.relative(__dirname, file)).sort();
}
const SOURCE_FILES = deriveSourceFiles();
function sourceId() {
  const hash = crypto.createHash('sha256');
  for (const name of SOURCE_FILES) hash.update(name).update('\0').update(fs.readFileSync(path.resolve(__dirname, name))).update('\0');
  return hash.digest('hex');
}
const LOADED_SOURCE_ID = sourceId();
function runtimeIdentity(root, freshSource = false) {
  return { ...rootIdentity(root), sourceId: freshSource ? sourceId() : LOADED_SOURCE_ID };
}
module.exports = { deriveSourceFiles, runtimeIdentity };

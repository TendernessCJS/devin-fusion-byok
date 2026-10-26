'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hostBuildId, publishHostBuild, BUILD_FILE } = require('../src/activation/host-identity.cjs');

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-host-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const write = (root, name, content) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

test('the host build id is deterministic and content-addressed', t => {
  const root = tree(t);
  write(root, 'src/a/x.cjs', 'alpha'); write(root, 'src/b.cjs', 'beta');
  const first = hostBuildId(root), second = hostBuildId(root);
  assert.equal(first.id, second.id);
  assert.equal(first.files, 2);
  assert.match(first.id, /^[0-9a-f]{64}$/);
});

test('any content change changes the id', t => {
  const root = tree(t);
  write(root, 'src/a/x.cjs', 'alpha'); write(root, 'src/b.cjs', 'beta');
  const before = hostBuildId(root).id;
  write(root, 'src/b.cjs', 'beta!');
  assert.notEqual(hostBuildId(root).id, before);
});

test('a rename changes the id because paths feed the hash', t => {
  const root = tree(t);
  write(root, 'src/a/x.cjs', 'alpha'); write(root, 'src/b.cjs', 'beta');
  const before = hostBuildId(root).id;
  fs.renameSync(path.join(root, 'src/b.cjs'), path.join(root, 'src/c.cjs'));
  assert.notEqual(hostBuildId(root).id, before);
});

test('non-.cjs files and node_modules/.git are ignored', t => {
  const root = tree(t);
  write(root, 'src/a/x.cjs', 'alpha'); write(root, 'src/b.cjs', 'beta');
  const before = hostBuildId(root);
  write(root, 'src/d.js', 'js'); write(root, 'src/node_modules/e.cjs', 'dep'); write(root, 'src/.git/f.cjs', 'meta');
  const after = hostBuildId(root);
  assert.equal(after.id, before.id);
  assert.equal(after.files, before.files);
});

test('a missing source tree throws while publishHostBuild swallows it', t => {
  const root = tree(t);
  assert.throws(() => hostBuildId(root));
  assert.equal(publishHostBuild({ root: path.join(root, 'out'), extensionPath: root, version: '0.0.0' }), null);
  assert.equal(fs.existsSync(path.join(root, 'out', BUILD_FILE)), false);
});

test('publishHostBuild writes a 0600 atomic record and overwrites cleanly', t => {
  const root = tree(t);
  write(root, 'src/x.cjs', 'alpha');
  const out = path.join(root, 'out');
  const record = publishHostBuild({ root: out, extensionPath: root, version: '9.9.9' });
  assert.ok(record && typeof record.id === 'string');
  const target = path.join(out, BUILD_FILE);
  const stored = JSON.parse(fs.readFileSync(target, 'utf8'));
  for (const key of ['id', 'files', 'version', 'extension', 'writtenAt']) assert.ok(Object.hasOwn(stored, key), key);
  assert.equal(stored.version, '9.9.9');
  assert.equal(stored.extension, root);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(out).filter(name => name.startsWith(BUILD_FILE + '.')), []);
  write(root, 'src/x.cjs', 'alpha-changed');
  const again = publishHostBuild({ root: out, extensionPath: root, version: '9.9.9' });
  assert.notEqual(again.id, record.id);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).id, again.id);
});

test('the real repository produces a stable build id', () => {
  const build = hostBuildId(path.resolve(__dirname, '..'));
  assert.match(build.id, /^[0-9a-f]{64}$/);
  assert.ok(build.files >= 100, 'the hash must cover the real src tree');
});

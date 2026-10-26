'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { hostBuildId, publishHostBuild, BUILD_DIR } = require('../src/activation/host-identity.cjs');

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
  assert.equal(fs.existsSync(path.join(root, 'out')), false);
});

test('publishHostBuild writes one 0600 record per activation under host-builds', t => {
  const root = tree(t);
  write(root, 'src/x.cjs', 'alpha');
  const out = path.join(root, 'out');
  const record = publishHostBuild({ root: out, extensionPath: root, version: '9.9.9', activatedAt: 'T0' });
  assert.ok(record && typeof record.id === 'string');
  assert.equal(record.kind, 'disk-source-snapshot');
  assert.equal(record.pid, process.pid);
  assert.equal(record.activatedAt, 'T0');
  assert.match(record.instanceId, /^[0-9a-f-]{36}$/);
  assert.match(record.recordFile, /^host-builds\/\d+-[0-9a-f-]{36}\.json$/);
  const target = path.join(out, record.recordFile);
  const stored = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.deepEqual(stored, record, 'the record on disk is exactly the returned record');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(out, BUILD_DIR)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.join(out, BUILD_DIR)).filter(name => name.endsWith('.tmp')), []);

  write(root, 'src/x.cjs', 'alpha-changed');
  const second = publishHostBuild({ root: out, extensionPath: root, version: '9.9.9' });
  assert.notEqual(second.id, record.id, 'a one-byte source change must move the id');
  assert.notEqual(second.instanceId, record.instanceId);
  assert.notEqual(second.recordFile, record.recordFile);
  assert.equal(fs.readdirSync(path.join(out, BUILD_DIR)).filter(name => name.endsWith('.json')).length, 2,
    'a repeat activation in the same pid must not overwrite the earlier record');
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), record,
    'the first record stays as written');
});

test('distinct pids publish independent records into the same root', t => {
  const root = tree(t);
  write(root, 'src/x.cjs', 'alpha');
  const out = path.join(root, 'out');
  const modulePath = path.resolve(__dirname, '../src/activation/host-identity.cjs');
  const script = `const {publishHostBuild}=require(${JSON.stringify(modulePath)});` +
    `const r=publishHostBuild(${JSON.stringify({ root: out, extensionPath: root, version: '1' })});` +
    'process.stdout.write(r ? r.recordFile : "null")';
  const first = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  const second = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.notEqual(first, second);
  for (const file of [first, second]) assert.ok(fs.existsSync(path.join(out, file)), file);
  assert.equal(fs.readdirSync(path.join(out, BUILD_DIR)).filter(name => name.endsWith('.json')).length, 2);
});

test('a failed publish returns null and removes only its own temp file', t => {
  const root = tree(t);
  write(root, 'src/x.cjs', 'alpha');
  const out = path.join(root, 'out');
  assert.ok(publishHostBuild({ root: out, extensionPath: root, version: '1' }), 'baseline publish works');
  const foreign = path.join(out, BUILD_DIR, 'not-ours.tmp');
  fs.writeFileSync(foreign, 'untouched');
  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('boom'); };
  try {
    assert.equal(publishHostBuild({ root: out, extensionPath: root, version: '1' }), null);
  } finally { fs.renameSync = realRename; }
  const names = fs.readdirSync(path.join(out, BUILD_DIR));
  assert.deepEqual(names.filter(name => name.endsWith('.tmp')), ['not-ours.tmp'],
    'cleanup removes only the temp file this publish created');
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'untouched');
});

test('a pre-existing temp path is never claimed as ours', t => {
  const root = tree(t);
  write(root, 'src/x.cjs', 'alpha');
  const out = path.join(root, 'out');
  const uuid = '11111111-2222-4333-8444-555555555555';
  const realUuid = crypto.randomUUID;
  crypto.randomUUID = () => uuid;
  const occupied = path.join(out, BUILD_DIR, `${process.pid}-${uuid}.tmp`);
  try {
    assert.ok(publishHostBuild({ root: out, extensionPath: root, version: '1' }), 'first run creates the dir');
    fs.writeFileSync(occupied, 'pre-existing bytes');
    assert.equal(publishHostBuild({ root: out, extensionPath: root, version: '1' }), null);
    assert.equal(fs.readFileSync(occupied, 'utf8'), 'pre-existing bytes',
      'an EEXIST temp belongs to someone else and must survive');
  } finally { crypto.randomUUID = realUuid; }
});

test('a write failure mid-publish cleans only the temp it created', t => {
  const root = tree(t);
  write(root, 'src/x.cjs', 'alpha');
  const out = path.join(root, 'out');
  const dir = path.join(out, BUILD_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const foreign = path.join(dir, 'other.tmp');
  fs.writeFileSync(foreign, 'keep');
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = () => { throw new Error('disk-full'); };
  try {
    assert.equal(publishHostBuild({ root: out, extensionPath: root, version: '1' }), null);
  } finally { fs.writeFileSync = realWrite; }
  assert.deepEqual(fs.readdirSync(dir), ['other.tmp'], 'the failed temp is removed, foreign files stay');
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'keep');
});

test('a legacy singleton host-build.json is left untouched', t => {
  const root = tree(t);
  write(root, 'src/x.cjs', 'alpha');
  const out = path.join(root, 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'host-build.json'), '{"legacy":true}');
  publishHostBuild({ root: out, extensionPath: root, version: '1' });
  assert.equal(fs.readFileSync(path.join(out, 'host-build.json'), 'utf8'), '{"legacy":true}');
});

test('the real repository produces a stable build id', () => {
  const build = hostBuildId(path.resolve(__dirname, '..'));
  assert.match(build.id, /^[0-9a-f]{64}$/);
  assert.ok(build.files >= 100, 'the hash must cover the real src tree');
});

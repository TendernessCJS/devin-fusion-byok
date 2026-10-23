'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readDoc, updateConfig, applyKeyDelta, archiveCorrupt, recoverFromBackup } = require('../src/config/store.cjs');
const { createManager } = require('../src/panel/manager.cjs');
const { readConfig } = require('../src/config/config.cjs');

function dir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-config-store-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('two processes holding the lock in turn never lose an update', async t => {
  const file = path.join(dir(t), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: true, providers: [] }));
  const worker = (key, value) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', `const { updateConfig } = require(${JSON.stringify(path.resolve(__dirname, '../src/config/store.cjs'))});
      const sab = new Int32Array(new SharedArrayBuffer(4));
      updateConfig(${JSON.stringify(file)}, doc => {
        Atomics.wait(sab, 0, 0, 200);
        doc[${JSON.stringify(key)}] = ${JSON.stringify(value)};
        return true;
      }, { timeoutMs: 5000 });
      console.log('done');`]);
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('worker ' + key + ' exited ' + code + ': ' + err)));
  });
  await Promise.all([worker('alpha', 1), worker('beta', 2)]);
  const { doc, revision } = readDoc(file);
  assert.equal(doc.alpha, 1, 'the first writer survives');
  assert.equal(doc.beta, 2, 'and so does the second');
  assert.equal(revision, 2, 'two committed updates');
});

test('a stale lock from a dead pid is reclaimed once', t => {
  const file = path.join(dir(t), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: true }));
  fs.writeFileSync(file + '.lock', JSON.stringify({ pid: 1 << 30, time: Date.now() }));
  const { changed } = updateConfig(file, doc => (doc.flag = true, true));
  assert.equal(changed, true);
  assert.equal(readConfig(file).flag, true);
  assert.equal(fs.existsSync(file + '.lock'), false, 'the stolen lock was released');
});

test('an empty lock aged past 30s is reclaimed by mtime', t => {
  const file = path.join(dir(t), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: true }));
  fs.writeFileSync(file + '.lock', '');
  const old = new Date(Date.now() - 40000);
  fs.utimesSync(file + '.lock', old, old);
  const { changed } = updateConfig(file, doc => (doc.flag = true, true));
  assert.equal(changed, true);
  assert.equal(readConfig(file).flag, true);
  assert.equal(fs.existsSync(file + '.lock'), false);
});

test('a fresh unparseable lock is never stolen and times out', t => {
  const file = path.join(dir(t), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: true }));
  fs.writeFileSync(file + '.lock', '{');
  assert.throws(() => updateConfig(file, () => true, { timeoutMs: 60 }), error => error.code === 'config_busy');
  assert.ok(fs.existsSync(file + '.lock'), 'a just-created-looking lock is not removed');
  fs.unlinkSync(file + '.lock');
});

test('the first write creates no bak; the second stores the previous bytes', t => {
  const file = path.join(dir(t), 'config.json');
  updateConfig(file, doc => Object.assign(doc, { enabled: true }));
  assert.equal(fs.existsSync(file + '.bak'), false);
  const first = fs.readFileSync(file, 'utf8');
  updateConfig(file, doc => (doc.flag = 1, true));
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), first, '.bak holds the pre-write bytes');
  assert.notEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).flag, 1);
});

test('valid JSON that is not an object is corrupt and resettable via fromEmpty', t => {
  const d = dir(t), file = path.join(d, 'config.json');
  for (const content of ['null', '[]']) {
    fs.writeFileSync(file, content);
    assert.throws(() => readDoc(file), error => error.code === 'config_corrupt');
  }
  fs.writeFileSync(file, 'not-json');
  const { doc } = updateConfig(file, d2 => Object.assign(d2, { enabled: true }), { fromEmpty: true });
  assert.equal(doc.enabled, true);
  assert.equal(fs.existsSync(file + '.bak'), false, 'corrupt bytes are not preserved over a good bak');
});

test('reset path archives evidence and restarts revision at 1 when bak is also corrupt', t => {
  const d = dir(t), file = path.join(d, 'config.json');
  fs.writeFileSync(file, 'not-json');
  fs.writeFileSync(file + '.bak', 'also-corrupt');
  assert.equal(recoverFromBackup(file), null);
  archiveCorrupt(file);
  const { revision, doc } = updateConfig(file, d2 => Object.assign(d2, { enabled: true }), { fromEmpty: true });
  assert.equal(revision, 1);
  assert.equal(doc.enabled, true);
  assert.ok(fs.readdirSync(d).some(name => name.startsWith('config.json.corrupt-')));
});

test('recovery mutator drops the backup’s own configRevision', t => {
  const file = path.join(dir(t), 'config.json');
  fs.writeFileSync(file, 'not-json');
  fs.writeFileSync(file + '.bak', JSON.stringify({ enabled: true, flag: 'kept', configRevision: 9 }));
  const recovered = recoverFromBackup(file);
  assert.ok(recovered);
  const { configRevision: _ignored, ...rest } = recovered.doc;
  const { doc, revision } = updateConfig(file, d2 => Object.assign(d2, rest), { fromEmpty: true });
  assert.equal(doc.flag, 'kept');
  assert.equal(doc.configRevision, 1);
  assert.equal(revision, 1);
});

test('archiveCorrupt does not throw for a missing file', t => {
  const file = path.join(dir(t), 'config.json');
  assert.doesNotThrow(() => archiveCorrupt(file));
});

test('a fresh lock from a live pid times out with config_busy', t => {
  const file = path.join(dir(t), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: true }));
  fs.writeFileSync(file + '.lock', JSON.stringify({ pid: process.pid, time: Date.now() }));
  assert.throws(() => updateConfig(file, () => true, { timeoutMs: 60 }), error => error.code === 'config_busy');
  assert.ok(fs.existsSync(file + '.lock'), 'a live lock is never removed');
  fs.unlinkSync(file + '.lock');
});

test('a mutator returning false writes nothing and does not advance the revision', t => {
  const file = path.join(dir(t), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: true, configRevision: 3 }));
  const before = fs.statSync(file).mtimeMs;
  const { changed, revision } = updateConfig(file, () => false);
  assert.equal(changed, false);
  assert.equal(revision, 3);
  assert.equal(fs.statSync(file).mtimeMs, before);
  assert.equal(readConfig(file).configRevision, 3);
});

test('recoverFromBackup restores a valid bak and preserves the corrupt file', t => {
  const d = dir(t), file = path.join(d, 'config.json');
  fs.writeFileSync(file, 'not-json{{{');
  fs.writeFileSync(file + '.bak', JSON.stringify({ enabled: true, marker: 'saved' }));
  const recovered = recoverFromBackup(file);
  assert.equal(recovered.doc.marker, 'saved');
  assert.equal(fs.existsSync(file), false, 'the corrupt original was renamed aside');
  assert.ok(fs.readdirSync(d).some(name => name.startsWith('config.json.corrupt-')));
});

test('recoverFromBackup without a bak returns null without throwing', t => {
  const file = path.join(dir(t), 'config.json');
  fs.writeFileSync(file, 'not-json');
  assert.equal(recoverFromBackup(file), null);
  fs.writeFileSync(file + '.bak', 'also-corrupt');
  assert.equal(recoverFromBackup(file), null);
});

test('applyKeyDelta merges only the keys this operation touched', () => {
  const doc = { a: 'external-new', b: 1, c: 9, configRevision: 7 };
  const baseline = { a: 'old', b: 1, c: 9, configRevision: 7 };
  const next = { a: 'old', b: 2, configRevision: 7 };
  const changed = applyKeyDelta(doc, next, baseline);
  assert.equal(changed, true);
  assert.equal(doc.a, 'external-new', 'untouched keys keep the external value');
  assert.equal(doc.b, 2, 'changed keys apply');
  assert.equal(Object.hasOwn(doc, 'c'), false, 'keys deleted by next are removed');
  assert.equal(doc.configRevision, 7, 'configRevision is never touched');
  assert.equal(applyKeyDelta(doc, next, baseline), false, 'a no-op merge reports no change');
});

test('legacy files without configRevision start at 0 and land at 1', t => {
  const file = path.join(dir(t), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: true }));
  assert.equal(readDoc(file).revision, 0);
  const { revision } = updateConfig(file, doc => (doc.flag = true, true));
  assert.equal(revision, 1);
  assert.equal(readDoc(file).revision, 1);
});

test('a stale manager commit merges keys instead of overwriting them', t => {
  const file = path.join(dir(t), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: true, providers: [] }));
  const hooks = () => ({ read: () => readConfig(file),
    write: (next, baseline) => updateConfig(file, doc => applyKeyDelta(doc, next, baseline)) });
  let first = true;
  const slow = createManager({ read: () => readConfig(file),
    write: (next, baseline) => {
      if (first) {
        first = false;
        updateConfig(file, doc => (doc.lastFusionSelection = 'fusion-b', true)); // the other window lands first
      }
      return updateConfig(file, doc => applyKeyDelta(doc, next, baseline));
    } });
  const other = createManager(hooks());
  return slow.dispatch('setAutoContinue', { enabled: true }).then(() => {
    return other.dispatch('ready');
  }).then(() => {
    const { doc } = readDoc(file);
    assert.equal(doc.lastFusionSelection, 'fusion-b', "the other window's key survives the stale commit");
    assert.equal(doc.autoContinueOnProviderError, true, 'and our flag still applied');
  });
});

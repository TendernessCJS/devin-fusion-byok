'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createSourceGraph } = require('./helpers/source-graph.cjs');

const repoRoot = path.resolve(__dirname, '..');
const srcRoot = path.join(repoRoot, 'src');
const rel = file => path.relative(repoRoot, file);
const srcFiles = () => {
  const files = [];
  const scan = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(full);
    else if (entry.name.endsWith('.cjs')) files.push(full);
  } };
  scan(srcRoot);
  return files;
};

const BACKEND_FORBIDDEN_DIRS = ['activation', 'panel', 'goal', 'fast-context', 'lifecycle', 'network', 'update'];
const BACKEND_FORBIDDEN_FILES = [
  'models/discovery.cjs', 'models/discovery-error.cjs', 'update.cjs', 'proxy.cjs',
  'extension.cjs',
];
const BACKEND_RUNTIME_ROOT = [
  'backend.cjs', 'backend-control.cjs', 'bridge.cjs', 'contract.cjs',
  'native-cache.cjs', 'port.cjs', 'source-identity.cjs',
];
function backendViolations(graph) {
  const violations = [];
  const closure = graph.closure(path.join(srcRoot, 'runtime/backend.cjs'));
  for (const file of closure) {
    const relative = path.relative(srcRoot, file);
    const [top, base] = [relative.split(path.sep)[0], path.basename(file)];
    const runtimeRest = top === 'runtime' ? relative.split(path.sep).slice(1) : [];
    if (BACKEND_FORBIDDEN_DIRS.includes(top) || BACKEND_FORBIDDEN_FILES.includes(relative) ||
      (top === 'runtime' && (runtimeRest[0] === 'host' ||
        (runtimeRest.length === 1 && !BACKEND_RUNTIME_ROOT.includes(base))))) violations.push(relative);
  }
  for (const file of closure) {
    if (graph.depsOf(file).deps.includes('vscode')) violations.push(path.relative(srcRoot, file) + ' -> vscode');
  }
  return violations;
}

test('the backend require closure contains no host, UI, feature or transport modules', () => {
  assert.deepEqual(backendViolations(createSourceGraph()), [],
    'the backend process must stay limited to its serving modules');
});

// Inverse of the deny-list above: a deny-list lets a brand-new top-level
// directory into the backend closure by default, which is exactly the leak
// this guard exists to catch. Measured tops: protocol:8, catalog:8, config:1,
// runtime:7, models:2, monitor:2, root:1 (catalog.cjs).
const BACKEND_ALLOWED_TOP_DIRS = ['protocol', 'catalog', 'config', 'runtime', 'models', 'monitor'];
const BACKEND_ALLOWED_ROOT_FILES = ['catalog.cjs'];
test('every top-level entry in the backend closure sits inside the allow-list', () => {
  const closure = createSourceGraph().closure(path.join(srcRoot, 'runtime/backend.cjs'));
  const unexpected = [];
  for (const file of closure) {
    const relative = path.relative(srcRoot, file);
    if (relative.startsWith('..')) continue; // repo-root deps like package.json
    const parts = relative.split(path.sep);
    if (parts.length === 1) {
      if (!BACKEND_ALLOWED_ROOT_FILES.includes(relative)) unexpected.push(relative);
    } else if (!BACKEND_ALLOWED_TOP_DIRS.includes(parts[0])) unexpected.push(relative);
  }
  assert.deepEqual(unexpected, [],
    'a new host-side top-level entry must be explicitly added to the allow-list: ' + unexpected.join(', '));
});

test('lightweight clients never reach the backend implementation or the hash walker', () => {
  const graph = createSourceGraph();
  for (const client of ['runtime/host/native-models.cjs', 'runtime/host/monitor-client.cjs']) {
    const closure = graph.closure(path.join(srcRoot, client));
    for (const file of closure) {
      const base = path.basename(file);
      assert.notEqual(base, 'backend.cjs', client + ' must not load the backend implementation');
      assert.notEqual(base, 'source-identity.cjs', client + ' must not pay the source-hash scan');
    }
    assert.ok([...closure].some(file => file.endsWith('contract.cjs')), client + ' keeps the lightweight contract');
  }
  const handshake = graph.closure(path.join(srcRoot, 'activation/backend-handshake.cjs'));
  assert.ok(![...handshake].some(file => file.endsWith('backend.cjs')), 'the handshake checks identity, it does not serve it');
  assert.ok([...handshake].some(file => file.endsWith('source-identity.cjs')), 'the handshake still verifies fresh source identity');
});

test('loading the lightweight clients executes neither backend.cjs nor source-identity.cjs', () => {
  for (const client of ['runtime/host/native-models.cjs', 'runtime/host/monitor-client.cjs']) {
    const loaded = execFileSync(process.execPath, ['-e',
      `require(${JSON.stringify(path.join(srcRoot, client))});` +
      'process.stdout.write(JSON.stringify(Object.keys(require.cache).filter(f => /[\\\\/](?:backend|source-identity)\\.cjs$/.test(f))))'],
      { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(loaded), [], client + ' must not execute the backend or the hash walker at load');
  }
});

test('the src tree has no file-level require cycles', () => {
  const { cycle, dynamic } = createSourceGraph().findCycle(srcFiles());
  assert.equal(cycle, null);
  assert.deepEqual(dynamic.map(rel), ['src/fast-context/launcher.cjs'],
    'the CLI launcher is the only file allowed an unresolvable require — outside the backend closure');
});

test('backend boundary guards fail on a host/UI edge injected in memory', () => {
  const backendFile = path.join(srcRoot, 'runtime/backend.cjs');
  const overlay = createSourceGraph({
    readFile: file => path.resolve(file) === backendFile
      ? fs.readFileSync(file, 'utf8') + "\nrequire('../panel/manager.cjs');\n"
      : fs.readFileSync(file, 'utf8'),
  });
  assert.ok(backendViolations(overlay).includes(path.join('panel', 'manager.cjs')),
    'an injected panel edge must trip the backend closure guard');
});

test('backend boundary guards fail on an injected runtime/host edge', () => {
  const backendFile = path.join(srcRoot, 'runtime/backend.cjs');
  const overlay = createSourceGraph({
    readFile: file => path.resolve(file) === backendFile
      ? fs.readFileSync(file, 'utf8') + "\nrequire('./host/injection-health.cjs');\n"
      : fs.readFileSync(file, 'utf8'),
  });
  assert.ok(backendViolations(overlay).includes(path.join('runtime', 'host', 'injection-health.cjs')),
    'an injected runtime/host edge must trip the backend closure guard');
});

test('backend boundary guards fail on an injected unknown runtime root module', () => {
  const backendFile = path.join(srcRoot, 'runtime/backend.cjs');
  const ghost = path.join(srcRoot, 'runtime/new-host-thing.cjs');
  const overlay = createSourceGraph({
    readFile: file => {
      const resolved = path.resolve(file);
      if (resolved === backendFile) return fs.readFileSync(file, 'utf8') + "\nrequire('./new-host-thing.cjs');\n";
      if (resolved === ghost) return "'use strict';\nmodule.exports = {};\n";
      return fs.readFileSync(file, 'utf8');
    },
    exists: file => path.resolve(file) === ghost || fs.existsSync(file),
  });
  assert.ok(backendViolations(overlay).includes(path.join('runtime', 'new-host-thing.cjs')),
    'an injected runtime root module outside the allowlist must trip the backend closure guard');
});

test('the cycle check fails on a require cycle injected in memory', () => {
  const portFile = path.join(srcRoot, 'runtime/port.cjs');
  const contractFile = path.join(srcRoot, 'runtime/contract.cjs');
  const overlay = createSourceGraph({
    readFile: file => {
      const resolved = path.resolve(file), text = fs.readFileSync(file, 'utf8');
      if (resolved === portFile) return text + "\nrequire('./contract.cjs');\n";
      if (resolved === contractFile) return text + "\nrequire('./port.cjs');\n";
      return text;
    },
  });
  const { cycle } = overlay.findCycle(srcFiles());
  assert.ok(cycle && cycle.includes(portFile) && cycle.includes(contractFile),
    'an injected port <-> contract cycle must be reported');
});

test('a non-literal require anywhere in the graph fails loudly', () => {
  const backendFile = path.join(srcRoot, 'runtime/backend.cjs');
  const overlay = createSourceGraph({
    readFile: file => path.resolve(file) === backendFile
      ? fs.readFileSync(file, 'utf8') + '\nrequire(condition ? "./a.cjs" : "./b.cjs");\n'
      : fs.readFileSync(file, 'utf8'),
  });
  assert.throws(() => overlay.closure(backendFile), /dynamic require/);
});

test('the config/models aggregation keeps shared modules in the backend and discovery out', () => {
  const closure = new Set([...createSourceGraph().closure(path.join(srcRoot, 'runtime/backend.cjs'))]
    .map(file => path.relative(srcRoot, file)));
  for (const shared of ['config/config.cjs', 'models/capabilities.cjs', 'models/native-entry.cjs'])
    assert.ok(closure.has(shared), shared + ' is a backend dependency at its new path');
  for (const discovery of ['models/discovery.cjs', 'models/discovery-error.cjs'])
    assert.ok(!closure.has(discovery), discovery + ' must stay out of the backend closure');
  for (const legacy of ['config.cjs', 'config-store.cjs', 'model-capabilities.cjs',
      'native-entry.cjs', 'model-discovery.cjs', 'model-discovery-error.cjs'])
    assert.ok(!fs.existsSync(path.join(srcRoot, legacy)), 'no duplicate or stub remains at src/' + legacy);
});

for (const discovery of ['models/discovery.cjs', 'models/discovery-error.cjs']) {
  test(`backend boundary guard rejects an injected ${discovery} edge`, () => {
    const backendFile = path.join(srcRoot, 'runtime/backend.cjs');
    const overlay = createSourceGraph({
      readFile: file => path.resolve(file) === backendFile
        ? fs.readFileSync(file, 'utf8') + `\nrequire('../${discovery}');\n`
        : fs.readFileSync(file, 'utf8'),
    });
    assert.ok(backendViolations(overlay).includes(discovery),
      'an injected ' + discovery + ' edge must trip the backend closure guard');
  });
}

const filesUnder = prefix => srcFiles()
  .map(file => path.relative(srcRoot, file))
  .filter(relative => relative.startsWith(prefix + path.sep))
  .sort();

const closureOf = (graph, entry) => [...graph.closure(path.join(srcRoot, entry))]
  .map(file => file === 'vscode' ? 'vscode' : path.relative(srcRoot, file));
// `closure()` only returns the files the walker enqueued, so a `vscode` edge is
// never a key — the dependency has to be read off each visited file's deps or the
// guard silently misses it.
const vscodeEdges = (graph, entry, closure) => closure
  .filter(file => file !== 'vscode')
  .filter(file => graph.depsOf(path.join(srcRoot, file), { tolerateDynamic: true }).deps.includes('vscode'))
  .map(() => entry + ' -> vscode');

const networkViolations = (graph, entries = filesUnder('network')) => {
  const violations = [];
  for (const entry of entries) {
    const closure = closureOf(graph, entry);
    for (const file of closure)
      if (file !== entry && !file.startsWith('network' + path.sep)) violations.push(entry + ' -> ' + file);
    violations.push(...vscodeEdges(graph, entry, closure));
  }
  return violations;
};

const updateViolations = (graph, entries = filesUnder('update')) => {
  const violations = [];
  for (const entry of entries) {
    const closure = closureOf(graph, entry);
    // `..` 前缀=解析到 src/ 之外的数据依赖（如 update/updater.cjs -> ../../package.json），
    // 不是模块分层边；`vscode` 仍由下面的 vscodeEdges 单独判定。
    for (const file of closure)
      if (file !== entry && !file.startsWith('..') && !file.startsWith('update' + path.sep) && !file.startsWith('network' + path.sep))
        violations.push(entry + ' -> ' + file);
    violations.push(...vscodeEdges(graph, entry, closure));
  }
  return violations;
};

// proxy-config carries panel-facing proxy text handling only; any repository
// dependency makes it a transport module wearing a config name.
const LEAF = path.join('update', 'proxy-config.cjs');
const leafViolations = graph => closureOf(graph, LEAF).length === 1 ? [] : [LEAF];

// Model discovery reached the GitHub stack only through the facade before; it
// must keep resolving to the shared direct transport and nothing update-shaped.
const DISCOVERY = path.join('models', 'discovery.cjs');
const discoveryViolations = graph => {
  const closure = closureOf(graph, DISCOVERY);
  return closure
    .filter(file => file !== DISCOVERY && (file === 'proxy.cjs' || file.startsWith('update' + path.sep)))
    .map(file => DISCOVERY + ' -> ' + file)
    .concat(vscodeEdges(graph, DISCOVERY, closure));
};

test('filesUnder enumerates the network directory from disk, so new files join the guard', () => {
  const listed = filesUnder('network');
  const onDisk = fs.readdirSync(path.join(srcRoot, 'network')).filter(name => name.endsWith('.cjs'));
  assert.equal(listed.length, onDisk.length);
  for (const file of listed) assert.ok(file.startsWith('network' + path.sep));
});

test('network/ and update/ keep their dependency ceilings, and proxy-config stays a leaf', () => {
  const graph = createSourceGraph();
  assert.deepEqual(networkViolations(graph), []);
  assert.deepEqual(updateViolations(graph), []);
  assert.deepEqual(leafViolations(graph), [], 'proxy-config must stay a leaf with only builtin dependencies');
  assert.deepEqual(discoveryViolations(graph), []);
  const discovery = closureOf(graph, DISCOVERY);
  assert.ok(discovery.includes(path.join('network', 'direct-fetch.cjs')),
    'discovery uses the direct transport at its new path');
  for (const entry of [path.join('panel', 'manager.cjs'), path.join('panel', 'panel-state.cjs')])
    assert.ok(closureOf(graph, entry).includes(path.join('update', 'proxy-config.cjs')),
      entry + ' reads proxy configuration only');
});

test('no production module requires the proxy.cjs facade', () => {
  const graph = createSourceGraph();
  const facade = path.join(srcRoot, 'proxy.cjs');
  for (const file of srcFiles()) {
    if (file === facade) continue;
    assert.ok(!graph.depsOf(file, { tolerateDynamic: true }).deps.includes(facade),
      rel(file) + ' must import the new module paths, not the compatibility facade');
  }
});

const injectedGraph = (patched, specifier) => {
  const file = path.join(srcRoot, patched);
  return createSourceGraph({
    readFile: target => path.resolve(target) === file
      ? fs.readFileSync(target, 'utf8') + `\nrequire('${specifier}');\n`
      : fs.readFileSync(target, 'utf8'),
  });
};

test('backend boundary guards fail on an injected update/download edge', () => {
  const backendFile = path.join(srcRoot, 'runtime/backend.cjs');
  const overlay = createSourceGraph({
    readFile: file => path.resolve(file) === backendFile
      ? fs.readFileSync(file, 'utf8') + "\nrequire('../update/download.cjs');\n"
      : fs.readFileSync(file, 'utf8'),
  });
  assert.ok(backendViolations(overlay).includes(path.join('update', 'download.cjs')),
    'an injected update/ edge must trip the backend closure guard');
});

for (const { patched, specifier, expect } of [
  { patched: path.join('network', 'client-request.cjs'), specifier: '../panel/manager.cjs', expect: path.join('panel', 'manager.cjs') },
  { patched: path.join('network', 'direct-fetch.cjs'), specifier: 'vscode', expect: 'vscode' },
  { patched: path.join('update', 'proxy-transport.cjs'), specifier: '../panel/manager.cjs', expect: path.join('panel', 'manager.cjs') },
  { patched: path.join('update', 'download.cjs'), specifier: '../proxy.cjs', expect: 'proxy.cjs' },
]) {
  test(`the layering guard rejects an injected ${patched} -> ${expect} edge`, () => {
    const violations = [...networkViolations(injectedGraph(patched, specifier)),
      ...updateViolations(injectedGraph(patched, specifier))];
    assert.ok(violations.includes(patched + ' -> ' + expect),
      'the injected edge must be reported from its own entry, not via another module that reaches it');
  });
}

test('the leaf guard rejects an injected proxy-config -> direct-fetch edge', () => {
  const overlay = injectedGraph(LEAF, '../network/direct-fetch.cjs');
  assert.deepEqual(leafViolations(overlay), [LEAF],
    'proxy-config must stop being a leaf once it depends on a transport');
});

test('the discovery guard rejects an injected discovery -> proxy.cjs edge', () => {
  const overlay = injectedGraph(DISCOVERY, '../proxy.cjs');
  // The facade re-exports the update modules, so this edge also drags them in;
  // the point is that the violation is reported from discovery's own entry.
  assert.ok(discoveryViolations(overlay).includes(DISCOVERY + ' -> proxy.cjs'),
    'discovery reaching the facade must be reported from its own entry');
});

test('the network ceiling covers every file the directory listing returns', () => {
  const download = path.join('update', 'download.cjs');
  for (const entry of filesUnder('network')) {
    const overlay = injectedGraph(entry, '../update/download.cjs');
    assert.ok(networkViolations(overlay).includes(entry + ' -> ' + download),
      entry + ' must be its own guard root, not a name in a hand-kept list');
  }
});

test('the update ceiling covers every file the directory listing returns', () => {
  const panel = path.join('panel', 'controller.cjs');
  for (const entry of filesUnder('update')) {
    const overlay = injectedGraph(entry, '../panel/controller.cjs');
    assert.ok(updateViolations(overlay).includes(entry + ' -> ' + panel),
      entry + ' must be its own guard root, not a name in a hand-kept list');
  }
});

test('a new file dropped into network/ is guarded by the same ceiling', () => {
  const ghost = path.join(srcRoot, 'network', 'extra.cjs');
  const overlay = createSourceGraph({
    readFile: file => path.resolve(file) === ghost
      ? "'use strict';\nrequire('../update/download.cjs');\n"
      : fs.readFileSync(file, 'utf8'),
    exists: file => path.resolve(file) === ghost || fs.existsSync(file),
  });
  const violations = networkViolations(overlay, [path.join('network', 'extra.cjs')]);
  assert.ok(violations.includes(path.join('network', 'extra.cjs') + ' -> ' + path.join('update', 'download.cjs')),
    'a new network/ file reaching update/ must be reported');
});

// `shared` is the activation-wide service locator: installers publish slots
// that other installers read through late binding. A slot with two writers
// makes one installer's state another's to overwrite and silently widens the
// object every test has to fake, so the writer map is pinned here.
const SHARED_MULTI_WRITER = { backendStatus: ['activation/commands.cjs', 'activation/enable.cjs'] };
const sharedWriterFiles = () => [
  path.join(srcRoot, 'extension.cjs'),
  ...fs.readdirSync(path.join(srcRoot, 'activation')).filter(name => name.endsWith('.cjs'))
    .map(name => path.join(srcRoot, 'activation', name)),
];
// Assignments and in-place mutations are both writes: `shared.x =`, compound
// and logical assignments, `++`/`--`, `delete shared.x`, and
// `shared.x.push(...)`/`shared.x.set(...)` etc. move state all the same.
const WRITE_PATTERN = (holder, slot) => new RegExp(
  String.raw`(?:delete\s+|\+\+\s*|--\s*)${holder}\.(${slot})` +
  String.raw`|${holder}\.(${slot})\s*(?:\+\+|--)` +
  String.raw`|${holder}\.(${slot})\s*(?:\?\?=|\|\|=|&&=|\*\*=|\+=|-=|\*=|\/=|%=|=)(?!=)` +
  String.raw`|${holder}\.(${slot})\.(?:set|delete|clear|push|add|splice)\s*\(`, 'g');
const writtenSlot = match => match.slice(1).find(value => value !== undefined);
const writeViolations = (holder, multiWriter, readFile = fs.readFileSync) => {
  const writers = new Map();
  const pattern = WRITE_PATTERN(holder, '[A-Za-z][A-Za-z0-9]*');
  for (const file of sharedWriterFiles()) {
    const label = path.relative(srcRoot, file).split(path.sep).join('/');
    for (const match of readFile(file, 'utf8').matchAll(pattern)) {
      const slot = writtenSlot(match);
      if (!writers.has(slot)) writers.set(slot, new Set());
      writers.get(slot).add(label);
    }
  }
  const violations = [];
  for (const [slot, set] of writers) {
    const actual = [...set].sort(), allowed = multiWriter[slot];
    if (!allowed) { if (actual.length > 1) violations.push(slot + ' <- ' + actual.join(', ')); continue; }
    if (actual.join(',') !== [...allowed].sort().join(',')) violations.push(slot + ' <- ' + actual.join(', '));
  }
  return violations;
};
const sharedWriterViolations = (readFile = fs.readFileSync) => writeViolations('shared', SHARED_MULTI_WRITER, readFile);

// deps.stores holds the three named slot groups split out of `shared`. Each
// store has exactly one owning writer module; acpObservation is the stated
// exception — enable.cjs owns its seq/ownModels, not the store factory file.
const STORE_OWNER = {
  nativeCatalog: ['activation/catalog-sync.cjs'],
  cacheSync: ['activation/cache-sync.cjs'],
  acpObservation: ['activation/enable.cjs'],
};
const storeWriterViolations = (readFile = fs.readFileSync) => {
  const violations = [];
  for (const [store, owners] of Object.entries(STORE_OWNER)) {
    for (const file of sharedWriterFiles()) {
      const label = path.relative(srcRoot, file).split(path.sep).join('/');
      const pattern = WRITE_PATTERN(String.raw`stores\.${store}`, '[A-Za-z][A-Za-z0-9]*');
      for (const match of readFile(file, 'utf8').matchAll(pattern)) {
        if (!owners.includes(label)) violations.push(`${store}.${writtenSlot(match)} <- ${label}`);
      }
    }
  }
  return violations;
};

test('every shared activation slot has exactly one writer module', () => {
  assert.deepEqual(sharedWriterViolations(), [],
    'a new writer must either move to the slot owner or join SHARED_MULTI_WRITER explicitly');
});

test('the shared writer guard rejects an injected second writer', () => {
  const target = path.join(srcRoot, 'activation', 'catalog-sync.cjs');
  const violations = sharedWriterViolations(file => path.resolve(file) === target
    ? fs.readFileSync(file, 'utf8') + '\nshared.backendStatus = \'x\';\n'
    : fs.readFileSync(file, 'utf8'));
  assert.ok(violations.includes('backendStatus <- activation/catalog-sync.cjs, activation/commands.cjs, activation/enable.cjs'),
    'a third writer of a whitelisted multi-writer slot must be reported');
});

test('every deps.stores slot is written only by its owning module', () => {
  assert.deepEqual(storeWriterViolations(), [],
    'a store slot written outside its owner must move the write or widen STORE_OWNER explicitly');
});

test('the store writer guard rejects an injected foreign writer', () => {
  const target = path.join(srcRoot, 'activation', 'catalog-sync.cjs');
  const violations = storeWriterViolations(file => path.resolve(file) === target
    ? fs.readFileSync(file, 'utf8') + '\nstores.acpObservation.seq = 1;\n'
    : fs.readFileSync(file, 'utf8'));
  assert.ok(violations.includes('acpObservation.seq <- activation/catalog-sync.cjs'),
    'a write from a non-owning module must be reported');
});

// Installers must resolve shared function slots at call time. A value capture
// pins whatever the slot held at install time, and because consumers declare
// defaults it degrades to a silent no-op instead of an error.
const installTimeCaptures = (readFile = fs.readFileSync) => {
  const source = readFile(path.join(srcRoot, 'activation', 'panel-install.cjs'), 'utf8');
  return [...source.matchAll(/\b(selectFusion|refreshNativeModels):(?!\s*\w+\s*=>|\s*\([^)]*\)\s*=>)/g)].map(match => match[1]);
};

test('panel installers resolve function slots at call time', () => {
  assert.deepEqual(installTimeCaptures(), [], 'pass a wrapper arrow function, not the slot value');
});

test('the call-time guard rejects an injected value capture', () => {
  const violations = installTimeCaptures(() => '  selectFusion: shared.saveFusionChoice,\n');
  assert.deepEqual(violations, ['selectFusion'], 'a value capture must be reported');
});

const reverted = (from, to) => file => fs.readFileSync(file, 'utf8').replace(from, to);

test('the call-time guard catches a refreshNativeModels value capture in real source', () => {
  const violations = installTimeCaptures(reverted(
    'refreshNativeModels: () => stores.nativeCatalog.refreshNativeModels()',
    'refreshNativeModels: stores.nativeCatalog.refreshNativeModels'));
  assert.deepEqual(violations, ['refreshNativeModels']);
});

test('the call-time guard catches a selectFusion value capture in real source', () => {
  const violations = installTimeCaptures(reverted(
    'selectFusion: uid => shared.saveFusionChoice(uid)',
    'selectFusion: shared.saveFusionChoice'));
  assert.deepEqual(violations, ['selectFusion']);
});

for (const snippet of ['stores.acpObservation.seq++;', 'stores.acpObservation.seq += 1;', 'delete stores.acpObservation.seq;']) {
  test(`the store writer guard rejects '${snippet}'`, () => {
    const target = path.join(srcRoot, 'activation', 'catalog-sync.cjs');
    const violations = storeWriterViolations(file => path.resolve(file) === target
      ? fs.readFileSync(file, 'utf8') + '\n' + snippet + '\n'
      : fs.readFileSync(file, 'utf8'));
    assert.ok(violations.includes('acpObservation.seq <- activation/catalog-sync.cjs'),
      snippet + ' must be reported');
  });
}

for (const snippet of ['shared.backendStatus++;', 'shared.backendStatus += 1;', 'delete shared.backendStatus;']) {
  test(`the shared writer guard rejects '${snippet}'`, () => {
    const target = path.join(srcRoot, 'activation', 'catalog-sync.cjs');
    const violations = sharedWriterViolations(file => path.resolve(file) === target
      ? fs.readFileSync(file, 'utf8') + '\n' + snippet + '\n'
      : fs.readFileSync(file, 'utf8'));
    assert.ok(violations.includes('backendStatus <- activation/catalog-sync.cjs, activation/commands.cjs, activation/enable.cjs'),
      snippet + ' must be reported');
  });
}

test('every activation store module stays a zero-dependency leaf', () => {
  const graph = createSourceGraph();
  for (const entry of [...filesUnder(path.join('activation', 'stores')), path.join('activation', 'managed-settings.cjs')]) {
    assert.deepEqual(closureOf(graph, entry), [entry],
      entry + ' must not require repository modules or vscode');
    assert.deepEqual(graph.depsOf(path.join(srcRoot, entry), { tolerateDynamic: true }).deps, [],
      entry + ' must not require anything, not even builtins');
  }
});

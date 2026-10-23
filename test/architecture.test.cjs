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

const closureRel = (graph, entry) =>
  new Set([...graph.closure(path.join(srcRoot, entry))].map(file => path.relative(srcRoot, file)));
const relPath = (...parts) => path.join(...parts);
const UPDATE_TRANSPORT = [relPath('update', 'proxy-transport.cjs'), relPath('update', 'download.cjs')];

// Layering policy for everything outside the backend: the shared direct
// transport must never reach the GitHub-only update internals, model discovery
// must not pull the update stack or the compatibility facade, and the panel's
// proxy-config dependency must stay a leaf.
const LAYERING = [
  { entry: relPath('network', 'direct-fetch.cjs'),
    banned: file => file === 'proxy.cjs' || file.startsWith('update' + path.sep) },
  { entry: relPath('network', 'client-request.cjs'),
    banned: file => file === 'proxy.cjs' || file.startsWith('update' + path.sep) },
  { entry: relPath('models', 'discovery.cjs'),
    banned: file => file === 'proxy.cjs' || file.startsWith('update' + path.sep) },
  { entry: relPath('panel', 'manager.cjs'),
    banned: file => file === 'proxy.cjs' || UPDATE_TRANSPORT.includes(file) },
  { entry: relPath('panel', 'panel-state.cjs'),
    banned: file => file === 'proxy.cjs' || UPDATE_TRANSPORT.includes(file) ||
      file === relPath('network', 'direct-fetch.cjs') },
  { entry: relPath('update', 'proxy-config.cjs'),
    banned: file => file !== relPath('update', 'proxy-config.cjs') },
];
function layeringViolations(graph) {
  const violations = [];
  for (const { entry, banned } of LAYERING)
    for (const file of closureRel(graph, entry)) if (banned(file)) violations.push(entry + ' -> ' + file);
  return violations;
}

test('the network/update layering keeps transports and the panel config isolated', () => {
  const graph = createSourceGraph();
  assert.deepEqual(layeringViolations(graph), []);
  assert.ok(closureRel(graph, 'models/discovery.cjs').has(relPath('network', 'direct-fetch.cjs')),
    'discovery uses the direct transport at its new path');
  for (const entry of ['panel/manager.cjs', 'panel/panel-state.cjs'])
    assert.ok(closureRel(graph, entry).has(relPath('update', 'proxy-config.cjs')),
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

const injectedLayeringGraph = (patched, specifier) => {
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
  { patched: relPath('network', 'direct-fetch.cjs'), specifier: '../update/download.cjs', expect: relPath('update', 'download.cjs') },
  { patched: relPath('network', 'client-request.cjs'), specifier: '../update/url-policy.cjs', expect: relPath('update', 'url-policy.cjs') },
  { patched: relPath('models', 'discovery.cjs'), specifier: '../proxy.cjs', expect: 'proxy.cjs' },
  { patched: relPath('panel', 'panel-state.cjs'), specifier: '../update/download.cjs', expect: relPath('update', 'download.cjs') },
  { patched: relPath('update', 'proxy-config.cjs'), specifier: '../network/direct-fetch.cjs', expect: relPath('network', 'direct-fetch.cjs') },
]) {
  test(`the layering guard rejects an injected ${patched} -> ${expect} edge`, () => {
    const violations = layeringViolations(injectedLayeringGraph(patched, specifier));
    assert.ok(violations.includes(patched + ' -> ' + expect),
      'the injected edge must be reported from its own entry, not via another module that reaches it');
  });
}

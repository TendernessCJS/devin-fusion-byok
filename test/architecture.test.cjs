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
  'models/discovery.cjs', 'models/discovery-error.cjs', 'update.cjs',
  'extension.cjs',
];
const BACKEND_RUNTIME_ROOT = [
  'backend.cjs', 'backend-control.cjs', 'bridge.cjs', 'contract.cjs',
  'native-cache.cjs', 'port.cjs', 'source-identity.cjs', 'upstream-origin.cjs',
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

test('no src file may name devin.reloadAcpConnections', () => {
  // The command drops every ACP connection on execution — users see "ACP
  // connection closed" and a window reload follows by ~5-35s (observed
  // 2026-10-14). The picker stays correct through the in-place CLI cache
  // rewrite, so nothing may ever call it.
  for (const file of srcFiles()) {
    assert.equal(fs.readFileSync(file, 'utf8').includes('reloadAcpConnections'), false,
      rel(file) + ' must not invoke the connection-killing picker refresh command');
  }
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
    .filter(file => file !== DISCOVERY && file.startsWith('update' + path.sep))
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
  { patched: path.join('network', 'direct-fetch.cjs'), specifier: '../update/proxy-transport.cjs', expect: path.join('update', 'proxy-transport.cjs') },
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

test('the discovery guard rejects an injected discovery -> update/proxy-config.cjs edge', () => {
  const overlay = injectedGraph(DISCOVERY, '../update/proxy-config.cjs');
  // The point is that the violation is reported from discovery's own entry.
  assert.ok(discoveryViolations(overlay).includes(DISCOVERY + ' -> ' + path.join('update', 'proxy-config.cjs')),
    'discovery reaching an update module must be reported from its own entry');
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

// The per-activation refactor removed the shared service locator entirely:
// service state lives inside each factory and cross-service access goes
// through named interfaces only. `shared`/`stores` identifiers and
// `deps.stores` access must not reappear in activation code — this is a shape
// guard (comments are stripped first, so prose keeps its history), not a
// claim that encapsulation is fully enforced at runtime.
const activationFiles = () => [
  path.join(srcRoot, 'extension.cjs'),
  ...fs.readdirSync(path.join(srcRoot, 'activation')).filter(name => name.endsWith('.cjs'))
    .map(name => path.join(srcRoot, 'activation', name)),
];
// Masks comments and string/template literal *text* with spaces so the guard
// only ever sees executable code. Template `${}` interpolation contents are
// real code and stay unmasked (nested templates/strings handled by the same
// scanner); blanking preserves newlines for stable positions. This is a
// lexical mask, not full JS parsing — a regex literal whose pattern contains
// a scanned word would still count as code (no activation source has one).
const maskNonCode = source => {
  // Split on UTF-16 code units so indexes line up with indexOf's offsets —
  // a non-BMP character must not shift the mask window.
  const chars = source.split('');
  const blank = (from, to) => { for (let i = from; i < to; i++) if (chars[i] !== '\n') chars[i] = ' '; };
  const scanQuoted = (i, quote) => {
    let j = i + 1;
    while (j < chars.length) {
      if (chars[j] === '\\') { j += 2; continue; }
      if (chars[j] === quote) { j += 1; break; }
      j += 1;
    }
    blank(i, j);
    return j;
  };
  const scanBraced = i => {
    // i sits just past '${'; returns the index just past its matching '}'.
    // The expression is code, so strings/comments/templates inside it get the
    // same masking while braces keep counting.
    let depth = 1;
    let j = i;
    while (j < chars.length && depth > 0) {
      const c = chars[j];
      if (c === '/' && chars[j + 1] === '/') { const end = source.indexOf('\n', j); blank(j, end === -1 ? chars.length : end); j = end === -1 ? chars.length : end; continue; }
      if (c === '/' && chars[j + 1] === '*') { const end = source.indexOf('*/', j + 2); blank(j, end === -1 ? chars.length : end + 2); j = end === -1 ? chars.length : end + 2; continue; }
      if (c === "'" || c === '"') { j = scanQuoted(j, c); continue; }
      if (c === '`') { j = scanTemplate(j); continue; }
      if (c === '{') depth += 1;
      if (c === '}') depth -= 1;
      j += 1;
    }
    return j;
  };
  const scanTemplate = i => {
    // Literal text is masked; each ${...} switches back to code scanning.
    let segment = i;
    let j = i + 1;
    while (j < chars.length) {
      if (chars[j] === '\\') { j += 2; continue; }
      if (chars[j] === '`') { blank(segment, j + 1); return j + 1; }
      if (chars[j] === '$' && chars[j + 1] === '{') {
        blank(segment, j + 2);
        j = scanBraced(j + 2);
        segment = j;
        continue;
      }
      j += 1;
    }
    blank(segment, j);
    return j;
  };
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === '/' && chars[i + 1] === '/') { const end = source.indexOf('\n', i); blank(i, end === -1 ? chars.length : end); i = end === -1 ? chars.length : end; continue; }
    if (c === '/' && chars[i + 1] === '*') { const end = source.indexOf('*/', i + 2); blank(i, end === -1 ? chars.length : end + 2); i = end === -1 ? chars.length : end + 2; continue; }
    if (c === "'" || c === '"') { i = scanQuoted(i, c); continue; }
    if (c === '`') { i = scanTemplate(i); continue; }
    i += 1;
  }
  return chars.join('');
};
const sharedContainerViolations = (readFile = fs.readFileSync) => {
  const violations = [];
  for (const file of activationFiles()) {
    const label = path.relative(srcRoot, file).split(path.sep).join('/');
    const source = maskNonCode(readFile(file, 'utf8'));
    for (const match of source.matchAll(/\bshared\b|\bstores\b/g)) violations.push(`${label}: ${match[0]}`);
  }
  return violations;
};

const reverted = (from, to) => file => fs.readFileSync(file, 'utf8').replace(from, to);

test('activation code contains no shared or stores container access', () => {
  assert.deepEqual(sharedContainerViolations(), [],
    'service state is private to each factory; cross-service access goes through named interfaces');
});

test('the no-shared-container guard rejects an injected shared access', () => {
  const violations = sharedContainerViolations(reverted(
    'onPublish: () => panel.publish()',
    'onPublish: () => shared.publish()'));
  assert.ok(violations.some(entry => entry.includes('shared')),
    'a shared container access must be reported');
});

test('the no-shared-container guard rejects a deps.stores access', () => {
  const violations = sharedContainerViolations(reverted(
    'onPublish: () => panel.publish()',
    'onPublish: () => deps.stores.panel.publish()'));
  assert.ok(violations.some(entry => entry.includes('stores')),
    'a deps.stores access must be reported');
});

test('the guard sees shared access past a URL string on the same line', () => {
  const violations = sharedContainerViolations(reverted(
    "expectedEnv: 'http://127.0.0.1:' + PORT,",
    "expectedEnv: ('http://127.0.0.1:' + PORT + shared.port),"));
  assert.ok(violations.some(entry => entry.includes('shared')),
    'a shared access after a // inside a string must be reported');
});

test('the guard ignores shared inside string literals', () => {
  const violations = sharedContainerViolations(reverted(
    "expectedEnv: 'http://127.0.0.1:' + PORT,",
    "expectedEnv: 'shared',"));
  assert.deepEqual(violations, [], 'a bare word inside a string is not a container access');
});

test('the guard ignores template text but sees interpolations', () => {
  const staticText = sharedContainerViolations(reverted(
    'onPublish: () => panel.publish()',
    'onPublish: () => panel.publish(`shared`)'));
  assert.deepEqual(staticText, [], 'template literal text is not code');
  const interpolated = sharedContainerViolations(reverted(
    'onPublish: () => panel.publish()',
    'onPublish: () => panel.publish(`${shared.port}`)'));
  assert.ok(interpolated.some(entry => entry.includes('shared')),
    'an interpolated shared access must be reported');
});

test('the masker keeps indexes aligned across non-BMP characters', () => {
  // A surrogate pair would shift a codepoint-based char array relative to
  // indexOf's UTF-16 offsets, letting later code escape the mask.
  const violations = sharedContainerViolations(reverted(
    'onPublish: () => panel.publish()',
    "onPublish: () => { const note = '😀'; /* note */ return shared.publish(); }"));
  assert.ok(violations.some(entry => entry.includes('shared')),
    'a shared access after an emoji string and block comment must be reported');
  const lineComment = sharedContainerViolations(reverted(
    'onPublish: () => panel.publish()',
    "onPublish: () => { const note = '😀'; // note\n  return shared.publish(); }"));
  assert.ok(lineComment.some(entry => entry.includes('shared')),
    'a shared access after an emoji string and line comment must be reported');
});

test('every activation store module stays a zero-dependency leaf', () => {
  const graph = createSourceGraph();
  for (const entry of [...filesUnder(path.join('activation', 'stores')), path.join('activation', 'managed-settings.cjs')]) {
    assert.deepEqual(closureOf(graph, entry), [entry],
      entry + ' must not require repository modules or vscode');
    assert.deepEqual(graph.depsOf(path.join(srcRoot, entry), { tolerateDynamic: true }).deps, [],
      entry + ' must not require anything, not even builtins');
  }
});

test('the backend source hash never absorbs host-side activation modules', () => {
  const files = require('../src/runtime/source-identity.cjs').deriveSourceFiles();
  assert.ok(!files.some(file => file.split(path.sep).join('/').includes('activation/')),
    'activation/ files are host-side; host-build.json tracks them separately');
});

test('host-identity.cjs requires no repository module', () => {
  const graph = createSourceGraph();
  assert.deepEqual(closureOf(graph, path.join('activation', 'host-identity.cjs')),
    [path.join('activation', 'host-identity.cjs')],
    'node builtins are allowed; repository modules would leak host paths into other closures');
});

// The ingest body limit must trip while collect() is still pulling the stream;
// a bare collect(request) buffers up to the 64 MiB default before checking.
const collectLimitViolations = source => {
  const violations = [];
  if (!/collect\(\s*request\s*,\s*MAX_BODY_BYTES\s*\)/.test(source)) violations.push('collect is not bounded by MAX_BODY_BYTES');
  if (/collect\(\s*request\s*\)/.test(source)) violations.push('bare collect(request)');
  return violations;
};

test('the native ingest body limit is enforced during collection', () => {
  const source = fs.readFileSync(path.join(srcRoot, 'runtime', 'backend-control.cjs'), 'utf8');
  assert.deepEqual(collectLimitViolations(source), [],
    'the 4 MiB limit must apply while collecting, or up to 64 MiB is buffered first');
});

test('the collect limit guard rejects a reverted bare collect', () => {
  const source = fs.readFileSync(path.join(srcRoot, 'runtime', 'backend-control.cjs'), 'utf8')
    .replace('collect(request, MAX_BODY_BYTES)', 'collect(request)');
  assert.ok(collectLimitViolations(source).length > 0,
    'a bare collect(request) must be reported');
});

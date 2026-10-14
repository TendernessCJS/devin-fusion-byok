'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const filename = path.resolve(__dirname, '../src/extension.cjs');
const realRequire = createRequire(filename);
const actualBackend = require('../src/runtime/backend.cjs');
const { RECEIPT } = require('../src/lifecycle/owned-settings.cjs');
const next = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, initial = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-extension-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'User/globalStorage/local.devin-fusion-byok'), extensionPath = path.join(directory, 'extension');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(extensionPath);
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ enabled: true, providers: [{ id: 'cpa', name: 'CPA', models: [] }], ...initial.config }));
  const globals = { agentEnv: { 'devin-cli': { KEEP: 'user-value' } }, agentPreferences: { 'devin-cli': { model: 'native-max', effort: 'high' } }, ...initial.globals };
  const state = new Map(Object.entries(initial.state || {})), commands = new Map(), logs = [], notices = [], watchers = [], preferenceListeners = [];
  const updates = [], bridges = [];
  let disposed = 0, installed = 0, managerOptions, autoContinueOptions, warningResult;
  const cacheChecks = [];
  const settings = {
    inspect: key => ({ globalValue: globals[key] }),
    get: () => { throw new Error('Merged workspace settings must not be copied into global settings'); },
    update: async (key, value) => { assert.ok(fs.existsSync(path.join(root, RECEIPT))); globals[key] = value; updates.push(key); },
  };
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    workspace: { getConfiguration: () => settings,
      onDidChangeConfiguration: fn => { preferenceListeners.push(fn); return { dispose() {} }; } },
    extensions: { getExtension: () => ({ extensionPath: '/native', packageJSON: { main: 'main.js', version: 'test' } }) },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; } },
    window: {
      createOutputChannel: () => ({ appendLine: value => logs.push(value), show() {}, dispose() {} }),
      showInformationMessage: text => notices.push(text), showErrorMessage: text => notices.push(text),
      showWarningMessage: text => { notices.push(text); return warningResult; },
      showQuickPick: async choices => choices[0],
    },
  };
  const identity = { service: 'devin-fusion-byok', version: '0.2.0', sourceId: 'expected', rootId: 'root' };
  const spawns = [];
  let fetchImpl = async () => new Response(JSON.stringify({ ...identity, draining: false }));
  let injectionGate = null;
  let nativeRead = async () => ({ status: 'empty', models: [] });
  const pushes = [];
  let pushResult = { pushed: 0, reason: 'empty' };
  let matrixUids = new Set(), extraCatalogModels = [];
  const overrides = {
    vscode,
    'node:fs': { ...fs, watchFile: (_file, _options, callback) => watchers.push(callback), unwatchFile: () => {} },
    'node:child_process': { spawn: (file, args, options) => {
      spawns.push({ file, args, options });
      const child = new EventEmitter(); child.unref = () => {};
      return child;
    } },
    './config.cjs': {
      readConfig: file => JSON.parse(fs.readFileSync(file, 'utf8')),
      writeConfig: (file, value) => fs.writeFileSync(file, JSON.stringify(value)),
      defaultConfig: realRequire('./config.cjs').defaultConfig,
      pruneRetiredKeys: realRequire('./config.cjs').pruneRetiredKeys, discover: async () => 2,
    },
    './catalog.cjs': { migrateFusionConfig: () => false, staleFusionUids: () => [],
      buildCatalog: config => ({ models: config.providers?.length
        ? [{ uid: 'dfbyok-own', label: 'own', kind: 'model' },
          { uid: 'fusion-dfbyok-selected', label: 'CPA Fusion', kind: 'matrix' },
          { uid: 'fusion-dfbyok-another', label: 'CPA Fusion Alt', kind: 'matrix' }, ...extraCatalogModels] : [],
      fusions: config.providers?.length ? { 'fusion-dfbyok-selected': { label: 'CPA Fusion' }, 'fusion-dfbyok-another': { label: 'CPA Fusion Alt' } } : {},
      lastFusionSelection: config.lastFusionSelection, matrixUids }) },
    './runtime/native-models.cjs': { readNativeModels: options => nativeRead(options),
      isUpstreamUid: realRequire('./runtime/native-models.cjs').isUpstreamUid,
      pushNativeModels: options => { pushes.push(options); return Promise.resolve(pushResult); } },
    './runtime/goal-continue.cjs': { installGoalContinue: () => null },
    './runtime/auto-continue.cjs': { installAutoContinue: options => { autoContinueOptions = options;
      return { status: () => ({}), reset() {}, cancelSession: () => false, dispose() {} }; } },
    './runtime/acp-observer.cjs': { installAcpObserver: () => ({ dispose() {} }) },
    './runtime/backend.cjs': { runtimeIdentity: () => identity, controlFile: actualBackend.controlFile, PORT: 39842, MANAGEMENT_PROTOCOL: 1 },
    './runtime/bridge.cjs': { createLsBridge: async (_port, options) => { bridges.push(options); return { port: 4567, close() {} }; } },
    './runtime/ls-injection.cjs': { installLsInjection: async options => {
      installed++; await options.createBridge(1234);
      if (injectionGate) { const gate = injectionGate; injectionGate = null; await gate; }
      return { status: { state: 'ready' }, dispose: async () => { disposed++; } };
    } },
    './panel/model.cjs': { ...realRequire('./panel/model.cjs'), createManager: options => {
      managerOptions = options;
      return realRequire('./panel/model.cjs').createManager(options);
    } },
    './runtime/cli-cache.cjs': { CACHE_NAME: /(?:)/, defaultDir: () => '/nonexistent-test-cli-cache',
      inspectCliCaches: () => ({ checked: 0, entries: [], expected: [] }),
      refreshStaleCliCaches: options => { cacheChecks.push(options); return { checked: options.expectedUids.length, refreshed: [], skipped: [], errors: [] }; } },
  };
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, process,
    AbortController, AbortSignal, setInterval, clearInterval, setTimeout: (fn, _ms) => setTimeout(fn, 0), clearTimeout,
    fetch: (...args) => fetchImpl(...args),
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name),
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  // Realm boundaries break instanceof inside the sandboxed module, so the
  // matrix uid set must be built with the sandbox realm's Set constructor.
  const vmSet = vm.runInNewContext('Set', sandbox);
  const context = { globalStorageUri: { fsPath: root }, extensionPath, subscriptions: [],
    globalState: { get: (key, fallback) => state.has(key) ? state.get(key) : fallback, update: async (key, value) => value === undefined ? state.delete(key) : state.set(key, value) } };
  t.after(async () => { await module.exports.deactivate(); context.subscriptions.forEach(value => value.dispose()); });
  return { ...module.exports, context, root, configFile, globals, state, commands, logs, notices, watchers, updates, bridges,
    preferenceListeners, managerOptions: () => managerOptions, spawns, autoContinueOptions: () => autoContinueOptions,
    setFetch: impl => { fetchImpl = impl; },
    setNativeRead: impl => { nativeRead = impl; },
    pushes: () => pushes,
    setPushResult: value => { pushResult = value; },
    setMatrixUids: uids => { matrixUids = new vmSet(uids); },
    setCatalogModels: models => { extraCatalogModels = models; },
    gateInjection: () => { let release; injectionGate = new Promise(resolve => { release = resolve; }); return release; },
    setWarningResult: value => { warningResult = value; },
    firePreference: (key = 'devin.acp.agentPreferences') => Promise.all(preferenceListeners.map(fn => fn({ affectsConfiguration: name => name === key }))),
    cacheChecks: () => cacheChecks,
    settle: async (ticks = 20) => { for (let index = 0; index < ticks; index++) await next(); },
    counts: () => ({ installed, disposed }) };
}
test('normal window unload restores its LS hook without reverting shared CLI environment', async t => {
  const f = fixture(t); await f.activate(f.context);
  assert.equal(f.counts().installed, 1);
  await f.deactivate();
  assert.equal(f.counts().disposed, 1);
  assert.equal(f.globals.agentEnv['devin-cli'].WINDSURF_API_SERVER_URL, 'http://127.0.0.1:39842');
  assert.equal(f.globals.agentEnv['devin-cli'].KEEP, 'user-value');
  assert.ok(!f.logs.some(line => line.includes('error')));
});
test('explicit disable restores owned env and any own Fusion selection, preserving native preference fields', async t => {
  const f = fixture(t); await f.activate(f.context);
  await f.commands.get('devinFusionByok.selectFusion')();
  f.globals.agentPreferences['devin-cli'].model = 'fusion-dfbyok-native-sidekick';
  await f.commands.get('devinFusionByok.disable')();
  assert.equal(f.counts().disposed, 1);
  assert.ok(!Object.hasOwn(f.globals.agentEnv['devin-cli'], 'WINDSURF_API_SERVER_URL'));
  assert.equal(f.globals.agentEnv['devin-cli'].KEEP, 'user-value');
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'native-max');
  assert.equal(f.globals.agentPreferences['devin-cli'].effort, 'high');
  assert.equal(f.state.has('savedEnv'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, RECEIPT))).changes.length, 0);
});
test('disable preserves subsequent user choices for native model and server URL', async t => {
  const f = fixture(t); await f.activate(f.context); await f.commands.get('devinFusionByok.selectFusion')();
  f.globals.agentPreferences['devin-cli'].model = 'gpt-native-chosen';
  f.globals.agentEnv['devin-cli'].WINDSURF_API_SERVER_URL = 'https://user.example';
  await f.commands.get('devinFusionByok.disable')();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'gpt-native-chosen');
  assert.equal(f.globals.agentEnv['devin-cli'].WINDSURF_API_SERVER_URL, 'https://user.example');
});
test('another window disabling stops catalog injection immediately and releases the hook on file notification', async t => {
  const f = fixture(t); await f.activate(f.context);
  assert.equal(f.bridges[0].getCatalog().models.length, 3);
  const config = JSON.parse(fs.readFileSync(f.configFile)); config.enabled = false; fs.writeFileSync(f.configFile, JSON.stringify(config));
  assert.equal(f.bridges[0].getCatalog().models.length, 0);
  f.watchers[0](); await next();
  assert.equal(f.counts().disposed, 1);
});
test('refreshing models while disabled does not re-enable routing', async t => {
  const f = fixture(t, { config: { enabled: false } }); await f.activate(f.context);
  await f.commands.get('devinFusionByok.refreshModels')();
  assert.equal(f.counts().installed, 0);
  assert.deepEqual(f.updates, []);
  assert.equal(JSON.parse(fs.readFileSync(f.configFile)).enabled, false);
});
test('legacy env originals migrate without mutating frozen configuration values', async t => {
  const nativeEnv = Object.freeze({ WINDSURF_API_SERVER_URL: 'http://127.0.0.1:39842', HTTPS_PROXY: 'http://legacy-proxy', KEEP: 'keep' });
  const f = fixture(t, { globals: { agentEnv: Object.freeze({ 'devin-cli': nativeEnv }) },
    state: { managedEnv: { WINDSURF_API_SERVER_URL: 'http://127.0.0.1:39842', HTTPS_PROXY: 'http://legacy-proxy' },
      savedEnv: { WINDSURF_API_SERVER_URL: 'https://before-plugin.example', HTTPS_PROXY: null } } });
  await f.activate(f.context);
  assert.equal(f.globals.agentEnv['devin-cli'].HTTPS_PROXY, undefined);
  await f.commands.get('devinFusionByok.disable')();
  assert.equal(f.globals.agentEnv['devin-cli'].WINDSURF_API_SERVER_URL, 'https://before-plugin.example');
  assert.equal(nativeEnv.HTTPS_PROXY, 'http://legacy-proxy');
});
test('an official Fusion selection is respected while our remembered choice stays on record', async t => {
  const f = fixture(t, { config: { lastFusionSelection: 'fusion-dfbyok-selected' },
    globals: { agentPreferences: { 'devin-cli': { model: 'fusion-official-claude', effort: 'high' } } } });
  await f.activate(f.context);
  // The official card's own combinations are legitimate: rewriting them would
  // silently undo what the user (or Devin) chose.
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-official-claude');
  assert.equal(f.globals.agentPreferences['devin-cli'].effort, 'high');
  assert.equal(JSON.parse(fs.readFileSync(f.configFile)).lastFusionSelection, 'fusion-dfbyok-selected',
    'the remembered combination survives as the locked-fallback target');
  assert.equal(f.updates.includes('agentPreferences'), false, 'accepting an official selection writes nothing');
});
test('an official selection mid-session is never rewritten and causes no write loop', async t => {
  const f = fixture(t, { config: { lastFusionSelection: 'fusion-dfbyok-selected' } });
  await f.activate(f.context);
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'native-max');
  for (const official of ['fusion-official-claude', 'fusion-official', 'fusion-claude-fable-5-1-medium-sidekick-swe-2-medium']) {
    f.globals.agentPreferences['devin-cli'].model = official;
    const writes = f.updates.length;
    await f.firePreference();
    await f.settle();
    assert.equal(f.globals.agentPreferences['devin-cli'].model, official);
    assert.equal(f.updates.length, writes, 'an official selection triggers no preference write');
  }
  assert.equal(JSON.parse(fs.readFileSync(f.configFile)).lastFusionSelection, 'fusion-dfbyok-selected');
});
test('plain native and plain own model selections are never overwritten', async t => {
  const f = fixture(t, { config: { lastFusionSelection: 'fusion-dfbyok-selected' } });
  await f.activate(f.context);
  for (const plain of ['native-max', 'dfbyok-plain-model', 'swe-2-max']) {
    f.globals.agentPreferences['devin-cli'].model = plain;
    const writes = f.updates.length;
    await f.firePreference();
    await f.settle();
    assert.equal(f.globals.agentPreferences['devin-cli'].model, plain);
    assert.equal(f.updates.length, writes);
  }
});
test('a stale or absent remembered combination never replaces an official or missing selection', async t => {
  for (const config of [{ lastFusionSelection: 'fusion-dfbyok-removed' }, { providers: [], lastFusionSelection: 'fusion-dfbyok-selected' }, {}]) {
    const f = fixture(t, { config, globals: { agentPreferences: { 'devin-cli': { model: 'fusion-official' } } } });
    await f.activate(f.context);
    await f.firePreference();
    await f.settle();
    assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-official');
  }
});
test('activation prunes retired config keys without touching preset keys', async t => {
  const f = fixture(t, { config: { sidekicks: [], roleExclusions: { lead: [], sidekick: [] },
    fusionPresets: [{ id: 'p1', name: 'P1' }] } });
  await f.activate(f.context);
  const written = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
  assert.ok(!Object.hasOwn(written, 'sidekicks'), 'retired sidekicks key is pruned');
  assert.ok(!Object.hasOwn(written, 'roleExclusions'), 'empty role maps are pruned');
  assert.ok(Object.hasOwn(written, 'fusionPresets'), 'preset data is never pruned');
});
test('cli cache checks are confined to the stubbed directory and see every own uid', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  const calls = f.cacheChecks();
  assert.ok(calls.length >= 1, 'activation checks CLI caches at least once');
  for (const call of calls) assert.equal(call.dir, '/nonexistent-test-cli-cache');
  assert.deepEqual(calls[0].expectedUids, ['dfbyok-own', 'fusion-dfbyok-selected', 'fusion-dfbyok-another'],
    'expectedUids is the full model list, unfiltered');
});
test('an idle native sync keeps the same CLI cache report', async t => {
  const f = fixture(t); await f.activate(f.context);
  const options = f.managerOptions();
  await options.refreshNativeModels();
  const first = options.cliCacheStatus();
  assert.ok(first && typeof first.at === 'string', 'the first check records a report');
  await options.refreshNativeModels();
  assert.strictEqual(options.cliCacheStatus(), first,
    'an unchanged check must keep the same report object: a fresh `at` made every 3s tick look like a state change and re-rendered the panel forever');
  assert.ok(f.cacheChecks().length >= 2, 'the cache check still runs on every tick');
});
test('a manual cache refresh always restamps the report', async t => {
  const f = fixture(t); await f.activate(f.context);
  const options = f.managerOptions();
  await options.refreshNativeModels();
  const first = options.cliCacheStatus();
  await options.refreshCliCaches();
  assert.notStrictEqual(options.cliCacheStatus(), first, 'the 刷新缓存 button must show a fresh timestamp');
});
test('a stale matrix fusion selection rolls back while a live one is kept', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  const stale = 'fusion-native-lead-sidekick-dfbyok-gone';
  f.setMatrixUids([stale]);
  f.globals.agentPreferences['devin-cli'].model = stale;
  await f.managerOptions().afterChange('setRoleModel');
  assert.equal(f.globals.agentPreferences['devin-cli'].model, undefined,
    'a matrix uid that is no longer in the catalog is rolled back');
  const live = 'fusion-native-lead-sidekick-dfbyok-live';
  f.setMatrixUids([live]);
  f.setCatalogModels([{ uid: live }]);
  f.globals.agentPreferences['devin-cli'].model = live;
  const writes = f.updates.length;
  await f.managerOptions().afterChange('setRoleModel');
  assert.equal(f.globals.agentPreferences['devin-cli'].model, live, 'a live matrix selection is preserved');
  assert.equal(f.updates.length, writes);
});
test('a saved own Fusion selection is remembered across reload and restores an emptied preference', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  await f.commands.get('devinFusionByok.selectFusion')();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-dfbyok-selected');
  assert.equal(JSON.parse(fs.readFileSync(f.configFile)).lastFusionSelection, 'fusion-dfbyok-selected');
  await f.deactivate();
  // An official selection Devin made meanwhile is left alone...
  f.globals.agentPreferences['devin-cli'].model = 'fusion-official-claude';
  await f.activate(f.context);
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-official-claude');
  // ...but a preference that ends up empty is restored from the memory.
  delete f.globals.agentPreferences['devin-cli'].model;
  await f.firePreference();
  await f.settle();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-dfbyok-selected');
});
test('a remembered combination saved by another window applies on the config notification', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  const current = JSON.parse(fs.readFileSync(f.configFile));
  current.lastFusionSelection = 'fusion-dfbyok-selected';
  fs.writeFileSync(f.configFile, JSON.stringify(current));
  f.globals.agentPreferences['devin-cli'].model = 'fusion-official';
  f.watchers[0]();
  await f.settle();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-official', 'the official selection stands');
  delete f.globals.agentPreferences['devin-cli'].model;
  f.watchers[0]();
  await f.settle();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-dfbyok-selected',
    'the other window memory fills an empty preference');
});
test('preference reconciliation stays inert while disabled and after unload', async t => {
  const f = fixture(t, { config: { enabled: false, lastFusionSelection: 'fusion-dfbyok-selected' },
    globals: { agentPreferences: { 'devin-cli': { model: 'fusion-official' } } } });
  await f.activate(f.context);
  await f.firePreference();
  await f.settle();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-official');
  const enabled = fixture(t, { config: { lastFusionSelection: 'fusion-dfbyok-selected' } });
  await enabled.activate(enabled.context);
  await enabled.deactivate();
  enabled.globals.agentPreferences['devin-cli'].model = 'fusion-official';
  const writes = enabled.updates.length;
  await enabled.firePreference();
  await enabled.settle();
  assert.equal(enabled.globals.agentPreferences['devin-cli'].model, 'fusion-official');
  assert.equal(enabled.updates.length, writes);
});
test('a native preference event with a valid own Fusion records it as the remembered default', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  const writes = () => f.updates.filter(key => key === 'agentPreferences').length;
  f.globals.agentPreferences['devin-cli'].model = 'fusion-dfbyok-selected';
  await f.firePreference();
  assert.equal(JSON.parse(fs.readFileSync(f.configFile)).lastFusionSelection, 'fusion-dfbyok-selected');
  assert.equal(writes(), 0);
  f.globals.agentPreferences['devin-cli'].model = 'fusion-dfbyok-another';
  await f.firePreference();
  assert.equal(JSON.parse(fs.readFileSync(f.configFile)).lastFusionSelection, 'fusion-dfbyok-another');
  delete f.globals.agentPreferences['devin-cli'].model;
  await f.firePreference();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-dfbyok-another');
  await f.firePreference('devin.acp.agentEnv');
  await f.settle();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-dfbyok-another');
});
test('re-enabling from the panel re-arms reconciliation after a disable', async t => {
  const f = fixture(t, { config: { lastFusionSelection: 'fusion-dfbyok-selected' } });
  await f.activate(f.context);
  const { write, afterChange } = f.managerOptions();
  write({ ...JSON.parse(fs.readFileSync(f.configFile)), enabled: false });
  await afterChange('setEnabled');
  assert.equal(f.counts().disposed, 1);
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'native-max');
  write({ ...JSON.parse(fs.readFileSync(f.configFile)), enabled: true });
  await afterChange('setEnabled');
  assert.equal(f.counts().installed, 2);
  // Reconciliation is armed again: an official selection still stands, while an
  // emptied preference is filled from the memory it re-read.
  f.globals.agentPreferences['devin-cli'].model = 'fusion-official-claude';
  await f.firePreference();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-official-claude');
  delete f.globals.agentPreferences['devin-cli'].model;
  await f.firePreference();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-dfbyok-selected');
});

const oldRuntimeHealth = idle => ({ service: 'devin-fusion-byok', version: '0.1.0', sourceId: 'old', rootId: 'root',
  instanceId: 'old-1', managementProtocol: 1, activeRequests: idle ? 0 : 4, draining: false });
const newRuntimeHealth = { service: 'devin-fusion-byok', version: '0.2.0', sourceId: 'expected', rootId: 'root',
  instanceId: 'new-1', managementProtocol: 1, activeRequests: 0, draining: false };
test('a busy older runtime lets activation finish and upgrades in the background once it idles', async t => {
  const f = fixture(t);
  fs.writeFileSync(actualBackend.controlFile(f.root), JSON.stringify({ ...oldRuntimeHealth(true), token: 'b'.repeat(64) }), { mode: 0o600 });
  let busy = true, shutdowns = 0, gone = false;
  f.setFetch(async url => {
    if (url.endsWith('/_runtime/shutdown')) { shutdowns++; return new Response('{"stopping":true}'); }
    if (busy) return new Response(JSON.stringify(oldRuntimeHealth(false)));
    if (shutdowns === 0) return new Response(JSON.stringify(oldRuntimeHealth(true)));
    if (!gone) { gone = true; throw new Error('Connection refused'); }
    return new Response(JSON.stringify(newRuntimeHealth));
  });
  await f.activate(f.context);
  assert.equal(f.counts().installed, 1, 'activation finishes the hook while the old runtime is busy');
  assert.equal(f.logs.filter(line => line.includes('runtime-update-pending')).length, 1);
  assert.ok(f.logs.some(line => line.includes('runtime-update-pending') && line.includes('0.1.0')));
  assert.equal(f.spawns.length, 0);
  assert.equal(shutdowns, 0);
  busy = false;
  await f.settle(80);
  assert.equal(shutdowns, 1);
  assert.equal(f.spawns.length, 1);
  assert.ok(!f.logs.some(line => line.includes('runtime-upgrade-error')));
});
test('unloading while the old runtime stays busy aborts the background upgrade', async t => {
  const f = fixture(t);
  let shutdowns = 0;
  f.setFetch(async url => {
    if (url.endsWith('/_runtime/shutdown')) { shutdowns++; return new Response('{"stopping":true}'); }
    return new Response(JSON.stringify(oldRuntimeHealth(false)));
  });
  await f.activate(f.context);
  assert.equal(f.counts().installed, 1);
  await f.deactivate();
  await f.settle(30);
  assert.equal(f.counts().disposed, 1);
  assert.equal(f.spawns.length, 0);
  assert.equal(shutdowns, 0);
  assert.ok(!f.logs.some(line => line.includes('runtime-upgrade-error')));
});
test('a runtime owned by another storage root fails activation before any hook installs', async t => {
  const f = fixture(t);
  f.setFetch(async () => new Response(JSON.stringify({ ...oldRuntimeHealth(true), rootId: 'other-root' })));
  await f.activate(f.context);
  assert.equal(f.counts().installed, 0);
  assert.equal(f.spawns.length, 0);
  assert.ok(f.logs.some(line => line.includes('different_storage')));
});
test('a cold-start failure still gates activation and installs no hook', async t => {
  const f = fixture(t);
  f.setFetch(async () => { throw new Error('Connection refused'); });
  await f.activate(f.context);
  assert.equal(f.counts().installed, 0);
  assert.equal(f.spawns.length, 1);
  assert.ok(f.logs.some(line => line.includes('startup_failed')));
});
test('another window re-enabling after a shared disable reinstalls the hook exactly once', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  assert.equal(f.counts().installed, 1);
  const current = JSON.parse(fs.readFileSync(f.configFile));
  fs.writeFileSync(f.configFile, JSON.stringify({ ...current, enabled: false }));
  f.watchers[0]();
  await f.settle();
  assert.equal(f.counts().disposed, 1);
  fs.writeFileSync(f.configFile, JSON.stringify({ ...current, enabled: true }));
  f.watchers[0](); f.watchers[0](); f.watchers[0]();
  await f.settle(40);
  assert.equal(f.counts().installed, 2);
  f.watchers[0]();
  await f.settle();
  assert.equal(f.counts().installed, 2);
  assert.equal(f.spawns.length, 0);
});
test('a config notification after unload never resurrects the hook', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  await f.deactivate();
  f.watchers[0]();
  await f.settle();
  assert.equal(f.counts().installed, 1);
  assert.equal(f.counts().disposed, 1);
});
test('native model observations from the bridge reach the panel and hide persists to shared config', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  f.bridges[0].onNativeModels([{ uid: 'swe-2-max', label: 'Official SWE', disabled: false },
    { uid: 'claude-x', label: 'Claude X', disabled: true }]);
  assert.deepEqual(JSON.parse(JSON.stringify(f.managerOptions().nativeModels())), [
    { uid: 'swe-2-max', label: 'Official SWE', disabled: false, isModelRouter: false, harnessUids: [] },
    { uid: 'claude-x', label: 'Claude X', disabled: true, isModelRouter: false, harnessUids: [] }]);
  const manager = realRequire('./panel/model.cjs').createManager(f.managerOptions());
  const state = await manager.dispatch('setNativeModelHidden', { uid: 'swe-2-max', hidden: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile)).hiddenNativeModelUids, ['swe-2-max']);
  assert.equal(state.nativeModels.find(entry => entry.uid === 'swe-2-max').hidden, true);
});

test('unloading while LS injection is deferred disposes the late connection instead of resurrecting it', async t => {
  const f = fixture(t);
  const release = f.gateInjection();
  const activation = f.activate(f.context);
  await f.settle(40);
  assert.equal(f.counts().installed, 1, 'injection started but has not resolved');
  assert.equal(f.counts().disposed, 0);
  await f.deactivate();
  release();
  await activation;
  await f.settle(10);
  assert.equal(f.counts().disposed, 1, 'the deferred connection is disposed, never assigned');
  f.watchers[0]();
  await f.settle();
  assert.equal(f.counts().installed, 1, 'no resurrection after unload');
});

test('backend sync hydrates the actual extension manager without LS observations and replaces empty snapshots', async t => {
  const f = fixture(t);
  const record = { uid: 'swe-2-high', label: 'SWE-2 High', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] };
  const official = { uid: 'fusion-lead-a-sidekick-swe-2-high', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'],
    sidekickDimension: { order: 2, name: 'SWE-2 High' } };
  f.setNativeRead(async () => ({ status: 'ready', models: [record, official] }));
  await f.activate(f.context); await f.settle();
  const manager = realRequire('./panel/model.cjs').createManager(f.managerOptions());
  const state = await manager.dispatch('ready');
  assert.equal(state.nativeCatalogStatus, 'ready');
  const sweRow = state.nativeModels.find(m => m.uid === record.uid);
  assert.ok(sweRow);
  assert.equal(sweRow.eligible, true);
  f.setNativeRead(async () => ({ status: 'empty', models: [] }));
  assert.equal((await manager.dispatch('refreshNativeModels')).nativeModels.length, 0);
});

test('late backend sync cannot publish after unload', async t => {
  const f = fixture(t); let release;
  f.setNativeRead(() => new Promise(resolve => { release = resolve; }));
  await f.activate(f.context); await f.settle();
  await f.deactivate();
  release({ status: 'ready', models: [{ uid: 'late', label: 'Late', disabled: false, isModelRouter: false, harnessUids: [] }] });
  await f.settle();
  assert.equal(f.managerOptions().nativeModels().length, 0);
});
test('auto-continue exhaustion surfaces a Chinese warning without sensitive data', async t => {
  const f = fixture(t); await f.activate(f.context);
  const options = f.autoContinueOptions();
  assert.equal(typeof options?.onStopped, 'function', 'the extension wires a stop callback');
  options.onStopped({ reason: 'error-attempt-limit', attempts: 5 });
  await f.settle();
  const notice = f.notices.at(-1);
  assert.match(notice, /自动继续/);
  assert.match(notice, /手动继续/);
  assert.doesNotMatch(notice, /s-cap|apiKey|token|标题/i);
});
test('the stop callback returns the warning promise so rejections stay contained by the caller', async t => {
  const f = fixture(t);
  f.setWarningResult(Promise.reject(new Error('toast failed')));
  await f.activate(f.context);
  const options = f.autoContinueOptions();
  const result = options.onStopped({ reason: 'error-attempt-limit', attempts: 5 });
  assert.ok(result instanceof Promise, 'the callback returns the warning promise rather than swallowing it');
  await assert.rejects(result, /toast failed/);
  assert.match(f.notices.at(-1), /自动继续/);
});
test('a poorer backend sync never downgrades the richer bridge observation', async t => {
  const uid = 'fusion-live-sidekick-swe-2-high';
  const rich = { uid, label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'],
    sidekickDimension: { order: 2, name: 'SWE-2 High', fastModeOrder: 0 },
    fusionMetadata: [{ key: 'Sidekick', order: 2, name: 'SWE-2 High', controlType: 3 }] };
  const poor = { uid, label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'] };
  const f = fixture(t);
  f.setNativeRead(async () => ({ status: 'ready', models: [poor] }));
  await f.activate(f.context);
  await f.settle();
  f.bridges.at(-1).onNativeModels([rich]);
  await f.settle();
  // The extension runs in a separate realm, so its objects never share a
  // prototype with the test's: compare serialized values.
  const find = () => JSON.parse(JSON.stringify(f.managerOptions().nativeModels().find(entry => entry.uid === uid) || null));
  assert.deepEqual(find().sidekickDimension, rich.sidekickDimension, 'the bridge observation carried the dimensions');
  // The backend observes the CLI side of the same catalog, whose copy can lack
  // the Fusion family metadata. Letting it win would make every native Sidekick
  // unresolvable, so the mirrored combinations disappear and are then reported
  // unemitted and deleted from the CLI cache.
  await f.managerOptions().refreshNativeModels();
  await f.settle();
  assert.deepEqual(find().sidekickDimension, rich.sidekickDimension, 'the sync kept the richer copy');
  assert.deepEqual(find().fusionMetadata, rich.fusionMetadata);
  assert.equal(find().disabled, false);
  // A genuine capability change still lands, so the merge never hides state.
  f.setNativeRead(async () => ({ status: 'ready', models: [{ ...poor, disabled: true }] }));
  await f.managerOptions().refreshNativeModels();
  await f.settle();
  assert.equal(find().disabled, true, 'fresher scalar fields are not masked');
  assert.deepEqual(find().sidekickDimension, rich.sidekickDimension, 'and the dimensions survive it');
});
// The push runs on a real timer, so settling by microtask/setImmediate rounds is
// not enough to observe it: wait for the effect with a deadline instead of
// assuming a tick count.
const waitFor = async (check, ms = 1000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return check();
};

test('the host pushes its richer observations to the backend once they grow', async t => {
  const f = fixture(t);
  f.setNativeRead(async () => ({ status: 'ready', models: [{ uid: 'swe-2-high', label: 'P', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] }] }));
  await f.activate(f.context);
  assert.ok(await waitFor(() => f.pushes().length >= 1), 'activation already offers what it has');
  const first = f.pushes().length;
  // The payload crosses the sandbox realm, so compare serialized values.
  const offered = JSON.parse(JSON.stringify(f.pushes().at(-1).models));
  assert.deepEqual(offered.map(entry => entry.uid), ['swe-2-high']);
  assert.equal(f.pushes().at(-1).root, f.root);

  // A richer bridge observation must be offered again, and it is the union that
  // travels: the backend only sees the CLI side of the catalog, so whatever the
  // native extension revealed has to come through here.
  f.bridges.at(-1).onNativeModels([{ uid: 'swe-2-high', label: 'P', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'],
    sidekickDimension: { order: 2, name: 'SWE-2 High', fastModeOrder: 0 } }]);
  assert.ok(await waitFor(() => f.pushes().length > first), 'a richer observation is offered too');
  const latest = JSON.parse(JSON.stringify(f.pushes().at(-1).models)).find(entry => entry.uid === 'swe-2-high');
  assert.deepEqual(latest.sidekickDimension, { order: 2, name: 'SWE-2 High', fastModeOrder: 0 });

  // A steady state stops sending: the same key must not keep pushing forever.
  const settled = f.pushes().length;
  // Drive refreshes with the same observation set: without the "unchanged view
  // is not re-sent" gate each one schedules another push, so the window has to
  // outlast the 5s throttle for the assertion to mean anything.
  for (let i = 0; i < 3; i++) await f.managerOptions().refreshNativeModels();
  await new Promise(resolve => setTimeout(resolve, 5500));
  assert.equal(f.pushes().length, settled, 'an unchanged view is not re-sent');
});

test('a failing push is logged and never disturbs the activation flow', async t => {
  const f = fixture(t);
  f.setPushResult({ pushed: 0, reason: 'unavailable' });
  f.setNativeRead(async () => ({ status: 'ready', models: [{ uid: 'swe-2-high', label: 'P', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] }] }));
  await f.activate(f.context);
  assert.ok(await waitFor(() => f.logs.some(line => line.includes('native-push-skip'))), 'the skip is reported');
  assert.equal(f.counts().installed, 1);
  assert.ok(f.logs.every(line => !line.includes('"event":"error"')));
});

// The gate used to key off the local bridge observations while sending the
// merged view. A first refresh that answered with nothing claimed the key, so
// the immediately following meaningful refresh looked "unchanged" and the push
// never happened — masked only by whichever timing happened to work.
test('an empty first refresh does not suppress the next push', async t => {
  const f = fixture(t);
  let calls = 0;
  const rich = [{ uid: 'swe-2-high', label: 'SWE-2 High', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'],
    sidekickDimension: { order: 2, name: 'SWE-2 High', fastModeOrder: 0 } }];
  f.setPushResult({ pushed: 1, count: 1, improved: true });
  f.setNativeRead(async () => { calls++; return calls === 1 ? { status: 'loading', models: [] } : { status: 'ready', models: rich }; });
  await f.activate(f.context);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual(f.pushes(), [], 'an empty first refresh offers nothing and claims no key');
  // Drive the second read deterministically instead of waiting for the 3s sync
  // timer, so the assertion is about the gate rather than about timing.
  await f.managerOptions().refreshNativeModels();
  assert.ok(await waitFor(() => f.pushes().length >= 1), 'the next meaningful refresh still pushes');
  const offered = JSON.parse(JSON.stringify(f.pushes().at(-1).models));
  assert.deepEqual(offered.map(entry => entry.uid), ['swe-2-high']);
  assert.ok(f.logs.some(line => line.includes('"event":"native-push"')), 'and it is reported');
});

test('our own uids are never part of a push payload', async t => {
  const f = fixture(t);
  f.setNativeRead(async () => ({ status: 'ready', models: [{ uid: 'swe-2-high', label: 'P', disabled: false, isModelRouter: false, harnessUids: ['h'] }] }));
  await f.activate(f.context);
  assert.ok(await waitFor(() => f.pushes().length >= 1));
  // The backend's reader rejects a catalog containing our uids, so offering them
  // would break every subsequent refresh of this host.
  f.bridges.at(-1).onNativeModels([{ uid: 'dfbyok-own', label: 'own', disabled: false, isModelRouter: false, harnessUids: ['fusion'] }]);
  await f.managerOptions().refreshNativeModels();
  await new Promise(resolve => setTimeout(resolve, 250));
  for (const push of f.pushes()) {
    assert.ok(push.models.every(entry => !/^(?:fusion-)?dfbyok-/.test(entry.uid)), 'no own uid is ever offered');
  }
});

test('a disabled plugin never pushes', async t => {
  const f = fixture(t, { config: { enabled: false } });
  await f.activate(f.context);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual(f.pushes(), []);
});

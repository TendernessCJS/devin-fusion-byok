'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { createSandboxLoader } = require('./helpers/sandbox.cjs');
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
  const cacheChecks = [], executed = [], authOptions = [], restoreCalls = [];
  let authDisposed = 0, authRestoreResult = { ok: true, code: 'restored' }, acpDisposed = 0, bridgeDisposeError = null;
  const authHandle = {
    deactivated: 0,
    deactivate() { this.deactivated += 1; },
    drain: () => Promise.resolve(true),
    restore: options => { restoreCalls.push(options); return Promise.resolve(authRestoreResult); },
    dispose() { authDisposed += 1; },
    status: { state: 'observing', calls: 0, rewrites: 0 },
  };
  const updateGates = { settings: new Map(), state: new Map() };
  const makeGate = (map, key) => { let mark, release;
    const started = new Promise(resolve => { mark = resolve; }), promise = new Promise(resolve => { release = resolve; });
    map.set(key, { mark, promise });
    return { started, release }; };
  const consumeGate = (map, key) => { const gate = map.get(key); map.delete(key); return gate; };
  const settings = {
    inspect: key => ({ globalValue: globals[key] }),
    get: () => { throw new Error('Merged workspace settings must not be copied into global settings'); },
    update: async (key, value) => { assert.ok(fs.existsSync(path.join(root, RECEIPT)));
      const gate = consumeGate(updateGates.settings, key); if (gate) { gate.mark(); await gate.promise; }
      globals[key] = value; updates.push(key); },
  };
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    workspace: { getConfiguration: () => settings,
      onDidChangeConfiguration: fn => { preferenceListeners.push(fn); return { dispose() {} }; } },
    extensions: { getExtension: () => ({ extensionPath: '/native', packageJSON: { main: 'main.js', version: 'test' } }) },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
      executeCommand: command => { executed.push(command); return Promise.resolve(); } },
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
    'node:child_process': { ...require('node:child_process'), spawn: (file, args, options) => {
      spawns.push({ file, args, options });
      const child = new EventEmitter(); child.unref = () => {};
      return child;
    } },
    './config/config.cjs': {
      readConfig: file => JSON.parse(fs.readFileSync(file, 'utf8')),
      writeConfig: (file, value) => fs.writeFileSync(file, JSON.stringify(value)),
      defaultConfig: realRequire('./config/config.cjs').defaultConfig,
      pruneRetiredKeys: realRequire('./config/config.cjs').pruneRetiredKeys,
    },
    './catalog.cjs': { staleFusionUids: () => [],
      catalogSignature: realRequire('./catalog/signature.cjs').catalogSignature,
      buildCatalog: config => ({ models: config.providers?.length
        ? [{ uid: 'dfbyok-own', label: 'own', kind: 'model' },
          { uid: 'fusion-dfbyok-selected', label: 'CPA Fusion', kind: 'matrix' },
          { uid: 'fusion-dfbyok-another', label: 'CPA Fusion Alt', kind: 'matrix' }, ...extraCatalogModels] : [],
      fusions: config.providers?.length ? { 'fusion-dfbyok-selected': { label: 'CPA Fusion' }, 'fusion-dfbyok-another': { label: 'CPA Fusion Alt' } } : {},
      lastFusionSelection: config.lastFusionSelection, matrixUids }) },
    './runtime/host/native-models.cjs': { readNativeModels: options => nativeRead(options),
      isUpstreamUid: realRequire('./runtime/host/native-models.cjs').isUpstreamUid,
      pushNativeModels: options => { pushes.push(options); return Promise.resolve(pushResult); } },
    './goal/continue-hook.cjs': { installGoalContinue: () => null },
    './runtime/host/auto-continue.cjs': { installAutoContinue: options => { autoContinueOptions = options;
      return { status: () => ({}), reset() {}, cancelSession: () => false, dispose() {} }; } },
    './runtime/host/acp-observer.cjs': { installAcpObserver: () => ({ dispose() { acpDisposed += 1; } }) },
    './runtime/host/auth-status.cjs': { installAuthStatusInjection: options => { authOptions.push(options); return authHandle; } },
    './runtime/source-identity.cjs': { runtimeIdentity: () => identity },
    './runtime/contract.cjs': { ...realRequire('./runtime/contract.cjs'), rootIdentity: () => identity },
    './runtime/bridge.cjs': { createLsBridge: async (_port, options) => { bridges.push(options); return { port: 4567, close() {} }; } },
    './runtime/host/ls-injection.cjs': { installLsInjection: async options => {
      installed++; await options.createBridge(1234);
      if (injectionGate) { const gate = injectionGate; injectionGate = null; await gate; }
      return { status: { state: 'ready' }, dispose: async () => { disposed++; if (bridgeDisposeError) throw bridgeDisposeError; } };
    } },
    './panel/manager.cjs': { ...realRequire('./panel/manager.cjs'), createManager: options => {
      managerOptions = options;
      return realRequire('./panel/manager.cjs').createManager(options);
    } },
    './runtime/host/cli-cache.cjs': { CACHE_NAME: /(?:)/, defaultDir: () => '/nonexistent-test-cli-cache',
      inspectCliCaches: () => ({ checked: 0, entries: [], expected: [] }),
      refreshStaleCliCaches: options => { cacheChecks.push(options); return { checked: options.expectedUids.length, refreshed: [], skipped: [], errors: [] }; } },
  };
  // Timeout-path tests get a short real drain budget; production keeps 5s.
  if (initial.managedSettingsTimeoutMs) overrides['./activation/managed-settings.cjs'] = {
    createManagedSettingsGate: options => realRequire('./activation/managed-settings.cjs')
      .createManagedSettingsGate({ timeoutMs: initial.managedSettingsTimeoutMs }),
  };
  if (initial.hostDisabled) overrides['./lifecycle/host-disabled.cjs'] = { isHostDisabled: () => true };
  const remoteCalls = { start: 0, stop: 0, ensure: 0 };
  let remoteEnsure = () => Promise.resolve();
  if (initial.remote) {
    vscode.env = { remoteName: 'ssh-remote' };
    vscode.extensions.getExtension = () => undefined;
    overrides['./activation/remote-support.cjs'] = {
      discoverRemoteMain: () => null,
      createRemoteSupport: () => ({
        start() { remoteCalls.start++; return Promise.resolve(); },
        stop() { remoteCalls.stop++; },
        status: () => [],
        ensureCurrentRemoteWindowTunnel() { remoteCalls.ensure++; return remoteEnsure(); },
      }),
    };
  }
  const loader = createSandboxLoader({ filename, overrides, globals: {
    AbortController, AbortSignal, setInterval, clearInterval, setTimeout: (fn, _ms) => setTimeout(fn, 0), clearTimeout,
    fetch: (...args) => fetchImpl(...args),
    // The managed-settings gate keeps a real drain budget: under the zero-delay
    // shim above its 5s bound collapses to 0ms, so drain always reports a
    // timeout and the tests would pass for the wrong reason.
  }, shareGlobals: file => file.includes(path.sep + 'src' + path.sep + 'activation' + path.sep) &&
    !file.endsWith('managed-settings.cjs') });
  const module = loader.module;
  // Realm boundaries break instanceof inside the sandboxed module, so the
  // matrix uid set must be built with the sandbox realm's Set constructor.
  const vmSet = vm.runInContext('Set', loader.context);
  const context = { globalStorageUri: { fsPath: root }, extensionPath, subscriptions: [],
    globalState: { get: (key, fallback) => state.has(key) ? state.get(key) : fallback,
      update: async (key, value) => { const gate = consumeGate(updateGates.state, key);
        if (gate) { gate.mark(); await gate.promise; }
        return value === undefined ? state.delete(key) : state.set(key, value); } } };
  t.after(async () => { await module.exports.deactivate(); context.subscriptions.forEach(value => value.dispose()); loader.assertStubsUsed('extension-lifecycle'); });
  return { ...module.exports, context, root, configFile, globals, state, commands, logs, notices, watchers, updates, bridges,
    preferenceListeners, managerOptions: () => managerOptions, spawns, autoContinueOptions: () => autoContinueOptions,
    setFetch: impl => { fetchImpl = impl; },
    setNativeRead: impl => { nativeRead = impl; },
    pushes: () => pushes,
    setPushResult: value => { pushResult = value; },
    setMatrixUids: uids => { matrixUids = new vmSet(uids); },
    setCatalogModels: models => { extraCatalogModels = models; },
    gateInjection: () => { let release; injectionGate = new Promise(resolve => { release = resolve; }); return release; },
    gateSettingsUpdate: key => makeGate(updateGates.settings, key),
    gateGlobalStateUpdate: key => makeGate(updateGates.state, key),
    setWarningResult: value => { warningResult = value; },
    firePreference: (key = 'devin.acp.agentPreferences') => Promise.all(preferenceListeners.map(fn => fn({ affectsConfiguration: name => name === key }))),
    cacheChecks: () => cacheChecks,
    executed: () => executed, authOptions: () => authOptions, restoreCalls: () => restoreCalls,
    authDisposed: () => authDisposed, setAuthRestore: value => { authRestoreResult = value; },
    acpDisposed: () => acpDisposed, setBridgeDisposeError: error => { bridgeDisposeError = error; },
    settle: async (ticks = 20) => { for (let index = 0; index < ticks; index++) await next(); },
    remoteCalls: () => remoteCalls,
    setRemoteEnsure: fn => { remoteEnsure = fn; },
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
function writeHostState(root, disabled) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(path.dirname(root), 'state.vscdb'));
  db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('extensionsIdentifiers/disabled', JSON.stringify(disabled.map(id => ({ id }))));
  db.close();
}
test('disabling in the extension manager restores owned env on unload, keeping the plugin enabled for next time', async t => {
  const f = fixture(t); await f.activate(f.context);
  assert.equal(f.globals.agentEnv['devin-cli'].WINDSURF_API_SERVER_URL, 'http://127.0.0.1:39842');
  writeHostState(f.root, ['github.copilot-chat', 'Local.Devin-Fusion-BYOK']);
  await f.deactivate();
  assert.equal(f.counts().disposed, 1);
  assert.ok(!Object.hasOwn(f.globals.agentEnv['devin-cli'], 'WINDSURF_API_SERVER_URL'));
  assert.equal(f.globals.agentEnv['devin-cli'].KEEP, 'user-value');
  assert.notEqual(JSON.parse(fs.readFileSync(f.configFile, 'utf8')).enabled, false, 'the panel switch is not flipped');
});
test('an unrelated disabled list or an unreadable database keeps the shared env on unload', async t => {
  const f = fixture(t); await f.activate(f.context);
  writeHostState(f.root, ['github.copilot-chat']);
  await f.deactivate();
  assert.equal(f.globals.agentEnv['devin-cli'].WINDSURF_API_SERVER_URL, 'http://127.0.0.1:39842');
  const g = fixture(t); await g.activate(g.context);
  fs.writeFileSync(path.join(path.dirname(g.root), 'state.vscdb'), 'not a database');
  await g.deactivate();
  assert.equal(g.globals.agentEnv['devin-cli'].WINDSURF_API_SERVER_URL, 'http://127.0.0.1:39842');
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
test('activation prunes every retired config key', async t => {
  const f = fixture(t, { config: { sidekicks: [{ providerId: 'p', model: 'x' }], roleExclusions: { lead: [], sidekick: [] },
    fusionPresets: [{ id: 'p1', name: 'P1' }], defaultFusionUid: 'fusion-dfbyok-gone', fusionMatrix: true } });
  await f.activate(f.context);
  const written = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
  for (const key of ['sidekicks', 'roleExclusions', 'fusionPresets', 'defaultFusionUid', 'fusionMatrix']) {
    assert.ok(!Object.hasOwn(written, key), key + ' is a retired key with no reader left');
  }
  assert.deepEqual(written.providers, [{ id: 'cpa', name: 'CPA', models: [] }], 'nothing else in the config is touched');
});
test('enable no longer persists the derived inference server url', async t => {
  const f = fixture(t, { config: { inferenceServerUrl: 'http://127.0.0.1:39842' } });
  await f.activate(f.context);
  const written = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
  assert.ok(!Object.hasOwn(written, 'inferenceServerUrl'),
    'the value is derived from the runtime port, so a persisted equal copy is pruned and never re-written');
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
  const manager = realRequire('./panel/manager.cjs').createManager(f.managerOptions());
  const state = await manager.dispatch('setNativeModelHidden', { uid: 'swe-2-max', hidden: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile)).hiddenNativeModelUids, ['swe-2-max']);
  const sweMember = state.nativeFamilies.flatMap(family => family.members).find(member => member.uid === 'swe-2-max');
  assert.equal(sweMember.hidden, true);
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
  const manager = realRequire('./panel/manager.cjs').createManager(f.managerOptions());
  const state = await manager.dispatch('ready');
  assert.equal(state.nativeCatalogStatus, 'ready');
  const sweRow = state.nativeFamilies.flatMap(family => family.members).find(m => m.uid === record.uid);
  assert.ok(sweRow);
  assert.equal(sweRow.eligible, true);
  f.setNativeRead(async () => ({ status: 'empty', models: [] }));
  assert.equal((await manager.dispatch('refreshNativeModels')).nativeFamilies.length, 0);
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
  // For a uid this host observed itself the host copy is authoritative, so a
  // divergent backend scalar is masked; a genuine change still lands for uids
  // only the backend saw, so the merge never hides state.
  const backendOnly = { uid: 'backend-only-model', label: 'B', disabled: true, isModelRouter: false, harnessUids: ['h'] };
  f.setNativeRead(async () => ({ status: 'ready', models: [{ ...poor, disabled: true }, backendOnly] }));
  await f.managerOptions().refreshNativeModels();
  await f.settle();
  assert.equal(find().disabled, false, 'a stale backend scalar cannot downgrade the host-observed uid');
  assert.deepEqual(find().sidekickDimension, rich.sidekickDimension, 'and the dimensions survive it');
  assert.equal(JSON.parse(JSON.stringify(f.managerOptions().nativeModels().find(entry => entry.uid === backendOnly.uid))).disabled, true,
    'backend-only uids still adopt backend scalar changes');
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
  // The push must actually land: under the revision gate a failed push
  // legitimately retries on every refresh.
  f.setPushResult({ pushed: 1, count: 1 });
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

test('a failed push does not consume the revision and the next refresh retries it', async t => {
  const f = fixture(t);
  const rich = [{ uid: 'swe-2-high', label: 'P', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] }];
  f.setNativeRead(async () => ({ status: 'ready', models: rich }));
  f.setPushResult({ pushed: 0, reason: 'unavailable' });
  await f.activate(f.context);
  assert.ok(await waitFor(() => f.pushes().length >= 1), 'the first refresh pushes');
  assert.equal(f.pushes().at(-1).revision, 1, 'the push carries the local revision');
  assert.ok(await waitFor(() => f.logs.some(line => line.includes('native-push-skip'))), 'the failure is reported');
  const failed = f.pushes().length;
  // The failure claimed nothing: the same unchanged view is retried once the
  // throttle window has passed.
  f.setPushResult({ pushed: 2, count: 1, revision: 99 });
  await f.managerOptions().refreshNativeModels();
  assert.ok(await waitFor(() => f.pushes().length > failed, 7000), 'an unchanged view retries a failed push');
  assert.equal(f.pushes().at(-1).revision, 1, 'the retry sends the same revision');
  assert.ok(f.logs.some(line => line.includes('native-push-revision-mismatch')),
    'a mismatched echo is logged as a diagnostic only');
  await f.managerOptions().refreshNativeModels();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(f.pushes().length, failed + 1, 'a success settles the revision despite the echo mismatch');
});

test('catalog and allowedUids changes raise the revision and re-push', async t => {
  const f = fixture(t);
  const rich = [{ uid: 'swe-2-high', label: 'P', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] }];
  let allowed;
  f.setNativeRead(async () => ({ status: 'ready', models: rich, allowedUids: allowed }));
  f.setPushResult({ pushed: 1, count: 1 });
  await f.activate(f.context);
  assert.ok(await waitFor(() => f.pushes().length >= 1));
  await f.managerOptions().refreshNativeModels();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(f.pushes().length, 1, 'an unchanged view after a success is not re-sent');
  // A changed allowlist is part of the revision, not a silent resend.
  allowed = ['swe-2-high'];
  await f.managerOptions().refreshNativeModels();
  assert.ok(await waitFor(() => f.pushes().length >= 2, 7000), 'an allowedUids change re-pushes');
  assert.equal(f.pushes().at(-1).revision, 2);
  // The payload crosses the sandbox realm, so compare serialized values.
  assert.deepEqual(JSON.parse(JSON.stringify(f.pushes().at(-1).allowedUids)), ['swe-2-high']);
  // A changed catalog bumps the revision again.
  f.setNativeRead(async () => ({ status: 'ready', allowedUids: allowed,
    models: [...rich, { uid: 'swe-2-max', label: 'M', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] }] }));
  await f.managerOptions().refreshNativeModels();
  assert.ok(await waitFor(() => f.pushes().length >= 3, 7000), 'a catalog change re-pushes');
  assert.equal(f.pushes().at(-1).revision, 3);
  assert.equal(f.pushes().at(-1).models.length, 2);
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

test('a bridge allowedUids update goes through the shared revision and push path', async t => {
  const f = fixture(t);
  const rich = [{ uid: 'swe-2-high', label: 'P', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] }];
  let backendAllowed;
  f.setNativeRead(async () => ({ status: 'ready', models: rich, allowedUids: backendAllowed }));
  f.setPushResult({ pushed: 1, count: 1 });
  await f.activate(f.context);
  assert.ok(await waitFor(() => f.pushes().length >= 1));
  const baseline = f.pushes().length;
  const baseRevision = f.pushes().at(-1).revision;

  f.bridges.at(-1).onAllowedUids({ kind: 'restricted', uids: ['swe-2-max', 'swe-2-high'] });
  assert.ok(await waitFor(() => f.pushes().length > baseline, 7000), 'the allowlist change schedules a push');
  assert.equal(f.pushes().at(-1).revision, baseRevision + 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.pushes().at(-1).allowedUids)), ['swe-2-high', 'swe-2-max']);

  const settled = f.pushes().length;
  const checks = f.cacheChecks().length;
  f.bridges.at(-1).onAllowedUids({ kind: 'restricted', uids: ['swe-2-high', 'swe-2-max', 'swe-2-high'] });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(f.pushes().length, settled, 'an identical set causes no extra push or revision');
  assert.equal(f.cacheChecks().length, checks, 'and no fan-out at all');

  f.bridges.at(-1).onAllowedUids({ kind: 'restricted', uids: [] });
  f.bridges.at(-1).onAllowedUids({ kind: 'restricted', uids: ['dfbyok-own'] });
  f.bridges.at(-1).onAllowedUids('not-an-array');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(f.pushes().length, settled);
  assert.equal(f.cacheChecks().length, checks);
  assert.deepEqual([...f.managerOptions().nativeAllowedUids()].sort(), ['swe-2-high', 'swe-2-max']);

  backendAllowed = ['swe-2-high', 'swe-2-max'];
  await f.managerOptions().refreshNativeModels();
  assert.deepEqual([...f.managerOptions().nativeAllowedUids()].sort(), ['swe-2-high', 'swe-2-max']);
});

test('the bridge allowedUids callback is inert once disabled or unloaded', async t => {
  const f = fixture(t);
  f.setNativeRead(async () => ({ status: 'ready', models: [{ uid: 'swe-2-high', label: 'P', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] }] }));
  await f.activate(f.context);
  const bridge = f.bridges.at(-1);
  f.managerOptions().write({ ...JSON.parse(fs.readFileSync(f.configFile)), enabled: false });
  await f.managerOptions().afterChange('setEnabled');
  bridge.onAllowedUids({ kind: 'restricted', uids: ['swe-2-high'] });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(f.managerOptions().nativeAllowedUids().size, 0, 'a disabled plugin ignores the update');
  assert.deepEqual(f.pushes(), []);

  const g = fixture(t);
  g.setNativeRead(async () => ({ status: 'ready', models: [{ uid: 'swe-2-high', label: 'P', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] }] }));
  await g.activate(g.context);
  const unloaded = g.bridges.at(-1);
  await g.deactivate();
  unloaded.onAllowedUids({ kind: 'restricted', uids: ['swe-2-high'] });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(g.managerOptions().nativeAllowedUids().size, 0, 'an unloaded plugin ignores the update');
  assert.deepEqual(g.pushes(), []);
});

test('a disabled plugin never pushes', async t => {
  const f = fixture(t, { config: { enabled: false } });
  await f.activate(f.context);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual(f.pushes(), []);
});

test('activation wires the injection health snapshot into panel state', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  const manager = realRequire('./panel/manager.cjs').createManager(f.managerOptions());
  const health = manager.state().health;
  assert.ok(health && Array.isArray(health.items), 'panel state carries the health snapshot');
  assert.equal(health.items.length, 6, 'backend, bridge, env, cache, catalog and acp are always reported');
  assert.equal(health.items.map(item => item.id).join(','), 'backend,bridge,env,cache,catalog,acp',
    'the sandboxed manager crosses realms, so compare the id list as a string');
});

test('enable installs the auth hook with the event contract and publishes through one refresh command', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  await f.settle();
  assert.equal(f.authOptions().length, 1, 'the auth-status hook is installed once');
  const options = f.authOptions()[0];
  for (const key of ['isEnabled', 'onNativeModels', 'onPublication', 'getCatalog']) {
    assert.equal(typeof options[key], 'function', key + ' is wired');
  }
  assert.equal(f.executed().filter(command => command === 'devin.refreshUserStatus').length, 1,
    'the first publication issues exactly one coalesced refresh — the bare executeCommand call is gone');
  // Until the hook reports a matching applied signature the catalog stays unconfirmed.
  const manager = realRequire('./panel/manager.cjs').createManager(f.managerOptions());
  const catalogState = () => manager.state().health.items.find(item => item.id === 'catalog').state;
  assert.equal(catalogState(), 'unknown', 'pending publication is unverified, not green');
  const { catalogSignature } = require('../src/catalog.cjs');
  options.onPublication({ phase: 'applied', callId: 1, signature: catalogSignature(options.getCatalog()) });
  assert.equal(catalogState(), 'ok', 'a confirmed applied signature is the only green path');
});

test('the disable command serializes teardown and runs the bounded passthrough restore', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  await f.settle();
  const disable = f.commands.get('devinFusionByok.disable');
  await Promise.all([disable(), disable()]);
  assert.equal(f.notices.filter(text => text === 'Fusion BYOK 已停用，原生连接已恢复。').length, 1,
    'concurrent disable invocations share one teardown');
  assert.equal(f.restoreCalls().length, 1, 'explicit disable runs exactly one passthrough verification');
  assert.equal(typeof f.restoreCalls()[0].command, 'function');
  assert.ok(f.authDisposed() >= 1, 'the hook is removed after the restore attempt');
});

test('a passthrough restore that still sees own entries is logged unverified, never claimed', async t => {
  const f = fixture(t);
  f.setAuthRestore({ ok: false, code: 'restore-unverified' });
  await f.activate(f.context);
  await f.settle();
  await f.commands.get('devinFusionByok.disable')();
  assert.ok(f.logs.some(line => line.includes('desktop-catalog-restore') && line.includes('restore-unverified')),
    'an unverified restore is recorded, not reported as recovered');
});

test('a normal unload disposes the hook without firing a restore refresh', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  await f.settle();
  const refreshes = f.executed().length;
  await f.deactivate();
  assert.equal(f.restoreCalls().length, 0, 'deactivate never starts a network verification');
  assert.equal(f.executed().length, refreshes, 'deactivate issues no refresh commands');
  assert.ok(f.authDisposed() >= 1);
});

test('hook events arriving after teardown cannot revive the publication', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  await f.settle();
  const options = f.authOptions()[0];
  await f.deactivate();
  const refreshes = f.executed().length;
  options.onPublication({ phase: 'applied', callId: 1, signature: 'late' });
  options.onPublication({ phase: 'cleared', callId: 2 });
  await f.settle();
  assert.equal(f.executed().length, refreshes, 'late hook events are inert');
});

test('external enabled=false through the watcher shares the same serialized disable path', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  await f.settle();
  const config = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
  config.enabled = false;
  fs.writeFileSync(f.configFile, JSON.stringify(config));
  await f.watchers[0]();
  await f.settle();
  assert.equal(f.notices.filter(text => text === 'Fusion BYOK 已停用，原生连接已恢复。').length, 1,
    'the watcher path now runs the same restore+report disable as the command');
  assert.equal(f.restoreCalls().length, 1, 'external disable also verifies the stored catalog');
});

test('an LS bridge dispose failure still removes the auth and ACP wrappers', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  await f.settle();
  f.setBridgeDisposeError(new Error('ls teardown boom'));
  await assert.rejects(f.deactivate(), /ls teardown boom/);
  assert.ok(f.authDisposed() >= 1, 'the auth hook is removed even though the bridge dispose threw');
  assert.ok(f.acpDisposed() >= 1, 'the ACP wrapper is removed even though the bridge dispose threw');
});

test('an unverified catalog restore reports the partial outcome, never unconditional success', async t => {
  const f = fixture(t);
  f.setAuthRestore({ ok: false, code: 'restore-unverified' });
  await f.activate(f.context);
  await f.settle();
  await f.commands.get('devinFusionByok.disable')();
  assert.deepEqual(f.notices.filter(text => text.startsWith('Fusion BYOK 已停用')),
    ['Fusion BYOK 已停用，连接设置已恢复；桌面模型目录恢复尚未确认。'],
    'an unverified restore must not read as fully recovered');
});

test('a bridge dispose failure still restores owned settings before the error surfaces', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  await f.settle();
  assert.equal(f.globals.agentEnv['devin-cli'].WINDSURF_API_SERVER_URL, 'http://127.0.0.1:39842', 'enable wrote the plugin URL');
  f.setBridgeDisposeError(new Error('ls teardown boom'));
  await f.commands.get('devinFusionByok.disable')();
  assert.ok(!Object.hasOwn(f.globals.agentEnv['devin-cli'], 'WINDSURF_API_SERVER_URL'),
    'the plugin URL is reverted even when the bridge dispose throws');
  assert.equal(f.globals.agentEnv['devin-cli'].KEEP, 'user-value', 'user-owned values survive');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, RECEIPT))).changes.length, 0,
    'the receipt is fully discharged');
  assert.ok(!f.notices.includes('Fusion BYOK 已停用，原生连接已恢复。'),
    'a teardown error must not be masked as a clean restore');
});

test('ensureEnabled waits out an in-flight disable before reinstalling', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  await f.settle();
  assert.equal(f.authOptions().length, 1);
  // Gate the passthrough restore so the disable is provably still running when
  // the external enable path fires through the real watcher callback.
  let release;
  f.setAuthRestore(new Promise(resolve => { release = () => resolve({ ok: true, code: 'restored' }); }));
  const pending = f.commands.get('devinFusionByok.disable')();
  await f.settle(10);
  assert.equal(f.restoreCalls().length, 1, 'the restore probe is armed inside the gated disable');
  f.managerOptions().write({ ...JSON.parse(fs.readFileSync(f.configFile)), enabled: true });
  // The watcher path awaits ensureEnabled internally; awaiting it here would
  // deadlock against the gated restore, so it is fired and let to queue.
  const enabling = f.managerOptions().afterChange('setEnabled');
  await f.settle(5);
  assert.equal(f.authOptions().length, 1, 'the pending enable cannot install while the disable owns teardown');
  release();
  await pending;
  await enabling;
  await f.settle();
  assert.equal(f.authOptions().length, 2, 'the new generation installs exactly one fresh hook');
  assert.equal(f.authDisposed(), 1, 'the old generation handle is disposed, the new one alive');
});

test('an event from the previous generation hook cannot move the new publisher', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  await f.settle();
  const first = f.authOptions()[0];
  await f.commands.get('devinFusionByok.disable')();
  f.managerOptions().write({ ...JSON.parse(fs.readFileSync(f.configFile)), enabled: true });
  await f.managerOptions().afterChange('setEnabled');
  await f.settle();
  assert.equal(f.authOptions().length, 2);
  const { catalogSignature } = realRequire('./catalog/signature.cjs');
  const before = f.authOptions().length;
  first.onPublication({ phase: 'applied', callId: 9, signature: catalogSignature(first.getCatalog()) });
  await f.settle();
  assert.equal(f.authOptions().length, before, 'the stale handle emits into a pinned closure');
  // The new generation's hook remains the live one: its events alone decide.
  assert.equal(f.authDisposed(), 1);
});
test('disable waits for an in-flight managed settings write before restoring', async t => {
  const f = fixture(t);
  await f.activate(f.context); await f.settle();
  await f.commands.get('devinFusionByok.disable')();
  const gate = f.gateSettingsUpdate('agentEnv'); t.after(() => gate.release());
  f.managerOptions().write({ ...JSON.parse(fs.readFileSync(f.configFile)), enabled: true });
  const enabling = f.managerOptions().afterChange('setEnabled').catch(() => {});
  await gate.started;
  const disabling = f.commands.get('devinFusionByok.disable')();
  const early = await Promise.race([
    disabling.then(() => 'done'),
    f.settle(10).then(() => 'pending'),
  ]);
  assert.equal(early, 'pending', 'disable must wait for the in-flight managed write');
  gate.release();
  await Promise.allSettled([enabling, disabling]);
  await f.settle();
  assert.ok(!Object.hasOwn(f.globals.agentEnv['devin-cli'], 'WINDSURF_API_SERVER_URL'));
  assert.equal(f.globals.agentEnv['devin-cli'].KEEP, 'user-value');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, RECEIPT))).changes.length, 0);
});
test('disable waits through the globalState leg of a managed settings write', async t => {
  const f = fixture(t);
  await f.activate(f.context); await f.settle();
  await f.commands.get('devinFusionByok.disable')();
  const gate = f.gateGlobalStateUpdate('savedEnv');
  f.managerOptions().write({ ...JSON.parse(fs.readFileSync(f.configFile)), enabled: true });
  const enabling = f.managerOptions().afterChange('setEnabled').catch(() => {});
  await gate.started;
  const disabling = f.commands.get('devinFusionByok.disable')();
  const early = await Promise.race([
    disabling.then(() => 'done'),
    f.settle(10).then(() => 'pending'),
  ]);
  assert.equal(early, 'pending', 'disable must wait for the in-flight managed write');
  gate.release();
  await Promise.allSettled([enabling, disabling]);
  await f.settle();
  assert.ok(!Object.hasOwn(f.globals.agentEnv['devin-cli'], 'WINDSURF_API_SERVER_URL'));
  assert.equal(f.globals.agentEnv['devin-cli'].KEEP, 'user-value');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, RECEIPT))).changes.length, 0);
});
test('disable waits for an in-flight panel fusion choice and restore still wins', { timeout: 5000 }, async t => {
  const f = fixture(t);
  await f.activate(f.context); await f.settle();
  const gate = f.gateSettingsUpdate('agentPreferences'); t.after(() => gate.release());
  const choosing = f.managerOptions().selectFusion('fusion-dfbyok-selected').catch(() => {});
  await gate.started;
  const disabling = f.commands.get('devinFusionByok.disable')();
  const early = await Promise.race([
    disabling.then(() => 'done'),
    f.settle(10).then(() => 'pending'),
  ]);
  assert.equal(early, 'pending', 'disable must wait for the in-flight preference write');
  gate.release();
  await Promise.allSettled([choosing, disabling]);
  await f.settle();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'native-max');
  assert.equal(f.globals.agentPreferences['devin-cli'].effort, 'high');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, RECEIPT))).changes.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.configFile)).enabled, false);
  assert.equal(f.counts().disposed, 1);
  const receiptBefore = fs.readFileSync(path.join(f.root, RECEIPT), 'utf8');
  await assert.rejects(f.managerOptions().selectFusion('fusion-dfbyok-selected'),
    error => error?.code === 'cancelled');
  assert.equal(fs.readFileSync(path.join(f.root, RECEIPT), 'utf8'), receiptBefore,
    'a write attempted after close is cancelled, not applied');
});
test('disable waits for the enable-time preference write from the remembered combination', { timeout: 5000 }, async t => {
  const f = fixture(t, { config: { lastFusionSelection: 'fusion-dfbyok-selected' },
    globals: { agentPreferences: { 'devin-cli': { effort: 'high' } } } });
  const gate = f.gateSettingsUpdate('agentPreferences'); t.after(() => gate.release());
  const activating = f.activate(f.context).catch(() => {});
  await gate.started;
  const disabling = f.commands.get('devinFusionByok.disable')();
  const early = await Promise.race([
    disabling.then(() => 'done'),
    f.settle(10).then(() => 'pending'),
  ]);
  assert.equal(early, 'pending');
  gate.release();
  await Promise.allSettled([activating, disabling]);
  await f.settle();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, undefined);
  assert.equal(f.globals.agentPreferences['devin-cli'].effort, 'high');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, RECEIPT))).changes.length, 0);
  assert.equal(f.counts().installed, 0, 'the superseded enable must not install a late hook');
});
test('disable waits for a preference reconciliation write in flight', { timeout: 5000 }, async t => {
  const f = fixture(t, { config: { lastFusionSelection: 'fusion-dfbyok-selected' } });
  await f.activate(f.context); await f.settle();
  delete f.globals.agentPreferences['devin-cli'].model;
  const gate = f.gateSettingsUpdate('agentPreferences'); t.after(() => gate.release());
  const firing = f.firePreference().catch(() => {});
  await gate.started;
  const disabling = f.commands.get('devinFusionByok.disable')();
  const early = await Promise.race([
    disabling.then(() => 'done'),
    f.settle(10).then(() => 'pending'),
  ]);
  assert.equal(early, 'pending');
  gate.release();
  await Promise.allSettled([firing, disabling]);
  await f.settle();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, undefined);
  assert.equal(f.globals.agentPreferences['devin-cli'].effort, 'high');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, RECEIPT))).changes.length, 0);
});
test('disable waits for a selection reconciliation write in flight', { timeout: 5000 }, async t => {
  const f = fixture(t);
  await f.activate(f.context); await f.settle();
  const stale = 'fusion-native-lead-sidekick-dfbyok-gone';
  f.setMatrixUids([stale]);
  f.globals.agentPreferences['devin-cli'].model = stale;
  const gate = f.gateSettingsUpdate('agentPreferences'); t.after(() => gate.release());
  const reconciling = f.managerOptions().afterChange('setRoleModel').catch(() => {});
  await gate.started;
  const disabling = f.commands.get('devinFusionByok.disable')();
  const early = await Promise.race([
    disabling.then(() => 'done'),
    f.settle(10).then(() => 'pending'),
  ]);
  assert.equal(early, 'pending');
  gate.release();
  await Promise.allSettled([reconciling, disabling]);
  await f.settle();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, undefined,
    'the stale own selection must not survive restore');
});
test('a drain timeout keeps evidence, warns instead of claiming restore, and a later disable finishes', { timeout: 5000 }, async t => {
  const f = fixture(t, { managedSettingsTimeoutMs: 30 });
  await f.activate(f.context); await f.settle();
  await f.commands.get('devinFusionByok.disable')();
  const gate = f.gateSettingsUpdate('agentEnv'); t.after(() => gate.release());
  f.managerOptions().write({ ...JSON.parse(fs.readFileSync(f.configFile)), enabled: true });
  const enabling = f.managerOptions().afterChange('setEnabled').catch(() => {});
  await gate.started;
  const noticesBefore = f.notices.length;
  await f.commands.get('devinFusionByok.disable')();
  const notices = f.notices.slice(noticesBefore);
  assert.ok(notices.some(notice => notice.includes('恢复尚未确认')),
    'a timed-out drain must not claim the settings were restored');
  assert.ok(!notices.some(notice => notice.includes('已恢复')),
    'both success wordings are reserved for a completed drain');
  assert.ok(JSON.parse(fs.readFileSync(path.join(f.root, RECEIPT))).changes.length > 0,
    'the receipt stays as compensation evidence');
  assert.ok(f.state.has('savedEnv') && f.state.has('managedEnv'),
    'the saved originals stay for the same reason');
  gate.release();
  await Promise.allSettled([enabling]);
  await f.settle();
  await f.commands.get('devinFusionByok.disable')();
  await f.settle();
  assert.ok(!Object.hasOwn(f.globals.agentEnv['devin-cli'], 'WINDSURF_API_SERVER_URL'),
    'the retained receipt lets the next disable finish the cleanup');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, RECEIPT))).changes.length, 0);
});
test('a host-disable drain timeout logs pending rather than restored', { timeout: 5000 }, async t => {
  const f = fixture(t, { managedSettingsTimeoutMs: 30, hostDisabled: true });
  await f.activate(f.context); await f.settle();
  await f.commands.get('devinFusionByok.disable')();
  const gate = f.gateSettingsUpdate('agentEnv'); t.after(() => gate.release());
  f.managerOptions().write({ ...JSON.parse(fs.readFileSync(f.configFile)), enabled: true });
  const enabling = f.managerOptions().afterChange('setEnabled').catch(() => {});
  await gate.started;
  await f.deactivate();
  assert.ok(f.logs.some(line => line.includes('host-disabled-settings-restore-pending')),
    'a timed-out host-disable restore must log pending');
  assert.ok(!f.logs.some(line => line.includes('host-disabled-settings-restored')),
    'the restored event is reserved for a completed drain');
  gate.release();
  await Promise.allSettled([enabling]);
});

test('a remote window without the native extension activates through the reverse tunnel only', async t => {
  const f = fixture(t, { remote: true });
  const api = await f.activate(f.context);
  await f.settle();
  assert.equal(f.globals.agentEnv['devin-cli'].WINDSURF_API_SERVER_URL, 'http://127.0.0.1:39842',
    'the agentEnv write still routes the remote CLI at the local backend');
  assert.equal(f.remoteCalls().start, 2, 'the tunnel install starts eagerly and the enable path starts it');
  assert.equal(f.remoteCalls().ensure, 1, 'the current window tunnel is requested once');
  assert.equal(api.status().state, 'ready');
  assert.deepEqual(api.status().tunnels, []);
  assert.equal(f.counts().installed, 0, 'no LS bridge installs without the native extension');
  assert.ok(f.logs.some(line => line.includes('activated-remote')));
  await f.deactivate();
  assert.equal(f.remoteCalls().stop, 1, 'teardown stops the tunnel support');
});

test('an initially-disabled remote window starts the tunnel only on enable', async t => {
  const f = fixture(t, { remote: true, config: { enabled: false } });
  const api = await f.activate(f.context);
  await f.settle();
  assert.equal(f.remoteCalls().start, 0, 'disabled activation installs no process-global wrappers');
  assert.equal(f.remoteCalls().ensure, 0);
  const config = JSON.parse(fs.readFileSync(f.configFile)); config.enabled = true;
  fs.writeFileSync(f.configFile, JSON.stringify(config));
  f.watchers[0]();
  await f.settle();
  assert.equal(f.remoteCalls().start, 1, 'enable starts the support lazily');
  assert.equal(f.remoteCalls().ensure, 1);
  assert.equal(api.status().state, 'ready');
});

test('disable then re-enable restarts remote support on the same window', async t => {
  const f = fixture(t, { remote: true });
  const api = await f.activate(f.context);
  await f.settle();
  assert.equal(api.status().state, 'ready');
  await f.commands.get('devinFusionByok.disable')();
  assert.equal(f.remoteCalls().stop, 1);
  const config = JSON.parse(fs.readFileSync(f.configFile)); config.enabled = true;
  fs.writeFileSync(f.configFile, JSON.stringify(config));
  f.watchers[0]();
  await f.settle();
  assert.equal(f.remoteCalls().start, 3, 'the support object survives teardown and installs again');
  assert.equal(f.remoteCalls().ensure, 2);
  assert.equal(api.status().state, 'ready');
});

test('a failed remote tunnel retries through ensureEnabled without re-running setup', async t => {
  const f = fixture(t, { remote: true });
  f.setRemoteEnsure(() => Promise.reject(new Error('tunnel_down')));
  const api = await f.activate(f.context);
  await f.settle();
  assert.equal(api.status().state, 'unavailable');
  assert.equal(f.remoteCalls().ensure, 1);
  assert.equal(f.counts().installed, 0);
  f.setRemoteEnsure(() => Promise.resolve());
  f.watchers[0]();
  await f.settle();
  assert.equal(f.remoteCalls().ensure, 2, 'a later enable trigger retries the tunnel');
  assert.equal(f.remoteCalls().start, 3, 'retry goes through support.start() again');
  assert.equal(api.status().state, 'ready');
  f.watchers[0]();
  await f.settle();
  assert.equal(f.remoteCalls().ensure, 2, 'a ready connection stays idempotent');
});

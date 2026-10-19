'use strict';

// R0 structural guardrail for managed agent env under an HTTP proxy (F3/R4).
// When the user configures `http.proxy`, the devin-cli agent environment must
// exempt loopback addresses via NO_PROXY so the CLI can still reach the local
// backend and language-server bridge. The current enable() writes only
// WINDSURF_API_SERVER_URL, so the proxy case is a todo for R4; the unproxied
// baseline is green.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSandboxLoader } = require('./helpers/sandbox.cjs');

const filename = path.resolve(__dirname, '../src/activation/enable.cjs');
const PORT = 39842;

// Minimal installEnable fixture: every relative require that enable() touches
// is stubbed except owned-settings.cjs (it only writes a receipt file inside
// the temp root). No real backend, vscode, or user settings are involved.
function fixture(t, { httpConfig = {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-proxy-env-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'storage');
  const extensionPath = path.join(directory, 'extension');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(extensionPath);
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ enabled: true }));

  const updates = [];
  const globals = { agentEnv: { 'devin-cli': {} } };
  const acpSettings = {
    inspect: key => ({ globalValue: globals[key] }),
    get: () => { throw new Error('Merged workspace settings must not be copied into global settings'); },
    update: async (key, value) => { globals[key] = value; updates.push(key); },
  };
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    workspace: { getConfiguration: section => section === 'http'
      ? { get: key => httpConfig[key], inspect: key => ({ globalValue: httpConfig[key] }) }
      : acpSettings },
    extensions: { getExtension: () => ({ extensionPath: '/native', packageJSON: { main: 'main.js', version: 'test' } }) },
  };
  const config = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const state = new Map();
  const context = {
    extensionPath,
    globalState: {
      get: (key, fallback) => state.has(key) ? state.get(key) : fallback,
      update: async (key, value) => value === undefined ? state.delete(key) : state.set(key, value),
    },
  };
  const lifecycle = { activationGeneration: 0, activationDisposed: false, connection: undefined };
  const shared = {
    reconcilePreference: async () => {},
    startNativeSync: () => {},
    observeNativeModels: () => {},
    pushToBackend: () => {},
    nativeAllowedUids: new Set(),
    management: undefined,
  };
  const deps = { lifecycle, config, configFile, vscode, context, log: () => {},
    catalog: () => ({ models: [] }), nativeMain: '/native/main.js', root, extensionPath };

  const loader = createSandboxLoader({ filename, overrides: {
    '../config.cjs': { writeConfig: (file, value) => fs.writeFileSync(file, JSON.stringify(value)) },
    '../runtime/ls-injection.cjs': { installLsInjection: async () => ({ dispose: async () => {} }) },
    '../runtime/bridge.cjs': { createLsBridge: async () => ({ port: 4567, close() {} }) },
    '../runtime/acp-observer.cjs': { installAcpObserver: () => ({ dispose() {} }) },
    '../runtime/backend.cjs': { PORT },
    './backend-handshake.cjs': { ensureBackend: ({ onCompatibleRuntime }) => {
      onCompatibleRuntime?.({ version: 'test' });
      return Promise.resolve();
    } },
  } });
  loader.module.exports.installEnable({ deps, shared });
  t.after(() => loader.assertStubsUsed('proxy-env'));
  return { globals, shared, lifecycle };
}

test('without http.proxy the managed devin-cli env contains only WINDSURF_API_SERVER_URL', async t => {
  const f = fixture(t);
  await f.shared.ensureEnabled();
  // The env object is built inside the sandbox realm; copy it across the
  // boundary before comparing against a test-realm literal.
  assert.deepEqual({ ...f.globals.agentEnv['devin-cli'] },
    { WINDSURF_API_SERVER_URL: `http://127.0.0.1:${PORT}` });
});

// R4 must add a loopback exemption when an HTTP proxy is configured: the
// managed env must carry NO_PROXY covering 127.0.0.1, localhost, and ::1 so
// devin-cli traffic to the local backend/bridge never leaves through the
// user's proxy.
test('with http.proxy configured the managed env exempts loopback via NO_PROXY',
  { todo: 'R4 proxy env: enable() must write NO_PROXY with loopback exemptions when http.proxy is set' },
  async t => {
    const f = fixture(t, { httpConfig: { proxy: 'http://127.0.0.1:7897', noProxy: [] } });
    await f.shared.ensureEnabled();
    const env = f.globals.agentEnv['devin-cli'];
    assert.equal(env.WINDSURF_API_SERVER_URL, `http://127.0.0.1:${PORT}`);
    const noProxy = String(env.NO_PROXY || '').split(',').map(entry => entry.trim());
    for (const host of ['127.0.0.1', 'localhost', '::1']) assert.ok(noProxy.includes(host));
  });

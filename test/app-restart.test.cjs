'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { restartApp, relaunchScript, appProbe, appBundle } = require('../src/runtime/app-restart.cjs');
const { createPanelController } = require('../src/panel/controller.cjs');

test('the bundle is derived from the app root and rejected otherwise', () => {
  assert.equal(appBundle('/Applications/Devin.app/Contents/Resources/app'), '/Applications/Devin.app');
  assert.equal(appBundle('/opt/devin/resources/app'), '');
  assert.equal(appBundle(undefined), '');
});

test('the relaunch helper is valid shell, quotes the bundle and gives up after the wait', () => {
  const script = relaunchScript("/Applications/Dev in's.app", 90);
  execFileSync('/bin/sh', ['-n', '-c', script]);
  assert.match(script, /\[ \$i -gt 180 \] && exit 0/);
  assert.ok(script.includes("/usr/bin/open '/Applications/Dev in'\\''s.app'"));
  assert.match(script, /\/bin\/ps -Ao comm=/);
  assert.ok(!script.includes('pgrep'));
});

test('restart spawns a detached helper before quitting', async () => {
  const calls = [];
  const vscode = { env: { appRoot: '/Applications/Devin.app/Contents/Resources/app' },
    commands: { executeCommand: async command => calls.push(['command', command]) } };
  const spawn = (file, args, options) => { calls.push(['spawn', file, options.detached]); return { unref() { calls.push(['unref']); } }; };
  assert.equal(await restartApp({ vscode, spawn, platform: 'darwin' }), '/Applications/Devin.app');
  assert.deepEqual(calls, [['spawn', '/bin/sh', true], ['unref'], ['command', 'workbench.action.quit']]);
  await assert.rejects(restartApp({ vscode, spawn, platform: 'linux' }), /restart_unsupported/);
});

function panelHarness(choice, restartApp) {
  let handler; const posted = [];
  const panel = { visible: true, reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} }),
    webview: { html: '', cspSource: '', postMessage: async message => { posted.push(message); return true; }, onDidReceiveMessage: fn => { handler = fn; return { dispose() {} }; } } };
  const warnings = [];
  const vscode = { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel,
    showWarningMessage: async (...args) => { warnings.push(args); return choice; } } };
  const controller = createPanelController({ vscode, context: { subscriptions: [] }, restartApp,
    manager: { state: () => ({}), dispatch: async () => { throw new Error('restart must not reach the manager'); } }, safeError: () => ({ message: 'x' }) });
  controller.open();
  return { send: message => handler(message), posted, warnings };
}

test('the panel restarts only after the modal is confirmed', async () => {
  let restarts = 0;
  const confirmed = panelHarness('重启', async () => { restarts++; });
  await confirmed.send({ id: 'a', type: 'app.restart' });
  assert.equal(restarts, 1);
  assert.equal(confirmed.warnings[0][1].modal, true);
  assert.deepEqual(confirmed.posted.find(m => m.type === 'result'), { type: 'result', id: 'a', ok: true, cancelled: false });

  const cancelled = panelHarness(undefined, async () => { restarts++; });
  await cancelled.send({ id: 'b', type: 'app.restart' });
  assert.equal(restarts, 1);
  assert.equal(cancelled.posted.find(m => m.type === 'result').cancelled, true);
});

test('restart failures are reported without leaking details', async () => {
  const failed = panelHarness('重启', async () => { throw new Error('secret detail'); });
  await failed.send({ id: 'c', type: 'app.restart' });
  const result = failed.posted.find(m => m.type === 'result');
  assert.equal(result.ok, false);
  assert.equal(result.error, '无法自动重启 Devin，请手动退出后重新打开。');
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// A symlink to node stands in for the app executable: `ps -o comm` reports the
// synthetic path, and node can spawn children so the probe runs inside the
// app's process tree exactly like the real helper does.
function fakeApp(dir) {
  const bundle = path.join(dir, 'Fake.app');
  const executable = path.join(bundle, 'Contents/MacOS/fakeapp');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.symlinkSync(process.execPath, executable);
  return { bundle, executable };
}

test('the liveness probe sees an app that pgrep cannot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-restart-'));
  try {
    const { bundle, executable } = fakeApp(dir);
    // macOS pgrep skips its own ancestors; the helper is always spawned as a
    // descendant of the app, so pgrep can never see the app it waits for. Run
    // the probe from a child of the synthetic app to reproduce that position.
    const program = 'const { execFileSync } = require("node:child_process");process.stdout.write(execFileSync("/bin/sh", ["-c", process.argv[1]], { encoding: "utf8" }));';
    const inner = `${appProbe(bundle)}; echo probe=$?; /usr/bin/pgrep -f '^${bundle}/Contents/MacOS/' >/dev/null 2>&1; echo pgrep=$?`;
    const output = execFileSync(executable, ['-e', program, inner], { encoding: 'utf8' });
    assert.match(output, /probe=0/);
    assert.match(output, /pgrep=1/);
    assert.throws(() => execFileSync('/bin/sh', ['-c', appProbe(bundle)]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the helper reopens only after the app exits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-restart-'));
  let app, helper;
  try {
    const { bundle, executable } = fakeApp(dir);
    app = spawn(executable, ['-e', 'setTimeout(() => {}, 1200)'], { stdio: 'ignore' });
    const marker = path.join(dir, 'reopened');
    helper = spawn('/bin/sh', ['-c', relaunchScript(bundle, 20, `/usr/bin/touch '${marker}'`)], { stdio: 'ignore' });
    await delay(400);
    assert.equal(fs.existsSync(marker), false, 'the helper must keep waiting while the app is alive');
    const deadline = Date.now() + 8000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await delay(200);
    assert.equal(fs.existsSync(marker), true, 'the helper relaunches only after the app exits');
  } finally {
    app?.kill();
    helper?.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { restartApp, relaunchScript, relaunchCommand, appProbe, appBundle } = require('../src/runtime/app-restart.cjs');
const { createPanelController } = require('../src/panel/controller.cjs');

test('the bundle is derived from the app root and rejected otherwise', () => {
  assert.equal(appBundle('/Applications/Devin.app/Contents/Resources/app'), '/Applications/Devin.app');
  assert.equal(appBundle('/opt/devin/resources/app'), '');
  assert.equal(appBundle(undefined), '');
});

test('the relaunch helper is valid shell, quotes paths and briefly settles before launching', () => {
  const script = relaunchScript("/Applications/Dev in's.app", 90, '/usr/bin/open',
    { logFile: "/tmp/devin fusion's restart.log", label: 'devin-fusion-byok-restart-test' });
  execFileSync('/bin/sh', ['-n', '-c', script]);
  assert.ok(script.includes(`[ $i -gt 180 ] && { log 'quit-cancelled'; [ -n 'devin-fusion-byok-restart-test' ] && /bin/launchctl remove 'devin-fusion-byok-restart-test' >/dev/null 2>&1; exit 0; }`),
    'a cancelled quit removes the launchd job before exiting');
  assert.ok(script.includes("/usr/bin/open '/Applications/Dev in'\\''s.app'"));
  assert.ok(script.includes(">> '/tmp/devin fusion'\\''s restart.log'"), 'the log path is single-quoted too');
  assert.match(script, /sleep 3/, 'the first launch waits out a small settle; retries cover the risky window');
  assert.match(script, /\/bin\/launchctl remove 'devin-fusion-byok-restart-test'/);
  assert.match(script, /\/bin\/ps -Ao comm=/);
  assert.ok(!script.includes('pgrep'));
});

test('rounds escalate open -> open -n -> direct exec of the app binary', () => {
  const bundle = '/Applications/Devin.app';
  const cmd = round => relaunchCommand(bundle, '/usr/bin/open', round, 10);
  assert.equal(cmd(1), "/usr/bin/open '/Applications/Devin.app' >/dev/null 2>&1");
  assert.equal(cmd(5), "/usr/bin/open '/Applications/Devin.app' >/dev/null 2>&1");
  assert.equal(cmd(6), "/usr/bin/open -n '/Applications/Devin.app' >/dev/null 2>&1");
  assert.equal(cmd(8), "/usr/bin/open -n '/Applications/Devin.app' >/dev/null 2>&1");
  assert.equal(cmd(9), "( /usr/bin/nohup '/Applications/Devin.app/Contents/MacOS/Devin' >/dev/null 2>&1 </dev/null & )");
  assert.equal(cmd(10), "( /usr/bin/nohup '/Applications/Devin.app/Contents/MacOS/Devin' >/dev/null 2>&1 </dev/null & )");
});

test('every launch channel appends its own output to the helper log', () => {
  const bundle = '/Applications/Devin.app';
  const cmd = round => relaunchCommand(bundle, '/usr/bin/open', round, 10, undefined, '/tmp/r.log');
  assert.ok(cmd(1).endsWith(`>> '/tmp/r.log' 2>&1`));
  assert.ok(cmd(6).endsWith(`>> '/tmp/r.log' 2>&1`));
  assert.ok(cmd(9).includes(`/usr/bin/nohup '/Applications/Devin.app/Contents/MacOS/Devin' >> '/tmp/r.log' 2>&1 </dev/null`));
});

test('stale instance handles are removed before every launch attempt', () => {
  const userData = "/Users/x/Application Support/Devin";
  const script = relaunchScript('/Applications/Devin.app', 90, '/usr/bin/open', { userData });
  const stale = `rm -f '${userData}'/*-main.sock '${userData}'/code.lock`;
  const settleIndex = script.indexOf('sleep 3');
  const caseIndex = script.indexOf('case $j in');
  assert.ok(script.slice(0, settleIndex).includes(stale), 'the first cleanup runs before the settle');
  assert.ok(script.slice(0, settleIndex).includes("log 'cleaned-stale'"), 'the first cleanup is logged');
  const roundCleanup = script.indexOf(stale, script.indexOf('j=$((j+1))'));
  assert.ok(roundCleanup !== -1 && roundCleanup < caseIndex, 'each round cleans again before choosing a channel');
  assert.ok(!relaunchScript('/Applications/Devin.app', 90).includes('rm -f'), 'no userData means no cleanup');
});

test('every round probes before launching so an already-running app is never opened again', () => {
  const script = relaunchScript('/Applications/Devin.app', 90, '/usr/bin/open', { label: 'x' });
  const probe = appProbe('/Applications/Devin.app');
  const preRound = `if ${probe}; then sleep 2; if ${probe}; then log "confirmed pre-round=$j"`;
  const caseIndex = script.indexOf('case $j in');
  assert.ok(caseIndex > 0, 'the launch command is a case branch');
  assert.ok(script.slice(0, caseIndex).includes(preRound), 'a confirmed probe before the first launch exits instead of opening');
});

test('restart prefers launchd and falls back to a detached shell on submit failure', async () => {
  const calls = [], unrefs = [];
  const vscode = { env: { appRoot: '/Applications/Devin.app/Contents/Resources/app' },
    commands: { executeCommand: async command => calls.push(['command', command]) } };
  const submitter = code => (file, args, options) => {
    calls.push([file, args, options]);
    const child = new EventEmitter();
    child.unref = () => unrefs.push(file);
    setTimeout(() => child.emit('exit', code), 5);
    return child;
  };
  assert.equal(await restartApp({ vscode, spawn: submitter(0), platform: 'darwin' }), '/Applications/Devin.app');
  assert.equal(calls[0][0], '/bin/launchctl');
  assert.equal(calls[0][1][0], 'submit');
  assert.equal(calls[0][1][1], '-l');
  assert.match(calls[0][1][2], /^devin-fusion-byok-restart-\d+$/);
  assert.deepEqual(calls[0][1].slice(3, 6), ['--', '/bin/sh', '-c']);
  assert.ok(!calls.some(call => call[0] === '/bin/sh'), 'a successful submit needs no fallback spawn');
  assert.equal(unrefs.length, 0, 'the submitted child is awaited, not detached');
  assert.deepEqual(calls.at(-1), ['command', 'workbench.action.quit']);

  calls.length = 0; unrefs.length = 0;
  await restartApp({ vscode, spawn: submitter(1), platform: 'darwin' });
  assert.equal(calls[0][0], '/bin/launchctl');
  const fallback = calls.find(call => call[0] === '/bin/sh');
  assert.ok(fallback, 'a non-zero submit falls back to the detached shell');
  assert.equal(fallback[2].detached, true);
  assert.deepEqual(unrefs, ['/bin/sh']);
  assert.deepEqual(calls.at(-1), ['command', 'workbench.action.quit']);
});

test('restart falls back when submit throws or returns a non-awaitable child', async () => {
  const vscode = { env: { appRoot: '/Applications/Devin.app/Contents/Resources/app' },
    commands: { executeCommand: async () => {} } };
  const calls = [];
  const throwing = (file, args, options) => {
    calls.push(file);
    if (file === '/bin/launchctl') throw new Error('spawn ENOENT');
    return { unref() { calls.push('unref'); } };
  };
  await restartApp({ vscode, spawn: throwing, platform: 'darwin' });
  assert.deepEqual(calls, ['/bin/launchctl', '/bin/sh', 'unref']);
  calls.length = 0;
  const silent = (file, args, options) => {
    calls.push(file);
    if (file === '/bin/launchctl') return {};
    return { unref() { calls.push('unref'); } };
  };
  await restartApp({ vscode, spawn: silent, platform: 'darwin' });
  assert.deepEqual(calls, ['/bin/launchctl', '/bin/sh', 'unref']);
  await assert.rejects(restartApp({ vscode, spawn: silent, platform: 'linux' }), /restart_unsupported/);
});

test('restart rotates the previous helper log and hands the new path to the script', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-restart-'));
  try {
    const logFile = path.join(dir, 'restart.log');
    fs.writeFileSync(logFile, 'previous run');
    const vscode = { env: { appRoot: '/Applications/Devin.app/Contents/Resources/app' },
      commands: { executeCommand: async () => {} } };
    const scripts = [];
    const spawn = (file, args) => {
      const child = new EventEmitter();
      if (file === '/bin/launchctl') { scripts.push(args.at(-1)); setTimeout(() => child.emit('exit', 0), 5); }
      else child.unref = () => {};
      return child;
    };
    await restartApp({ vscode, spawn, platform: 'darwin', logFile });
    assert.equal(fs.readFileSync(logFile + '.previous', 'utf8'), 'previous run');
    assert.equal(fs.existsSync(logFile), false, 'the old log moved aside before the helper starts');
    assert.ok(scripts[0].includes(`'${logFile}'`), 'the submitted helper writes to the new log path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  assert.match(confirmed.warnings[0][0], /自动重新打开/);
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

test('window reload invokes the injected command only after the modal is confirmed', async () => {
  let reloads = 0;
  const make = choice => {
    let handler; const posted = [];
    const panel = { visible: true, reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} }),
      webview: { html: '', cspSource: '', postMessage: async message => { posted.push(message); return true; },
        onDidReceiveMessage: fn => { handler = fn; return { dispose() {} }; } } };
    const warnings = [];
    const vscode = { ViewColumn: { Active: 1 },
      window: { createWebviewPanel: () => panel, showWarningMessage: async (...args) => { warnings.push(args); return choice; } } };
    createPanelController({ vscode, context: { subscriptions: [] },
      reloadWindow: async () => { reloads++; },
      manager: { state: () => ({}), dispatch: async () => { throw new Error('reload must not reach the manager'); } },
      safeError: () => ({ message: 'x' }) }).open();
    return { send: message => handler(message), posted, warnings };
  };
  const confirmed = make('重载');
  await confirmed.send({ id: 'r1', type: 'window.reload' });
  assert.equal(reloads, 1);
  assert.equal(confirmed.warnings[0][1].modal, true);
  assert.deepEqual(confirmed.posted.find(m => m.type === 'result'), { type: 'result', id: 'r1', ok: true, cancelled: false });
  const cancelled = make(undefined);
  await cancelled.send({ id: 'r2', type: 'window.reload' });
  assert.equal(reloads, 1, 'a dismissed modal never reloads the window');
  assert.equal(cancelled.posted.find(m => m.type === 'result').cancelled, true);
});

test('unsupported restarts surface the platform limitation rather than a transient failure', async () => {
  const unsupported = panelHarness('重启', async () => { throw new Error('restart_unsupported'); });
  await unsupported.send({ id: 'u', type: 'app.restart' });
  const result = unsupported.posted.find(m => m.type === 'result');
  assert.equal(result.ok, false);
  assert.equal(result.error, '当前环境不支持重启 Devin。');
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

// An `open` replacement that logs every invocation; on call `succeedsAt` it
// spawns the fake app for `transientMs` (mimicking a launch that immediately
// self-terminates under LaunchServices) and on later calls for `stableMs`.
function fakeOpen(dir, executable, { succeedsAt = 1, transientMs = 0, stableMs = 30000 } = {}) {
  const log = path.join(dir, 'open-calls');
  const pids = path.join(dir, 'open-pids');
  const script = path.join(dir, 'fake-open.sh');
  fs.writeFileSync(script, [
    `echo call >> '${log}'`,
    `n=$(wc -l < '${log}' | tr -d ' ')`,
    `lifetime=${transientMs ? `$([ "$n" -eq ${succeedsAt} ] && echo ${transientMs} || echo ${stableMs})` : stableMs}`,
    `[ "$n" -lt ${succeedsAt} ] && exit 0`,
    `'${executable}' -e "setTimeout(() => {}, $lifetime)" >/dev/null 2>&1 &`,
    `echo $! >> '${pids}'`,
  ].join('\n'));
  return {
    open: `/bin/sh '${script}'`,
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0,
    killSpawned: () => {
      if (!fs.existsSync(pids)) return;
      for (const line of fs.readFileSync(pids, 'utf8').trim().split('\n')) {
        try { process.kill(Number(line)); } catch {}
      }
    },
  };
}

function waitExit(child, ms) {
  return Promise.race([
    new Promise(resolve => child.once('exit', code => resolve(code))),
    delay(ms).then(() => { child.kill(); throw new Error('the relaunch helper hung'); }),
  ]);
}

test('the helper reopens only after the app exits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-restart-'));
  let app, helper;
  try {
    const { bundle, executable } = fakeApp(dir);
    app = spawn(executable, ['-e', 'setTimeout(() => {}, 1200)'], { stdio: 'ignore' });
    const marker = path.join(dir, 'reopened');
    helper = spawn('/bin/sh', ['-c', relaunchScript(bundle, 20, `/usr/bin/touch '${marker}'`, { settle: 0, rounds: 2, verify: 1 })], { stdio: 'ignore' });
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

test('a still-running app is never opened again', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-restart-'));
  const { bundle, executable } = fakeApp(dir);
  const logFile = path.join(dir, 'restart.log');
  const gate = fakeOpen(dir, executable);
  const app = spawn(executable, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'ignore' });
  t.after(() => { app.kill(); gate.killSpawned(); fs.rmSync(dir, { recursive: true, force: true }); });
  const helper = spawn('/bin/sh', ['-c', relaunchScript(bundle, 1, gate.open, { settle: 0, rounds: 3, verify: 1, logFile, label: 'test-' + process.pid })], { stdio: 'ignore' });
  assert.equal(await waitExit(helper, 8000), 0);
  assert.equal(gate.calls(), 0, 'the helper gives up on a cancelled quit instead of launching');
  const log = fs.readFileSync(logFile, 'utf8');
  assert.match(log, /helper-started/);
  assert.match(log, /quit-cancelled/, 'a cancelled quit is logged');
  assert.doesNotMatch(log, /attempt/, 'and no launch was attempted');
});

test('the helper retries open until the app is confirmed running', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-restart-'));
  const { bundle, executable } = fakeApp(dir);
  const gate = fakeOpen(dir, executable, { succeedsAt: 3 });
  t.after(() => { gate.killSpawned(); fs.rmSync(dir, { recursive: true, force: true }); });
  const helper = spawn('/bin/sh', ['-c', relaunchScript(bundle, 20, gate.open, { settle: 0, rounds: 5, verify: 2 })], { stdio: 'ignore' });
  assert.equal(await waitExit(helper, 20000), 0);
  assert.equal(gate.calls(), 3, 'the first two failed opens are retried, the third succeeds');
});

test('the log records which round and channel actually succeeded', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-restart-'));
  const { bundle, executable } = fakeApp(dir);
  const logFile = path.join(dir, 'restart.log');
  const gate = fakeOpen(dir, executable, { succeedsAt: 2 });
  t.after(() => { gate.killSpawned(); fs.rmSync(dir, { recursive: true, force: true }); });
  const helper = spawn('/bin/sh', ['-c', relaunchScript(bundle, 20, gate.open, { settle: 0, rounds: 2, verify: 1, logFile })], { stdio: 'ignore' });
  assert.equal(await waitExit(helper, 20000), 0);
  const log = fs.readFileSync(logFile, 'utf8');
  assert.match(log, /attempt 1 channel=open/);
  assert.match(log, /attempt 2 channel=open/);
  assert.match(log, /confirmed round=2/, 'the winning round is observable in the log');
});

test('the helper does not open again once the first relaunch is confirmed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-restart-'));
  const { bundle, executable } = fakeApp(dir);
  const gate = fakeOpen(dir, executable, { succeedsAt: 1 });
  t.after(() => { gate.killSpawned(); fs.rmSync(dir, { recursive: true, force: true }); });
  const helper = spawn('/bin/sh', ['-c', relaunchScript(bundle, 20, gate.open, { settle: 0, rounds: 5, verify: 2 })], { stdio: 'ignore' });
  assert.equal(await waitExit(helper, 15000), 0);
  assert.equal(gate.calls(), 1, 'a confirmed launch ends the loop');
});

test('a launch that dies within seconds is not mistaken for success', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-restart-'));
  const { bundle, executable } = fakeApp(dir);
  const gate = fakeOpen(dir, executable, { succeedsAt: 1, transientMs: 1500 });
  t.after(() => { gate.killSpawned(); fs.rmSync(dir, { recursive: true, force: true }); });
  const helper = spawn('/bin/sh', ['-c', relaunchScript(bundle, 20, gate.open, { settle: 0, rounds: 4, verify: 2 })], { stdio: 'ignore' });
  assert.equal(await waitExit(helper, 20000), 0);
  assert.ok(gate.calls() >= 2, 'the transient launch is detected as gone and open is retried');
});

test('the helper gives up within its budget when open never relaunches', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-restart-'));
  const { bundle } = fakeApp(dir);
  const gate = fakeOpen(dir, path.join(dir, 'unused'), { succeedsAt: 99 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const helper = spawn('/bin/sh', ['-c', relaunchScript(bundle, 20, gate.open, { settle: 0, rounds: 3, verify: 1 })], { stdio: 'ignore' });
  assert.equal(await waitExit(helper, 15000), 1, 'exhausting the budget exits non-zero');
  assert.equal(gate.calls(), 3, 'every round ran, then the helper stopped on its own');
});

test('the helper removes stale instance handles once the app is gone', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-restart-'));
  const { bundle } = fakeApp(dir);
  const userData = path.join(dir, 'user data');
  fs.mkdirSync(userData);
  const sock = path.join(userData, '9.9-main.sock'), lock = path.join(userData, 'code.lock');
  fs.writeFileSync(sock, ''); fs.writeFileSync(lock, '12345');
  const logFile = path.join(dir, 'restart.log');
  const gate = fakeOpen(dir, path.join(dir, 'unused'), { succeedsAt: 99 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const helper = spawn('/bin/sh', ['-c', relaunchScript(bundle, 20, gate.open, { settle: 0, rounds: 1, verify: 1, logFile, userData })], { stdio: 'ignore' });
  assert.equal(await waitExit(helper, 15000), 1);
  assert.equal(fs.existsSync(sock), false, 'the stale ipc socket is removed');
  assert.equal(fs.existsSync(lock), false, 'the stale lockfile is removed');
  assert.match(fs.readFileSync(logFile, 'utf8'), /cleaned-stale/);
});

test('the helper logs its lifecycle to the log file', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-restart-'));
  const { bundle, executable } = fakeApp(dir);
  const logFile = path.join(dir, 'restart.log');
  const failing = fakeOpen(dir, executable, { succeedsAt: 99 });
  t.after(() => { failing.killSpawned(); fs.rmSync(dir, { recursive: true, force: true }); });
  const helper = spawn('/bin/sh', ['-c', relaunchScript(bundle, 20, failing.open, { settle: 0, rounds: 10, verify: 1, logFile })], { stdio: 'ignore' });
  assert.equal(await waitExit(helper, 25000), 1);
  const log = fs.readFileSync(logFile, 'utf8');
  assert.match(log, /helper-started pid=\d+/);
  assert.match(log, /app-exited/);
  assert.match(log, /attempt \d channel=open rc=\d+/);
  assert.match(log, /attempt \d channel=open-new rc=\d+/, 'rounds past the 50% mark log the open-new channel');
  assert.match(log, /attempt \d channel=exec rc=\d+/, 'the last rounds exec the executable directly');
  assert.match(log, /gave-up/);
});

test('a confirmed relaunch is logged and stops the helper', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-restart-'));
  const { bundle, executable } = fakeApp(dir);
  const logFile = path.join(dir, 'restart.log');
  const gate = fakeOpen(dir, executable, { succeedsAt: 1 });
  t.after(() => { gate.killSpawned(); fs.rmSync(dir, { recursive: true, force: true }); });
  const helper = spawn('/bin/sh', ['-c', relaunchScript(bundle, 20, gate.open, { settle: 0, rounds: 4, verify: 2, logFile, label: 'test-' + process.pid })], { stdio: 'ignore' });
  assert.equal(await waitExit(helper, 15000), 0);
  assert.match(fs.readFileSync(logFile, 'utf8'), /confirmed round=1/);
});

test('launchctl submit runs the helper detached from the app', async t => {
  if (process.platform !== 'darwin' || !fs.existsSync('/bin/launchctl')) return t.skip('launchctl is macOS only');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-restart-'));
  const { bundle, executable } = fakeApp(dir);
  const label = 'devin-fusion-byok-restart-test-' + process.pid;
  const marker = path.join(dir, 'relaunched');
  const app = spawn(executable, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => {
    app.kill();
    try { execFileSync('/bin/launchctl', ['remove', label]); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const submit = await new Promise(resolve => {
    const child = spawn('/bin/launchctl', ['submit', '-l', label, '--', '/bin/sh', '-c',
      relaunchScript(bundle, 20, `/usr/bin/touch '${marker}'`, { settle: 0, rounds: 2, verify: 1 })], { stdio: 'ignore' });
    child.once('exit', resolve);
    child.once('error', () => resolve(1));
  });
  if (submit !== 0) return t.skip('launchctl submit is unavailable in this environment');
  await delay(500);
  assert.equal(fs.existsSync(marker), false, 'the submitted helper waits while the app is alive');
  app.kill();
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await delay(200);
  assert.equal(fs.existsSync(marker), true, 'the launchd job relaunched the app after it exited');
});

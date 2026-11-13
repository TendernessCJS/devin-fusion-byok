#!/usr/bin/env node
// Read-only post-upgrade install re-verification: static contract, runtime
// contract cache, installed extension identity, runtime log aggregation.
// Never writes, never reads config.json, never touches Devin.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const DEFAULT_EXT = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf';
const DEFAULT_STORAGE = path.join(os.homedir(), 'Library/Application Support/Devin/User/globalStorage/local.devin-fusion-byok');
const REPO = path.join(__dirname, '..');
const EXT_HOME = path.join(os.homedir(), '.devin/extensions');
const TEST_FILES = ['test/installed-acp.test.cjs', 'test/goal-idle-regression.test.cjs',
  'test/catalog-emit.test.cjs', 'test/role-exclusions.test.cjs',
  'test/catalog-augment.test.cjs', 'test/native-models-sync.test.cjs'];
const LOG_FIELDS = new Set(['event', 'time', 'model', 'status', 'rpc', 'models', 'matrix',
  'beforeOwn', 'afterOwn', 'mismatch', 'unparsable', 'oversize', 'reasons', 'name',
  'declaredCount', 'phase']);

// ---------- pure functions (unit-testable) ----------

function parseLogLines(text, hours, now) {
  const cutoff = now - hours * 3600e3;
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const at = Date.parse(record.time);
    if (!Number.isFinite(at) || at < cutoff || at > now) continue;
    const projected = {};
    for (const key of LOG_FIELDS) if (key in record) projected[key] = record[key];
    events.push(projected);
  }
  return events;
}

function aggregateLog(events) {
  const chatStatus = {}, chatModel = {};
  let requestErrors = 0, replayFailed = 0, forwardTimeouts = 0, unparsable = 0;
  const replayReasons = {}, toolNames = [];
  let lastCatalog = null;
  for (const e of events) {
    switch (e.event) {
      case 'chat-complete':
        chatStatus[String(e.status ?? 'unknown')] = (chatStatus[String(e.status ?? 'unknown')] || 0) + 1;
        if (e.model) chatModel[e.model] = (chatModel[e.model] || 0) + 1;
        break;
      case 'request-error': requestErrors++; break;
      case 'catalog': lastCatalog = e; break;
      case 'state-envelope-replay-failed':
        replayFailed++;
        if (Array.isArray(e.reasons)) {
          for (const r of e.reasons) replayReasons[r] = (replayReasons[r] || 0) + 1;
        } else if (e.reasons && typeof e.reasons === 'object') {
          for (const [r, n] of Object.entries(e.reasons)) {
            if (Number.isInteger(n) && n > 0) replayReasons[r] = (replayReasons[r] || 0) + n;
          }
        }
        break;
      case 'tool-name-unknown': if (e.name) toolNames.push(e.name); break;
      case 'forward-timeout': forwardTimeouts++; break;
    }
    if (e.unparsable) unparsable++;
  }
  const chatTotal = Object.values(chatStatus).reduce((a, b) => a + b, 0);
  return { total: events.length, chatTotal, chatStatus, chatModel, requestErrors,
    replayFailed, replayReasons, toolNames, forwardTimeouts, lastCatalog, unparsable };
}

function evaluateLog(agg) {
  // INFO-only signals (replay-failed / tool-name-unknown / forward-timeout)
  // must never produce WARN or FAIL — this mapping is a hard contract.
  const infos = [];
  if (agg.replayFailed) {
    const reasons = Object.keys(agg.replayReasons).length ? `(reasons ${JSON.stringify(agg.replayReasons)})` : '';
    infos.push(`state-envelope-replay-failed × ${agg.replayFailed}${reasons}`);
  }
  if (agg.toolNames.length) infos.push(`tool-name-unknown: ${[...new Set(agg.toolNames)].join(', ')}`);
  if (agg.forwardTimeouts) infos.push(`forward-timeout × ${agg.forwardTimeouts}`);
  const warns = [];
  const nonOk = Object.fromEntries(Object.entries(agg.chatStatus).filter(([k]) => k !== '200'));
  if (Object.keys(nonOk).length) warns.push(`chat-complete 非 200: ${JSON.stringify(nonOk)}`);
  if (agg.requestErrors > 0) warns.push(`request-error × ${agg.requestErrors}`);
  if (!agg.lastCatalog) warns.push('窗口内未见目录注入');
  else if (agg.lastCatalog.afterOwn === 0) warns.push('未见 BYOK 条目注入');
  return { infos, warns };
}

function evaluateContractCache(cache, appVersion) {
  const checks = [];
  if (cache === null) {
    checks.push({ level: 'FAIL', message: '扩展从未在该版本上激活（无 native-contract.json）' });
    return checks;
  }
  if (appVersion == null || appVersion === '') {
    checks.push({ level: 'FAIL', message: '无法取得本体版本,无法判定契约缓存是否 stale' });
    return checks;
  }
  if (cache.appVersion !== appVersion) {
    checks.push({ level: 'FAIL', message: `stale:契约缓存在 ${cache.appVersion},本体已 ${appVersion};重载 Devin 后复验` });
    return checks;
  }
  if (cache.status !== 'ok') {
    checks.push({ level: 'FAIL', message: `契约缓存 status=${cache.status}`, data: { missing: cache.missing } });
  }
  if (cache.missing && typeof cache.missing === 'object' && Object.keys(cache.missing).length) {
    checks.push({ level: 'FAIL', message: '契约缓存 missing 非空', data: { missing: cache.missing } });
  }
  if (!checks.length) checks.push({ level: 'PASS', message: `运行期契约缓存 ok(版本 ${cache.appVersion})` });
  return checks;
}

// compareTrees(installedRoot, repoRoot): installed 侧独有标 (repo 缺),repo 侧独有标 (installed 缺);
// 只在一侧存在且递归不含任何文件的目录进 emptyDirs,不进 diffs。
function compareTrees(installedRoot, repoRoot) {
  const diffs = [], emptyDirs = [];
  const hasFile = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .some(e => e.isDirectory() ? hasFile(path.join(dir, e.name)) : true);
  const walk = (dirA, dirB, rel) => {
    const namesA = new Set(fs.readdirSync(dirA)), namesB = new Set(fs.readdirSync(dirB));
    for (const name of namesA) {
      const relPath = rel ? rel + '/' + name : name;
      const pa = path.join(dirA, name), pb = path.join(dirB, name);
      if (!namesB.has(name)) {
        (fs.statSync(pa).isDirectory() && !hasFile(pa) ? emptyDirs : diffs).push(relPath + ' (repo 缺)');
        continue;
      }
      const sa = fs.statSync(pa), sb = fs.statSync(pb);
      if (sa.isDirectory() !== sb.isDirectory()) { diffs.push(relPath + ' (类型)'); continue; }
      if (sa.isDirectory()) walk(pa, pb, relPath);
      else if (crypto.createHash('sha256').update(fs.readFileSync(pa)).digest('hex') !==
               crypto.createHash('sha256').update(fs.readFileSync(pb)).digest('hex')) diffs.push(relPath);
    }
    for (const name of namesB) {
      if (namesA.has(name)) continue;
      const relPath = rel ? rel + '/' + name : name;
      const pb = path.join(dirB, name);
      (fs.statSync(pb).isDirectory() && !hasFile(pb) ? emptyDirs : diffs).push(relPath + ' (installed 缺)');
    }
  };
  walk(installedRoot, repoRoot, '');
  return { diffs, emptyDirs };
}

function verdictOf(checks) {
  if (checks.some(c => c.level === 'FAIL')) return 'fail';
  if (checks.some(c => c.level === 'WARN')) return 'warn';
  return 'ok';
}

// ---------- main ----------

function usage() {
  console.error('usage: node scripts/verify-install.cjs [--hours=24] [--json] [--with-tests] [--storage=<abs>] [--extension-path=<abs>]');
  process.exit(2);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.log(`FAIL [internal] ${error && error.message ? error.message : String(error)}`);
    console.log('verdict: fail');
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  let hours = 24, json = false, withTests = false, storage = DEFAULT_STORAGE, extensionPath = DEFAULT_EXT;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '--with-tests') withTests = true;
    else if (arg.startsWith('--hours=')) { hours = Number(arg.slice(8)); if (!(hours > 0)) usage(); }
    else if (arg.startsWith('--storage=')) storage = arg.slice(10);
    else if (arg.startsWith('--extension-path=')) extensionPath = arg.slice(17);
    else usage();
  }
  if (!fs.existsSync(extensionPath)) usage();

  const checks = [], push = (id, level, message, data) => checks.push({ id, level, message, data });
  const now = Date.now();

  // A. static contract
  let version = null;
  const probe = spawnSync(process.execPath,
    [path.join(__dirname, 'native-contract-report.cjs'), '--json', `--extension-path=${extensionPath}`],
    { encoding: 'utf8', maxBuffer: 64 << 20 });
  let report = null;
  if (probe.status === 0) { try { report = JSON.parse(probe.stdout); } catch { report = null; } }
  if (!report) push('contract', 'FAIL', '契约报告执行失败', { stderr: (probe.stderr || '').slice(0, 300) });
  else {
    version = report.version;
    if (report.status === 'ok') push('contract', 'PASS', `静态契约 ok(Devin ${version})`);
    else if (report.status === 'drift') push('contract', 'FAIL', '静态契约 drift', { missing: report.missing });
    else push('contract', 'FAIL', `静态契约 unavailable`, { code: report.code });
  }

  // B. runtime contract cache + catalog-unknown receipt
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(path.join(storage, 'native-contract.json'), 'utf8')); } catch {}
  for (const c of evaluateContractCache(cache, version)) push('contract-cache', c.level, c.message, c.data);
  push('catalog-unknown', fs.existsSync(path.join(storage, 'catalog-unknown.json')) ? 'FAIL' : 'PASS',
    fs.existsSync(path.join(storage, 'catalog-unknown.json')) ? '出现白名单外的原生目录 RPC' : '无未知目录 RPC');

  // C. installed extension identity
  const repoPkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const installedDir = path.join(EXT_HOME, `local.devin-fusion-byok-${repoPkg.version}`);
  if (!fs.existsSync(installedDir)) push('installed', 'FAIL', `未安装该版本(${repoPkg.version})`);
  else if (!fs.existsSync(path.join(installedDir, 'src'))) push('installed', 'FAIL', '已安装目录缺少 src/');
  else {
    let instPkg = null;
    try { instPkg = JSON.parse(fs.readFileSync(path.join(installedDir, 'package.json'), 'utf8')); } catch {}
    if (!instPkg) push('installed', 'FAIL', '已安装 package.json 不可解析');
    else {
      const mismatches = ['name', 'publisher', 'version'].filter(k => instPkg[k] !== repoPkg[k]);
      if (mismatches.length) push('installed', 'FAIL', '已安装 package.json 与仓库不一致', { mismatches });
      else {
        const { diffs, emptyDirs } = compareTrees(path.join(installedDir, 'src'), path.join(REPO, 'src'));
        if (diffs.length) push('installed', 'FAIL', '已安装代码与仓库不一致,需重新打包安装', { diffs: diffs.slice(0, 10), total: diffs.length });
        else if (emptyDirs.length) push('installed', 'WARN', '已安装包含仓库已删除的空目录,建议重新打包安装', { emptyDirs: emptyDirs.slice(0, 10), total: emptyDirs.length });
        else push('installed', 'PASS', `装的正是这份代码(local.devin-fusion-byok-${repoPkg.version})`);
      }
    }
  }

  // D. runtime log aggregation
  let agg = null;
  const logPath = path.join(storage, 'runtime.log');
  if (!fs.existsSync(logPath)) push('log', 'FAIL', '窗口内无运行记录(runtime.log 不存在)');
  else {
    agg = aggregateLog(parseLogLines(fs.readFileSync(logPath, 'utf8'), hours, now));
    if (!agg.total) push('log', 'FAIL', `窗口内(${hours}h)无运行记录`);
    else {
      push('log', 'PASS', `窗口内 ${agg.total} 条事件;chat-complete ${agg.chatTotal} 条(状态 ${JSON.stringify(agg.chatStatus)});request-error ${agg.requestErrors}`);
      const { infos, warns } = evaluateLog(agg);
      for (const m of warns) push('log', 'WARN', m);
      for (const m of infos) push('log', 'INFO', m);
      if (agg.lastCatalog) push('log', 'INFO', `最近 catalog: ${agg.lastCatalog.rpc} models=${agg.lastCatalog.models} matrix=${agg.lastCatalog.matrix} own ${agg.lastCatalog.beforeOwn}→${agg.lastCatalog.afterOwn}`);
    }
  }

  // E. optional narrow tests
  let tests = null;
  if (withTests) {
    const run = spawnSync(process.execPath, ['--test', ...TEST_FILES], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 });
    const out = run.stdout + run.stderr;
    const num = key => { const m = out.match(new RegExp(`ℹ ${key} (\\d+)`)); return m ? Number(m[1]) : null; };
    tests = { pass: num('pass'), fail: num('fail'), skipped: num('skipped') };
    if (tests.fail === null) push('tests', 'FAIL', '窄测输出无法解析');
    else if (tests.fail > 0) push('tests', 'FAIL', `窄测失败 ${tests.fail}`);
    else if (tests.skipped > 0) push('tests', 'FAIL', '测试被跳过,说明 bundle 抽取锚点漂移');
    else push('tests', 'PASS', `窄测 ${tests.pass} 通过 / 0 失败 / 0 跳过`);
  }

  const verdict = verdictOf(checks.map(c => ({ level: c.level })));
  const exitCode = verdict === 'fail' ? 1 : 0;
  if (json) {
    console.log(JSON.stringify({ verdict, exitCode, version, hours, checks, log: agg, tests }, null, 2));
  } else {
    for (const c of checks) {
      console.log(`${c.level.padEnd(4)} [${c.id}] ${c.message}${c.data ? ' ' + JSON.stringify(c.data).slice(0, 400) : ''}`);
    }
    console.log(`verdict: ${verdict}`);
    if (verdict === 'fail') console.log('建议:先重载 Devin 再复验;若「已安装代码不一致」请重新打包安装;漂移请核对 docs/devin-3.12.28-review.md。');
    else if (verdict === 'warn') console.log('建议:窗口内有警告项,非阻断;详情见上方 WARN 行。');
  }
  process.exit(exitCode);
}

module.exports = { parseLogLines, aggregateLog, evaluateLog, evaluateContractCache, compareTrees, verdictOf };

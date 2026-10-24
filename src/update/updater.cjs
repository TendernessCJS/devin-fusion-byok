'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { allowedUrl } = require('./url-policy.cjs');
const { requestBytes } = require('./download.cjs');
const { maskProxy, parseProxy } = require('./proxy-config.cjs');
const REPOSITORY = 'TendernessCJS/devin-fusion-byok';
const PAGE = `https://github.com/${REPOSITORY}/releases`;
const API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const INTERVAL = 6 * 60 * 60 * 1000;
const MAX = 50 * 1024 * 1024;
const CHECK_FAILED = '检查更新失败：网络不可达。若本机需经代理访问 GitHub，请在「设置」页填写「更新代理」。不代表已是最新版。';
const PROXY_INVALID = '检查更新失败：updateProxy 代理地址无效，请修正或移除后重试。不代表已是最新版。';
function parseVersion(v) {
  if (typeof v !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)) throw Error('version');
  const parts = v.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw Error('version');
  return parts;
}
function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
function releaseInfo(value) {
  if (!value || value.draft || value.prerelease || typeof value.tag_name !== 'string') throw Error('release');
  const version = value.tag_name.replace(/^v/, ''); parseVersion(version);
  const name = `devin-fusion-byok-${version}.vsix`;
  const url = `${PAGE}/download/${value.tag_name}/${name}`;
  const asset = value.assets?.find(a => a.name === name);
  const installable = !!asset && asset.browser_download_url === url && /^sha256:[a-f0-9]{64}$/.test(asset.digest) && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= MAX;
  return { version, name, url, page: `${PAGE}/tag/${value.tag_name}`, digest: installable ? asset.digest.slice(7) : null, size: installable ? asset.size : null, installable, notes: typeof value.body === 'string' ? value.body.slice(0, 6000) : '' };
}
async function verifyPackage(file, version, run = execFile) {
  const options = { maxBuffer: 1024 * 1024, timeout: 15000 };
  const { stdout } = await run('/usr/bin/unzip', ['-p', file, 'extension/package.json'], options);
  const pkg = JSON.parse(stdout);
  if (pkg.name !== 'devin-fusion-byok' || pkg.publisher !== 'local' || pkg.version !== version) throw Error('identity');
  const xml = String((await run('/usr/bin/unzip', ['-p', file, 'extension.vsixmanifest'], options)).stdout);
  if (/<!|&/.test(xml)) throw Error('xml');
  const identities = [...xml.matchAll(/<Identity\b([^>]*)\/?\s*>/g)];
  if (identities.length !== 1) throw Error('identity');
  const attributes = [...identities[0][1].matchAll(/([\w]+)\s*=\s*["']([^"']*)["']/g)];
  const fields = Object.fromEntries(attributes.map(m => [m[1], m[2]]));
  if (new Set(attributes.map(m => m[1])).size !== attributes.length || fields.Id !== pkg.name || fields.Publisher !== pkg.publisher || fields.Version !== version) throw Error('identity');
}
function createUpdater({ currentVersion, globalState, storagePath, request = requestBytes, install, confirm = async () => false, notify = () => {}, onChange = () => {}, now = Date.now, verify = verifyPackage, proxy = () => '' }) {
  let saved = globalState?.get('fusionByokUpdate', {}) || {};
  let autoCheck = saved.autoCheck !== false, ignoredVersion = saved.ignoredVersion || '';
  let phase = 'idle', error = '', latest = null, disposed = false, timer, pending, installing, abort, lastCheck = 0, announced;
  let writes = Promise.resolve();
  const snapshot = () => { let proxyValue = '';
    try { proxyValue = maskProxy(proxy()); } catch {}
    return { currentVersion, latestVersion: latest?.version || null, phase, error, autoCheck, ignored: latest?.version === ignoredVersion, notes: latest?.notes || '', releaseUrl: latest?.page || PAGE, canInstall: phase === 'available' && latest?.installable === true && typeof install === 'function', installable: latest?.installable === true, proxy: proxyValue };
  };
  const emit = () => { if (!disposed) Promise.resolve().then(() => onChange(snapshot())).catch(() => {}); };
  const proxyConfig = () => parseProxy(proxy());
  const persist = () => {
    const value = { autoCheck, ignoredVersion };
    writes = writes.then(() => globalState?.update('fusionByokUpdate', value)).catch(() => { error = '更新偏好保存失败，请稍后重试。'; emit(); });
    return writes;
  };
  const check = ({ force = false, notify: shouldNotify = true } = {}) => {
    if (disposed || installing || phase === 'installed') return Promise.resolve(snapshot());
    if (pending) return pending;
    if (!force && (!autoCheck || latest && now() - lastCheck < INTERVAL)) return Promise.resolve(snapshot());
    let via;
    try { via = proxyConfig(); } catch {
      phase = 'error'; error = PROXY_INVALID; emit();
      return Promise.resolve(snapshot());
    }
    phase = 'checking'; error = ''; emit(); abort = new AbortController(); const signal = abort.signal;
    pending = (async () => {
      try {
        const bytes = await request(API, { limit: 1024 * 1024, signal, proxy: via });
        if (disposed) return snapshot();
        latest = releaseInfo(JSON.parse(bytes.toString()));
        const order = compareVersions(latest.version, currentVersion);
        phase = order > 0 ? 'available' : order < 0 ? 'ahead' : 'current'; lastCheck = now();
        if (!force && shouldNotify && autoCheck && phase === 'available' && ignoredVersion !== latest.version && announced !== latest.version) {
          announced = latest.version; Promise.resolve().then(() => { if (!disposed && autoCheck) return notify(snapshot()); }).catch(() => {});
        }
      } catch { if (!disposed) { phase = 'error'; error = CHECK_FAILED; } }
      finally { pending = null; emit(); }
      return snapshot();
    })();
    return pending;
  };
  const installUpdate = () => {
    if (disposed || installing || !snapshot().canInstall) return installing || Promise.resolve(snapshot());
    let via;
    try { via = proxyConfig(); } catch {
      phase = 'available'; error = PROXY_INVALID; emit();
      return Promise.resolve(snapshot());
    }
    const target = latest; phase = 'installing'; error = ''; emit();
    installing = (async () => {
      let directory;
      try {
        if (!await confirm(snapshot()) || disposed) { phase = 'available'; return snapshot(); }
        abort = new AbortController();
        const bytes = await request(target.url, { limit: MAX, signal: abort.signal, proxy: via });
        if (disposed) return snapshot();
        if (bytes.length !== target.size || crypto.createHash('sha256').update(bytes).digest('hex') !== target.digest) throw Error('digest');
        fs.mkdirSync(storagePath, { recursive: true, mode: 0o700 });
        directory = fs.mkdtempSync(path.join(storagePath, 'update-')); fs.chmodSync(directory, 0o700);
        const file = path.join(directory, target.name); fs.writeFileSync(file, bytes, { mode: 0o600 });
        await verify(file, target.version);
        if (disposed) return snapshot();
        await install({ path: file, version: target.version }); phase = 'installed';
      } catch { phase = 'available'; error = '下载、校验或安装失败，未确认更新成功。可以重试或打开发布页面手动安装。'; }
      finally { if (directory) fs.rmSync(directory, { recursive: true, force: true }); installing = null; emit(); }
      return snapshot();
    })();
    return installing;
  };
  return { snapshot, check, installUpdate,
    async ignore() { if (!disposed) { ignoredVersion = latest?.version || ''; await persist(); emit(); } return snapshot(); },
    async setAutoCheck(enabled) { if (!disposed) { autoCheck = enabled === true; await persist(); emit(); } return snapshot(); },
    start() { if (disposed || timer) return; void check(); timer = setInterval(() => { void check(); }, INTERVAL); timer.unref?.(); },
    dispose() { disposed = true; clearInterval(timer); abort?.abort(); }
  };
}
function createUpdateHost({ vscode, context, onChange, proxy, run = execFile, request }) {
  const cli = path.join(vscode.env?.appRoot || '', 'bin', 'devin-desktop');
  const supported = process.platform === 'darwin' && path.isAbsolute(cli) && fs.existsSync(cli);
  let updater;
  updater = createUpdater({ currentVersion: require('../../package.json').version, globalState: context.globalState, storagePath: context.globalStorageUri.fsPath, onChange, proxy, request,
    confirm: async state => await vscode.window.showWarningMessage(`安装 Fusion BYOK ${state.latestVersion}？不会自动重载当前窗口。`, { modal: true }, '安装更新') === '安装更新',
    install: supported ? async ({ path: file }) => { await run(cli, ['--install-extension', file], { timeout: 120000, maxBuffer: 1024 * 1024 }); } : undefined,
    notify: async state => { const action = await vscode.window.showInformationMessage(`Fusion BYOK ${state.latestVersion} 已发布。`, '查看更新', '忽略此版本'); if (action === '查看更新') await vscode.commands.executeCommand('devinFusionByok.openPanel'); else if (action === '忽略此版本') await updater.ignore(); }
  });
  const command = vscode.commands.registerCommand('devinFusionByok.checkUpdates', async () => { await updater.check({ force: true }); await vscode.commands.executeCommand('devinFusionByok.openPanel'); });
  context.subscriptions.push(updater, command); updater.start(); return updater;
}
module.exports = { REPOSITORY, PAGE, compareVersions, parseVersion, releaseInfo, allowedUrl, requestBytes, verifyPackage, createUpdater, createUpdateHost };

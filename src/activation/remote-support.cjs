'use strict';
const fs = require('node:fs');
const path = require('node:path');

// A manifest main may omit the extension: `windsurf-remote-openssh` declares
// `./dist/extension` while the file is `extension.js`. That path is only used
// as the createRequire anchor, and the extension host does not resolve it —
// the install failed with ENOENT on the literal path, so remote support never
// installed at all. Normalise to the file that actually exists.
function resolveMainFile(base) {
  for (const candidate of [base, base + '.js', base + '.json', path.join(base, 'index.js')]) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return null;
}

function discoverRemoteMain(vscode, extensionId, fallbackRel) {
  try {
    const ext = vscode.extensions?.getExtension?.(extensionId);
    if (ext?.extensionPath && ext.packageJSON?.main) return resolveMainFile(path.resolve(ext.extensionPath, ext.packageJSON.main));
    const appRoot = vscode.env?.appRoot;
    return appRoot ? resolveMainFile(path.join(appRoot, fallbackRel)) : null;
  } catch { return null; }
}

// Diagnostics only: remote install failures are swallowed so a broken wrapper
// never breaks activation, which left the log without any cause. Record the
// error code plus a truncated message; no payload from the wrapped modules.
function describeError(error) {
  const code = typeof error?.code === 'string' ? error.code
    : typeof error?.name === 'string' ? error.name : 'error';
  const message = typeof error?.message === 'string' ? error.message.slice(0, 200) : '';
  return message ? { code, message } : { code };
}

function createRemoteSupport({ vscode, root, nativeMain, isEnabled = () => true, log = () => {} }) {
  let install = null, generation = 0, manager = null;
  // One live install per generation: `manager` is the persistent guard, so a
  // completed install is never repeated (a second installRemoteSupport would
  // wrap spawn/resolver a second time and only one copy would be restorable).
  function start() {
    if (manager) return Promise.resolve();
    if (install) return install;
    const current = generation;
    const task = (async () => {
      let installed;
      try {
        installed = require('../runtime/host/remote-tunnel.cjs').installRemoteSupport({
          vscode, nativeMainPath: nativeMain,
          opensshMainPath: discoverRemoteMain(vscode, 'codeium.windsurf-remote-openssh', 'extensions/windsurf-remote-openssh/dist/extension.js'),
          wslMainPath: discoverRemoteMain(vscode, 'codeium.windsurf-remote-wsl', 'extensions/windsurf-remote-wsl/dist/extension.js'),
          root, isEnabled, log });
      } catch (error) { try { log('remote-support-unavailable', describeError(error)); } catch {} return; }
      if (current !== generation) { try { installed.dispose(); } catch {} return; }
      manager = installed;
    })();
    install = task.then(() => { if (install === settled) install = null; });
    const settled = install;
    return install;
  }
  function stop() {
    generation++;
    install = null;
    const current = manager;
    manager = null;
    try { current?.dispose(); } catch {}
  }
  return {
    start,
    stop,
    status: () => manager?.status?.() || [],
    ensureCurrentRemoteWindowTunnel() {
      if (!manager) { try { log('remote-tunnel-unavailable'); } catch {} return Promise.reject(new Error('remote_tunnel_unavailable')); }
      return manager.ensureCurrentRemoteWindowTunnel().catch(error => { try { log('remote-tunnel-unavailable'); } catch {} throw error; });
    },
  };
}

// A local window never installs the remote wrappers, so a host that cannot be
// patched would fail invisibly there. Probe once with injection disabled: the
// wrappers are inert (isEnabled is false), they are disposed immediately, and a
// failure keeps its cause instead of degrading into one unknown event name.
function probeRemoteSupport({ vscode, root, nativeMain, log = () => {} }) {
  let installed;
  try {
    installed = require('../runtime/host/remote-tunnel.cjs').installRemoteSupport({
      vscode, nativeMainPath: nativeMain,
      opensshMainPath: discoverRemoteMain(vscode, 'codeium.windsurf-remote-openssh', 'extensions/windsurf-remote-openssh/dist/extension.js'),
      wslMainPath: discoverRemoteMain(vscode, 'codeium.windsurf-remote-wsl', 'extensions/windsurf-remote-wsl/dist/extension.js'),
      root, isEnabled: () => false, log });
  } catch (error) {
    try { log('remote-support-probe', describeError(error)); } catch {}
    return false;
  }
  try { installed.dispose(); } catch {}
  try { log('remote-support-probe', { installed: true }); } catch {}
  return true;
}

module.exports = { discoverRemoteMain, createRemoteSupport, describeError, probeRemoteSupport };

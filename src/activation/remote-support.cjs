'use strict';
const fs = require('node:fs');
const path = require('node:path');

function discoverRemoteMain(vscode, extensionId, fallbackRel) {
  try {
    const ext = vscode.extensions?.getExtension?.(extensionId);
    if (ext?.extensionPath && ext.packageJSON?.main) return path.resolve(ext.extensionPath, ext.packageJSON.main);
    const appRoot = vscode.env?.appRoot;
    const fallback = appRoot && path.join(appRoot, fallbackRel);
    return fallback && fs.existsSync(fallback) ? fallback : null;
  } catch { return null; }
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
      } catch { try { log('remote-support-unavailable'); } catch {} return; }
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

module.exports = { discoverRemoteMain, createRemoteSupport };

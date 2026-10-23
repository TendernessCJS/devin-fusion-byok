'use strict';
const { staleFusionUids, augmentCatalog } = require('../catalog.cjs');
const { defaultDir: cliCacheDir, refreshStaleCliCaches } = require('../runtime/host/cli-cache.cjs');
const { createPickerRefresh } = require('../runtime/host/picker-refresh.cjs');

function installCacheSync({ deps, shared, publish }) {
  const { config, vscode, context, log, catalog } = deps;
  shared.pickerRefresh = createPickerRefresh({ log,
    // devin.reloadAcpConnections drops every ACP connection on execution —
    // users see "ACP connection closed" and a conversation-area reload, and a
    // window reload follows it by ~5-35s (observed 2026-10-14). The in-place
    // CLI cache rewrite already guarantees what the next session reads, so no
    // command is wired in here; keep the module for signature tracking/tests.
    lightCommands: [],
    executeCommand: command => vscode.commands.executeCommand(command),
    readModels: () => catalog().models,
    observe: () => shared.acpObservationSeq,
    applied: token => shared.acpObservationSeq > token && shared.acpOwnModels > 0 });
  shared.pickerRefresh.prime();
  context.subscriptions.push(shared.pickerRefresh);
  // The CLI intersects its picker with per-identity caches under
  // ~/.cache/devin/cli; a cache written before a config change keeps the old
  // uid digests and drops the affected entries. This CLI never re-fetches a
  // missing file, so stale caches are refreshed in place by rewriting the
  // payload through the same augmentation the backend applies.
  const check = ({ force = false } = {}) => {
    try {
      if (config().enabled === false) return shared.cliCacheReport;
      const current = catalog();
      const expectedUids = current.models.map(model => model.uid);
      if (!expectedUids.length) return shared.cliCacheReport;
      const emittedFusionUids = new Set(Object.keys(current.fusions || {}));
      const knownUids = new Set([...Object.keys(current.routes || {}), ...emittedFusionUids, ...shared.nativeModels.keys()]);
      const excludedUids = role => {
        const set = new Set();
        for (const ref of Array.isArray(config().roleExclusions?.[role]) ? config().roleExclusions[role] : []) {
          if (typeof ref?.nativeUid === 'string') { set.add(ref.nativeUid); continue; }
          for (const [uid, route] of Object.entries(current.routes || {})) {
            if (route.providerId === ref?.providerId && route.model === ref?.model) set.add(uid);
          }
        }
        return set;
      };
      const excluded = { lead: excludedUids('lead'), sidekick: excludedUids('sidekick') };
      const result = refreshStaleCliCaches({ dir: cliCacheDir(), expectedUids, force,
        staleProbe: payload => staleFusionUids(payload, { emitted: emittedFusionUids, known: knownUids, excluded }),
        augment: (payload, rpc, report) => augmentCatalog(payload, { rpc, format: { json: false }, catalog: current, onSkip: report }) });
      // The report is part of panel state, and panel state is deduplicated by
      // its JSON. Restamping `at` on every automatic check made each 3s sync
      // look like a change, so the panel re-rendered forever — killing the
      // focused search box and resetting every list scroll. Record the moment
      // the outcome was established instead, and keep the previous object when
      // the outcome is unchanged (only a manual, forced check always restamps).
      const summary = { checked: result.checked, refreshed: result.refreshed,
        skipped: result.skipped || [], errors: result.errors || [] };
      const previous = shared.cliCacheReport && JSON.stringify({ checked: shared.cliCacheReport.checked,
        refreshed: shared.cliCacheReport.refreshed, skipped: shared.cliCacheReport.skipped, errors: shared.cliCacheReport.errors });
      if (force || previous !== JSON.stringify(summary)) shared.cliCacheReport = { at: new Date().toISOString(), ...summary };
      if (result.refreshed.length) log('cli-cache-refreshed', { files: result.refreshed, force });
      for (const skip of result.skipped || []) log('cli-cache-skip', { name: skip.name, reason: skip.reason });
      for (const error of result.errors || []) log('cli-cache-write-error', { name: error.name, code: error.code });
    } catch (error) { log('cli-cache-check-failed', { code: error?.code || 'unknown' }); }
    return shared.cliCacheReport;
  };
  const changed = () => { shared.pickerRefresh?.changed?.(); check(); };
  // Manual counterpart of the automatic check: the panel button exists so a
  // user whose picker looks stale can force the rewrite now instead of waiting
  // for the next config change or native sync. It is forced because the
  // automatic check only sees uid presence, while a payload can be complete and
  // still carry out-of-date entries (a changed dimension shape, a stale
  // label) — exactly the case the button is for.
  const refresh = async () => {
    const report = check({ force: true });
    await publish();
    return report;
  };
  return { check, changed, refresh };
}

module.exports = { installCacheSync };

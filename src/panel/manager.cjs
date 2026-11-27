'use strict';
const { randomUUID } = require('node:crypto');
const { analyzeRoles, buildCatalog, buildRoleLists, refKey } = require('../catalog.cjs');
const { discover: discoverModels } = require('../models/discovery.cjs');
const { normalizeBaseUrlPath } = require('./base-url.cjs');
const { publicState } = require('./panel-state.cjs');
const { sortByOrder, nextOrder, normalizeOrders } = require('../models/order.cjs');
const { translator } = require('../i18n/index.cjs');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
class PanelInputError extends Error {}
const fail = message => { throw new PanelInputError(message); };
// The validators take the translator and a field key (manager.field.*): the
// message is copy for the panel's error toast, never parsed.
function text(t, value, field, maximum = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) fail(t('manager.invalid', { label: t(field) }));
  return value.trim();
}
function baseUrl(t, value) {
  let url; try { url = new URL(text(t, value, 'manager.field.baseUrl', 2048)); } catch { fail(t('manager.baseUrlIncomplete')); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail(t('manager.baseUrlParts'));
  url.pathname = normalizeBaseUrlPath(url.pathname);
  return url.toString().replace(/\/$/, '');
}
// The discovery endpoint override shares the base URL's validation except
// for path rewriting: it is already a full endpoint, so the path the user
// typed stays authoritative (stripping a trailing /models here would defeat
// the override's only purpose).
function modelsUrl(t, value) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return null;
  let url; try { url = new URL(text(t, value, 'manager.field.modelsUrl', 2048)); } catch { fail(t('manager.modelsUrlIncomplete')); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail(t('manager.modelsUrlParts'));
  return url.toString().replace(/\/$/, '');
}
function staticModelIds(t, value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 200) fail(t('manager.staticInvalid'));
  const ids = [];
  for (const item of value) { const id = text(t, item, 'manager.field.modelId'); if (!ids.includes(id)) ids.push(id); }
  return ids;
}
// One fast variant per model, one claimant per variant, no chains: the matrix
// emission twins entries uid-for-uid, so any ambiguity would silently drop one.
// A fast variant mirrors its base: the twin is keyed by exact effort, so any
// drift in tiers would silently drop the Fast option. Linking overwrites the
// variant's capability fields and every later save of the base re-applies
// them — enabled included, in BOTH directions: the variant row is hidden in
// the panel, so a one-way disable could never be switched back on. Identity,
// label, order and the link itself stay the variant's own.
const FAST_SYNC_FIELDS = ['contextWindow', 'maxOutputTokens', 'efforts', 'effortMode', 'reasoningEffort', 'enabled'];
function syncFastVariants(provider) {
  const byId = new Map(provider.models.map(model => [model.id, model]));
  for (const model of provider.models) {
    if (typeof model.fastModel !== 'string' || !model.fastModel) continue;
    const target = byId.get(model.fastModel);
    if (!target || target === model) continue;
    for (const field of FAST_SYNC_FIELDS) {
      if (own(model, field)) target[field] = Array.isArray(model[field]) ? [...model[field]] : model[field];
      else delete target[field];
    }
  }
}

function validateFastModels(t, provider) {
  const byId = new Map((Array.isArray(provider.models) ? provider.models : []).map(model => [model.id, model]));
  const claimed = new Set();
  for (const model of byId.values()) {
    if (typeof model.fastModel !== 'string' || !model.fastModel) continue;
    if (model.fastModel === model.id) fail(t('manager.fastModelSelf'));
    const target = byId.get(model.fastModel);
    if (!target) fail(t('manager.fastModelMissing'));
    if (typeof target.fastModel === 'string' && target.fastModel) fail(t('manager.fastModelChain'));
    if (claimed.has(model.fastModel)) fail(t('manager.fastModelDuplicate'));
    claimed.add(model.fastModel);
  }
}
function boolean(t, value, field) { if (typeof value !== 'boolean') fail(t('manager.invalid', { label: t(field) })); return value; }
function number(t, value, field) { if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) fail(t('manager.positiveInteger', { label: t(field) })); return value; }
function providerAt(t, config, id) { return config.providers.find(provider => provider.id === id) || fail(t('manager.providerGone')); }
// A role reference to a BYOK model is authoritative in config, so a ref whose
// provider or model is gone can never resolve again — and an unresolvable ref
// renders as a switchless "not in the available list" row, so it would stick
// around with no way to clear it. Native refs are deliberately left alone: the
// native catalog is observed, so an absent uid usually just means "not synced
// yet" and pruning would silently discard a real selection.
function pruneDanglingRoleRefs(config) {
  const models = new Map(config.providers.map(provider => [provider.id, new Set(provider.models.map(model => model.id))]));
  for (const key of ['roleInclusions', 'roleExclusions']) {
    const lists = config[key];
    if (!lists || typeof lists !== 'object') continue;
    for (const role of ['lead', 'sidekick']) {
      if (!Array.isArray(lists[role])) continue;
      const kept = lists[role].filter(ref => typeof ref?.nativeUid === 'string' ||
        (typeof ref?.providerId === 'string' && models.get(ref.providerId)?.has(ref.model)));
      if (!kept.length) delete lists[role]; else lists[role] = kept;
    }
    if (!Object.keys(lists).length) delete config[key];
  }
}
function modelPatch(t, input, previous) {
  const model = { ...previous };
  if (own(input, 'label')) model.label = text(t, input.label, 'manager.field.modelName');
  if (own(input, 'enabled')) model.enabled = boolean(t, input.enabled, 'manager.field.enabled');
  if (own(input, 'supportsImages')) { boolean(t, input.supportsImages, 'manager.field.images'); model.supportsImages = true; }
  if (own(input, 'contextWindow')) model.contextWindow = number(t, input.contextWindow, 'manager.field.contextWindow');
  if (own(input, 'maxOutputTokens')) model.maxOutputTokens = number(t, input.maxOutputTokens, 'manager.field.maxOutput');
  if (own(input, 'efforts')) {
    if (!Array.isArray(input.efforts) || input.efforts.some(v => !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(v))) fail(t('manager.effortsInvalid'));
    if (input.efforts.includes('none')) fail(t('manager.effortsNoneReserved'));
    model.efforts = [...new Set(input.efforts)];
  }
  if (own(input, 'effortMode')) {
    if (!['auto', 'manual', 'none'].includes(input.effortMode)) fail(t('manager.effortModeInvalid'));
    model.effortMode = input.effortMode;
  }
  if (own(input, 'fastModel')) {
    if (input.fastModel === null || input.fastModel === '') delete model.fastModel;
    else model.fastModel = text(t, input.fastModel, 'manager.field.modelId');
  }
  if (own(input, 'reasoningEffort')) {
    if (input.reasoningEffort === null) delete model.reasoningEffort;
    else if (typeof input.reasoningEffort === 'boolean') model.reasoningEffort = input.reasoningEffort;
    else fail(t('manager.invalid', { label: t('models.effort') }));
  }
  if (model.maxOutputTokens > model.contextWindow) fail(t('manager.outputOverContext'));
  return model;
}
function createManager({ read, write, discover = discoverModels, afterChange = async () => {}, selectFusion = async () => {}, nativeModels = () => [], nativeAllowedUids = () => null, refreshNativeModels = async () => {}, refreshCliCaches = null, cliCacheStatus = () => null, nativeContract = () => null, nativeCatalogStatus = () => 'empty', autoContinueStatus = () => 'unavailable', backendStatus = () => 'unknown', health = () => null, acpOwnModels = () => 0, t = translator() }) {
  let queue = Promise.resolve();
  let pendingImport;
  const modelsModeOf = provider => provider.modelsMode || (provider.modelsUrl ? 'url' : 'auto');
  const signature = provider => JSON.stringify([provider.id, provider.baseUrl, provider.apiFormat, provider.apiKey, modelsModeOf(provider), provider.modelsUrl || '', JSON.stringify(provider.staticModels || [])]);
  const state = () => {
    const config = read(), status = nativeCatalogStatus();
    const result = publicState(config, nativeModels(), autoContinueStatus(), status, cliCacheStatus(), nativeAllowedUids(), undefined, acpOwnModels());
    result.nativeContract = nativeContract() || null;
    result.nativeCatalogStatus = status;
    result.backendStatus = backendStatus();
    result.health = health();
    const provider = config.providers.find(p => p.id === pendingImport?.providerId);
    result.importCandidates = provider && signature(provider) === pendingImport.signature ? {
      providerId: provider.id, token: pendingImport.token,
      models: pendingImport.models.map(model => ({ id: model.id, label: model.label || model.id,
        imported: provider.models.some(existing => existing.id === model.id) })),
    } : null;
    return result;
  };
  async function apply(type, payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail(t('manager.payloadInvalid'));
    if (type === 'ready' || type === 'refreshNativeModels') { await refreshNativeModels(); return state(); }
    if (type === 'refreshCliCaches') {
      if (read().enabled === false) fail(t('manager.cacheNeedsEnabled'));
      if (typeof refreshCliCaches !== 'function') fail(t('manager.cacheUnsupported'));
      await refreshCliCaches();
      return state();
    }
    let config = read();
    let baseline = structuredClone(config);
    // The native observation is pinned to one snapshot per operation so the
    // candidate checks and the commit-time validation never mix two reads of a
    // moving catalog. The analysis is bound to the config object it was built
    // from: a reassigned config (refreshModels) re-analyzes automatically, and
    // in-place mutations invalidate it explicitly before validation, so the
    // final buildCatalog always sees the state being written.
    let observedSnapshot, analysis, analyzedConfig;
    const observed = () => observedSnapshot ||
      (observedSnapshot = { models: nativeModels(), allowed: nativeAllowedUids() });
    const roleAnalysis = () => {
      if (analyzedConfig !== config) {
        analysis = analyzeRoles(config, observed().models, observed().allowed);
        analyzedConfig = config;
      }
      return analysis;
    };
    if (type === 'selectFusion') {
      if (config.enabled === false) fail(t('manager.needsEnabled'));
      if (!own(buildCatalog(config, observed().models, observed().allowed, roleAnalysis()).fusions, payload.uid)) fail(t('manager.fusionGone'));
      await selectFusion(payload.uid); return state();
    }
    switch (type) {
      case 'saveProvider': {
        const existing = payload.id ? providerAt(t, config, payload.id) : null;
        const name = text(t, payload.name, 'manager.field.providerName', 80), url = baseUrl(t, payload.baseUrl);
        if (!['openai-responses', 'openai', 'anthropic'].includes(payload.apiFormat)) fail(t('manager.apiTypeRequired'));
        if (own(payload, 'apiKey') && (typeof payload.apiKey !== 'string' || payload.apiKey.length > 8192 || /[\r\n]/.test(payload.apiKey))) fail(t('manager.apiKeyInvalid'));
        const apiKey = payload.apiKey?.trim() || existing?.apiKey || '';
        // The mode alone decides whether modelsUrl is read, mirroring the
        // effort mode contract: outside 'url' it is ignored, not rewritten.
        const mode = payload.modelsMode;
        if (!['auto', 'url', 'manual'].includes(mode)) fail(t('manager.modelsModeInvalid'));
        const listUrl = mode === 'url' ? modelsUrl(t, payload.modelsUrl) : null;
        if (mode === 'url' && !listUrl) fail(t('manager.modelsUrlRequired'));
        // Static IDs feed the manual-mode picker only; they never join a
        // discovery request, and removing one never removes a configured model.
        const statics = mode === 'manual' ? staticModelIds(t, payload.staticModels) : [];
        if (existing) {
          const previousName = existing.name;
          Object.assign(existing, { name, baseUrl: url, apiFormat: payload.apiFormat, apiKey, modelsMode: mode });
          // Each key belongs to exactly one mode: the mode that owns it writes or
          // clears it, every other mode leaves it untouched. The read side gates on
          // the mode alone, so a preserved key is inert rather than active, and
          // switching back finds the previous configuration still there.
          if (mode === 'url') { if (listUrl) existing.modelsUrl = listUrl; else delete existing.modelsUrl; }
          if (mode === 'manual') { if (statics.length) existing.staticModels = statics; else delete existing.staticModels; }
          if (name !== previousName) for (const model of existing.models) if (model.label?.startsWith(previousName + ' · ')) model.label = name + model.label.slice(previousName.length);
        } else {
          normalizeOrders(config.providers);
          config.providers.push({ id: 'provider-' + randomUUID(), name, baseUrl: url, apiFormat: payload.apiFormat, apiKey, modelsMode: mode,
            enabled: true, order: nextOrder(config.providers), models: [], ...(listUrl ? { modelsUrl: listUrl } : {}),
            ...(statics.length ? { staticModels: statics } : {}) });
        }
        break;
      }
      case 'deleteProvider': providerAt(t, config, payload.id); config.providers = config.providers.filter(p => p.id !== payload.id); break;
      case 'setProviderEnabled': providerAt(t, config, payload.id).enabled = boolean(t, payload.enabled, 'manager.field.enabled'); break;
      case 'refreshModels': {
        const original = providerAt(t, config, payload.providerId);
        if (modelsModeOf(original) === 'manual') {
          // A manual provider has no list endpoint to call: the configured static
          // IDs become the candidates so the import picker stays one code path.
          // Clearing first mirrors the discovery branch, so a failure never leaves
          // another provider's candidates standing.
          pendingImport = undefined;
          const ids = (original.staticModels || []).filter(value => typeof value === 'string' && value);
          if (!ids.length) fail(t('manager.staticSourceEmpty'));
          const candidates = ids.map(id => ({ id, label: original.name + ' · ' + id, efforts: [],
            contextWindow: 272000, maxOutputTokens: 131072, source: 'manual' }));
          buildCatalog({ ...config, providers: [{ ...original, enabled: true, models: candidates }] }); // Same candidate validation as discovery.
          pendingImport = { providerId: original.id, signature: signature(original), token: randomUUID(), models: candidates };
          return state();
        }
        const fetched = structuredClone(original);
        pendingImport = undefined;
        await discover(fetched);
        // Read again after the network request so another window's edits survive.
        config = read(); baseline = structuredClone(config);
        const current = providerAt(t, config, payload.providerId);
        if (signature(current) !== signature(original)) fail(t('manager.providerChanged'));
        // Validate a private candidate catalog, without changing saved models.
        buildCatalog({ ...config, providers: [{ ...current, enabled: true, models: fetched.models }] });
        pendingImport = { providerId: current.id, signature: signature(current), token: randomUUID(), models: fetched.models };
        return state();
      }
      case 'importModels': {
        const provider = providerAt(t, config, payload.providerId);
        if (!pendingImport || pendingImport.providerId !== provider.id || pendingImport.token !== payload.token ||
            pendingImport.signature !== signature(provider)) fail(t('manager.candidatesExpired'));
        if (!Array.isArray(payload.ids) || !payload.ids.length || payload.ids.some(id => typeof id !== 'string') ||
            new Set(payload.ids).size !== payload.ids.length) fail(t('manager.pickModels'));
        const candidates = new Map(pendingImport.models.map(model => [model.id, model]));
        if (payload.ids.some(id => !candidates.has(id))) fail(t('manager.pickNotListed'));
        const existing = new Set(provider.models.map(model => model.id));
        normalizeOrders(provider.models);
        for (const id of payload.ids) if (!existing.has(id)) {
          const candidate = candidates.get(id);
          provider.models.push({ ...candidate, label: provider.name + ' · ' + id, enabled: true,
            order: nextOrder(provider.models) });
        }
        // An imported model can complete a fast link written ahead of it (the
        // implicit import-on-save flow, or a hand-edited config): validate and
        // replay the sync right away instead of waiting for the next save.
        validateFastModels(t, provider);
        syncFastVariants(provider);
        break;
      }
      case 'updateModels': {
        const provider = providerAt(t, config, payload.providerId);
        if (!Array.isArray(payload.changes || []) || !Array.isArray(payload.removeIds || [])) fail(t('manager.changesInvalid'));
        for (const change of payload.changes || []) {
          const index = provider.models.findIndex(m => m.id === change?.id);
          if (index < 0) fail(t('manager.modelGone'));
          provider.models[index] = modelPatch(t, change, provider.models[index]);
        }
        provider.models = provider.models.filter(m => !(payload.removeIds || []).includes(m.id));
        // A gone fast variant can never resolve again; clear the reference
        // instead of failing the write, mirroring pruneDanglingRoleRefs.
        const removed = new Set(payload.removeIds || []);
        for (const model of provider.models) if (removed.has(model.fastModel)) delete model.fastModel;
        validateFastModels(t, provider);
        syncFastVariants(provider);
        break;
      }
      case 'addModel': {
        const provider = providerAt(t, config, payload.providerId), input = payload.model;
        const id = text(t, input?.id, 'manager.field.modelId');
        if (provider.models.some(m => m.id === id)) fail(t('manager.modelExists'));
        normalizeOrders(provider.models);
        provider.models.push(modelPatch(t, input, { id, label: id, enabled: true, efforts: [], contextWindow: 272000,
          maxOutputTokens: 131072, source: 'manual', order: nextOrder(provider.models) }));
        validateFastModels(t, provider);
        syncFastVariants(provider);
        break;
      }
      case 'addModels': {
        const provider = providerAt(t, config, payload.providerId);
        if (!Array.isArray(payload.ids) || !payload.ids.length || payload.ids.length > 200) fail(t('manager.modelsBulkInvalid'));
        const ids = [];
        for (const value of payload.ids) { const id = text(t, value, 'manager.field.modelId'); if (!ids.includes(id)) ids.push(id); }
        normalizeOrders(provider.models);
        for (const id of ids) {
          if (provider.models.some(m => m.id === id)) continue;
          provider.models.push({ id, label: provider.name + ' · ' + id, enabled: true, efforts: [],
            contextWindow: 272000, maxOutputTokens: 131072, source: 'manual', order: nextOrder(provider.models) });
        }
        validateFastModels(t, provider);
        syncFastVariants(provider);
        break;
      }
      case 'setNativeModelHidden': {
        const raw = Array.isArray(payload.uids) ? payload.uids : [payload.uid];
        if (!raw.length || raw.length > 256) fail(t('manager.uidInvalid'));
        const hidden = boolean(t, payload.hidden, 'manager.field.visibility');
        const observedUids = new Set(observed().models.map(entry => entry?.uid));
        for (const uid of raw) {
          if (typeof uid !== 'string' || !uid || uid.length > 256 || /^(?:fusion-)?dfbyok-/.test(uid)) fail(t('manager.uidInvalid'));
          if (hidden && !observedUids.has(uid)) fail(t('manager.nativeNotListed'));
        }
        const targets = new Set(raw), seen = new Set(), list = [];
        for (const value of Array.isArray(config.hiddenNativeModelUids) ? config.hiddenNativeModelUids : []) {
          if (typeof value !== 'string' || !value || value.length > 256 || /^(?:fusion-)?dfbyok-/.test(value) || seen.has(value)) continue;
          seen.add(value); list.push(value);
        }
        if (hidden) { for (const uid of raw) if (!seen.has(uid)) { seen.add(uid); list.push(uid); } config.hiddenNativeModelUids = list; }
        else config.hiddenNativeModelUids = list.filter(value => !targets.has(value));
        break;
      }
      case 'setRoleModel': {
        const role = payload.role;
        if (role !== 'lead' && role !== 'sidekick') fail(t('manager.roleInvalid'));
        const enabled = boolean(t, payload.enabled, 'manager.field.enabled');
        const model = payload.model;
        if (!model || typeof model !== 'object' || Array.isArray(model)) fail(t('manager.modelParamInvalid'));
        const hasNative = typeof model.nativeUid === 'string' && !!model.nativeUid;
        const hasProvider = typeof model.providerId === 'string' && typeof model.model === 'string' && !!model.providerId && !!model.model;
        if ((hasNative && hasProvider) || (!hasNative && !hasProvider)) fail(t('manager.modelIdentityInvalid'));
        const key = refKey(model);
        if (!key) fail(t('manager.uidInvalid'));

        const currentRoles = buildRoleLists(config, observed().models, observed().allowed, roleAnalysis());
        const candidateList = currentRoles[role] || [];
        const candidate = candidateList.find(item => refKey(item.ref) === key ||
          hasNative && (item.memberUids || []).some(uid => refKey({ nativeUid: uid }) === key));
        if (enabled && (!candidate || !candidate.available)) fail(t('manager.modelUnavailable'));

        if (!config.roleExclusions) config.roleExclusions = { lead: [], sidekick: [] };
        if (!Array.isArray(config.roleExclusions[role])) config.roleExclusions[role] = [];
        if (!config.roleInclusions) config.roleInclusions = { lead: [], sidekick: [] };
        if (!Array.isArray(config.roleInclusions[role])) config.roleInclusions[role] = [];

        const refToStore = hasNative ? { nativeUid: model.nativeUid } : { providerId: model.providerId, model: model.model };
        if (enabled) {
          // A role item may cover an official effort family — clear exclusions
          // recorded on any member uid, not only the item's own ref.
          const memberKeys = new Set((candidate?.memberUids || [model.nativeUid]).map(uid => refKey({ nativeUid: uid })));
          config.roleExclusions[role] = config.roleExclusions[role].filter(r => !memberKeys.has(refKey(r)) && refKey(r) !== key);
          if (hasNative && !config.roleInclusions[role].some(r => refKey(r) === key)) {
            config.roleInclusions[role].push(refToStore);
          }
        } else {
          // Clearing a role item must drop inclusions on every family member,
          // or a stale member ref keeps explicitIncluded set and pins the row.
          const memberKeys = new Set((candidate?.memberUids || [model.nativeUid]).map(uid => refKey({ nativeUid: uid })));
          config.roleInclusions[role] = config.roleInclusions[role].filter(r => !memberKeys.has(refKey(r)) && refKey(r) !== key);
          if (!config.roleExclusions[role].some(r => refKey(r) === key)) {
            config.roleExclusions[role].push(refToStore);
          }
        }
        break;
      }
      case 'forgetRoleRef': {
        const role = payload.role;
        if (role !== 'lead' && role !== 'sidekick') fail(t('manager.roleInvalid'));
        const model = payload.model;
        if (!model || typeof model !== 'object' || Array.isArray(model)) fail(t('manager.modelParamInvalid'));
        const hasNative = typeof model.nativeUid === 'string' && !!model.nativeUid;
        const hasProvider = typeof model.providerId === 'string' && typeof model.model === 'string' && !!model.providerId && !!model.model;
        if ((hasNative && hasProvider) || (!hasNative && !hasProvider)) fail(t('manager.modelIdentityInvalid'));
        const key = refKey(model);
        if (!key) fail(t('manager.uidInvalid'));
        // A native ref is only safe to forget once the catalog has actually
        // been observed — during a pending sync an absent uid may mean "not
        // synced yet", and removing it would silently lose a real pick.
        if (hasNative && nativeCatalogStatus() !== 'ready') fail(t('manager.catalogNotSynced'));
        for (const list of ['roleInclusions', 'roleExclusions']) {
          const refs = config[list]?.[role];
          if (Array.isArray(refs)) config[list][role] = refs.filter(ref => refKey(ref) !== key);
        }
        break;
      }
      case 'moveProvider': {
        if (payload?.delta !== -1 && payload?.delta !== 1) fail(t('manager.directionInvalid'));
        const ordered = sortByOrder(config.providers);
        const index = ordered.findIndex(provider => provider.id === payload.id);
        if (index < 0) fail(t('manager.providerGone'));
        const target = index + payload.delta;
        if (target < 0 || target >= ordered.length) return state();
        normalizeOrders(config.providers);
        const a = ordered[index], b = ordered[target];
        [a.order, b.order] = [b.order, a.order];
        break;
      }
      case 'moveModel': {
        const provider = providerAt(t, config, payload.providerId);
        if (!Number.isSafeInteger(payload?.delta) || payload.delta === 0) fail(t('manager.directionInvalid'));
        const ordered = sortByOrder(provider.models);
        const index = ordered.findIndex(model => model.id === payload.id);
        if (index < 0) fail(t('manager.modelGone'));
        const target = Math.min(Math.max(index + payload.delta, 0), ordered.length - 1);
        if (target === index) return state();
        normalizeOrders(provider.models);
        const a = ordered[index], b = ordered[target];
        [a.order, b.order] = [b.order, a.order];
        break;
      }
      case 'setEnabled': config.enabled = boolean(t, payload.enabled, 'manager.field.enabled'); break;
      case 'setGoalEnabled': config.goalEnabled = boolean(t, payload.enabled, 'manager.field.goal'); break;
      case 'setAutoContinue': config.autoContinueOnProviderError = boolean(t, payload.enabled, 'manager.field.autoContinue'); break;
      case 'setAutoContinueUntilPlanComplete': config.autoContinueUntilPlanComplete = boolean(t, payload.enabled, 'manager.field.autoContinuePlan'); break;
      default: fail(t('manager.unsupported'));
    }
    pruneDanglingRoleRefs(config);
    config.providers = sortByOrder(config.providers);
    for (const provider of config.providers) provider.models = sortByOrder(provider.models);
    analyzedConfig = undefined; // The cases above mutated config in place.
    buildCatalog(config, observed().models, observed().allowed, roleAnalysis()); // Validate the complete model graph before committing.
    write(config, baseline);
    if (type === 'importModels') pendingImport = undefined;
    await afterChange(type);
    return state();
  }
  return { state, dispatch(type, payload) {
    const operation = queue.then(() => apply(type, payload));
    queue = operation.catch(() => {}); return operation;
  } };
}
module.exports = { createManager, PanelInputError };

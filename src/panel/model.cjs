'use strict';
const { randomUUID } = require('node:crypto');
const { buildCatalog, buildRoleLists, refKey } = require('../catalog.cjs');
const { discover: discoverModels } = require('../config.cjs');
const { modelSupportsImages } = require('../model-capabilities.cjs');
const { normalizeBaseUrlPath } = require('./base-url.cjs');
const { parseProxy, maskProxy } = require('../proxy.cjs');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
class PanelInputError extends Error {}
const fail = message => { throw new PanelInputError(message); };
function text(value, label, maximum = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) fail(label + '无效。');
  return value.trim();
}
function baseUrl(value) {
  let url; try { url = new URL(text(value, 'API 地址', 2048)); } catch { fail('请填写完整的 http:// 或 https:// API 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('API 地址不能包含登录信息、查询参数或片段。');
  url.pathname = normalizeBaseUrlPath(url.pathname);
  return url.toString().replace(/\/$/, '');
}
function boolean(value, label) { if (typeof value !== 'boolean') fail(label + '无效。'); return value; }
function number(value, label) { if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) fail(label + '必须是正整数。'); return value; }
function providerAt(config, id) { return config.providers.find(provider => provider.id === id) || fail('该供应商已不存在，请刷新面板。'); }
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
function modelPatch(input, previous) {
  const model = { ...previous };
  if (own(input, 'label')) model.label = text(input.label, '模型名称');
  if (own(input, 'enabled')) model.enabled = boolean(input.enabled, '启用状态');
  if (own(input, 'supportsImages')) { boolean(input.supportsImages, '图片支持'); model.supportsImages = true; }
  if (own(input, 'contextWindow')) model.contextWindow = number(input.contextWindow, '上下文长度');
  if (own(input, 'maxOutputTokens')) model.maxOutputTokens = number(input.maxOutputTokens, '最大输出长度');
  if (own(input, 'efforts')) {
    if (!Array.isArray(input.efforts) || input.efforts.some(v => !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(v))) fail('推理强度列表无效。');
    model.efforts = [...new Set(input.efforts)];
  }
  if (own(input, 'effortMode')) {
    if (!['auto', 'manual', 'none'].includes(input.effortMode)) fail('推理档位来源无效。');
    model.effortMode = input.effortMode;
  }
  if (model.maxOutputTokens > model.contextWindow) fail('最大输出长度不能超过上下文长度。');
  return model;
}
function publicState(config, nativeModels = [], autoContinueStatus = 'unavailable', nativeCatalogStatus = 'ready', cliCache) {
  const catalog = buildCatalog({ ...config, enabled: true }, nativeModels);
  const hidden = new Set(catalog.hiddenNativeModelUids || []);
  const roleLists = buildRoleLists(config, nativeModels);
  const eligibleLeads = new Set(roleLists.lead.filter(item => item.available).flatMap(item => item.memberUids || [item.ref.nativeUid]).filter(Boolean));
  const eligibleSidekicks = new Set(roleLists.sidekick.filter(item => item.available).flatMap(item => item.memberUids || [item.ref.nativeUid]).filter(Boolean));
  const observed = new Set();
  const natives = [];
  for (const entry of nativeModels) {
    if (!entry || typeof entry.uid !== 'string' || !entry.uid) continue;
    observed.add(entry.uid);
    natives.push({ uid: entry.uid, label: typeof entry.label === 'string' && entry.label ? entry.label : entry.uid,
      disabled: entry.disabled === true, hidden: hidden.has(entry.uid),
      eligibleLead: eligibleLeads.has(entry.uid), eligibleSidekick: eligibleSidekicks.has(entry.uid),
      eligible: eligibleLeads.has(entry.uid) || eligibleSidekicks.has(entry.uid) });
  }
  for (const uid of hidden) if (!observed.has(uid)) natives.push({ uid, label: uid, disabled: false, hidden: true, eligibleLead: false, eligibleSidekick: false, eligible: false });
  return {
    enabled: config.enabled !== false,
    providers: config.providers.map(provider => ({ id: provider.id, name: provider.name, baseUrl: provider.baseUrl,
      apiFormat: provider.apiFormat, enabled: provider.enabled !== false, keyConfigured: !!provider.apiKey,
      models: provider.models.map(model => ({ id: model.id, label: model.label || model.id, enabled: model.enabled !== false,
        efforts: model.efforts || [], effortMode: model.effortMode || (model.efforts?.length ? 'manual' : 'auto'),
        contextWindow: model.contextWindow || 272000, maxOutputTokens: model.maxOutputTokens || Math.min(131072, model.contextWindow || 272000),
        supportsImages: modelSupportsImages(model) })) })),
    sidekicks: catalog.sidekicks.map(sidekick => sidekick.native
      ? { nativeUid: sidekick.uid, label: sidekick.label } : { providerId: sidekick.providerId, model: sidekick.model }),
    roleLists,
    nativeModels: natives,
    modelCount: Object.keys(catalog.routes).length,
    fusionCount: catalog.matrixUids.size,
    cliCache: cliCache && typeof cliCache === 'object' ? cliCache : null,
    autoContinueOnProviderError: config.autoContinueOnProviderError === true,
    autoContinueUntilPlanComplete: config.autoContinueUntilPlanComplete === true,
    autoContinueStatus: typeof autoContinueStatus === 'string' ? autoContinueStatus : 'unavailable',
    updateProxy: maskProxy(config.updateProxy),
  };
}
function createManager({ read, write, discover = discoverModels, afterChange = async () => {}, selectFusion = async () => {}, nativeModels = () => [], refreshNativeModels = async () => {}, refreshCliCaches = null, cliCacheStatus = () => null, nativeCatalogStatus = () => 'empty', autoContinueStatus = () => 'unavailable' }) {
  let queue = Promise.resolve();
  let pendingImport;
  const signature = provider => JSON.stringify([provider.id, provider.baseUrl, provider.apiFormat, provider.apiKey]);
  const state = () => {
    const config = read(), status = nativeCatalogStatus();
    const result = publicState(config, nativeModels(), autoContinueStatus(), status, cliCacheStatus());
    result.nativeCatalogStatus = status;
    const provider = config.providers.find(p => p.id === pendingImport?.providerId);
    result.importCandidates = provider && signature(provider) === pendingImport.signature ? {
      providerId: provider.id, token: pendingImport.token,
      models: pendingImport.models.map(model => ({ id: model.id, label: model.label || model.id,
        imported: provider.models.some(existing => existing.id === model.id) })),
    } : null;
    return result;
  };
  async function apply(type, payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('操作参数无效。');
    if (type === 'ready' || type === 'refreshNativeModels') { await refreshNativeModels(); return state(); }
    if (type === 'refreshCliCaches') {
      if (read().enabled === false) fail('请先启用 Fusion BYOK 再刷新缓存。');
      if (typeof refreshCliCaches !== 'function') fail('当前环境不支持手动刷新缓存。');
      await refreshCliCaches();
      return state();
    }
    let config = read();
    if (type === 'selectFusion') {
      if (config.enabled === false) fail('请先启用 Fusion BYOK。');
      if (!own(buildCatalog(config, nativeModels()).fusions, payload.uid)) fail('该 Fusion 组合已不可用，请重新选择。');
      await selectFusion(payload.uid); return state();
    }
    switch (type) {
      case 'saveProvider': {
        const existing = payload.id ? providerAt(config, payload.id) : null;
        const name = text(payload.name, '供应商名称', 80), url = baseUrl(payload.baseUrl);
        if (!['openai-responses', 'openai', 'anthropic'].includes(payload.apiFormat)) fail('请选择 API 类型。');
        if (own(payload, 'apiKey') && (typeof payload.apiKey !== 'string' || payload.apiKey.length > 8192 || /[\r\n]/.test(payload.apiKey))) fail('API Key 无效。');
        const apiKey = payload.apiKey?.trim() || existing?.apiKey || '';
        if (existing) {
          const previousName = existing.name;
          Object.assign(existing, { name, baseUrl: url, apiFormat: payload.apiFormat, apiKey });
          if (name !== previousName) for (const model of existing.models) if (model.label?.startsWith(previousName + ' · ')) model.label = name + model.label.slice(previousName.length);
        } else config.providers.push({ id: 'provider-' + randomUUID(), name, baseUrl: url, apiFormat: payload.apiFormat, apiKey, enabled: true, models: [] });
        break;
      }
      case 'deleteProvider': providerAt(config, payload.id); config.providers = config.providers.filter(p => p.id !== payload.id); break;
      case 'setProviderEnabled': providerAt(config, payload.id).enabled = boolean(payload.enabled, '启用状态'); break;
      case 'refreshModels': {
        const original = providerAt(config, payload.providerId), fetched = structuredClone(original);
        pendingImport = undefined;
        await discover(fetched);
        // Read again after the network request so another window's edits survive.
        config = read(); const current = providerAt(config, payload.providerId);
        if (signature(current) !== signature(original)) fail('供应商配置刚刚发生变化，请重新刷新模型。');
        // Validate a private candidate catalog, without changing saved models.
        buildCatalog({ ...config, providers: [{ ...current, enabled: true, models: fetched.models }] });
        pendingImport = { providerId: current.id, signature: signature(current), token: randomUUID(), models: fetched.models };
        return state();
      }
      case 'importModels': {
        const provider = providerAt(config, payload.providerId);
        if (!pendingImport || pendingImport.providerId !== provider.id || pendingImport.token !== payload.token ||
            pendingImport.signature !== signature(provider)) fail('模型列表已失效，请重新获取后选择。');
        if (!Array.isArray(payload.ids) || !payload.ids.length || payload.ids.some(id => typeof id !== 'string') ||
            new Set(payload.ids).size !== payload.ids.length) fail('请选择要导入的模型。');
        const candidates = new Map(pendingImport.models.map(model => [model.id, model]));
        if (payload.ids.some(id => !candidates.has(id))) fail('所选模型不在获取的列表中，请重新选择。');
        const existing = new Set(provider.models.map(model => model.id));
        for (const id of payload.ids) if (!existing.has(id)) {
          const candidate = candidates.get(id);
          provider.models.push({ ...candidate, label: provider.name + ' · ' + id, enabled: true });
        }
        break;
      }
      case 'updateModels': {
        const provider = providerAt(config, payload.providerId);
        if (!Array.isArray(payload.changes || []) || !Array.isArray(payload.removeIds || [])) fail('模型修改列表无效。');
        for (const change of payload.changes || []) {
          const index = provider.models.findIndex(m => m.id === change?.id);
          if (index < 0) fail('该模型已不存在，请刷新面板。');
          provider.models[index] = modelPatch(change, provider.models[index]);
        }
        provider.models = provider.models.filter(m => !(payload.removeIds || []).includes(m.id));
        break;
      }
      case 'addModel': {
        const provider = providerAt(config, payload.providerId), input = payload.model;
        const id = text(input?.id, '模型 ID');
        if (provider.models.some(m => m.id === id)) fail('该模型已经在列表中。');
        provider.models.push(modelPatch(input, { id, label: id, enabled: true, efforts: [], contextWindow: 272000, maxOutputTokens: 131072, source: 'manual' }));
        break;
      }
      case 'setNativeModelHidden': {
        const uid = payload.uid;
        if (typeof uid !== 'string' || !uid || uid.length > 256 || /^(?:fusion-)?dfbyok-/.test(uid)) fail('模型标识无效。');
        const hidden = boolean(payload.hidden, '显示状态');
        if (hidden && !nativeModels().some(entry => entry?.uid === uid)) fail('该官方模型当前未出现在列表中，请刷新后重试。');
        const seen = new Set(), list = [];
        for (const value of Array.isArray(config.hiddenNativeModelUids) ? config.hiddenNativeModelUids : []) {
          if (typeof value !== 'string' || !value || value.length > 256 || /^(?:fusion-)?dfbyok-/.test(value) || seen.has(value)) continue;
          seen.add(value); list.push(value);
        }
        if (hidden) { if (!seen.has(uid)) list.push(uid); config.hiddenNativeModelUids = list; }
        else config.hiddenNativeModelUids = list.filter(value => value !== uid);
        break;
      }
      case 'setRoleModel': {
        const role = payload.role;
        if (role !== 'lead' && role !== 'sidekick') fail('角色类型无效。');
        const enabled = boolean(payload.enabled, '启用状态');
        const model = payload.model;
        if (!model || typeof model !== 'object' || Array.isArray(model)) fail('模型参数无效。');
        const hasNative = typeof model.nativeUid === 'string' && !!model.nativeUid;
        const hasProvider = typeof model.providerId === 'string' && typeof model.model === 'string' && !!model.providerId && !!model.model;
        if ((hasNative && hasProvider) || (!hasNative && !hasProvider)) fail('模型身份无效。');
        const key = refKey(model);
        if (!key) fail('模型标识无效。');

        const currentRoles = buildRoleLists(config, nativeModels());
        const candidateList = currentRoles[role] || [];
        const candidate = candidateList.find(item => refKey(item.ref) === key ||
          hasNative && (item.memberUids || []).some(uid => refKey({ nativeUid: uid }) === key));
        if (enabled && (!candidate || !candidate.available)) fail('该模型当前不可用，无法添加。');

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
      case 'setEnabled': config.enabled = boolean(payload.enabled, '启用状态'); break;
      case 'setAutoContinue': config.autoContinueOnProviderError = boolean(payload.enabled, '自动继续'); break;
      case 'setAutoContinueUntilPlanComplete': config.autoContinueUntilPlanComplete = boolean(payload.enabled, '完成待办时自动继续'); break;
      case 'setUpdateProxy': {
        const input = payload?.value;
        if (typeof input !== 'string') fail('请填写 http:// 或 https:// 开头的代理地址。');
        const value = input.trim();
        if (value.length > 2048) fail('请填写 http:// 或 https:// 开头的代理地址。');
        if (!value) { delete config.updateProxy; break; }
        const stored = typeof config.updateProxy === 'string' ? config.updateProxy : '';
        if (stored && value === maskProxy(stored)) return state();
        try { parseProxy(value); } catch { fail('请填写 http:// 或 https:// 开头的代理地址。'); }
        config.updateProxy = value;
        break;
      }
      default: fail('不支持的操作。');
    }
    pruneDanglingRoleRefs(config);
    buildCatalog(config, nativeModels()); // Validate the complete model graph before committing.
    write(config);
    if (type === 'importModels') pendingImport = undefined;
    await afterChange(type);
    return state();
  }
  return { state, dispatch(type, payload) {
    const operation = queue.then(() => apply(type, payload));
    queue = operation.catch(() => {}); return operation;
  } };
}
module.exports = { createManager, publicState, PanelInputError };

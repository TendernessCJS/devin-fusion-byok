'use strict';
const { parseFields, str, num, m } = require('../protocol/wire.cjs');
const { concat, ownUid, has, nativeUid } = require('./identity.cjs');
const { normalizeNativeEntry } = require('../native-entry.cjs');

const OBSERVE_SOURCE = { GetCliModelConfigs: 'cli', GetCascadeModelConfigs: 'cascade', GetCommandModelConfigs: 'command', GetUserStatus: 'entitlement' };
function rpcShape(rpc) {
  let value = typeof rpc === 'string' ? rpc : rpc?.path || rpc?.name || '';
  try { if (value.includes('://')) value = new URL(value).pathname; } catch { return null; }
  value = value.split('?')[0];
  const method = value.slice(value.lastIndexOf('/') + 1);
  if (method === 'GetUserStatus') return { status: true, field: 1, sorts: true, source: OBSERVE_SOURCE[method] };
  if (['GetCliModelConfigs', 'GetCascadeModelConfigs', 'GetCommandModelConfigs'].includes(method)) return { status: false, sorts: method === 'GetCascadeModelConfigs', source: OBSERVE_SOURCE[method] };
  return null;
}

function rewriteMessage(data, number, transform, create = false) {
  const parsed = parseFields(data), matches = parsed.filter(field => field.number === number);
  if (matches.length > 1 || matches.some(field => field.wire !== 2)) throw new Error('Ambiguous catalog message');
  if (!matches.length) return create ? concat([data, m(number, transform(Buffer.alloc(0)))]) : data;
  return concat(parsed.map(field => field.number === number ? m(number, transform(field.value)) : field.raw));
}

// The server marks Fusion combinations the account cannot use as disabled.
// Report every native `fusion-` router uid and which are locked so assignment
// interception can fall back to the configured combination without affecting
// entries that remain enabled. Observation failures must never break rewriting.
function reportFusionStatus(entries, isJson, report) {
  if (typeof report !== 'function') return;
  try {
    const seen = [], locked = [];
    for (const entry of entries) {
      const uid = isJson ? entry?.modelUid ?? entry?.model_uid : str(entry, 22);
      if (typeof uid !== 'string' || !uid.startsWith('fusion-') || ownUid(uid)) continue;
      seen.push(uid);
      if (isJson ? entry.disabled === true : num(entry, 4) === 1) locked.push(uid);
    }
    if (seen.length) report(locked, seen);
  } catch {}
}

function protoUid(entry) {
  const uids = parseFields(entry).filter(field => field.number === 22);
  if (uids.length !== 1 || uids[0].wire !== 2) return '';
  return uids[0].value.toString('utf8');
}

// Inner field 23 is the server's family identifier — entries sharing it are
// one model with a tier selector and toggles (glm-5.2 groups all six uids).
// Absent or malformed just means "no family", never an invalid entry.
function metaFamilyUid(inner) {
  const fams = inner.filter(field => field.number === 23);
  if (fams.length !== 1 || fams[0].wire !== 2) return '';
  const value = fams[0].value.toString('utf8').trim();
  return value && value.length <= 128 ? value : '';
}

function protoFamilyUid(entry) {
  const infos = parseFields(entry).filter(field => field.number === 23);
  if (infos.length !== 1 || infos[0].wire !== 2) return '';
  try { return metaFamilyUid(parseFields(infos[0].value)); } catch { return ''; }
}

function protoDisabled(entry) {
  const flags = parseFields(entry).filter(field => field.number === 4);
  if (!flags.length) return false;
  if (flags.length !== 1 || flags[0].wire !== 0) return true;
  return Number(flags[0].value) !== 0;
}

function protoMetadata(entry) {
  const infos = parseFields(entry).filter(field => field.number === 23);
  if (infos.length !== 1 || infos[0].wire !== 2) return { harnessUids: [], isModelRouter: false };
  try {
    const inner = parseFields(infos[0].value);
    const harnesses = inner.filter(field => field.number === 20);
    if (harnesses.some(field => field.wire !== 2)) return { harnessUids: [], isModelRouter: false };
    const routers = inner.filter(field => field.number === 25);
    if (routers.length > 1 || routers.some(field => field.wire !== 0)) return { harnessUids: [], isModelRouter: false };
    const maxTokensFields = inner.filter(field => field.number === 4);
    const maxOutputFields = inner.filter(field => field.number === 13);
    const featuresFields = inner.filter(field => field.number === 6);
    let maxTokens, maxOutputTokens, supportsImages = false;
    if (maxTokensFields.length === 1 && maxTokensFields[0].wire === 0) {
      const val = Number(maxTokensFields[0].value);
      if (Number.isSafeInteger(val) && val > 0) maxTokens = val;
    }
    if (maxOutputFields.length === 1 && maxOutputFields[0].wire === 0) {
      const val = Number(maxOutputFields[0].value);
      if (Number.isSafeInteger(val) && val > 0) maxOutputTokens = val;
    }
    if (featuresFields.length === 1 && featuresFields[0].wire === 2) {
      const featInner = parseFields(featuresFields[0].value);
      const imgFields = featInner.filter(f => f.number === 11);
      if (imgFields.length === 1 && imgFields[0].wire === 0 && Number(imgFields[0].value) === 1) {
        supportsImages = true;
      }
    }
    const familyUid = metaFamilyUid(inner);
    // Inner field 22 is the proto DisplayOption enum (verified against the
    // official renderer): 0/absent UNSPECIFIED → standard picker, 1 ARENA,
    // 2 BATTLE_GROUP_ONLY, 3 MODEL_ROUTER, 4 QUICK_REVIEW, 5 MIMIC,
    // 6 HIDDEN_TOOL, 7 COMPACTOR, 8 MODERN_AGENT_CHAT → standard picker
    // ("Devin Local only" outside it). Everything except 0/absent and 8
    // routes to a non-picker surface or is invisible outright.
    const kinds = inner.filter(field => field.number === 22);
    let kind;
    if (kinds.length === 1 && kinds[0].wire === 0) {
      const value = Number(kinds[0].value);
      if (Number.isSafeInteger(value)) kind = value;
    }
    return {
      harnessUids: harnesses.map(field => field.value.toString('utf8')),
      isModelRouter: routers.length === 1 && Number(routers[0].value) !== 0,
      ...(maxTokens ? { maxTokens } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(supportsImages ? { supportsImages: true } : {}),
      ...(familyUid ? { familyUid } : {}),
      ...(kind !== undefined ? { kind } : {}),
    };
  } catch { return { harnessUids: [], isModelRouter: false }; }
}

const CANONICAL_FAMILY_KEYS = new Set(['Lead', 'Effort', 'Sidekick', 'Fast Mode', 'Recommended Sidekick']);

function protoFusionMetadata(entry) {
  const families = parseFields(entry).filter(field => field.number === 30);
  if (!families.length) return null;
  if (families.length !== 1 || families[0].wire !== 2) return null;
  try {
    const parts = parseFields(families[0].value);
    if (parts.some(field => field.number === 2 && field.wire !== 2)) return null;
    const entries = [];
    const keys = new Set();
    for (const field of parts.filter(field => field.number === 2)) {
      const item = parseFields(field.value);
      const keyFields = item.filter(part => part.number === 1);
      if (keyFields.length !== 1 || keyFields[0].wire !== 2) return null;
      const key = keyFields[0].value.toString('utf8');
      // Non-canonical control dimensions (Reasoning Effort, 1M Context,
      // Thinking, Prompt Cache Retention, Speed) are kept: the settings page
      // reads them to describe the family, and role/emission logic only ever
      // reads the canonical names so extra keys cannot leak into it.
      if (keys.has(key)) return null;
      keys.add(key);
      const valFields = item.filter(part => part.number === 2);
      if (valFields.length !== 1 || valFields[0].wire !== 2) return null;
      const dims = parseFields(valFields[0].value);
      const orders = dims.filter(part => part.number === 1);
      const names = dims.filter(part => part.number === 2);
      const controls = dims.filter(part => part.number === 3);
      // Official entries omit order on informational dims (e.g. Recommended
      // Sidekick): treat a missing order as 0 instead of rejecting the entry.
      if (orders.length > 1 || (orders.length === 1 && orders[0].wire !== 0)) return null;
      if (names.length > 1 || names.some(part => part.wire !== 2)) return null;
      if (controls.length > 1 || controls.some(part => part.wire !== 0)) return null;
      const order = orders.length ? Number(orders[0].value) : 0;
      const name = names.length ? names[0].value.toString('utf8') : '';
      const controlType = controls.length ? Number(controls[0].value) : 0;
      if (!Number.isSafeInteger(order) || order < 0 || order > 0x7fffffff) return null;
      if (!Number.isSafeInteger(controlType) || controlType < 0 || controlType > 0x7fffffff) return null;
      if (CANONICAL_FAMILY_KEYS.has(key) && key !== 'Fast Mode' && !name) return null;
      entries.push({ key, order, name, controlType });
    }
    return entries.length ? entries : null;
  } catch { return null; }
}

function extractSidekickDimension(entries) {
  if (!Array.isArray(entries)) return null;
  const sidekick = entries.find(e => e.key === 'Sidekick');
  if (!sidekick || !sidekick.name) return null;
  const fastMode = entries.find(e => e.key === 'Fast Mode');
  return { order: sidekick.order, name: sidekick.name, fastModeOrder: fastMode ? fastMode.order : 0 };
}

function protoSidekick(entry) {
  return extractSidekickDimension(protoFusionMetadata(entry));
}

function jsonAliasValue(object, camel, snake) {
  const hasCamel = has(object, camel), hasSnake = has(object, snake);
  if (hasCamel && hasSnake && JSON.stringify(object[camel]) !== JSON.stringify(object[snake])) return { conflict: true };
  return { value: hasCamel ? object[camel] : object[snake], present: hasCamel || hasSnake };
}

function jsonMetadata(entry) {
  const empty = { harnessUids: [], isModelRouter: false };
  const info = jsonAliasValue(entry, 'modelInfo', 'model_info');
  if (info.conflict || !info.present || !info.value || typeof info.value !== 'object' || Array.isArray(info.value)) return empty;
  const harness = jsonAliasValue(info.value, 'harnessUids', 'harness_uids');
  const router = jsonAliasValue(info.value, 'isModelRouter', 'is_model_router');
  if (harness.conflict || router.conflict) return empty;
  if (harness.present && (!Array.isArray(harness.value) || harness.value.some(value => typeof value !== 'string'))) return empty;
  if (router.present && typeof router.value !== 'boolean') return empty;
  const maxTokens = jsonAliasValue(info.value, 'maxTokens', 'max_tokens');
  const maxOutputTokens = jsonAliasValue(info.value, 'maxOutputTokens', 'max_output_tokens');
  const features = jsonAliasValue(info.value, 'modelFeatures', 'model_features');
  let supportsImages = false;
  if (!features.conflict && features.present && features.value && typeof features.value === 'object' && !Array.isArray(features.value)) {
    const img = jsonAliasValue(features.value, 'supportsImages', 'supports_images');
    if (!img.conflict && img.present && img.value === true) supportsImages = true;
  }
  const family = jsonAliasValue(info.value, 'modelFamilyUid', 'model_family_uid');
  const familyUid = !family.conflict && family.present && typeof family.value === 'string'
    ? family.value.trim() : '';
  return {
    harnessUids: harness.present ? harness.value : [],
    isModelRouter: router.value === true,
    ...(!maxTokens.conflict && maxTokens.present && Number.isSafeInteger(maxTokens.value) && maxTokens.value > 0 ? { maxTokens: maxTokens.value } : {}),
    ...(!maxOutputTokens.conflict && maxOutputTokens.present && Number.isSafeInteger(maxOutputTokens.value) && maxOutputTokens.value > 0 ? { maxOutputTokens: maxOutputTokens.value } : {}),
    ...(supportsImages ? { supportsImages: true } : {}),
    ...(familyUid && familyUid.length <= 128 ? { familyUid } : {}),
  };
}

function jsonFusionMetadata(entry) {
  const meta = jsonAliasValue(entry, 'modelFamilyMetadata', 'model_family_metadata');
  if (meta.conflict || !meta.present || !meta.value || typeof meta.value !== 'object' || Array.isArray(meta.value)) return null;
  const list = meta.value.entries;
  if (!Array.isArray(list)) return null;
  const entries = [];
  const keys = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.key !== 'string') return null;
    const key = item.key;
    if (keys.has(key)) return null;
    keys.add(key);
    const value = item.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const control = jsonAliasValue(value, 'controlType', 'control_type');
    if (control.conflict || (control.present && (!Number.isSafeInteger(control.value) || control.value < 0 || control.value > 0x7fffffff))) return null;
    if (value.order !== undefined && (!Number.isSafeInteger(value.order) || value.order < 0 || value.order > 0x7fffffff)) return null;
    if (value.name !== undefined && typeof value.name !== 'string') return null;
    const name = typeof value.name === 'string' ? value.name : '';
    const controlType = control.present ? control.value : 0;
    if (CANONICAL_FAMILY_KEYS.has(key) && key !== 'Fast Mode' && !name) return null;
    entries.push({ key, order: value.order ?? 0, name, controlType });
  }
  return entries.length ? entries : null;
}

function jsonSidekick(entry) {
  return extractSidekickDimension(jsonFusionMetadata(entry));
}

function nativeEntries(entries, isJson, source, pickerLabels) {
  const seen = [];
  for (const entry of entries) {
    let uid, label, disabled, meta, dimension, fusionMeta, listed;
    if (isJson) {
      uid = nativeUid(entry);
      label = typeof entry?.label === 'string' ? entry.label : '';
      disabled = has(entry, 'disabled') ? entry.disabled !== false : false;
      meta = jsonMetadata(entry);
      fusionMeta = jsonFusionMetadata(entry);
      dimension = extractSidekickDimension(fusionMeta);
    } else {
      uid = protoUid(entry);
      label = str(entry, 1);
      disabled = protoDisabled(entry);
      meta = protoMetadata(entry);
      fusionMeta = protoFusionMetadata(entry);
      dimension = extractSidekickDimension(fusionMeta);
      // Top-level field 6 marks legacy entitlement rows the picker still lists
      // (GPT-4.1/GPT-4o); its absence on an otherwise identical row (o3) is how
      // the picker drops retired models.
      listed = num(entry, 6) === 1;
    }
    if (typeof uid !== 'string' || !uid || uid.length > 256 || ownUid(uid)) continue;
    // The field extraction above keeps each source's own pass-through and
    // fail-closed semantics (e.g. a non-false JSON `disabled` arrives here
    // already true); the shared normalizer only re-encodes the canonical shape.
    const normalized = normalizeNativeEntry({
      uid, label, disabled, harnessUids: meta.harnessUids, isModelRouter: meta.isModelRouter,
      ...(dimension ? { sidekickDimension: dimension } : {}),
      ...(fusionMeta ? { fusionMetadata: fusionMeta } : {}),
      ...(meta.kind !== undefined ? { kind: meta.kind } : {}),
      ...(listed ? { listed: true } : {}),
      ...(meta.maxTokens ? { maxTokens: meta.maxTokens } : {}),
      ...(meta.maxOutputTokens ? { maxOutputTokens: meta.maxOutputTokens } : {}),
      ...(meta.supportsImages ? { supportsImages: true } : {}),
      ...(meta.familyUid ? { familyUid: meta.familyUid } : {}),
      ...(source ? { sources: [source] } : {}),
      ...(pickerLabels ? { pickerListed: pickerLabels.has(label) } : {}),
    });
    if (normalized) seen.push(normalized);
  }
  return seen;
}

function reportNativeModels(entries, isJson, report, source) {
  if (typeof report !== 'function') return;
  try { const seen = nativeEntries(entries, isJson, source); if (seen.length) report(seen); } catch {}
}

function defaultFusion(catalog) {
  const uid = catalog?.lastFusionSelection;
  if (typeof uid !== 'string' || !has(catalog?.fusions, uid)) return null;
  const fusion = catalog.fusions[uid];
  return fusion?.sidekickNative === false && fusion?.leadNative !== true && has(catalog?.routes, fusion.leadUid) && has(catalog?.routes, fusion.sidekickUid) ? fusion : null;
}

function jsonKey(object, camel, snake) { return has(object, snake) && !has(object, camel) ? snake : camel; }
function protoPickerLabels(fields) {
  const labels = new Set();
  for (const section of fields.filter(field => field.number === 2 && field.wire === 2)) {
    try {
      for (const group of parseFields(section.value).filter(part => part.number === 2 && part.wire === 2)) {
        for (const label of parseFields(group.value).filter(part => part.number === 2 && part.wire === 2)) {
          labels.add(label.value.toString('utf8'));
        }
      }
    } catch {}
  }
  return labels.size ? labels : null;
}

function jsonPickerLabels(payload) {
  const sorts = payload[jsonKey(payload, 'clientModelSorts', 'client_model_sorts')];
  if (!Array.isArray(sorts)) return null;
  const labels = new Set();
  for (const sort of sorts) {
    const groups = sort?.groups;
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const list = group?.modelLabels ?? group?.model_labels;
      if (!Array.isArray(list)) continue;
      for (const label of list) if (typeof label === 'string') labels.add(label);
    }
  }
  return labels.size ? labels : null;
}

module.exports = { OBSERVE_SOURCE, rpcShape, rewriteMessage, reportFusionStatus, protoUid, metaFamilyUid, protoFamilyUid, protoDisabled, protoMetadata, CANONICAL_FAMILY_KEYS, protoFusionMetadata, extractSidekickDimension, protoSidekick, jsonAliasValue, jsonMetadata, jsonFusionMetadata, jsonSidekick, nativeEntries, reportNativeModels, defaultFusion, jsonKey, protoPickerLabels, jsonPickerLabels };

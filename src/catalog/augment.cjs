'use strict';
const { parseFields, fields, str, s, m } = require('../protocol/wire.cjs');
const { OWN_GROUP, ownUid, has, concat, expandHiddenByFamily, nativeUid } = require('./identity.cjs');
const { rpcShape, rewriteMessage, reportFusionStatus, protoUid, protoFamilyUid, jsonKey, jsonMetadata, nativeEntries, reportNativeModels, protoPickerLabels, jsonPickerLabels } = require('./payload.cjs');

function augmentProtoList(data, catalog, hasSorts = true, onFusionStatus, onNativeModels, source) {
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const parsed = parseFields(data), existingLabels = new Set(models.map(model => model.label));
  const entries = parsed.filter(field => field.number === 1 && field.wire === 2).map(field => field.value);
  reportFusionStatus(entries, false, onFusionStatus);
  reportNativeModels(entries, false, onNativeModels, source);
  const hiddenNative = expandHiddenByFamily(new Set(catalog.hiddenNativeModelUids || []), entries, protoUid, protoFamilyUid);
  const hiddenFusion = new Set(catalog.hiddenFusionUids || []);
  const matrixUids = catalog.matrixUids instanceof Set ? catalog.matrixUids : new Set(catalog.matrixUids || []);
  const retainedLabels = new Set(models.map(model => model.label));
  const hiddenLabels = new Set();
  const preserved = [];
  for (const field of parsed) {
    if (field.number === 1 && field.wire === 2) {
      const uid = protoUid(field.value), label = str(field.value, 1);
      if (ownUid(uid) || matrixUids.has(uid)) { existingLabels.add(label); continue; }
      // Entries we emitted but no longer emit (config changed, uid drifted)
      // look like official fusions yet are dead weight: they keep stale
      // dimension values alive and can shadow current ones when the picker
      // dedupes by order. Official fusion entries always carry capability
      // records (field 32); our emit never does, so an f32-less `fusion-*`
      // entry is safely ours to drop. Fresh entries are re-added below.
      if (uid.startsWith('fusion-') && !fields(field.value, 32).length) continue;
      if (hiddenNative.has(uid)) { if (label) hiddenLabels.add(label); continue; }
      if (hiddenFusion.has(uid)) { if (label) hiddenLabels.add(label); continue; }
      retainedLabels.add(label);
    }
    preserved.push(field);
  }
  for (const label of hiddenLabels) if (retainedLabels.has(label)) hiddenLabels.delete(label);
  const labels = models.map(model => model.label);
  const groups = [{ name: OWN_GROUP, items: models.filter(model => model.kind === 'model') }]
    .filter(group => group.items.length).map(group => concat([s(1, group.name), ...group.items.map(model => s(2, model.label))]));
  let sorts = 0;
  const result = preserved.map(field => {
    if (!hasSorts || field.number !== 2 || field.wire !== 2) return field.raw;
    sorts++;
    const parts = parseFields(field.value).filter(part => {
      if (part.number !== 2 || part.wire !== 2 || str(part.value, 1) !== OWN_GROUP) return true;
      return !parseFields(part.value).filter(value => value.number === 2 && value.wire === 2)
        .every(value => existingLabels.has(value.value.toString('utf8')));
    });
    const position = parts.findIndex(part => part.number === 2 && part.wire === 2);
    const rewritten = parts.map(part => {
      if (!hiddenLabels.size || part.number !== 2 || part.wire !== 2) return part;
      const inner = parseFields(part.value);
      const kept = inner.filter(value => !(value.number === 2 && value.wire === 2 && hiddenLabels.has(value.value.toString('utf8'))));
      return kept.length === inner.length ? part : { raw: m(2, concat(kept.map(value => value.raw))) };
    });
    if (labels.length) rewritten.splice(position < 0 ? rewritten.length : position, 0, ...groups.map(group => ({ raw: m(2, group) })));
    return m(2, concat(rewritten.map(part => part.raw)));
  });
  const own = models.map(model => m(1, model.raw));
  result.splice(Math.max(preserved.findIndex(field => field.number === 1 && field.wire === 2), 0), 0, ...own);
  if (hasSorts && !sorts && labels.length) result.push(m(2, concat([s(1, OWN_GROUP), ...groups.map(group => m(2, group))])));
  return concat(result);
}

function augmentJsonList(data, catalog, hasSorts = true, onFusionStatus, onNativeModels, source) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid catalog JSON');
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const modelsKey = jsonKey(data, 'clientModelConfigs', 'client_model_configs');
  const sortsKey = jsonKey(data, 'clientModelSorts', 'client_model_sorts');
  const existing = data[modelsKey] || [], sorts = data[sortsKey] || [];
  if (!Array.isArray(existing) || !Array.isArray(sorts)) throw new Error('Invalid catalog list');
  reportFusionStatus(existing, true, onFusionStatus);
  reportNativeModels(existing, true, onNativeModels, source);
  const hiddenNative = expandHiddenByFamily(new Set(catalog.hiddenNativeModelUids || []), existing, nativeUid,
    model => jsonMetadata(model).familyUid || '');
  const hiddenFusion = new Set(catalog.hiddenFusionUids || []);
  const matrixUids = catalog.matrixUids instanceof Set ? catalog.matrixUids : new Set(catalog.matrixUids || []);
  const labels = models.map(model => model.label), existingLabels = new Set(labels);
  const retainedLabels = new Set(labels);
  const hiddenLabels = new Set();
  const kept = [];
  for (const model of existing) {
    const uid = nativeUid(model);
    if (ownUid(uid) || matrixUids.has(uid)) { existingLabels.add(model?.label); continue; }
    if (hiddenNative.has(uid)) { if (typeof model.label === 'string') hiddenLabels.add(model.label); continue; }
    if (hiddenFusion.has(uid)) { if (typeof model.label === 'string') hiddenLabels.add(model.label); continue; }
    if (typeof model?.label === 'string') retainedLabels.add(model.label);
    kept.push(model);
  }
  for (const label of hiddenLabels) if (retainedLabels.has(label)) hiddenLabels.delete(label);
  const groups = [{ groupName: OWN_GROUP, modelLabels: models.filter(model => model.kind === 'model').map(model => model.label) }]
    .filter(group => group.modelLabels.length);
  const append = sort => ({ ...sort, groups: [...groups, ...(sort.groups || []).map(value => {
    const labelsKey = has(value, 'modelLabels') ? 'modelLabels' : has(value, 'model_labels') ? 'model_labels' : '';
    if (!labelsKey || !Array.isArray(value[labelsKey]) || !hiddenLabels.size) return value;
    const keptLabels = value[labelsKey].filter(label => !hiddenLabels.has(label));
    return keptLabels.length === value[labelsKey].length ? value : { ...value, [labelsKey]: keptLabels };
  }).filter(value =>
    (value.groupName ?? value.group_name) !== OWN_GROUP || !(value.modelLabels ?? value.model_labels ?? []).every(label => existingLabels.has(label)))] });
  return { ...data,
    [modelsKey]: [...models.map(model => structuredClone(model.json)), ...kept],
    ...(hasSorts ? { [sortsKey]: sorts.length ? sorts.map(append) : (labels.length ? [{ name: OWN_GROUP, groups }] : sorts) } : {}),
  };
}

/** Accept decoded wire messages; framing/compression is exclusively the caller's responsibility. */
function augmentCatalog(data, { rpc, format = {}, catalog, onFusionStatus, onNativeModels, onSkip, retireOwn = false } = {}) {
  // Reported when the payload is left untouched for a reason the caller could
  // not infer from the bytes: silently returning the input looks exactly like
  // "nothing to do" and hid a shape mismatch that made every in-place cache
  // rewrite a no-op while the refresh still reported success.
  const skip = code => { try { onSkip?.(code, rpc); } catch {} };
  // `GetCliTeamSettings` carries its whole injection in the allowlist rewrite,
  // so it reports through the same channel as the catalog shapes below.
  if (rpc === '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings') return augmentLocalModelChoices(data, format, catalog, skip, retireOwn);
  const shape = rpcShape(rpc);
  if (!shape || !catalog) return data;
  // `retireOwn` keeps the cleanup pass alive even when the emit is empty: the
  // last own entry must still be removed, so the "nothing to emit" shortcut is
  // only allowed on traffic that never rewrites (observation passthrough).
  if (!catalog.models?.length && !catalog.hiddenNativeModelUids?.length && !catalog.hiddenFusionUids?.length &&
      typeof onFusionStatus !== 'function' && typeof onNativeModels !== 'function' && !retireOwn) return data;
  try {
    if (format.json === true) {
      if (!shape.status) return augmentJsonList(data, catalog, shape.sorts, onFusionStatus, onNativeModels, shape.source);
      const statusKey = jsonKey(data, 'userStatus', 'user_status'), status = data?.[statusKey];
      if (!status || typeof status !== 'object' || Array.isArray(status)) return data;
      const configKey = jsonKey(status, 'cascadeModelConfigData', 'cascade_model_config_data');
      return { ...data, [statusKey]: { ...status, [configKey]: augmentJsonList(status[configKey] || {}, catalog, true, onFusionStatus, onNativeModels, shape.source) } };
    }
    if (!Buffer.isBuffer(data)) return data;
    if (!shape.status) return augmentProtoList(data, catalog, shape.sorts, onFusionStatus, onNativeModels, shape.source);
    const parsed = parseFields(data);
    const wrapped = parsed.filter(field => field.number === shape.field);
    // `GetUserStatus` has two shapes. The bridge repeats back the
    // `GetUserStatusResponse` envelope, whose field 1 is a `user_status` message
    // carrying the model list at *its* field 33; the CLI persists the bare
    // `UserStatus` message instead, where field 1 is the `pro` boolean and the
    // list already sits at field 33 of the payload. Field 1's wire type is the
    // only discriminator between them.
    if (wrapped.length !== 1 || wrapped[0].wire !== 2) {
      const list = parsed.filter(field => field.number === 33);
      if (list.length !== 1 || list[0].wire !== 2) { skip('shape-unrecognized'); return data; }
      // `create: false` keeps a payload that merely resembles a status — the
      // malformed inputs the callers already rely on returning untouched — from
      // gaining a model list it never had.
      return rewriteMessage(data, 33, value => augmentProtoList(value, catalog, true, onFusionStatus, onNativeModels, shape.source), false);
    }
    return rewriteMessage(data, shape.field, status => rewriteMessage(status, 33, value => augmentProtoList(value, catalog, true, onFusionStatus, onNativeModels, shape.source), true));
  } catch { skip('transform-failed'); return data; }
}

// Fusion entries we emitted but no longer do are indistinguishable from the
// official catalog by uid shape (they mirror `fusion-<a>-sidekick-<b>`). The
// reliable discriminator is structural: official fusion entries always carry
// capability records (field 32), our emit never writes that field. Scans the
// model-entry lists of either known payload shape (flat clientModelConfigs or
// the user_status nesting) and returns f32-less `fusion-*` uids that are safe
// to drop.
//
// "Safe" is deliberately conservative. A uid that is merely absent from the
// current emit is NOT stale: our emit set shrinks whenever a native model's
// observation is incomplete (the Sidekick dimensions arrive late), and dropping
// by absence alone deleted 131 valid combinations in one pass (2026-10-14).
// An entry is reported only when it can never be served again:
//   - its uid no longer splits into a lead/sidekick pair (a malformed leftover)
//   - one of its sides is no longer a known uid at all (the model is gone or
//     the BYOK uid digest changed with the configuration)
//   - one of its sides was explicitly turned off for that role, because then it
//     must stop feeding dimension values into the picker
// Callers must pass the object form `{ emitted, known, excluded }`; the
// historical positional set implied "not emitted means stale", which deleted
// perfectly servable combinations. A wrong argument type throws TypeError
// instead of degrading into "everything is stale".
// `known` is mandatory and must be non-empty for the same reason: it is the
// only real discriminator below, so an absent (or empty) set silently restores
// the absence semantics. `excluded` may stay optional — its default is the
// conservative side.
function staleFusionUids(data, options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || options instanceof Set) {
    throw new TypeError('staleFusionUids requires { emitted, known, excluded }');
  }
  const known = options.known instanceof Set ? options.known : Array.isArray(options.known) ? new Set(options.known) : null;
  if (!known || !known.size) {
    throw new TypeError('staleFusionUids requires a non-empty `known` set');
  }
  const emitted = options.emitted instanceof Set ? options.emitted : new Set(options.emitted || []);
  const excluded = options.excluded || {};
  const stale = [];
  const scan = buffer => {
    const uid = protoUid(buffer);
    if (!uid.startsWith('fusion-') || emitted.has(uid) || fields(buffer, 32).length) return;
    const marker = uid.lastIndexOf('-sidekick-');
    if (marker <= 'fusion-'.length) { stale.push(uid); return; }
    const leadUid = uid.slice('fusion-'.length, marker), sidekickUid = uid.slice(marker + '-sidekick-'.length);
    if (!leadUid || !sidekickUid || leadUid.endsWith('-fast')) { stale.push(uid); return; }
    const dead = (uid, role) => !known.has(uid) || (excluded[role] instanceof Set && excluded[role].has(uid));
    if (dead(leadUid, 'lead') || dead(sidekickUid, 'sidekick')) stale.push(uid);
  };
  // The payload itself is scanned alongside every field-1 message it carries:
  // the flat CLI-configs list keeps its entries at the top level, the
  // `GetUserStatusResponse` envelope nests them under field 1 → 33, and the bare
  // `UserStatus` message the CLI caches (field 1 is the `pro` boolean) keeps them
  // at field 33 of the payload itself. Scanning only the envelope made the cached
  // shape invisible, so its stale entries could never be retired.
  try {
    for (const body of [data, ...parseFields(data).filter(field => field.number === 1 && field.wire === 2).map(field => field.value)]) {
      scan(body);
      try {
        for (const list of parseFields(body).filter(field => field.number === 33 && field.wire === 2)) {
          for (const entry of parseFields(list.value).filter(field => field.number === 1 && field.wire === 2)) scan(entry.value);
        }
      } catch { /* not a status envelope — the flat scan above already ran */ }
    }
  } catch { /* unparseable payloads simply report no stale entries */ }
  return stale;
}

// Sort sections (field 2 in a catalog list message) carry the picker's actual
// layout: named groups of model *labels*. A label present there renders as a
// picker row when its uid is also allowlisted; catalog entries whose label
// never appears (SWE-check, review rows) are unreachable through the picker.
function collectNativeModels(data, { rpc, format = {} } = {}) {
  const shape = rpcShape(rpc);
  if (!shape) return [];
  try {
    if (format.json === true) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
      let payload = data;
      if (shape.status) {
        const status = data[jsonKey(data, 'userStatus', 'user_status')];
        if (!status || typeof status !== 'object' || Array.isArray(status)) return [];
        payload = status[jsonKey(status, 'cascadeModelConfigData', 'cascade_model_config_data')] || {};
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
      const list = payload[jsonKey(payload, 'clientModelConfigs', 'client_model_configs')];
      const picker = shape.sorts ? jsonPickerLabels(payload) : null;
      return Array.isArray(list) ? nativeEntries(list, true, shape.source, picker) : [];
    }
    if (!Buffer.isBuffer(data)) return [];
    if (!shape.status) {
      const parsed = parseFields(data);
      const picker = shape.sorts ? protoPickerLabels(parsed) : null;
      return nativeEntries(parsed.filter(field => field.number === 1 && field.wire === 2).map(field => field.value), false, shape.source, picker);
    }
    const statuses = parseFields(data).filter(field => field.number === 1);
    let inner;
    if (statuses.length === 1 && statuses[0].wire === 2) {
      // GetUserStatusResponse envelope: field 1 is the user_status message and
      // the model list sits at its field 33.
      const lists = parseFields(statuses[0].value).filter(field => field.number === 33);
      if (lists.length !== 1 || lists[0].wire !== 2) return [];
      inner = parseFields(lists[0].value);
    } else {
      // The bare UserStatus message (what setAuthStatus persists and the CLI
      // caches) carries the model list at field 33 of the payload itself; its
      // field 1 is the pro boolean, which is how it differs from the envelope.
      const lists = parseFields(data).filter(field => field.number === 33);
      if (lists.length !== 1 || lists[0].wire !== 2) return [];
      inner = parseFields(lists[0].value);
    }
    return nativeEntries(inner.filter(field => field.number === 1 && field.wire === 2).map(field => field.value), false, shape.source, protoPickerLabels(inner));
  } catch { return []; }
}

// GetCliTeamSettings carries the account's allowed model uid list (proto field
// 7, JSON allowedModelUids) — the authoritative gate for whether an official
// model appears in a picker at all. Catalog payloads keep retired models and
// even reference them from sort groups, so catalog presence alone cannot tell
// a picker row from a dangling entitlement leftover.
// The result is three-state: { kind: 'restricted', uids } for a non-empty legal
// list, { kind: 'unrestricted' } when the payload is confirmed to be this RPC
// yet carries no entries, and null for any other RPC or a malformed shape.
// "Empty" is a weak signal — proto3 repeated fields cannot distinguish absent
// from present-but-empty — so callers must debounce it rather than clearing on
// a single observation.
function collectAllowedUids(data, { rpc, format = {} } = {}) {
  let value = typeof rpc === 'string' ? rpc : rpc?.path || rpc?.name || '';
  try { if (value.includes('://')) value = new URL(value).pathname; } catch { return null; }
  if (value.split('?')[0] !== '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings') return null;
  try {
    if (format.json === true) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
      const key = jsonKey(data, 'allowedModelUids', 'allowed_model_uids');
      if (!has(data, key)) return { kind: 'unrestricted' };
      const list = data[key];
      if (!Array.isArray(list)) return null;
      if (!list.length) return { kind: 'unrestricted' };
      const uids = list.filter(uid => typeof uid === 'string' && uid && uid.length <= 256);
      return uids.length === list.length ? { kind: 'restricted', uids } : null;
    }
    if (!Buffer.isBuffer(data)) return null;
    const uids = [];
    for (const field of parseFields(data)) {
      if (field.number !== 7) continue;
      if (field.wire !== 2) return null;
      uids.push(field.value.toString('utf8'));
    }
    return uids.length ? { kind: 'restricted', uids } : { kind: 'unrestricted' };
  } catch { return null; }
}

// The CLI intersects the model catalog with its configured choices. Register
// only locally routed BYOK models; native choices and every other setting stay
// byte-identical. A native Sidekick must already be in the native choice list.
function augmentLocalModelChoices(data, format, catalog, skip = () => {}, retireOwn = false) {
  if (!catalog?.models?.length && !retireOwn) return data;
  if (!catalog?.models) catalog = { models: [] };
  try {
    const key = format.json ? jsonKey(data, 'allowedModelUids', 'allowed_model_uids') : null;
    const parsed = format.json ? null : parseFields(data);
    const entries = format.json ? data[key] : parsed.filter(f => f.number === 7).map(f => {
      if (f.wire !== 2) throw new Error('Invalid model choice');
      return f.value.toString('utf8');
    });
    // An absent or empty list is unrestricted; do not turn it into a restriction.
    if (entries === undefined || Array.isArray(entries) && entries.length === 0) return data;
    if (!Array.isArray(entries) || entries.some(uid => typeof uid !== 'string')) { skip('shape-unrecognized'); return data; }
    const matrixUids = catalog.matrixUids instanceof Set ? catalog.matrixUids : new Set(catalog.matrixUids || []);
    const isOwn = uid => ownUid(uid) || matrixUids.has(uid);
    const native = new Set(entries.filter(uid => !isOwn(uid)));
    const additions = catalog.models.filter(model => {
      if (!isOwn(model.uid)) return false;
      if (Object.hasOwn(catalog.routes, model.uid)) return true;
      const fusion = catalog.fusions[model.uid];
      if (!fusion) return false;
      if (fusion.leadNative) {
        if (!native.has(fusion.leadUid)) return false;
        return fusion.sidekickNative ? native.has(fusion.sidekickUid) : ownUid(fusion.sidekickUid) && Object.hasOwn(catalog.routes, fusion.sidekickUid);
      }
      return ownUid(fusion.leadUid) && Object.hasOwn(catalog.routes, fusion.leadUid) &&
        (fusion.sidekickNative ? native.has(fusion.sidekickUid) : ownUid(fusion.sidekickUid) && Object.hasOwn(catalog.routes, fusion.sidekickUid));
    }).map(model => model.uid);
    if (format.json) return { ...data, [key]: [...entries.filter(uid => !isOwn(uid)), ...additions] };
    return concat([...parsed.filter(f => !(f.number === 7 && isOwn(f.value.toString('utf8')))).map(f => f.raw), ...additions.map(uid => s(7, uid))]);
  } catch { skip('transform-failed'); return data; }
}

module.exports = { augmentProtoList, augmentJsonList, augmentCatalog, staleFusionUids, collectNativeModels, collectAllowedUids, augmentLocalModelChoices };

'use strict';
const { parseFields, s, m } = require('../protocol/wire.cjs');
const { has, ownUid, concat, SIDEKICK_HARNESSES } = require('./identity.cjs');
const { defaultFusion } = require('./payload.cjs');

function assignmentUid(data, format, field, camel, snake) {
  if (format.json === true) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid assignment');
    if (has(data, camel) && has(data, snake) && data[camel] !== data[snake]) throw new Error('Ambiguous assignment');
    const value = data[camel] ?? data[snake] ?? '';
    if (typeof value !== 'string') throw new Error('Invalid assignment uid');
    return value;
  }
  const values = parseFields(data).filter(value => value.number === field);
  if (values.length > 1 || values.some(value => value.wire !== 2)) throw new Error('Ambiguous assignment');
  return values[0]?.value.toString('utf8') || '';
}

function resolveAssignment(data, format = {}, catalog, lockedFusionUids) {
  try {
    const router = assignmentUid(data, format, 2, 'modelRouterUid', 'model_router_uid');
    const leadRouter = assignmentUid(data, format, 6, 'fusionLeadRouterUid', 'fusion_lead_router_uid');
    const uid = leadRouter || router;
    let fusion = has(catalog?.fusions, uid) ? catalog.fusions[uid] : null;
    let redirected = false;
    // A locked official Fusion selection (free account) falls back to the
    // configured combination; enabled official entries keep their native path.
    if (!fusion && uid.startsWith('fusion-') && !ownUid(uid) && lockedFusionUids instanceof Set && lockedFusionUids.has(uid)) {
      fusion = defaultFusion(catalog);
      redirected = !!fusion;
    }
    // The picker may allow combinations we never emitted (e.g. a BYOK lead
    // with an official sidekick outside our pools). Split official-shaped
    // uids instead of failing. Fast-mode variants are refused: BYOK has no
    // fast capability, so downgrading silently would fake success.
    if (!fusion) {
      const marker = typeof uid === 'string' ? uid.lastIndexOf('-sidekick-') : -1;
      if (marker > 'fusion-'.length && uid.startsWith('fusion-')) {
        const leadUid = uid.slice('fusion-'.length, marker), sidekickUid = uid.slice(marker + '-sidekick-'.length);
        if (sidekickUid && !leadUid.endsWith('-fast')) {
          const leadNative = !ownUid(leadUid), sidekickNative = !ownUid(sidekickUid);
          fusion = { uid, label: uid, leadUid, sidekickUid, leadNative, sidekickNative,
            ...(leadNative ? { leadHarnessUids: catalog?.nativeLeadHarnessUids?.get(leadUid) } : {}),
            ...(sidekickNative ? { sidekickHarnessUids: catalog?.nativeHarnessUids?.get(sidekickUid) } : {}) };
        }
      }
    }
    if (!fusion) return null;
    const modelUid = leadRouter ? fusion.sidekickUid : fusion.leadUid;
    if (leadRouter) {
      if (fusion.sidekickNative) {
        if (!Array.isArray(fusion.sidekickHarnessUids) || !fusion.sidekickHarnessUids.length) return null;
      } else if (!has(catalog.routes, modelUid)) return null;
    } else {
      if (fusion.leadNative) {
        if (!Array.isArray(fusion.leadHarnessUids) || !fusion.leadHarnessUids.length) return null;
      } else if (!has(catalog.routes, modelUid)) return null;
    }
    let harnessUids;
    if (leadRouter) {
      harnessUids = fusion.sidekickNative ? fusion.sidekickHarnessUids : [...SIDEKICK_HARNESSES];
    } else {
      harnessUids = fusion.leadNative ? fusion.leadHarnessUids : ['fusion'];
    }
    const result = format.json === true ? { assignment: { modelUid, harnessUids } }
      : m(1, concat([s(2, modelUid), ...harnessUids.map(harness => s(3, harness))]));
    if (redirected) Object.defineProperty(result, 'redirectedFrom', { value: uid });
    return result;
  } catch { return null; }
}

module.exports = { assignmentUid, resolveAssignment };

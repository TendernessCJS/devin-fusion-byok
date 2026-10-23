'use strict';
const { analyzeRoles, buildCatalog, buildRoleLists } = require('../catalog.cjs');
const { modelSupportsImages } = require('../models/capabilities.cjs');
const { maskProxy } = require('../proxy.cjs');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
// The settings list mirrors the official picker's provider sections. The wire
// carries no vendor field, so the family id's prefix decides; codenamed uids
// (MODEL_PRIVATE_*) fall back to the label, which carries the real model name.
// Truly unrecognized entries land in 其他 rather than inventing a name.
const NATIVE_VENDORS = [
  ['Anthropic', /^(?:claude|opus|MODEL_CLAUDE)\b/i],
  ['OpenAI', /^(?:gpt|o[0-9]|codex|chatgpt|MODEL_(?:CHAT_)?GPT|MODEL_CHAT_O)\b/i],
  ['Google', /^(?:gemini|MODEL_GOOGLE)\b/i],
  ['xAI', /^(?:grok|xai|MODEL_XAI)\b/i],
  ['DeepSeek', /^deepseek\b/i],
  ['Moonshot', /^kimi\b/i],
  ['Zhipu AI', /^(?:glm|zhipu|zai)\b/i],
  ['NVIDIA', /^(?:nemotron|nvidia)\b/i],
  ['Mistral', /^(?:mistral|magistral|devstral|codestral|pixtral|voxtral)\b/i],
  ['Meta', /^llama\b/i],
  ['Alibaba', /^qwen\b/i],
  ['MiniMax', /^minimax\b/i],
  ['Devin', /^(?:swe\b|fusion$|adaptive$|arena|subagent|memory-migration|MODEL_DEVIN|devin)\b/i],
];
const OTHER_VENDOR = '其他';
function nativeVendor(id, label = '') {
  const key = id.startsWith('uid:') ? id.slice(4) : id;
  for (const candidate of [key, label]) {
    const rank = NATIVE_VENDORS.findIndex(([, pattern]) => pattern.test(candidate));
    if (rank >= 0) return { name: NATIVE_VENDORS[rank][0], rank };
  }
  return { name: OTHER_VENDOR, rank: NATIVE_VENDORS.length };
}
function publicState(config, nativeModels = [], autoContinueStatus = 'unavailable', nativeCatalogStatus = 'ready', cliCache, allowedUids, health = null) {
  const allowed = allowedUids instanceof Set ? (allowedUids.size ? allowedUids : null)
    : (Array.isArray(allowedUids) && allowedUids.length ? new Set(allowedUids) : null);
  const analysis = analyzeRoles({ ...config, enabled: true }, nativeModels, allowed);
  const catalog = buildCatalog({ ...config, enabled: true }, nativeModels, allowed, analysis);
  const hidden = new Set(catalog.hiddenNativeModelUids || []);
  const roleLists = buildRoleLists(config, nativeModels, allowed, analysis);
  const eligibleLeads = new Set(roleLists.lead.filter(item => item.available).flatMap(item => item.memberUids || [item.ref.nativeUid]).filter(Boolean));
  const eligibleSidekicks = new Set(roleLists.sidekick.filter(item => item.available).flatMap(item => item.memberUids || [item.ref.nativeUid]).filter(Boolean));
  // The settings list groups native entries by the server's family identity:
  // one upstream "model" is a tier selector plus toggles. fusion-* combination
  // entries are governed on the Fusion tab and never appear here.
  const FAMILY_INFO_DIMS = new Set(['Lead', 'Effort', 'Reasoning Effort', 'Sidekick', 'Recommended Sidekick']);
  // `-lightning` marks a fast-mode variant uid (swe-2-medium-lightning), but
  // "Lightning" is deliberately absent from the label suffix: SWE-1.7
  // Lightning is its own family whose name must survive stripping.
  const FAMILY_MARKED_UID = /-(none|minimal|low|medium|high|xhigh|max|ultra|fast|lightning|priority|thinking|\d+m)$/i;
  const FAMILY_LABEL_SUFFIX = /(?:\s+(?:No Thinking|None|Minimal|Low|Medium|High|XHigh|Max|Ultra|Thinking|Fast|Context|\d+M))+$/i;
  const familiesById = new Map();
  for (const entry of nativeModels) {
    const uid = typeof entry?.uid === 'string' ? entry.uid : '';
    if (!uid || uid.startsWith('fusion-') || uid.startsWith('dfbyok-')) continue;
    const familyUid = typeof entry.familyUid === 'string' ? entry.familyUid.trim() : '';
    const id = familyUid ? familyUid : `uid:${uid}`;
    let family = familiesById.get(id);
    if (!family) familiesById.set(id, family = { id, members: [] });
    family.members.push({ entry, uid,
      label: typeof entry.label === 'string' && entry.label ? entry.label : uid,
      disabled: entry.disabled === true, hidden: hidden.has(uid),
      eligible: eligibleLeads.has(uid) || eligibleSidekicks.has(uid) });
  }
  const usedFamilyLabels = new Set();
  const nativeFamilies = [...familiesById.values()].map(family => {
    const members = family.members.map(({ entry, ...member }) => member);
    // The display name comes from the unmarked member (bare uid); without one,
    // the smallest uid. Trailing tier/toggle words are stripped; a collision
    // disambiguates with the family id so no two rows share a label.
    const base = members.length === 1 ? members[0]
      : (members.find(member => !FAMILY_MARKED_UID.test(member.uid)) ||
         members.reduce((a, b) => a.uid < b.uid ? a : b));
    let label = base.label || base.uid;
    if (members.length > 1) {
      const stripped = label.replace(FAMILY_LABEL_SUFFIX, '').trim();
      if (stripped) label = stripped;
    }
    if (usedFamilyLabels.has(label)) label = `${label} (${family.id})`;
    usedFamilyLabels.add(label);
    const effortOrders = new Map(), toggles = new Set();
    for (const { entry } of family.members) {
      for (const dim of Array.isArray(entry.fusionMetadata) ? entry.fusionMetadata : []) {
        if (!dim || typeof dim.key !== 'string') continue;
        if (dim.key === 'Effort' || dim.key === 'Reasoning Effort') {
          if (dim.name && (!effortOrders.has(dim.name) || dim.order < effortOrders.get(dim.name))) effortOrders.set(dim.name, dim.order);
        } else if (!FAMILY_INFO_DIMS.has(dim.key) && dim.order !== 0) toggles.add(dim.key);
      }
    }
    // Hidden is family-level: any member uid in the blacklist hides the whole
    // family (the augment side expands by familyUid the same way), so the
    // "partially hidden" state cannot occur — the switch is all-or-nothing.
    const anyHidden = members.some(member => member.hidden);
    // Picker visibility, ordered by what we can prove. `kind` is the proto
    // DisplayOption enum (verified against the official renderer): 0/absent =
    // standard picker, 8 = MODERN_AGENT_CHAT (standard picker, "Devin Local
    // only" outside it), and every other value routes to a non-picker surface
    // — 1 ARENA, 2 BATTLE_GROUP_ONLY, 3 MODEL_ROUTER, 4 QUICK_REVIEW,
    // 5 MIMIC, 6 HIDDEN_TOOL, 7 COMPACTOR — or is outright invisible.
    // Adaptive/Fusion render in the official picker (kind 3) but are routing
    // surfaces, not real models, so the user wants them folded into internal.
    // The team settings allowlist is the authoritative gate once observed — a
    // catalog row whose uid is absent from it (o3, Opus Review, Codex Spark)
    // is a retired leftover no picker renders. A `pickerListed === false`
    // verdict (the label is absent from every sort group of a sorts-carrying
    // payload) likewise means no picker row, which also covers allowlisted-
    // but-unlisted rows like SWE-check when the allowlist itself has not
    // landed yet. Before the first allowlist, fall back to observation-source
    // and capability heuristics: `listed` keeps retired-but-offered rows
    // visible (GPT-4.1 vs o3), entitlement/command-only entries are hidden,
    // and harness/metadata mark real picker rows for sourceless legacy
    // observations.
    const internal = family.members.every(member => {
      const entry = member.entry || {};
      if (entry.isModelRouter === true) return true;
      if (Number.isSafeInteger(entry.kind) && entry.kind >= 1 && entry.kind !== 8) return true;
      if (allowed && !allowed.has(member.uid)) return true;
      if (entry.pickerListed === false) return true;
      if (allowed) return false;
      if (entry.listed === true) return false;
      if (Array.isArray(entry.sources) && entry.sources.length
        && !entry.sources.some(source => source === 'cli' || source === 'cascade')) return true;
      if (Array.isArray(entry.harnessUids) && entry.harnessUids.length) return false;
      if (!Array.isArray(entry.sources) || !entry.sources.length) {
        return !(Array.isArray(entry.fusionMetadata) && entry.fusionMetadata.length);
      }
      return false;
    });
    return { id: family.id, label, variants: members.length, internal,
      efforts: [...effortOrders.entries()].sort((a, b) => a[1] - b[1]).map(([name]) => name),
      toggles: [...toggles].sort(),
      hidden: anyHidden,
      members };
  });
  // A hidden uid whose model left the observed catalog still gets a single-
  // member family so it can be unhidden again.
  const observedUids = new Set([...familiesById.values()].flatMap(family => family.members.map(member => member.uid)));
  for (const uid of hidden) {
    if (observedUids.has(uid)) continue;
    const id = `uid:${uid}`;
    const label = uid;
    nativeFamilies.push({ id, label, variants: 1, efforts: [], toggles: [],
      hidden: true, internal: false,
      members: [{ uid, label, disabled: false, eligible: false, hidden: true }] });
  }
  // Vendor grouping mirrors the official picker's provider sections; stable
  // sort keeps observation order inside each vendor.
  for (const family of nativeFamilies) family.vendor = nativeVendor(family.id, family.label).name;
  nativeFamilies.sort((a, b) => nativeVendor(a.id, a.label).rank - nativeVendor(b.id, b.label).rank);
  // The Fusion card selection this extension last observed. It is a memory
  // (`lastFusionSelection`), so picking a plain model afterwards leaves it
  // pointing at the previous combination — the panel therefore labels it as
  // the most recent one, not as the current one. The name comes from our
  // mirrored entry when it is one of ours, else from the observed native
  // entry, so an official combination is named too.
  const lastFusionUid = typeof catalog.lastFusionSelection === 'string' ? catalog.lastFusionSelection : '';
  const observedFusion = lastFusionUid ? nativeModels.find(entry => entry?.uid === lastFusionUid) || null : null;
  const mirroredFusion = lastFusionUid && own(catalog.fusions, lastFusionUid) ? catalog.fusions[lastFusionUid] : null;
  const lastFusionLabel = (mirroredFusion && typeof mirroredFusion.label === 'string' && mirroredFusion.label) ||
    (observedFusion && typeof observedFusion.label === 'string' && observedFusion.label) || '';
  const lastFusion = lastFusionUid ? {
    uid: lastFusionUid, label: lastFusionLabel || lastFusionUid,
    source: mirroredFusion ? 'mirrored' : observedFusion ? 'official' : 'unresolved',
  } : null;
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
    nativeFamilies,
    modelCount: Object.keys(catalog.routes).length,
    fusionCount: catalog.matrixUids.size,
    lastFusion,
    cliCache: cliCache && typeof cliCache === 'object' ? cliCache : null,
    goalEnabled: config.goalEnabled === true,
    autoContinueOnProviderError: config.autoContinueOnProviderError === true,
    autoContinueUntilPlanComplete: config.autoContinueUntilPlanComplete === true,
    autoContinueStatus: typeof autoContinueStatus === 'string' ? autoContinueStatus : 'unavailable',
    updateProxy: maskProxy(config.updateProxy),
    health,
  };
}

module.exports = { publicState, nativeVendor };

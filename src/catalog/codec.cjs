'use strict';
const { s, v, m } = require('../protocol/wire.cjs');
const { SIDEKICK_HARNESSES, concat } = require('./identity.cjs');

// A dimension value is encoded exactly as declared: an absent `order`/`name`/
// `controlType` stays absent on the wire. That matters for the two informational
// dimensions — the official card writes `Fast Mode` with only a controlType and
// `Recommended Sidekick` with only a name, and the picker dedupes dimension
// values by `order`, so writing an explicit 0 there puts our entries in a
// separate bucket and surfaces controls the official catalog never shows.
function encodeFamily(family) {
  return concat([s(1, family.modelFamilyLabel), ...family.entries.map(entry => m(2,
    concat([s(1, entry.key), m(2, concat([
      ...(entry.value.order === undefined ? [] : [v(1, entry.value.order)]),
      ...(entry.value.name === undefined ? [] : [s(2, entry.value.name)]),
      ...(entry.value.controlType === undefined ? [] : [v(3, entry.value.controlType)]),
    ]))])))]);
}

function encodeConfig(config) {
  const info = config.modelInfo;
  const features = info.modelFeatures;
  const infoRaw = concat([
    v(3, info.modelType), v(4, info.maxTokens),
    m(6, concat([v(8, 1), ...(features.supportsImages ? [v(11, 1)] : []), v(12, 1),
      ...(features.supportsThinking ? [v(15, 1)] : []), v(21, 1)])),
    v(13, info.maxOutputTokens), s(17, info.modelUid), s(18, info.inferenceServerUrl),
    ...info.harnessUids.map(uid => s(20, uid)),
    ...(info.displayOption ? [v(22, info.displayOption)] : []),
    s(23, info.modelFamilyUid), ...(info.isModelRouter ? [v(25, 1)] : []),
  ]);
  return concat([s(1, config.label), ...(config.supportsImages ? [v(5, 1)] : []),
    v(10, config.provider), v(18, config.maxTokens),
    s(22, config.modelUid), m(23, infoRaw), m(30, encodeFamily(config.modelFamilyMetadata))]);
}

function configFor({ uid, label, family, familyUid, contextWindow, maxOutputTokens, effort, fusion, supportsImages, inferenceServerUrl, kind, harnessUids }) {
  const json = {
    label, modelUid: uid, provider: fusion ? 1 : 2,
    maxTokens: contextWindow, supportsImages: !!supportsImages,
    modelInfo: {
      modelUid: uid, modelType: 2, maxTokens: contextWindow,
      maxOutputTokens,
      inferenceServerUrl,
      harnessUids: harnessUids ?? (fusion ? ['fusion'] : [...SIDEKICK_HARNESSES]),
      displayOption: fusion ? 3 : 0, modelFamilyUid: familyUid, isModelRouter: !!fusion,
      modelFeatures: { zeroShotCapable: true, supportsImages: !!supportsImages, supportsToolCalls: true,
        supportsParallelToolCalls: true, supportsThinking: !!effort && effort !== 'none' },
    },
    modelFamilyMetadata: family,
  };
  return { uid, label, effort, kind: kind || (fusion ? 'fusion' : 'model'), json, raw: encodeConfig(json) };
}

module.exports = { encodeFamily, encodeConfig, configFor };

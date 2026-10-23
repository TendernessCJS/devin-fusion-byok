'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fields, str, num } = require('../src/protocol/wire.cjs');
const { encodeFamily, configFor } = require('../src/catalog/codec.cjs');

const FAMILY = {
  modelFamilyLabel: 'Family',
  entries: [
    { key: 'Fast Mode', value: { controlType: 2 } },
    { key: 'Recommended Sidekick', value: { name: 'SWE' } },
    { key: 'Effort', value: { order: 0, name: 'None', controlType: 1 } },
  ],
};
const FAMILY_RAW = '0a0646616d696c79120f0a0946617374204d6f646512021802121d0a145265636f6d6d656e64656420536964656b69636b1205120353574512140a064566666f7274120a080012044e6f6e651801';

const CONFIG_INPUT = {
  uid: 'dfbyok-openai-gpt-5', label: 'GPT-5', family: FAMILY, familyUid: 'dfbyok-family-openai',
  contextWindow: 272000, maxOutputTokens: 128000, inferenceServerUrl: 'https://api.openai.com/v1',
};
const EXPECTED = {
  modelImageDefault: {
    input: { ...CONFIG_INPUT, effort: 'medium', supportsImages: true },
    result: { uid: 'dfbyok-openai-gpt-5', label: 'GPT-5', effort: 'medium', kind: 'model' },
    json: { label: 'GPT-5', modelUid: 'dfbyok-openai-gpt-5', provider: 2, maxTokens: 272000, supportsImages: true,
      modelInfo: { modelUid: 'dfbyok-openai-gpt-5', modelType: 2, maxTokens: 272000, maxOutputTokens: 128000,
        inferenceServerUrl: 'https://api.openai.com/v1', harnessUids: ['swe-1p6', 'swe-1p5'], displayOption: 0,
        modelFamilyUid: 'dfbyok-family-openai', isModelRouter: false,
        modelFeatures: { zeroShotCapable: true, supportsImages: true, supportsToolCalls: true,
          supportsParallelToolCalls: true, supportsThinking: true } },
      modelFamilyMetadata: FAMILY },
    raw: '0a054750542d3528015002900180cd10b20113646662796f6b2d6f70656e61692d6770742d35ba017418022080cd10320b4001580160017801a801016880e8078a0113646662796f6b2d6f70656e61692d6770742d3592011968747470733a2f2f6170692e6f70656e61692e636f6d2f7631a201077377652d317036a201077377652d317035ba0114646662796f6b2d66616d696c792d6f70656e6169f2014e0a0646616d696c79120f0a0946617374204d6f646512021802121d0a145265636f6d6d656e64656420536964656b69636b1205120353574512140a064566666f7274120a080012044e6f6e651801',
  },
  modelNoImageHarness: {
    input: { ...CONFIG_INPUT, effort: 'none', supportsImages: false, harnessUids: ['custom-h'] },
    result: { uid: 'dfbyok-openai-gpt-5', label: 'GPT-5', effort: 'none', kind: 'model' },
    json: { label: 'GPT-5', modelUid: 'dfbyok-openai-gpt-5', provider: 2, maxTokens: 272000, supportsImages: false,
      modelInfo: { modelUid: 'dfbyok-openai-gpt-5', modelType: 2, maxTokens: 272000, maxOutputTokens: 128000,
        inferenceServerUrl: 'https://api.openai.com/v1', harnessUids: ['custom-h'], displayOption: 0,
        modelFamilyUid: 'dfbyok-family-openai', isModelRouter: false,
        modelFeatures: { zeroShotCapable: true, supportsImages: false, supportsToolCalls: true,
          supportsParallelToolCalls: true, supportsThinking: false } },
      modelFamilyMetadata: FAMILY },
    raw: '0a054750542d355002900180cd10b20113646662796f6b2d6f70656e61692d6770742d35ba016718022080cd10320740016001a801016880e8078a0113646662796f6b2d6f70656e61692d6770742d3592011968747470733a2f2f6170692e6f70656e61692e636f6d2f7631a20108637573746f6d2d68ba0114646662796f6b2d66616d696c792d6f70656e6169f2014e0a0646616d696c79120f0a0946617374204d6f646512021802121d0a145265636f6d6d656e64656420536964656b69636b1205120353574512140a064566666f7274120a080012044e6f6e651801',
  },
  fusion: {
    input: { ...CONFIG_INPUT, uid: 'fusion-dfbyok-openai-gpt-5', label: 'GPT-5 Fusion', effort: 'high', supportsImages: true, fusion: true },
    result: { uid: 'fusion-dfbyok-openai-gpt-5', label: 'GPT-5 Fusion', effort: 'high', kind: 'fusion' },
    json: { label: 'GPT-5 Fusion', modelUid: 'fusion-dfbyok-openai-gpt-5', provider: 1, maxTokens: 272000, supportsImages: true,
      modelInfo: { modelUid: 'fusion-dfbyok-openai-gpt-5', modelType: 2, maxTokens: 272000, maxOutputTokens: 128000,
        inferenceServerUrl: 'https://api.openai.com/v1', harnessUids: ['fusion'], displayOption: 3,
        modelFamilyUid: 'dfbyok-family-openai', isModelRouter: true,
        modelFeatures: { zeroShotCapable: true, supportsImages: true, supportsToolCalls: true,
          supportsParallelToolCalls: true, supportsThinking: true } },
      modelFamilyMetadata: FAMILY },
    raw: '0a0c4750542d3520467573696f6e28015001900180cd10b2011a667573696f6e2d646662796f6b2d6f70656e61692d6770742d35ba017618022080cd10320b4001580160017801a801016880e8078a011a667573696f6e2d646662796f6b2d6f70656e61692d6770742d3592011968747470733a2f2f6170692e6f70656e61692e636f6d2f7631a20106667573696f6eb00103ba0114646662796f6b2d66616d696c792d6f70656e6169c80101f2014e0a0646616d696c79120f0a0946617374204d6f646512021802121d0a145265636f6d6d656e64656420536964656b69636b1205120353574512140a064566666f7274120a080012044e6f6e651801',
  },
  fusionNoImage: {
    input: { ...CONFIG_INPUT, uid: 'fusion-dfbyok-openai-gpt-5x', label: 'GPT-5 Fusion X', effort: 'none', supportsImages: false, fusion: true },
    result: { uid: 'fusion-dfbyok-openai-gpt-5x', label: 'GPT-5 Fusion X', effort: 'none', kind: 'fusion' },
    json: { label: 'GPT-5 Fusion X', modelUid: 'fusion-dfbyok-openai-gpt-5x', provider: 1, maxTokens: 272000, supportsImages: false,
      modelInfo: { modelUid: 'fusion-dfbyok-openai-gpt-5x', modelType: 2, maxTokens: 272000, maxOutputTokens: 128000,
        inferenceServerUrl: 'https://api.openai.com/v1', harnessUids: ['fusion'], displayOption: 3,
        modelFamilyUid: 'dfbyok-family-openai', isModelRouter: true,
        modelFeatures: { zeroShotCapable: true, supportsImages: false, supportsToolCalls: true,
          supportsParallelToolCalls: true, supportsThinking: false } },
      modelFamilyMetadata: FAMILY },
    raw: '0a0e4750542d3520467573696f6e20585001900180cd10b2011b667573696f6e2d646662796f6b2d6f70656e61692d6770742d3578ba017318022080cd10320740016001a801016880e8078a011b667573696f6e2d646662796f6b2d6f70656e61692d6770742d357892011968747470733a2f2f6170692e6f70656e61692e636f6d2f7631a20106667573696f6eb00103ba0114646662796f6b2d66616d696c792d6f70656e6169c80101f2014e0a0646616d696c79120f0a0946617374204d6f646512021802121d0a145265636f6d6d656e64656420536964656b69636b1205120353574512140a064566666f7274120a080012044e6f6e651801',
  },
};

test('encodeFamily keeps absent order/name/controlType absent and explicit fields as declared', () => {
  const raw = encodeFamily(FAMILY);
  assert.equal(raw.toString('hex'), FAMILY_RAW);
  const values = fields(raw, 2).map(entry => fields(entry.value, 2)[0].value);
  const has = (buffer, number, wire) => fields(buffer, number).some(field => field.wire === wire);
  assert.equal(has(values[0], 1, 0), false);
  assert.equal(has(values[0], 2, 2), false);
  assert.equal(num(values[0], 3), 2);
  assert.equal(has(values[1], 1, 0), false);
  assert.equal(str(values[1], 2), 'SWE');
  assert.equal(has(values[1], 3, 0), false);
  assert.equal(num(values[2], 1), 0);
  assert.equal(has(values[2], 1, 0), true);
  assert.equal(str(values[2], 2), 'None');
  assert.equal(num(values[2], 3), 1);
});

for (const [name, expected] of Object.entries(EXPECTED)) {
  test(`configFor ${name} matches frozen JSON and wire bytes`, () => {
    const result = configFor(expected.input);
    assert.deepEqual({ uid: result.uid, label: result.label, effort: result.effort, kind: result.kind }, expected.result);
    assert.deepEqual(result.json, expected.json);
    assert.ok(Buffer.isBuffer(result.raw));
    assert.equal(result.raw.toString('hex'), expected.raw);
  });
}

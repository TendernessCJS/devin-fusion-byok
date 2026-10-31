'use strict';
// Fixed wire-contract matrix: the default request bodies recorded at 04dc73d
// must be byte-identical under the current implementation. Never regenerate
// the baseline to make this pass — intentional body changes get a per-scenario
// rationale and a deliberate fixture edit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/provider-wire-contract.json');
const { route, provider, formats, scenarios, EXTRA } = require('./fixtures/provider-wire-cases.cjs');
const { buildRequestBody } = require('../src/protocol/provider-request.cjs');

function buildCase(scenario, format, options = { cacheBreakpoints: true }) {
  const request = scenarios[scenario]();
  const states = [];
  let body;
  try {
    body = buildRequestBody(request, route, { ...provider, apiFormat: format }, stat => states.push(stat), options);
  } catch (error) {
    body = { __threw: error.code || error.message };
  }
  return { body, stateOutcomes: states };
}

test('fixture metadata is traceable and complete', () => {
  assert.match(fixture.metadata.commit, /^04dc73d[0-9a-f]{33}$/, 'baseline pins commit 04dc73d');
  assert.equal(fixture.metadata.dirty, false);
  assert.equal(fixture.cases.length, 52);
  for (const entry of fixture.cases) {
    const known = entry.scenario in scenarios || entry.scenario === EXTRA.name;
    assert.ok(known, 'no builder for fixture scenario ' + entry.scenario);
  }
  const built = new Set();
  for (const name of Object.keys(scenarios)) for (const format of formats) built.add(name + '/' + format);
  built.add(EXTRA.name + '/' + EXTRA.format);
  for (const entry of fixture.cases) {
    assert.ok(built.has(entry.scenario + '/' + entry.format), 'fixture case without a builder: ' + entry.scenario + '/' + entry.format);
    built.delete(entry.scenario + '/' + entry.format);
  }
  assert.equal(built.size, 0, 'builders without a fixture case: ' + [...built].join(','));
});

test('all 52 baseline cases reproduce byte-identically', () => {
  let compared = 0;
  for (const entry of fixture.cases) {
    const extra = entry.scenario === EXTRA.name;
    const actual = buildCase(extra ? EXTRA.scenario : entry.scenario, entry.format, extra ? EXTRA.options : undefined);
    const label = entry.scenario + '/' + entry.format;
    assert.deepEqual(actual.body, entry.body, label + ' body drifted from baseline');
    assert.deepEqual(actual.stateOutcomes, entry.stateOutcomes, label + ' stateOutcomes drifted');
    compared++;
  }
  assert.equal(compared, 52, 'every baseline case was compared');
});

test('strict-and-parallel keeps schema verbatim across formats', () => {
  for (const format of ['openai-responses', 'openai-chat-completions']) {
    const { body } = buildCase('strict-and-parallel', format);
    // Responses nests fields flat; Chat wraps them under `function`.
    const tool = body.tools[0].function || body.tools[0];
    const params = tool.parameters.properties;
    assert.deepEqual(params.target.type, ['string', 'null'], format + ' must not fold type arrays into anyOf');
    assert.ok('description' in params, format + ' must keep a property literally named description');
    assert.deepEqual(params.options.anyOf, [{ type: 'string' }, { type: 'object', properties: { retries: { type: 'integer', default: 3 } } }], format);
    assert.equal(tool.strict, true, format);
    assert.equal(body.parallel_tool_calls, false, format);
  }
});

test('custom grammar tools stay custom on Responses and function-shaped on Anthropic', () => {
  const responses = buildCase('custom-tool-grammar', 'openai-responses').body;
  assert.equal(responses.tools[0].type, 'custom');
  assert.deepEqual(responses.tools[0].format, { type: 'grammar', definition: 'start: "x"', syntax: 'lark' });
  const anthropic = buildCase('custom-tool-grammar', 'anthropic').body;
  assert.equal(anthropic.tools[0].type, undefined);
  assert.deepEqual(anthropic.tools[0].input_schema, { type: 'object', properties: {} });
});

test('raw JSON arguments keep their whitespace verbatim', () => {
  const raw = '{ "cmd" :  "echo 1" }';
  const responses = buildCase('raw-json-whitespace', 'openai-responses').body;
  assert.equal(responses.input.find(item => item.type === 'function_call').arguments, raw);
  const chat = buildCase('raw-json-whitespace', 'openai-chat-completions').body;
  assert.equal(chat.messages.find(message => message.tool_calls).tool_calls[0].function.arguments, raw);
});

test('anthropic thinking lanes keep signed, redacted and foreign-envelope branches verbatim', () => {
  const signed = buildCase('signed-thinking', 'anthropic').body;
  assert.deepEqual(signed.messages[1].content[0], { type: 'thinking', thinking: 'internal reasoning', signature: 'EqQBCgIYAhIMsignature-fixture' });
  const redacted = buildCase('redacted-thinking', 'anthropic').body;
  assert.deepEqual(redacted.messages[1].content[0], { type: 'redacted_thinking', data: 'opaque-fixture-bytes' });
  const foreign = buildCase('foreign-responses-envelope-on-anthropic', 'anthropic').body;
  assert.deepEqual(foreign.messages[1].content, [{ type: 'text', text: 'answer' }], 'a foreign envelope must not become a thinking block');
});

test('the comparison is not vacuous: targeted mutations must fail', () => {
  const mutatedSchema = structuredClone(fixture.cases);
  const strictCase = mutatedSchema.find(entry => entry.scenario === 'strict-and-parallel' && entry.format === 'openai-responses');
  strictCase.body.tools[0].parameters.properties.target.type = 'string';
  const actual = buildCase('strict-and-parallel', 'openai-responses');
  assert.throws(() => assert.deepEqual(actual.body, strictCase.body));

  const mutatedStates = structuredClone(fixture.cases);
  const statesCase = mutatedStates.find(entry => entry.scenario === 'responses-state-replay' && entry.format === 'openai-responses');
  assert.ok(statesCase.stateOutcomes.length, 'the fixture must carry stateOutcomes to mutate');
  statesCase.stateOutcomes.splice(0, 1);
  const rebuilt = buildCase('responses-state-replay', 'openai-responses');
  assert.throws(() => assert.deepEqual(rebuilt.stateOutcomes, statesCase.stateOutcomes));

  const mutatedArgs = structuredClone(fixture.cases);
  const argsCase = mutatedArgs.find(entry => entry.scenario === 'raw-json-whitespace' && entry.format === 'openai-responses');
  const call = argsCase.body.input.find(item => item.type === 'function_call');
  call.arguments = call.arguments.replace(' :  ', ': ');
  const rebuiltArgs = buildCase('raw-json-whitespace', 'openai-responses');
  assert.throws(() => assert.deepEqual(rebuiltArgs.body, argsCase.body));
});

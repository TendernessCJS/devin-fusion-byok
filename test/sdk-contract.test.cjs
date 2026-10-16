'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseChat } = require('../src/protocol/acp.cjs');
const { buildAnthropicBody, createAnthropicAdapter } = require('../src/protocol/anthropic.cjs');

const ANTHROPIC_FILE = path.join(__dirname, '..', '.refs', 'anthropic-sdk-typescript', 'src', 'resources', 'messages', 'messages.ts');
const OPENAI_FILE = path.join(__dirname, '..', '.refs', 'openai-node', 'src', 'resources', 'shared.ts');
const anthropicSource = fs.existsSync(ANTHROPIC_FILE) ? fs.readFileSync(ANTHROPIC_FILE, 'utf8') : null;
const openaiSource = fs.existsSync(OPENAI_FILE) ? fs.readFileSync(OPENAI_FILE, 'utf8') : null;
const missingAnthropic = { skip: '.refs/anthropic-sdk-typescript is a read-only local copy, absent on CI' };
const missingOpenai = { skip: '.refs/openai-node is a read-only local copy, absent on CI' };

function unionMembers(source, marker) {
  const index = source.indexOf(marker);
  assert.notEqual(index, -1, `${marker} not found — the SDK layout changed`);
  const block = source.slice(index, source.indexOf(';', index));
  const members = [...block.matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.ok(members.length > 0, `${marker} parsed to no members — the SDK layout changed`);
  return members;
}

test('Anthropic StopReason union members map into the allowed finish reasons', { ...(anthropicSource ? {} : missingAnthropic) }, () => {
  const members = unionMembers(anthropicSource, 'export type StopReason =');
  const adapter = createAnthropicAdapter();
  const allowed = new Set(['stop', 'length', 'content_filter', 'pause_turn']);
  for (const member of members) {
    const out = adapter({ type: 'message_delta', data: { delta: { stop_reason: member } } });
    const chunk = out.find(entry => entry.data?.choices?.[0]?.finish_reason);
    assert.ok(chunk, `${member} must produce a finish chunk`);
    const reason = chunk.data.choices[0].finish_reason;
    assert.ok(allowed.has(reason), `${member} mapped to ${reason}, which the shared processor does not understand`);
  }
  const mapped = member => createAnthropicAdapter()({ type: 'message_delta', data: { delta: { stop_reason: member } } })
    .find(entry => entry.data?.choices?.[0]?.finish_reason).data.choices[0].finish_reason;
  assert.equal(mapped('max_tokens'), 'length');
  assert.equal(mapped('model_context_window_exceeded'), 'length');
  assert.equal(mapped('refusal'), 'content_filter');
  assert.equal(mapped('pause_turn'), 'pause_turn');
  const toolUse = mapped('tool_use');
  assert.notEqual(toolUse, 'length', 'tool_use must not report a truncation');
  assert.notEqual(toolUse, 'content_filter', 'tool_use must not report a filter stop');
});

test('Anthropic OutputConfig effort literals all reach the wire body', { ...(anthropicSource ? {} : missingAnthropic) }, () => {
  const match = anthropicSource.match(/effort\?:\s*((?:'[^']*'\s*\|\s*)*'[^']*')\s*\|\s*null;/);
  assert.ok(match, 'effort? literal union not found — the SDK layout changed');
  const members = [...match[1].matchAll(/'([^']+)'/g)].map(m2 => m2[1]);
  assert.ok(members.length > 0);
  const request = parseChat({ messages: [], tools: [] });
  for (const effort of members) {
    const body = buildAnthropicBody(request, { model: 'm', effort }, { apiFormat: 'anthropic' });
    assert.equal(body.output_config?.effort, effort, `effort ${effort} is dropped by buildAnthropicBody`);
  }
  const unknown = buildAnthropicBody(request, { model: 'm', effort: 'ultra' }, { apiFormat: 'anthropic' });
  assert.equal(unknown.output_config, undefined, 'a value absent from the SDK union must not reach the wire');
});

test('OpenAI chat effort literals we may send stay a subset of the SDK union', { ...(openaiSource ? {} : missingOpenai) }, () => {
  const members = new Set(unionMembers(openaiSource, 'export type ReasoningEffort'));
  const ours = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  for (const value of ours) assert.ok(members.has(value), `ReasoningEffort no longer includes ${value}`);
});

test('Anthropic ToolChoice members and our emitted shapes agree', { ...(anthropicSource ? {} : missingAnthropic) }, () => {
  const union = anthropicSource.match(/export type ToolChoice = ([^;]+);/);
  assert.ok(union, 'ToolChoice union not found — the SDK layout changed');
  for (const name of ['ToolChoiceAuto', 'ToolChoiceAny', 'ToolChoiceTool', 'ToolChoiceNone'])
    assert.ok(union[1].includes(name), `ToolChoice union lost ${name}`);
  for (const [name, literal] of [['ToolChoiceAuto', 'auto'], ['ToolChoiceAny', 'any'], ['ToolChoiceTool', 'tool'], ['ToolChoiceNone', 'none']]) {
    const block = anthropicSource.match(new RegExp(`interface ${name} \\{[\\s\\S]*?type: '([^']+)'`));
    assert.ok(block, `${name}.type not found — the SDK layout changed`);
    assert.equal(block[1], literal, `${name}.type is now ${block[1]}, expected ${literal}`);
  }
  const tool = { name: 'shell_command', description: 'Run', parameters: { type: 'object', properties: {} }, strict: false };
  const body = toolChoice => buildAnthropicBody({ ...parseChat({ messages: [], tools: [] }), tools: [tool], toolChoice }, { model: 'm' }, { apiFormat: 'anthropic' }).tool_choice;
  assert.deepEqual(body({ type: 'any' }), { type: 'any' });
  assert.deepEqual(body({ type: 'tool', name: 'shell_command' }), { type: 'tool', name: 'shell_command' });
  assert.deepEqual(body({ type: 'none' }), { type: 'none' });
  assert.deepEqual(body({ type: 'auto' }), { type: 'auto' });
});

test('Anthropic ThinkingBlockParam keeps signature as a required field', { ...(anthropicSource ? {} : missingAnthropic) }, () => {
  const block = anthropicSource.match(/interface ThinkingBlockParam \{[\s\S]*?\n\}/);
  assert.ok(block, 'ThinkingBlockParam interface not found — the SDK layout changed');
  assert.ok(/signature: string;/.test(block[0]), 'signature is no longer a required string field');
  assert.ok(!/signature\?:/.test(block[0]), 'signature became optional — revisit the replay-only-when-signed rule');
});

const RESPONSES_FILE = path.join(__dirname, '..', '.refs', 'openai-node', 'src', 'resources', 'responses', 'responses.ts');
const responsesSource = fs.existsSync(RESPONSES_FILE) ? fs.readFileSync(RESPONSES_FILE, 'utf8') : null;
const missingResponses = { skip: '.refs/openai-node is a read-only local copy, absent on CI' };

test('Responses CustomTool stays type custom with an optional format', { ...(responsesSource ? {} : missingResponses) }, () => {
  const block = responsesSource.match(/export interface CustomTool \{[\s\S]*?\n\}/);
  assert.ok(block, 'CustomTool interface not found — the SDK layout changed');
  assert.ok(/type: 'custom'/.test(block[0]), 'CustomTool.type literal changed');
  assert.ok(/format\?:/.test(block[0]), 'CustomTool.format became required — update our emission');
});

test('Responses Grammar syntax union stays lark|regex with type grammar', { ...(openaiSource ? {} : missingOpenai) }, () => {
  const block = openaiSource.match(/interface Grammar \{[\s\S]*?\n  \}/);
  assert.ok(block, 'CustomToolInputFormat.Grammar not found — the SDK layout changed');
  assert.ok(/type: 'grammar'/.test(block[0]), 'Grammar.type literal changed');
  const syntax = block[0].match(/syntax: ([^;]+);/);
  assert.ok(syntax, 'Grammar.syntax not found — the SDK layout changed');
  assert.deepEqual(new Set([...syntax[1].matchAll(/'([^']+)'/g)].map(match => match[1])), new Set(['lark', 'regex']));
});

test('ResponseCustomToolCall.input stays a plain string', { ...(responsesSource ? {} : missingResponses) }, () => {
  const block = responsesSource.match(/export interface ResponseCustomToolCall \{[\s\S]*?\n\}/);
  assert.ok(block, 'ResponseCustomToolCall not found — the SDK layout changed');
  assert.ok(/\n {2}input: string;/.test(block[0]), 'input is no longer a required string — raw forwarding is broken');
  assert.ok(!/input\?:/.test(block[0]) && !/input: (?!string\b)/.test(block[0]), 'input shape changed');
});

test('Responses params still expose store and reasoning.encrypted_content include', { ...(responsesSource ? {} : missingResponses) }, () => {
  assert.ok(/\n {2}store\?: boolean \| null;/.test(responsesSource), 'store param disappeared — the state channel must change');
  const members = new Set(unionMembers(responsesSource, 'export type ResponseIncludable'));
  assert.ok(members.has('reasoning.encrypted_content'), 'reasoning.encrypted_content was removed from ResponseIncludable');
});

test('the anthropic foreign-signature guard covers the responses envelope prefix', () => {
  const { STATE_PREFIX } = require('../src/protocol/inference.cjs');
  const { readFileSync } = require('node:fs');
  const anthropicSource = readFileSync(path.join(__dirname, '..', 'src', 'protocol', 'anthropic.cjs'), 'utf8');
  const guard = anthropicSource.match(/FOREIGN_STATE_PREFIX = '([^']+)'/);
  assert.ok(guard, 'FOREIGN_STATE_PREFIX not found — the guard was removed');
  assert.ok(STATE_PREFIX.startsWith(guard[1]), `guard prefix ${guard[1]} no longer covers the envelope prefix ${STATE_PREFIX}`);
});

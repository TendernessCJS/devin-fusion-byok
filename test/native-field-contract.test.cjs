'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Field-number contract against the installed Devin webapp protobuf schema
// (protobuf-es `newFieldList` descriptors). A missing bundle is the only skip;
// a bundle that exists but no longer carries a relied-on field must fail.
const APP_ROOT = process.env.DFBYOK_TEST_APP_ROOT || '/Applications/Devin.app/Contents/Resources/app';
const ASSETS = path.join(APP_ROOT, 'out/vs/workbench/devin-webapp-host/assets');

const FILE_MARK = '//__PB_FILE__:';
function pbBundle() {
  // Only an absent assets directory may skip: a present directory without a
  // schema bundle is drift and must fail, never skip.
  let names;
  try { names = fs.readdirSync(ASSETS); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('installed Devin layout changed: assets unreadable (' + (error.code || error.message) + ')');
  }
  const sources = [];
  for (const name of names) {
    if (!name.endsWith('.js')) continue;
    const source = fs.readFileSync(path.join(ASSETS, name), 'utf8');
    if (source.includes('typeName=`exa.')) sources.push({ name, source });
  }
  if (!sources.length) throw new Error('installed Devin layout changed: assets present but no schema bundle found');
  return sources.map(file => FILE_MARK + file.name + '\n' + file.source).join('\n');
}

function balancedEnd(text, start, open, close) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      for (i++; i < text.length && text[i] !== quote; i++) if (text[i] === '\\') i++;
      if (i >= text.length) throw new Error('installed schema has an unterminated string');
      continue;
    }
    if (char === open) depth++;
    else if (char === close && --depth === 0) return i;
  }
  throw new Error('installed schema has an unterminated descriptor');
}

function uniqueAnchor(text, anchor, description) {
  const first = text.indexOf(anchor);
  if (first < 0) throw new Error('installed schema not found: ' + description);
  if (text.indexOf(anchor, first + anchor.length) >= 0) throw new Error('installed schema descriptor is not unique: ' + description);
  return first;
}

function topLevelProps(raw, typeName, no) {
  const props = new Map();
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '{') { depth++; continue; }
    if (c === '}') { depth--; continue; }
    if (depth !== 1) continue;
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < raw.length && raw[i] !== c; i++) if (raw[i] === '\\') i++;
      if (i >= raw.length) throw new Error('installed schema has an unterminated string: ' + typeName);
      continue;
    }
    const key = raw.slice(i).match(/^([A-Za-z_$][\w$]*)\s*:/);
    if (!key) {
      if (/[A-Za-z_$]/.test(raw[i])) throw new Error('installed schema property cannot be parsed: ' + typeName + '.f' + no + ' near ' + raw.slice(i, i + 16));
      continue;
    }
    i += key[0].length;
    let j = i, nested = 0;
    for (; j < raw.length; j++) {
      const ch = raw[j];
      if (ch === '"' || ch === "'" || ch === '`') {
        const q = ch;
        for (j++; j < raw.length && raw[j] !== q; j++) if (raw[j] === '\\') j++;
        if (j >= raw.length) throw new Error('installed schema has an unterminated string: ' + typeName);
        continue;
      }
      if (ch === '{' || ch === '[') nested++;
      else if (ch === '}' || ch === ']') { if (nested === 0) break; nested--; }
      else if (ch === ',' && nested === 0) break;
    }
    if (props.has(key[1])) throw new Error('installed schema property is not unique: ' + typeName + '.f' + no + '.' + key[1]);
    props.set(key[1], raw.slice(i, j).trim());
    i = j - 1;
  }
  return props;
}

function boolProp(props, key, typeName, no) {
  const value = props.get(key);
  if (value === undefined) return false;
  if (value === '!0' || value === 'true') return true;
  if (value === '!1' || value === 'false') return false;
  throw new Error('installed schema property is not a boolean literal: ' + typeName + '.f' + no + ' ' + key + '=' + value);
}

function descriptorFrom(sourceText, typeName) {
  const anchor = uniqueAnchor(sourceText, 'typeName=`' + typeName + '`', typeName);
  const marker = '.newFieldList(()=>[';
  const start = sourceText.indexOf(marker, anchor);
  if (start < 0) throw new Error('installed schema field list not found: ' + typeName);
  const nextType = sourceText.indexOf('typeName=`', anchor + 1);
  if (nextType >= 0 && nextType < start) throw new Error('installed schema field list not found: ' + typeName);
  const open = start + marker.length - 1;
  const end = balancedEnd(sourceText, open, '[', ']');
  const body = sourceText.slice(open + 1, end);
  const fields = new Map();
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '{') continue;
    const objectEnd = balancedEnd(body, i, '{', '}');
    const raw = body.slice(i, objectEnd + 1);
    const head = raw.match(/^\{no:(\d+),name:`([^`]+)`(?:,jsonName:`[^`]+`)?,kind:`(scalar|message|enum|map)`/);
    if (!head) throw new Error('installed schema field cannot be parsed: ' + typeName);
    const no = Number(head[1]);
    if (fields.has(no)) throw new Error('installed schema field number is not unique: ' + typeName + '.f' + no);
    const props = topLevelProps(raw, typeName, no);
    const scalarType = head[3] === 'scalar' ? (props.get('T') ?? '').match(/^\d+$/) : null;
    if (head[3] === 'scalar' && !scalarType) throw new Error('installed schema scalar type not found: ' + typeName + '.f' + no);
    fields.set(no, { name: head[2], kind: head[3], scalarType: scalarType ? Number(scalarType[0]) : null,
      ref: head[3] === 'scalar' ? null : (props.get('T') ?? null),
      repeated: boolProp(props, 'repeated', typeName, no), optional: boolProp(props, 'opt', typeName, no), raw });
    i = objectEnd;
  }
  if (!fields.size) throw new Error('installed schema has no fields: ' + typeName);
  return fields;
}

function enumFrom(sourceText, typeName) {
  const anchor = uniqueAnchor(sourceText, ',`' + typeName + '`,[', typeName);
  const open = sourceText.indexOf('[', anchor + 1);
  const end = balancedEnd(sourceText, open, '[', ']');
  const values = new Map();
  for (const part of sourceText.slice(open + 1, end).matchAll(/\{no:(\d+),name:`([^`]+)`\}/g)) values.set(part[2], Number(part[1]));
  if (!values.size) throw new Error('installed schema enum has no values: ' + typeName);
  return values;
}

function bundleFiles(sourceText) {
  const files = new Map();
  let pos = 0;
  while (true) {
    const at = sourceText.indexOf(FILE_MARK, pos);
    if (at < 0) break;
    const nl = sourceText.indexOf('\n', at + FILE_MARK.length);
    if (nl < 0) throw new Error('schema bundle file marker is truncated');
    const name = sourceText.slice(at + FILE_MARK.length, nl);
    if (files.has(name)) throw new Error('schema bundle file name is not unique: ' + name);
    files.set(name, nl + 1);
    pos = nl + 1;
  }
  if (!files.size) throw new Error('schema bundle has no tagged files');
  const bounds = [...files.entries()];
  const result = new Map();
  for (let i = 0; i < bounds.length; i++) {
    const [name, start] = bounds[i];
    const end = i + 1 < bounds.length ? bounds[i + 1][1] - (FILE_MARK.length + bounds[i + 1][0].length + 1) : sourceText.length;
    result.set(name, { body: sourceText.slice(start, end), start });
  }
  return result;
}

function indexBundle(sourceText) {
  const files = bundleFiles(sourceText);
  const index = new Map();
  for (const [name, file] of files) {
    const body = file.body;
    const classes = new Map();
    for (const match of body.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*class\b/g)) {
      const brace = body.indexOf('{', match.index);
      if (brace < 0) throw new Error('installed schema class is unterminated: ' + name);
      const end = balancedEnd(body, brace, '{', '}');
      const typeName = body.slice(brace, end).match(/typeName=`([^`]+)`/);
      if (typeName) {
        if (classes.has(match[1])) throw new Error('installed schema class alias is not unique: ' + name + '.' + match[1]);
        classes.set(match[1], typeName[1]);
      }
    }
    const enums = new Map();
    for (const match of body.matchAll(/setEnumType\(([\w$]+),\s*[`'"]([^`'"]+)[`'"]/g)) {
      if (enums.has(match[1])) throw new Error('installed schema enum alias is not unique: ' + name + '.' + match[1]);
      enums.set(match[1], match[2]);
    }
    const imports = new Map();
    for (const match of body.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
      const from = match[2].split('/').pop();
      for (const part of match[1].split(',')) {
        const pair = part.trim().split(/\s+as\s+/);
        const exported = pair[0].trim(), local = (pair[1] ?? pair[0]).trim();
        if (!exported) continue;
        if (imports.has(local)) throw new Error('installed schema import alias is not unique: ' + name + '.' + local);
        imports.set(local, { exported, from });
      }
    }
    const exports = new Map();
    for (const match of body.matchAll(/export\s*\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?/g)) {
      const from = match[2] ? match[2].split('/').pop() : null;
      for (const part of match[1].split(',')) {
        const pair = part.trim().split(/\s+as\s+/);
        const local = pair[0].trim(), exported = (pair[1] ?? pair[0]).trim();
        if (!local) continue;
        if (exports.has(exported)) throw new Error('installed schema export is not unique: ' + name + '.' + exported);
        exports.set(exported, { local, from });
      }
    }
    index.set(name, { classes, enums, imports, exports });
  }
  return index;
}

function typeFile(sourceText, typeName) {
  const files = bundleFiles(sourceText);
  const anchor = 'typeName=`' + typeName + '`';
  const at = sourceText.indexOf(anchor);
  if (at < 0) throw new Error('installed schema not found: ' + typeName);
  let found = null;
  for (const [name, file] of files) {
    if (at >= file.start && at < file.start + file.body.length) {
      if (found) throw new Error('installed schema descriptor is not unique: ' + typeName);
      found = name;
    }
  }
  if (!found) throw new Error('installed schema not found: ' + typeName);
  return found;
}

function resolveExported(index, file, name, seen) {
  const scope = index.get(file);
  if (!scope) throw new Error('unresolvable import ' + file + ' for ' + name);
  if (seen.has('e:' + file + ':' + name)) throw new Error('circular type reference ' + name + ' in ' + file);
  seen.add('e:' + file + ':' + name);
  const exported = scope.exports.get(name);
  if (!exported) throw new Error('unresolvable export ' + name + ' in ' + file);
  if (exported.from) return resolveExported(index, exported.from, exported.local, seen);
  return resolveSymbol(index, file, exported.local, seen);
}

function resolveSymbol(index, file, symbol, seen = new Set()) {
  const scope = index.get(file);
  if (!scope) throw new Error('unresolvable schema file for ' + symbol);
  if (seen.has(file + ':' + symbol)) throw new Error('circular type reference ' + symbol + ' in ' + file);
  seen.add(file + ':' + symbol);
  const hits = (scope.classes.has(symbol) ? 1 : 0) + (scope.enums.has(symbol) ? 1 : 0);
  if (hits > 1) throw new Error('ambiguous local type declaration ' + symbol + ' in ' + file);
  if (scope.classes.has(symbol)) return scope.classes.get(symbol);
  if (scope.enums.has(symbol)) return scope.enums.get(symbol);
  const imported = scope.imports.get(symbol);
  if (!imported) throw new Error('unresolvable type reference ' + symbol + ' in ' + file);
  return resolveExported(index, imported.from, imported.exported, seen);
}

function resolvedRef(sourceText, typeName, number) {
  const file = typeFile(sourceText, typeName);
  const field = descriptorFrom(sourceText, typeName).get(number);
  if (!field || !field.ref) throw new Error('installed schema field has no type reference: ' + typeName + '.f' + number);
  const call = field.ref.match(/^[\w$]+\.getEnumType\(([\w$]+)\)$/);
  const symbol = call ? call[1] : field.ref;
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) throw new Error('installed schema field type is not a symbol: ' + typeName + '.f' + number + ' ' + field.ref);
  return resolveSymbol(indexBundle(sourceText), file, symbol);
}

const field = (name, kind, scalarType = null, repeated = false, optional = false) => ({ name, kind, scalarType, repeated, optional });
const message = (name, repeated = false, optional = false) => field(name, 'message', null, repeated, optional);
const scalar = (name, scalarType, repeated = false, optional = false) => field(name, 'scalar', scalarType, repeated, optional);
const enumeration = (name, repeated = false) => field(name, 'enum', null, repeated);
const EXPECTED_FIELDS = {
  'exa.codeium_common_pb.UserStatus': { 33: message('cascade_model_config_data') },
  'exa.codeium_common_pb.ClientModelConfig': {
    1: scalar('label', 9), 4: scalar('disabled', 8), 5: scalar('supports_images', 8), 10: enumeration('provider'),
    18: scalar('max_tokens', 5), 22: scalar('model_uid', 9), 23: message('model_info'), 30: message('model_family_metadata'),
  },
  'exa.codeium_common_pb.ModelInfo': {
    3: enumeration('model_type'), 4: scalar('max_tokens', 5), 6: message('model_features'), 13: scalar('max_output_tokens', 5),
    17: scalar('model_uid', 9), 18: scalar('inference_server_url', 9), 20: scalar('harness_uids', 9, true),
    22: enumeration('display_option'), 23: scalar('model_family_uid', 9), 25: scalar('is_model_router', 8),
    26: message('compaction_thresholds'), 27: scalar('aliases', 9, true), 28: enumeration('partner_providers', true),
  },
  'exa.codeium_common_pb.ModelFeatures': {
    8: scalar('zero_shot_capable', 8), 11: scalar('supports_images', 8), 12: scalar('supports_tool_calls', 8),
    15: scalar('supports_thinking', 8), 21: scalar('supports_parallel_tool_calls', 8),
  },
  'exa.codeium_common_pb.ModelFamilyMetadata': {
    1: scalar('model_family_label', 9), 2: message('entries', true), 3: scalar('is_default_model_in_family', 8),
  },
  'exa.codeium_common_pb.ModelFamilyMetadataEntry': { 1: scalar('key', 9), 2: message('value') },
  'exa.codeium_common_pb.ModelFamilyMetadataValue': {
    1: scalar('order', 5), 2: scalar('name', 9), 3: enumeration('control_type'),
  },
  'exa.codeium_common_pb.ClientModelSort': {
    1: scalar('name', 9), 2: message('groups', true), 3: scalar('display_metric', 9, false, true),
  },
  'exa.codeium_common_pb.CascadeModelConfigData': {
    1: message('client_model_configs', true), 2: message('client_model_sorts', true), 3: message('default_override_model_config', false, true),
  },
  'exa.codeium_common_pb.ModelStatusInfo': {
    1: enumeration('model'), 2: scalar('message', 9), 3: enumeration('status'), 4: scalar('model_uid', 9),
  },
  'exa.api_server_pb.AssignModelRequest': {
    1: message('metadata'), 2: scalar('model_router_uid', 9), 3: scalar('cascade_id', 9),
    5: message('chat_message_prompt'), 6: scalar('fusion_lead_router_uid', 9),
  },
  'exa.api_server_pb.ModelAssignment': {
    1: scalar('assignment_jwt', 9), 2: scalar('model_uid', 9), 3: scalar('harness_uids', 9, true),
  },
  'exa.api_server_pb.GetChatMessageRequest': {
    2: scalar('prompt', 9), 3: message('chat_message_prompts', true), 6: enumeration('internal_chat_model'),
    10: message('tools', true), 11: scalar('disable_parallel_tool_calls', 8), 12: message('tool_choice'),
    21: scalar('chat_model_uid', 9), 27: scalar('prompt_cache_key', 9), 28: scalar('session_id', 9),
  },
  'exa.chat_pb.ChatMessagePrompt': {
    1: scalar('message_id', 9), 2: enumeration('source'), 3: scalar('prompt', 9), 6: message('tool_calls', true),
    7: scalar('tool_call_id', 9), 9: scalar('tool_result_is_error', 8), 10: message('images', true),
    11: scalar('thinking', 9), 12: scalar('signature', 9), 20: message('videos', true), 21: message('documents', true),
    22: scalar('generation_model_uid', 9),
  },
  'exa.chat_pb.ChatToolDefinition': {
    1: scalar('name', 9), 2: scalar('description', 9), 3: scalar('json_schema_string', 9),
    8: message('computer_use_config', false, true), 9: scalar('is_custom_tool', 8, false, true),
    10: scalar('custom_tool_grammar', 9, false, true), 11: scalar('custom_tool_grammar_syntax', 9, false, true),
    12: scalar('strict', 8),
  },
  'exa.chat_pb.ChatToolChoice': { 1: scalar('option_name', 9), 2: scalar('tool_name', 9) },
  'exa.codeium_common_pb.ChatToolCall': {
    1: scalar('id', 9), 2: scalar('name', 9), 3: scalar('arguments_json', 9), 6: scalar('is_custom_tool_call', 8),
  },
  'exa.codeium_common_pb.ImageData': { 1: scalar('base64_data', 9), 2: scalar('mime_type', 9), 3: scalar('caption', 9) },
  'exa.codeium_common_pb.VideoData': { 1: scalar('base64_data', 9), 2: scalar('mime_type', 9), 3: scalar('url', 9) },
  'exa.codeium_common_pb.DocumentData': {
    1: scalar('base64_data', 9), 2: scalar('mime_type', 9), 3: scalar('filename', 9), 4: scalar('url', 9),
  },
  'exa.codeium_common_pb.ModelUsageStats': {
    2: scalar('input_tokens', 4), 3: scalar('output_tokens', 4), 4: scalar('cache_write_tokens', 4),
    5: scalar('cache_read_tokens', 4), 7: scalar('message_id', 9), 9: scalar('model_uid', 9), 13: scalar('used_provider_plan', 8),
  },
  'exa.api_server_pb.GetChatMessageResponse': {
    1: scalar('message_id', 9), 2: message('timestamp'), 3: scalar('delta_text', 9), 4: scalar('delta_tokens', 13),
    5: enumeration('stop_reason'), 6: message('delta_tool_calls', true), 7: message('usage'), 9: scalar('delta_thinking', 9),
    10: scalar('delta_signature', 9), 11: scalar('thinking_redacted', 8), 14: scalar('credit_cost', 5),
    18: scalar('committed_credit_cost', 5), 23: scalar('actual_model_uid', 9, false, true),
    29: message('notifications', true), 30: message('model_change', false, true),
  },
};
const EXPECTED_REFS = {
  'exa.api_server_pb.GetChatMessageResponse': {
    5: 'exa.codeium_common_pb.StopReason', 6: 'exa.codeium_common_pb.ChatToolCall',
    7: 'exa.codeium_common_pb.ModelUsageStats',
  },
  'exa.api_server_pb.GetChatMessageRequest': {
    3: 'exa.chat_pb.ChatMessagePrompt', 6: 'exa.codeium_common_pb.Model',
    10: 'exa.chat_pb.ChatToolDefinition', 12: 'exa.chat_pb.ChatToolChoice',
  },
  'exa.chat_pb.ChatMessagePrompt': {
    2: 'exa.codeium_common_pb.ChatMessageSource', 6: 'exa.codeium_common_pb.ChatToolCall',
    10: 'exa.codeium_common_pb.ImageData', 20: 'exa.codeium_common_pb.VideoData',
    21: 'exa.codeium_common_pb.DocumentData',
  },
  'exa.codeium_common_pb.ClientModelConfig': {
    23: 'exa.codeium_common_pb.ModelInfo', 30: 'exa.codeium_common_pb.ModelFamilyMetadata',
  },
  'exa.codeium_common_pb.ModelInfo': { 6: 'exa.codeium_common_pb.ModelFeatures' },
  'exa.codeium_common_pb.ModelFamilyMetadata': { 2: 'exa.codeium_common_pb.ModelFamilyMetadataEntry' },
  'exa.codeium_common_pb.ModelFamilyMetadataEntry': { 2: 'exa.codeium_common_pb.ModelFamilyMetadataValue' },
  'exa.codeium_common_pb.UserStatus': { 33: 'exa.codeium_common_pb.CascadeModelConfigData' },
};
const EXPECTED_ENUMS = {
  'exa.codeium_common_pb.StopReason': {
    STOP_REASON_STOP_PATTERN: 2, STOP_REASON_MAX_TOKENS: 3, STOP_REASON_FUNCTION_CALL: 10,
    STOP_REASON_CONTENT_FILTER: 11, STOP_REASON_ERROR: 13,
  },
  'exa.codeium_common_pb.ChatMessageSource': {
    CHAT_MESSAGE_SOURCE_UNSPECIFIED: 0, CHAT_MESSAGE_SOURCE_USER: 1, CHAT_MESSAGE_SOURCE_SYSTEM: 2,
    CHAT_MESSAGE_SOURCE_UNKNOWN: 3, CHAT_MESSAGE_SOURCE_TOOL: 4, CHAT_MESSAGE_SOURCE_SYSTEM_PROMPT: 5,
  },
};

function assertContract(sourceText) {
  for (const [typeName, expected] of Object.entries(EXPECTED_FIELDS)) {
    const actual = descriptorFrom(sourceText, typeName);
    for (const [number, shape] of Object.entries(expected)) {
      const field = actual.get(Number(number));
      assert.ok(field, `${typeName}.f${number} is missing`);
      assert.deepEqual({ name: field.name, kind: field.kind, scalarType: field.scalarType,
        repeated: field.repeated, optional: field.optional }, shape, `${typeName}.f${number}`);
    }
  }
  for (const [typeName, expected] of Object.entries(EXPECTED_ENUMS)) {
    const actual = enumFrom(sourceText, typeName);
    for (const [name, number] of Object.entries(expected)) assert.equal(actual.get(name), number, `${typeName}.${name}`);
  }
  for (const [typeName, expected] of Object.entries(EXPECTED_REFS)) {
    for (const [number, refType] of Object.entries(expected)) {
      assert.equal(resolvedRef(sourceText, typeName, Number(number)), refType,
        `${typeName}.f${number} type reference`);
    }
  }
}

const source = pbBundle();

test('the fields this plugin reads keep their numbers, kinds, scalar types and cardinality in the installed schema', { skip: !source }, () => {
  assertContract(source);
});

// Field names verified against the 3.11.238 installed descriptors; the
// catalog write/read paths in src/catalog/*.cjs and the AssignModelRequest
// table in src/runtime/backend.cjs hand-code every one of these numbers.
// Presence-only registration: newly observed fields exist in the schema but
// this build deliberately does not read or transform them. Native forwarding
// passes GetChatMessageResponse through untouched; BYOK constructs its chunks
// and must not fabricate official notification or model-change events.

function assertTextChunk(codec) {
  const { fields, str } = require('../src/protocol/wire.cjs');
  const buffer = codec.textChunk('id', 'text');
  const matches = fields(buffer, 3);
  assert.equal(matches.length, 1, 'the text delta must occupy field 3 exactly once');
  assert.equal(matches[0].wire, 2);
  assert.equal(str(buffer, 3), 'text');
}

test('production chat chunk writers use the independently verified native field layout', () => {
  const codec = require('../src/protocol/native-chat-codec.cjs');
  const { fields, str, num } = require('../src/protocol/wire.cjs');
  const only = (buffer, number, wire) => {
    const matches = fields(buffer, number);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].wire, wire);
    return matches[0].value;
  };
  assertTextChunk(codec);
  assert.equal(str(codec.thinkingChunk('id', 'thinking'), 9), 'thinking');
  assert.equal(str(codec.signatureChunk('id', 'signature'), 10), 'signature');
  assert.equal(num(codec.redactedThinkingChunk('id'), 11), 1);
  const tool = only(codec.toolChunk('id', [{ id: 'call', name: 'exec', arguments: '{}', isCustomToolCall: true }]), 6, 2);
  assert.equal(str(tool, 1), 'call');
  assert.equal(str(tool, 2), 'exec');
  assert.equal(str(tool, 3), '{}');
  assert.equal(num(tool, 6), 1);
  const stop = codec.stopChunk('id', 3, 'model');
  assert.equal(num(stop, 5), 3);
  assert.equal(str(stop, 23), 'model');
  const usage = only(codec.usageChunk('id', 'model', { inputTokens: 9, outputTokens: 4, cacheWriteTokens: 2, cacheReadTokens: 3 }), 7, 2);
  assert.equal(num(usage, 2), 9);
  assert.equal(num(usage, 3), 4);
  assert.equal(num(usage, 4), 2);
  assert.equal(num(usage, 5), 3);
  assert.equal(str(usage, 7), 'id');
  assert.equal(str(usage, 9), 'model');
});

test('production request parsing and catalog writing use the verified field layout', () => {
  const { parseChat } = require('../src/protocol/native-chat-codec.cjs');
  const { encodeConfig } = require('../src/catalog/codec.cjs');
  const { fields, str, num, s, v, m } = require('../src/protocol/wire.cjs');
  const request = Buffer.concat([
    s(2, 'system'), s(21, 'model'), s(27, 'cache'), v(6, 7), v(11, 1),
    m(3, Buffer.concat([s(1, 'message'), v(2, 4), s(3, 'prompt'), s(7, 'call'), v(9, 1), s(11, 'thinking'), s(12, 'signature')])),
    m(10, Buffer.concat([s(1, 'exec'), s(2, 'description'), s(3, '{}'), v(12, 1)])),
    m(12, Buffer.concat([s(1, 'auto'), s(2, 'exec')])),
  ]);
  const parsed = parseChat(request);
  assert.equal(parsed.systemPrompt, 'system');
  assert.equal(parsed.modelUid, 'model');
  assert.equal(parsed.promptCacheKey, 'cache');
  assert.equal(parsed.modelEnum, 7);
  assert.equal(parsed.disableParallelToolCalls, true);
  assert.deepEqual(parsed.toolChoice, { type: 'auto', name: 'exec' });
  assert.deepEqual(parsed.messages, [{ role: 'tool', source: 4, messageId: 'message', content: 'prompt', toolCalls: [],
    toolCallId: 'call', toolResultIsError: true, images: [], videos: [], documents: [], thinking: 'thinking', signature: 'signature' }]);
  assert.deepEqual(parsed.tools, [{ name: 'exec', description: 'description', parameters: {}, strict: true,
    isCustomTool: false, customToolGrammar: '', customToolGrammarSyntax: '', hasComputerUseConfig: false }]);
  const raw = encodeConfig({ label: 'label', supportsImages: true, provider: 2, maxTokens: 1000, modelUid: 'model',
    modelInfo: { modelType: 2, maxTokens: 1000, modelFeatures: { supportsImages: true, supportsThinking: true },
      maxOutputTokens: 100, modelUid: 'model', inferenceServerUrl: 'server', harnessUids: ['harness'],
      displayOption: 3, modelFamilyUid: 'family', isModelRouter: true },
    modelFamilyMetadata: { modelFamilyLabel: 'Family', entries: [{ key: 'effort', value: { order: 1, name: 'High', controlType: 2 } }] } });
  assert.equal(str(raw, 1), 'label');
  assert.equal(num(raw, 5), 1);
  assert.equal(num(raw, 10), 2);
  assert.equal(num(raw, 18), 1000);
  assert.equal(str(raw, 22), 'model');
  const info = fields(raw, 23)[0].value;
  assert.equal(num(info, 3), 2);
  assert.equal(num(info, 4), 1000);
  assert.equal(num(info, 13), 100);
  assert.equal(str(info, 17), 'model');
  assert.equal(str(info, 18), 'server');
  assert.equal(str(info, 20), 'harness');
  assert.equal(num(info, 22), 3);
  assert.equal(str(info, 23), 'family');
  assert.equal(num(info, 25), 1);
  const features = fields(info, 6)[0].value;
  for (const number of [8, 11, 12, 15, 21]) assert.equal(num(features, number), 1);
  const family = fields(raw, 30)[0].value;
  assert.equal(str(family, 1), 'Family');
  const entry = fields(family, 2)[0].value;
  assert.equal(str(entry, 1), 'effort');
  const value = fields(entry, 2)[0].value;
  assert.equal(num(value, 1), 1);
  assert.equal(str(value, 2), 'High');
  assert.equal(num(value, 3), 2);
});

test('mutation proof: schema drift fails the same full contract checker', { skip: !source }, () => {
  const mutateField = (typeName, number, transform) => {
    const raw = descriptorFrom(source, typeName).get(number).raw;
    const anchor = source.indexOf('typeName=`' + typeName + '`');
    const at = source.indexOf(raw, anchor);
    assert.ok(at >= anchor, `${typeName}.f${number} raw must sit under its own type`);
    const replacement = transform(raw);
    assert.notEqual(replacement, raw, `${typeName}.f${number} mutation must change the descriptor`);
    return source.slice(0, at) + replacement + source.slice(at + raw.length);
  };
  const cases = [
    ['dropped field', 'exa.codeium_common_pb.UserStatus', 33, raw => '', /UserStatus\.f33 is missing/],
    ['changed number', 'exa.codeium_common_pb.UserStatus', 33, raw => raw.replace('no:33', 'no:99'), /UserStatus\.f33 is missing/],
    ['changed name', 'exa.codeium_common_pb.ClientModelConfig', 22, raw => raw.replace('model_uid', 'model_id'), /ClientModelConfig\.f22/],
    ['changed kind', 'exa.codeium_common_pb.ClientModelConfig', 22, raw => raw.replace('kind:`scalar`', 'kind:`message`'), /ClientModelConfig\.f22/],
    ['changed scalar type', 'exa.codeium_common_pb.ClientModelConfig', 22, raw => raw.replace('T:9', 'T:8'), /ClientModelConfig\.f22/],
    ['changed repeated', 'exa.codeium_common_pb.ModelInfo', 20, raw => raw.replace(',repeated:!0', ''), /ModelInfo\.f20/],
    ['changed optional', 'exa.chat_pb.ChatToolDefinition', 12, raw => raw.replace('}', ',opt:!0}'), /ChatToolDefinition\.f12/],
    ['optional literal true', 'exa.chat_pb.ChatToolDefinition', 12, raw => raw.replace('}', ',opt:true}'), /ChatToolDefinition\.f12/],
    ['dropped optional', 'exa.chat_pb.ChatToolDefinition', 9, raw => raw.replace(',opt:!0', ''), /ChatToolDefinition\.f9/],
    ['optional literal false on an optional field', 'exa.chat_pb.ChatToolDefinition', 9, raw => raw.replace(',opt:!0', ',opt:!1'), /ChatToolDefinition\.f9/],
    ['repeated literal true on a non-repeated field', 'exa.codeium_common_pb.UserStatus', 33, raw => raw.replace('}', ',repeated:true}'), /UserStatus\.f33/],
    ['optional literal true with a spaced colon', 'exa.chat_pb.ChatToolDefinition', 12, raw => raw.replace('}', ',opt : true}'), /ChatToolDefinition\.f12/],
    ['repeated literal true with a spaced colon', 'exa.codeium_common_pb.UserStatus', 33, raw => raw.replace('}', ',repeated : true}'), /UserStatus\.f33/],
    ['non-boolean optional expression', 'exa.chat_pb.ChatToolDefinition', 12, raw => raw.replace('}', ',opt:someFlag}'), /boolean literal/],
    ['usage tokens demoted to int32', 'exa.codeium_common_pb.ModelUsageStats', 2, raw => raw.replace(',T:4', ',T:5'), /ModelUsageStats\.f2/],
    ['request tools no longer repeated', 'exa.api_server_pb.GetChatMessageRequest', 10, raw => raw.replace(',repeated:!0', ''), /GetChatMessageRequest\.f10/],
  ];
  for (const [name, typeName, number, mutate, expected] of cases) {
    assert.throws(() => assertContract(mutateField(typeName, number, mutate)), expected, name);
  }
  const enumType = 'exa.codeium_common_pb.StopReason';
  const enumRaw = '{no:3,name:`STOP_REASON_MAX_TOKENS`}';
  assert.ok(source.includes(enumRaw));
  assert.throws(() => assertContract(source.replace(enumRaw, '{no:4,name:`STOP_REASON_MAX_TOKENS`}')), /StopReason\.STOP_REASON_MAX_TOKENS/);
  const responseType = 'exa.api_server_pb.GetChatMessageResponse';
  const responseFields = descriptorFrom(source, responseType);
  const requestEnum = descriptorFrom(source, 'exa.api_server_pb.GetChatMessageRequest').get(6).raw.match(/,T:([^}]+)}/)[1];
  const toolMessage = responseFields.get(6).raw.match(/,T:([^,}]+)/)[1];
  assert.throws(() => assertContract(mutateField(responseType, 5, raw => raw.replace(/,T:[^}]+}/, ',T:' + requestEnum + '}'))),
    /GetChatMessageResponse\.f5/, 'a foreign enum reference must name f5');
  assert.throws(() => assertContract(mutateField(responseType, 7, raw => raw.replace(/,T:[^,}]+/, ',T:' + toolMessage))),
    /GetChatMessageResponse\.f7/, 'a foreign message reference must name f7');
  const equivalents = [
    ['repeated !0 as true', 'exa.codeium_common_pb.ModelInfo', 20, raw => raw.replace(',repeated:!0', ',repeated:true')],
    ['repeated !0 as spaced true', 'exa.codeium_common_pb.ModelInfo', 20, raw => raw.replace(',repeated:!0', ',repeated : true')],
    ['optional !0 as spaced true', 'exa.chat_pb.ChatToolDefinition', 9, raw => raw.replace(',opt:!0', ',opt : true')],
    ['absent opt as false', 'exa.codeium_common_pb.UserStatus', 33, raw => raw.replace('}', ',opt:false}')],
    ['absent opt as !1', 'exa.codeium_common_pb.UserStatus', 33, raw => raw.replace('}', ',opt:!1}')],
  ];
  for (const [name, typeName, number, mutate] of equivalents) assertContract(mutateField(typeName, number, mutate));
});

test('mutation proof: production codec wiring drift is caught', () => {
  const vm = require('node:vm');
  const filename = path.join(__dirname, '../src/protocol/native-chat-codec.cjs');
  const original = fs.readFileSync(filename, 'utf8');
  const mutated = original.replace("function textChunk(id, text) { return Buffer.concat([...prefix(id), s(3, text)]); }",
    "function textChunk(id, text) { return Buffer.concat([...prefix(id), s(4, text)]); }");
  assert.notEqual(mutated, original);
  const module = { exports: {} };
  vm.runInNewContext(mutated, { module, exports: module.exports, Buffer, Date,
    require: request => request === './wire.cjs' ? require('../src/protocol/wire.cjs') : require(request) }, { filename });
  assert.throws(() => assertTextChunk(module.exports));
});

test('type references resolve through static ESM bindings and fail loudly on drift', () => {
  const synthetic = (files) => Object.entries(files).map(([name, body]) => FILE_MARK + name + '\n' + body).join('\n');
  const common = [
    'var l={type:`enum-carrier`};',
    'util.setEnumType(l,`exa.codeium_common_pb.StopReason`,[{no:2,name:`STOP_REASON_STOP_PATTERN`}]);',
    'var e={type:`enum-carrier`};',
    'util.setEnumType(e,`exa.codeium_common_pb.Model`,[{no:1,name:`MODEL_UNSPECIFIED`}]);',
    'export{l as Dn,e as Gt};',
  ].join('\n');
  const editorBody = (importSpec, fields5, fields6) => [
    `import{${importSpec}}from"./common-x.js";`,
    'var R=class{static typeName=`x.Response`;',
    'static fields=x.newFieldList(()=>[' + fields5 + ',' + fields6 + '])};',
  ].join('\n');
  const responseField = (no, ref) => `{no:${no},name:\`f${no}\`,kind:\`enum\`,T:${ref}}`;
  const good = synthetic({
    'common-x.js': common,
    'editor.js': editorBody('Dn as B,Gt as H', responseField(5, 'S.getEnumType(B)'), responseField(6, 'S.getEnumType(H)')),
  });
  assert.equal(resolvedRef(good, 'x.Response', 5), 'exa.codeium_common_pb.StopReason');
  assert.equal(resolvedRef(good, 'x.Response', 6), 'exa.codeium_common_pb.Model');
  const renamed = synthetic({
    'common-x.js': common.replace('l as Dn', 'l as Zz'),
    'editor.js': editorBody('Zz as B,Gt as H', responseField(5, 'S.getEnumType(B)'), responseField(6, 'S.getEnumType(H)')),
  });
  assert.equal(resolvedRef(renamed, 'x.Response', 5), 'exa.codeium_common_pb.StopReason',
    'alias and re-export names may churn as long as the full typeName is stable');
  const local = synthetic({ 'one.js': 'var c=class{static typeName=`x.Y`;' +
    'static fields=x.newFieldList(()=>[{no:1,name:`p`,kind:`message`,T:c}])};' });
  assert.equal(resolvedRef(local, 'x.Y', 1), 'x.Y', 'same-file class references resolve locally');
  const missingImport = synthetic({ 'editor.js': editorBody('', responseField(5, 'S.getEnumType(B)'), responseField(6, 'S.getEnumType(B)')) });
  assert.throws(() => resolvedRef(missingImport, 'x.Response', 5), /unresolvable/);
  const missingExport = synthetic({
    'common-x.js': common.replace('l as Dn', 'l as Other'),
    'editor.js': editorBody('Dn as B,Gt as H', responseField(5, 'S.getEnumType(B)'), responseField(6, 'S.getEnumType(H)')),
  });
  assert.throws(() => resolvedRef(missingExport, 'x.Response', 5), /unresolvable export Dn/);
  const missingTarget = synthetic({ 'editor.js': editorBody('Dn as B', responseField(5, 'S.getEnumType(B)'), responseField(6, 'B')) });
  assert.throws(() => resolvedRef(missingTarget, 'x.Response', 5), /unresolvable import/);
  const bareForeign = synthetic({
    'common-x.js': common,
    'editor.js': editorBody('Dn as B', responseField(5, 'W'), responseField(6, 'B')),
  });
  assert.throws(() => resolvedRef(bareForeign, 'x.Response', 5), /unresolvable/);
  const duplicate = synthetic({
    'a.js': 'var A=class{static typeName=`x.Response`;static fields=x.newFieldList(()=>[{no:1,name:`a`,kind:`scalar`,T:9}])};',
    'b.js': 'var R=class{static typeName=`x.Response`;static fields=x.newFieldList(()=>[{no:5,name:`f5`,kind:`enum`,T:S.getEnumType(B)}])};',
  });
  assert.throws(() => resolvedRef(duplicate, 'x.Response', 5), /not unique/,
    'two real classes carrying the same typeName must be rejected, not silently picked');
  const ambiguous = synthetic({ 'one.js': [
    'var z=class{static typeName=`x.Amb`;',
    'static fields=x.newFieldList(()=>[{no:1,name:`p`,kind:`enum`,T:S.getEnumType(z)}])};',
    'util.setEnumType(z,`x.AmbEnum`,[{no:1,name:`A`}]);',
  ].join('\n') });
  assert.throws(() => resolvedRef(ambiguous, 'x.Amb', 1), /ambiguous/,
    'a local alias declared as both class and enum cannot be resolved arbitrarily');
  const chain = synthetic({
    'a.js': 'var q=class{static typeName=`x.Deep`;' +
      'static fields=x.newFieldList(()=>[{no:1,name:`v`,kind:`scalar`,T:9}])};export{q as Qa};',
    'b.js': 'import{Qa}from"./a.js";export{Qa as Qb};',
    'c.js': 'import{Qb as Q}from"./b.js";' +
      'var D=class{static typeName=`x.Use`;static fields=x.newFieldList(()=>[{no:1,name:`p`,kind:`message`,T:Q}])};',
  });
  assert.equal(resolvedRef(chain, 'x.Use', 1), 'x.Deep', 'an export of an import resolves transitively');
  const reExport = synthetic({
    'a.js': 'var q=class{static typeName=`x.Deep`;' +
      'static fields=x.newFieldList(()=>[{no:1,name:`v`,kind:`scalar`,T:9}])};export{q as Qa};',
    'b.js': 'export{Qa as Qb}from"./a.js";',
    'c.js': 'import{Qb as Q}from"./b.js";' +
      'var D=class{static typeName=`x.Use`;static fields=x.newFieldList(()=>[{no:1,name:`p`,kind:`message`,T:Q}])};',
  });
  assert.equal(resolvedRef(reExport, 'x.Use', 1), 'x.Deep', 'explicit re-exports resolve to their origin file');
  const cycled = synthetic({
    'a.js': 'export{Q as Qa}from"./b.js";',
    'b.js': 'export{Qa as Q}from"./a.js";',
    'c.js': 'import{Qa as Q}from"./a.js";' +
      'var D=class{static typeName=`x.Use`;static fields=x.newFieldList(()=>[{no:1,name:`p`,kind:`message`,T:Q}])};',
  });
  assert.throws(() => resolvedRef(cycled, 'x.Use', 1), /circular|unresolvable/);
});

// Loads this file's source in a VM with a fake node:test collector against a
// synthetic app root — the module-level pbBundle() call runs for real while
// no production tests register in the live runner.
function loadContractAt(root) {
  const vm = require('node:vm');
  const os = require('node:os');
  const collected = [];
  const fakeTest = (name, opts, fn) => { collected.push({ name, fn: typeof opts === 'function' ? opts : fn }); };
  fakeTest.skip = fakeTest;
  const sandboxRequire = name => name === 'node:test' ? fakeTest : require(name);
  const sandbox = { require: sandboxRequire, module: { exports: {} }, exports: {}, process: { env: { DFBYOK_TEST_APP_ROOT: root } },
    __dirname, __filename, Buffer, console };
  sandbox.globalThis = sandbox;
  try {
    vm.runInNewContext(fs.readFileSync(__filename, 'utf8'), sandbox, { filename: __filename });
  } catch (error) { return { loadError: error, collected }; }
  return { collected, loadError: null };
}
// Every synthetic install root is removed by the test that asked for it: an
// abandoned root would survive the run and silently accumulate in $TMPDIR.
const tempAssets = (t, files) => {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-schema-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, 'out/vs/workbench/devin-webapp-host/assets');
  fs.mkdirSync(assets, { recursive: true });
  for (const [name, sourceText] of Object.entries(files)) fs.writeFileSync(path.join(assets, name), sourceText);
  return root;
};

test('a present-but-schema-less assets dir fails the contract instead of skipping', t => {
  const { loadError } = loadContractAt(tempAssets(t, { 'app.js': 'export const x = 1;' }));
  assert.ok(loadError, 'assets without a schema bundle must throw, not skip');
  assert.match(String(loadError), /layout changed|no schema bundle/);
});

test('duplicated schema descriptors fail instead of silently picking one', t => {
  const schema = 'typeName=`exa.codeium_common_pb.UserStatus`;static fields=x.newFieldList(()=>[{no:33,name:`cascade_model_config_data`,kind:`message`}])';
  const { collected, loadError } = loadContractAt(tempAssets(t, { 'a.js': schema, 'b.js': schema }));
  assert.equal(loadError, null);
  assert.throws(() => collected[0].fn(), /descriptor is not unique/,
    'the duplicate descriptor itself must fail, not an unrelated missing field');
});

test('a truncated descriptor fails instead of being partially accepted', t => {
  const schema = 'typeName=`exa.codeium_common_pb.UserStatus`;static fields=x.newFieldList(()=>[{no:33,name:`cascade_model_config_data`,kind:`message`}])';
  const { collected, loadError } = loadContractAt(tempAssets(t, { 'a.js': schema.slice(0, -2) }));
  assert.equal(loadError, null);
  assert.throws(() => collected[0].fn(), /not found|unterminated/);
});

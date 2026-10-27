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
    if (source.includes('typeName=`exa.')) sources.push(source);
  }
  if (!sources.length) throw new Error('installed Devin layout changed: assets present but no schema bundle found');
  return sources.join('\n');
}

const source = pbBundle();
const descriptor = typeName => {
  const hit = source.match(new RegExp('typeName=`' + typeName.replace(/\./g, '\\.') + '`;static fields=[^=]+\\.newFieldList\\(\\(\\)=>\\[([\\s\\S]*?)\\]\\)'));
  if (!hit) throw new Error('installed schema message not found: ' + typeName);
  if (source.split('typeName=`' + typeName + '`').length - 1 !== 1) throw new Error('installed schema descriptor is not unique: ' + typeName);
  const fields = new Map();
  for (const part of hit[1].matchAll(/\{no:(\d+),name:`([^`]+)`,kind:`(\w+)`[^}]*\}/g)) {
    fields.set(Number(part[1]), { name: part[2], kind: part[3] });
  }
  if (!fields.size) throw new Error('installed schema has no fields: ' + typeName);
  return fields;
};

test('the fields this plugin reads keep their numbers and kinds in the installed schema', { skip: !source }, () => {
  const userStatus = descriptor('exa.codeium_common_pb.UserStatus');
  assert.equal(userStatus.get(33)?.kind, 'message', 'UserStatus.f33 carries cascade_model_config_data');
  const config = descriptor('exa.codeium_common_pb.ClientModelConfig');
  assert.equal(config.get(22)?.kind, 'scalar', 'ClientModelConfig.f22 is the model uid');
  const info = descriptor('exa.codeium_common_pb.ModelInfo');
  for (const [no, kind] of [[4, 'scalar'], [18, 'scalar'], [20, 'scalar'], [22, 'enum'], [23, 'scalar'], [25, 'scalar']]) {
    assert.equal(info.get(no)?.kind, kind, `ModelInfo.f${no} keeps kind ${kind}`);
  }
  const assignment = descriptor('exa.api_server_pb.ModelAssignment');
  for (const no of [1, 2, 3]) assert.ok(assignment.has(no), `ModelAssignment.f${no}`);
  const assignRequest = descriptor('exa.api_server_pb.AssignModelRequest');
  for (const no of [2, 6]) assert.ok(assignRequest.has(no), `AssignModelRequest.f${no}`);
});

test('newer fields are registered without being relied on', { skip: !source }, () => {
  // Presence-only registration: these fields exist in the 3.11.216 schema but
  // this build deliberately does not read or transform them.
  assert.equal(descriptor('exa.codeium_common_pb.ModelInfo').get(26)?.kind, 'message', 'ModelInfo.f26 compaction_thresholds registered');
  assert.ok(descriptor('exa.chat_pb.ChatMessagePrompt').has(22), 'ChatMessagePrompt.f22 generation_model_uid registered');
  assert.ok(descriptor('exa.codeium_common_pb.ModelUsageStats').has(13), 'ModelUsageStats.f13 used_provider_plan registered');
  assert.ok(descriptor('exa.api_server_pb.GetChatMessageRequest').has(28), 'GetChatMessageRequest.f28 session_id registered');
  // Presence-only: we pass GetChatMessageResponse through untouched, so these
  // register the fields exist — not that we decode or depend on them.
  const chatResponse = descriptor('exa.api_server_pb.GetChatMessageResponse');
  assert.equal(chatResponse.get(29)?.kind, 'message', 'GetChatMessageResponse.f29 notifications registered');
  assert.equal(chatResponse.get(29)?.name, 'notifications');
  assert.equal(chatResponse.get(30)?.kind, 'message', 'GetChatMessageResponse.f30 model_change registered');
  assert.equal(chatResponse.get(30)?.name, 'model_change');
});

test('the field numbers the chat codec reads and writes match the installed schema', { skip: !source }, () => {
  // These field numbers are hand-coded in src/protocol/native-chat-codec.cjs
  // (request parsing, response framing, usage accounting). Until now they had
  // only self-referential fixture coverage: a Devin upgrade that renumbers any
  // of them would leave every test green while decoding garbage.
  const CODEC_FIELDS = {
    'exa.api_server_pb.GetChatMessageRequest': { 2: 'prompt', 3: 'chat_message_prompts', 6: 'internal_chat_model', 10: 'tools', 11: 'disable_parallel_tool_calls', 12: 'tool_choice', 21: 'chat_model_uid', 27: 'prompt_cache_key' },
    'exa.chat_pb.ChatMessagePrompt': { 1: 'message_id', 2: 'source', 3: 'prompt', 6: 'tool_calls', 7: 'tool_call_id', 9: 'tool_result_is_error', 10: 'images', 11: 'thinking', 12: 'signature', 20: 'videos', 21: 'documents' },
    'exa.chat_pb.ChatToolDefinition': { 1: 'name', 2: 'description', 3: 'json_schema_string', 8: 'computer_use_config', 9: 'is_custom_tool', 10: 'custom_tool_grammar', 11: 'custom_tool_grammar_syntax', 12: 'strict' },
    'exa.chat_pb.ChatToolChoice': { 1: 'option_name', 2: 'tool_name' },
    'exa.codeium_common_pb.ChatToolCall': { 1: 'id', 2: 'name', 3: 'arguments_json', 6: 'is_custom_tool_call' },
    'exa.codeium_common_pb.ImageData': { 1: 'base64_data', 2: 'mime_type', 3: 'caption' },
    'exa.codeium_common_pb.VideoData': { 1: 'base64_data', 2: 'mime_type', 3: 'url' },
    'exa.codeium_common_pb.DocumentData': { 1: 'base64_data', 2: 'mime_type', 3: 'filename', 4: 'url' },
    'exa.codeium_common_pb.ModelUsageStats': { 2: 'input_tokens', 3: 'output_tokens', 4: 'cache_write_tokens', 5: 'cache_read_tokens', 7: 'message_id', 9: 'model_uid' },
    'exa.api_server_pb.GetChatMessageResponse': { 1: 'message_id', 2: 'timestamp', 3: 'delta_text', 5: 'stop_reason', 6: 'delta_tool_calls', 7: 'usage', 9: 'delta_thinking', 10: 'delta_signature', 11: 'thinking_redacted', 23: 'actual_model_uid' },
  };
  for (const [type, expected] of Object.entries(CODEC_FIELDS)) {
    const fields = descriptor(type);
    for (const [no, name] of Object.entries(expected)) {
      assert.equal(fields.get(Number(no))?.name, name, `${type}.f${no}`);
    }
  }
});

test('mutation proof: a dropped field number makes the contract fail', { skip: !source }, () => {
  // Removing the f33 descriptor from a copy must flip the same parse to absent.
  const hit = source.match(/typeName=`exa\.codeium_common_pb\.UserStatus`;static fields=[^=]+\.newFieldList\(\(\)=>\[([\s\S]*?)\]\)/);
  assert.ok(hit);
  const mutated = hit[1].replace(/\{no:33,[^{}]*\}/, '');
  const fields = new Map([...mutated.matchAll(/\{no:(\d+),name:`[^`]+`,kind:`(\w+)`/g)].map(part => [Number(part[1]), part[2]]));
  assert.equal(fields.has(33), false, 'a schema that dropped f33 no longer satisfies the contract');
  assert.throws(() => assert.equal(fields.get(33)?.kind, 'message'));
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
const tempAssets = files => {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbyok-schema-'));
  const assets = path.join(root, 'out/vs/workbench/devin-webapp-host/assets');
  fs.mkdirSync(assets, { recursive: true });
  for (const [name, sourceText] of Object.entries(files)) fs.writeFileSync(path.join(assets, name), sourceText);
  return root;
};

test('a present-but-schema-less assets dir fails the contract instead of skipping', () => {
  const { loadError } = loadContractAt(tempAssets({ 'app.js': 'export const x = 1;' }));
  assert.ok(loadError, 'assets without a schema bundle must throw, not skip');
  assert.match(String(loadError), /layout changed|no schema bundle/);
});

test('duplicated schema descriptors fail instead of silently picking one', () => {
  const schema = 'typeName=`exa.codeium_common_pb.UserStatus`;static fields=x.newFieldList(()=>[{no:33,name:`cascade_model_config_data`,kind:`message`}])';
  const { collected, loadError } = loadContractAt(tempAssets({ 'a.js': schema, 'b.js': schema }));
  assert.equal(loadError, null);
  assert.throws(() => collected[0].fn(), /descriptor is not unique/,
    'the duplicate descriptor itself must fail, not an unrelated missing field');
});

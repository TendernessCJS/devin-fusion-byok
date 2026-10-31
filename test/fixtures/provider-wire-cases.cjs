'use strict';
// Neutral scenario builders for the fixed wire-contract matrix. Verbatim copy
// of the capture inputs recorded in provider-wire-contract.json at 04dc73d —
// do not "improve" these literals: any change invalidates the baseline.

const { STATE_PREFIX, stateScope } = require('../../src/protocol/state-envelope.cjs');

const route = { model: 'fixture-model', uid: 'local-fixture-uid', effort: 'high' };
const provider = { id: 'provider-fixture-1', baseUrl: 'https://provider.example.invalid/v1', apiKey: 'fixture-key', apiFormat: 'openai-responses' };
const formats = ['openai-responses', 'openai-chat-completions', 'anthropic'];

const schemaArray = {
  type: 'object',
  properties: {
    cmd: { type: 'string', description: 'command' },
    target: { type: ['string', 'null'], description: 'keeps the array form verbatim' },
    description: { type: 'string' },
    options: { anyOf: [{ type: 'string' }, { type: 'object', properties: { retries: { type: 'integer', default: 3 } } }] },
  },
  required: ['cmd'],
  additionalProperties: false,
};
const tools = [
  { name: 'shell_command', description: 'Run a command', parameters: schemaArray, strict: true },
  { name: 'sidekick', description: 'Delegate work', parameters: { type: 'object', properties: { prompt: { type: 'string' } } }, strict: false },
];

const scenarios = {
  'plain-text': () => ({ systemPrompt: 'system instructions', messages: [{ role: 'user', content: 'hello' }] }),
  'multi-turn-system-middle': () => ({
    systemPrompt: 'lead prompt',
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer one' },
      { role: 'system', content: 'mid stream system' },
      { role: 'user', content: 'second' },
    ],
  }),
  'parallel-tools': () => ({
    systemPrompt: '',
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'checking', toolCalls: [
        { id: 'call_1', name: 'shell_command', arguments: '{"cmd":"ls"}' },
        { id: 'call_2', name: 'sidekick', arguments: '{"prompt":"task"}' },
      ] },
      { role: 'tool', toolCallId: 'call_1', content: 'ok' },
      { role: 'tool', toolCallId: 'call_2', content: 'done', toolResultIsError: true },
    ],
  }),
  'tool-empty-input': () => ({
    systemPrompt: '',
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_e', name: 'shell_command', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'call_e', content: '' },
    ],
  }),
  'raw-json-whitespace': () => ({
    systemPrompt: '',
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_w', name: 'shell_command', arguments: '{ "cmd" :  "echo 1" }' }] },
      { role: 'tool', toolCallId: 'call_w', content: 'echo 1' },
    ],
  }),
  'strict-and-parallel': () => ({
    systemPrompt: 'sys', tools, disableParallelToolCalls: true,
    messages: [{ role: 'user', content: 'go' }],
  }),
  'forced-tool-choice': () => ({
    systemPrompt: 'sys', tools, toolChoice: { type: 'function', name: 'shell_command' },
    messages: [{ role: 'user', content: 'go' }],
  }),
  'forced-anthropic-choice': () => ({
    systemPrompt: 'sys', tools, toolChoice: { type: 'tool', name: 'shell_command' },
    messages: [{ role: 'user', content: 'go' }],
  }),
  'custom-tool-grammar': () => ({
    systemPrompt: '',
    tools: [{ name: 'pattern_search', description: 'raw input tool', parameters: { type: 'object', properties: {} }, isCustomTool: true, customToolGrammar: 'start: "x"', customToolGrammarSyntax: 'lark' }],
    messages: [
      { role: 'user', content: 'search' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_c', name: 'pattern_search', arguments: 'not json', isCustomToolCall: true }] },
      { role: 'tool', toolCallId: 'call_c', content: 'hit' },
    ],
  }),
  'image-attachment': () => ({
    systemPrompt: '',
    messages: [{ role: 'user', content: 'look', images: [{ base64: 'aGVsbG8=', mimeType: 'image/png', caption: 'caption text' }], documents: [] }],
  }),
  'document-attachment': () => ({
    systemPrompt: '',
    messages: [{ role: 'user', content: 'read', documents: [{ base64: Buffer.from('plain body').toString('base64'), mimeType: 'text/plain', filename: 'note.txt' }], images: [] }],
  }),
  'prompt-cache-key': () => ({ systemPrompt: 'sys', promptCacheKey: 'cache-key-1', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] }),
  'signed-thinking': () => ({
    systemPrompt: '',
    messages: [
      { role: 'user', content: 'think' },
      { role: 'assistant', content: 'visible', thinking: 'internal reasoning', signature: 'EqQBCgIYAhIMsignature-fixture' },
      { role: 'user', content: 'next' },
    ],
  }),
  'redacted-thinking': () => ({
    systemPrompt: '',
    messages: [
      { role: 'user', content: 'think' },
      { role: 'assistant', content: 'visible', thinking: '', signature: 'dfbyok-redacted-v1:opaque-fixture-bytes' },
      { role: 'user', content: 'next' },
    ],
  }),
  'responses-state-replay': () => {
    const items = [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'planned' }], encrypted_content: 'fixture-encrypted-content' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'assistant answer' }] }];
    const envelope = STATE_PREFIX + Buffer.from(JSON.stringify({ scope: stateScope(provider, route), items })).toString('base64url');
    return {
      systemPrompt: 'sys',
      messages: [
        { role: 'user', content: 'plan' },
        { role: 'assistant', content: 'assistant answer', signature: envelope },
        { role: 'user', content: 'continue' },
      ],
    };
  },
  'responses-state-foreign-scope': () => {
    const items = [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'planned' }], encrypted_content: 'fixture-encrypted-content' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'assistant answer' }] }];
    const envelope = STATE_PREFIX + Buffer.from(JSON.stringify({ scope: 'scope-from-another-provider', items })).toString('base64url');
    return {
      systemPrompt: 'sys',
      messages: [
        { role: 'user', content: 'plan' },
        { role: 'assistant', content: 'assistant answer', signature: envelope },
        { role: 'user', content: 'continue' },
      ],
    };
  },
  'foreign-responses-envelope-on-anthropic': () => ({
    systemPrompt: '',
    messages: [
      { role: 'user', content: 'plan' },
      { role: 'assistant', content: 'answer', signature: 'dfbyok-responses-v1:eyJzY29wZSI6IngiLCJpdGVtcyI6W119' },
      { role: 'user', content: 'continue' },
    ],
  }),
};

// The baseline's one extra case: Anthropic built with the cache-breakpoint
// capability off, pinning the flag rather than implying it.
const EXTRA = {
  name: 'prompt-cache-key-no-breakpoints',
  scenario: 'prompt-cache-key',
  format: 'anthropic',
  options: { cacheBreakpoints: false },
};

module.exports = { route, provider, formats, tools, scenarios, EXTRA };

'use strict';

const { isAnthropicFormat, buildAnthropicBody } = require('./anthropic.cjs');
const { STATE_PREFIX, MAX_STATE_BYTES, stateScope, replayMatches } = require('./state-envelope.cjs');

function isChatFormat(format = '') { return /chat[-_\/]?completions|^(?:chat|openai)$/.test(format); }
const STANDARD_CHAT_FINISH = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']);

function endpoint(provider) {
  const url = new URL(provider.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid provider URL');
  const anthropic = isAnthropicFormat(provider.apiFormat);
  const chat = anthropic || isChatFormat(provider.apiFormat);
  url.pathname = url.pathname.replace(/\/(responses|chat\/completions|messages)\/?$/, '').replace(/\/$/, '') +
    (anthropic ? '/messages' : chat ? '/chat/completions' : '/responses');
  url.search = '';
  url.hash = '';
  return { url, chat, anthropic };
}

// A forced/required choice is the only kind a thinking-mode provider refuses;
// `auto`, `none` and an absent value are always accepted.
function forcedToolChoice(body) {
  const choice = body?.tool_choice;
  if (choice === undefined || choice === null) return false;
  const type = typeof choice === 'object' ? choice.type : choice;
  return type !== undefined && type !== 'auto' && type !== 'none';
}

function contentOf(message, chat) {
  if (!message.images?.length) return message.content;
  const parts = [];
  if (message.content !== '') parts.push(chat ? { type: 'text', text: message.content } : { type: 'input_text', text: message.content });
  for (const image of message.images) {
    const url = `data:${image.mimeType};base64,${image.base64}`;
    parts.push(chat ? { type: 'image_url', image_url: { url } } : { type: 'input_image', image_url: url });
    if (image.caption) parts.push(chat ? { type: 'text', text: image.caption } : { type: 'input_text', text: image.caption });
  }
  return parts;
}

function buildRequestBody(request, route, provider, onState = () => {}) {
  if (isAnthropicFormat(provider.apiFormat)) return buildAnthropicBody(request, route, provider);
  const chat = isChatFormat(provider.apiFormat);
  const messages = [];
  if (request.systemPrompt !== '') messages.push({ role: chat ? 'system' : 'developer', content: request.systemPrompt });
  for (const message of request.messages) {
    if (message.role === 'tool') {
      messages.push(chat ? { role: 'tool', tool_call_id: message.toolCallId, content: message.content } : { type: 'function_call_output', call_id: message.toolCallId, output: message.content });
      continue;
    }
    const content = contentOf(message, chat);
    if (chat) {
      const item = { role: message.role, content };
      if (message.toolCalls?.length) item.tool_calls = message.toolCalls.map(tool => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } }));
      messages.push(item);
    } else {
      if (message.role === 'assistant' &&
          typeof message.signature === 'string' && message.signature.startsWith(STATE_PREFIX) &&
          !message.images?.length) {
        const bytes = Buffer.byteLength(message.signature);
        let state = null;
        if (bytes <= MAX_STATE_BYTES) {
          try { state = JSON.parse(Buffer.from(message.signature.slice(STATE_PREFIX.length), 'base64url').toString('utf8')); } catch {}
        }
        const outcome = bytes > MAX_STATE_BYTES ? 'oversize'
          : !state ? 'unparsable'
          : state.scope !== stateScope(provider, route) ? 'scope'
          : (!Array.isArray(state.items) || !state.items.length) ? 'invalid'
          : replayMatches(state, message) ? 'replayed' : 'mismatch';
        onState(outcome === 'replayed' ? { outcome, bytes, items: state.items.length } : { outcome, bytes });
        if (outcome === 'replayed') {
          messages.push(...state.items);
          continue;
        }
      }
      // A native message stores text before its repeated tool calls. Preserve
      // that sequence and keep every system message at its original position.
      if (content !== '' || !message.toolCalls?.length) messages.push({ role: message.role === 'system' ? 'developer' : message.role, content });
      for (const tool of message.toolCalls || []) messages.push({ type: 'function_call', call_id: tool.id, name: tool.name, arguments: tool.arguments });
    }
  }
  const body = { model: route.model, [chat ? 'messages' : 'input']: messages, stream: true };
  if (chat) body.stream_options = { include_usage: true };
  if (!chat) {
    body.store = false;
    body.include = ['reasoning.encrypted_content'];
  }
  if (request.disableParallelToolCalls === true) body.parallel_tool_calls = false;
  const maxTokens = request.maxTokens ?? route.maxOutputTokens ?? route.maxTokens ?? provider.maxOutputTokens ?? provider.maxTokens;
  if (Number.isSafeInteger(maxTokens) && maxTokens > 0) body[chat ? 'max_completion_tokens' : 'max_output_tokens'] = maxTokens;
  if (route.effort) {
    if (chat) body.reasoning_effort = route.effort;
    else body.reasoning = { effort: route.effort, ...(route.effort === 'none' ? {} : { summary: 'auto' }) };
  }
  if (request.tools?.length) {
    // Native strict is a plain proto3 bool, so an unset field and an explicit
    // false are indistinguishable; always send the boolean, because omitting it
    // lets a Responses server auto-enable strict validation on a compatible schema.
    body.tools = request.tools.map(tool => {
      // Chat Completions has no custom tool type; custom tools stay function-shaped.
      if (chat) return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters, strict: tool.strict === true } };
      if (tool.isCustomTool === true) {
        const custom = { type: 'custom', name: tool.name };
        if (tool.description) custom.description = tool.description;
        if (tool.customToolGrammar && ['lark', 'regex'].includes(tool.customToolGrammarSyntax))
          custom.format = { type: 'grammar', definition: tool.customToolGrammar, syntax: tool.customToolGrammarSyntax };
        return custom;
      }
      return { type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: tool.strict === true };
    });
    const choice = request.toolChoice;
    if (choice?.name) body.tool_choice = chat ? { type: 'function', function: { name: choice.name } } : { type: 'function', name: choice.name };
    else if (choice) {
      const type = typeof choice === 'string' ? choice : choice.type;
      if (['auto', 'none', 'required', 'any'].includes(type)) body.tool_choice = type === 'any' ? 'required' : type;
    }
  }
  return body;
}

module.exports = { isChatFormat, STANDARD_CHAT_FINISH, endpoint, forcedToolChoice, contentOf, buildRequestBody };

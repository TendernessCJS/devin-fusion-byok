'use strict';

// Anthropic Messages API support. Requests are translated from the neutral
// Devin request shape; streamed events are adapted into Chat Completions-style
// chunks so the shared processor and monitor handle them unchanged.
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_OUTPUT_TOKENS = 128000;
const DEFAULT_OUTPUT_TOKENS = 64000;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// ACP field 10 is shared: the Responses path also writes its state envelope
// there. Never replay a foreign envelope as a thinking signature — Anthropic
// requires the original signature verbatim, and a foreign string earns a 400.
const FOREIGN_STATE_PREFIX = 'dfbyok-';
// ACP has only a boolean redacted marker (field 11); the opaque data rides the
// signature channel (field 10) under this prefix — same lane as the Responses
// state envelope, distinguished by prefix.
const REDACTED_PREFIX = 'dfbyok-redacted-v1:';

// Anthropic has no prompt_cache_key equivalent; prompt caching needs an
// explicit ephemeral breakpoint. One marker on the last cacheable block of
// the penultimate message reuses the shared prefix — the final message is
// the new turn content, so a breakpoint there buys nothing.
const CACHEABLE_BLOCK = new Set(['text', 'tool_result', 'tool_use', 'image', 'document']);

function isAnthropicFormat(format = '') { return format === 'anthropic'; }

function anthropicHeaders(apiKey) {
  return { 'anthropic-version': ANTHROPIC_VERSION, ...(apiKey ? { 'x-api-key': apiKey } : {}) };
}

function attachmentUnsupported(detail) {
  const err = new Error('Attachments are not supported by this protocol');
  err.code = 'attachment_unsupported';
  err.detail = detail;
  return err;
}

function textBlocks(message) {
  const blocks = [];
  if (message.content) blocks.push({ type: 'text', text: message.content });
  for (const image of message.images || []) {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } });
    if (image.caption) blocks.push({ type: 'text', text: image.caption });
  }
  for (const doc of message.documents || []) {
    if (doc.base64 && doc.mimeType === 'application/pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: doc.base64 } });
    } else if (doc.base64 && doc.mimeType === 'text/plain') {
      blocks.push({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: Buffer.from(doc.base64, 'base64').toString('utf8') } });
    } else throw attachmentUnsupported(doc.mimeType || 'document');
  }
  if (message.videos?.length) throw attachmentUnsupported('video');
  return blocks;
}

function toolInput(args) {
  try {
    const value = JSON.parse(args || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

// Neutral history -> merged Anthropic turns. Kept as a separate function so the
// pairing probe below can inspect exactly what the wire body would contain —
// running it on raw request.messages would misjudge parallel tool results.
function buildTurns(request) {
  const system = request.systemPrompt ? [request.systemPrompt] : [];
  const messages = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = messages.at(-1);
    // Merge adjacent turns so parallel tool results share one user message.
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const message of request.messages) {
    if (message.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content || '', ...(message.toolResultIsError ? { is_error: true } : {}) }]);
    } else if (message.role === 'system') {
      // Leading system messages join the system prompt; later ones keep their position as user text.
      if (!messages.length) { if (message.content) system.push(message.content); }
      else push('user', message.content ? [{ type: 'text', text: message.content }] : []);
    } else if (message.role === 'assistant') {
      // Claude requires the original thinking block, signature included, to be
      // replayed verbatim once extended thinking is used together with tools.
      // A redacted-prefixed signature instead replays the redacted block itself.
      const thinking = message.signature?.startsWith(REDACTED_PREFIX)
        ? [{ type: 'redacted_thinking', data: message.signature.slice(REDACTED_PREFIX.length) }]
        : message.signature && !message.signature.startsWith(FOREIGN_STATE_PREFIX)
          ? [{ type: 'thinking', thinking: message.thinking || '', signature: message.signature }] : [];
      push('assistant', [...thinking, ...textBlocks(message),
        ...(message.toolCalls || []).map(tool => ({ type: 'tool_use', id: tool.id, name: tool.name, input: toolInput(tool.arguments) }))]);
    } else {
      push('user', textBlocks(message));
    }
  }
  return { system, messages };
}

// Read-only audit of the merged turns: whether every tool_result can find its
// tool_use. The native side assembles this history, so whether Anthropic's
// pairing invariants hold can only be observed, not asserted statically.
function inspectToolPairing(request) {
  const counts = { orphan: 0, nonAdjacent: 0, duplicate: 0, notFirst: 0 };
  const idsSoFar = new Set();
  const resultIds = new Set();
  let lastAssistantIds = new Set();
  for (const turn of buildTurns(request).messages) {
    if (turn.role === 'assistant') {
      lastAssistantIds = new Set();
      for (const block of turn.content) {
        if (block.type === 'tool_use' && block.id) { idsSoFar.add(block.id); lastAssistantIds.add(block.id); }
      }
      continue;
    }
    if (turn.content.findIndex(block => block.type === 'tool_result') > 0) counts.notFirst++;
    for (const block of turn.content) {
      if (block.type !== 'tool_result') continue;
      if (!idsSoFar.has(block.tool_use_id)) counts.orphan++;
      else if (!lastAssistantIds.has(block.tool_use_id)) counts.nonAdjacent++;
      if (resultIds.has(block.tool_use_id)) counts.duplicate++;
      else resultIds.add(block.tool_use_id);
    }
    // Only the immediately preceding assistant turn counts as adjacent.
    lastAssistantIds = new Set();
  }
  return counts;
}

function buildAnthropicBody(request, route, provider, options = {}) {
  const { system, messages } = buildTurns(request);
  const requested = request.maxTokens ?? route.maxOutputTokens ?? route.maxTokens ?? provider.maxOutputTokens ?? provider.maxTokens;
  const maxTokens = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, MAX_OUTPUT_TOKENS) : DEFAULT_OUTPUT_TOKENS;
  const body = { model: route.model, max_tokens: maxTokens, messages, stream: true };
  if (system.length) body.system = system.join('\n\n');
  const effort = route.effort === 'minimal' ? 'low' : route.effort;
  if (EFFORTS.has(effort)) body.output_config = { effort };
  if (request.tools?.length) {
    // Anthropic Messages has no custom tool type; custom tools stay function-shaped.
    body.tools = request.tools.map(tool => ({ name: tool.name, description: tool.description,
      input_schema: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
      ...(tool.strict === true ? { strict: true } : {}) }));
    // Forced choices only degrade to auto after the provider refuses them (400 on tool_choice).
    const choice = request.toolChoice;
    const type = typeof choice === 'string' ? choice : choice?.type;
    if (['auto', 'any', 'none'].includes(type)) body.tool_choice = { type };
    else if (choice?.name) body.tool_choice = { type: 'tool', name: choice.name };
    else if (choice) body.tool_choice = { type: 'auto' };
    if (request.disableParallelToolCalls === true && body.tool_choice?.type !== 'none')
      body.tool_choice = { ...(body.tool_choice || { type: 'auto' }), disable_parallel_tool_use: true };
  }
  if (options.cacheBreakpoints === true && request.promptCacheKey && messages.length >= 2) {
    const blocks = messages.at(-2).content;
    for (let index = blocks.length - 1; index >= 0; index--) {
      if (CACHEABLE_BLOCK.has(blocks[index]?.type)) {
        blocks[index].cache_control = { type: 'ephemeral' };
        break;
      }
    }
  }
  return body;
}

// Returns a copy without any cache_control markers; the input stays untouched
// so the original request body can still be compared or logged as sent.
function stripCacheControl(body) {
  const cleanBlock = block => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return block;
    const { cache_control: _cacheControl, ...rest } = block;
    return rest;
  };
  const stripped = { ...body };
  if (Array.isArray(body.tools)) stripped.tools = body.tools.map(cleanBlock);
  if (Array.isArray(body.system)) stripped.system = body.system.map(cleanBlock);
  if (Array.isArray(body.messages)) {
    stripped.messages = body.messages.map(message => (message && typeof message === 'object'
      ? { ...message, content: Array.isArray(message.content) ? message.content.map(cleanBlock) : message.content }
      : message));
  }
  return stripped;
}

// ACP has no pause semantics, so pause_turn still ends as a normal stop, but
// the original reason is preserved for attribution through provider-stop logs.
const FINISH = { max_tokens: 'length', model_context_window_exceeded: 'length', refusal: 'content_filter', pause_turn: 'pause_turn' };

function createAnthropicAdapter() {
  const blocks = new Map();
  let redactedSent = false;
  const usage = { input: null, cacheRead: 0, cacheCreate: 0, output: null, thinking: null };
  const readUsage = value => {
    if (!value || typeof value !== 'object') return;
    if (Number.isSafeInteger(value.input_tokens)) usage.input = value.input_tokens;
    if (Number.isSafeInteger(value.cache_read_input_tokens)) usage.cacheRead = value.cache_read_input_tokens;
    if (Number.isSafeInteger(value.cache_creation_input_tokens)) usage.cacheCreate = value.cache_creation_input_tokens;
    if (Number.isSafeInteger(value.output_tokens)) usage.output = value.output_tokens;
    if (Number.isSafeInteger(value.output_tokens_details?.thinking_tokens)) usage.thinking = value.output_tokens_details.thinking_tokens;
  };
  const chunk = (type, delta, extra = {}) => ({ type, data: { choices: [{ index: 0, delta, ...extra }] } });
  const toolDelta = (type, index, call) => chunk(type, { tool_calls: [{ index, ...call }] });
  return function adapt(event) {
    const data = event.data;
    if (event.type === 'done' || event.type === 'message_stop') return [{ type: 'done' }];
    if (!data || event.type === 'ping') return [];
    switch (event.type) {
      case 'message_start':
        readUsage(data.message?.usage);
        return [{ type: event.type, data: { choices: [] } }];
      case 'content_block_start': {
        const block = data.content_block || {};
        const index = data.index ?? 0;
        if (block.type === 'text') return block.text ? [chunk(event.type, { content: block.text })] : [];
        if (block.type === 'thinking') return block.thinking ? [chunk(event.type, { reasoning_content: block.thinking })] : [];
        // Only the first redacted block per response carries its data on the
        // signature lane; later blocks degrade to the bare marker.
        if (block.type === 'redacted_thinking') {
          if (typeof block.data === 'string' && block.data && !redactedSent) {
            redactedSent = true;
            return [chunk(event.type, { thinking_redacted: true, signature: REDACTED_PREFIX + block.data })];
          }
          return [chunk(event.type, { thinking_redacted: true })];
        }
        if (block.type !== 'tool_use') return [];
        const input = block.input && typeof block.input === 'object' && Object.keys(block.input).length ? JSON.stringify(block.input) : '';
        blocks.set(index, { streamed: false, input });
        return [toolDelta(event.type, index, { id: block.id, function: { name: block.name, arguments: '' } })];
      }
      case 'content_block_delta': {
        const delta = data.delta || {};
        const index = data.index ?? 0;
        if (delta.type === 'text_delta' && delta.text) return [chunk(event.type, { content: delta.text })];
        if (delta.type === 'thinking_delta' && delta.thinking) return [chunk(event.type, { reasoning_content: delta.thinking })];
        if (delta.type === 'signature_delta' && delta.signature) return [chunk(event.type, { signature: delta.signature })];
        if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && blocks.has(index)) {
          if (delta.partial_json) blocks.get(index).streamed = true;
          return delta.partial_json ? [toolDelta(event.type, index, { function: { arguments: delta.partial_json } })] : [];
        }
        return [];
      }
      case 'content_block_stop': {
        const index = data.index ?? 0;
        const tool = blocks.get(index);
        // A tool call without argument deltas still needs valid JSON arguments.
        if (!tool || tool.streamed) return [];
        tool.streamed = true;
        return [toolDelta(event.type, index, { function: { arguments: tool.input || '{}' } })];
      }
      case 'message_delta': {
        readUsage(data.usage);
        const reason = data.delta?.stop_reason;
        const result = chunk(event.type, {}, reason ? { finish_reason: FINISH[reason] || 'stop' } : {});
        if (usage.input !== null && usage.output !== null) {
          result.data.usage = { prompt_tokens: usage.input + usage.cacheRead + usage.cacheCreate, completion_tokens: usage.output,
            // `cache_creation_tokens` inside prompt_tokens_details is our own
            // internal convention between this adapter and usageSnapshot().
            prompt_tokens_details: { cached_tokens: usage.cacheRead, cache_creation_tokens: usage.cacheCreate },
            ...(Number.isSafeInteger(usage.thinking) ? { completion_tokens_details: { reasoning_tokens: usage.thinking } } : {}) };
        }
        return [result];
      }
      case 'error': return [{ type: 'error', data: { error: data.error || true } }];
      default: return [];
    }
  };
}

module.exports = { ANTHROPIC_VERSION, isAnthropicFormat, anthropicHeaders, buildAnthropicBody, buildTurns, inspectToolPairing, stripCacheControl, createAnthropicAdapter };

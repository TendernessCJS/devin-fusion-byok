'use strict';
const { textChunk, thinkingChunk, signatureChunk, redactedThinkingChunk, toolChunk, stopChunk, usageChunk } = require('./native-chat-codec.cjs');
const { STATE_PREFIX, MAX_STATE_BYTES, validStateItem } = require('./state-envelope.cjs');
const { usageSnapshot, providerErrorCode } = require('./provider-events.cjs');

function createStreamProcessor({ id, uid, chat, emit, scope = null, onSkip = () => {}, onStateSize = () => {}, onDiag = () => {}, declaredTools = null }) {
  const calls = new Map();
  const itemIndexes = new Map();
  const stateItems = new Map();
  let finalItems = null;
  const texts = new Map();
  let emittedText = 0;
  let terminal = false;
  let reason = 2;
  let chatFinish = null;
  let finished = false;
  let usage = null;
  let finishedResult = null;
  const getCall = (index, itemId) => {
    const key = index ?? itemIndexes.get(itemId) ?? itemId;
    if (key === undefined) {
      const err = new Error('Tool call has no index');
      err.code = 'upstream_invalid_tool';
      err.detail = 'no-index';
      throw err;
    }
    if (itemId) itemIndexes.set(itemId, key);
    if (!calls.has(key)) calls.set(key, { id: '', name: '', arguments: '', complete: undefined });
    return calls.get(key);
  };
  const setName = (call, name) => {
    if (!name) return;
    if (call.name && call.name !== name) { const err = new Error('Tool call name changed mid-stream'); err.code = 'upstream_invalid_tool'; err.detail = 'changed-name'; throw err; }
    call.name = name;
  };
  const text = async (key, value, complete = false, thinking = false) => {
    if (typeof value !== 'string') return;
    const previous = texts.get(key) || '';
    if (complete && !value.startsWith(previous)) {
      const err = new Error('Inconsistent completed text');
      err.code = 'upstream_text_mismatch';
      throw err;
    }
    const delta = complete ? value.slice(previous.length) : value;
    texts.set(key, complete ? value : previous + value);
    if (delta) { await emit(thinking ? thinkingChunk(id, delta) : textChunk(id, delta)); emittedText++; }
  };
  const item = async (value, index, done) => {
    if (scope && value && typeof value === 'object' && index !== undefined) stateItems.set(index, value);
    if (value.type === 'function_call' || value.type === 'custom_tool_call') {
      const call = getCall(index, value.id);
      if (value.type === 'custom_tool_call') call.custom = true;
      if (value.call_id || value.id) call.id = value.call_id || value.id;
      if (value.name) call.name = value.name;
      const payload = value.type === 'custom_tool_call' ? value.input : value.arguments;
      if (typeof payload === 'string' && (done || payload)) {
        if (done) call.complete = payload;
        else call.arguments = payload;
      }
    } else if (done && value.type === 'message') {
      for (const [contentIndex, part] of (value.content || []).entries()) {
        if (part.type === 'output_text') await text(`${index}:${contentIndex}`, part.text, true);
        if (part.type === 'refusal') await text(`refusal:${index}:${contentIndex}`, part.refusal, true);
      }
    } else if (done && value.type === 'reasoning') {
      for (const [summaryIndex, part] of (value.summary || []).entries()) {
        if (part.type === 'summary_text') await text(`reasoning:${index}:${summaryIndex}`, part.text, true, true);
      }
      for (const [contentIndex, part] of (value.content || []).entries()) {
        if (part.type === 'reasoning_text') await text(`reasoning_text:${index}:${contentIndex}`, part.text, true, true);
      }
    }
  };
  return {
    get terminal() { return terminal; },
    async event(event) {
      if (finished) return;
      const data = event.data;
      if (event.type === 'done') {
        if (!terminal && chat) terminal = true;
        return;
      }
      if (!data || data.error) {
        const err = new Error('Upstream stream error');
        err.code = 'upstream_stream_error';
        err.providerCode = providerErrorCode(data);
        throw err;
      }
      const container = chat ? data : data.response;
      if (container && typeof container === 'object' && Object.hasOwn(container, 'usage')) usage = usageSnapshot(data, chat);
      if (chat) {
        for (const choice of data.choices || []) {
          if ((choice.index ?? 0) !== 0) continue;
          const delta = choice.delta || choice.message || {};
          if (delta.content) await text('chat', delta.content);
          if (delta.refusal) await text('chat-refusal', delta.refusal);
          if (delta.reasoning_content || delta.reasoning) await text('reasoning', delta.reasoning_content || delta.reasoning, false, true);
          // Signatures and redacted-thinking flags are passthrough markers, not
          // semantic output — they must not feed `texts` or the empty-output check.
          if (delta.signature) await emit(signatureChunk(id, delta.signature));
          if (delta.thinking_redacted) await emit(redactedThinkingChunk(id));
          if (delta.function_call) {
            const call = getCall('function_call');
            call.id = call.id || `${id}:0`;
            if (delta.function_call.name) setName(call, delta.function_call.name);
            if (typeof delta.function_call.arguments === 'string') call.arguments += delta.function_call.arguments;
          }
          for (const tool of delta.tool_calls || []) {
            const call = getCall(tool.index ?? 0);
            if (tool.id && !call.id) call.id = tool.id;
            if (tool.function?.name) setName(call, tool.function.name);
            if (typeof tool.function?.arguments === 'string') call.arguments += tool.function.arguments;
          }
          if (choice.finish_reason) {
            terminal = true;
            chatFinish = choice.finish_reason;
            reason = choice.finish_reason === 'length' ? 3 : choice.finish_reason === 'content_filter' ? 11 : 2;
          }
        }
        return;
      }
      switch (event.type) {
        case 'response.output_item.added': await item(data.item, data.output_index, false); break;
        case 'response.output_item.done': await item(data.item, data.output_index, true); break;
        case 'response.function_call_arguments.delta': getCall(data.output_index, data.item_id).arguments += data.delta || ''; break;
        case 'response.function_call_arguments.done': getCall(data.output_index, data.item_id).complete = data.arguments; break;
        // Custom tool calls carry raw-string input, not JSON arguments.
        case 'response.custom_tool_call_input.delta': { const call = getCall(data.output_index, data.item_id); call.custom = true; call.arguments += data.delta || ''; break; }
        case 'response.custom_tool_call_input.done': { const call = getCall(data.output_index, data.item_id); call.custom = true; call.complete = data.input; break; }
        case 'response.output_text.delta': await text(`${data.output_index ?? 0}:${data.content_index ?? 0}`, data.delta); break;
        case 'response.output_text.done': await text(`${data.output_index ?? 0}:${data.content_index ?? 0}`, data.text, true); break;
        case 'response.reasoning.delta':
        case 'response.reasoning_summary_text.delta': await text(`reasoning:${data.output_index ?? 0}:${data.summary_index ?? 0}`, data.delta, false, true); break;
        case 'response.reasoning_text.delta': await text(`reasoning_text:${data.output_index ?? 0}:${data.content_index ?? 0}`, data.delta, false, true); break;
        case 'response.reasoning_text.done': await text(`reasoning_text:${data.output_index ?? 0}:${data.content_index ?? 0}`, data.text, true, true); break;
        case 'response.reasoning_summary_text.done': await text(`reasoning:${data.output_index ?? 0}:${data.summary_index ?? 0}`, data.text, true, true); break;
        case 'response.refusal.delta': await text(`refusal:${data.output_index ?? 0}:${data.content_index ?? 0}`, data.delta); break;
        case 'response.refusal.done': await text(`refusal:${data.output_index ?? 0}:${data.content_index ?? 0}`, data.refusal, true); break;
        case 'response.completed':
          if (scope && Array.isArray(data.response?.output)) finalItems = data.response.output;
          if (data.response?.status && data.response.status !== 'completed' && data.response.status !== 'incomplete') {
            const err = new Error('Unexpected completion status');
            err.code = 'upstream_stream_error';
            throw err;
          }
          for (const [index, value] of (data.response?.output || []).entries()) await item(value, index, true);
          terminal = true;
          if (data.response?.status === 'incomplete') reason = data.response?.incomplete_details?.reason === 'content_filter' ? 11 : 3;
          break;
        case 'response.incomplete':
          if (scope && Array.isArray(data.response?.output)) finalItems = data.response.output;
          for (const [index, value] of (data.response?.output || []).entries()) await item(value, index, true);
          terminal = true;
          reason = data.response?.incomplete_details?.reason === 'content_filter' ? 11 : 3;
          break;
        case 'response.failed':
        case 'error': {
          const err = new Error('Upstream response failed');
          err.code = 'upstream_stream_error';
          err.providerCode = providerErrorCode(data);
          throw err;
        }
      }
    },
    async finish() {
      if (finished) return finishedResult;
      if (!terminal) {
        const err = new Error('Upstream stream ended without completion');
        err.code = 'upstream_stream_incomplete';
        throw err;
      }
      const tools = [];
      const orderedCalls = [...calls.entries()].sort(([left], [right]) => typeof left === 'number' && typeof right === 'number' ? left - right : 0);
      const unknownReported = new Set();
      if (reason === 2) for (const [, call] of orderedCalls) {
        // Diagnostic only: an undeclared name still forwards the block — the
        // model's spelling may legitimately differ from our normalisation.
        if (declaredTools && call.name && !declaredTools.has(call.name) && !unknownReported.has(call.name)) {
          unknownReported.add(call.name);
          onDiag({ event: 'tool-name-unknown', name: call.name, declaredCount: declaredTools.size });
        }
        const args = call.complete ?? call.arguments;
        if (!call.name || !call.id || typeof args !== 'string') {
          const err = new Error('Incomplete tool call');
          err.code = 'upstream_invalid_tool';
          err.detail = 'incomplete-call';
          throw err;
        }
        try {
          if (!call.custom) JSON.parse(args); // Validate once, then forward the original JSON bytes.
        } catch {
          const err = new Error('Invalid tool call JSON');
          err.code = 'upstream_invalid_tool';
          err.detail = 'invalid-json';
          throw err;
        }
        tools.push({ id: call.id, name: call.name, arguments: args, isCustomToolCall: Boolean(call.custom) });
      }
      // `stop` is an ordinary plain-text end; only an upstream claim of a tool
      // finish with zero tool blocks is a mismatch. The Responses path carries
      // no such claim marker, so chatFinish stays null there.
      if (reason === 2 && tools.length === 0 && (chatFinish === 'tool_calls' || chatFinish === 'function_call')) {
        onDiag({ event: 'tool-claim-mismatch', textChunks: texts.size, toolChunks: 0 });
      }
      if (reason === 2 && !tools.length && !emittedText) {
        const err = new Error('Upstream completed without output');
        err.code = 'upstream_empty_output';
        throw err;
      }
      if (tools.length) await emit(toolChunk(id, tools));
      if (usage) await emit(usageChunk(id, uid, usage));
      if (scope) {
        const items = finalItems ?? [...stateItems.entries()]
          .sort(([left], [right]) => typeof left === 'number' && typeof right === 'number' ? left - right : 0).map(([, value]) => value);
        if (items.length && items.every(validStateItem)) {
          const envelope = STATE_PREFIX + Buffer.from(JSON.stringify({ scope, items })).toString('base64url');
          const bytes = Buffer.byteLength(envelope);
          if (bytes <= MAX_STATE_BYTES) { onStateSize({ bytes }); await emit(signatureChunk(id, envelope)); }
          else onStateSize({ bytes, dropped: true });
        } else if (items.length) {
          onSkip(items.some(item => item?.type === 'custom_tool_call') ? 'custom-tool' : 'invalid-item');
        }
      }
      await emit(stopChunk(id, tools.length ? 10 : reason, uid));
      finished = true;
      finishedResult = { toolNames: tools.map(tool => tool.name), toolIds: tools.map(tool => tool.id) };
      return finishedResult;
    },
  };
}

module.exports = { createStreamProcessor };

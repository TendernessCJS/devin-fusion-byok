'use strict';

// Unified orchestration entry for all three provider protocols: serveChat,
// endpoint routing, request bodies (OpenAI Responses + Chat Completions), the
// SSE processor, bounded degrade retries, and the reasoning-state envelope
// channel. Despite the old name, this is not Responses-only — the Anthropic
// Messages implementation is delegated to anthropic.cjs.

const { randomUUID } = require('node:crypto');
const { frame } = require('./wire.cjs');
const { textChunk, thinkingChunk, signatureChunk, redactedThinkingChunk, toolChunk, stopChunk, usageChunk } = require('./native-chat-codec.cjs');
const { createTracker } = require('./tracker.cjs');
const { anthropicHeaders, createAnthropicAdapter, stripCacheControl } = require('./anthropic.cjs');
const { STATE_PREFIX, MAX_STATE_BYTES, stateScope, validStateItem, sizeBucket } = require('./state-envelope.cjs');
const { STANDARD_CHAT_FINISH, endpoint, forcedToolChoice, buildRequestBody } = require('./provider-request.cjs');
const { readErrorDetail, parseEvent, events, usageSnapshot } = require('./provider-events.cjs');

function processor(id, uid, chat, emit, scope = null, onSkip = () => {}, onStateSize = () => {}, onDiag = () => {}, declaredTools = null) {
  const calls = new Map();
  const itemIndexes = new Map();
  const stateItems = new Map();
  let finalItems = null;
  const texts = new Map();
  let terminal = false;
  let reason = 2;
  let chatFinish = null;
  let finished = false;
  let usage = null;
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
    if (delta) await emit(thinking ? thinkingChunk(id, delta) : textChunk(id, delta));
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
          throw err;
        }
      }
    },
    async finish() {
      if (finished) return [];
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
      if (reason === 2 && !tools.length && !texts.size) {
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
      return tools.map(tool => tool.name);
    },
  };
}

// Only enumerations reach the log: messages can carry prompt text, host names and tokens.
const enumValue = value => typeof value === 'string' && /^[A-Za-z_$][\w$]{0,47}$/.test(value) ? value : null;
// SSE frame names are lowercase vocabulary (`response.output_text.delta`), so the dot is
// allowed only here and only in that shape.
const frameName = value => typeof value === 'string' && value.length <= 64 && /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/.test(value) ? value : null;

// A transport failure is classified as a bare `upstream_network`, which cannot
// tell a reset socket from a DNS or TLS failure. Only enumerations are kept:
// messages can carry host names and tokens, so they never reach the log.
function transportDetail(err) {
  const parts = [enumValue(err?.name), enumValue(err?.cause?.code) || enumValue(err?.code)];
  return [...new Set(parts.filter(Boolean))].join('/');
}

// True when the request body carries any explicit cache breakpoint; only the
// Anthropic body builder emits them, so the 400 degrade below can safely test
// for their presence instead of tracking them out of band.
function hasCacheControl(body) {
  const marked = list => Array.isArray(list) && list.some(block => block && typeof block === 'object' && block.cache_control !== undefined);
  if (marked(body?.tools) || (Array.isArray(body?.system) && marked(body.system))) return true;
  return Array.isArray(body?.messages) && body.messages.some(message => marked(message?.content));
}

async function serveChat({ request, route, provider, res, signal, log = () => {}, timeouts = {}, onMetrics = () => {}, cacheSupport = null }) {
  const id = randomUUID();
  const metrics = createTracker({ id, route, provider });
  let outcome = 'error', outcomeCode = null;
  const upstreamController = new AbortController();
  const abort = () => upstreamController.abort();
  const close = () => { if (!res.writableEnded) upstreamController.abort(); };
  signal?.addEventListener('abort', abort, { once: true });
  res.on('close', close);
  if (signal?.aborted) upstreamController.abort();
  const write = async chunk => {
    if (signal?.aborted || res.destroyed || res.writableEnded) throw new Error('Client closed');
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/connect+proto', 'cache-control': 'no-store' });
    if (!res.write(frame(chunk))) await new Promise((resolve, reject) => {
      const clean = () => { res.off('drain', drained); res.off('close', closed); signal?.removeEventListener('abort', closed); };
      const drained = () => { clean(); resolve(); };
      const closed = () => { clean(); reject(new Error('Client closed')); };
      res.once('drain', drained); res.once('close', closed); signal?.addEventListener('abort', closed, { once: true });
    });
  };
  let status = 0;
  let classifiedCode = 'upstream_network';
  const record = event => { try { log(event); } catch { /* Diagnostics cannot fail a model request. */ } };
  const frames = [];
  let lastEvent = null;
  const noteFrame = event => {
    lastEvent = event;
    const name = frameName(event?.type);
    if (name && frames.length < 8 && !frames.includes(name)) frames.push(name);
  };
  const failureShape = () => {
    const data = lastEvent?.data;
    const response = data?.response;
    const providerError = data?.error && typeof data.error === 'object'
      ? data.error
      : (response?.error && typeof response.error === 'object' ? response.error : null);
    const fields = {};
    const failFrame = frameName(lastEvent?.type);
    if (failFrame) fields.failFrame = failFrame;
    // A Responses `error` event carries `code` at the top level, not under `error`.
    const errorCode = enumValue(providerError?.code) || enumValue(data?.code);
    if (errorCode) fields.errorCode = errorCode;
    const errorType = enumValue(providerError?.type);
    if (errorType) fields.errorType = errorType;
    const responseStatus = enumValue(response?.status);
    if (responseStatus) fields.responseStatus = responseStatus;
    const incompleteReason = enumValue(response?.incomplete_details?.reason);
    if (incompleteReason) fields.incompleteReason = incompleteReason;
    if (frames.length) fields.frames = [...frames];
    return fields;
  };

  const firstResponseLimit = Number.isSafeInteger(timeouts?.firstResponseMs) && timeouts.firstResponseMs > 0
    ? Math.min(timeouts.firstResponseMs, 2147483647) : 120000;
  const idleLimit = Number.isSafeInteger(timeouts?.idleMs) && timeouts.idleMs > 0
    ? Math.min(timeouts.idleMs, 2147483647) : 120000;

  let activeTimer = null;
  const clearTimer = () => { if (activeTimer) { clearTimeout(activeTimer); activeTimer = null; } };
  const armTimer = (ms, code) => {
    clearTimer();
    activeTimer = setTimeout(() => {
      classifiedCode = code;
      upstreamController.abort();
    }, ms);
  };

  try {
    const { url, chat, anthropic } = endpoint(provider);
    const replay = { replayed: 0, bytes: 0, items: 0, mismatch: 0, unparsable: 0, oversize: 0 };
    const cacheBreakpoints = cacheSupport ? Boolean(cacheSupport.enabledFor(provider)) : false;
    let body = buildRequestBody(request, route, provider, stat => {
      if (stat.outcome === 'replayed') { replay.replayed += 1; replay.bytes = Math.max(replay.bytes, stat.bytes); replay.items = Math.max(replay.items, stat.items || 0); }
      else if (stat.outcome in replay) replay[stat.outcome] += 1;
    }, { cacheBreakpoints });
    if (replay.replayed) record({ event: 'state-envelope-replayed', model: route.model, bytes: replay.bytes, bucket: sizeBucket(replay.bytes), items: replay.items });
    if (replay.mismatch + replay.unparsable + replay.oversize > 0) record({ event: 'state-envelope-replay-failed', model: route.model, mismatch: replay.mismatch, unparsable: replay.unparsable, oversize: replay.oversize });
    // Pre-flight: a turn with no non-whitespace text, no attachment and no
    // tool-call/tool-result content must fail before any upstream request —
    // the native side does not guard this path.
    {
      const messages = request.messages || [];
      const last = messages.at(-1) || {};
      const hasText = typeof last.content === 'string' && last.content.trim() !== '';
      const hasAttachment = (last.images?.length || last.documents?.length || last.videos?.length) > 0;
      const hasTool = (last.toolCalls?.length || 0) > 0 || last.role === 'tool';
      // Zero messages means there is no turn to judge here (the caller supplied
      // only a system prompt); only an existing last message can be empty.
      if (messages.length > 0 && !hasText && !hasAttachment && !hasTool) {
        const err = new Error('This turn has no text or attachment to send.');
        err.code = 'request_empty_content';
        throw err;
      }
    }
    const headers = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(anthropic ? anthropicHeaders(provider.apiKey) : provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {})
    };
    const send = payload => {
      armTimer(firstResponseLimit, 'upstream_timeout');
      return fetch(url, {
        redirect: 'error',
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: upstreamController.signal
      });
    };
    // A connection-layer failure before the first byte is retried exactly
    // once after a bounded, abortable pause. The zero-output gate only proves
    // no billable output reached the client; it cannot prove the provider
    // never received the request, so it bounds duplication risk rather than
    // guaranteeing the provider was never charged.
    const RETRYABLE_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT']);
    const connectFailure = err => RETRYABLE_CODES.has(err?.cause?.code || err?.code);
    const pause = ms => new Promise(resolve => {
      const done = () => { clearTimeout(timer); upstreamController.signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      upstreamController.signal.addEventListener('abort', done, { once: true });
    });
    let upstream;
    try {
      upstream = await send(body);
    } catch (error) {
      if (!connectFailure(error) || upstreamController.signal.aborted || signal?.aborted || res.headersSent) throw error;
      record({ event: 'upstream-retry', model: route.model, attempt: 1, transport: transportDetail(error) });
      await pause(150);
      if (upstreamController.signal.aborted || signal?.aborted) throw error;
      upstream = await send(body);
    }
    // Thinking-mode providers (DeepSeek, Moonshot) answer a forced/required
    // tool_choice with HTTP 400 — "Thinking mode does not support this
    // tool_choice" — instead of ignoring it, so a forced choice turns a working
    // request into a hard failure. Two bounded steps: on the Anthropic format,
    // first retry with thinking disabled so the caller's forced choice survives;
    // only if that also fails, degrade the choice to `auto`. The provider's own
    // message must name tool_choice, so a 400 about anything else (context
    // length, bad parameters) still surfaces unchanged.
    if (!upstream.ok && upstream.status === 400) {
      // The response body is read exactly once and shared by both degrade
      // rules — getReader() fails on a consumed stream, so a second read would
      // silently see an empty string and skip a recoverable retry.
      const detail = await readErrorDetail(upstream);
      if (forcedToolChoice(body) && /tool_choice/i.test(detail)) {
        const hadThinking = body.thinking !== undefined;
        // Degrading drops an injected `thinking` flag: if the provider refused
        // that field too, carrying it into the final retry would fail again.
        const degradeChoice = next => {
          const degraded = { ...next, tool_choice: anthropic
            ? { type: 'auto', ...(next.tool_choice?.disable_parallel_tool_use ? { disable_parallel_tool_use: true } : {}) }
            : 'auto' };
          if (!hadThinking) delete degraded.thinking;
          return degraded;
        };
        if (anthropic && !hadThinking) {
          // Thinking mode is what refuses a forced choice, so disabling it is
          // the cheaper retry; degrading the choice is only the fallback.
          body = { ...body, thinking: { type: 'disabled' } };
          upstream = await send(body);
          if (upstream.ok) {
            record({ event: 'provider-degraded', model: route.model, reason: 'thinking-disabled' });
          } else {
            await readErrorDetail(upstream);
            body = degradeChoice(body);
            upstream = await send(body);
            record({ event: 'provider-degraded', model: route.model, reason: 'tool-choice' });
          }
        } else {
          body = degradeChoice(body);
          upstream = await send(body);
          record({ event: 'provider-degraded', model: route.model, reason: 'tool-choice' });
        }
      } else if (('store' in body || 'include' in body)
          && /store|include|reasoning\.encrypted_content/i.test(detail)) {
        const { store: _store, include: _include, ...stripped } = body;
        body = stripped;
        upstream = await send(body);
        record({ event: 'provider-degraded', model: route.model, reason: 'responses-state' });
      } else if (anthropic && cacheBreakpoints && hasCacheControl(body)) {
        // A 400 recoverable only by stripping the breakpoint proves the marker
        // caused it — that success is what marks the provider. A retry that
        // still fails has a different cause and must not disable anything.
        body = stripCacheControl(body);
        upstream = await send(body);
        if (upstream.ok) {
          cacheSupport.disable(provider);
          record({ event: 'cache-breakpoint-disabled', model: route.model, reason: '400' });
        }
      } else if (chat && !anthropic && typeof body.max_tokens === 'number'
          && /max_?(?:completion_)?tokens/i.test(detail)) {
        // DeepSeek ignores `max_completion_tokens` but honours `max_tokens`;
        // official OpenAI reasoning models are the mirror image. One rename
        // retry, gated on the error naming the field so unrelated 400s
        // (context length, bad schema) still surface unchanged. `chat` also
        // covers anthropic here, which legitimately sends `max_tokens` — the
        // explicit !anthropic guard keeps it out of this rename.
        const { max_tokens: cap, ...rest } = body;
        body = { ...rest, max_completion_tokens: cap };
        upstream = await send(body);
        record({ event: 'provider-degraded', model: route.model, reason: 'max-tokens-field' });
      }
    }
    clearTimer();

    status = upstream.status;
    if (!upstream.ok) {
      classifiedCode = 'upstream_http';
      await upstream.body?.cancel();
      throw new Error('Upstream HTTP error');
    }
    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.body || !contentType.toLowerCase().includes('text/event-stream')) {
      classifiedCode = 'upstream_content_type';
      await upstream.body?.cancel();
      throw new Error('Upstream did not return SSE');
    }

    async function* rawChunksWithTimeout(bodyStream) {
      const reader = bodyStream.getReader();
      try {
        while (true) {
          armTimer(idleLimit, 'upstream_timeout');
          let res;
          try {
            res = await reader.read();
          } catch (err) {
            if (classifiedCode !== 'upstream_timeout') classifiedCode = 'upstream_stream_error';
            throw err;
          } finally {
            clearTimer();
          }
          if (res.done) break;
          yield res.value;
        }
      } finally {
        reader.releaseLock();
      }
    }

    const declaredTools = new Set((request.tools || []).map(tool => tool.name));
    const stream = processor(id, route.uid || request.modelUid, chat, write, !chat ? stateScope(provider, route) : null,
      reason => record({ event: 'state-envelope-skipped', model: route.model, reason }),
      ({ bytes, dropped }) => dropped
        ? record({ event: 'state-envelope-oversize', model: route.model, bytes, limit: MAX_STATE_BYTES })
        : record({ event: 'state-envelope-size', model: route.model, bytes, bucket: sizeBucket(bytes) }),
      event => record(event), declaredTools);
    try {
      const adapt = anthropic ? createAnthropicAdapter() : event => [event];
      upstream: for await (const raw of events(rawChunksWithTimeout(upstream.body))) {
        for (const event of adapt(raw)) {
          noteFrame(event);
          metrics.event(event, chat);
          await stream.event(event);
          if (event.type === 'done' || (!chat && stream.terminal)) break upstream;
        }
      }
    } catch (err) {
      if (classifiedCode !== 'upstream_timeout') {
        const allowedCodes = new Set([
          'upstream_timeout', 'upstream_http', 'upstream_content_type',
          'upstream_stream_error', 'upstream_stream_incomplete',
          'upstream_invalid_tool', 'upstream_invalid_json', 'upstream_network', 'upstream_empty_output',
          'upstream_text_mismatch', 'attachment_unsupported', 'request_empty_content'
        ]);
        classifiedCode = allowedCodes.has(err?.code) ? err.code : 'upstream_stream_error';
      }
      throw err;
    }

    let toolNames;
    try {
      toolNames = await stream.finish();
    } catch (err) {
      const code = err?.code;
      classifiedCode = ['upstream_invalid_tool', 'upstream_empty_output', 'upstream_text_mismatch'].includes(code) ? code : 'upstream_stream_incomplete';
      throw err;
    }

    const providerStop = metrics.providerStopReason?.();
    if (providerStop && !STANDARD_CHAT_FINISH.has(providerStop)) record({ event: 'provider-stop', model: route.model, reason: providerStop });
    res.end(frame(Buffer.from('{}'), 2));
    outcome = 'success';
    record({ event: 'chat-complete', model: route.model, status, toolNames, requestId: id });
    return { status, toolNames, requestId: id };
  } catch (err) {
    clearTimer();
    const isClientCancel = signal?.aborted || res.destroyed || res.writableEnded;
    if (isClientCancel) {
      outcome = 'cancelled';
      outcomeCode = 'client_cancelled';
      record({ event: 'chat-aborted', model: route.model, status });
      if (!res.destroyed && !res.writableEnded) res.destroy();
      return { status, aborted: true };
    }

    // buildRequestBody throws before any response arrives, so its code never
    // passed through the stream catch — adopt it here for the error text.
    if (err?.code === 'attachment_unsupported') classifiedCode = 'attachment_unsupported';
    if (err?.code === 'request_empty_content') classifiedCode = 'request_empty_content';
    let errorText = 'Provider response could not be completed.';
    if (classifiedCode === 'upstream_timeout') {
      const budget = status ? idleLimit : firstResponseLimit;
      const shown = budget >= 1000 ? `${Math.round(budget / 1000)}s` : `${budget}ms`;
      errorText = `Provider response timed out after ${shown}.`;
    } else if (classifiedCode === 'upstream_http' && status >= 400) {
      errorText = `Provider returned HTTP ${status}.`;
    } else if (classifiedCode === 'upstream_content_type' || classifiedCode === 'upstream_invalid_json' || classifiedCode === 'upstream_invalid_tool') {
      errorText = 'Provider response format is invalid.';
    } else if (classifiedCode === 'upstream_empty_output') {
      errorText = 'Provider returned no output.';
    } else if (classifiedCode === 'upstream_text_mismatch') {
      errorText = 'Provider response was inconsistent.';
    } else if (classifiedCode === 'attachment_unsupported') {
      errorText = 'Attached media is not supported by this provider protocol.';
    } else if (classifiedCode === 'request_empty_content') {
      errorText = 'This turn has no text or attachment to send.';
    }

    try {
      await write(textChunk(id, errorText));
      await write(stopChunk(id, 13, route.uid || request.modelUid));
      res.end(frame(Buffer.from('{}'), 2));
    } catch {
      if (!res.destroyed && !res.writableEnded) res.destroy();
    }
    outcomeCode = classifiedCode;
    const transport = transportDetail(err);
    record({ event: 'chat-error', model: route.model, status, code: classifiedCode, requestId: id, ...(typeof err?.detail === 'string' && err.detail ? { detail: err.detail } : {}), ...(transport ? { transport } : {}), ...failureShape() });
    return { status, error: true, code: classifiedCode, requestId: id };
  } finally {
    try { onMetrics(metrics.finish(outcome, status, outcomeCode)); } catch {}
    clearTimer();
    upstreamController.abort();
    signal?.removeEventListener('abort', abort);
    res.off('close', close);
  }
}

module.exports = { serveChat, buildRequestBody, parseEvent, STATE_PREFIX };

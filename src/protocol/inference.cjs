'use strict';

// Unified orchestration entry for all three provider protocols: serveChat,
// endpoint routing, request bodies (OpenAI Responses + Chat Completions), the
// SSE processor, bounded degrade retries, and the reasoning-state envelope
// channel. Despite the old name, this is not Responses-only — the Anthropic
// Messages implementation is delegated to anthropic.cjs.

const { randomUUID } = require('node:crypto');
const { frame } = require('./wire.cjs');
const { textChunk, stopChunk } = require('./native-chat-codec.cjs');
const { createTracker } = require('./tracker.cjs');
const { anthropicHeaders, createAnthropicAdapter, inspectToolPairing } = require('./anthropic.cjs');
const { STATE_PREFIX, MAX_STATE_BYTES, stateScope, sizeBucket } = require('./state-envelope.cjs');
const { STANDARD_CHAT_FINISH, endpoint, providerHeaders, buildRequestBody } = require('./provider-request.cjs');
const { readErrorDetail, parseEvent, events, classifyErrorDetail, classifyQuotaDetail, enumValue, providerErrorCode } = require('./provider-events.cjs');
const { createStreamWriter } = require('./stream-writer.cjs');
const { createStreamProcessor } = require('./stream-processor.cjs');
const { openUpstream, transportDetail } = require('./request-policy.cjs');

// A burst of resets means a second fixed offset tends to re-collide with the
// same edge, so the pause is drawn from half to full budget instead of being
// constant. Only one retry exists, so the worst case stays bounded.
const RETRY_PAUSE_MS = 600;

// SSE frame names are lowercase vocabulary (`response.output_text.delta`), so the dot is
// allowed only here and only in that shape.
const frameName = value => typeof value === 'string' && value.length <= 64 && /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/.test(value) ? value : null;

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
  const drainLimit = Number.isSafeInteger(timeouts?.drainMs) && timeouts.drainMs > 0
    ? Math.min(timeouts.drainMs, 600000) : 120000;
  let backpressureTimedOut = false;
  const writer = createStreamWriter({ res, signal, timeoutMs: drainLimit, onTimeout: () => { backpressureTimedOut = true; } });
  const write = async chunk => {
    if (signal?.aborted || res.destroyed || res.writableEnded) throw new Error('Client closed');
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/connect+proto', 'cache-control': 'no-store' });
    await writer.write(frame(chunk));
  };
  let status = 0;
  let classifiedCode = 'upstream_network';
  let signatureMentioned = false;
  let quotaExhausted = false;
  // Each Response body can be consumed once, so degrade rules and the final
  // classification share the same read per response object.
  const errorDetails = new WeakMap();
  const readDetail = response => {
    let pending = errorDetails.get(response);
    if (!pending) { pending = readErrorDetail(response); errorDetails.set(response, pending); }
    return pending;
  };
  const connectAttempts = [];
  const record = event => { try { log(event); } catch { /* Diagnostics cannot fail a model request. */ } };
  const clientCancelled = () => Boolean(signal?.aborted || res.destroyed || res.writableEnded || backpressureTimedOut);
  const finishCancelled = () => {
    outcome = 'cancelled';
    outcomeCode = 'client_cancelled';
    record({ event: 'chat-aborted', model: route.model, status, ...(backpressureTimedOut ? { reason: 'backpressure-timeout' } : {}) });
    if (!res.destroyed && !res.writableEnded) res.destroy();
    return { status, aborted: true };
  };
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
    const errorCode = providerErrorCode(data);
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
  const retryBase = Number.isSafeInteger(timeouts?.retryPauseMs) && timeouts.retryPauseMs >= 0
    ? Math.min(timeouts.retryPauseMs, 5000) : RETRY_PAUSE_MS;
  const retryDeadlineMs = Number.isSafeInteger(timeouts?.retryDeadlineMs) && timeouts.retryDeadlineMs >= 0
    ? Math.min(timeouts.retryDeadlineMs, 600000) : 120000;
  // The pause doubles per retry ordinal (1, 2, 3) and keeps the same jitter
  // shape: a draw from the upper half of the ordinal's budget.
  const retryPauseMs = ordinal => {
    const budget = Math.min(retryBase * 2 ** (ordinal - 1), 5000);
    return budget ? Math.round(budget / 2 + Math.random() * budget / 2) : 0;
  };

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
    const replay = { replayed: 0, bytes: 0, items: 0, mismatch: 0, unparsable: 0, oversize: 0, reasons: {} };
    const cacheBreakpoints = cacheSupport ? Boolean(cacheSupport.enabledFor(provider)) : false;
    // Observation-only probes; a probe failure must never reach the request.
    try {
      const computerUse = (request.tools || []).filter(tool => tool.hasComputerUseConfig === true).length;
      if (computerUse) record({ event: 'native-computer-use-tool', model: route.model, count: computerUse });
      if (anthropic) {
        const pairing = inspectToolPairing(request);
        if (pairing.orphan) record({ event: 'tool-pair-orphan', model: route.model, count: pairing.orphan });
        if (pairing.nonAdjacent) record({ event: 'tool-pair-nonadjacent', model: route.model, count: pairing.nonAdjacent });
        if (pairing.duplicate) record({ event: 'tool-pair-duplicate', model: route.model, count: pairing.duplicate });
        if (pairing.notFirst) record({ event: 'tool-result-not-first', model: route.model, count: pairing.notFirst });
      }
    } catch { record({ event: 'tool-pair-probe-failed', model: route.model }); }
    let body = buildRequestBody(request, route, provider, stat => {
      if (stat.outcome === 'replayed') { replay.replayed += 1; replay.bytes = Math.max(replay.bytes, stat.bytes); replay.items = Math.max(replay.items, stat.items || 0); }
      else if (stat.outcome in replay) { replay[stat.outcome] += 1; if (stat.reason) replay.reasons[stat.reason] = (replay.reasons[stat.reason] || 0) + 1; }
    }, { cacheBreakpoints });
    if (replay.replayed) record({ event: 'state-envelope-replayed', model: route.model, bytes: replay.bytes, bucket: sizeBucket(replay.bytes), items: replay.items });
    if (replay.mismatch + replay.unparsable + replay.oversize > 0) record({ event: 'state-envelope-replay-failed', model: route.model, mismatch: replay.mismatch, unparsable: replay.unparsable, oversize: replay.oversize, ...(replay.mismatch ? { reasons: replay.reasons } : {}) });
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
      ...providerHeaders(url, request),
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
    const RETRYABLE_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT']);
    const connectFailure = err => RETRYABLE_CODES.has(err?.cause?.code || err?.code);
    const pause = ms => new Promise(resolve => {
      const done = () => { clearTimeout(timer); upstreamController.signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      upstreamController.signal.addEventListener('abort', done, { once: true });
    });
    const retry = {
      deadlineMs: retryDeadlineMs,
      nextPause: retryPauseMs,
      pause,
      canRetry: error => connectFailure(error)
        && !upstreamController.signal.aborted && !signal?.aborted && !res.headersSent,
      isAborted: () => upstreamController.signal.aborted || signal?.aborted,
    };
    const upstream = await openUpstream({ body, chat, anthropic, provider, model: route.model,
      cacheBreakpoints, cacheSupport, send, readDetail, record, connectAttempts, retry });

    status = upstream.status;
    if (!upstream.ok) {
      // Triage only: the hint must describe the attempt that actually failed, so
      // it is classified within the send deadline instead of at the first 400.
      // Quota/credit exhaustion is reported as 402 — the status alone decides,
      // so the body is never awaited — or as a 400/429 whose body names it; the
      // body is read once (readDetail is memoised per response) and only ever
      // reduced to a flag — the detail itself is never logged.
      quotaExhausted = upstream.status === 402;
      if (upstream.status === 400 || upstream.status === 429) {
        try {
          const detail = await readDetail(upstream);
          if (upstream.status === 400) signatureMentioned = classifyErrorDetail(detail) !== null;
          quotaExhausted = classifyQuotaDetail(detail, { anthropicRateLimit: anthropic && upstream.status === 429 }) !== null;
        } catch { /* triage only */ }
      }
      classifiedCode = quotaExhausted ? 'upstream_quota' : 'upstream_http';
      clearTimer();
      await upstream.body?.cancel();
      throw new Error('Upstream HTTP error');
    }
    clearTimer();
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
    const stream = createStreamProcessor({ id, uid: route.uid || request.modelUid, chat, emit: write,
      scope: !chat ? stateScope(provider, route) : null,
      onSkip: reason => record({ event: 'state-envelope-skipped', model: route.model, reason }),
      onStateSize: ({ bytes, dropped }) => dropped
        ? record({ event: 'state-envelope-oversize', model: route.model, bytes, limit: MAX_STATE_BYTES })
        : record({ event: 'state-envelope-size', model: route.model, bytes, bucket: sizeBucket(bytes) }),
      onDiag: event => record(event), declaredTools });
    try {
      const adapt = anthropic ? createAnthropicAdapter({ onDiagnostic: event => record(event) }) : event => [event];
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
      const finished = await stream.finish();
      toolNames = finished.toolNames;
      metrics.toolsEmitted(finished.toolIds);
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
    if (clientCancelled()) return finishCancelled();

    // buildRequestBody throws before any response arrives, so its code never
    // passed through the stream catch — adopt it here for the error text.
    if (err?.code === 'attachment_unsupported') classifiedCode = 'attachment_unsupported';
    if (err?.code === 'request_empty_content') classifiedCode = 'request_empty_content';
    if (classifiedCode === 'upstream_stream_error' && err?.providerCode === 'insufficient_quota') classifiedCode = 'upstream_quota';
    let errorText = 'Provider response could not be completed.';
    if (classifiedCode === 'upstream_quota') {
      errorText = 'Provider account has insufficient balance.';
    } else if (classifiedCode === 'upstream_timeout') {
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
      if (clientCancelled()) return finishCancelled();
      if (!res.destroyed && !res.writableEnded) res.destroy();
    }
    outcomeCode = classifiedCode;
    const transport = transportDetail(err);
    record({ event: 'chat-error', model: route.model, status, code: classifiedCode, requestId: id, ...(classifiedCode === 'upstream_http' && status === 400 && signatureMentioned ? { diagnostic: 'signature-mentioned' } : {}), ...(classifiedCode === 'upstream_quota' ? { diagnostic: 'quota-exhausted' } : {}), ...(typeof err?.detail === 'string' && err.detail ? { detail: err.detail } : {}), ...(transport ? { transport } : {}), ...(connectAttempts.length > 1 ? { attempts: connectAttempts } : {}), ...failureShape() });
    return { status, error: true, code: classifiedCode, requestId: id };
  } finally {
    try { onMetrics(metrics.finish(outcome, status, outcomeCode)); } catch {}
    clearTimer();
    writer.dispose();
    upstreamController.abort();
    signal?.removeEventListener('abort', abort);
    res.off('close', close);
  }
}

module.exports = { serveChat, buildRequestBody, STATE_PREFIX };

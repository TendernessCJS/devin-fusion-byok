'use strict';
const { enumValue } = require('./provider-events.cjs');
const { forcedToolChoice } = require('./provider-request.cjs');
const { stripCacheControl } = require('./anthropic.cjs');

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

// A connection-layer failure before the first byte is retried up to three
// times after bounded, abortable pauses that double per retry. The
// zero-output gate only proves no billable output reached the client; it
// cannot prove the provider never received the request, so it bounds
// duplication risk rather than guaranteeing the provider was never charged.
// A retried send still rides the pooled socket — `connection: close` cannot
// force a fresh connection through fetch — so consecutive failures on the
// same peer can still exhaust the budget.
const MAX_CONNECT_ATTEMPTS = 4;

async function openUpstream({ body, chat, anthropic, provider, model, cacheBreakpoints, cacheSupport, send, readDetail, record, connectAttempts, retry }) {
  const connectStartedAt = Date.now();
  let upstream;
  for (let attempt = 1; ; attempt++) {
    const attemptStartedAt = Date.now();
    try {
      upstream = await send(body);
      if (attempt > 1) record({ event: 'upstream-retry-recovered', model, attempt: attempt - 1, attempts: attempt });
      break;
    } catch (error) {
      const elapsedMs = Date.now() - attemptStartedAt;
      connectAttempts.push({ attempt, elapsedMs, code: enumValue(error?.cause?.code) || enumValue(error?.code) });
      const retryable = retry.canRetry(error);
      if (!retryable || attempt >= MAX_CONNECT_ATTEMPTS || retry.deadlineMs === 0) throw error;
      const waitMs = retry.nextPause(attempt);
      if (Date.now() - connectStartedAt + waitMs > retry.deadlineMs) throw error;
      record({ event: 'upstream-retry', model, attempt, transport: transportDetail(error), pauseMs: waitMs, elapsedMs, bytes: Buffer.byteLength(JSON.stringify(body)) });
      await retry.pause(waitMs);
      if (retry.isAborted()) throw error;
    }
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
    const detail = await readDetail(upstream);
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
          record({ event: 'provider-degraded', model, reason: 'thinking-disabled' });
        } else {
          await readDetail(upstream);
          body = degradeChoice(body);
          upstream = await send(body);
          record({ event: 'provider-degraded', model, reason: 'tool-choice' });
        }
      } else {
        body = degradeChoice(body);
        upstream = await send(body);
        record({ event: 'provider-degraded', model, reason: 'tool-choice' });
      }
    } else if (('store' in body || 'include' in body)
        && /store|include|reasoning\.encrypted_content/i.test(detail)) {
      const { store: _store, include: _include, ...stripped } = body;
      body = stripped;
      upstream = await send(body);
      record({ event: 'provider-degraded', model, reason: 'responses-state' });
    } else if (anthropic && cacheBreakpoints && hasCacheControl(body)) {
      // A 400 recoverable only by stripping the breakpoint proves the marker
      // caused it — that success is what marks the provider. A retry that
      // still fails has a different cause and must not disable anything.
      body = stripCacheControl(body);
      upstream = await send(body);
      if (upstream.ok) {
        cacheSupport.disable(provider);
        record({ event: 'cache-breakpoint-disabled', model, reason: '400' });
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
      // Only a successful rename proves the field was the cause; a retry that
      // still fails has some other problem and must not read as "degraded".
      if (upstream.ok) record({ event: 'provider-degraded', model, reason: 'max-tokens-field' });
    }
  }
  return upstream;
}

module.exports = { openUpstream, transportDetail };

'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { loadAcpApi, restoreMember, createAcpRegistry, isTerminalStatus } = require('./acp-hook.cjs');

const INSTANCE = Symbol.for('devin-fusion-byok.auto-continue.v1');
const ATTACHED = Symbol.for('devin-fusion-byok.auto-continue.attached');
const TARGET_ERROR = 'Provider response could not be completed';
const TRANSIENT_HTTP_RE = /Provider returned HTTP (?:408|429|500|502|503|504)\.$/;
const TIMEOUT_RE = /Provider response timed out after \d+(?:ms|s)\.$/;
const PROVIDER_LIKE_RE = /provider response/i;
const TERMINAL_BLOCKER_RE = /(?:Provider returned HTTP (?:4\d\d|5\d\d)\.|Provider response format is invalid\.)$/;

function matchesTimeoutError(text) {
  return typeof text === 'string' && TIMEOUT_RE.test(text.trimEnd());
}

function matchesProviderError(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(TARGET_ERROR) || trimmed.endsWith(TARGET_ERROR + '.')) return true;
  if (matchesTimeoutError(trimmed)) return true;
  return TRANSIENT_HTTP_RE.test(trimmed);
}

function matchesTerminalBlocker(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trimEnd();
  if (TRANSIENT_HTTP_RE.test(trimmed)) return false;
  return TERMINAL_BLOCKER_RE.test(trimmed);
}

const ERROR_ATTEMPT_LIMIT = 5;
const ERROR_WINDOW_MS = 10 * 60 * 1000;
const PLAN_ATTEMPT_LIMIT = 10;
// Only objective truncation continues: `max_turn_requests` is the per-prompt
// request budget (native shows "send another message to continue") and
// `max_tokens` is output cut at the provider limit. `end_turn` is a normal
// finish — continuing it would override the model's own decision on evidence
// the model writes itself. A truncation with zero visible text and zero tool
// calls does not continue either: under the same budget it must repeat.
const CONTINUABLE_STOP = new Set(['max_tokens', 'max_turn_requests']);

const RESET_METHODS = new Set([
  'session/cancel',
  'session/load',
  'session/resume',
  'session/close',
  'session/delete',
  'session/archive',
  '_cognition.ai/session/archive'
]);

function installAutoContinue({ nativeMainPath, isEnabled = () => false, getOptions = () => ({ onProviderError: true, untilPlanComplete: false }), log = () => {}, scheduler, isSessionSuppressed, now = Date.now, onStopped = () => {} } = {}) {
  const api = loadAcpApi(nativeMainPath);
  const vscode = createRequire(nativeMainPath)('vscode');
  if (api[INSTANCE]) return api[INSTANCE];

  const scheduleTimer = scheduler?.setTimeout || setTimeout;
  const clearTimer = scheduler?.clearTimeout || clearTimeout;

  const connections = new Map();
  const autoAttempts = new WeakMap();
  let disposed = false;
  let autoContinueCount = 0;

  function report(event, data) {
    try { log(event, data); } catch {}
  }

  function sessionSuppressed(sessionId) {
    if (typeof isSessionSuppressed !== 'function' || !sessionId) return false;
    try { return isSessionSuppressed(sessionId) === true; } catch { return true; }
  }

  function detach(connector) {
    const entry = connections.get(connector);
    if (!entry) return;
    entry.active = false;
    for (const timer of entry.timers.values()) clearTimer(timer);
    entry.timers.clear();
    for (const turn of entry.sessions.values()) {
      turn.retryDisallowed = true;
      if (turn.deferred && !turn.deferred.settled && turn.lastResult) {
        turn.deferred.settled = true;
        if (turn.lastResult?.isReject) turn.deferred.reject(turn.lastResult.value);
        else turn.deferred.resolve(turn.lastResult.value);
      }
    }
    entry.sessions.clear();
    restoreMember(connector, 'sendRequest', entry.sendRequestWrapper, entry.sendRequestDescriptor);
    restoreMember(connector, 'forwardClientRequest', entry.forwardWrapper, entry.forwardDescriptor);
    if (entry.setStatusWrapper) {
      restoreMember(connector, 'setStatus', entry.setStatusWrapper, entry.setStatusDescriptor);
    }
    delete connector[ATTACHED];
    connections.delete(connector);
  }

  function attach(connector) {
    if (disposed || !connector || connector[ATTACHED] || connector.agentId !== 'devin-cli' ||
        connector.bundled !== true || !['local', 'ssh', 'wsl'].includes(connector.location?.kind) ||
        typeof connector.sendRequest !== 'function' || typeof connector.forwardClientRequest !== 'function') {
      return null;
    }

    const originalSend = connector.sendRequest;
    const originalForward = connector.forwardClientRequest;
    const originalSetStatus = typeof connector.setStatus === 'function' ? connector.setStatus : null;

    const sendRequestDescriptor = Object.getOwnPropertyDescriptor(connector, 'sendRequest');
    const forwardDescriptor = Object.getOwnPropertyDescriptor(connector, 'forwardClientRequest');
    const setStatusDescriptor = originalSetStatus ? Object.getOwnPropertyDescriptor(connector, 'setStatus') : null;

    const entry = {
      active: true,
      connector,
      timers: new Map(),
      sessions: new Map(),
      turnGeneration: 0,
      sendRequestDescriptor,
      forwardDescriptor,
      setStatusDescriptor
    };

    function cancelSessionTimer(sessionId) {
      const timer = entry.timers.get(sessionId);
      if (timer) {
        clearTimer(timer);
        entry.timers.delete(sessionId);
      }
    }

    function stopErrorRetry(sessionId, turn, reason) {
      cancelSessionTimer(sessionId);
      if (entry.sessions.get(sessionId) !== turn) return;
      turn.retryDisallowed = true;
      const data = { reason, attempts: turn.errorAttempts };
      if (turn.deferred && !turn.deferred.settled && turn.lastResult) {
        turn.deferred.settled = true;
        if (turn.lastResult.isReject) turn.deferred.reject(turn.lastResult.value);
        else turn.deferred.resolve(turn.lastResult.value);
      }
      entry.sessions.delete(sessionId);
      report('auto-continue-stopped', data);
      try { Promise.resolve(onStopped(data)).catch(() => {}); } catch {}
    }

    function stopPlanRetry(sessionId, turn, reason) {
      cancelSessionTimer(sessionId);
      if (entry.sessions.get(sessionId) !== turn) return;
      turn.retryDisallowed = true;
      const data = { reason, attempts: turn.attempts };
      if (turn.deferred && !turn.deferred.settled && turn.lastResult) {
        turn.deferred.settled = true;
        if (turn.lastResult.isReject) turn.deferred.reject(turn.lastResult.value);
        else turn.deferred.resolve(turn.lastResult.value);
      }
      entry.sessions.delete(sessionId);
      report('auto-continue-stopped', data);
      try { Promise.resolve(onStopped(data)).catch(() => {}); } catch {}
    }

    function checkHasPendingPlan(turn) {
      if (!turn?.plans || turn.plans.size === 0) return false;
      for (const plan of turn.plans.values()) {
        if (!plan || plan.invalid) continue;
        if (plan.pendingCount > 0) return true;
      }
      return false;
    }

    function planSnapshot(turn) {
      return JSON.stringify([...new Set([...turn.plans.values()]
        .filter(plan => !plan.invalid).map(plan => plan.signature))].sort());
    }

    function hasPlanProgress(turn) {
      if (turn.autoPlanSnapshot === null || turn.autoPlanSnapshot !== planSnapshot(turn)) return true;
      report('auto-continue-stopped', { reason: 'plan-no-progress', attempts: turn.attempts });
      return false;
    }

    function scheduleAuto(sessionId, turn, reason = 'error') {
      cancelSessionTimer(sessionId);
      turn.scheduledReason = reason;
      if (reason === 'error') {
        turn.errorStartedAt ??= now();
        if (turn.errorAttempts >= ERROR_ATTEMPT_LIMIT) { stopErrorRetry(sessionId, turn, 'error-attempt-limit'); return; }
        if (now() >= turn.errorStartedAt + ERROR_WINDOW_MS) { stopErrorRetry(sessionId, turn, 'error-time-limit'); return; }
      } else {
        if (turn.attempts >= PLAN_ATTEMPT_LIMIT) { stopPlanRetry(sessionId, turn, 'plan-attempt-limit'); return; }
        turn.errorAttempts = 0;
        turn.errorStartedAt = null;
      }
      // Each chain backs off on its own counter: an error retry must not
      // inflate the plan backoff nor consume a plan slot.
      const attempts = reason === 'error' ? (turn.errorAttempts || 0) : (turn.attempts || 0);
      const safePow = Math.min(attempts, 10);
      const delay = Math.min(2000 * Math.pow(2, safePow), 30000);
      const generation = turn.generation;
      report('auto-continue-scheduled', { attempts, delay, reason });

      const timer = scheduleTimer(() => {
        entry.timers.delete(sessionId);
        if (disposed || !entry.active || !isEnabled() || sessionSuppressed(sessionId)) return;
        const currentTurn = entry.sessions.get(sessionId);
        if (!currentTurn || currentTurn.generation !== generation || currentTurn.retryDisallowed) return;
        if (reason === 'error') {
          if (currentTurn.errorAttempts >= ERROR_ATTEMPT_LIMIT) { stopErrorRetry(sessionId, currentTurn, 'error-attempt-limit'); return; }
          if (now() >= currentTurn.errorStartedAt + ERROR_WINDOW_MS) { stopErrorRetry(sessionId, currentTurn, 'error-time-limit'); return; }
        } else {
          if (currentTurn.attempts >= PLAN_ATTEMPT_LIMIT) { stopPlanRetry(sessionId, currentTurn, 'plan-attempt-limit'); return; }
        }
        executeAuto(sessionId, attempts, currentTurn);
      }, delay);

      entry.timers.set(sessionId, timer);
    }

    function executeAuto(sessionId, attempts, activeTurn) {
      const reason = activeTurn.scheduledReason;
      const clientMessageId = randomUUID();
      const timestamp = new Date().toISOString();
      const isV2 = (connector.protocolVersion >= 2) || !!activeTurn.isV2;

      // The synthetic user message must carry `messageSubIndex`, exactly like the
      // app's own optimistic messages: the client's chunk reducer merges an
      // incoming `user_message_chunk` into an existing part only when both
      // `cognition.ai/clientMessageId` and `cognition.ai/messageSubIndex` match
      // (the reducer copies the update `_meta` onto each part). Without the
      // subindex the agent's echo of the prompt is appended as a second part and
      // the bubble reads "continuecontinue".
      const synthetic = isV2 ? {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'user_message',
            messageId: clientMessageId,
            content: [{ type: 'text', text: 'continue' }],
            _meta: {
              'cognition.ai/clientMessageId': clientMessageId,
              'cognition.ai/messageSubIndex': 0,
              'cognition.ai/isOptimistic': true,
              'cognition.ai/timestamp': timestamp
            }
          }
        }
      } : {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'continue' },
            _meta: {
              'cognition.ai/clientMessageId': clientMessageId,
              'cognition.ai/messageSubIndex': 0,
              'cognition.ai/isOptimistic': true,
              'cognition.ai/timestamp': timestamp
            }
          }
        }
      };

      try {
        const ret = originalForward.call(connector, synthetic);
        if (ret && typeof ret.catch === 'function') ret.catch(() => {});
      } catch {}

      const promptRequest = {
        method: 'session/prompt',
        params: {
          sessionId,
          prompt: [{ type: 'text', text: 'continue' }],
          _meta: {
            'cognition.ai/clientMessageId': clientMessageId
          }
        }
      };
      autoAttempts.set(promptRequest, { attempts: attempts + 1, reason });
      autoContinueCount++;
      report('auto-continue-fired', { attempts: attempts + 1 });

      let token;
      try { token = vscode?.CancellationToken?.None; } catch {}

      try {
        Promise.resolve(entry.sendRequestWrapper.call(connector, promptRequest, token)).catch(() => report('auto-continue-send-error'));
        if (reason === 'error') activeTurn.errorAttempts++;
      } catch (err) {
        report('auto-continue-send-error');
        if (activeTurn.deferred && !activeTurn.deferred.settled) {
          activeTurn.deferred.settled = true;
          activeTurn.deferred.reject(err);
        }
      }
    }

    function pendingItemCount(turn) {
      // Read-only: sums pendingCount over valid plan entries. Never touches
      // snapshots — checkHasPendingPlan / hasPlanProgress stay the only judges.
      if (!turn?.plans) return 0;
      let total = 0;
      for (const plan of turn.plans.values()) {
        if (plan && !plan.invalid && typeof plan.pendingCount === 'number') total += plan.pendingCount;
      }
      return total;
    }

    function emitEvaluated(turn, sessionId, site, stopReason, decision, reason, overrides = {}) {
      const options = getOptions() || {};
      report('auto-continue-evaluated', {
        site,
        stopReason: typeof stopReason === 'string' ? stopReason : null,
        enabled: isEnabled(),
        onProviderError: options.onProviderError !== false,
        untilPlanComplete: options.untilPlanComplete === true,
        suppressed: sessionSuppressed(sessionId),
        retryDisallowed: turn.retryDisallowed,
        providerErrorMatched: 'providerErrorMatched' in overrides ? overrides.providerErrorMatched : matchesProviderError(turn.tail),
        terminalBlocker: matchesTerminalBlocker(turn.tail),
        hasPendingPlan: checkHasPendingPlan(turn),
        planUpdates: turn.planUpdates || 0,
        pendingItems: pendingItemCount(turn),
        decision,
        reason,
      });
    }

    function handlePromptPromise(promise, turn, sessionId, capturedGen) {
      Promise.resolve(promise).then(
        res => {
          const settle = () => {
            if (turn.deferred && !turn.deferred.settled) {
              turn.deferred.settled = true;
              turn.deferred.resolve(res);
            }
          };
          if (disposed || !entry.active) {
            emitEvaluated(turn, sessionId, 'resolve', res?.stopReason, 'untracked', disposed ? 'disposed' : 'inactive');
            settle();
            return;
          }

          const currentTurn = entry.sessions.get(sessionId);
          if (turn.retryDisallowed || !currentTurn || currentTurn !== turn) {
            emitEvaluated(turn, sessionId, 'resolve', res?.stopReason, 'untracked',
              !currentTurn ? 'session-gone' : currentTurn !== turn ? 'superseded' : 'retry-disallowed');
            settle();
            return;
          }

          if (res?.stopReason === 'cancelled' || res?.stopReason === 'refusal') {
            emitEvaluated(turn, sessionId, 'resolve', res.stopReason, 'stop', res.stopReason);
            turn.consumed = true;
            turn.retryDisallowed = true;
            settle();
            entry.sessions.delete(sessionId);
            return;
          }

          if (typeof res?.stopReason !== 'string') {
            emitEvaluated(turn, sessionId, 'resolve', null, 'stop', 'no-stop-reason');
            settle();
            return;
          }

          if (turn.generation !== capturedGen) {
            emitEvaluated(turn, sessionId, 'resolve', res.stopReason, 'untracked', 'generation-mismatch');
            return;
          }
          turn.consumed = true;
          const options = getOptions() || {};

          const shouldRetryError = !turn.retryDisallowed && isEnabled() && !sessionSuppressed(sessionId) && options.onProviderError !== false && matchesProviderError(turn.tail);
          const hasPendingPlan = checkHasPendingPlan(turn);
          const isBlocked = matchesTerminalBlocker(turn.tail);
          const emptyTruncation = CONTINUABLE_STOP.has(res.stopReason) && !(turn.textChars > 0) && !(turn.toolCalls > 0);
          const planEligible = !turn.retryDisallowed && !isBlocked && isEnabled() && !sessionSuppressed(sessionId) && options.untilPlanComplete === true &&
            CONTINUABLE_STOP.has(res.stopReason);
          const shouldRetryPlan = planEligible && !emptyTruncation;

          // hasPlanProgress consumes its snapshot — keep the original lazy call:
          // it only runs when the error branch did not, exactly like the old else-if.
          // A plan that exists but did not move is the one thing that turns a
          // truncation into a spin, so progress is required only then.
          const planRetry = !shouldRetryError && shouldRetryPlan && (!hasPendingPlan || hasPlanProgress(turn));
          emitEvaluated(turn, sessionId, 'resolve', res.stopReason,
            shouldRetryError ? 'error-retry' : planRetry ? 'plan-retry' : 'stop',
            !shouldRetryError && !planRetry && emptyTruncation && planEligible ? 'truncated-empty' : null);
          if (shouldRetryError) {
            turn.lastResult = { value: res, isReject: false };
            scheduleAuto(sessionId, turn, 'error');
          } else if (planRetry) {
            turn.lastResult = { value: res, isReject: false };
            scheduleAuto(sessionId, turn, 'plan');
          } else {
            if (isEnabled() && options.onProviderError !== false) {
              const tail = typeof turn.tail === 'string' ? turn.tail : '';
              if (PROVIDER_LIKE_RE.test(tail.slice(-400))) {
                const trimmed = tail.trimEnd();
                report('auto-continue-miss', {
                  reason: turn.retryDisallowed ? 'retry-disallowed'
                    : sessionSuppressed(sessionId) ? 'session-suppressed' : 'tail-mismatch',
                  tailLength: tail.length,
                  endsWithGeneric: trimmed.endsWith(TARGET_ERROR) || trimmed.endsWith(TARGET_ERROR + '.'),
                  endsWithTimeout: matchesTimeoutError(tail),
                  terminalBlocker: isBlocked,
                  stopReason: typeof res?.stopReason === 'string' ? res.stopReason : ''
                });
              }
            }
            if (turn.deferred && !turn.deferred.settled) {
              turn.deferred.settled = true;
              turn.deferred.resolve(res);
            }
            entry.sessions.delete(sessionId);
          }
        },
        err => {
          if (disposed || !entry.active) {
            if (turn.deferred && !turn.deferred.settled) {
              turn.deferred.settled = true;
              turn.deferred.reject(err);
            }
            return;
          }

          const currentTurn = entry.sessions.get(sessionId);
          if (turn.retryDisallowed || !currentTurn || currentTurn !== turn) {
            if (turn.deferred && !turn.deferred.settled) {
              turn.deferred.settled = true;
              turn.deferred.reject(err);
            }
            return;
          }

          if (turn.generation !== capturedGen) return;
          turn.consumed = true;
          const msg = typeof err?.message === 'string' ? err.message : (typeof err === 'string' ? err : '');
          const isExactMsg = msg === TARGET_ERROR || msg === TARGET_ERROR + '.' || matchesTimeoutError(msg);
          const options = getOptions() || {};

          emitEvaluated(turn, sessionId, 'reject', null,
            (isEnabled() && options.onProviderError !== false && isExactMsg && !sessionSuppressed(sessionId)) ? 'error-retry' : 'stop', null,
            { providerErrorMatched: isExactMsg });
          if (isEnabled() && options.onProviderError !== false && isExactMsg && !sessionSuppressed(sessionId)) {
            turn.lastResult = { value: err, isReject: true };
            scheduleAuto(sessionId, turn, 'error');
          } else {
            if (isEnabled() && options.onProviderError !== false && PROVIDER_LIKE_RE.test(msg.slice(-400)))
              report('auto-continue-miss', { reason: 'reject-mismatch', messageLength: msg.length, enabled: true });
            turn.retryDisallowed = true;
            if (turn.deferred && !turn.deferred.settled) {
              turn.deferred.settled = true;
              turn.deferred.reject(err);
            }
            entry.sessions.delete(sessionId);
          }
        }
      );
    }

    function validatePlanEntries(entries) {
      if (!Array.isArray(entries) || entries.length > 1000) return null;
      let pending = 0;
      const normalized = [];
      for (const e of entries) {
        if (!e || typeof e !== 'object' || typeof e.content !== 'string') return null;
        // Native requires `status` (pending|in_progress|completed) plus a
        // `priority` field; the missing-status fallback below is our lenient
        // default, not native behaviour.
        const status = e.status == null ? 'pending' : e.status;
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
          return null;
        }
        if (status === 'pending' || status === 'in_progress') pending++;
        normalized.push([e.content, status]);
      }
      const signature = createHash('sha256').update(JSON.stringify(normalized
        .map(entry => JSON.stringify(entry)).sort())).digest('hex');
      return { invalid: false, pendingCount: pending, signature };
    }

    // Native keeps a single current plan: every `plan`/`plan_update(items)`
    // marks the previous one stale, non-`items` updates produce no plan record,
    // and `plan_removed` is a no-op in the projection. We mirror that — at most
    // one plan lives in `turn.plans`; `planUpdates` still counts raw events for
    // diagnostics.
    function processPlanUpdate(turn, update, sessionId) {
      if (!turn || !update) return;
      turn.planUpdates = (turn.planUpdates || 0) + 1;
      if (!turn.plans) turn.plans = new Map();

      if (update.sessionUpdate === 'plan') {
        const state = validatePlanEntries(update.entries);
        turn.plans.clear();
        turn.plans.set('__default__', state || { invalid: true, pendingCount: 0 });
      } else if (update.sessionUpdate === 'plan_update') {
        const plan = update.plan;
        const planId = plan?.planId;
        if (typeof planId !== 'string' || !planId || planId.length > 256) return;
        turn.plans.clear();
        if (plan?.type !== 'items') return;
        const state = validatePlanEntries(plan.entries);
        turn.plans.set(planId, state || { invalid: true, pendingCount: 0 });
      } else if (update.sessionUpdate === 'plan_removed') {
        const planId = update.planId;
        if (typeof planId === 'string' && planId && planId.length <= 256) {
          turn.plans.delete(planId);
        }
      }

      if (turn.scheduledReason === 'plan' && !checkHasPendingPlan(turn)) {
        cancelSessionTimer(sessionId);
        turn.scheduledReason = null;
        if (turn.deferred && !turn.deferred.settled && turn.lastResult) {
          turn.deferred.settled = true;
          if (turn.lastResult.isReject) turn.deferred.reject(turn.lastResult.value);
          else turn.deferred.resolve(turn.lastResult.value);
        }
        entry.sessions.delete(sessionId);
      }
    }

    function observeIncoming(request) {
      if (disposed || !entry.active) return;
      const method = request?.method;
      let params = request?.params;
      if (method === 'ext/method' && params?.method === '_session/elicitation' && params?.params) {
        params = params.params;
      }
      const sessionId = params?.sessionId;
      if (!sessionId) return;

      if (method === 'session/request_permission' || method === 'elicitation/create' ||
          method === '_session/elicitation' || method === 'session/permission_request' ||
          (method === 'ext/method' && request?.params?.method === '_session/elicitation')) {
        const turn = entry.sessions.get(sessionId);
        if (turn) {
          cancelSessionTimer(sessionId);
          turn.retryDisallowed = true;
          if (turn.deferred && !turn.deferred.settled && turn.lastResult) {
            turn.deferred.settled = true;
            if (turn.lastResult.isReject) turn.deferred.reject(turn.lastResult.value);
            else turn.deferred.resolve(turn.lastResult.value);
          }
          entry.sessions.delete(sessionId);
        }
        return;
      }

      if (method !== 'session/update') return;
      const update = params?.update;
      if (!update) return;

      if (update._meta?.['cognition.ai/subagent_context'] ||
          update.content?._meta?.['cognition.ai/subagent_context'] ||
          params._meta?.['cognition.ai/subagent_context']) {
        return;
      }

      const turn = entry.sessions.get(sessionId);
      if (!turn) return;

      const kind = update.sessionUpdate;
      if (kind === 'plan' || kind === 'plan_update' || kind === 'plan_removed') {
        processPlanUpdate(turn, update, sessionId);
        return;
      }

      if (kind === 'state_update') {
        turn.isV2 = true;
        const state = update.state;
        if (state === 'running') {
          cancelSessionTimer(sessionId);
        } else if (state === 'requires_action' || state === 'refusal' || state === 'cancelled' ||
                   update.stopReason === 'cancelled' || update.stopReason === 'refusal') {
          cancelSessionTimer(sessionId);
          turn.retryDisallowed = true;
          turn.consumed = true;
          turn.tail = '';
          entry.sessions.delete(sessionId);
          return;
        } else if (state === 'idle') {
          if (!turn.consumed) {
            turn.consumed = true;
            const options = getOptions() || {};
            const isError = matchesProviderError(turn.tail);
            const isBlocked = matchesTerminalBlocker(turn.tail);
            const shouldRetryError = !turn.retryDisallowed && isEnabled() && !sessionSuppressed(sessionId) && options.onProviderError !== false && isError;
            const hasPendingPlan = checkHasPendingPlan(turn);
            const allowedPlanReason = CONTINUABLE_STOP.has(update.stopReason);
            const emptyTruncation = allowedPlanReason && !(turn.textChars > 0) && !(turn.toolCalls > 0);
            const planEligible = !turn.retryDisallowed && !isBlocked && isEnabled() && !sessionSuppressed(sessionId) && options.untilPlanComplete === true && allowedPlanReason;
            const shouldRetryPlan = planEligible && !emptyTruncation;

            // Same lazy contract as the resolve branch: progress is checked
            // only when a pending plan exists and the error chain lost.
            const planRetry = !shouldRetryError && shouldRetryPlan && (!hasPendingPlan || hasPlanProgress(turn));
            emitEvaluated(turn, sessionId, 'idle', update.stopReason,
              shouldRetryError ? 'error-retry' : planRetry ? 'plan-retry' : 'stop',
              !shouldRetryError && !planRetry && emptyTruncation && planEligible ? 'truncated-empty' : null);
            if (shouldRetryError) {
              scheduleAuto(sessionId, turn, 'error');
            } else if (planRetry) {
              scheduleAuto(sessionId, turn, 'plan');
            } else {
              entry.sessions.delete(sessionId);
            }
          }
          return;
        }
      }

      if (kind === 'session_info_update') {
        const meta = { ...(params?._meta?.['cognition.ai/session'] || {}), ...(update._meta || {}) };
        const outcome = meta['cognition.ai/finishedOutcome'];
        const disabled = meta['cognition.ai/inputDisabledReason'];
        const actionReq = meta['cognition.ai/userActionRequired'];
        if (['completed', 'stopped', 'suspended', 'expired'].includes(outcome) ||
            (typeof disabled === 'string' && disabled) ||
            (typeof actionReq === 'string' && actionReq)) {
          cancelSessionTimer(sessionId);
          turn.retryDisallowed = true;
          if (turn.deferred && !turn.deferred.settled && turn.lastResult) {
            turn.deferred.settled = true;
            if (turn.lastResult.isReject) turn.deferred.reject(turn.lastResult.value);
            else turn.deferred.resolve(turn.lastResult.value);
          }
          entry.sessions.delete(sessionId);
          return;
        }
      }

      if (turn.consumed) return;

      if (kind === 'agent_message_chunk') {
        if (update.messageId) {
          turn.isV2 = true;
          if (turn.messageId !== update.messageId) {
            turn.messageId = update.messageId;
            turn.tail = '';
          }
        }
        const content = update.content;
        if (content?.type === 'text' && typeof content.text === 'string') {
          turn.tail = (turn.tail + content.text).slice(-4096);
          turn.textChars = (turn.textChars || 0) + content.text.length;
        } else {
          turn.tail = '';
        }
      } else if (kind === 'agent_message') {
        turn.isV2 = true;
        if (update.messageId && turn.messageId !== update.messageId) {
          turn.messageId = update.messageId;
          turn.tail = '';
        }
        if (update._meta?.['cognition.ai/abort'] || update.stopReason === 'cancelled') {
          turn.tail = '';
          turn.retryDisallowed = true;
          return;
        }
        if (Array.isArray(update.content)) {
          let text = '';
          let lastWasNonText = false;
          for (const b of update.content) {
            if (b?._meta?.['cognition.ai/subagent_context']) continue;
            if (b?.type === 'text' && typeof b.text === 'string') {
              text += b.text;
              lastWasNonText = false;
            } else {
              lastWasNonText = true;
            }
          }
          turn.tail = lastWasNonText ? '' : text.slice(-4096);
          turn.textChars = (turn.textChars || 0) + text.length;
        }
      } else if (kind === 'tool_call') {
        turn.tail = '';
        turn.toolCalls = (turn.toolCalls || 0) + 1;
      } else if (kind === 'user_message_chunk' || kind === 'user_message' ||
                 kind === 'tool_call_update' || kind === 'tool_call_content_chunk' ||
                 kind === 'agent_thought_chunk' || kind === 'agent_thought') {
        turn.tail = '';
      }
    }

    entry.sendRequestWrapper = function (...args) {
      const request = args[0];
      const method = request?.method;
      const sessionId = request?.params?.sessionId;

      if (!disposed && entry.active && sessionId && RESET_METHODS.has(method)) {
        cancelSessionTimer(sessionId);
        const existingTurn = entry.sessions.get(sessionId);
        if (existingTurn) {
          existingTurn.retryDisallowed = true;
          if (existingTurn.deferred && !existingTurn.deferred.settled && existingTurn.lastResult) {
            existingTurn.deferred.settled = true;
            if (existingTurn.lastResult?.isReject) existingTurn.deferred.reject(existingTurn.lastResult.value);
            else if (existingTurn.lastResult) existingTurn.deferred.resolve(existingTurn.lastResult.value);
          }
        }
        entry.sessions.delete(sessionId);
      }

      const enabled = isEnabled();
      const isAuto = autoAttempts.has(request);
      const isV2 = connector.protocolVersion >= 2;
      const suppressed = !isAuto && sessionSuppressed(sessionId);

      let manualTurn;
      if (!disposed && entry.active && sessionId && method === 'session/prompt') {
        if (!isAuto) {
          cancelSessionTimer(sessionId);
          const previousTurn = entry.sessions.get(sessionId);
          if (previousTurn) {
            previousTurn.retryDisallowed = true;
            if (previousTurn.deferred && !previousTurn.deferred.settled && previousTurn.lastResult) {
              previousTurn.deferred.settled = true;
              if (previousTurn.lastResult.isReject) previousTurn.deferred.reject(previousTurn.lastResult.value);
              else previousTurn.deferred.resolve(previousTurn.lastResult.value);
            }
          }
          if (enabled && !suppressed) {
            manualTurn = {
              generation: ++entry.turnGeneration,
              attempts: 0,
              errorAttempts: 0,
              errorStartedAt: null,
              tail: '',
              messageId: null,
              isV2,
              consumed: false,
              retryDisallowed: false,
              lastResult: null,
              deferred: null,
              textChars: 0,
              toolCalls: 0,
              planUpdates: 0,
              plans: new Map(),
              autoPlanSnapshot: null,
              scheduledReason: null
            };
            entry.sessions.set(sessionId, manualTurn);
          } else {
            entry.sessions.delete(sessionId);
          }
        } else {
          const currentTurn = entry.sessions.get(sessionId);
          if (currentTurn) {
            currentTurn.generation = ++entry.turnGeneration;
            const auto = autoAttempts.get(request);
            if (auto) { if (auto.reason !== 'error') currentTurn.attempts = auto.attempts; }
            else currentTurn.attempts = currentTurn.attempts + 1;
            currentTurn.autoPlanSnapshot = planSnapshot(currentTurn);
            currentTurn.tail = '';
            currentTurn.textChars = 0;
            currentTurn.toolCalls = 0;
            currentTurn.messageId = null;
            currentTurn.consumed = false;
            currentTurn.lastResult = null;
            currentTurn.scheduledReason = null;
          }
        }
      }

      const activeTurn = sessionId && method === 'session/prompt' ? entry.sessions.get(sessionId) : null;
      const currentGen = activeTurn?.generation;
      let originalPromise;
      try {
        originalPromise = Reflect.apply(originalSend, this, args);
      } catch (err) {
        if (activeTurn) {
          if (activeTurn.deferred && !activeTurn.deferred.settled) {
            activeTurn.deferred.settled = true;
            activeTurn.deferred.reject(err);
          }
          entry.sessions.delete(sessionId);
        }
        throw err;
      }

      if (!enabled || suppressed || !activeTurn || isV2) {
        if (isV2 && activeTurn && originalPromise && typeof originalPromise.catch === 'function') {
          originalPromise.catch(() => {
            if (entry.sessions.get(sessionId) === activeTurn && activeTurn.generation === currentGen) {
              entry.sessions.delete(sessionId);
            }
          });
        }
        return originalPromise;
      }

      if (isAuto) {
        handlePromptPromise(originalPromise, activeTurn, sessionId, currentGen);
        return originalPromise;
      }

      let resolveDeferred, rejectDeferred;
      const chainedPromise = new Promise((resolve, reject) => {
        resolveDeferred = resolve;
        rejectDeferred = reject;
      });
      activeTurn.deferred = { resolve: resolveDeferred, reject: rejectDeferred, settled: false };

      handlePromptPromise(originalPromise, activeTurn, sessionId, currentGen);

      return chainedPromise;
    };

    entry.forwardWrapper = function (...args) {
      try { observeIncoming(args[0]); } catch {}
      return Reflect.apply(originalForward, this, args);
    };

    entry.disconnect = () => {
      for (const timer of entry.timers.values()) clearTimer(timer);
      entry.timers.clear();
      for (const turn of entry.sessions.values()) {
        turn.retryDisallowed = true;
        if (turn.deferred && !turn.deferred.settled && turn.lastResult) {
          turn.deferred.settled = true;
          if (turn.lastResult.isReject) turn.deferred.reject(turn.lastResult.value);
          else turn.deferred.resolve(turn.lastResult.value);
        }
      }
      entry.sessions.clear();
    };

    if (originalSetStatus) {
      entry.setStatusWrapper = function (status, ...rest) {
        if (isTerminalStatus(status)) entry.disconnect();
        return Reflect.apply(originalSetStatus, this, [status, ...rest]);
      };
    }

    try {
      if (originalSetStatus) connector.setStatus = entry.setStatusWrapper;
      connector.sendRequest = entry.sendRequestWrapper;
      connector.forwardClientRequest = entry.forwardWrapper;
      connector[ATTACHED] = true;
    } catch (e) {
      restoreMember(connector, 'sendRequest', entry.sendRequestWrapper, sendRequestDescriptor);
      restoreMember(connector, 'forwardClientRequest', entry.forwardWrapper, forwardDescriptor);
      if (originalSetStatus) restoreMember(connector, 'setStatus', entry.setStatusWrapper, setStatusDescriptor);
      delete connector[ATTACHED];
      throw e;
    }

    connections.set(connector, entry);
    report('auto-continue-connector-attached');
    return entry;
  }

  const layer = createAcpRegistry(api).addLayer({
    id: 'auto-continue', priority: 10, attach, detach,
    update(target, change) {
      if (!isTerminalStatus(change?.status)) return;
      for (const [connector, entry] of connections) {
        if (connector.location?.kind === 'local' || (target !== connector && target !== connector.id)) continue;
        entry.disconnect();
      }
    } });

  const handle = {
    status() {
      return {
        installed: !disposed,
        connections: connections.size,
        activeSessions: [...connections.values()].reduce((sum, c) => sum + c.sessions.size, 0),
        pendingTimers: [...connections.values()].reduce((sum, c) => sum + c.timers.size, 0),
        autoContinueCount
      };
    },
    reset() {
      for (const entry of connections.values()) {
        for (const timer of entry.timers.values()) clearTimer(timer);
        entry.timers.clear();
        for (const turn of entry.sessions.values()) {
          turn.retryDisallowed = true;
          if (turn.deferred && !turn.deferred.settled && turn.lastResult) {
            turn.deferred.settled = true;
            if (turn.lastResult.isReject) turn.deferred.reject(turn.lastResult.value);
            else turn.deferred.resolve(turn.lastResult.value);
          }
        }
        entry.sessions.clear();
      }
    },
    cancelSession(sessionId) {
      if (!sessionId) return false;
      let cancelled = false;
      for (const entry of connections.values()) {
        const timer = entry.timers.get(sessionId);
        if (timer !== undefined) { clearTimer(timer); entry.timers.delete(sessionId); cancelled = true; }
        const turn = entry.sessions.get(sessionId);
        if (!turn) continue;
        turn.retryDisallowed = true;
        if (turn.deferred && !turn.deferred.settled && turn.lastResult) {
          turn.deferred.settled = true;
          if (turn.lastResult.isReject) turn.deferred.reject(turn.lastResult.value);
          else turn.deferred.resolve(turn.lastResult.value);
        }
        entry.sessions.delete(sessionId);
        cancelled = true;
      }
      return cancelled;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      handle.reset();
      layer.remove();
      delete api[INSTANCE];
    }
  };

  api[INSTANCE] = handle;
  return handle;
}

module.exports = {
  installAutoContinue,
  matchesProviderError,
  matchesTerminalBlocker,
  PLAN_ATTEMPT_LIMIT
};

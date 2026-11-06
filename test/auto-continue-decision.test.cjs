'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/auto-continue-fixture.cjs');

const f = fixture();
const decide = f.decideContinuation;
assert.equal(typeof decide, 'function', 'the fixture must expose the pure decision seam');

const base = {
  enabled: true,
  suppressed: false,
  retryDisallowed: false,
  onProviderError: true,
  untilPlanComplete: true,
  providerErrorMatched: false,
  terminalBlocker: false,
  stopReason: 'max_turn_requests',
  textChars: 10,
  toolCalls: 0,
  hasPendingPlan: false,
  planProgressed: true
};
const verdict = (overrides = {}) => {
  const out = decide({ ...base, ...overrides });
  return { decision: out.decision, reason: out.reason, stalledPlan: out.stalledPlan };
};

const cases = [
  ['disabled stops', { enabled: false, providerErrorMatched: true }, 'stop', null, false],
  ['suppressed stops', { suppressed: true, providerErrorMatched: true }, 'stop', null, false],
  ['retryDisallowed stops', { retryDisallowed: true, providerErrorMatched: true }, 'stop', null, false],
  ['provider error beats a stalled pending plan', { providerErrorMatched: true, hasPendingPlan: true, planProgressed: false }, 'error-retry', null, false],
  ['onProviderError off hands a truncation to the plan chain', { onProviderError: false, providerErrorMatched: true }, 'plan-retry', null, false],
  ['end_turn is never continuable', { stopReason: 'end_turn' }, 'stop', null, false],
  ['max_tokens continues without a plan', { stopReason: 'max_tokens' }, 'plan-retry', null, false],
  ['untilPlanComplete off stops a truncation', { untilPlanComplete: false }, 'stop', null, false],
  ['empty truncation does not continue', { textChars: 0, toolCalls: 0 }, 'stop', 'truncated-empty', false],
  ['tool-call-only truncation continues', { textChars: 0, toolCalls: 3 }, 'plan-retry', null, false],
  ['a terminal blocker vetoes the plan chain', { terminalBlocker: true }, 'stop', null, false],
  ['a pending plan that progressed continues', { hasPendingPlan: true, planProgressed: true }, 'plan-retry', null, false],
  ['a pending plan that stalled stops with the hint', { hasPendingPlan: true, planProgressed: false }, 'stop', null, true],
  ['reject shape with an exact provider error retries', { stopReason: null, providerErrorMatched: true }, 'error-retry', null, false],
  ['reject shape never enters the plan chain', { stopReason: null, providerErrorMatched: false, hasPendingPlan: true, planProgressed: true }, 'stop', null, false]
];

test('decideContinuation maps snapshot facts to the shared verdict', () => {
  for (const [name, overrides, decision, reason, stalledPlan] of cases) {
    assert.deepEqual(verdict(overrides), { decision, reason, stalledPlan }, name);
  }
});

test('decideContinuation is deterministic and never mutates its input', () => {
  const input = Object.freeze({ ...base, hasPendingPlan: true, planProgressed: false });
  const snapshot = JSON.stringify(input);
  const first = decide(input);
  const second = decide(input);
  assert.equal(JSON.stringify(first), JSON.stringify(second), 'same facts, same verdict');
  assert.equal(JSON.stringify(input), snapshot, 'frozen input stays untouched');
});

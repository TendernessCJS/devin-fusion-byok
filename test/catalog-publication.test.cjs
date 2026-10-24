'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCatalogPublication } = require('../src/activation/catalog-publication.cjs');
const { catalogSignature } = require('../src/catalog.cjs');

function fakeClock() {
  const clock = { t: 1000, seq: 0, timers: new Map(),
    now() { return clock.t; },
    set(fn, ms) { const id = ++clock.seq; clock.timers.set(id, { fn, at: clock.t + ms }); return id; },
    clear(id) { clock.timers.delete(id); },
    advance(ms = 1) {
      clock.t += ms;
      for (const [id, timer] of [...clock.timers]) {
        if (timer.at <= clock.t) { clock.timers.delete(id); timer.fn(); }
      }
    } };
  return clock;
}

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const micro = () => Promise.resolve();

function fixture({ catalog } = {}) {
  const clock = fakeClock();
  const commands = [], logs = [], gate = { next: deferred() };
  const current = { catalog: catalog ?? { models: [{ uid: 'own-1', raw: Buffer.from('a') }] } };
  const pub = createCatalogPublication({
    getCatalog: () => current.catalog,
    refreshUserStatus: () => { const call = deferred(); commands.push(call); return call.promise; },
    isCurrent: () => true,
    log: (event, data) => logs.push({ event, data }),
    clock });
  const signature = c => catalogSignature(c ?? current.catalog);
  return { clock, commands, logs, current, pub, signature };
}

test('a change coalesces into one refresh and confirms on the matching applied signature', async () => {
  const f = fixture();
  f.pub.changed();
  f.pub.changed();
  assert.equal(f.pub.status().state, 'pending');
  assert.equal(f.commands.length, 0, 'the merge delay coalesces bursts before any command');
  f.clock.advance(1500);
  assert.equal(f.commands.length, 1);
  f.commands[0].resolve();
  await micro();
  assert.equal(f.pub.status().state, 'pending', 'command settle alone is not confirmation');
  f.pub.observe({ callId: 1, phase: 'applied', signature: f.signature() });
  assert.equal(f.pub.status().state, 'ready');
  // The same content again schedules nothing.
  f.pub.changed();
  f.clock.advance(10 * 1000);
  assert.equal(f.commands.length, 1, 'same signature triggers no request');
});

test('a command failure retries once after the retry delay, then degrades within budget', async () => {
  const f = fixture();
  f.pub.changed();
  f.clock.advance(1500);
  assert.equal(f.commands.length, 1);
  f.commands[0].reject(new Error('no'));
  await micro();
  assert.equal(f.commands.length, 1, 'the retry waits for its delay');
  f.clock.advance(5000);
  assert.equal(f.commands.length, 2);
  f.commands[1].reject(new Error('no'));
  await micro();
  f.clock.advance(5000);
  assert.equal(f.commands.length, 2, 'two automatic attempts per signature, then the budget stops it');
  assert.equal(f.pub.status().state, 'degraded');
  assert.equal(f.pub.status().code, 'attempt-budget');
  // A manual refresh re-arms a single attempt.
  f.pub.changed({ force: true });
  f.clock.advance(1500);
  assert.equal(f.commands.length, 3);
});

test('a watchdog timeout degrades without releasing the in-flight lock', async () => {
  const f = fixture();
  f.pub.changed();
  f.clock.advance(1500);
  assert.equal(f.commands.length, 1);
  f.clock.advance(10000);
  assert.equal(f.pub.status().state, 'degraded');
  assert.equal(f.pub.status().code, 'command-watchdog');
  // The lock is still held: a new change cannot start a parallel command.
  f.current.catalog = { models: [{ uid: 'own-2', raw: Buffer.from('b') }] };
  f.pub.changed();
  f.clock.advance(60 * 1000);
  assert.equal(f.commands.length, 1, 'an unsettled command never frees its lock into a parallel refresh');
});

test('a stale applied signature never marks a newer desired emit ready', async () => {
  const f = fixture();
  f.pub.changed();
  f.clock.advance(1500);
  const first = f.signature();
  f.current.catalog = { models: [{ uid: 'own-2', raw: Buffer.from('b') }] };
  const second = f.signature();
  assert.notEqual(first, second);
  f.pub.changed();
  f.commands[0].resolve();
  await micro();
  f.pub.observe({ callId: 2, phase: 'applied', signature: first });
  assert.equal(f.pub.status().state, 'pending', 'the old emit confirmation must not satisfy the new one');
  f.clock.advance(1500);
  assert.equal(f.commands.length, 2);
  f.commands[1].resolve();
  await micro();
  f.pub.observe({ callId: 3, phase: 'applied', signature: second });
  assert.equal(f.pub.status().state, 'ready');
});

test('an applied signature for foreign content while desired pending retries conservatively', async () => {
  const f = fixture();
  f.pub.changed();
  f.clock.advance(1500);
  f.commands[0].resolve();
  await micro();
  f.pub.observe({ callId: 4, phase: 'applied', signature: 'someone-elses' });
  assert.equal(f.pub.status().state, 'pending');
  f.clock.advance(5000);
  assert.equal(f.commands.length, 2, 'ours is still owed, so it re-attempts within budget');
});

test('a cleared event moves to waiting-auth and stops automatic work', async () => {
  const f = fixture();
  f.pub.changed();
  f.clock.advance(1500);
  assert.equal(f.commands.length, 1);
  f.commands[0].resolve();
  await micro();
  f.pub.observe({ callId: 5, phase: 'cleared' });
  assert.equal(f.pub.status().state, 'waiting-auth');
  f.pub.changed();
  f.clock.advance(60 * 1000);
  assert.equal(f.commands.length, 1, 'no refresh loop while signed out');
});

test('a late failure for a different signature does not tear down a ready state', async () => {
  const f = fixture();
  f.pub.changed();
  f.clock.advance(1500);
  f.commands[0].resolve();
  await micro();
  f.pub.observe({ callId: 6, phase: 'applied', signature: f.signature() });
  assert.equal(f.pub.status().state, 'ready');
  f.pub.observe({ callId: 7, phase: 'failed', signature: 'stale-call', code: 'native-call-failed' });
  assert.equal(f.pub.status().state, 'ready');
});

test('hook unavailability degrades deterministically', () => {
  const f = fixture();
  f.pub.observe({ callId: 8, phase: 'failed', code: 'hook-unavailable' });
  assert.equal(f.pub.status().state, 'degraded');
  assert.equal(f.pub.status().code, 'hook-unavailable');
});

test('the rolling window caps automatic attempts and manual force bypasses it once', async () => {
  const f = fixture();
  // Each signature consumes two automatic attempts (first try + one retry on
  // the signature-mismatch), so the rolling 60s window of six is exhausted
  // after three signatures and the next automatic attempt must refuse.
  for (let index = 0; index < 3; index++) {
    f.current.catalog = { models: [{ uid: 'own-' + index, raw: Buffer.from('x' + index) }] };
    f.pub.changed();
    f.clock.advance(1500);
    f.commands.at(-1).resolve();
    await micro();
    f.pub.observe({ callId: 9, phase: 'applied', signature: 'other-' + index });
    f.clock.advance(5000);
    f.commands.at(-1).resolve();
    await micro();
  }
  assert.equal(f.commands.length, 6, 'two attempts per signature within the window');
  f.current.catalog = { models: [{ uid: 'own-7', raw: Buffer.from('x7') }] };
  f.pub.changed();
  f.clock.advance(1500);
  assert.equal(f.pub.status().state, 'degraded');
  assert.equal(f.pub.status().code, 'attempt-budget');
  assert.equal(f.commands.length, 6, 'the window cap stops automatic calls entirely');
  // A manual refresh is the sanctioned way past a spent budget.
  f.pub.changed({ force: true });
  f.clock.advance(1500);
  assert.equal(f.commands.length, 7);
  // Attempts age out: after the window slides, automatic work resumes.
  f.commands.at(-1).resolve();
  await micro();
  f.pub.observe({ callId: 10, phase: 'applied', signature: f.signature() });
  f.clock.advance(60 * 1000);
  f.current.catalog = { models: [{ uid: 'own-8', raw: Buffer.from('x8') }] };
  f.pub.changed();
  f.clock.advance(1500);
  assert.equal(f.commands.length, 8);
});

test('dispose clears every timer and late events cannot revive the publication', async () => {
  const f = fixture();
  f.pub.changed();
  f.pub.dispose();
  f.clock.advance(60 * 1000);
  assert.equal(f.commands.length, 0);
  f.pub.observe({ callId: 11, phase: 'applied', signature: f.signature() });
  f.pub.observe({ callId: 12, phase: 'cleared' });
  assert.equal(f.pub.status().state, 'pending', 'a disposed publication ignores late events');
  f.pub.changed({ force: true });
  f.clock.advance(1500);
  assert.equal(f.commands.length, 0);
});

test('a missing refresh command is unsupported without scheduling anything', () => {
  const pub = createCatalogPublication({ getCatalog: () => ({ models: [] }), refreshUserStatus: null });
  assert.equal(pub.status().state, 'unsupported');
  pub.changed({ force: true });
  assert.equal(pub.status().state, 'unsupported');
});

test('a settled-but-unconfirmed command retries once after the confirm wait, then degrades', async () => {
  const f = fixture();
  f.pub.changed();
  f.clock.advance(1500);
  f.commands[0].resolve();
  await micro();
  assert.equal(f.pub.status().state, 'pending', 'settle alone is still not confirmation');
  f.clock.advance(4999);
  assert.equal(f.commands.length, 1, 'the bounded confirm wait has not expired yet');
  f.clock.advance(1);
  assert.equal(f.commands.length, 1, 'the confirm wait arms the standard retry delay');
  f.clock.advance(5000);
  assert.equal(f.commands.length, 2, 'one retry fires when no applied arrives');
  f.commands[1].resolve();
  await micro();
  f.clock.advance(10000);
  assert.equal(f.commands.length, 2, 'the per-signature budget still applies — no third attempt');
  assert.equal(f.pub.status().state, 'degraded');
  assert.equal(f.pub.status().code, 'attempt-budget');
});

test('a confirmation arriving inside the wait window prevents the retry', async () => {
  const f = fixture();
  f.pub.changed();
  f.clock.advance(1500);
  f.commands[0].resolve();
  await micro();
  f.clock.advance(3000);
  f.pub.observe({ callId: 13, phase: 'applied', signature: f.signature() });
  f.clock.advance(5000);
  assert.equal(f.commands.length, 1, 'an applied inside the window cancels the retry');
  assert.equal(f.pub.status().state, 'ready');
});

test('a catalog change while a command is in flight republishes immediately after settle', async () => {
  const f = fixture();
  f.pub.changed();
  f.clock.advance(1500);
  const first = f.signature();
  // The catalog changes while command #1 is still in flight.
  f.current.catalog = { models: [{ uid: 'own-2', raw: Buffer.from('b') }] };
  const second = f.signature();
  f.pub.changed();
  f.clock.advance(1500);
  assert.equal(f.commands.length, 1, 'the in-flight lock still blocks a parallel command');
  f.commands[0].resolve();
  await micro();
  assert.equal(f.commands.length, 2, 'the stale emit is superseded immediately after settle');
  f.commands[1].resolve();
  await micro();
  f.pub.observe({ callId: 14, phase: 'applied', signature: second });
  assert.equal(f.pub.status().state, 'ready');
  assert.equal(first === second, false);
});

test('confirm and retry timers are cleaned on dispose', async () => {
  const f = fixture();
  f.pub.changed();
  f.clock.advance(1500);
  f.commands[0].resolve();
  await micro();
  f.pub.dispose();
  f.clock.advance(60 * 1000);
  assert.equal(f.commands.length, 1, 'no retry after dispose');
});

test('a late commit from an older call revokes ready and repairs within budget', async () => {
  const f = fixture();
  f.pub.changed();
  f.clock.advance(1500);
  const oldSignature = f.signature();
  f.commands[0].resolve(); await micro();
  f.current.catalog = { models: [{ uid: 'own-2', raw: Buffer.from('b') }] };
  f.pub.changed(); f.clock.advance(1500);
  f.commands[1].resolve(); await micro();
  f.pub.observe({ callId: 2, phase: 'applied', signature: f.signature() });
  assert.equal(f.pub.status().state, 'ready');
  // The older call's write lands late and overwrites the confirmed emit.
  f.pub.observe({ callId: 1, phase: 'applied', signature: oldSignature });
  assert.equal(f.pub.status().state, 'pending', 'the stale commit revokes ready');
  assert.equal(f.pub.status().code, 'stale-commit');
  assert.equal(f.commands.length, 3, 'the current target is repaired inside the budget');
  f.commands[2].resolve(); await micro();
  f.pub.observe({ callId: 3, phase: 'applied', signature: f.signature() });
  assert.equal(f.pub.status().state, 'ready');
});

test('the command lock is released only by its own settle, never by hook events', async () => {
  const f = fixture();
  f.pub.changed();
  f.clock.advance(1500);
  f.pub.observe({ callId: 1, phase: 'applied', signature: f.signature() });
  assert.equal(f.pub.status().state, 'ready', 'the event confirms even while the command is unsettled');
  f.current.catalog = { models: [{ uid: 'own-2', raw: Buffer.from('b') }] };
  f.pub.changed(); f.clock.advance(1500);
  assert.equal(f.commands.length, 1, 'a matching applied cannot free an unsettled command');
  f.commands[0].resolve(); await micro();
  assert.equal(f.commands.length, 2, 'settle releases the lock into the queued emit');
});

test('cleared sticks: a pre-clear commit cannot restore confirmation and changed cannot self-refresh', async () => {
  const f = fixture();
  f.pub.changed();
  f.clock.advance(1500);
  const signature = f.signature();
  f.pub.observe({ callId: 1, phase: 'applied', signature });
  assert.equal(f.pub.status().state, 'ready');
  f.commands[0].resolve(); await micro();
  f.pub.observe({ callId: 2, phase: 'cleared' });
  assert.equal(f.pub.status().state, 'waiting-auth');
  // A pre-clear call's late success must not lift waiting-auth.
  f.pub.observe({ callId: 1, phase: 'applied', signature });
  assert.equal(f.pub.status().state, 'waiting-auth');
  // A config change stays queued — no automatic refresh while signed out.
  f.current.catalog = { models: [{ uid: 'own-2', raw: Buffer.from('b') }] };
  f.pub.changed();
  f.clock.advance(60 * 1000);
  assert.equal(f.commands.length, 1, 'no automatic refresh while signed out');
  // A post-clear commit that mismatches the store re-arms the owed publish…
  f.pub.observe({ callId: 3, phase: 'applied', signature: 'foreign-store' });
  assert.equal(f.commands.length, 2);
  f.commands[1].resolve(); await micro();
  // …and only a post-clear call carrying the target signature restores ready.
  f.pub.observe({ callId: 4, phase: 'applied', signature: f.signature() });
  assert.equal(f.pub.status().state, 'ready');
});

test('force fires exactly one manual request while ready and coalesces concurrent forces', async () => {
  const f = fixture();
  f.pub.changed();
  f.clock.advance(1500);
  f.commands[0].resolve(); await micro();
  f.pub.observe({ callId: 1, phase: 'applied', signature: f.signature() });
  assert.equal(f.pub.status().state, 'ready');
  // A manual refresh bypasses the applied-signature early return exactly once.
  f.pub.changed({ force: true });
  f.clock.advance(1500);
  assert.equal(f.commands.length, 2, 'the forced request really goes out');
  // Forces while that manual command is still in flight merge into one.
  f.pub.changed({ force: true });
  f.pub.changed({ force: true });
  f.clock.advance(1500);
  assert.equal(f.commands.length, 2, 'in-flight forces cannot run in parallel');
  f.commands[1].resolve(); await micro();
  assert.equal(f.commands.length, 3, 'the merged force issues one command after settle');
  f.commands[2].resolve(); await micro();
  f.clock.advance(60 * 1000);
  assert.equal(f.commands.length, 3, 'a manual failure to confirm earns no extra attempts');
});

test('a matching applied before the command settles confirms, and settle stays inert', async () => {
  const f = fixture();
  f.pub.changed();
  f.clock.advance(1500);
  f.pub.observe({ callId: 1, phase: 'applied', signature: f.signature() });
  assert.equal(f.pub.status().state, 'ready');
  f.commands[0].resolve(); await micro();
  assert.equal(f.pub.status().state, 'ready');
  f.clock.advance(60 * 1000);
  assert.equal(f.commands.length, 1, 'no confirm-wait retry once ready');
});

test('a manual failure never earns automatic attempts and does not touch the budget', async () => {
  const f = fixture();
  // Manual-only start: no automatic attempt was ever spent for this target.
  f.pub.changed({ force: true });
  f.clock.advance(1500);
  assert.equal(f.commands.length, 1);
  f.commands[0].reject(new Error('manual boom')); await micro();
  assert.equal(f.pub.status().state, 'degraded');
  assert.equal(f.pub.status().code, 'command-failed');
  f.clock.advance(60 * 1000);
  assert.equal(f.commands.length, 1, 'a manual rejection is never re-queued automatically');
});

test('an unconfirmed manual gets the same confirm window, then degrades without retry', async () => {
  const f = fixture();
  f.pub.changed({ force: true });
  f.clock.advance(1500);
  f.commands[0].resolve(); await micro();
  f.clock.advance(4999);
  assert.equal(f.pub.status().state, 'pending', 'the manual emit still waits for its applied event');
  f.clock.advance(1);
  assert.equal(f.pub.status().state, 'degraded');
  assert.equal(f.pub.status().code, 'manual-unconfirmed');
  f.clock.advance(60 * 1000);
  assert.equal(f.commands.length, 1, 'an unconfirmed manual never re-queues itself');
});

test('a matching applied before a manual command rejects does not schedule more work', async () => {
  const f = fixture();
  f.pub.changed({ force: true });
  f.clock.advance(1500);
  f.pub.observe({ callId: 1, phase: 'applied', signature: f.signature() });
  f.commands[0].reject(new Error('late failure')); await micro();
  f.clock.advance(60 * 1000);
  assert.equal(f.commands.length, 1, 'a confirmed commit is not undone by the late settle');
});

test('repeated forces inside the merge window collapse into one manual request', async () => {
  const f = fixture();
  f.pub.changed({ force: true });
  f.pub.changed({ force: true });
  f.pub.changed({ force: true });
  f.clock.advance(1500);
  assert.equal(f.commands.length, 1, 'three forces merge into exactly one request');
  f.commands[0].resolve(); await micro();
  f.clock.advance(60000);
  assert.equal(f.commands.length, 1, 'settlement cannot replay an already consumed manual intent');
});

test('forcing a queued automatic merge consumes it without retaining its retry', async () => {
  const f = fixture();
  f.pub.changed();
  f.pub.changed({ force: true });
  f.clock.advance(1500);
  f.commands[0].reject(new Error('manual failure')); await micro();
  f.clock.advance(60000);
  assert.equal(f.commands.length, 1, 'same-target force replaces the automatic merge too');

  const g = fixture();
  g.pub.changed(); g.clock.advance(1500);
  g.commands[0].reject(new Error('automatic failure')); await micro();
  g.pub.changed({ force: true }); g.clock.advance(1500);
  g.commands[1].reject(new Error('manual failure')); await micro();
  g.clock.advance(60000);
  assert.equal(g.commands.length, 2, 'a force cancels the previously scheduled automatic retry');
});

test('pre-clear calls remain tracked across login and a late commit triggers repair', async () => {
  const f = fixture();
  f.pub.changed(); f.clock.advance(1500);
  f.commands[0].resolve(); await micro();
  f.pub.observe({ callId: 1, phase: 'attempt', signature: 'old' });
  f.pub.observe({ callId: 2, phase: 'cleared' });
  f.pub.observe({ callId: 3, phase: 'applied', signature: f.signature() });
  assert.notEqual(f.pub.status().state, 'ready', 'an older pending call may still overwrite the new login');
  f.pub.observe({ callId: 1, phase: 'applied', signature: 'old' });
  assert.notEqual(f.pub.status().state, 'ready');
  assert.equal(f.commands.length, 2, 'the late pre-clear commit is repaired after login');
});

test('a forced catalog change replaces the pending automatic merge, never stacks it', async () => {
  const f = fixture();
  f.pub.changed();
  f.current.catalog = { models: [{ uid: 'own-2', raw: Buffer.from('b') }] };
  f.pub.changed({ force: true });
  f.clock.advance(1500);
  // Exactly one request went out, and it was the manual one for the new target.
  assert.equal(f.commands.length, 1, 'the force replaces the auto merge instead of stacking behind it');
  f.commands[0].resolve(); await micro();
  f.pub.observe({ callId: 1, phase: 'applied', signature: f.signature() });
  assert.equal(f.pub.status().state, 'ready');
});

test('an in-flight manual still lets a genuine target change republish on settle', async () => {
  const f = fixture();
  f.pub.changed({ force: true });
  f.clock.advance(1500);
  f.current.catalog = { models: [{ uid: 'own-2', raw: Buffer.from('b') }] };
  f.pub.changed();
  f.commands[0].resolve(); await micro();
  assert.equal(f.commands.length, 2, 'the new target goes out after the manual settles');
});

test('a failed native write leaves ready revoked until a matching commit lands', async () => {
  const f = fixture();
  f.pub.changed();
  f.clock.advance(1500);
  f.commands[0].resolve(); await micro();
  f.pub.observe({ callId: 1, phase: 'applied', signature: f.signature() });
  assert.equal(f.pub.status().state, 'ready');
  // A foreign in-flight call revokes ready; its real rejection reveals the
  // store still holds the confirmed emit, so ready stands again.
  f.pub.observe({ callId: 2, phase: 'attempt', signature: 'foreign' });
  assert.equal(f.pub.status().state, 'pending');
  f.pub.observe({ callId: 2, phase: 'failed', code: 'native-call-failed' });
  assert.equal(f.pub.status().state, 'ready');
});

test('a native write that landed without emit verification revokes ready and repairs', async () => {
  const f = fixture();
  f.pub.changed();
  f.clock.advance(1500);
  f.commands[0].resolve(); await micro();
  f.pub.observe({ callId: 1, phase: 'applied', signature: f.signature() });
  assert.equal(f.pub.status().state, 'ready');
  // The native side of an unverifiable emit still wrote — the store's content
  // is unknown, so the confirmed signature can no longer stand.
  f.pub.observe({ callId: 2, phase: 'attempt', signature: null });
  f.pub.observe({ callId: 2, phase: 'failed', code: 'shape-unrecognized', nativeApplied: true });
  assert.equal(f.pub.status().state, 'pending');
  assert.equal(f.pub.status().code, 'stale-commit');
  assert.equal(f.commands.length, 2, 'the target is repaired inside the budget');
});

test('a clear during an unsettled command holds the pause through watchdog, change and settle', async () => {
  const f = fixture();
  f.pub.changed();
  f.clock.advance(1500);
  f.pub.observe({ callId: 1, phase: 'cleared' });
  // The command never settles; the watchdog must not turn the pause back into
  // automatic work, and a config change stays queued regardless.
  f.clock.advance(10000);
  f.current.catalog = { models: [{ uid: 'own-2', raw: Buffer.from('b') }] };
  f.pub.changed();
  f.clock.advance(60000);
  assert.equal(f.commands.length, 1, 'no automatic refresh while signed out');
  assert.equal(f.pub.status().state, 'waiting-auth');
  // Resolving the old command cannot re-arm anything either.
  f.commands[0].resolve(); await micro();
  f.clock.advance(60000);
  assert.equal(f.commands.length, 1, 'the settled pre-clear command cannot republish');
});

test('a manual force during sign-out may fire once but a failure never lifts the pause', async () => {
  const f = fixture();
  f.pub.observe({ callId: 1, phase: 'cleared' });
  f.pub.changed({ force: true });
  f.clock.advance(1500);
  assert.equal(f.commands.length, 1, 'an explicit manual request may still try');
  f.commands[0].reject(new Error('offline')); await micro();
  f.clock.advance(60000);
  assert.equal(f.commands.length, 1, 'a failed manual earns nothing automatic');
  assert.equal(f.pub.status().code, 'command-failed');
  // A post-clear commit still ends the pause normally.
  f.pub.observe({ callId: 2, phase: 'applied', signature: 'foreign' });
  f.commands[1]?.resolve?.();
  assert.equal(f.pub.status().state === 'waiting-auth', false);
});

test('a manual command that fails while a new target waits still publishes the new target', async () => {
  const f = fixture();
  f.pub.changed({ force: true });
  f.clock.advance(1500);
  f.current.catalog = { models: [{ uid: 'own-2', raw: Buffer.from('b') }] };
  f.pub.changed();
  f.commands[0].reject(new Error('manual boom')); await micro();
  assert.equal(f.commands.length, 2, 'the queued target goes out by the automatic budget, not lost with the manual');
});

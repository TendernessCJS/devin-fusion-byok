'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { monitorDateRange, filterMonitorRecords, filteredMonitorView, createMonitorStats } = require('../src/monitor-stats.cjs');

test('date presets use local calendar days and month boundaries', () => {
  const now = new Date(2026, 9, 13, 12).getTime();
  const thisMonth = monitorDateRange('this-month', { now });
  assert.equal(thisMonth.from, new Date(2026, 9, 1).getTime());
  assert.equal(thisMonth.to, new Date(2026, 10, 1).getTime());
  assert.equal(thisMonth.startDate, '2026-10-01');
  assert.equal(thisMonth.endDate, '2026-10-31');
  const lastMonth = monitorDateRange('last-month', { now: new Date(2026, 0, 13, 12).getTime() });
  assert.equal(lastMonth.startDate, '2025-12-01');
  assert.equal(lastMonth.endDate, '2025-12-31');
  const last7 = monitorDateRange('last-7-days', { now });
  assert.equal(last7.from, new Date(2026, 9, 7).getTime());
  assert.equal(last7.to, new Date(2026, 9, 14).getTime());
  assert.equal(last7.startDate, '2026-10-07');
  assert.equal(last7.endDate, '2026-10-13');
  const today = monitorDateRange('today', { now });
  assert.equal(today.from, new Date(2026, 9, 13).getTime());
  assert.equal(today.to, new Date(2026, 9, 14).getTime());
  assert.equal(today.startDate, '2026-10-13');
  assert.equal(today.endDate, '2026-10-13');
  assert.equal(monitorDateRange('all', { now }).error, null);
  assert.equal(monitorDateRange('nonsense', { now }).error !== null, true);
});

test('custom dates validate, leap days work and year 99 is not 1999', () => {
  const sameDay = monitorDateRange('custom', { start: '2026-10-05', end: '2026-10-05' });
  assert.equal(sameDay.error, null);
  assert.equal(sameDay.from, new Date(2026, 9, 5).getTime());
  assert.equal(sameDay.to, new Date(2026, 9, 6).getTime(), 'the end date is inclusive through its local midnight');
  assert.equal(monitorDateRange('custom', { start: '2024-02-29', end: '2024-02-29' }).error, null);
  assert.ok(monitorDateRange('custom', { start: '2025-02-29', end: '2025-02-29' }).error);
  assert.ok(monitorDateRange('custom', { start: '2026-02-30', end: '2026-02-30' }).error);
  assert.ok(monitorDateRange('custom', { start: '', end: '2026-01-01' }).error);
  assert.ok(monitorDateRange('custom', { start: '2026-02-01', end: '2026-01-01' }).error, 'an inverted range is an error');
  const ancient = monitorDateRange('custom', { start: '0099-01-01', end: '0099-01-01' });
  assert.equal(ancient.error, null);
  assert.equal(new Date(ancient.from).getFullYear(), 99, 'year 0099 must stay 99, never slide to 1999');
});

test('a DST spring-forward day spans 23 hours, never a fixed 86400000', () => {
  const tz = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    const range = monitorDateRange('custom', { start: '2026-03-08', end: '2026-03-08' });
    assert.equal(range.error, null);
    assert.equal(range.to - range.from, 23 * 3600 * 1000, 'local midnight to local midnight crosses the DST gap');
  } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
});

test('the range is left-closed right-open on record start times', () => {
  const from = new Date(2026, 9, 1).getTime(), to = new Date(2026, 10, 1).getTime();
  const iso = ms => new Date(ms).toISOString();
  const input = [from - 1, from, to - 1, to].map(ms => ({ startedAt: iso(ms), id: 'r' }));
  const kept = filterMonitorRecords(input, { from, to, error: null });
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map(r => r.startedAt), [iso(from), iso(to - 1)], 'from is inclusive, to is exclusive');
});

test('filteredMonitorView recomputes summary and attribution inside the range only', () => {
  const iso = ms => new Date(ms).toISOString();
  const base = new Date(2026, 9, 15, 12).getTime();
  const record = extra => ({ schemaVersion: 3, model: 'm', status: 'success', attribution: 'unassigned', attributionReason: 'no-tool-ids', ...extra });
  const inRange = [
    record({ id: 'ok', startedAt: iso(base), outputTokens: 10, durationMs: 1000, tps: 25 }),
    record({ id: 'cancel', startedAt: iso(base + 1), status: 'cancelled', outputTokens: 20, durationMs: 2000 }),
    record({ id: 'err', startedAt: iso(base + 2), status: 'error', outputTokens: 0, durationMs: 1000 }),
    record({ id: 'bad', startedAt: iso(base + 3), inputTokens: 1, cachedTokens: 2, outputTokens: 32 }),
  ];
  const outside = record({ id: 'outside', startedAt: iso(new Date(2026, 8, 1).getTime()), outputTokens: 99, tps: 999 });
  const snapshot = { version: 1, status: 'ready', records: [...inRange, outside],
    summary: { requests: 5, outputTokens: { value: 99999, reported: 5 } }, sessions: [], retentionLimit: 5000 };
  const clone = JSON.parse(JSON.stringify(snapshot));
  const view = filteredMonitorView(snapshot, 'all', monitorDateRange('custom', { start: '2026-10-15', end: '2026-10-15' }));
  assert.equal(view.records.length, 4);
  assert.equal(view.summary.requests, 4);
  assert.equal(view.summary.outputTokens.value, 30, 'the outside record and the inconsistent row never count');
  assert.equal(view.summary.outputTokens.reported, 3);
  assert.equal(view.summary.excludedUsageRecords, 1);
  assert.equal(view.summary.throughputTps.value, 7.5, '30 tokens over 4000 ms of usable durations');
  assert.equal(view.summary.cancelled, 1);
  assert.equal(view.summary.error, 1);
  assert.equal(view.summary.tps.value, 25, 'a newer out-of-range sample cannot outrank the in-range latest');
  assert.deepEqual(view.attributionSummary, { assigned: 0, ambiguous: 0, noToolIds: 4, unmatchedToolIds: 0, lookupUnavailable: 0 });
  assert.deepEqual(snapshot, clone, 'the source snapshot is never mutated');
});

test('provider and model filters narrow the view before summarizing', () => {
  const iso = ms => new Date(ms).toISOString();
  const base = new Date(2026, 9, 15, 12).getTime();
  const record = extra => ({ schemaVersion: 3, model: 'm', providerId: 'ds', status: 'success', attribution: 'unassigned', attributionReason: 'no-tool-ids', startedAt: iso(base), outputTokens: 10, durationMs: 1000, ...extra });
  const snapshot = { version: 1, status: 'ready', retentionLimit: 5000, sessions: [], summary: {},
    records: [record({ id: 'a' }), record({ id: 'b', model: 'other' }), record({ id: 'c', providerId: 'ms' }), record({ id: 'd', providerId: '' })] };
  const all = monitorDateRange('all');
  assert.equal(filteredMonitorView(snapshot, 'all', all).records.length, 4);
  assert.deepEqual(filteredMonitorView(snapshot, 'all', all, { providerId: 'ms' }).records.map(r => r.id), ['c']);
  assert.deepEqual(filteredMonitorView(snapshot, 'all', all, { providerId: '__none__' }).records.map(r => r.id), ['d'],
    'records with no provider land in the unknown bucket');
  assert.deepEqual(filteredMonitorView(snapshot, 'all', all, { model: 'other' }).records.map(r => r.id), ['b']);
  assert.deepEqual(filteredMonitorView(snapshot, 'all', all, { providerId: 'ds', model: 'm' }).records.map(r => r.id), ['a'],
    'provider and model combine');
});

test('createMonitorStats returns the same pure helpers for browser injection', () => {
  const factory = eval('(' + createMonitorStats.toString() + ')');
  const injected = factory();
  assert.equal(typeof injected.monitorDateRange, 'function');
  assert.equal(typeof injected.filteredMonitorView, 'function');
  assert.equal(injected.monitorDateRange('this-month', { now: new Date(2026, 9, 13, 12).getTime() }).startDate, '2026-10-01');
});

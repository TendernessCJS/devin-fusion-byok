'use strict';
const fs = require('node:fs');
const { rootIdentity, controlFile } = require('../contract.cjs');
const { PORT } = require('../port.cjs');
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_HEALTH_BYTES = 4 * 1024 * 1024;
const COUNT_FIELDS = ['requests', 'success', 'error', 'cancelled', 'excludedUsageRecords'];
const METRIC_KEYS = ['inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens', 'ttftMs', 'textTtftMs', 'tps', 'throughputTps', 'firstResponseMs', 'gatewayTps'];
const METRIC_FIELDS = ['value', 'reported', 'samples'];
const RECORD_FIELDS = ['schemaVersion', 'id', 'startedAt', 'model', 'providerId', 'effort', 'status', 'code', 'httpStatus',
  'inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens', 'firstOutputMs', 'firstTextMs', 'firstResponseMs',
  'durationMs', 'outputSpanMs', 'tps', 'decodeMs', 'visibleTokens', 'hasTools', 'hasReasoning',
  'throughputTps', 'gatewayTps', 'usageState', 'usageComplete', 'sessionId', 'attribution'];
const ATTRIBUTION_REASONS = ['ambiguous-match', 'no-tool-ids', 'lookup-unavailable', 'tool-id-unmatched'];
const ATTRIBUTION_FIELDS = ['assigned', 'ambiguous', 'noToolIds', 'unmatchedToolIds', 'lookupUnavailable'];
const LOOKUP_STATUS_VALUES = { tools: ['ready', 'unavailable', 'not-needed'], labels: ['ready', 'unavailable', 'not-needed'] };
const STORAGE_CODES = ['load-too-large', 'load-invalid-record', 'load-unavailable', 'append-failed', 'compact-failed'];
const { withConnectionRetry } = require('./retry.cjs');
async function readOnce({ root, port, signal, request }) {
  const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000);
  const base = 'http://127.0.0.1:' + port;
  const read = async (url, headers, maximum) => {
    const response = await request(url, { signal: timeout, headers, redirect: 'error' });
    if (!response.ok) throw new Error('monitor_unavailable');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maximum) throw new Error('monitor_snapshot_too_large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const health = await read(base + '/health', undefined, MAX_HEALTH_BYTES);
  const expected = rootIdentity(root);
  if (health.service !== expected.service || health.rootId !== expected.rootId || !health.instanceId) throw new Error('monitor_identity');
  if (health.monitorProtocol !== 1) return { status: 'unsupported', snapshot: null };
  const control = JSON.parse(fs.readFileSync(controlFile(root), 'utf8'));
  if (control.rootId !== health.rootId || control.instanceId !== health.instanceId || control.sourceId !== health.sourceId || !/^[a-f0-9]{64}$/.test(control.token || '')) throw new Error('monitor_identity');
  const data = await read(base + '/_runtime/monitor', { authorization: 'Bearer ' + control.token }, MAX_SNAPSHOT_BYTES);
  if (data.instanceId !== health.instanceId) throw new Error('monitor_identity');
  if (!data.snapshot) return { status: 'unavailable', snapshot: null };
  return { status: 'ready', snapshot: publicSnapshot(data.snapshot) };
}
async function readMonitor({ root, port = PORT, signal, request = fetch }) {
  return withConnectionRetry(() => readOnce({ root, port, signal, request }), { signal });
}
function metricOf(metric) {
  if (!metric || typeof metric !== 'object' || Array.isArray(metric)) return null;
  const copy = {};
  for (const field of METRIC_FIELDS) if (metric[field] !== undefined) copy[field] = metric[field];
  return copy;
}
function summaryOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const summary = {};
  for (const field of COUNT_FIELDS) if (value[field] !== undefined) summary[field] = value[field];
  if (value.excludedUsageRecords !== undefined) summary.excludedUsageRecords = Number.isSafeInteger(value.excludedUsageRecords) && value.excludedUsageRecords >= 0 ? value.excludedUsageRecords : null;
  for (const field of METRIC_KEYS) if (value[field] !== undefined) summary[field] = metricOf(value[field]);
  return summary;
}
function recordOf(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const record = {};
  for (const field of RECORD_FIELDS) if (entry[field] !== undefined) record[field] = entry[field];
  if (entry.attributionReason !== undefined) record.attributionReason = ATTRIBUTION_REASONS.includes(entry.attributionReason) ? entry.attributionReason : null;
  return record;
}
function attributionSummaryOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!ATTRIBUTION_FIELDS.every(field => Number.isSafeInteger(value[field]) && value[field] >= 0)) return null;
  const summary = {};
  for (const field of ATTRIBUTION_FIELDS) summary[field] = value[field];
  return summary;
}
function lookupStatusOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = {};
  for (const [field, allowed] of Object.entries(LOOKUP_STATUS_VALUES)) status[field] = allowed.includes(value[field]) ? value[field] : null;
  return status;
}
function storageDiagnosticsOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Number.isSafeInteger(value.pendingWrites) || value.pendingWrites < 0 ||
      !Number.isSafeInteger(value.failedWrites) || value.failedWrites < 0 ||
      typeof value.persistenceBlocked !== 'boolean') return null;
  return { code: STORAGE_CODES.includes(value.code) ? value.code : null,
    pendingWrites: value.pendingWrites, failedWrites: value.failedWrites,
    persistenceBlocked: value.persistenceBlocked };
}
function sessionOf(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const summary = summaryOf(entry.summary);
  if (!summary || !Array.isArray(entry.records)) return null;
  return { sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : null,
    title: typeof entry.title === 'string' ? entry.title : null,
    lastActivityAt: Number.isSafeInteger(entry.lastActivityAt) ? entry.lastActivityAt : null,
    attribution: typeof entry.attribution === 'string' ? entry.attribution : 'unassigned',
    attributionSummary: attributionSummaryOf(entry.attributionSummary),
    summary, records: entry.records.map(recordOf).filter(Boolean) };
}
function publicSnapshot(snapshot) {
  const summary = summaryOf(snapshot.summary);
  if (snapshot.version !== 1 || typeof snapshot.status !== 'string' || !summary || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.sessions)) {
    throw new Error('monitor_invalid');
  }
  return { version: 1, status: snapshot.status, storageError: snapshot.storageError === true,
    sessionStatus: snapshot.sessionStatus === 'ready' ? 'ready' : 'unavailable',
    lookupStatus: lookupStatusOf(snapshot.lookupStatus),
    storageDiagnostics: storageDiagnosticsOf(snapshot.storageDiagnostics),
    attributionSummary: attributionSummaryOf(snapshot.attributionSummary),
    retentionLimit: Number.isSafeInteger(snapshot.retentionLimit) && snapshot.retentionLimit > 0 ? snapshot.retentionLimit : null,
    records: snapshot.records.map(recordOf).filter(Boolean), summary,
    sessions: snapshot.sessions.map(sessionOf).filter(Boolean) };
}
module.exports = { readMonitor, MAX_SNAPSHOT_BYTES, publicSnapshot };

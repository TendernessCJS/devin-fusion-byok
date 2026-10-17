'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const LIMIT = 5000;
const COMPACT_AT = LIMIT + 250;
const { token, timing, usageIsInconsistent, summarize, attributionStats, identifier } = require('./stats.cjs');
function normalize(record) {
  if (!identifier(record?.id) || !['success', 'error', 'cancelled'].includes(record.status) || !Number.isFinite(Date.parse(record.startedAt))) return null;
  const result = { id: record.id, startedAt: record.startedAt, model: identifier(record.model) || 'unknown',
    providerId: identifier(record.providerId) || '', effort: identifier(record.effort), status: record.status,
    code: identifier(record.code), httpStatus: token(record.httpStatus) ?? 0, usageComplete: record.usageComplete === true };
  // The stored record carries no `sessionId`/`attribution`/`messageIds`/`role`:
  // attribution is computed per snapshot by `associate`, so a placeholder here is
  // a claim nothing has verified. Every line of the real monitor.jsonl read
  // `"attribution":"unassigned","role":"unknown"` while the same records were
  // attributed to sessions in the panel, and `role` is read nowhere at all.
  for (const key of ['inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens']) result[key] = token(record[key]);
  for (const key of ['firstOutputMs', 'firstTextMs', 'durationMs', 'outputSpanMs']) result[key] = timing(record[key]);
  result.schemaVersion = [2, 3].includes(record.schemaVersion) ? record.schemaVersion : 1;
  result.toolIds = result.schemaVersion >= 2 && Array.isArray(record.toolIds) ? [...new Set(record.toolIds.map(identifier).filter(Boolean))].slice(-32) : [];
  result.hasTools = result.schemaVersion >= 2 && typeof record.hasTools === 'boolean' ? record.hasTools : null;
  result.hasReasoning = result.schemaVersion >= 2 && typeof record.hasReasoning === 'boolean' ? record.hasReasoning : null;
  if (result.schemaVersion >= 2 && result.reasoningTokens > 0) result.hasReasoning = true;
  result.decodeMs = result.schemaVersion >= 2 ? timing(record.decodeMs) : null;
  const inconsistent = usageIsInconsistent(result);
  result.visibleTokens = !inconsistent && result.schemaVersion >= 2 && result.outputTokens !== null &&
    (result.hasReasoning === false || result.reasoningTokens !== null) ? result.outputTokens - (result.reasoningTokens ?? 0) : null;
  result.tps = result.schemaVersion >= 2 && result.status === 'success' && result.hasTools === false && result.visibleTokens > 0 && result.decodeMs > 0 ? result.visibleTokens * 1000 / result.decodeMs : null;
  result.throughputTps = !inconsistent && result.outputTokens !== null && result.durationMs > 0 ? result.outputTokens * 1000 / result.durationMs : null;
  result.firstResponseMs = result.schemaVersion >= 3 ? timing(record.firstResponseMs) : null;
  result.usageState = inconsistent ? 'inconsistent' : result.inputTokens !== null && result.outputTokens !== null ? 'complete' :
    ['inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens'].some(key => result[key] !== null) ? 'partial' : 'missing';
  result.usageComplete = result.usageState === 'complete';
  result.gatewayTps = !inconsistent && result.outputTokens > 0 && result.firstResponseMs !== null && result.durationMs > result.firstResponseMs
    ? result.outputTokens * 1000 / (result.durationMs - result.firstResponseMs) : null;
  if (inconsistent) result.tps = null;
  return result;
}
const quote = value => "'" + value.replace(/'/g, "''") + "'";
const TOOL_LOOKUP_TIMEOUT_MS = 8000;

function lookupRows(databasePath, sql, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = execFile('/usr/bin/sqlite3', ['-readonly', '-json', databasePath], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
        if (error) { reject(new Error('session_lookup_unavailable')); return; }
        try { resolve(JSON.parse(stdout || '[]')); } catch { reject(new Error('session_lookup_invalid')); }
      });
    } catch { reject(new Error('session_lookup_unavailable')); return; }
    child.stdin.on('error', () => {});
    child.stdin.end(sql);
  });
}
// Attribution reads `tool_call_state` only. Its composite primary key
// `(session_id, tool_call_id)` makes the `tool_call_id IN (...)` probe a covering
// index scan (measured 58ms on a real 8.1 GB sessions.db). The `message_nodes`
// side was removed instead of kept as an opt-in: matching a response id against
// `json_extract(chat_message, '$.message_id')` has no index to use and took ~31s
// on the same database, so it could never finish inside any sane bound — the
// option only existed to be permanently off, which made `response-id`
// attribution and the `messageIds` it keyed on unreachable dead weight.
async function sessionMatches(databasePath, toolIds = []) {
  if (!toolIds.length) return { rows: [], tools: 'not-needed' };
  const tools = toolIds.map(quote).join(',') || "''";
  try {
    const rows = await lookupRows(databasePath, `.timeout 1000\nSELECT session_id, tool_call_id AS message_id FROM tool_call_state WHERE tool_call_id IN (${tools});\n`, TOOL_LOOKUP_TIMEOUT_MS);
    return { rows, tools: 'ready' };
  } catch { return { rows: [], tools: 'unavailable' }; }
}
// Labels are looked up per snapshot, never persisted: titles are user content
// and must not leak into monitor.jsonl. Any failure degrades to no labels.
async function sessionLabels(databasePath, ids) {
  if (!ids.length) return { labels: new Map(), status: 'not-needed' };
  const values = ids.map(quote).join(',');
  const sql = `.timeout 1000\nSELECT id, title, last_activity_at FROM sessions WHERE id IN (${values});\n`;
  const rows = await new Promise(resolve => {
    let child;
    try { child = execFile('/usr/bin/sqlite3', ['-readonly', '-json', databasePath], { timeout: 8000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      try { resolve(JSON.parse(stdout || '[]')); } catch { resolve(null); }
    }); } catch { resolve(null); return; }
    child.stdin.on('error', () => {});
    child.stdin.end(sql);
  });
  if (rows === null) return { labels: new Map(), status: 'unavailable' };
  const labels = new Map();
  for (const row of rows) {
    if (!identifier(row.id)) continue;
    const trimmed = typeof row.title === 'string' ? row.title.trim() : '';
    labels.set(row.id, { title: trimmed || null,
      lastActivityAt: Number.isSafeInteger(row.last_activity_at) ? row.last_activity_at : null });
  }
  return { labels, status: 'ready' };
}
// Attribution vocabulary, in order of what can be proven: a single session for
// the record's tool ids, several sessions (ambiguous, never guessed), or nothing.
function associate(records, rows, { toolLookupUnavailable = false } = {}) {
  const mapping = new Map();
  for (const row of rows) {
    if (!identifier(row.message_id) || !identifier(row.session_id)) continue;
    if (!mapping.has(row.message_id)) mapping.set(row.message_id, new Set());
    mapping.get(row.message_id).add(row.session_id);
  }
  return records.map(record => {
    const { toolIds, ...publicRecord } = record;
    const sessions = new Set((toolIds || []).flatMap(id => [...(mapping.get(id) || [])]));
    const sessionId = sessions.size === 1 ? [...sessions][0] : null;
    return { ...publicRecord, sessionId,
      attribution: sessionId ? 'tool-id' : sessions.size > 1 ? 'ambiguous' : 'unassigned',
      attributionReason: sessionId ? null : sessions.size > 1 ? 'ambiguous-match'
        : !(toolIds || []).length ? 'no-tool-ids'
        : toolLookupUnavailable ? 'lookup-unavailable' : 'tool-id-unmatched' };
  });
}
function createMonitor({ root, databasePath = path.join(os.homedir(), '.local/share/devin/cli/sessions.db') }) {
  const file = path.join(root, 'monitor.jsonl');
  let records = [], storageError = false, pending = null, cached = null, cachedAt = 0, revision = 0;
  let projectedCount = 0, loadFailed = false;
  let storageCode = null, pendingWrites = 0, failedWrites = 0;
  try {
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > 32 * 1024 * 1024) throw new Error('monitor_size');
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        projectedCount++;
        try { const record = normalize(JSON.parse(line)); if (record) records.push(record); else { storageError = true; storageCode = 'load-invalid-record'; } }
        catch { storageError = true; storageCode = 'load-invalid-record'; }
      }
      records = [...new Map(records.map(r => [r.id, r])).values()].slice(-LIMIT);
    }
  } catch (error) { storageError = true; loadFailed = true; storageCode = error?.message === 'monitor_size' ? 'load-too-large' : 'load-unavailable'; }
  let queue = Promise.resolve(), closed = false, closing = null;
  const enqueue = (job, code) => {
    if (loadFailed) return queue;
    pendingWrites++;
    queue = queue.then(job).catch(error => { storageError = true; failedWrites++; storageCode = error?.monitorOp === 'append' ? 'append-failed' : code; })
      .finally(() => { pendingWrites--; });
    return queue;
  };
  const compact = (snapshotRecords, fallbackLine) => enqueue(async () => {
    if (storageError) {
      if (fallbackLine === undefined) return;
      try {
        await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
        await fs.promises.appendFile(file, fallbackLine, { mode: 0o600 });
      } catch (error) { throw Object.assign(new Error('monitor_write_failed'), { monitorOp: 'append' }); }
      return;
    }
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = file + '.' + randomUUID() + '.tmp';
    let handle, created = false;
    try {
      handle = await fs.promises.open(temporary, 'wx', 0o600);
      created = true;
      await handle.writeFile(snapshotRecords.map(r => JSON.stringify(r)).join('\n') + '\n');
      await handle.close();
      handle = null;
      await fs.promises.rename(temporary, file);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (created) await fs.promises.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }, 'compact-failed');
  function record(data) {
    if (closed) return;
    const value = normalize(data);
    if (!value || records.some(r => r.id === value.id)) return;
    records.push(value); records = records.slice(-LIMIT); revision++;
    const line = JSON.stringify(value) + '\n';
    projectedCount++;
    if (projectedCount < COMPACT_AT) {
      enqueue(async () => {
        await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
        await fs.promises.appendFile(file, line, { mode: 0o600 });
      }, 'append-failed');
    } else {
      compact(records.slice(), line);
      projectedCount = LIMIT;
    }
  }
  function flush() { return queue; }
  function close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      await queue;
      if (!storageError && projectedCount > records.length) {
        await compact(records.slice());
        projectedCount = records.length;
      }
    })();
    return closing;
  }
  async function snapshot() {
    if (pending) return pending;
    if (cached && Date.now() - cachedAt < 15000 && cached.revision === revision && cached.value.storageError === storageError) return cached.value;
    const current = records.slice(), currentRevision = revision;
    pending = (async () => {
      await queue;
      let lookup = { rows: [], tools: 'not-needed' };
      try { lookup = await sessionMatches(databasePath, [...new Set(current.flatMap(r => r.toolIds || []))]); }
      catch { lookup = { rows: [], tools: 'unavailable' }; }
      const sessionStatus = lookup.tools === 'unavailable' ? 'unavailable' : 'ready';
      const publicRecords = associate(current, lookup.rows, { toolLookupUnavailable: lookup.tools === 'unavailable' }).reverse();
      const groups = new Map();
      for (const r of publicRecords) {
        const key = r.sessionId || '__unassigned__';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      let labels = new Map(), labelsStatus = 'ready';
      try { const labelResult = await sessionLabels(databasePath, [...groups.keys()].filter(key => key !== '__unassigned__')); labels = labelResult.labels; labelsStatus = labelResult.status; }
      catch { labelsStatus = 'unavailable'; }
      const sessions = [...groups.values()].map(list => {
        const sessionId = list[0].sessionId, label = sessionId ? labels.get(sessionId) : null;
        return { sessionId, title: label?.title ?? null, lastActivityAt: label?.lastActivityAt ?? null,
          attribution: sessionId ? 'tool-id' : 'unassigned',
          attributionSummary: attributionStats(list),
          summary: summarize(list), records: list };
      });
      // Mirror the official picker: most recent activity first, unlabeled and
      // unassigned buckets last.
      sessions.sort((a, b) => (a.sessionId === null) - (b.sessionId === null) ||
        (a.lastActivityAt === null) - (b.lastActivityAt === null) ||
        (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
      const value = { version: 1, status: storageError || sessionStatus !== 'ready' || labelsStatus === 'unavailable' ? 'degraded' : 'ready',
        storageError, sessionStatus,
        lookupStatus: { tools: lookup.tools, labels: labelsStatus },
        storageDiagnostics: { code: storageCode, pendingWrites, failedWrites, persistenceBlocked: loadFailed },
        attributionSummary: attributionStats(publicRecords),
        retentionLimit: LIMIT, records: publicRecords, summary: summarize(publicRecords), sessions };
      cached = { revision: currentRevision, value }; cachedAt = Date.now(); return value;
    })().finally(() => { pending = null; });
    return pending;
  }
  return { record, snapshot, flush, close };
}
module.exports = { createMonitor, summarize, associate, attributionStats };

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const LIMIT = 5000;
const COMPACT_AT = LIMIT + 250;
const token = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const timing = value => Number.isFinite(value) && value >= 0 ? value : null;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value) ? value : null;

function usageOf(data, chat) {
  const u = chat ? data?.usage : data?.response?.usage;
  if (!u || typeof u !== 'object') return null;
  return {
    inputTokens: token(chat ? u.prompt_tokens : u.input_tokens),
    outputTokens: token(chat ? u.completion_tokens : u.output_tokens),
    cachedTokens: token((chat ? u.prompt_tokens_details : u.input_tokens_details)?.cached_tokens ?? u.prompt_cache_hit_tokens),
    reasoningTokens: token((chat ? u.completion_tokens_details : u.output_tokens_details)?.reasoning_tokens)
  };
}
function semanticOutput(event, chat) {
  const d = event.data;
  if (!d) return { output: false, text: false };
  if (chat) {
    const delta = (d.choices || []).find(c => (c.index ?? 0) === 0)?.delta;
    const text = typeof delta?.content === 'string' && delta.content.length > 0;
    const thinking = [delta?.reasoning_content, delta?.reasoning].some(v => typeof v === 'string' && v.length > 0);
    const tool = delta?.tool_calls?.some(v => v.function?.name || v.function?.arguments);
    return { output: Boolean(text || thinking || tool), text };
  }
  const items = event.type === 'response.completed' ? d.response?.output || [] : event.type === 'response.output_item.done' ? [d.item] : [];
  const text = (event.type === 'response.output_text.delta' && typeof d.delta === 'string' && d.delta.length > 0) ||
    (event.type === 'response.output_text.done' && typeof d.text === 'string' && d.text.length > 0) ||
    items.some(item => item?.type === 'message' && item.content?.some(part => part.type === 'output_text' && part.text));
  const delta = ['response.reasoning.delta', 'response.reasoning_summary_text.delta', 'response.function_call_arguments.delta'].includes(event.type) && typeof d.delta === 'string' && d.delta.length > 0;
  const tool = (event.type === 'response.output_item.added' && d.item?.type === 'function_call' && Boolean(d.item.name || d.item.arguments)) ||
    items.some(item => item?.type === 'function_call' && (item.name || item.arguments));
  return { output: Boolean(text || delta || tool), text: Boolean(text) };
}
function createTracker({ id, request, route, provider, now = () => performance.now(), startedAt = new Date().toISOString() }) {
  const start = now();
  let firstOutput = null, firstText = null, firstResponse = null, lastOutput = null, usage = null, complete = false;
  let hasTools = false, hasReasoning = false, terminalAt = null;
  const toolIds = new Set();
  const rememberTool = id => { if (identifier(id)) toolIds.add(id); };
  return {
    event(event, chat) {
      const elapsed = now() - start;
      const data = event.data;
      if (data && event.type !== 'done') firstResponse ??= elapsed;
      const choices = chat ? data?.choices || [] : [];
      const choice = choices.find(c => (c.index ?? 0) === 0);
      const delta = choice?.delta;
      const items = chat ? [] : data?.response?.output || (data?.item ? [data.item] : []);
      if (delta?.tool_calls?.length || items.some(item => item?.type === 'function_call') || event.type?.startsWith('response.function_call_arguments.')) hasTools = true;
      for (const call of delta?.tool_calls || []) rememberTool(call.id);
      for (const item of items) if (item?.type === 'function_call') rememberTool(item.call_id || item.id);
      if (delta?.reasoning_content || delta?.reasoning || event.type?.startsWith('response.reasoning')) hasReasoning = true;
      if (choice?.finish_reason || ['response.completed', 'response.incomplete'].includes(event.type)) terminalAt ??= elapsed;
      const semantic = semanticOutput(event, chat);
      if (semantic.output) { firstOutput ??= elapsed; lastOutput = elapsed; }
      const textDelta = chat ? typeof delta?.content === 'string' && delta.content.length > 0 : event.type === 'response.output_text.delta' && typeof data?.delta === 'string' && data.delta.length > 0;
      if (textDelta) firstText ??= elapsed;
      const next = usageOf(event.data, chat);
      if (next) {
        usage = next;
        complete = usage.inputTokens !== null && usage.outputTokens !== null;
      }
    },
    finish(status, httpStatus, code = null) {
      const durationMs = Math.max(0, now() - start);
      const visibleTokens = usage?.outputTokens != null && (!hasReasoning || usage?.reasoningTokens != null)
        ? usage.outputTokens - (usage.reasoningTokens ?? 0) : null;
      const decodeMs = firstText !== null && terminalAt > firstText ? terminalAt - firstText : null;
      const tps = status === 'success' && !hasTools && visibleTokens > 0 && decodeMs > 0 ? visibleTokens * 1000 / decodeMs : null;
      return { schemaVersion: 3, firstResponseMs: firstResponse, id, startedAt, model: route.model, providerId: provider.id || route.providerId || '', effort: route.effort || null,
        status, code, httpStatus, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null,
        cachedTokens: usage?.cachedTokens ?? null, reasoningTokens: usage?.reasoningTokens ?? null,
        firstOutputMs: firstOutput, firstTextMs: firstText, durationMs,
        outputSpanMs: firstOutput !== null && lastOutput > firstOutput ? lastOutput - firstOutput : null,
        tps, decodeMs, visibleTokens, hasTools, hasReasoning,
        throughputTps: status === 'success' && complete && durationMs > 0 ? usage.outputTokens * 1000 / durationMs : null,
        toolIds: [...toolIds].slice(-32),
        usageComplete: complete, messageIds: [...new Set((request.messages || []).map(m => identifier(m.messageId)).filter(Boolean))].slice(-8),
        sessionId: null, attribution: 'unassigned', role: 'unknown' };
    }
  };
}
function normalize(record) {
  if (!identifier(record?.id) || !['success', 'error', 'cancelled'].includes(record.status) || !Number.isFinite(Date.parse(record.startedAt))) return null;
  const result = { id: record.id, startedAt: record.startedAt, model: identifier(record.model) || 'unknown',
    providerId: identifier(record.providerId) || '', effort: identifier(record.effort), status: record.status,
    code: identifier(record.code), httpStatus: token(record.httpStatus) ?? 0, usageComplete: record.usageComplete === true,
    messageIds: Array.isArray(record.messageIds) ? [...new Set(record.messageIds.map(identifier).filter(Boolean))].slice(-8) : [],
    sessionId: null, attribution: 'unassigned', role: 'unknown' };
  for (const key of ['inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens']) result[key] = token(record[key]);
  for (const key of ['firstOutputMs', 'firstTextMs', 'durationMs', 'outputSpanMs']) result[key] = timing(record[key]);
  result.schemaVersion = [2, 3].includes(record.schemaVersion) ? record.schemaVersion : 1;
  result.toolIds = result.schemaVersion >= 2 && Array.isArray(record.toolIds) ? [...new Set(record.toolIds.map(identifier).filter(Boolean))].slice(-32) : [];
  result.hasTools = result.schemaVersion >= 2 ? record.hasTools === true : null;
  result.hasReasoning = result.schemaVersion >= 2 ? record.hasReasoning === true : null;
  result.decodeMs = result.schemaVersion >= 2 ? timing(record.decodeMs) : null;
  result.visibleTokens = result.schemaVersion >= 2 ? token(record.visibleTokens) : null;
  result.tps = result.schemaVersion >= 2 && result.status === 'success' && result.hasTools === false && result.visibleTokens > 0 && result.decodeMs > 0 ? result.visibleTokens * 1000 / result.decodeMs : null;
  result.throughputTps = result.outputTokens !== null && result.durationMs > 0 ? result.outputTokens * 1000 / result.durationMs : null;
  result.firstResponseMs = result.schemaVersion >= 3 ? timing(record.firstResponseMs) : null;
  const inconsistent = (result.cachedTokens !== null && result.inputTokens !== null && result.cachedTokens > result.inputTokens) ||
    (result.reasoningTokens !== null && result.outputTokens !== null && result.reasoningTokens > result.outputTokens);
  result.usageState = inconsistent ? 'inconsistent' : result.inputTokens !== null && result.outputTokens !== null ? 'complete' :
    ['inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens'].some(key => result[key] !== null) ? 'partial' : 'missing';
  result.usageComplete = result.usageState === 'complete';
  result.gatewayTps = !inconsistent && result.outputTokens > 0 && result.firstResponseMs !== null && result.durationMs > result.firstResponseMs
    ? result.outputTokens * 1000 / (result.durationMs - result.firstResponseMs) : null;
  if (inconsistent) result.tps = null;
  return result;
}
function summarize(records) {
  const result = { requests: records.length, success: 0, error: 0, cancelled: 0 };
  for (const record of records) result[record.status]++;
  for (const key of ['inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens']) {
    const values = records.map(r => r[key]).filter(v => v !== null);
    result[key] = { value: values.length ? values.reduce((a, b) => a + b, 0) : null, reported: values.length };
  }
  for (const [key, field] of [['ttftMs', 'firstOutputMs'], ['textTtftMs', 'firstTextMs']]) {
    const values = records.filter(r => r.status === 'success' && r.schemaVersion >= 2).map(r => r[field]).filter(v => v !== null);
    result[key] = { value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, samples: values.length };
  }
  const eligible = records.filter(r => r.schemaVersion >= 2 && r.status === 'success' && timing(r.tps) !== null);
  const latest = eligible.reduce((a, b) => !a || Date.parse(b.startedAt) >= Date.parse(a.startedAt) ? b : a, null);
  result.tps = { value: latest?.tps ?? null, samples: eligible.length };
  const firstResponses = records.map(r => r.firstResponseMs).filter(v => timing(v) !== null);
  result.firstResponseMs = { value: firstResponses.length ? firstResponses.reduce((a, b) => a + b, 0) / firstResponses.length : null, samples: firstResponses.length };
  const gateway = records.filter(r => timing(r.gatewayTps) !== null && r.durationMs > r.firstResponseMs);
  const gatewayDuration = gateway.reduce((n, r) => n + r.durationMs - r.firstResponseMs, 0);
  result.gatewayTps = { value: gatewayDuration > 0 ? gateway.reduce((n, r) => n + r.outputTokens, 0) * 1000 / gatewayDuration : null, samples: gateway.length };
  const throughput = records.filter(r => r.outputTokens !== null && r.durationMs > 0);
  const duration = throughput.reduce((n, r) => n + r.durationMs, 0);
  result.throughputTps = { value: duration > 0 ? throughput.reduce((n, r) => n + r.outputTokens, 0) * 1000 / duration : null, samples: throughput.length };
  return result;
}
const quote = value => "'" + value.replace(/'/g, "''") + "'";
const TOOL_LOOKUP_TIMEOUT_MS = 8000;
// The message-id branch scans message_nodes without an index (json_extract in
// WHERE), so it is the expensive half. It runs as a bounded supplement: a
// timeout there must never discard the tool-id matches, which are indexed.
const MESSAGE_LOOKUP_TIMEOUT_MS = 1500;

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
async function sessionMatches(databasePath, ids, toolIds = []) {
  if (!ids.length && !toolIds.length) return [];
  const values = ids.map(quote).join(',') || "''";
  const tools = toolIds.map(quote).join(',') || "''";
  const rows = toolIds.length
    ? await lookupRows(databasePath, `.timeout 1000\nSELECT session_id, tool_call_id AS message_id, 'tool' AS kind FROM tool_call_state WHERE tool_call_id IN (${tools});\n`, TOOL_LOOKUP_TIMEOUT_MS)
    : [];
  if (ids.length) {
    try {
      rows.push(...await lookupRows(databasePath, `.timeout 1000\nSELECT DISTINCT session_id, json_extract(chat_message, '$.message_id') AS message_id, 'message' AS kind FROM message_nodes WHERE json_extract(chat_message, '$.message_id') IN (${values});\n`, MESSAGE_LOOKUP_TIMEOUT_MS));
    } catch { /* supplemental branch: its failure must not discard indexed matches */ }
  }
  return rows;
}
// Labels are looked up per snapshot, never persisted: titles are user content
// and must not leak into monitor.jsonl. Any failure degrades to no labels.
async function sessionLabels(databasePath, ids) {
  if (!ids.length) return new Map();
  const values = ids.map(quote).join(',');
  const sql = `.timeout 1000\nSELECT id, title, last_activity_at FROM sessions WHERE id IN (${values});\n`;
  const rows = await new Promise(resolve => {
    let child;
    try { child = execFile('/usr/bin/sqlite3', ['-readonly', '-json', databasePath], { timeout: 8000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve([]); return; }
      try { resolve(JSON.parse(stdout || '[]')); } catch { resolve([]); }
    }); } catch { resolve([]); return; }
    child.stdin.on('error', () => {});
    child.stdin.end(sql);
  });
  const labels = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!identifier(row.id)) continue;
    const trimmed = typeof row.title === 'string' ? row.title.trim() : '';
    labels.set(row.id, { title: trimmed || null,
      lastActivityAt: Number.isSafeInteger(row.last_activity_at) ? row.last_activity_at : null });
  }
  return labels;
}
function associate(records, rows) {
  const mapping = new Map();
  for (const row of rows) {
    if (!identifier(row.message_id) || !identifier(row.session_id)) continue;
    const key = (row.kind === 'tool' ? 'tool:' : 'message:') + row.message_id;
    if (!mapping.has(key)) mapping.set(key, new Set());
    mapping.get(key).add(row.session_id);
  }
  return records.map(record => {
    let sessions = mapping.get('message:' + record.id), attribution = 'response-id';
    if (!sessions?.size) {
      attribution = 'tool-id';
      sessions = new Set((record.toolIds || []).flatMap(id => [...(mapping.get('tool:' + id) || [])]));
    }
    const { messageIds, toolIds, ...publicRecord } = record;
    return { ...publicRecord, sessionId: sessions?.size === 1 ? [...sessions][0] : null,
      attribution: sessions?.size === 1 ? attribution : sessions?.size > 1 ? 'ambiguous' : 'unassigned' };
  });
}
function createMonitor({ root, databasePath = path.join(os.homedir(), '.local/share/devin/cli/sessions.db') }) {
  const file = path.join(root, 'monitor.jsonl');
  let records = [], storageError = false, pending = null, cached = null, cachedAt = 0, revision = 0;
  let projectedCount = 0, loadFailed = false;
  try {
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > 32 * 1024 * 1024) throw new Error('monitor_size');
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        projectedCount++;
        try { const record = normalize(JSON.parse(line)); if (record) records.push(record); else storageError = true; } catch { storageError = true; }
      }
      records = [...new Map(records.map(r => [r.id, r])).values()].slice(-LIMIT);
    }
  } catch { storageError = true; loadFailed = true; }
  let queue = Promise.resolve(), closed = false, closing = null;
  const enqueue = job => {
    if (loadFailed) return queue;
    queue = queue.then(job).catch(() => { storageError = true; });
    return queue;
  };
  const compact = (snapshotRecords, fallbackLine) => enqueue(async () => {
    if (storageError) {
      if (fallbackLine === undefined) return;
      await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.promises.appendFile(file, fallbackLine, { mode: 0o600 });
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
  });
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
      });
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
      let rows = [], sessionStatus = 'ready';
      try { rows = await sessionMatches(databasePath, current.map(r => r.id), [...new Set(current.flatMap(r => r.toolIds || []))]); }
      catch { sessionStatus = 'unavailable'; }
      const publicRecords = associate(current, rows).reverse();
      const groups = new Map();
      for (const r of publicRecords) {
        const key = r.sessionId || '__unassigned__';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      let labels = new Map();
      try { labels = await sessionLabels(databasePath, [...groups.keys()].filter(key => key !== '__unassigned__')); } catch {}
      const sessions = [...groups.values()].map(list => {
        const sessionId = list[0].sessionId, label = sessionId ? labels.get(sessionId) : null;
        return { sessionId, title: label?.title ?? null, lastActivityAt: label?.lastActivityAt ?? null,
          attribution: list.every(r => r.attribution === 'response-id') ? 'response-id' : sessionId ? 'tool-id' : 'unassigned',
          summary: summarize(list), records: list };
      });
      // Mirror the official picker: most recent activity first, unlabeled and
      // unassigned buckets last.
      sessions.sort((a, b) => (a.sessionId === null) - (b.sessionId === null) ||
        (a.lastActivityAt === null) - (b.lastActivityAt === null) ||
        (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
      const value = { version: 1, status: storageError || sessionStatus !== 'ready' ? 'degraded' : 'ready', storageError, sessionStatus,
        retentionLimit: LIMIT, records: publicRecords, summary: summarize(publicRecords), sessions };
      cached = { revision: currentRevision, value }; cachedAt = Date.now(); return value;
    })().finally(() => { pending = null; });
    return pending;
  }
  return { record, snapshot, flush, close };
}
module.exports = { createMonitor, createTracker, usageOf, semanticOutput, summarize, associate };

'use strict';
function createMonitorStats() {
  const token = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const timing = value => Number.isFinite(value) && value >= 0 ? value : null;
  const usageIsInconsistent = record => record?.usageState === 'inconsistent' ||
    (token(record?.cachedTokens) !== null && token(record?.inputTokens) !== null && record.cachedTokens > record.inputTokens) ||
    (token(record?.reasoningTokens) !== null && token(record?.outputTokens) !== null && record.reasoningTokens > record.outputTokens);
  function summarize(records) {
    const usable = records.filter(record => !usageIsInconsistent(record));
    const result = { requests: records.length, success: 0, error: 0, cancelled: 0, excludedUsageRecords: records.length - usable.length };
    for (const record of records) result[record.status]++;
    for (const key of ['inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens']) {
      const values = usable.map(r => token(r[key])).filter(v => v !== null);
      result[key] = { value: values.length ? values.reduce((a, b) => a + b, 0) : null, reported: values.length };
    }
    for (const [key, field] of [['ttftMs', 'firstOutputMs'], ['textTtftMs', 'firstTextMs']]) {
      const values = records.filter(r => r.status === 'success' && r.schemaVersion >= 2).map(r => timing(r[field])).filter(v => v !== null);
      result[key] = { value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, samples: values.length };
    }
    const eligible = usable.filter(r => r.schemaVersion >= 2 && r.status === 'success' && timing(r.tps) !== null);
    const latest = eligible.reduce((a, b) => !a || Date.parse(b.startedAt) >= Date.parse(a.startedAt) ? b : a, null);
    result.tps = { value: latest?.tps ?? null, samples: eligible.length };
    const firstResponses = records.map(r => timing(r.firstResponseMs)).filter(v => v !== null);
    result.firstResponseMs = { value: firstResponses.length ? firstResponses.reduce((a, b) => a + b, 0) / firstResponses.length : null, samples: firstResponses.length };
    const gateway = usable.filter(r => token(r.outputTokens) !== null && timing(r.gatewayTps) !== null && r.durationMs > r.firstResponseMs);
    const gatewayDuration = gateway.reduce((n, r) => n + r.durationMs - r.firstResponseMs, 0);
    result.gatewayTps = { value: gatewayDuration > 0 ? gateway.reduce((n, r) => n + r.outputTokens, 0) * 1000 / gatewayDuration : null, samples: gateway.length };
    const throughput = usable.filter(r => token(r.outputTokens) !== null && timing(r.durationMs) !== null && r.durationMs > 0);
    const duration = throughput.reduce((n, r) => n + r.durationMs, 0);
    result.throughputTps = { value: duration > 0 ? throughput.reduce((n, r) => n + r.outputTokens, 0) * 1000 / duration : null, samples: throughput.length };
    return result;
  }
  function attributionStats(records) {
    const counts = { assigned: 0, ambiguous: 0, noToolIds: 0, unmatchedToolIds: 0, lookupUnavailable: 0 };
    for (const record of records) {
      if (record.sessionId) counts.assigned++;
      else if (record.attribution === 'ambiguous') counts.ambiguous++;
      else if (record.attributionReason === 'no-tool-ids') counts.noToolIds++;
      else if (record.attributionReason === 'tool-id-unmatched') counts.unmatchedToolIds++;
      else if (record.attributionReason === 'lookup-unavailable') counts.lookupUnavailable++;
    }
    return counts;
  }
  const localDate = (year, month, day) => {
    const date = new Date(0);
    date.setFullYear(year, month, day);
    date.setHours(0, 0, 0, 0);
    return date;
  };
  const dateKey = date => String(date.getFullYear()).padStart(4, '0') + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  const parseLocalDate = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = localDate(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
  };
  function monitorDateRange(mode = 'this-month', { start = '', end = '', now = Date.now() } = {}) {
    const invalid = error => ({ from: null, to: null, startDate: '', endDate: '', error });
    if (mode === 'all') return { from: null, to: null, startDate: '', endDate: '', error: null };
    let from, to;
    if (mode === 'custom') {
      if (!start || !end) return invalid('请选择开始和结束日期。');
      from = parseLocalDate(start);
      const last = parseLocalDate(end);
      if (!from || !last) return invalid('日期无效，请选择有效的开始和结束日期。');
      if (from.getTime() > last.getTime()) return invalid('开始日期不能晚于结束日期。');
      to = localDate(last.getFullYear(), last.getMonth(), last.getDate() + 1);
    } else {
      const date = new Date(now);
      if (!Number.isFinite(date.getTime()) || date.getFullYear() < 1 || date.getFullYear() > 9999) return invalid('当前时间不可用，请检查系统时间。');
      const year = date.getFullYear(), month = date.getMonth(), day = date.getDate();
      if (mode === 'this-month') { from = localDate(year, month, 1); to = localDate(year, month + 1, 1); }
      else if (mode === 'last-month') { from = localDate(year, month - 1, 1); to = localDate(year, month, 1); }
      else if (mode === 'last-7-days') { from = localDate(year, month, day - 6); to = localDate(year, month, day + 1); }
      else return invalid('请选择有效的时间区间。');
    }
    const last = new Date(to.getTime());
    last.setDate(last.getDate() - 1);
    return { from: from.getTime(), to: to.getTime(), startDate: dateKey(from), endDate: dateKey(last), error: null };
  }
  function filterMonitorRecords(records, range) {
    if (range.error) return [];
    if (range.from === null && range.to === null) return records;
    return records.filter(record => {
      const startedAt = Date.parse(record.startedAt);
      return Number.isFinite(startedAt) && startedAt >= range.from && startedAt < range.to;
    });
  }
  function filteredMonitorView(snapshot, sessionId, range) {
    if (!snapshot || range.error) return null;
    const source = sessionId === 'all' ? snapshot : snapshot.sessions.find(session => (session.sessionId || '__unassigned__') === sessionId);
    if (!source) return null;
    const records = filterMonitorRecords(source.records, range);
    const all = range.from === null && range.to === null;
    const counts = attributionStats(records);
    const complete = Object.values(counts).reduce((sum, count) => sum + count, 0) === records.length;
    const originalCounts = source.attributionSummary;
    const fields = ['assigned', 'ambiguous', 'noToolIds', 'unmatchedToolIds', 'lookupUnavailable'];
    const originalComplete = originalCounts && fields.every(field => Number.isSafeInteger(originalCounts[field]) && originalCounts[field] >= 0) &&
      fields.reduce((sum, field) => sum + originalCounts[field], 0) === records.length;
    return { ...source, records, summary: summarize(records), attributionSummary: complete ? counts : all && originalComplete ? originalCounts : null };
  }
  return { token, timing, usageIsInconsistent, summarize, attributionStats, monitorDateRange, filterMonitorRecords, filteredMonitorView };
}
module.exports = { createMonitorStats, ...createMonitorStats() };

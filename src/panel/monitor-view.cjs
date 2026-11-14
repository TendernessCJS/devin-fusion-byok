'use strict';
const { createMonitorStats } = require('../monitor/stats.cjs');
const { markupText } = require('./dom.cjs');
const { translator, browserSource } = require('../i18n/index.cjs');
// Columns marked "extra" stay in the DOM but are hidden until "显示全部指标" is checked.
const COLUMNS = [['started'], ['model'], ['status'], ['usage', true], ['firstResponse'], ['gatewayTps'], ['input'], ['output'], ['cached', true], ['reasoning', true],
  ['firstOutput', true], ['firstText', true], ['textTps', true], ['throughput', true], ['duration'], ['attribution', true]];
function monitorMarkup(t = translator()) {
  const h = markupText(t);
  const head = COLUMNS.map(([key, extra]) => `<th${extra ? ' class="extra"' : ''}>${h('monitor.col.' + key)}</th>`).join('');
  return `<div id="usage-monitor"><div class="monitor-controls"><select id="monitor-session" aria-label="${h('monitor.sessionAria')}"><option value="all">${h('monitor.allSessions')}</option></select><select id="monitor-provider" aria-label="${h('monitor.providerAria')}"><option value="all">${h('monitor.allProviders')}</option></select><select id="monitor-model" aria-label="${h('monitor.modelAria')}"><option value="all">${h('monitor.allModels')}</option></select><select id="monitor-time-range" aria-label="${h('monitor.rangeAria')}"><option value="today">${h('monitor.range.today')}</option><option value="this-month">${h('monitor.range.thisMonth')}</option><option value="last-month">${h('monitor.range.lastMonth')}</option><option value="last-7-days">${h('monitor.range.last7')}</option><option value="all">${h('monitor.range.all')}</option><option value="custom">${h('monitor.range.custom')}</option></select><span id="monitor-date-controls" hidden><label for="monitor-date-start">${h('monitor.dateStart')} <input id="monitor-date-start" type="date" min="0001-01-01" max="9999-12-31"></label><label for="monitor-date-end">${h('monitor.dateEnd')} <input id="monitor-date-end" type="date" min="0001-01-01" max="9999-12-31"></label></span><button id="monitor-refresh" class="secondary" type="button">${h('common.refresh')}</button><span class="spacer"></span><label class="toggle hint"><input id="monitor-detail" type="checkbox">${h('monitor.detail')}</label></div><p id="monitor-status" class="warn mb" role="status">${h('monitor.loading')}</p><p id="monitor-diagnostics" class="hint mb" role="status" aria-live="polite" hidden></p><p id="monitor-range-error" class="warn mb" role="alert" hidden></p><p id="monitor-range-info" class="hint mb" role="status" hidden></p><div id="monitor-summary" class="tiles"></div><div id="monitor-table-wrap" class="monitor-table-wrap"><table class="monitor-table"><thead><tr>${head}</tr></thead><tbody id="monitor-requests"></tbody></table></div><div class="monitor-pager"><button id="monitor-prev" class="secondary" type="button">${h('monitor.prev')}</button><span id="monitor-page" class="hint" role="status"></span><button id="monitor-next" class="secondary" type="button">${h('monitor.next')}</button></div></div>`;
}
function monitorScript(locale) {
  return `
  (() => {
    ${browserSource(locale, ['common.', 'monitor.'])}
    const { monitorDateRange, filteredMonitorView } = (${createMonitorStats.toString()})();
    const PAGE_SIZE = 100;
    let snapshot = null, page = 0, rowsSignature = '', summarySignature = '', rangeKey = '', selectorSignature, providerSignature, modelSignature;
    let providerNames = new Map();
    const root = document.getElementById('usage-monitor');
    const selector = document.getElementById('monitor-session');
    const providerSel = document.getElementById('monitor-provider');
    const modelSel = document.getElementById('monitor-model');
    const status = document.getElementById('monitor-status');
    const diagnostics = document.getElementById('monitor-diagnostics');
    const timeRange = document.getElementById('monitor-time-range');
    const dateControls = document.getElementById('monitor-date-controls');
    const dateStart = document.getElementById('monitor-date-start');
    const dateEnd = document.getElementById('monitor-date-end');
    const rangeInfo = document.getElementById('monitor-range-info');
    const rangeError = document.getElementById('monitor-range-error');
    timeRange.value = 'this-month';
    const initialCustom = monitorDateRange('this-month');
    dateStart.value = initialCustom.startDate;
    dateEnd.value = initialCustom.endDate;
    const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return t('monitor.localZone'); } };
    let startedFormatter = null, formatterZone = null;
    const startTimeFormatter = zone => {
      if (formatterZone !== zone) { formatterZone = zone; startedFormatter = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
      return startedFormatter;
    };
    const currentRange = () => {
      const range = monitorDateRange(timeRange.value, { start: dateStart.value, end: dateEnd.value });
      const key = JSON.stringify([timeRange.value, range.from, range.to, range.error]);
      if (key !== rangeKey) { rangeKey = key; page = 0; }
      return range;
    };
    const summary = document.getElementById('monitor-summary');
    const rows = document.getElementById('monitor-requests');
    const tableWrap = document.getElementById('monitor-table-wrap');
    const detail = document.getElementById('monitor-detail');
    const prev = document.getElementById('monitor-prev');
    const next = document.getElementById('monitor-next');
    const pageLabel = document.getElementById('monitor-page');
    const EXTRA = ${JSON.stringify(COLUMNS.map(([, extra]) => !!extra))};
    const format = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
    const metricFormat = (key, value) => key.endsWith('Ms') && typeof value === 'number' && Number.isFinite(value) ? (value / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 }) : format(value);
    const attribution = value => ({ 'tool-id': t('monitor.attr.toolId'), ambiguous: t('monitor.attr.ambiguous'), unassigned: t('monitor.attr.unassigned') }[value] || t('common.unknown'));
    const attributionReason = value => ({ 'ambiguous-match': t('monitor.attr.ambiguous'), 'no-tool-ids': t('monitor.attr.noToolIds'), 'lookup-unavailable': t('monitor.attr.lookupUnavailable'), 'tool-id-unmatched': t('monitor.attr.unmatched') }[value]);
    const stateName = value => ({ success: t('monitor.state.success'), error: t('monitor.state.error'), cancelled: t('monitor.state.cancelled') }[value] || t('common.unknown'));
    const usageName = value => ({ complete: t('monitor.usage.complete'), partial: t('monitor.usage.partial'), missing: t('monitor.usage.missing'), inconsistent: t('monitor.usage.inconsistent') }[value] || '—');
    const ago = epoch => {
      if (!Number.isSafeInteger(epoch)) return '';
      const seconds = Math.floor(Date.now() / 1000) - epoch;
      if (seconds < 60) return t('monitor.ago.now');
      if (seconds < 3600) return t('monitor.ago.minutes', { count: Math.floor(seconds / 60) });
      if (seconds < 86400) return t('monitor.ago.hours', { count: Math.floor(seconds / 3600) });
      return t('monitor.ago.days', { count: Math.floor(seconds / 86400) });
    };
    const syncSelectorTitle = () => { const option = [...selector.options].find(o => o.value === selector.value); selector.title = option ? option.textContent : ''; };
    // [key, label, shown without detail]
    const METRICS = [['firstResponseMs',true],['gatewayTps',true],['inputTokens',true],['outputTokens',true],['cachedTokens',true],['reasoningTokens',false],['ttftMs',false],['textTtftMs',false],['tps',false],['throughputTps',false]].map(([key, basic]) => [key, t('monitor.metric.' + key), basic]);
    const FIELDS = ['firstResponseMs','gatewayTps','inputTokens','outputTokens','cachedTokens','reasoningTokens','firstOutputMs','firstTextMs','tps','throughputTps','durationMs'];
    const METRIC_TITLES = {
      firstResponseMs: t('monitor.metricTitle.firstResponseMs'),
      gatewayTps: t('monitor.metricTitle.gatewayTps'),
      throughputTps: t('monitor.metricTitle.throughputTps')
    };
    const metricTitle = (key, metric, requests) => {
      if (key === 'tps') return t('monitor.metricTitle.tps', { samples: metric?.samples ?? 0 });
      if (METRIC_TITLES[key]) return METRIC_TITLES[key];
      if (key === 'inputTokens' || key === 'outputTokens') return t('monitor.metricTitle.tokens', { reported: metric?.reported ?? 0, requests });
      if (key === 'cachedTokens' || key === 'reasoningTokens') return t('monitor.metricTitle.subsetTokens', { reported: metric?.reported ?? 0, requests });
      return t('monitor.metricTitle.basedOn', { reported: metric?.reported ?? metric?.samples ?? 0, requests });
    };
    function tile(value, label, title) {
      const node = document.createElement('div'); node.className = 'tile'; if (title) node.title = title;
      const v = document.createElement('span'); v.className = 'tile-value'; v.textContent = value;
      const l = document.createElement('span'); l.className = 'tile-label'; l.textContent = label;
      node.append(v); node.append(l); return node;
    }
    const syncOptions = (select, entries, allLabel) => {
      const previous = select.value;
      select.replaceChildren();
      const all = document.createElement('option'); all.value = 'all'; all.textContent = allLabel; all.title = allLabel; select.append(all);
      for (const [value, label] of entries) { const option = document.createElement('option'); option.value = value; option.textContent = label; option.title = label; select.append(option); }
      select.value = entries.some(([value]) => value === previous) ? previous : 'all';
    };
    const providerLabel = id => id === '__none__' ? t('monitor.unknownProvider') : (providerNames.get(id) || id);
    const syncProviderOptions = () => {
      const ids = [...new Set((snapshot?.records || []).map(r => r.providerId || '__none__'))];
      ids.sort((a, b) => providerLabel(a).localeCompare(providerLabel(b), 'zh'));
      const key = ids.map(id => id + '|' + providerLabel(id)).join('~');
      if (key !== providerSignature) { providerSignature = key; syncOptions(providerSel, ids.map(id => [id, providerLabel(id)]), t('monitor.allProviders')); }
    };
    const syncModelOptions = () => {
      const ids = [...new Set((snapshot?.records || [])
        .filter(r => providerSel.value === 'all' || (r.providerId || '__none__') === providerSel.value)
        .map(r => r.model).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'));
      const key = providerSel.value + '|' + ids.join('~');
      if (key !== modelSignature) { modelSignature = key; syncOptions(modelSel, ids.map(id => [id, id]), t('monitor.allModels')); }
    };
    function render() {
      syncSelectorTitle();
      const zone = localZone();
      const formatStarted = startTimeFormatter(zone);
      const range = currentRange();
      const selected = snapshot ? filteredMonitorView(snapshot, selector.value, range, { providerId: providerSel.value, model: modelSel.value }) : null;
      const s = selected?.summary;
      const summaryKey = s ? detail.checked + '|' + JSON.stringify(s) : '';
      if (summaryKey !== summarySignature) {
        summarySignature = summaryKey;
        summary.replaceChildren();
        if (s) {
          summary.append(tile(format(s.requests), t('monitor.requests') + (s.error ? ' · ' + t('monitor.requestsFailed', { count: s.error }) : '') + (s.cancelled ? ' · ' + t('monitor.requestsCancelled', { count: s.cancelled }) : ''), t('monitor.requestsTitle', { success: s.success, error: s.error, cancelled: s.cancelled })));
          for (const [key, label, basic] of METRICS) {
            if (!basic && !detail.checked) continue;
            const metric = s[key];
            summary.append(tile(metricFormat(key, metric?.value), label, metricTitle(key, metric, s.requests)));
          }
        }
      }
      const totalPages = selected ? Math.max(1, Math.ceil(selected.records.length / PAGE_SIZE)) : 1;
      if (page >= totalPages) page = totalPages - 1;
      if (page < 0) page = 0;
      const pageRecords = selected ? selected.records.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE) : [];
      let rowsKey = zone + '|' + page + '|' + JSON.stringify(pageRecords);
      if (!pageRecords.length) rowsKey += '|' + (range.error ? 'invalid' : range.from === null ? 'all' : 'range');
      if (rowsKey !== rowsSignature) {
        rowsSignature = rowsKey;
        // Replacing the tbody's children transiently collapses the table, and the
        // scroll container is the static wrapper: its scrollTop gets clamped to 0
        // and never comes back, so the user's scroll position dies on every
        // refresh that brings new records.
        const tableScroll = tableWrap ? tableWrap.scrollTop : 0;
        rows.replaceChildren();
        for (const r of pageRecords) {
          const row = document.createElement('tr');
          const startedAt = typeof r.startedAt === 'string' ? r.startedAt : String(r.startedAt ?? '');
          const parsed = Date.parse(startedAt);
          const values = [Number.isFinite(parsed) ? formatStarted.format(parsed) : (startedAt || '—'), r.model + (r.effort ? ' / ' + r.effort : ''), stateName(r.status), usageName(r.usageState), ...FIELDS.map(k => metricFormat(k, r[k])), attributionReason(r.attributionReason) || attribution(r.attribution)];
          values.forEach((value, index) => { const cell = document.createElement('td'); if (EXTRA[index]) cell.className = 'extra'; if (index === 0) cell.title = t('monitor.rawTime', { time: startedAt }); else { const key = FIELDS[index - 4]; if (key && METRIC_TITLES[key]) cell.title = METRIC_TITLES[key]; } cell.textContent = value; row.append(cell); });
          row.title = t('monitor.requestId', { id: r.id }) + (r.code ? ' · ' + r.code : ''); rows.append(row);
        }
        if (!pageRecords.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = EXTRA.length; cell.className = 'hint'; cell.textContent = range.error ? t('monitor.fixRange') : range.from === null ? t('monitor.noRecords') : t('monitor.noRecordsInRange'); row.append(cell); rows.append(row); }
        if (tableWrap) tableWrap.scrollTop = tableScroll;
      }
      pageLabel.textContent = selected ? t('monitor.page', { page: page + 1, pages: totalPages, count: selected.records.length }) : '';
      prev.disabled = !selected || page === 0;
      next.disabled = !selected || page >= totalPages - 1;
      const lines = [];
      if (snapshot && selected) {
        lines.push(Number.isSafeInteger(snapshot.retentionLimit) ? t('monitor.window', { limit: snapshot.retentionLimit, count: selected.records.length }) : t('monitor.retained', { count: selected.records.length }));
        const counts = selected.attributionSummary;
        if (counts && [counts.assigned, counts.ambiguous, counts.noToolIds, counts.unmatchedToolIds, counts.lookupUnavailable].every(value => Number.isSafeInteger(value) && value >= 0)) {
          lines.push(t('monitor.attrSummary', { assigned: counts.assigned, noToolIds: counts.noToolIds, unmatched: counts.unmatchedToolIds, ambiguous: counts.ambiguous, unavailable: counts.lookupUnavailable }));
        }
        if (s.excludedUsageRecords > 0) lines.push(t('monitor.excluded', { count: s.excludedUsageRecords }));
      }
      const diagnosticsText = lines.join('\\n');
      if (diagnostics.textContent !== diagnosticsText) diagnostics.textContent = diagnosticsText;
      diagnostics.hidden = !lines.length;
      // stats.cjs reports a code; an unknown one is shown as is rather than hidden.
      const errorText = range.error ? (Object.prototype.hasOwnProperty.call(I18N, 'monitor.' + range.error) ? t('monitor.' + range.error) : range.error) : '';
      if (rangeError.textContent !== errorText) rangeError.textContent = errorText;
      rangeError.hidden = !errorText;
      const infoText = !snapshot ? '' : (range.error ? '' :
        (range.from === null ? t('monitor.range.all') : t('monitor.rangeSpan', { start: range.startDate, end: range.endDate })) +
        t('monitor.rangeNote', { zone }));
      if (rangeInfo.textContent !== infoText) rangeInfo.textContent = infoText;
      rangeInfo.hidden = !infoText;
    }
    selector.addEventListener('change', () => { page = 0; render(); });
    providerSel.addEventListener('change', () => { page = 0; syncModelOptions(); render(); });
    modelSel.addEventListener('change', () => { page = 0; render(); });
    timeRange.addEventListener('change', () => { dateControls.hidden = timeRange.value !== 'custom'; render(); });
    dateStart.addEventListener('change', render);
    dateEnd.addEventListener('change', render);
    prev.addEventListener('click', () => { page--; render(); });
    next.addEventListener('click', () => { page++; render(); });
    detail.addEventListener('change', () => { root.classList.toggle('detailed', detail.checked); render(); });
    document.getElementById('monitor-refresh').addEventListener('click', () => vscode.postMessage({ id: 'monitor-refresh', type: 'monitor.refresh' }));
    window.addEventListener('message', event => {
      if (event.data?.type !== 'monitor-state') return;
      const result = event.data.result;
      snapshot = result?.snapshot || null;
      providerNames = new Map((result?.providers || []).map(p => [p?.id, p?.name]).filter(([id]) => typeof id === 'string' && id));
      const warnings = [];
      if (!snapshot) warnings.push(result?.status === 'unsupported' ? t('monitor.unsupported') : t('monitor.unavailable'));
      else {
        if (snapshot.storageError) {
          const codes = {
            'load-too-large': t('monitor.storage.loadTooLarge'),
            'load-invalid-record': t('monitor.storage.loadInvalidRecord'),
            'load-unavailable': t('monitor.storage.loadUnavailable'),
            'append-failed': t('monitor.storage.appendFailed'),
            'compact-failed': t('monitor.storage.compactFailed')
          };
          warnings.push(codes[snapshot.storageDiagnostics?.code] || t('monitor.storage.generic'));
          const diagnosticsCounts = snapshot.storageDiagnostics;
          if (diagnosticsCounts && diagnosticsCounts.failedWrites > 0) warnings.push(t('monitor.storage.failedWrites', { count: diagnosticsCounts.failedWrites }));
          if (diagnosticsCounts && diagnosticsCounts.pendingWrites > 0) warnings.push(t('monitor.storage.pendingWrites', { count: diagnosticsCounts.pendingWrites }));
        }
        if (snapshot.sessionStatus !== 'ready') warnings.push(t('monitor.lookupUnavailable'));
        if (snapshot.lookupStatus?.labels === 'unavailable') warnings.push(t('monitor.titlesUnavailable'));
      }
      status.textContent = warnings.join(' ');
      status.hidden = !status.textContent;
      const selectorKey = (snapshot?.sessions || []).map(session =>
        (session.sessionId || '__unassigned__') + '|' + (session.title || '') + '|' + ago(session.lastActivityAt)).join('~');
      if (selectorKey !== selectorSignature) {
        selectorSignature = selectorKey;
        const previous = selector.value; selector.replaceChildren();
        const all = document.createElement('option'); all.value = 'all'; all.textContent = t('monitor.allSessions'); all.title = all.textContent; selector.append(all);
        for (const session of snapshot?.sessions || []) {
          const option = document.createElement('option');
          option.value = session.sessionId || '__unassigned__';
          if (!session.sessionId) { option.textContent = t('monitor.unassignedSessions'); option.title = option.textContent; selector.append(option); continue; }
          const parts = [session.title || session.sessionId];
          const time = ago(session.lastActivityAt);
          if (time) parts.push(time);
          option.textContent = parts.join(' · ');
          option.title = option.textContent;
          selector.append(option);
        }
        if ([...selector.options].some(o => o.value === previous)) selector.value = previous;
      }
      syncSelectorTitle();
      syncProviderOptions();
      syncModelOptions();
      render();
    });
  })();`;
}
module.exports = { monitorMarkup, monitorScript };

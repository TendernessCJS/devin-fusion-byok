'use strict';
const { createMonitorStats } = require('../runtime/monitor-stats.cjs');
// Columns marked "extra" stay in the DOM but are hidden until "显示全部指标" is checked.
const COLUMNS = [['开始时间（本机）'], ['模型／档位'], ['状态'], ['用量', true], ['首数据事件 s'], ['首数据后 TPS'], ['输入'], ['输出'], ['缓存命中', true], ['推理', true],
  ['首输出 s', true], ['正文首字 s', true], ['正文 TPS', true], ['请求吞吐 TPS', true], ['总耗时 s'], ['会话关联', true]];
function monitorMarkup() {
  const head = COLUMNS.map(([label, extra]) => `<th${extra ? ' class="extra"' : ''}>${label}</th>`).join('');
  return `<div id="usage-monitor"><div class="monitor-controls"><select id="monitor-session" aria-label="选择会话"><option value="all">全部会话</option></select><select id="monitor-time-range" aria-label="时间区间"><option value="this-month">当月</option><option value="last-month">上月</option><option value="last-7-days">最近 7 天</option><option value="all">全部保留记录</option><option value="custom">自定义</option></select><span id="monitor-date-controls" hidden><label for="monitor-date-start">开始日期 <input id="monitor-date-start" type="date" min="0001-01-01" max="9999-12-31"></label><label for="monitor-date-end">结束日期 <input id="monitor-date-end" type="date" min="0001-01-01" max="9999-12-31"></label></span><button id="monitor-refresh" class="secondary" type="button">刷新</button><span class="spacer"></span><label class="toggle hint"><input id="monitor-detail" type="checkbox">显示全部指标</label></div><p id="monitor-status" class="warn mb" role="status">正在读取…</p><p id="monitor-diagnostics" class="hint mb" role="status" aria-live="polite" hidden></p><p id="monitor-range-error" class="warn mb" role="alert" hidden></p><p id="monitor-range-info" class="hint mb" role="status" hidden></p><div id="monitor-summary" class="tiles"></div><div id="monitor-table-wrap" class="monitor-table-wrap"><table class="monitor-table"><thead><tr>${head}</tr></thead><tbody id="monitor-requests"></tbody></table></div><div class="monitor-pager"><button id="monitor-prev" class="secondary" type="button">上一页</button><span id="monitor-page" class="hint" role="status"></span><button id="monitor-next" class="secondary" type="button">下一页</button></div></div>`;
}
function monitorScript() {
  return `
  (() => {
    const { monitorDateRange, filteredMonitorView } = (${createMonitorStats.toString()})();
    const PAGE_SIZE = 100;
    let snapshot = null, page = 0, rowsSignature = '', summarySignature = '', rangeKey = '', selectorSignature;
    const root = document.getElementById('usage-monitor');
    const selector = document.getElementById('monitor-session');
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
    const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return '本机时区'; } };
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
    const attribution = value => ({ 'response-id': '输出 ID 确认', 'tool-id': '本次工具 ID 确认', ambiguous: '存在歧义', unassigned: '未归属' }[value] || '未知');
    const attributionReason = value => ({ 'ambiguous-match': '存在歧义', 'no-tool-ids': '无可用工具 ID', 'lookup-unavailable': '归属查询不可用', 'tool-id-unmatched': '工具状态未匹配' }[value]);
    const stateName = value => ({ success: '成功', error: '失败', cancelled: '已取消' }[value] || '未知');
    const usageName = value => ({ complete: '完整', partial: '不完整', missing: '未上报', inconsistent: '数据异常' }[value] || '—');
    const ago = epoch => {
      if (!Number.isSafeInteger(epoch)) return '';
      const seconds = Math.floor(Date.now() / 1000) - epoch;
      if (seconds < 60) return '刚刚';
      if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前';
      if (seconds < 86400) return Math.floor(seconds / 3600) + ' 小时前';
      return Math.floor(seconds / 86400) + ' 天前';
    };
    const syncSelectorTitle = () => { const option = [...selector.options].find(o => o.value === selector.value); selector.title = option ? option.textContent : ''; };
    // [key, label, shown without detail]
    const METRICS = [['firstResponseMs','平均首数据事件 s',true],['gatewayTps','首数据后吞吐 TPS',true],['inputTokens','输入 token',true],['outputTokens','输出 token',true],['cachedTokens','缓存命中 token',true],['reasoningTokens','推理 token',false],['ttftMs','平均首输出 s',false],['textTtftMs','平均正文首字 s',false],['tps','最近有效正文 TPS',false],['throughputTps','请求吞吐 TPS（含等待）',false]];
    const FIELDS = ['firstResponseMs','gatewayTps','inputTokens','outputTokens','cachedTokens','reasoningTokens','firstOutputMs','firstTextMs','tps','throughputTps','durationMs'];
    const METRIC_TITLES = {
      firstResponseMs: '从请求开始到首个进入监控的 SSE 数据事件，不是 HTTP 响应头时间；包含成功、失败与取消请求的有效时间样本。',
      gatewayTps: '全部有效输出 token ÷ 首数据事件到请求结束的时间；包含推理和工具，并包含失败/取消的有效已上报用量。',
      throughputTps: '全部有效输出 token ÷ 总请求耗时，包含等待；包含失败/取消的有效已上报用量。'
    };
    const metricTitle = (key, metric, requests) => {
      if (key === 'tps') return '最近一条有效成功样本的正文 TPS，不是平均值；含工具或已知 reasoning 分项不明时不计算。保留记录中有 ' + (metric?.samples ?? 0) + ' 条有效样本。';
      if (METRIC_TITLES[key]) return METRIC_TITLES[key];
      if (key === 'inputTokens' || key === 'outputTokens') return '基于 ' + (metric?.reported ?? 0) + '/' + requests + ' 次请求；异常用量记录已从汇总排除。';
      if (key === 'cachedTokens' || key === 'reasoningTokens') return '基于 ' + (metric?.reported ?? 0) + '/' + requests + ' 次请求；异常用量记录已从汇总排除；数值是输入/输出 token 的子集，不重复计入总量。';
      return '基于 ' + (metric?.reported ?? metric?.samples ?? 0) + '/' + requests + ' 次请求';
    };
    function tile(value, label, title) {
      const node = document.createElement('div'); node.className = 'tile'; if (title) node.title = title;
      const v = document.createElement('span'); v.className = 'tile-value'; v.textContent = value;
      const l = document.createElement('span'); l.className = 'tile-label'; l.textContent = label;
      node.append(v); node.append(l); return node;
    }
    function render() {
      syncSelectorTitle();
      const zone = localZone();
      const formatStarted = startTimeFormatter(zone);
      const range = currentRange();
      const selected = snapshot ? filteredMonitorView(snapshot, selector.value, range) : null;
      const s = selected?.summary;
      const summaryKey = s ? detail.checked + '|' + JSON.stringify(s) : '';
      if (summaryKey !== summarySignature) {
        summarySignature = summaryKey;
        summary.replaceChildren();
        if (s) {
          summary.append(tile(format(s.requests), '请求' + (s.error ? ' · 失败 ' + s.error : '') + (s.cancelled ? ' · 取消 ' + s.cancelled : ''), '成功 ' + s.success + ' · 失败 ' + s.error + ' · 取消 ' + s.cancelled));
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
          values.forEach((value, index) => { const cell = document.createElement('td'); if (EXTRA[index]) cell.className = 'extra'; if (index === 0) cell.title = '原始时间：' + startedAt; else { const key = FIELDS[index - 4]; if (key && METRIC_TITLES[key]) cell.title = METRIC_TITLES[key]; } cell.textContent = value; row.append(cell); });
          row.title = '请求 ID：' + r.id + (r.code ? ' · ' + r.code : ''); rows.append(row);
        }
        if (!pageRecords.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = EXTRA.length; cell.className = 'hint'; cell.textContent = range.error ? '请修正时间区间后查看用量。' : range.from === null ? '还没有请求记录。' : '所选时间区间内暂无保留记录。'; row.append(cell); rows.append(row); }
        if (tableWrap) tableWrap.scrollTop = tableScroll;
      }
      pageLabel.textContent = selected ? '第 ' + (page + 1) + ' / ' + totalPages + ' 页 · 共 ' + selected.records.length + ' 条' : '';
      prev.disabled = !selected || page === 0;
      next.disabled = !selected || page >= totalPages - 1;
      const lines = [];
      if (snapshot && selected) {
        lines.push(Number.isSafeInteger(snapshot.retentionLimit) ? '统计窗口：最近 ' + snapshot.retentionLimit + ' 条（当前 ' + selected.records.length + ' 条）' : '当前保留 ' + selected.records.length + ' 条');
        const counts = selected.attributionSummary;
        if (counts && [counts.assigned, counts.ambiguous, counts.noToolIds, counts.unmatchedToolIds, counts.lookupUnavailable].every(value => Number.isSafeInteger(value) && value >= 0)) {
          lines.push('归属：已确认 ' + counts.assigned + ' · 无可用工具 ID ' + counts.noToolIds + ' · 工具状态未匹配 ' + counts.unmatchedToolIds + ' · 歧义 ' + counts.ambiguous + ' · 查询不可用 ' + counts.lookupUnavailable);
        }
        if (s.excludedUsageRecords > 0) lines.push('已从用量与吞吐汇总排除 ' + s.excludedUsageRecords + ' 条异常记录（仍计入请求数和时间指标）');
        const messages = snapshot.lookupStatus?.messages;
        if (messages === 'disabled') lines.push('消息 UUID 补查默认关闭');
        else if (messages === 'unavailable') lines.push('诊断消息补查失败（未影响工具归属）');
      }
      const diagnosticsText = lines.join('\\n');
      if (diagnostics.textContent !== diagnosticsText) diagnostics.textContent = diagnosticsText;
      diagnostics.hidden = !lines.length;
      const errorText = range.error ? range.error : '';
      if (rangeError.textContent !== errorText) rangeError.textContent = errorText;
      rangeError.hidden = !errorText;
      const infoText = !snapshot ? '' : (range.error ? '' :
        (range.from === null ? '全部保留记录' : '选定日期范围 ' + range.startDate + ' 至 ' + range.endDate) +
        '；按请求开始时间统计；本机时区（' + zone + '）。仅基于本地保留记录，可能不完整，非供应商账单。');
      if (rangeInfo.textContent !== infoText) rangeInfo.textContent = infoText;
      rangeInfo.hidden = !infoText;
    }
    selector.addEventListener('change', () => { page = 0; render(); });
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
      const warnings = [];
      if (!snapshot) warnings.push(result?.status === 'unsupported' ? '用量统计未启用。' : '用量统计暂不可用。');
      else {
        if (snapshot.storageError) {
          const codes = {
            'load-too-large': '监控日志超过读取上限，原日志保留，本轮未继续落盘。请先备份再人工处理。',
            'load-invalid-record': '监控日志含无法解析的记录，已保留原日志并停止自动压缩。',
            'load-unavailable': '监控日志读取失败，原日志保留，本轮未继续落盘。请检查文件访问权限。',
            'append-failed': '监控记录追加失败，部分数据可能仅在内存中。请检查磁盘空间和权限。',
            'compact-failed': '监控日志压缩失败，原日志保留。请检查磁盘空间和权限。'
          };
          warnings.push(codes[snapshot.storageDiagnostics?.code] || '统计存储异常。');
          const diagnosticsCounts = snapshot.storageDiagnostics;
          if (diagnosticsCounts && diagnosticsCounts.failedWrites > 0) warnings.push('写入失败 ' + diagnosticsCounts.failedWrites + ' 次');
          if (diagnosticsCounts && diagnosticsCounts.pendingWrites > 0) warnings.push('待写 ' + diagnosticsCounts.pendingWrites + ' 次');
        }
        if (snapshot.sessionStatus !== 'ready') warnings.push('工具归属查询暂不可用，统计用量仍可查看。');
        if (snapshot.lookupStatus?.labels === 'unavailable') warnings.push('会话标题读取失败，暂显示会话 ID。');
      }
      status.textContent = warnings.join(' ');
      status.hidden = !status.textContent;
      const selectorKey = (snapshot?.sessions || []).map(session =>
        (session.sessionId || '__unassigned__') + '|' + (session.title || '') + '|' + ago(session.lastActivityAt)).join('~');
      if (selectorKey !== selectorSignature) {
        selectorSignature = selectorKey;
        const previous = selector.value; selector.replaceChildren();
        const all = document.createElement('option'); all.value = 'all'; all.textContent = '全部会话'; all.title = all.textContent; selector.append(all);
        for (const session of snapshot?.sessions || []) {
          const option = document.createElement('option');
          option.value = session.sessionId || '__unassigned__';
          if (!session.sessionId) { option.textContent = '未归属／有歧义'; option.title = option.textContent; selector.append(option); continue; }
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
      render();
    });
  })();`;
}
module.exports = { monitorMarkup, monitorScript };

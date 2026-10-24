'use strict';
const { updateMarkup } = require('./update-view.cjs');

function pageMarkup() {
  return `
      <div id="settings-general"></div>
      <details id="native-group" class="group"><summary>官方模型显示<span id="native-count" class="hint"></span></summary><div class="group-body" id="native-models"></div></details>
      <details id="cache-group" class="group"><summary>CLI 缓存<span id="cache-hint" class="hint"></span></summary><div class="group-body">
        <p class="hint mb">缓存按账号身份区分，存于 <code class="cmd">~/.cache/devin/cli</code>。下拉少条目或有已删模型时点「刷新缓存」原地重写：原件另存 <code class="cmd">.bak</code>（只留最近一份），主文件不改名、不删除。「刷新模型目录」重新提交给桌面端，以原生确认为准。</p>
        <div class="cache-toolbar">
          <button id="refresh-cache" type="button">刷新缓存</button>
          <button id="refresh-desktop-catalog" type="button" class="secondary">刷新模型目录</button>
        </div>
        <p class="hint" id="cache-report"></p>
      </div></details>
      ${updateMarkup()}`;
}

function createSettingsView(ui) {
  const { selection, request, run, element, byId, button, switchInput, focusTargets, scrollTargets } = ui;
  const state = () => ui.state();
  const off = ui.off;

  function renderSettings() {
    const container = byId('settings-general');
    container.replaceChildren();
    const backendText = { starting: '启动中', running: '运行中', stopped: '已停止' }[state().backendStatus]
      || `异常（${state().backendStatus || '未知'}）`;
    const catalogText = { ready: '已同步', loading: '同步中', empty: '未同步' }[state().nativeCatalogStatus]
      || `异常（${state().nativeCatalogStatus || '未知'}）`;
    container.append(element('p', { class: 'hint', text: `运行状态：后台服务 ${backendText} · 官方目录 ${catalogText}` }));
    const health = state().health;
    if (health && Array.isArray(health.items)) {
      container.append(element('p', { class: 'hint',
        text: `注入健康：${health.items.map(item => `${item.label} ${({ ok: '✓', bad: '✗', unknown: '待验证' })[item.state]}`).join(' · ')}` }));
      if (health.ok === false) {
        const hints = health.items.filter(item => item.state === 'bad' && item.hint).map(item => item.hint).join(' ');
        if (hints) container.append(element('p', { class: 'warn mt', text: hints }));
      }
    }
    const setting = (title, sub, control) => element('div', { class: 'setting' },
      element('div', { class: 'row-main' }, element('span', { class: 'row-title', text: title }), sub ? element('span', { class: 'row-sub', text: sub }) : null), control);
    const status = state().autoContinueStatus === 'attached' ? null
      : state().autoContinueStatus === 'waiting' ? '还没连上会话：重新加载窗口并新建对话后生效。'
      : '自动继续当前不可用，请在「输出」面板的 Devin Fusion BYOK 通道查看日志。';
    // The auto-continue card is rebuilt on every state push, so it cannot be a
    // <details>: the open flag would reset. The heading lives inside the card
    // instead, keeping title, switches and warning one visual unit.
    container.append(element('div', { class: 'list mt' },
      element('div', { class: 'list-head', text: '自动继续' }),
      setting('服务商出错时自动重试', '临时错误打断回复时自动发送 continue。按量计费的服务商可能多扣费。',
        switchInput(state().autoContinueOnProviderError === true, '服务商出错时自动重试',
          value => run(() => request('setAutoContinue', { enabled: value })), off())),
      setting('待办没做完时自动继续', '会话里还有未完成的 Plan 时自动推进，随时可以手动停止。',
        switchInput(state().autoContinueUntilPlanComplete === true, '待办没做完时自动继续',
          value => run(() => request('setAutoContinueUntilPlanComplete', { enabled: value })), off())),
      status ? element('p', { class: 'warn list-note', text: status }) : null));
  }

  function renderNative() {
    const container = byId('native-models');
    container.replaceChildren();
    const all = state().nativeFamilies || [];
    const visible = all.filter(family => !family.hidden && !family.internal).length;
    const hiddenCount = all.filter(family => family.hidden).length;
    const internalCount = all.filter(family => family.internal).length;
    byId('native-count').textContent = all.length
      ? visible + ' / ' + all.length + ' 个系列' + (hiddenCount ? ' · 已隐藏 ' + hiddenCount : '') + (internalCount ? ' · 内部 ' + internalCount : '') : '';
    const search = element('input', { type: 'search', placeholder: '搜索官方模型', 'aria-label': '搜索官方模型',
      oninput: event => { selection.nativeSearch = event.target.value; renderNativeRows(); } });
    search.value = selection.nativeSearch;
    focusTargets.set('native-search', search);
    const list = element('div', { id: 'native-list', class: 'list scroll', 'aria-label': '官方模型列表' });
    scrollTargets.set('native-list', list);
    container.append(element('p', { class: 'hint mb', text: '停用的系列会从 Devin 模型列表隐藏，也不再出现在「Fusion」页候选中；仅本机生效，不影响账号。' }),
      element('div', { class: 'toolbar' }, search, button('刷新', () => run(() => request('refreshNativeModels'), '正在同步官方模型…', '已同步。'))),
      list);
    renderNativeRows();
  }

  function renderNativeRows() {
    const container = byId('native-list');
    if (!container) return;
    container.replaceChildren();
    const all = state().nativeFamilies || [];
    const query = selection.nativeSearch.trim().toLocaleLowerCase();
    const families = all.filter(family => !query ||
      (family.label + ' ' + (family.vendor || '') + ' ' + family.members.map(member => member.uid + ' ' + member.label).join(' ')).toLocaleLowerCase().includes(query));
    if (!families.length) {
      container.append(element('div', { class: 'empty', text: all.length ? '没有匹配的模型。' : ({ loading: '正在同步官方模型…', unsupported: '当前后台版本暂不支持同步。', unavailable: '无法连接插件本地服务，请点刷新重试。', empty: '还没收到官方模型，打开一次 Devin 的模型选择器后再刷新。' }[state().nativeCatalogStatus] || '还没收到官方模型，请点刷新重试。') }));
      return;
    }
    function nativeRow(family) {
      const sub = family.variants > 1 ? [family.variants + ' 个变体'] : [];
      if (family.efforts.length) sub.push('Effort ' + family.efforts.join(' / '));
      if (family.toggles.length) sub.push(...family.toggles);
      if (!family.members.some(member => member.eligible)) sub.push('不可用作 Fusion Lead/Sidekick');
      return element('div', { class: 'row' },
        element('div', { class: 'row-main' }, element('span', { class: 'row-title', text: family.label }),
          element('span', { class: 'row-sub', text: sub.join(' · ') })),
        switchInput(!family.hidden, family.variants > 1 ? '在列表中显示 ' + family.label + ' 的 ' + family.variants + ' 个变体' : '在列表中显示 ' + family.label,
          show => run(() => request('setNativeModelHidden', { uids: family.members.map(member => member.uid), hidden: !show })), off() || family.internal === true));
    }
    const groups = new Map();
    for (const family of families) {
      if (family.internal) continue;
      const vendor = family.vendor || '其他';
      if (!groups.has(vendor)) groups.set(vendor, []);
      groups.get(vendor).push(family);
    }
    for (const [vendor, group] of groups) {
      container.append(element('div', { class: 'vendor-head', text: vendor + ' · ' + group.length + ' 个系列' }));
      for (const family of group) container.append(nativeRow(family));
    }
    // Retired leftovers, review/check rows and router cards (Adaptive/Fusion
    // render in the picker but are routing surfaces, not models) are folded
    // into a collapsed internal section under the picker groups.
    const internal = families.filter(family => family.internal);
    if (internal.length) {
      const details = element('details', { class: 'fold', open: !!query },
        element('summary', { text: '内部条目 · ' + internal.length + ' · 退役与路由/内部用途' }));
      for (const family of internal) details.append(nativeRow(family));
      container.append(details);
    }
  }

  function renderCache() {
    const report = state().cliCache;
    const hint = byId('cache-hint'), detail = byId('cache-report');
    hint.textContent = report && report.at ? '最近检查 ' + new Date(report.at).toLocaleTimeString('zh-CN', { hour12: false }) : '';
    // The three status lines collapse into one row joined by ' · ' — the same
    // separator the header status line uses. Empty segments are skipped.
    const segments = [];
    if (!report) segments.push('还没有记录，点一次「刷新缓存」即可。');
    else {
      const parts = [];
      if (report.refreshed?.length) parts.push('已重写 ' + report.refreshed.map(name => name.split('.')[0]).join('、'));
      const SKIP_REASONS = { 'no-improvement': '已是最新', unsupported: '格式不支持', 'read-failed': '读取失败' };
      // Injection failures and unreadable/unsupported cache formats are not "no
      // rewrite needed": the file was left alone for a reason the user can act on.
      const SKIP_WARNINGS = {
    'retire-withheld': '官方目录未就绪，暂不清理', 'augment-failed': '重写失败', 'shape-unrecognized': '载荷形状未识别', 'transform-failed': '注入出错',
        'too-large': '文件超过大小上限', 'unsupported-envelope': '信封格式未适配', 'malformed-payload': '载荷形状未识别',
        'concurrent-write': '文件刚被 CLI 更新' };
      for (const skip of report.skipped || []) {
        const name = skip.name.split('.')[0];
        parts.push(SKIP_WARNINGS[skip.reason]
          ? name + ' 未改动（' + SKIP_WARNINGS[skip.reason] + '）'
          : name + ' 无需重写（' + (SKIP_REASONS[skip.reason] || skip.reason) + '）');
      }
      for (const error of report.errors || []) parts.push(error.name.split('.')[0] + ' 写入失败（' + error.code + '）');
      const coverage = report.coverage;
      if (coverage && coverage.dirState === 'missing') parts.push('未发现 CLI 缓存目录');
      if (coverage && coverage.dirState === 'unreadable') parts.push('CLI 缓存目录不可读，未能检查');
      if (coverage && Array.isArray(coverage.unsupported) && coverage.unsupported.length) {
        parts.push('发现未知代际缓存 ' + coverage.unsupported.map(item => item.name.split('.')[0]).join('、') +
          '，当前插件未适配，未处理；请更新插件');
      }
      if (coverage && Array.isArray(coverage.legacy) && coverage.legacy.length) {
        parts.push('历史缓存文件 ' + coverage.legacy.map(item => item.name).join('、') + ' 为旧版本残留，未处理');
      }
      if (!report.checked) parts.push('没有找到本插件写入的缓存文件');
      else if (!parts.length) parts.push('检查了 ' + report.checked + ' 个文件，内容已是最新');
      segments.push(parts.join('；'));
      if (coverage && coverage.dirState === 'ok') {
        const gens = [...new Set((coverage.generations || []).map(entry => entry.generation))].sort((a, b) => a - b);
        if (coverage.current && coverage.current.generation) {
          // `current` is the newest supported generation on disk — the CLI
          // reader is never observed, so the copy must not claim an active v.
          let text = '检测到兼容缓存 v' + coverage.current.generation;
          if (gens.length > 1) text += '（同时在盘 ' + gens.map(g => 'v' + g).join('、') + '）';
          segments.push(text);
        }
        if (coverage.dynamic) segments.push('检测到新代际 v' + Math.max(...gens.filter(g => g > 6)) + '，格式兼容，可动态处理');
      }
    }
    const status = state().desktopCatalog;
    const catalogText = !status || typeof status !== 'object' ? '' :
      ({ ready: '原生目录已提交', pending: '原生目录尚未确认', 'waiting-auth': '等待账号登录',
        degraded: '原生目录同步失败', unsupported: '当前环境不支持目录发布' })[status.state] || '';
    if (catalogText) segments.push(catalogText);
    detail.textContent = segments.join(' · ');
  }

  return {
    render() { renderSettings(); renderNative(); renderCache(); },
    bind() {
      byId('refresh-cache').addEventListener('click', () => run(() => request('refreshCliCaches'), '正在刷新缓存…', '缓存已检查。'));
      byId('refresh-desktop-catalog').addEventListener('click', () => run(() => request('refreshDesktopCatalog'), '正在刷新模型目录…', '已触发提交，以原生确认为准。'));
    },
  };
}

module.exports = { pageMarkup, createSettingsView };

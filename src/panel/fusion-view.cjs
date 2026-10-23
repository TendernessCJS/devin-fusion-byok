'use strict';
function pageMarkup() {
  return `
      <div class="section-head"><h2>Fusion 可选模型</h2><span id="role-count" class="hint"></span></div>
      <p id="fusion-summary" class="hint mb"></p>
      <p class="hint mb">这里启用的模型会出现在 Devin 官方 Fusion 卡片的 Lead / Sidekick 下拉里；Lead 按系列（Effort 档位）成组，官方默认项已可用，无需手动添加。停用后模型从下拉移除，相关组合同时失效——正在使用的组合请在 Fusion 卡片里重新选择。</p>
      <div class="role-grid"><div id="role-lead"></div><div id="role-sidekick"></div></div>`;
}

function createFusionView(ui) {
  const { selection, request, run, element, byId, button, switchInput, focusTargets, scrollTargets } = ui;
  const state = () => ui.state();
  const off = ui.off;
  const roleSearch = selection.roleSearch;
  const roleMoreOpen = selection.roleMoreOpen;

  const FUSION_SOURCES = { mirrored: '插件镜像', official: '官方', unresolved: '已不在可用列表' };
  // Live status for the Fusion tab: how many combinations this extension
  // mirrors into the official card, plus the last combination the card was
  // seen holding. Read-only — the card itself stays the source of truth.
  function fusionSummary() {
    const last = state().lastFusion;
    return '已镜像 ' + (state().fusionCount || 0) + ' 条组合；' + (last && last.uid
      ? '最近一次使用：' + (last.label || last.uid) + '（' + (FUSION_SOURCES[last.source] || '未知') + '）'
      : '还没有在 Fusion 卡片里选过组合');
  }

  function renderRoles() {
    const lists = state().roleLists || {};
    const on = role => (lists[role] || []).filter(item => item.selected).length;
    byId('role-count').textContent = 'Lead ' + on('lead') + ' · Sidekick ' + on('sidekick');
    byId('fusion-summary').textContent = fusionSummary();
    for (const role of ['lead', 'sidekick']) {
      const container = byId('role-' + role);
      const name = role === 'lead' ? 'Lead' : 'Sidekick';
      container.replaceChildren();
      const search = element('input', { type: 'search', placeholder: '搜索', 'aria-label': '搜索 ' + name + ' 模型',
        oninput: event => { roleSearch[role] = event.target.value; renderRoleRows(role); } });
      search.value = roleSearch[role];
      focusTargets.set('role-search-' + role, search);
      const list = element('div', { id: role + '-role-list', class: 'list scroll', 'aria-label': name + ' 模型列表' });
      scrollTargets.set(role + '-role-list', list);
      container.append(element('h3', { text: name }), element('div', { class: 'toolbar' }, search), list);
      renderRoleRows(role);
    }
  }

  function renderRoleRows(role) {
    const container = byId(role + '-role-list');
    if (!container) return;
    const name = role === 'lead' ? 'Lead' : 'Sidekick';
    const query = roleSearch[role].trim().toLocaleLowerCase();
    const list = state().roleLists?.[role] || [];
    const rows = list.filter(item => !query || item.label.toLocaleLowerCase().includes(query));
    container.replaceChildren();
    const row = item => {
      const confirmed = !item.native || state().nativeCatalogStatus === 'ready';
      return element('div', { class: 'row' },
        element('div', { class: 'row-main' }, element('span', { class: 'row-title', text: item.label }),
          item.native ? element('span', { class: 'row-sub',
            text: '官方' + ((item.memberUids || []).length > 1 ? ' · ' + item.memberUids.length + ' 个变体' : '') })
            : element('span', { class: 'row-sub',
              text: 'BYOK' + ((item.variantCount || 0) > 1 ? ' · ' + item.variantCount + ' 档' : '') })),
        item.available ? switchInput(item.selected === true, '在 ' + name + ' 中启用 ' + item.label,
          value => run(() => request('setRoleModel', { role, model: item.ref, enabled: value })), off())
          : element('div', { class: 'actions nowrap' },
            element('span', { class: 'hint', text: confirmed ? item.reason || '不可用' : '官方目录未同步，暂无法确认' }),
            confirmed ? button('移除', () => run(() => request('forgetRoleRef', { role, model: item.ref }), '正在移除…', '已移除。'), 'quiet') : null));
    };
    const main = query ? rows : rows.filter(item => !item.native || item.defaultSelected || item.selected || item.explicitIncluded);
    const extra = query ? [] : rows.filter(item => item.native && !item.defaultSelected && !item.selected && !item.explicitIncluded);
    for (const item of main) container.append(row(item));
    if (extra.length) {
      const details = element('details', { class: 'fold', open: roleMoreOpen[role] }, element('summary', { text: '更多官方模型（' + extra.length + '）' }));
      details.addEventListener('toggle', () => { roleMoreOpen[role] = details.open; });
      for (const item of extra) details.append(row(item));
      container.append(details);
    }
    if (!rows.length) container.append(element('div', { class: 'empty', text: list.length ? '没有匹配的模型。' : '暂无可选模型。' }));
  }

  return { render: renderRoles };
}

module.exports = { pageMarkup, createFusionView };

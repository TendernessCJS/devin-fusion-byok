'use strict';
const { markupText } = require('./dom.cjs');
const { translator } = require('../i18n/index.cjs');
function pageMarkup(t = translator()) {
  const h = markupText(t);
  return `
      <div class="section-head"><h2>${h('fusion.title')}</h2><span id="role-count" class="hint"></span></div>
      <p id="fusion-summary" class="hint mb"></p>
      <p class="hint mb">${h('fusion.lead')}</p>
      <div class="role-grid"><div id="role-lead"></div><div id="role-sidekick"></div></div>`;
}

function createFusionView(ui) {
  const { selection, request, run, catalogSuccess, element, byId, button, switchInput, focusTargets, scrollTargets } = ui;
  const state = () => ui.state();
  const off = ui.off;
  const roleSearch = selection.roleSearch;
  const roleMoreOpen = selection.roleMoreOpen;

  const FUSION_SOURCES = { mirrored: t('fusion.source.mirrored'), official: t('fusion.source.official'), unresolved: t('fusion.source.unresolved') };
  // catalog/roles.cjs emits this one reason as display copy (and its tests pin
  // the value), so it is translated here at render instead of at the source.
  const ROLE_REASONS = { '当前未在可用列表中': t('fusion.reason.notListed') }; // i18n-data: value emitted by catalog/roles.cjs
  // Live status for the Fusion tab: how many combinations this extension
  // mirrors into the official card, plus the last combination the card was
  // seen holding. Read-only — the card itself stays the source of truth.
  function fusionSummary() {
    const last = state().lastFusion;
    return t('fusion.mirrored', { count: state().fusionCount || 0 }) + (last && last.uid
      ? t('fusion.lastUsed', { label: last.label || last.uid, source: FUSION_SOURCES[last.source] || t('common.unknown') })
      : t('fusion.neverUsed'));
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
      const search = element('input', { type: 'search', placeholder: t('fusion.search'), 'aria-label': t('fusion.searchAria', { role: name }),
        oninput: event => { roleSearch[role] = event.target.value; renderRoleRows(role); } });
      search.value = roleSearch[role];
      focusTargets.set('role-search-' + role, search);
      const list = element('div', { id: role + '-role-list', class: 'list scroll', 'aria-label': t('fusion.listAria', { role: name }) });
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
            text: t('fusion.official') + ((item.memberUids || []).length > 1 ? ' · ' + t('fusion.variants', { count: item.memberUids.length }) : '') })
            : element('span', { class: 'row-sub',
              text: 'BYOK' + ((item.variantCount || 0) > 1 ? ' · ' + t('models.tiers', { count: item.variantCount }) : '') })),
        item.available ? switchInput(item.selected === true, t('fusion.enableInRoleAria', { role: name, label: item.label }),
          value => run(() => request('setRoleModel', { role, model: item.ref, enabled: value }), undefined, catalogSuccess), off())
          : element('div', { class: 'actions nowrap' },
            element('span', { class: 'hint', text: confirmed ? (item.reason ? ROLE_REASONS[item.reason] || item.reason : t('fusion.unavailable')) : t('fusion.unconfirmed') }),
            confirmed ? button(t('common.remove'), () => run(() => request('forgetRoleRef', { role, model: item.ref }), t('fusion.removing'), t('fusion.removed')), 'quiet') : null));
    };
    const main = query ? rows : rows.filter(item => !item.native || item.defaultSelected || item.selected || item.explicitIncluded);
    const extra = query ? [] : rows.filter(item => item.native && !item.defaultSelected && !item.selected && !item.explicitIncluded);
    for (const item of main) container.append(row(item));
    if (extra.length) {
      const details = element('details', { class: 'fold', open: roleMoreOpen[role] }, element('summary', { text: t('fusion.moreOfficial', { count: extra.length }) }));
      details.addEventListener('toggle', () => { roleMoreOpen[role] = details.open; });
      for (const item of extra) details.append(row(item));
      container.append(details);
    }
    if (!rows.length) container.append(element('div', { class: 'empty', text: list.length ? t('models.noMatch') : t('fusion.empty') }));
  }

  return { render: renderRoles };
}

module.exports = { pageMarkup, createFusionView };

'use strict';
const { updateMarkup } = require('./update-view.cjs');
const { markupText } = require('./dom.cjs');
const { translator, LANGUAGE_CHOICES } = require('../i18n/index.cjs');

// The language row is static markup sandwiched between two dynamic containers
// (settings-status and settings-general are both rebuilt on every state push):
// changing the language re-renders the whole page, so the current choice is
// baked in here. Its title reads the same in both languages, so a user stuck
// in the wrong one can still find it.
function languageMarkup(h, choice) {
  const options = LANGUAGE_CHOICES.map(value => `<option value="${value}"${value === choice ? ' selected' : ''}>${h('settings.language.' + value)}</option>`).join('');
  return `<div class="list mt"><div class="setting"><div class="row-main"><span class="row-title">${h('settings.language.title')}</span><span class="row-sub">${h('settings.language.hint')}</span></div><select id="language-select" aria-label="${h('settings.language.title')}">${options}</select></div></div>`;
}

function pageMarkup(t = translator(), languageChoice = 'auto') {
  const h = markupText(t);
  return `
      <div id="settings-status"></div>
      ${languageMarkup(h, languageChoice)}
      <div id="settings-general"></div>
      <details id="native-group" class="group"><summary>${h('settings.native.title')}<span id="native-count" class="hint"></span></summary><div class="group-body" id="native-models"></div></details>
      <details id="cache-group" class="group"><summary>${h('settings.cache.title')}<span id="cache-hint" class="hint"></span></summary><div class="group-body">
        <p class="hint mb">${h('settings.cache.lead', { dir: '<code class="cmd">~/.cache/devin/cli</code>', bak: '<code class="cmd">.bak</code>' })}</p>
        <div class="cache-toolbar">
          <button id="refresh-cache" type="button">${h('settings.cache.refresh')}</button>
        </div>
        <p class="hint" id="cache-report"></p>
      </div></details>
      ${updateMarkup(t)}`;
}

function createSettingsView(ui) {
  const { selection, request, run, catalogSuccess, element, byId, button, switchInput, focusTargets, scrollTargets } = ui;
  const state = () => ui.state();
  const off = ui.off;
  // panel-state.cjs names the catch-all vendor with this value (panel-manager
  // tests pin it); it stays the grouping key and is translated only for display.
  const OTHER_VENDOR = '其他'; // i18n-data: vendor value emitted by panel/panel-state.cjs

  function renderSettings() {
    const container = byId('settings-status');
    const general = byId('settings-general');
    container.replaceChildren();
    general.replaceChildren();
    const backendText = { starting: t('settings.backend.starting'), running: t('settings.backend.running'), stopped: t('settings.backend.stopped') }[state().backendStatus]
      || t('settings.abnormal', { status: state().backendStatus || t('common.unknown') });
    const catalogText = { ready: t('settings.catalog.ready'), loading: t('settings.catalog.loading'), empty: t('settings.catalog.empty') }[state().nativeCatalogStatus]
      || t('settings.abnormal', { status: state().nativeCatalogStatus || t('common.unknown') });
    container.append(element('p', { class: 'hint', text: t('settings.runtimeStatus', { backend: backendText, catalog: catalogText }) }));
    const health = state().health;
    if (health && Array.isArray(health.items)) {
      container.append(element('p', { class: 'hint',
        text: t('settings.health', { items: health.items.map(item => `${item.label} ${({ ok: '✓', bad: '✗', unknown: t('settings.health.unknown') })[item.state]}`).join(' · ') }) }));
      if (health.ok === false) {
        const hints = health.items.filter(item => item.state === 'bad' && item.hint).map(item => item.hint).join(' ');
        if (hints) container.append(element('p', { class: 'warn mt', text: hints }));
      }
    }
    const setting = (title, sub, control) => element('div', { class: 'setting' },
      element('div', { class: 'row-main' }, element('span', { class: 'row-title', text: title }), sub ? element('span', { class: 'row-sub', text: sub }) : null), control);
    const status = state().autoContinueStatus === 'attached' ? null
      : state().autoContinueStatus === 'waiting' ? t('settings.auto.waiting')
      : t('settings.auto.unavailable');
    // The auto-continue card is rebuilt on every state push, so it cannot be a
    // <details>: the open flag would reset. The heading lives inside the card
    // instead, keeping title, switches and warning one visual unit.
    general.append(element('div', { class: 'list mt' },
      element('div', { class: 'list-head', text: t('settings.auto.title') }),
      setting(t('settings.auto.retry'), t('settings.auto.retryHint'),
        switchInput(state().autoContinueOnProviderError === true, t('settings.auto.retry'),
          value => run(() => request('setAutoContinue', { enabled: value })), off())),
      setting(t('settings.auto.truncated'), t('settings.auto.truncatedHint'),
        switchInput(state().autoContinueUntilPlanComplete === true, t('settings.auto.truncated'),
          value => run(() => request('setAutoContinueUntilPlanComplete', { enabled: value })), off())),
      status ? element('p', { class: 'warn list-note', text: status }) : null));
  }

  function renderNative() {
    const container = byId('native-models');
    container.replaceChildren();
    const all = state().nativeFamilies || [];
    const listed = all.filter(family => family.hidden !== true).length;
    byId('native-count').textContent = all.length ? t('settings.native.count', { listed, total: all.length }) : '';
    const search = element('input', { type: 'search', placeholder: t('settings.native.search'), 'aria-label': t('settings.native.search'),
      oninput: event => { selection.nativeSearch = event.target.value; renderNativeRows(); } });
    search.value = selection.nativeSearch;
    focusTargets.set('native-search', search);
    const list = element('div', { id: 'native-list', class: 'list scroll', 'aria-label': t('settings.native.listAria') });
    scrollTargets.set('native-list', list);
    const shown = all.filter(family => !family.internal);
    // The pills are an additive breakdown of the non-internal families: a
    // hidden family is counted only under 已隐藏, so 可用 + 已隐藏 + 不可用 always
    // equals 全部 minus 内部. Counting a hidden family as 可用 as well would
    // make the default 可用 view show families the user has already turned off.
    // Labels are states (what the count describes); the verbs 隐藏/显示 belong
    // to the bulk buttons below, so a pill never reads as an action.
    const counts = { all: all.length,
      available: shown.filter(family => family.hidden !== true && family.disabled !== true).length,
      disabled: shown.filter(family => family.hidden !== true && family.disabled === true).length,
      hidden: shown.filter(family => family.hidden === true).length,
      internal: all.filter(family => family.internal === true).length };
    // 全部 first (the only way back to filtered-out families), then the three
    // mutually exclusive states of a picker family, then 内部 — a different
    // class entirely (never rendered by the picker, opens a flat list).
    const FILTERS = ['all', 'available', 'hidden', 'disabled', 'internal'].map(key => [key, t('settings.native.filter.' + key)]);
    const FILTER_TITLES = Object.fromEntries(FILTERS.map(([key]) => [key, t('settings.native.filterTitle.' + key)]));
    if (!FILTERS.some(([key]) => key === selection.nativeFilter)) selection.nativeFilter = 'available';
    const pillNodes = new Map();
    const pills = element('div', { class: 'filter-pills' }, FILTERS.map(([key, label]) => {
      const node = element('button', { type: 'button', text: label + ' ' + counts[key], title: FILTER_TITLES[key],
        class: 'pill' + (selection.nativeFilter === key ? ' active' : ''),
        onclick: () => {
          selection.nativeFilter = key;
          for (const [name, pill] of pillNodes) pill.className = 'pill' + (name === key ? ' active' : '');
          renderNativeRows();
        } });
      pillNodes.set(key, node);
      return node;
    }));
    const uidsOf = families => [...new Set(families.flatMap(family => family.members.map(member => member.uid)))];
    const setHidden = (families, hidden, progress, success) => run(async () => {
      const uids = uidsOf(families);
      for (let at = 0; at < uids.length; at += 250)
        await request('setNativeModelHidden', { uids: uids.slice(at, at + 250), hidden });
    }, progress, success);
    const disabledTargets = shown.filter(family => family.disabled === true && !family.hidden);
    const shownTargets = shown.filter(family => !family.hidden);
    const hiddenTargets = shown.filter(family => family.hidden === true);
    const bulk = (label, families, hidden, progress, success) =>
      element('button', { type: 'button', class: 'secondary', text: label,
        disabled: off() || !families.length,
        onclick: () => setHidden(families, hidden, progress, success) });
    container.append(element('p', { class: 'hint mb', text: t('settings.native.lead') }),
      element('div', { class: 'toolbar' }, search, pills),
      element('div', { class: 'toolbar' },
        bulk(disabledTargets.length ? t('settings.native.hideUnavailableCount', { count: disabledTargets.length }) : t('settings.native.hideUnavailable'), disabledTargets, true, t('settings.native.hidingUnavailable'), t('settings.native.hidUnavailable')),
        bulk(t('settings.native.hideAll'), shownTargets, true, t('settings.native.hidingAll'), t('settings.native.hidAll')),
        bulk(t('settings.native.showAll'), hiddenTargets, false, t('settings.native.showing'), t('settings.native.shown')),
        button(t('common.refresh'), () => run(() => request('refreshNativeModels'), t('settings.native.syncing'), t('settings.native.synced')), 'secondary')),
      list);
    renderNativeRows();
  }

  function renderNativeRows() {
    const container = byId('native-list');
    if (!container) return;
    container.replaceChildren();
    const all = state().nativeFamilies || [];
    const query = selection.nativeSearch.trim().toLocaleLowerCase();
    const filter = selection.nativeFilter;
    const families = all.filter(family => {
      if (query && !(family.label + ' ' + (family.vendor || '') + ' ' + family.members.map(member => member.uid + ' ' + member.label).join(' ')).toLocaleLowerCase().includes(query)) return false;
      if (filter === 'available') return !family.internal && family.hidden !== true && family.disabled !== true;
      if (filter === 'disabled') return !family.internal && family.hidden !== true && family.disabled === true;
      if (filter === 'hidden') return !family.internal && family.hidden === true;
      if (filter === 'internal') return family.internal === true;
      return true;
    });
    if (!families.length) {
      // The default view is a filter, so an empty list must say which one and
      // where the rest went instead of looking like a sync failure.
      const filtered = query ? t('settings.native.noMatch')
        : filter === 'all' ? t('settings.native.noneAtAll')
        : t('settings.native.noneInFilter');
      container.append(element('div', { class: 'empty', text: all.length ? filtered : ({ loading: t('settings.native.syncing'), unsupported: t('settings.native.unsupported'), unavailable: t('settings.native.unavailable'), empty: t('settings.native.emptyCatalog') }[state().nativeCatalogStatus] || t('settings.native.emptyRetry')) }));
      return;
    }
    function nativeRow(family) {
      const sub = family.variants > 1 ? [t('fusion.variants', { count: family.variants })] : [];
      if (family.disabled === true) sub.unshift(t('settings.native.accountUnavailable'));
      if (family.efforts.length) sub.push('Effort ' + family.efforts.join(' / '));
      if (family.toggles.length) sub.push(...family.toggles);
      if (family.disabled !== true && !family.members.some(member => member.eligible)) sub.push(t('settings.native.notFusionEligible'));
      if (family.internal === true) sub.push(t('settings.native.notInPicker'));
      return element('div', { class: 'row' },
        element('div', { class: 'row-main' }, element('span', { class: 'row-title', text: family.label }),
          element('span', { class: 'row-sub', text: sub.join(' · ') })),
        switchInput(!family.hidden, family.variants > 1 ? t('settings.native.showVariantsAria', { label: family.label, count: family.variants }) : t('settings.native.showAria', { label: family.label }),
          show => run(() => request('setNativeModelHidden', { uids: family.members.map(member => member.uid), hidden: !show }), undefined, catalogSuccess), off() || family.internal === true));
    }
    if (filter === 'internal') {
      for (const family of families) container.append(nativeRow(family));
      return;
    }
    const groups = new Map();
    for (const family of families) {
      if (family.internal) continue;
      const vendor = family.vendor || OTHER_VENDOR;
      if (!groups.has(vendor)) groups.set(vendor, []);
      groups.get(vendor).push(family);
    }
    for (const [vendor, group] of groups) {
      container.append(element('div', { class: 'vendor-head', text: t('settings.native.vendorHead', { vendor: vendor === OTHER_VENDOR ? t('settings.native.vendorOther') : vendor, count: group.length }) }));
      for (const family of [...group].sort((a, b) => Number(a.disabled === true) - Number(b.disabled === true)))
        container.append(nativeRow(family));
    }
    // Retired leftovers, review/check rows and router cards (Adaptive/Fusion
    // render in the picker but are routing surfaces, not models) are folded
    // into a collapsed internal section under the picker groups.
    const internal = families.filter(family => family.internal);
    if (internal.length) {
      const details = element('details', { class: 'fold', open: !!query },
        element('summary', { text: t('settings.native.internalFold', { count: internal.length }) }));
      for (const family of internal) details.append(nativeRow(family));
      container.append(details);
    }
  }

  function renderCache() {
    const report = state().cliCache;
    const hint = byId('cache-hint'), detail = byId('cache-report');
    hint.textContent = report && report.at ? t('settings.cache.lastChecked', { time: new Date(report.at).toLocaleTimeString('zh-CN', { hour12: false }) }) : '';
    // The three status lines collapse into one row joined by ' · ' — the same
    // separator the header status line uses. Empty segments are skipped.
    const segments = [];
    if (!report) segments.push(t('settings.cache.noRecord'));
    else {
      const parts = [];
      if (report.refreshed?.length) parts.push(t('settings.cache.rewritten', { names: report.refreshed.map(name => name.split('.')[0]).join(t('common.enumSep')) }));
      const SKIP_REASONS = { 'no-improvement': t('settings.cache.skip.noImprovement'), unsupported: t('settings.cache.skip.unsupported'), 'read-failed': t('settings.cache.skip.readFailed') };
      // Injection failures and unreadable/unsupported cache formats are not "no
      // rewrite needed": the file was left alone for a reason the user can act on.
      const SKIP_WARNINGS = {
        'retire-withheld': t('settings.cache.warn.retireWithheld'), 'augment-failed': t('settings.cache.warn.augmentFailed'), 'shape-unrecognized': t('settings.cache.warn.shapeUnrecognized'), 'transform-failed': t('settings.cache.warn.transformFailed'),
        'too-large': t('settings.cache.warn.tooLarge'), 'unsupported-envelope': t('settings.cache.warn.unsupportedEnvelope'), 'malformed-payload': t('settings.cache.warn.shapeUnrecognized'),
        'concurrent-write': t('settings.cache.warn.concurrentWrite') };
      for (const skip of report.skipped || []) {
        const name = skip.name.split('.')[0];
        parts.push(SKIP_WARNINGS[skip.reason]
          ? t('settings.cache.untouched', { name, reason: SKIP_WARNINGS[skip.reason] })
          : t('settings.cache.notNeeded', { name, reason: SKIP_REASONS[skip.reason] || skip.reason }));
      }
      for (const error of report.errors || []) parts.push(t('settings.cache.writeFailed', { name: error.name.split('.')[0], code: error.code }));
      const coverage = report.coverage;
      if (coverage && coverage.dirState === 'missing') parts.push(t('settings.cache.dirMissing'));
      if (coverage && coverage.dirState === 'unreadable') parts.push(t('settings.cache.dirUnreadable'));
      if (coverage && Array.isArray(coverage.unsupported) && coverage.unsupported.length) {
        parts.push(t('settings.cache.unknownGeneration', { names: coverage.unsupported.map(item => item.name.split('.')[0]).join(t('common.enumSep')) }));
      }
      if (coverage && Array.isArray(coverage.legacy) && coverage.legacy.length) {
        parts.push(t('settings.cache.legacy', { names: coverage.legacy.map(item => item.name).join(t('common.enumSep')) }));
      }
      if (!report.checked) parts.push(t('settings.cache.noneOwned'));
      else if (!parts.length) parts.push(t('settings.cache.upToDate', { count: report.checked }));
      segments.push(parts.join(t('common.clauseSep')));
      if (coverage && coverage.dirState === 'ok') {
        const gens = [...new Set((coverage.generations || []).map(entry => entry.generation))].sort((a, b) => a - b);
        if (coverage.current && coverage.current.generation) {
          // `current` is the newest supported generation on disk — the CLI
          // reader is never observed, so the copy must not claim an active v.
          let text = t('settings.cache.compatible', { generation: coverage.current.generation });
          if (gens.length > 1) text += t('settings.cache.alsoOnDisk', { generations: gens.map(g => 'v' + g).join(t('common.enumSep')) });
          segments.push(text);
        }
        if (coverage.dynamic) segments.push(t('settings.cache.dynamic', { generation: Math.max(...gens.filter(g => g > 6)) }));
        // Multiple model_configs identities can coexist on disk while the CLI
        // only reads one; surface the per-identity own count so the split is
        // observable. A single identity is the common case — stay quiet.
        const configs = (coverage.generations || []).filter(entry => /^model_configs_v\d+\.[0-9a-f]+\.bin$/.test(entry.name || ''))
          .sort((a, b) => (a.fetchedAt || 0) - (b.fetchedAt || 0));
        if (configs.length >= 2) {
          segments.push(configs.map(entry =>
            t('settings.cache.identity', { id: entry.name.split('.')[1].slice(0, 6), count: entry.ownCount ?? 0 })).join(' / '));
        }
      }
    }
    const contract = state().nativeContract;
    if (contract && contract.status === 'drift') {
      const ARTIFACT_NAMES = { cli: 'CLI', ls: 'LS', desktop: t('settings.contract.desktop'), chat: t('settings.contract.chat') };
      const MARKER_NAMES = { 'artifact-missing': t('settings.contract.missingFile'), 'too-large': t('settings.contract.tooLarge') };
      const missing = Object.entries(contract.missing || {}).map(([artifact, markers]) =>
        t('settings.contract.lacks', { artifact: ARTIFACT_NAMES[artifact] || artifact,
          markers: markers.map(marker => MARKER_NAMES[marker] || marker).join(t('common.enumSep')) })).join(t('common.commaSep'));
      segments.push(t('settings.contract.drift', { missing }) +
        (contract.appVersion ? t('settings.contract.appVersion', { version: contract.appVersion }) : ''));
    }
    detail.textContent = segments.join(' · ');
  }

  return {
    render() { renderSettings(); renderNative(); renderCache(); },
    bind() {
      byId('refresh-cache').addEventListener('click', () => run(() => request('refreshCliCaches'), t('settings.cache.refreshing'), t('settings.cache.checked')));
      // A new display language re-renders the page from the host; when the
      // resolved language stays the same (e.g. Auto on an English editor), the
      // toast below is what the user sees. A rejected change puts the old value back.
      const language = byId('language-select');
      let applied = language.value;
      language.addEventListener('change', () => {
        const choice = language.value;
        run(() => request('setLanguage', { choice }), t('client.saving'), t('settings.language.saved'))
          .then(ok => { if (ok) applied = choice; else language.value = applied; });
      });
    },
  };
}

module.exports = { pageMarkup, createSettingsView };

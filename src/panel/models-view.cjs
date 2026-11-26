'use strict';
const { markupText } = require('./dom.cjs');
const { translator } = require('../i18n/index.cjs');
function pageMarkup(t = translator()) {
  const h = markupText(t);
  return `
      <div class="models-layout">
        <div><div class="section-head"><h2>${h('models.providers')}</h2><button id="add-provider" class="quiet" type="button" disabled>${h('models.add')}</button></div><nav id="providers" class="provider-nav" aria-label="${h('models.providersAria')}"></nav></div>
        <div id="models"></div>
      </div>`;
}

function createModelsView(ui) {
  const { selection, request, run, catalogSuccess, notice, remember, element, byId, button, switchInput, input, field,
    openDialog, finishDialog, deleteButton, focusTargets, scrollTargets, normalizeBaseUrlPath, modelEfforts } = ui;
  const state = () => ui.state();
  const busy = () => ui.busy();
  const currentProvider = ui.currentProvider;
  const hostOf = ui.hostOf;

  function renderProviders() {
    const container = byId('providers');
    container.replaceChildren();
    if (!state().providers.length) {
      container.append(element('p', { class: 'hint', text: t('models.noProviders') }));
      return;
    }
    for (const [index, provider] of state().providers.entries()) {
      const on = provider.models.filter(model => model.enabled !== false).length;
      const moveButton = (delta, label, title, disabled) => element('button', {
        type: 'button', class: 'move', disabled,
        'aria-label': t(delta < 0 ? 'models.moveProviderUpAria' : 'models.moveProviderDownAria', { name: provider.name }), title,
        onclick: () => run(() => request('moveProvider', { id: provider.id, delta }), undefined, catalogSuccess),
      }, element('span', { class: 'move-glyph', text: delta < 0 ? '↑' : '↓' }));
      container.append(element('div', {
        class: 'provider-item' + (provider.id === selection.providerId ? ' selected' : '') },
        element('button', {
          type: 'button', class: 'provider-select',
          'aria-current': provider.id === selection.providerId ? 'true' : 'false',
          onclick: () => {
            if (busy() || selection.providerId === provider.id) return;
            selection.providerId = provider.id;
            selection.modelSearch = '';
            remember();
            renderProviders();
            renderModels();
          }
        }, element('span', { class: 'row-title', text: provider.name }),
        element('span', { class: 'row-sub', text: provider.enabled === false ? t('models.providerOff') : t('models.modelCount', { count: on }) })),
        element('div', { class: 'order-move' },
          moveButton(-1, t('models.moveUp'), t('models.moveUp'), index === 0),
          moveButton(1, t('models.moveDown'), t('models.moveDown'), index === state().providers.length - 1))));
    }
  }

  function renderModels() {
    const container = byId('models');
    const provider = currentProvider();
    container.replaceChildren();
    if (!provider) {
      container.append(element('div', { class: 'list' }, element('div', { class: 'empty' },
        element('p', { text: t('models.emptyLead') }),
        button(t('models.addProvider'), () => providerDialog(), ''))));
      return;
    }
    const format = { 'openai-responses': 'Responses', anthropic: 'Anthropic Messages' }[provider.apiFormat] || 'Chat Completions';
    container.append(element('div', { class: 'provider-head' },
      element('div', { class: 'row-main' }, element('h2', { text: provider.name }),
        element('span', { class: 'row-sub', text: hostOf(provider.baseUrl) + ' · ' + format + (provider.keyConfigured ? '' : ' · ' + t('models.noKey')) })),
      element('div', { class: 'actions' },
        switchInput(provider.enabled !== false, t('models.enableProviderAria', { name: provider.name }),
          value => run(() => request('setProviderEnabled', { id: provider.id, enabled: value }), undefined, catalogSuccess)),
        button(t('models.edit'), () => providerDialog(provider), 'quiet'))));
    if (provider.enabled === false) container.append(element('p', { class: 'warn mb', text: t('models.providerOffNotice') }));
    // The ACP directory is built once per session, so enabling a supplier or
    // adding models here leaves the running conversation on the old list until
    // a new one starts. Saying so beats leaving the user to guess why the
    // picker looks unchanged.
    const drift = state().catalogDrift;
    if (drift) container.append(element('p', { class: 'warn mb',
      text: t('models.drift', { count: drift.missing }) }));
    const search = element('input', { type: 'search', placeholder: t('models.search'), 'aria-label': t('models.searchImportedAria'),
      oninput: event => { selection.modelSearch = event.target.value; renderModelRows(); } });
    search.value = selection.modelSearch;
    focusTargets.set('model-search', search);
    const importButton = button(t('models.import'), () => provider.keyConfigured
      ? run(async () => {
        await request('refreshModels', { providerId: provider.id });
        importDialog(provider.id);
      }, t('models.fetching'), t('models.pickToImport'))
      : notice(t('models.importNeedsKey'), 'error'), '');
    if (!provider.keyConfigured) importButton.title = t('models.keyMissingTitle');
    container.append(element('div', { class: 'toolbar' }, provider.models.length ? search : element('span', { class: 'spacer' }),
      importButton, button(t('models.addManually'), () => modelDialog(provider))));
    const list = element('div', { id: 'model-list', class: 'list scroll', 'aria-label': t('models.listAria') });
    scrollTargets.set('model-list', list);
    container.append(list);
    renderModelRows();
  }

  function visibleModels() {
    const query = selection.modelSearch.trim().toLocaleLowerCase();
    return (currentProvider()?.models || []).filter(model => !query || (model.id + ' ' + (model.label || '')).toLocaleLowerCase().includes(query));
  }

  function renderModelRows() {
    const container = byId('model-list');
    if (!container) return;
    const provider = currentProvider();
    container.replaceChildren();
    const models = visibleModels();
    if (!models.length) {
      container.append(element('div', { class: 'empty', text: provider.models.length ? t('models.noMatch') : t('models.emptyModels') }));
      return;
    }
    if (models.length > 1) {
      const bulk = value => {
        const changes = models.filter(model => (model.enabled !== false) !== value).map(model => ({ id: model.id, enabled: value }));
        if (changes.length) run(() => request('updateModels', { providerId: provider.id, changes }), undefined, catalogSuccess);
      };
      const filtered = models.length < provider.models.length;
      container.append(element('div', { class: 'row compact' },
        element('span', { class: 'row-main hint', text: (filtered ? t('models.filteredCount', { count: models.length }) : '')
          + t('models.enabledCount', { enabled: models.filter(model => model.enabled !== false).length, total: models.length }) }),
        button(filtered ? t('models.enableThese') : t('models.enableAll'), () => bulk(true), 'quiet'),
        button(filtered ? t('models.disableThese') : t('models.disableAll'), () => bulk(false), 'quiet')));
    }
    const fmtTokens = value => value >= 1000000 ? (Math.round(value / 100000) / 10) + 'M'
      : value >= 1000 ? Math.round(value / 1000) + 'K' : String(value);
    for (const model of models) {
      const name = model.label || model.id;
      const caps = [];
      const variants = modelEfforts(model).length;
      if (variants > 1) caps.push(t('models.tiers', { count: variants }));
      if (model.contextWindow) caps.push(fmtTokens(model.contextWindow) + ' Context');
      const sub = [name !== model.id ? model.id : '', ...caps].filter(Boolean).join(' · ');
      const index = models.indexOf(model);
      const moveButton = (delta, label, title, disabled) => element('button', {
        type: 'button', class: 'move', disabled,
        'aria-label': t(delta < 0 ? 'models.moveModelUpAria' : 'models.moveModelDownAria', { name }), title,
        onclick: () => run(() => request('moveModel', { providerId: provider.id, id: model.id, delta }), undefined, catalogSuccess),
      }, element('span', { class: 'move-glyph', text: delta < 0 ? '↑' : '↓' }));
      container.append(element('div', { class: 'row' },
        element('div', { class: 'row-main' },
          element('button', { type: 'button', class: 'link-title', text: name, 'aria-label': t('models.editModelAria', { name }), onclick: () => modelDialog(provider, model) }),
          sub ? element('span', { class: 'row-sub mono', text: sub }) : null),
        selection.modelSearch.trim() ? null : element('div', { class: 'order-move' },
          moveButton(-1, t('models.moveUp'), t('models.moveUp'), index === 0),
          moveButton(1, t('models.moveDown'), t('models.moveDown'), index === models.length - 1)),
        switchInput(model.enabled !== false, t('models.enableModelAria', { name }),
          value => run(() => request('updateModels', { providerId: provider.id, changes: [{ id: model.id, enabled: value }] }), undefined, catalogSuccess))));
    }
  }

  function importDialog(providerId) {
    const candidates = state().importCandidates;
    if (!candidates || candidates.providerId !== providerId) throw new Error(t('models.candidatesExpired'));
    const { dialog, form } = openDialog(t('models.import'));
    form.classList.add('import-picker');
    const selected = new Set();
    const search = input('', { type: 'search', placeholder: t('models.search'), 'aria-label': t('models.searchCandidatesAria') });
    const list = element('div', { class: 'list scroll', 'aria-label': t('models.candidatesAria') });
    const count = element('span', { class: 'hint', role: 'status' });
    let submit;
    const visible = () => {
      const query = search.value.trim().toLocaleLowerCase();
      return candidates.models.filter(model => (model.id + ' ' + model.label).toLocaleLowerCase().includes(query));
    };
    const updateCount = () => {
      count.textContent = t('models.selectedCount', { selected: selected.size, total: candidates.models.length });
      if (submit) submit.disabled = selected.size === 0;
    };
    const renderRows = () => {
      list.replaceChildren();
      for (const model of visible()) {
        const checkbox = element('input', { type: 'checkbox', checked: model.imported || selected.has(model.id), disabled: model.imported,
          onchange: event => { if (event.target.checked) selected.add(model.id); else selected.delete(model.id); updateCount(); } });
        list.append(element('label', { class: 'row' }, checkbox,
          element('span', { class: 'row-main' }, element('span', { class: 'row-title', text: model.label }),
            model.label !== model.id ? element('span', { class: 'row-sub mono', text: model.id }) : null),
          model.imported ? element('span', { class: 'hint', text: t('models.imported') }) : null));
      }
      if (!list.childElementCount) list.append(element('p', { class: 'empty', text: candidates.models.length ? t('models.noMatch') : t('models.noneReturned') }));
      updateCount();
    };
    search.addEventListener('input', renderRows);
    form.append(element('div', { class: 'toolbar' }, search),
      element('div', { class: 'toolbar' }, button(t('models.selectAll'), () => {
        for (const model of visible()) if (!model.imported) selected.add(model.id);
        renderRows();
      }, 'quiet'), button(t('models.clearSelection'), () => { selected.clear(); renderRows(); }, 'quiet'), element('span', { class: 'spacer' }), count), list);
    submit = finishDialog(dialog, form, t('models.importSubmit'), () => request('importModels', { providerId, token: candidates.token, ids: [...selected] }), null, t('models.importedNotice'));
    renderRows();
  }

  function providerDialog(provider) {
    const { dialog, form } = openDialog(provider ? t('models.editProvider') : t('models.addProvider'));
    const name = input(provider?.name, { required: true, maxlength: 80, placeholder: t('models.namePlaceholder') });
    const baseUrl = input(provider?.baseUrl, { type: 'url', required: true, placeholder: 'https://example.com/v1', spellcheck: 'false' });
    const apiFormat = element('select', { 'aria-label': t('models.apiType') },
      element('option', { value: 'openai-responses', text: 'OpenAI Responses' }),
      element('option', { value: 'openai', text: 'OpenAI Chat Completions' }),
      element('option', { value: 'anthropic', text: 'Anthropic Messages' }));
    apiFormat.value = provider?.apiFormat || 'openai-responses';
    const apiKey = input('', { type: 'password', autocomplete: 'new-password', placeholder: provider?.keyConfigured ? t('models.keyKeep') : '', spellcheck: 'false' });
    const urlField = field(t('models.baseUrl'), baseUrl, t('models.baseUrlHint'));
    const urlPreview = element('span', { class: 'hint url-preview' });
    urlField.append(urlPreview);
    const refreshPreview = () => {
      let url;
      try { url = new URL(baseUrl.value.trim()); } catch { url = null; }
      urlPreview.replaceChildren();
      if (!url || !['http:', 'https:'].includes(url.protocol)) return;
      const base = url.origin + normalizeBaseUrlPath(url.pathname);
      const path = { openai: '/chat/completions', anthropic: '/messages' }[apiFormat.value] || '/responses';
      urlPreview.append(t('models.previewRequest', { url: base + path }), element('br'), t('models.previewModels', { url: base + '/models' }));
      // /v1 is appended only for a bare host. Saying so outright beats leaving
      // the user to reverse-engineer the rule from the two URLs above — the
      // failure mode of getting it wrong is a silent 404.
      if (url.pathname.replace(/\/+$/, '') === '') urlPreview.append(element('br'), t('models.previewBareHost'));
    };
    baseUrl.addEventListener('input', refreshPreview);
    apiFormat.addEventListener('change', refreshPreview);
    refreshPreview();
    form.append(field(t('models.name'), name), urlField, field(t('models.apiType'), apiFormat), field(t('models.apiKey'), apiKey));
    const remove = provider ? deleteButton(dialog, t('models.deleteProviderTitle'), t('models.deleteProviderBody', { name: provider.name }),
      () => request('deleteProvider', { id: provider.id })) : null;
    finishDialog(dialog, form, t('common.save'), () => {
      const payload = { name: name.value.trim(), baseUrl: baseUrl.value.trim(), apiFormat: apiFormat.value };
      if (provider) payload.id = provider.id;
      if (apiKey.value.trim()) payload.apiKey = apiKey.value.trim();
      return request('saveProvider', payload);
    }, remove);
  }

  function modelDialog(provider, model) {
    const { dialog, form } = openDialog(model ? t('models.editModel') : t('models.addModelTitle'));
    const id = input(model?.id, { required: true, readOnly: Boolean(model), maxlength: 256, placeholder: t('models.idPlaceholder'), spellcheck: 'false' });
    const label = input(model?.label || '', { maxlength: 160, placeholder: t('models.labelPlaceholder') });
    const contextWindow = input(model?.contextWindow || 272000, { type: 'number', min: 1, step: 1, required: true });
    const maxOutputTokens = input(model?.maxOutputTokens || 131072, { type: 'number', min: 1, step: 1, required: true });
    const efforts = input((model?.efforts || []).join(', '), { placeholder: 'low, medium, high', spellcheck: 'false' });
    const effortMode = element('select', { 'aria-label': t('models.effort') },
      element('option', { value: 'auto', text: t('models.effortAuto') }),
      element('option', { value: 'manual', text: t('models.effortManual') }),
      element('option', { value: 'none', text: t('models.effortNone') }));
    effortMode.value = model?.effortMode || (model?.efforts?.length ? 'manual' : 'auto');
    // The tri-state overrides whatever /models reported for this model.
    const reasoning = element('select', { 'aria-label': t('models.reasoningSupport') },
      element('option', { value: 'auto', text: t('models.reasoningAuto') }),
      element('option', { value: 'yes', text: t('models.reasoningSupported') }),
      element('option', { value: 'no', text: t('models.reasoningUnsupported') }));
    reasoning.value = model?.reasoningEffort === true ? 'yes' : model?.reasoningEffort === false ? 'no' : 'auto';
    const manual = field(t('models.effortList'), efforts, t('models.effortListHint'));
    manual.hidden = effortMode.value !== 'manual';
    effortMode.addEventListener('change', () => { manual.hidden = effortMode.value !== 'manual'; });
    form.append(field(t('models.modelId'), id), field(t('models.displayName'), label),
      element('details', { class: 'fold', open: effortMode.value === 'manual' }, element('summary', { text: t('models.advanced') }),
        element('div', { class: 'field-grid' }, field(t('models.contextWindow'), contextWindow), field(t('models.maxOutput'), maxOutputTokens)),
        field(t('models.effort'), effortMode, t('models.effortHint')), manual, field(t('models.reasoningSupport'), reasoning)));
    const remove = model ? deleteButton(dialog, t('models.deleteModelTitle'), t('models.deleteModelBody', { provider: provider.name, model: model.label || model.id }),
      () => request('updateModels', { providerId: provider.id, changes: [], removeIds: [model.id] })) : null;
    finishDialog(dialog, form, model ? t('common.save') : t('models.addSubmit'), () => {
      const saved = { id: id.value.trim(), label: label.value.trim() || id.value.trim(),
        contextWindow: Number(contextWindow.value), maxOutputTokens: Number(maxOutputTokens.value), effortMode: effortMode.value,
        reasoningEffort: reasoning.value === 'auto' ? null : reasoning.value === 'yes',
        efforts: effortMode.value === 'auto' ? [] : [...new Set(efforts.value.split(/[,，\s]+/).map(value => value.trim()).filter(Boolean))] }; // i18n-data: accepts a full-width comma as a list separator in user input
      if (model) return request('updateModels', { providerId: provider.id, changes: [{ ...saved, supportsImages: true }] });
      return request('addModel', { providerId: provider.id, model: { ...saved, enabled: true } });
    }, remove, model ? undefined : t('models.addedNotice'));
  }

  return {
    render() { renderProviders(); renderModels(); },
    bind() { byId('add-provider').addEventListener('click', () => providerDialog()); },
  };
}

module.exports = { pageMarkup, createModelsView };

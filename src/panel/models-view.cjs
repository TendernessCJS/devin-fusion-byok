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
    // A manual provider picks its candidates from the configured static IDs, so
    // the import flow needs no credential to run.
    const needsKey = !provider.keyConfigured && (provider.modelsMode || 'auto') !== 'manual';
    const importButton = button(t('models.import'), () => needsKey
      ? notice(t('models.importNeedsKey'), 'error')
      : run(async () => {
        await request('refreshModels', { providerId: provider.id });
        importDialog(provider.id);
      }, t('models.fetching'), t('models.pickToImport')), '');
    if (needsKey) importButton.title = t('models.keyMissingTitle');
    container.append(element('div', { class: 'toolbar' }, provider.models.length ? search : element('span', { class: 'spacer' }),
      importButton, button(t('models.addManually'), () => modelDialog(provider)), button(t('models.addMany'), () => addManyDialog(provider.id), 'quiet')));
    const list = element('div', { id: 'model-list', class: 'list scroll', 'aria-label': t('models.listAria') });
    scrollTargets.set('model-list', list);
    container.append(list);
    renderModelRows();
  }

  function visibleModels() {
    const query = selection.modelSearch.trim().toLocaleLowerCase();
    const models = currentProvider()?.models || [];
    const byIdLocal = new Map(models.map(model => [model.id, model]));
    return models.filter(model => {
      if (model.hiddenFastVariant) return false;
      if (!query) return true;
      let haystack = model.id + ' ' + (model.label || '');
      const variant = byIdLocal.get(model.fastModel);
      if (variant) haystack += ' ' + variant.id + ' ' + (variant.label || '');
      return haystack.toLocaleLowerCase().includes(query);
    });
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
      const paired = typeof model.fastModel === 'string' && model.fastModel ? 'Fast Mode: ' + model.fastModel : '';
      const sub = [name !== model.id ? model.id : '', ...caps, paired].filter(Boolean).join(' · ');
      const index = models.indexOf(model);
      // Hidden fast variants still occupy positions in the persisted order, so
      // a visible neighbour can sit several rows away: the delta is the index
      // distance inside the full order, which moveModel (any nonzero integer)
      // clamps and swaps directly.
      const fullOrder = provider.models;
      const neighborDelta = neighbor => fullOrder.findIndex(entry => entry.id === neighbor.id) - fullOrder.findIndex(entry => entry.id === model.id);
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
          moveButton(index > 0 ? neighborDelta(models[index - 1]) : -1, t('models.moveUp'), t('models.moveUp'), index === 0),
          moveButton(index < models.length - 1 ? neighborDelta(models[index + 1]) : 1, t('models.moveDown'), t('models.moveDown'), index === models.length - 1)),
        switchInput(model.enabled !== false, t('models.enableModelAria', { name }),
          value => run(() => request('updateModels', { providerId: provider.id, changes: [{ id: model.id, enabled: value }] }), undefined, catalogSuccess))));
    }
  }

  function addManyDialog(providerId) {
    const { dialog, form } = openDialog(t('models.addManyTitle'));
    const textarea = element('textarea', { rows: 6, spellcheck: 'false', placeholder: t('models.addManyPlaceholder') });
    form.append(field(t('models.addManyLabel'), textarea, t('models.addManyHint')));
    finishDialog(dialog, form, t('common.save'), () => {
      const ids = [...new Set(textarea.value.split('\n').map(line => line.trim()).filter(Boolean))];
      if (!ids.length) throw new Error(t('models.addManyEmpty'));
      return request('addModels', { providerId, ids });
    }, null, t('models.addManyDone'));
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
    const { dialog, form } = openDialog(provider ? t('models.editProvider') : t('models.addProvider'), { wide: true });
    const name = input(provider?.name, { required: true, maxlength: 80, placeholder: t('models.namePlaceholder') });
    const baseUrl = input(provider?.baseUrl, { type: 'url', required: true, placeholder: 'https://example.com/v1', spellcheck: 'false' });
    const apiFormat = element('select', { 'aria-label': t('models.apiType') },
      element('option', { value: 'openai-responses', text: 'OpenAI Responses' }),
      element('option', { value: 'openai', text: 'OpenAI Chat Completions' }),
      element('option', { value: 'anthropic', text: 'Anthropic Messages' }));
    apiFormat.value = provider?.apiFormat || 'openai-responses';
    const apiKey = input('', { type: 'password', autocomplete: 'new-password', placeholder: provider?.keyConfigured ? t('models.keyKeep') : '', spellcheck: 'false' });
    const modelsUrlInput = input(provider?.modelsUrl || '', { type: 'url', placeholder: t('models.modelsUrlPlaceholder'), spellcheck: 'false' });
    // The source mode alone decides where the model list comes from, mirroring
    // the effort-mode contract: the address field is only read in 'url' mode,
    // and 'manual' never requests /models at all.
    const source = element('select', { 'aria-label': t('models.source') },
      element('option', { value: 'auto', text: t('models.sourceAuto') }),
      element('option', { value: 'url', text: t('models.sourceUrl') }),
      element('option', { value: 'manual', text: t('models.sourceManual') }));
    source.value = provider?.modelsMode || 'auto';
    const urlField = field(t('models.baseUrl'), baseUrl, t('models.baseUrlHint'));
    const urlPreview = element('span', { class: 'hint url-preview' });
    urlField.append(urlPreview);
    const listUrlField = field(t('models.modelsUrl'), modelsUrlInput, t('models.modelsUrlHint'));
    const manualHint = element('span', { class: 'hint', text: t('models.sourceManualHint') });
    const sourceField = field(t('models.source'), source);
    sourceField.append(manualHint);
    const staticArea = element('textarea', { rows: 4, spellcheck: 'false', placeholder: t('models.staticListPlaceholder') });
    staticArea.value = (provider?.staticModels || []).join('\n');
    const staticField = field(t('models.staticList'), staticArea, t('models.staticListHint'));
    // The whole model-source configuration folds away: most providers never
    // touch it, and the chat credentials stay adjacent without the extra rows.
    const foldSummary = element('summary', { text: '' });
    const fold = element('details', { class: 'fold section' }, foldSummary, sourceField, listUrlField, staticField);
    const refreshPreview = () => {
      const mode = source.value;
      listUrlField.hidden = mode !== 'url';
      staticField.hidden = mode !== 'manual';
      manualHint.hidden = mode !== 'manual';
      const modeLabel = { auto: t('models.sourceModeAuto'), url: t('models.sourceModeUrl'), manual: t('models.sourceModeManual') }[mode];
      foldSummary.textContent = t('models.sourceSummary', { mode: modeLabel });
      let url;
      try { url = new URL(baseUrl.value.trim()); } catch { url = null; }
      urlPreview.replaceChildren();
      if (!url || !['http:', 'https:'].includes(url.protocol)) return;
      const base = url.origin + normalizeBaseUrlPath(url.pathname);
      const path = { openai: '/chat/completions', anthropic: '/messages' }[apiFormat.value] || '/responses';
      urlPreview.append(t('models.previewRequest', { url: base + path }));
      // /v1 is appended only for a bare host. Saying so outright beats leaving
      // the user to reverse-engineer the rule from the two URLs above — the
      // failure mode of getting it wrong is a silent 404. An explicit models
      // address makes the derivation irrelevant, so the note goes with it.
      if (mode === 'manual') return;
      // An empty url-mode address is rejected on save, so the preview must
      // not promise a derived endpoint that would never be used.
      if (mode === 'url' && !modelsUrlInput.value.trim()) return;
      const list = mode === 'url' ? modelsUrlInput.value.trim() : base + '/models';
      urlPreview.append(element('br'), t('models.previewModels', { url: list }));
      if (mode !== 'url' && url.pathname.replace(/\/+$/, '') === '') urlPreview.append(element('br'), t('models.previewBareHost'));
    };
    baseUrl.addEventListener('input', refreshPreview);
    apiFormat.addEventListener('change', refreshPreview);
    modelsUrlInput.addEventListener('input', refreshPreview);
    source.addEventListener('change', refreshPreview);
    refreshPreview();
    const identity = element('div', { class: 'field-grid' },
      field(t('models.name'), name), field(t('models.apiType'), apiFormat));
    const apiKeyField = field(t('models.apiKey'), apiKey);
    form.append(identity, urlField, apiKeyField, fold);
    const remove = provider ? deleteButton(dialog, t('models.deleteProviderTitle'), t('models.deleteProviderBody', { name: provider.name }),
      () => request('deleteProvider', { id: provider.id })) : null;
    // Invalid url-mode input is rejected by the manager; unfolding the section
    // first keeps the error copy next to the field it refers to. The view only
    // checks that a scheme exists — full validation stays on the write path.
    form.addEventListener('submit', () => {
      if (source.value === 'url' && !/^https?:\/\//i.test(modelsUrlInput.value.trim())) fold.open = true;
    });
    finishDialog(dialog, form, t('common.save'), () => {
      const payload = { name: name.value.trim(), baseUrl: baseUrl.value.trim(), apiFormat: apiFormat.value, modelsMode: source.value,
        modelsUrl: source.value === 'url' ? modelsUrlInput.value.trim() : undefined,
        staticModels: source.value === 'manual' ? [...new Set(staticArea.value.split('\n').map(line => line.trim()).filter(Boolean))] : undefined };
      if (provider) payload.id = provider.id;
      if (apiKey.value.trim()) payload.apiKey = apiKey.value.trim();
      return request('saveProvider', payload);
    }, remove);
  }

  function modelDialog(provider, model) {
    const { dialog, form } = openDialog(model ? t('models.editModel') : t('models.addModelTitle'), { wide: true });
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
    // The mode alone decides where tiers come from, so the two refinements below
    // are only shown for the mode that actually reads them: a manual list wins
    // over every capability field, and the /models override is only consulted in
    // auto. Hiding them keeps three competing knobs from sharing one screen.
    const hintAuto = element('span', { class: 'hint', text: t('models.effortHint') });
    const hintManual = element('span', { class: 'hint', text: t('models.effortHintManual') });
    const hintNone = element('span', { class: 'hint', text: t('models.effortHintNone') });
    const effortField = element('label', { class: 'field' },
      element('span', { class: 'field-title', text: t('models.effort') }), effortMode, hintAuto, hintManual, hintNone);
    const manual = field(t('models.effortList'), efforts, t('models.effortListHint'));
    const reasoningField = field(t('models.reasoningSupport'), reasoning, t('models.reasoningHint'));
    const syncEffortUi = () => {
      const mode = effortMode.value;
      hintAuto.hidden = mode !== 'auto';
      hintManual.hidden = mode !== 'manual';
      hintNone.hidden = mode !== 'none';
      manual.hidden = mode !== 'manual';
      reasoningField.hidden = mode !== 'auto';
    };
    effortMode.addEventListener('change', syncEffortUi);
    syncEffortUi();
    // Fast Mode: one fast variant per base model. The select starts from the
    // imported models and, once per dialog, pulls the same discovery candidates
    // the import flow uses; picking an unimported candidate imports it on save.
    const fastCheck = element('input', { type: 'checkbox', role: 'switch', 'aria-label': t('models.fastModeAria') });
    fastCheck.checked = Boolean(model?.fastModel);
    const fastSelect = element('select', { 'aria-label': t('models.fastField') });
    const fastHint = element('span', { class: 'hint', role: 'status' });
    const fastSection = element('div', { class: 'fast-mode' },
      element('div', { class: 'fast-mode-head' },
        element('label', { class: 'fast-toggle' }, fastCheck, element('span', { class: 'row-title', text: t('models.fastMode') })),
        fastSelect),
      element('span', { class: 'hint', text: t('models.fastModeHint') }), fastHint);
    let fetched = false, painted = false;
    const fastProvider = () => (state().providers || []).find(entry => entry.id === provider.id) || provider;
    // The select only lists this provider's models, so the import-time
    // `Provider · id` prefix is pure noise here; a hand-written label stays intact.
    const fastOptionText = entry => {
      const full = entry.label || entry.id || '';
      const prefix = (provider.name || provider.id) + ' · ';
      return full.startsWith(prefix) ? full.slice(prefix.length) : full;
    };
    const rebuildFastOptions = () => {
      const current = fastProvider();
      const models = Array.isArray(current.models) ? current.models : [];
      const selfId = id.value.trim();
      // The first paint seeds the select from the saved link; every later
      // rebuild keeps whatever the select holds, a cleared choice included —
      // re-seeding would silently undo it when the switch is flipped again.
      const chosen = painted ? fastSelect.value : (model?.fastModel || '');
      const claimed = new Set();
      for (const entry of models) if (entry.fastModel && entry.id !== selfId && entry.id !== model?.id) claimed.add(entry.fastModel);
      const seen = new Set(), options = [];
      for (const entry of models) {
        if (entry.enabled === false || entry.id === selfId || entry.fastModel || claimed.has(entry.id)) continue;
        seen.add(entry.id);
        options.push({ value: entry.id, text: fastOptionText(entry) });
      }
      const candidates = state().importCandidates;
      if (candidates && candidates.providerId === provider.id) {
        for (const candidate of candidates.models || []) {
          if (candidate.id === selfId || seen.has(candidate.id)) continue;
          seen.add(candidate.id);
          options.push({ value: candidate.id, text: fastOptionText(candidate) + (candidate.imported === false ? t('models.fastNotImported') : '') });
        }
      }
      if (model?.fastModel && !seen.has(model.fastModel) && model.fastModel !== selfId) {
        options.push({ value: model.fastModel, text: model.fastModel + t('models.fastDisabled') });
      }
      fastSelect.replaceChildren(element('option', { value: '', text: t('models.fastModelNone') }),
        ...options.map(option => element('option', { value: option.value, text: option.text })));
      fastSelect.value = options.some(option => option.value === chosen) ? chosen : '';
      painted = true;
    };
    let fastStatus = '';
    const syncFastUi = () => {
      fastSelect.hidden = !fastCheck.checked;
      const empty = fastSelect.children.length <= 1;
      const copy = fastStatus === 'loading' ? t('models.fastLoading')
        : fastStatus || (fastCheck.checked && empty ? t('models.fastNoCandidates') : '');
      fastHint.textContent = copy;
      fastHint.hidden = !fastCheck.checked || !copy;
    };
    const fetchFast = async () => {
      if (fetched) return;
      if (!provider.keyConfigured && (provider.modelsMode || 'auto') !== 'manual') return;
      fetched = true;
      fastSelect.disabled = true;
      fastStatus = 'loading';
      syncFastUi();
      try {
        await request('refreshModels', { providerId: provider.id });
        fastStatus = '';
      } catch (failure) {
        fastStatus = t('models.fastFetchFailed', { message: failure.message || '' });
      }
      fastSelect.disabled = false;
      rebuildFastOptions();
      syncFastUi();
    };
    fastCheck.addEventListener('change', () => {
      rebuildFastOptions();
      syncFastUi();
      if (fastCheck.checked) fetchFast();
    });
    rebuildFastOptions();
    syncFastUi();
    if (fastCheck.checked) fetchFast();
    form.append(element('div', { class: 'field-grid' }, field(t('models.modelId'), id), field(t('models.displayName'), label)),
      fastSection,
      element('details', { class: 'fold', open: effortMode.value === 'manual' }, element('summary', { text: t('models.advanced') }),
        element('div', { class: 'field-grid' }, field(t('models.contextWindow'), contextWindow), field(t('models.maxOutput'), maxOutputTokens)),
        effortField, reasoningField, manual));
    const remove = model ? deleteButton(dialog, t('models.deleteModelTitle'), t('models.deleteModelBody', { provider: provider.name, model: model.label || model.id }),
      () => request('updateModels', { providerId: provider.id, changes: [], removeIds: [model.id] })) : null;
    finishDialog(dialog, form, model ? t('common.save') : t('models.addSubmit'), async () => {
      const saved = { id: id.value.trim(), label: label.value.trim() || id.value.trim(),
        contextWindow: Number(contextWindow.value), maxOutputTokens: Number(maxOutputTokens.value), effortMode: effortMode.value,
        reasoningEffort: reasoning.value === 'auto' ? null : reasoning.value === 'yes',
        efforts: effortMode.value === 'manual' ? [...new Set(efforts.value.split(/[,，\s]+/).map(value => value.trim()).filter(Boolean))] : [] }; // i18n-data: accepts a full-width comma as a list separator in user input
      if (fastCheck.checked) {
        if (!fastSelect.value) throw new Error(t('models.fastRequired'));
        if (fastSelect.value === id.value.trim()) throw new Error(t('models.fastSelf'));
        saved.fastModel = fastSelect.value;
      } else saved.fastModel = null;
      if (saved.fastModel) {
        const listed = (fastProvider().models || []).some(entry => entry.id === saved.fastModel);
        if (!listed) {
          const candidates = state().importCandidates;
          if (!candidates || candidates.providerId !== provider.id || !(candidates.models || []).some(entry => entry.id === saved.fastModel)) {
            throw new Error(t('models.fastNotListed'));
          }
          try {
            await request('importModels', { providerId: provider.id, token: candidates.token, ids: [saved.fastModel] });
          } catch (failure) {
            fetched = false;
            fetchFast();
            throw failure;
          }
        }
      }
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

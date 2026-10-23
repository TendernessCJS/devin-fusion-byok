'use strict';
function pageMarkup() {
  return `
      <div class="models-layout">
        <div><div class="section-head"><h2>供应商</h2><button id="add-provider" class="quiet" type="button" disabled>添加</button></div><nav id="providers" class="provider-nav" aria-label="供应商列表"></nav></div>
        <div id="models"></div>
      </div>`;
}

function createModelsView(ui) {
  const { selection, request, run, notice, remember, element, byId, button, switchInput, input, field,
    openDialog, finishDialog, deleteButton, focusTargets, scrollTargets, normalizeBaseUrlPath, modelEfforts } = ui;
  const state = () => ui.state();
  const busy = () => ui.busy();
  const currentProvider = ui.currentProvider;
  const hostOf = ui.hostOf;

  function renderProviders() {
    const container = byId('providers');
    container.replaceChildren();
    if (!state().providers.length) {
      container.append(element('p', { class: 'hint', text: '还没有供应商。' }));
      return;
    }
    for (const provider of state().providers) {
      const on = provider.models.filter(model => model.enabled !== false).length;
      container.append(element('button', {
        type: 'button', class: 'provider-item' + (provider.id === selection.providerId ? ' selected' : ''),
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
      element('span', { class: 'row-sub', text: provider.enabled === false ? '已停用' : on + ' 个模型' })));
    }
  }

  function renderModels() {
    const container = byId('models');
    const provider = currentProvider();
    container.replaceChildren();
    if (!provider) {
      container.append(element('div', { class: 'list' }, element('div', { class: 'empty' },
        element('p', { text: '添加一个 OpenAI 或 Anthropic 兼容的 API，就能在 Devin 里用它的模型。' }),
        button('添加供应商', () => providerDialog(), ''))));
      return;
    }
    const format = { 'openai-responses': 'Responses', anthropic: 'Anthropic Messages' }[provider.apiFormat] || 'Chat Completions';
    container.append(element('div', { class: 'provider-head' },
      element('div', { class: 'row-main' }, element('h2', { text: provider.name }),
        element('span', { class: 'row-sub', text: hostOf(provider.baseUrl) + ' · ' + format + (provider.keyConfigured ? '' : ' · 未填密钥') })),
      element('div', { class: 'actions' },
        switchInput(provider.enabled !== false, '启用供应商 ' + provider.name,
          value => run(() => request('setProviderEnabled', { id: provider.id, enabled: value }))),
        button('编辑', () => providerDialog(provider), 'quiet'))));
    if (provider.enabled === false) container.append(element('p', { class: 'warn mb', text: '已停用，这里的模型不会出现在新对话里。' }));
    const search = element('input', { type: 'search', placeholder: '搜索模型', 'aria-label': '搜索导入的模型',
      oninput: event => { selection.modelSearch = event.target.value; renderModelRows(); } });
    search.value = selection.modelSearch;
    focusTargets.set('model-search', search);
    const importButton = button('导入模型', () => provider.keyConfigured
      ? run(async () => {
        await request('refreshModels', { providerId: provider.id });
        importDialog(provider.id);
      }, '正在获取模型列表…', '请勾选要导入的模型。')
      : notice('该供应商未配置 API 密钥，请先添加密钥再导入模型。', 'error'), '');
    if (!provider.keyConfigured) importButton.title = '未配置 API 密钥';
    container.append(element('div', { class: 'toolbar' }, provider.models.length ? search : element('span', { class: 'spacer' }),
      importButton, button('手动添加', () => modelDialog(provider))));
    const list = element('div', { id: 'model-list', class: 'list scroll', 'aria-label': '模型列表' });
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
      container.append(element('div', { class: 'empty', text: provider.models.length ? '没有匹配的模型。' : '还没有模型，点「导入模型」从供应商获取。' }));
      return;
    }
    if (models.length > 1) {
      const bulk = value => {
        const changes = models.filter(model => (model.enabled !== false) !== value).map(model => ({ id: model.id, enabled: value }));
        if (changes.length) run(() => request('updateModels', { providerId: provider.id, changes }));
      };
      const filtered = models.length < provider.models.length;
      container.append(element('div', { class: 'row compact' },
        element('span', { class: 'row-main hint', text: (filtered ? '筛选出 ' + models.length + ' 个 · ' : '')
          + models.filter(model => model.enabled !== false).length + ' / ' + models.length + ' 已启用' }),
        button(filtered ? '启用这些' : '全部启用', () => bulk(true), 'quiet'),
        button(filtered ? '停用这些' : '全部停用', () => bulk(false), 'quiet')));
    }
    const fmtTokens = value => value >= 1000000 ? (Math.round(value / 100000) / 10) + 'M'
      : value >= 1000 ? Math.round(value / 1000) + 'K' : String(value);
    for (const model of models) {
      const name = model.label || model.id;
      const caps = [];
      const variants = modelEfforts(model).length;
      if (variants > 1) caps.push(variants + ' 档');
      if (model.contextWindow) caps.push(fmtTokens(model.contextWindow) + ' Context');
      const sub = [name !== model.id ? model.id : '', ...caps].filter(Boolean).join(' · ');
      container.append(element('div', { class: 'row' },
        element('div', { class: 'row-main' },
          element('button', { type: 'button', class: 'link-title', text: name, 'aria-label': '编辑模型 ' + name, onclick: () => modelDialog(provider, model) }),
          sub ? element('span', { class: 'row-sub mono', text: sub }) : null),
        switchInput(model.enabled !== false, '启用模型 ' + name,
          value => run(() => request('updateModels', { providerId: provider.id, changes: [{ id: model.id, enabled: value }] })))));
    }
  }

  function importDialog(providerId) {
    const candidates = state().importCandidates;
    if (!candidates || candidates.providerId !== providerId) throw new Error('模型列表已失效，请重新获取。');
    const { dialog, form } = openDialog('导入模型');
    form.classList.add('import-picker');
    const selected = new Set();
    const search = input('', { type: 'search', placeholder: '搜索模型', 'aria-label': '搜索可导入的模型' });
    const list = element('div', { class: 'list scroll', 'aria-label': '可导入的模型列表' });
    const count = element('span', { class: 'hint', role: 'status' });
    let submit;
    const visible = () => {
      const query = search.value.trim().toLocaleLowerCase();
      return candidates.models.filter(model => (model.id + ' ' + model.label).toLocaleLowerCase().includes(query));
    };
    const updateCount = () => {
      count.textContent = '已选 ' + selected.size + ' / 共 ' + candidates.models.length;
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
          model.imported ? element('span', { class: 'hint', text: '已导入' }) : null));
      }
      if (!list.childElementCount) list.append(element('p', { class: 'empty', text: candidates.models.length ? '没有匹配的模型。' : '供应商没有返回模型。' }));
      updateCount();
    };
    search.addEventListener('input', renderRows);
    form.append(element('div', { class: 'toolbar' }, search),
      element('div', { class: 'toolbar' }, button('全选', () => {
        for (const model of visible()) if (!model.imported) selected.add(model.id);
        renderRows();
      }, 'quiet'), button('清空', () => { selected.clear(); renderRows(); }, 'quiet'), element('span', { class: 'spacer' }), count), list);
    submit = finishDialog(dialog, form, '导入', () => request('importModels', { providerId, token: candidates.token, ids: [...selected] }), null, '已导入。');
    renderRows();
  }

  function providerDialog(provider) {
    const { dialog, form } = openDialog(provider ? '编辑供应商' : '添加供应商');
    const name = input(provider?.name, { required: true, maxlength: 80, placeholder: '例如：OpenRouter' });
    const baseUrl = input(provider?.baseUrl, { type: 'url', required: true, placeholder: 'https://example.com/v1', spellcheck: 'false' });
    const apiFormat = element('select', { 'aria-label': 'API 类型' },
      element('option', { value: 'openai-responses', text: 'OpenAI Responses' }),
      element('option', { value: 'openai', text: 'OpenAI Chat Completions' }),
      element('option', { value: 'anthropic', text: 'Anthropic Messages' }));
    apiFormat.value = provider?.apiFormat || 'openai-responses';
    const apiKey = input('', { type: 'password', autocomplete: 'new-password', placeholder: provider?.keyConfigured ? '留空则不修改' : '', spellcheck: 'false' });
    const urlField = field('API 地址', baseUrl, '只填域名时会自动补上 /v1；写了路径就按原样使用，例如 /v1、/api/paas/v4、/openai 都原样保留。');
    const urlPreview = element('span', { class: 'hint url-preview' });
    urlField.append(urlPreview);
    const refreshPreview = () => {
      let url;
      try { url = new URL(baseUrl.value.trim()); } catch { url = null; }
      urlPreview.replaceChildren();
      if (!url || !['http:', 'https:'].includes(url.protocol)) return;
      const base = url.origin + normalizeBaseUrlPath(url.pathname);
      const path = { openai: '/chat/completions', anthropic: '/messages' }[apiFormat.value] || '/responses';
      urlPreview.append('实际请求：' + base + path, element('br'), '获取模型：' + base + '/models');
      // /v1 is appended only for a bare host. Saying so outright beats leaving
      // the user to reverse-engineer the rule from the two URLs above — the
      // failure mode of getting it wrong is a silent 404.
      if (url.pathname.replace(/\/+$/, '') === '') urlPreview.append(element('br'), '地址只填了域名，已自动补 /v1');
    };
    baseUrl.addEventListener('input', refreshPreview);
    apiFormat.addEventListener('change', refreshPreview);
    refreshPreview();
    form.append(field('名称', name), urlField, field('API 类型', apiFormat), field('API 密钥', apiKey));
    const remove = provider ? deleteButton(dialog, '删除供应商？', '会一并移除“' + provider.name + '”导入的模型；用到它们的 Fusion 组合会失效。',
      () => request('deleteProvider', { id: provider.id })) : null;
    finishDialog(dialog, form, '保存', () => {
      const payload = { name: name.value.trim(), baseUrl: baseUrl.value.trim(), apiFormat: apiFormat.value };
      if (provider) payload.id = provider.id;
      if (apiKey.value.trim()) payload.apiKey = apiKey.value.trim();
      return request('saveProvider', payload);
    }, remove);
  }

  function modelDialog(provider, model) {
    const { dialog, form } = openDialog(model ? '编辑模型' : '手动添加模型');
    const id = input(model?.id, { required: true, readOnly: Boolean(model), maxlength: 256, placeholder: '供应商的模型 ID', spellcheck: 'false' });
    const label = input(model?.label || '', { maxlength: 160, placeholder: '留空使用模型 ID' });
    const contextWindow = input(model?.contextWindow || 272000, { type: 'number', min: 1, step: 1, required: true });
    const maxOutputTokens = input(model?.maxOutputTokens || 131072, { type: 'number', min: 1, step: 1, required: true });
    const efforts = input((model?.efforts || []).join(', '), { placeholder: 'low, medium, high', spellcheck: 'false' });
    const effortMode = element('select', { 'aria-label': '思考档位' },
      element('option', { value: 'auto', text: '自动' }),
      element('option', { value: 'manual', text: '手动填写' }),
      element('option', { value: 'none', text: '不指定' }));
    effortMode.value = model?.effortMode || (model?.efforts?.length ? 'manual' : 'auto');
    const manual = field('档位列表', efforts, '用逗号分隔。');
    manual.hidden = effortMode.value !== 'manual';
    effortMode.addEventListener('change', () => { manual.hidden = effortMode.value !== 'manual'; });
    form.append(field('模型 ID', id), field('显示名称', label),
      element('details', { class: 'fold', open: effortMode.value === 'manual' }, element('summary', { text: '高级' }),
        element('div', { class: 'field-grid' }, field('上下文（tokens）', contextWindow), field('最大输出（tokens）', maxOutputTokens)),
        field('思考档位', effortMode, '自动：GPT/o 系列与较新的 Claude Opus/Sonnet 提供 Low、Medium、High、XHigh、Max，能否生效取决于供应商。'), manual));
    const remove = model ? deleteButton(dialog, '删除模型？', '从“' + provider.name + '”移除“' + (model.label || model.id) + '”，之后可以重新导入。',
      () => request('updateModels', { providerId: provider.id, changes: [], removeIds: [model.id] })) : null;
    finishDialog(dialog, form, model ? '保存' : '添加', () => {
      const saved = { id: id.value.trim(), label: label.value.trim() || id.value.trim(),
        contextWindow: Number(contextWindow.value), maxOutputTokens: Number(maxOutputTokens.value), effortMode: effortMode.value,
        efforts: effortMode.value === 'auto' ? [] : [...new Set(efforts.value.split(/[,，\s]+/).map(value => value.trim()).filter(Boolean))] };
      if (model) return request('updateModels', { providerId: provider.id, changes: [{ ...saved, supportsImages: true }] });
      return request('addModel', { providerId: provider.id, model: { ...saved, enabled: true } });
    }, remove);
  }

  return {
    render() { renderProviders(); renderModels(); },
    bind() { byId('add-provider').addEventListener('click', () => providerDialog()); },
  };
}

module.exports = { pageMarkup, createModelsView };

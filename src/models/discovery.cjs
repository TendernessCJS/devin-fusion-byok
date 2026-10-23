'use strict';
const { directFetch } = require('../proxy.cjs');
const { ModelDiscoveryError } = require('./discovery-error.cjs');

// Model lists arrive in one of two shapes: the OpenAI body itself, or that body
// wrapped in the gateway's own envelope ({code, message, data: {object, data}}).
// Only the bare shape was accepted, so an envelope was reported as "no model
// list" — a message users read as "this provider has no /models endpoint",
// hiding the real cause behind a wrong conclusion.
function modelList(json) {
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.data?.data)) return json.data.data;
  return null;
}
async function discover(provider, { request = directFetch } = {}) {
  const anthropic = provider.apiFormat === 'anthropic';
  const headers = anthropic ? { 'anthropic-version': '2023-06-01', 'x-api-key': provider.apiKey } : { Authorization: 'Bearer ' + provider.apiKey };
  const listed = [];
  let after = null;
  // Anthropic's /models is paginated; OpenAI-compatible providers return a single page.
  for (let page = 0; page < 20; page++) {
    const url = new URL(provider.baseUrl.replace(/\/$/, '') + '/models');
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API 地址必须以 http:// 或 https:// 开头');
    if (anthropic) { url.searchParams.set('limit', '1000'); if (after) url.searchParams.set('after_id', after); }
    const response = await request(url, { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new ModelDiscoveryError(response.status);
    const json = await response.json();
    const list = modelList(json);
    if (!list) throw new Error('API 未返回模型列表');
    listed.push(...list);
    if (!anthropic || !json.has_more || typeof json.last_id !== 'string' || json.last_id === after) break;
    after = json.last_id;
  }
  const old = new Map(provider.models.map(m => [m.id, m]));
  const limits = new Map(listed.filter(m => m && typeof m.id === 'string').map(m => [m.id, m]));
  const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  provider.models = [...new Set(listed.map(m => m?.id).filter(id => typeof id === 'string' && id.length <= 256))].map(id => {
    if (old.has(id)) return old.get(id);
    const info = limits.get(id);
    const contextWindow = positive(info.max_input_tokens) ?? 272000;
    const maxOutputTokens = Math.min(positive(info.max_tokens) ?? 131072, contextWindow);
    return { id, label: provider.name + ' · ' + id, efforts: [], contextWindow, maxOutputTokens };
  });
  return provider.models.length;
}
module.exports = { modelList, discover };

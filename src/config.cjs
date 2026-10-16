'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { directFetch } = require('./proxy.cjs');

function readConfig(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}
function defaultConfig() { return { enabled: true, providers: [] }; }
// Retired keys: everything the named-preset pipeline used to own, plus empty
// role override maps. The one-shot migration that lifted saved presets into
// `roleInclusions` has run everywhere this fork is installed (verified against
// the live config), so these are dead weight now — and a dead key with no
// cleanup path would sit in a user's config forever with no way to remove it
// from the panel.
function pruneRetiredKeys(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  let changed = false;
  for (const key of ['sidekicks', 'fusionPresets', 'defaultFusionUid', 'fusionMatrix']) {
    if (!Object.hasOwn(config, key)) continue;
    delete config[key];
    changed = true;
  }
  for (const key of ['roleExclusions', 'roleInclusions']) {
    if (!Object.hasOwn(config, key)) continue;
    const value = config[key];
    const roles = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    if (!roles || Object.values(roles).every(list => !Array.isArray(list) || list.length === 0)) { delete config[key]; changed = true; }
  }
  return changed;
}
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
// 404/405 means the route itself is absent — common for gateways that only proxy
// inference. Name the escape hatch instead of leaving a bare status the user
// reads as "no model list here". Any other status keeps the plain message: it
// says nothing about whether the route exists.
function discoveryError(status) {
  if (status === 404 || status === 405) {
    return new Error(`获取模型失败：HTTP ${status}（该供应商可能未提供 /models，可在供应商卡片里用「手动添加」录入模型）`);
  }
  return new Error('获取模型失败：HTTP ' + status);
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
    if (!response.ok) throw discoveryError(response.status);
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
module.exports = { readConfig, writeConfig, defaultConfig, pruneRetiredKeys, discover };

'use strict';
// Locates the installed Devin picker logic by code shape instead of minified
// identifiers, which change on every Devin build.
//
// Two independent capability probes: the legacy chat-client renderer (older
// Devin picker) and the 3.11 webapp bundle under devin-webapp-host/assets. A
// missing file is the only skip condition — when a bundle exists but an anchor
// is absent, duplicated or relocated, the loader throws instead of skipping.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DEFAULT_APP_ROOT = '/Applications/Devin.app/Contents/Resources/app';
const appRoot = root => root || process.env.DFBYOK_TEST_APP_ROOT || DEFAULT_APP_ROOT;
const rendererFileOf = root => path.join(appRoot(root), 'out/vs/workbench/windsurf-chat-client/index.js');
const webappDirOf = root => path.join(appRoot(root), 'out/vs/workbench/devin-webapp-host/assets');

// Directory listings and file contents are cached per install root so each
// test does not re-scan the whole assets directory.
const legacySources = new Map();
const load = root => {
  const file = rendererFileOf(root);
  if (!legacySources.has(file)) legacySources.set(file, fs.readFileSync(file, 'utf8'));
  return legacySources.get(file);
};

const webappBundles = new Map();
// The assets directory being absent is the only skip channel: a present
// directory means this install is supposed to have the picker, so an anchor
// that is missing, duplicated or unreadable is a layout change — it must fail
// loudly, never degrade into a silent skip.
function webappBundle(root, anchor = 'catalogMisses') {
  const dir = webappDirOf(root);
  const key = dir + '|' + anchor;
  if (!webappBundles.has(key)) {
    let names;
    try { names = fs.readdirSync(dir); }
    catch (error) {
      // ENOENT is the only skip channel; any other failure is drift, loudly.
      if (error?.code === 'ENOENT') return null;
      throw new Error(`installed Devin layout changed: ${dir} unreadable (${error.code || error.message})`);
    }
    const found = [];
    for (const name of names) {
      if (!name.endsWith('.js')) continue;
      const file = path.join(dir, name);
      let source;
      try { source = fs.readFileSync(file, 'utf8'); }
      catch (error) { throw new Error(`installed Devin layout changed: ${file} unreadable (${error.code || error.message})`); }
      if (source.includes(anchor)) found.push({ file, source });
    }
    if (!found.length) throw new Error(`installed Devin layout changed: no bundle in ${dir} carries '${anchor}'`);
    if (found.length > 1) throw new Error(`installed Devin layout changed: '${anchor}' matches ${found.length} bundles (${found.map(hit => path.basename(hit.file)).join(', ')})`);
    webappBundles.set(key, found[0]);
  }
  return webappBundles.get(key);
}

const rendererFile = rendererFileOf();
const legacyAvailable = fs.existsSync(rendererFile);
// Only a truly absent path may skip; a file at the assets path or an
// unreadable directory still counts as "supposed to have the picker" and must
// fail through the loaders, not hide as absent.
let webappAvailable;
try { fs.statSync(webappDirOf()); webappAvailable = true; }
catch (error) { webappAvailable = error?.code === 'ENOENT' ? false : true; }

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`function ${name} is unterminated`);
}

function required(match, what) {
  if (!match) throw new Error(`installed Devin anchor not found: ${what}`);
  return match;
}

// Minified names may contain `$` (e.g. `$n`), which is a regex assertion.
const esc = name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Family grouping + row selection: returns { group(models), rows(grouped) }.
function loadFamilyPicker(root) {
  const source = load(root);
  const grouping = required(source.match(/function (\w+)\(e\)\{let t=new Map,n=\[\];for\(let r of e\)\{let e=r\.familyUid;/), 'family grouping');
  const wrapper = required(source.match(new RegExp(`function (\\w+)\\(e,t\\)\\{let\\{families:n\\}=${grouping[1]}\\(t\\?\\?e\\)`)), 'grouped picker input');
  const rows = required(source.match(/function (\w+)\(e,t,n,r,i\)\{let\{fullFamilies:a,families:o,ordered:s\}=e/), 'picker rows');
  const start = source.indexOf(grouping[0]);
  const rowsStart = source.indexOf(rows[0], start);
  const end = rowsStart + functionSource(source, rows[1]).length;
  if (!(start >= 0 && rowsStart > start)) throw new Error('installed Devin family picker range');
  const api = vm.runInNewContext(`${source.slice(start, end)};({group:${wrapper[1]},rows:${rows[1]}})`);
  return { group: models => api.group(models), rows: models => api.rows(api.group(models), [], undefined, false) };
}

// ACP session option intersection: returns { options(session), filter(session, models) }.
function loadAcpPicker(root) {
  const source = load(root);
  const use = required(source.match(/let e=(\w+)\((\w+)\.options\);return (\w+)\.filter\(t=>e\.has\(t\.modelUid\)\|\|t\.disabled\)/), 'session/catalog intersection');
  const collector = required(source.match(new RegExp(`function ${use[1]}\\(e\\)\\{let t=new Set;for\\(let n of e\\)if\\((\\w+)\\(n\\)\\)`)), 'session option collector');
  const code = `${functionSource(source, collector[1])};${functionSource(source, use[1])};${use[1]}`;
  const collect = vm.runInNewContext(code);
  const select = new Function(use[1], use[2], use[3], use[0]);
  return { collect, filter: (session, models) => select(collect, session, models) };
}

// The 3.11 agent-window picker lives in the webapp bundle, not the old chat
// client. It intersects each model configOption with the userStatus catalog:
// option values absent from catalog.models become catalogMisses (dropped from
// the UI), catalog models present in the options render under catalog.sorts.
// Extracts the real intersection function; icon/image lookups are stubbed.
function loadWebappPicker(root) {
  const bundle = webappBundle(root);
  if (!bundle) throw new Error('installed Devin webapp picker bundle not found');
  const source = bundle.source;
  const pick = required(source.match(/function ([\w$]+)\(e,t=null,n=!1\)\{let r=(\w+)\(e\.options\),i=t\?new Map\(t\.models\.map\(e=>\[e\.modelUid,e\]\)\):void 0;if\(t&&n\)/), 'webapp picker intersection');
  const flatten = required(source.match(/([\w$]+)=e=>e.flatMap\(e=>`group`in e\?e\.options:\[e\]\)/), 'option flattener');
  const mapper = required(source.match(/function ([\w$]+)\(e\)\{return\{label:e\.name,modelUid:e\.value,icon:(\w+)\(e,[\s\S]{0,160}?supportsImages:(\w+)\(e\)/), 'option mapper');
  const merge = required(source.match(/function (\w+)\(e,t\)\{return t\?\{\.\.\.e,provider:t\.provider/), 'catalog merge');
  const optionMerge = required(source.match(new RegExp(`function ([\\w$]+)\\(e,t\\)\\{return\\{\\.\\.\\.${esc(merge[1])}\\(${esc(mapper[1])}\\(e\\),t\\),label:t\\.label,icon:void 0,displayOption:([\\w$]+)\\(t\\.displayOption\\)\\}`)), 'catalog option merge');
  const disabled = required(source.match(new RegExp(`function ([\\w$]+)\\(e\\)\\{return\\{\\.\\.\\.${esc(merge[1])}\\(\\{label:e\\.label,modelUid:e\\.modelUid`)), 'disabled merge');
  const misses = required(source.match(/catalogMisses:([\w$]+)\}/), 'miss bucket');
  const display = required(source.match(/([\w$]+)=e=>e===`modern-agent-chat`\?`standard-picker`:e/), 'display mapper');
  const code = `var ${flatten[1]}=e=>e.flatMap(e=>'group' in e?e.options:[e]);var ${misses[1]}=[];var ${display[1]}=e=>e==='modern-agent-chat'?'standard-picker':e;`
    + `${functionSource(source, mapper[1])};${functionSource(source, merge[1])};${functionSource(source, optionMerge[1])};${functionSource(source, disabled[1])};${functionSource(source, pick[1])};${pick[1]}`;
  return vm.runInNewContext(code, { [mapper[2]]: () => null, [mapper[3]]: () => undefined });
}

// Recommended-group sorter that marks the router-only group as featured.
function loadGroupSorter(root) {
  const source = load(root);
  const hit = required(source.match(/function (\w+)\(e,t=\w+,n=\(\)=>!0\)\{return e\.map\(e=>\{let r=e\.groups\.map\(e=>\(\{groupName:e\.groupName,options:e\.options\.filter\(n\)\.map\(e=>t\(e\)\),isFeatured:!!\(e\.options\.length>0&&e\.options\.every\(e=>e\.modelInfo\?\.displayOption===(\w+)\.MODEL_ROUTER\)\)\|\|void 0/), 'featured group sorter');
  const sorter = vm.runInNewContext(`${functionSource(source, hit[1]).replace(/t=\w+,n=/, 't=e=>e,n=')};${hit[1]}`, { [hit[2]]: { MODEL_ROUTER: 3 } });
  return sorter;
}

// The catalog mapper in modelCatalogSource-*.js: a full ES module whose only
// external inputs are protobuf-es enum objects and rolldown helpers. The whole
// file is evaluated with the enum values it imports supplied by name — the
// init block at the bottom builds the real partner/provider maps itself.
function loadModelCatalogMapper(root) {
  const bundle = webappBundle(root, 'mapModelCatalog:()=>');
  if (!bundle) throw new Error('installed Devin model-catalog mapper bundle not found');
  // The bundle is a single minified line: strip ESM syntax by pattern.
  const body = bundle.source.replace(/import\{[^}]*\}from"[^"]*";/g, '').replace(/export\{[^}]*\};?\s*$/, '');
  const context = {
    console, e: fn => fn, t: value => value,
    u: { UNSPECIFIED: 0, WINDSURF: 1, OPENAI: 2, ANTHROPIC: 3, GOOGLE: 4, XAI: 5, DEEPSEEK: 6,
      MOONSHOT: 7, QWEN: 8, ZAI: 9, MINIMAX: 10, NVIDIA: 11, THINKING_MACHINES: 12, META: 13 },
    c: { UNSPECIFIED: 0, LOW: 1, MEDIUM: 2, HIGH: 3, FREE: 4 },
    r: { FRH: 0, IL4: 1, IL5: 2, IL6: 3, ITAR: 4 },
    l: { OPENAI: 1 }, o: () => {},
    s: { UNSPECIFIED: 0, STATIC_CREDIT: 1, API: 2, BYOK: 3, ACU_TOKEN: 4, ACU_CREDIT: 5 },
    i: { UNSPECIFIED: 0, COST: 1, COST_FUZZY: 2, COST_UNIT: 3, TEXT: 4 },
    n: { UNSPECIFIED: 0, HIGHLIGHT: 1 },
    d: { UNSPECIFIED: 0, ARENA: 1, BATTLE_GROUP_ONLY: 2, MODEL_ROUTER: 3, QUICK_REVIEW: 4,
      MIMIC: 5, HIDDEN_TOOL: 6, COMPACTOR: 7, MODERN_AGENT_CHAT: 8 },
    a: {},
  };
  // The enum maps sit behind a lazy initializer (rolldown pattern); the export
  // record is lazy too: `mapModelCatalog: () => C` — one call unwraps each.
  const init = required(body.match(/function (\w+)\(\)\{return\(\1=\w+\(\(\(\)=>\{\w+\(\),T=\{/), 'mapper enum initializer');
  return vm.runInNewContext(`${body};${init[1]}();f`, context).mapModelCatalog();
}

// The family pipeline lives in one app-initial bundle. Minified names change
// with every Devin build, so each role is resolved by body shape and reported
// under the historical key the tests already use. 3.11.238 renamed the whole
// set (grouping Nt -> Rt, rows Kt -> Zt) and left `function Nt(e){let t=new
// Map` in an unrelated bundle — anchoring on a name picked the wrong file.
const FAMILY_SHAPES = {
  // grouping: models -> { families, ungrouped }
  Nt: /function (\w+)\(e\)\{let t=new Map,n=\[\];for\(let r of e\)\{let e=r\.familyUid;/,
  // dimension dedupe: models -> [{ name, values }] sorted by order
  Pt: /function (\w+)\(e\)\{let t=new Map;for\(let n of e\)if\(n\.familyMetadata\)for\(let\[e,r\]of Object\.entries\(n\.familyMetadata\)\)\{/,
  // toggle: exactly two values, both unnamed
  Ft: /function (\w+)\(e\)\{return e\.length===2&&e\.every\(e=>e\.name===``\)\}/,
  // rows builder: takes the grouped input and reads fullFamilies/families/ordered
  Kt: /function (\w+)\(e,t,n,r,i\)\{let\{fullFamilies:a,families:o,ordered:s\}=e/
};

const familyPipelines = new Map();
function loadFamilyPipeline(root) {
  const dir = webappDirOf(root);
  if (familyPipelines.has(dir)) return familyPipelines.get(dir);
  let names;
  try { names = fs.readdirSync(dir); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error('installed Devin family pipeline bundle not found');
    throw new Error(`installed Devin layout changed: ${dir} unreadable (${error.code || error.message})`);
  }
  const hits = [];
  for (const name of names) {
    if (!name.endsWith('.js')) continue;
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    const grouping = source.match(FAMILY_SHAPES.Nt);
    if (grouping) hits.push({ name, source, grouping });
  }
  if (!hits.length) throw new Error(`installed Devin layout changed: no bundle in ${dir} carries the family grouping shape`);
  if (hits.length > 1) throw new Error(`installed Devin layout changed: the family grouping shape matches ${hits.length} bundles (${hits.map(hit => hit.name).join(', ')})`);
  const { source, grouping } = hits[0];
  const resolved = { Nt: grouping[1] };
  for (const key of ['Pt', 'Ft', 'Kt']) resolved[key] = required(source.match(FAMILY_SHAPES[key]), `family pipeline shape ${key}`)[1];
  // Two-argument wrapper: families of `t ?? e` as fullFamilies, `e` as ordered.
  resolved.Gt = required(source.match(new RegExp(`function (\\w+)\\(e,t\\)\\{let\\{families:\\w+\\}=${grouping[1]}\\(t\\?\\?e\\)`)), 'grouped picker input')[1];
  // Dimension selection with prefix fallback: reads the current model's orders
  // through the collector, then walks back over the earlier dimensions.
  resolved.Ut = required(source.match(/function (\w+)\(e,t,n,r\)\{let \w+=\w+\(t,e\.dimensions\),\w+=e\.dimensions\[n\]/), 'dimension selection')[1];
  const start = source.indexOf(grouping[0]);
  const rowsStart = source.indexOf(`function ${resolved.Kt}(`);
  if (!(start >= 0 && rowsStart > start)) throw new Error('installed Devin family pipeline range');
  const end = rowsStart + functionSource(source, resolved.Kt).length;
  const exported = Object.entries(resolved).map(([key, name]) => `${key}:${name}`).join(',');
  const api = vm.runInNewContext(`${source.slice(start, end)};({${exported}})`);
  familyPipelines.set(dir, api);
  return api;
}

module.exports = { rendererFile, available: legacyAvailable, legacyAvailable, webappAvailable,
  loadFamilyPicker, loadAcpPicker, loadWebappPicker, loadGroupSorter, loadModelCatalogMapper, loadFamilyPipeline };

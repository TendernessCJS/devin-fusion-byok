'use strict';
// Guards that keep the translation from rotting:
//  - zh-CN and en carry the same keys and the same placeholders;
//  - every literal key the code asks for exists;
//  - no new hardcoded CJK copy appears in src/ outside the string table.
// The CJK scan is fail-closed: every src/ file is checked unless it is listed
// in EXEMPT_FILES below (with the reason), and a single line is exempt only
// when it carries an `i18n-data:` comment saying why the text is not UI copy
// (a value another module emits or matches, or text for the model).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zh = require('../src/i18n/locales/zh-CN.cjs');
const en = require('../src/i18n/locales/en.cjs');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;
const LINE_MARKER = 'i18n-data:';
const EXEMPT_FILES = {
  'i18n/locales/zh-CN.cjs': 'the Chinese string table itself',
  'i18n/locales/en.cjs': 'the English table (language names are shown as themselves)',
  'goal/report.cjs': 'standalone CLI the model runs to file Goal reports; its output is read by the model and it has no editor language',
  'fast-context/server.cjs': 'standalone MCP server; its tool output is read by other agents, not shown in this UI',
  'update/updater.cjs': 'the update mechanism was left untouched by the i18n change; its copy is not in the table yet',
};
const rel = file => path.relative(SRC, file).split(path.sep).join('/');
const srcFiles = (dir = SRC) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? srcFiles(full) : entry.name.endsWith('.cjs') ? [full] : [];
});

// Returns the source with comments blanked out (newlines kept, so line numbers
// survive). Strings, template literals (with ${} nesting) and regex literals
// are kept, because that is where hardcoded copy would live.
function stripComments(source) {
  let out = '', i = 0, last = '';
  const stack = [];
  const regexAllowed = () => !last || /[(,=:[!&|?{};+\-*%<>~^]$/.test(last) || /\b(?:return|typeof|case|do|else|in|of|void|yield|await)$/.test(last);
  const push = text => { out += text; const trimmed = text.trim(); if (trimmed) last = (last + trimmed).slice(-12); };
  while (i < source.length) {
    const ch = source[i], next = source[i + 1];
    const inTemplate = stack.length && stack[stack.length - 1] === 'template';
    if (inTemplate) {
      if (ch === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
      if (ch === '`') { stack.pop(); out += ch; i++; last = '`'; continue; }
      if (ch === '$' && next === '{') { stack.push('expr'); out += '${'; i += 2; last = '{'; continue; }
      out += ch; i++; continue;
    }
    if (ch === '/' && next === '/') { while (i < source.length && source[i] !== '\n') { out += ' '; i++; } continue; }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' '); i = stop; continue;
    }
    if (ch === '\'' || ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      push(source.slice(i, j + 1)); i = j + 1; continue;
    }
    if (ch === '`') { stack.push('template'); out += ch; i++; continue; }
    if (ch === '{' && stack.length) { stack.push('brace'); push(ch); i++; continue; }
    if (ch === '}' && stack.length) {
      const top = stack.pop();
      out += ch; i++;
      if (top === 'expr') last = '';
      else last = '}';
      continue;
    }
    if (ch === '/' && regexAllowed()) {
      let j = i + 1, inClass = false;
      while (j < source.length && source[j] !== '\n') {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) break;
        j++;
      }
      while (/[a-z]/i.test(source[j + 1] || '')) j++;
      push(source.slice(i, j + 1)); i = j + 1; continue;
    }
    push(ch); i++;
  }
  return out;
}

function hardcodedCjk(source) {
  const raw = source.split('\n');
  return stripComments(source).split('\n').flatMap((line, index) =>
    CJK.test(line) && !raw[index].includes(LINE_MARKER) ? [{ line: index + 1, text: raw[index].trim().slice(0, 140) }] : []);
}

test('zh-CN and en carry exactly the same keys', () => {
  const zhKeys = new Set(Object.keys(zh)), enKeys = new Set(Object.keys(en));
  assert.deepEqual([...zhKeys].filter(key => !enKeys.has(key)), [], 'keys missing from en.cjs');
  assert.deepEqual([...enKeys].filter(key => !zhKeys.has(key)), [], 'keys missing from zh-CN.cjs');
});

test('every entry is non-empty text and both languages use the same placeholders', () => {
  const placeholders = value => [...new Set([...value.matchAll(/\{(\w+)(?:\|[^|{}]*\|[^|{}]*)?\}/g)].map(match => match[1]))].sort();
  for (const key of Object.keys(zh)) {
    for (const [name, table] of [['zh-CN', zh], ['en', en]])
      assert.ok(typeof table[key] === 'string' && table[key].trim(), `${name} ${key} must be non-empty text`);
    assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), `${key}: en and zh-CN must fill the same placeholders`);
  }
});

test('the English table has no Chinese except the language names the option shows as themselves', () => {
  const allowed = new Set(['settings.language.title', 'settings.language.zh-CN']);
  const leaked = Object.keys(en).filter(key => CJK.test(en[key]) && !allowed.has(key));
  assert.deepEqual(leaked, []);
  assert.match(zh['settings.language.title'], /Language/, 'the language option is labelled bilingually');
  assert.equal(zh['settings.language.title'], en['settings.language.title']);
});

test('every literal key the code asks for exists in the table', () => {
  const missing = [];
  for (const file of srcFiles()) {
    if (rel(file).startsWith('i18n/locales/')) continue;
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    for (const match of source.matchAll(/(?<![\w$.])[th]\(\s*'([A-Za-z][\w.-]*)'\s*[,)]/g))
      if (!Object.hasOwn(zh, match[1])) missing.push(rel(file) + ': ' + match[1]);
  }
  assert.deepEqual(missing, []);
});

test('package.nls.json and package.nls.zh-cn.json localize every contributed title with the same keys', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const nls = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.json'), 'utf8'));
  const nlsZh = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.zh-cn.json'), 'utf8'));
  assert.deepEqual(Object.keys(nlsZh).sort(), Object.keys(nls).sort());
  for (const command of pkg.contributes.commands) {
    const match = /^%([\w.-]+)%$/.exec(command.title);
    assert.ok(match, command.command + ' title must be a %key% placeholder');
    assert.ok(nls[match[1]] && nlsZh[match[1]], command.command + ' title resolves in both languages');
    assert.doesNotMatch(nls[match[1]], CJK, 'the default (English) title has no Chinese');
  }
  const packaged = fs.readFileSync(path.join(ROOT, 'scripts/package.cjs'), 'utf8');
  for (const name of ['package.nls.json', 'package.nls.zh-cn.json']) assert.ok(packaged.includes(`'${name}'`), name + ' ships in the VSIX');
});

test('src has no hardcoded Chinese copy outside the string table', () => {
  const found = [];
  for (const file of srcFiles()) {
    if (Object.hasOwn(EXEMPT_FILES, rel(file))) continue;
    for (const hit of hardcodedCjk(fs.readFileSync(file, 'utf8'))) found.push(`${rel(file)}:${hit.line}: ${hit.text}`);
  }
  assert.deepEqual(found, [], 'move UI copy into src/i18n/locales (both languages), or mark a non-UI value with `// ' + LINE_MARKER + ' <why>`');
  for (const file of Object.keys(EXEMPT_FILES)) assert.ok(fs.existsSync(path.join(SRC, file)), 'stale exemption: ' + file);
});

test('the CJK guard sees literals and ignores comments, markers and comment-like text inside strings', () => {
  const sample = [
    "const a = 'http://x'; // 注释不算",
    "/* 块注释 */ const b = `模板 ${x ? '嵌套' : ''}`;",
    "const c = s.replace(/清除|删除/, '');",
    "const d = '保留'; // " + LINE_MARKER + " emitted by another module",
    "const e = 1 / 2; const f = '除法之后';",
    '',
  ].join('\n');
  assert.deepEqual(hardcodedCjk(sample).map(hit => hit.line), [2, 3, 5]);
  assert.equal(hardcodedCjk("const ok = t('models.import'); // 导入模型").length, 0);
});

test('the English panel, Goal page and context page render without Chinese beyond the language option', () => {
  const { renderPanel } = require('../src/panel/view.cjs');
  const { goalHtml } = require('../src/panel/goal-view.cjs');
  const { contextHtml } = require('../src/panel/context-view.cjs');
  const visible = html => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  const panel = visible(renderPanel({ nonce: 'n', locale: 'en' })).replace(/语言 \/ Language|>中文</g, '');
  assert.doesNotMatch(panel, CJK);
  assert.match(panel, /<html lang="en">/);
  assert.doesNotMatch(visible(goalHtml('n', 'en')), CJK);
  assert.doesNotMatch(visible(contextHtml('n', 'en')), CJK);
  // The default stays the original Chinese copy.
  assert.match(renderPanel({ nonce: 'n' }), /<html lang="zh-CN">[\s\S]*重载窗口/);
});

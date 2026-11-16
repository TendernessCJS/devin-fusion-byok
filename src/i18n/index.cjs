'use strict';
// UI string tables. Only text a person reads in the UI lives here: log events,
// config keys, protocol fields, error codes and anything another part of the
// system parses stay where they are. zh-CN is the original copy and the
// fallback; en must carry exactly the same key set (test/i18n.test.cjs).
//
// Host code receives a translator by injection (no module-level locale: the
// activation services hold no shared mutable state). Webviews cannot require
// this module — their code is serialized with toString() — so they get the
// table and the same format() through browserSource().
const TABLES = Object.freeze({
  'zh-CN': require('./locales/zh-CN.cjs'),
  en: require('./locales/en.cjs'),
});
const DEFAULT_LOCALE = 'zh-CN';
const LOCALES = Object.freeze(Object.keys(TABLES));
// What the panel's language option stores; 'auto' follows the editor.
const LANGUAGE_CHOICES = Object.freeze(['auto', 'zh-CN', 'en']);

// Any zh* display language (zh-cn, zh-tw, zh-hk, …) gets the Chinese copy,
// everything else English.
function displayLocale(language) {
  return /^zh(?:$|[-_])/i.test(String(language || '')) ? 'zh-CN' : 'en';
}
function resolveLocale(choice, language) {
  return choice !== 'auto' && Object.hasOwn(TABLES, choice) ? choice : displayLocale(language);
}

// `{name}` inserts a param; `{name|one|other}` picks a word by whether the
// param equals 1 (English plurals; the Chinese copy never needs it, so both
// tables keep one key per string). Serialized into webviews: keep it
// self-contained (no closures, no helpers).
function format(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)(?:\|([^|{}]*)\|([^|{}]*))?\}/g, (match, name, one, other) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
    if (one !== undefined) return Number(params[name]) === 1 ? one : other;
    return String(params[name]);
  });
}

function lookup(table, key) {
  if (Object.hasOwn(table, key)) return table[key];
  if (Object.hasOwn(TABLES[DEFAULT_LOCALE], key)) return TABLES[DEFAULT_LOCALE][key];
  return key;
}

function translator(locale = DEFAULT_LOCALE) {
  const resolved = Object.hasOwn(TABLES, locale) ? locale : DEFAULT_LOCALE;
  const table = TABLES[resolved];
  const t = (key, params) => format(lookup(table, key), params);
  t.locale = resolved;
  return t;
}

// The panel's language choice lives in the extension's globalState (as the
// updater's own preference does): it survives updates, needs no config.json
// write, and so triggers none of the config watchers. 'auto' is stored as
// absent.
const CHOICE_KEY = 'devinFusionByok.language';
const cleanChoice = value => value === 'zh-CN' || value === 'en' ? value : 'auto';

// The per-activation service: `t` re-reads the locale on every call, so a
// language change reaches every holder of `t` without re-injection; views that
// render once (webview HTML, status bar items) re-render on onDidChange.
function createI18n({ language = () => undefined, memento = null } = {}) {
  const translators = new Map();
  const listeners = new Set();
  const choice = () => { try { return cleanChoice(memento?.get(CHOICE_KEY)); } catch { return 'auto'; } };
  const locale = () => resolveLocale(choice(), language());
  const t = (key, params) => {
    const current = locale();
    if (!translators.has(current)) translators.set(current, translator(current));
    return translators.get(current)(key, params);
  };
  Object.defineProperty(t, 'locale', { get: locale, enumerable: true });
  async function setChoice(next) {
    if (!LANGUAGE_CHOICES.includes(next)) throw new TypeError('language choice must be one of ' + LANGUAGE_CHOICES.join(', '));
    if (!memento || typeof memento.update !== 'function') throw new Error('language_unavailable');
    const previous = locale();
    await memento.update(CHOICE_KEY, next === 'auto' ? undefined : next);
    const current = locale();
    for (const listener of [...listeners]) { try { listener({ locale: current, previous, choice: choice() }); } catch {} }
    return current;
  }
  // Fires after every successful choice change, even when the resolved locale
  // stays the same (the panel's selector still has to show the new choice).
  const onDidChange = listener => { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; };
  return { t, locale, choice, setChoice, onDidChange };
}

// The webview prelude: `const t = …` at the top level of the page script, so
// every serialized view function picks it up from the enclosing scope (the
// same convention as domHelpersSource). `prefixes` trims the table to what a
// page uses. JSON is not script-safe by itself: escape `<` so no string can
// close the surrounding <script> element.
function browserSource(locale = DEFAULT_LOCALE, prefixes = null) {
  const t = translator(locale);
  const table = TABLES[t.locale];
  const entries = Object.keys(TABLES[DEFAULT_LOCALE])
    .filter(key => !prefixes || prefixes.some(prefix => key.startsWith(prefix)))
    .map(key => [key, lookup(table, key)]);
  const json = JSON.stringify(Object.fromEntries(entries)).replace(/</g, '\\u003c');
  return `const I18N = ${json};const I18N_FORMAT = ${format.toString()};` +
    'const t = (key, params) => I18N_FORMAT(Object.prototype.hasOwnProperty.call(I18N, key) ? I18N[key] : key, params);';
}

module.exports = { DEFAULT_LOCALE, LOCALES, LANGUAGE_CHOICES, CHOICE_KEY, TABLES, displayLocale, resolveLocale, format, translator, createI18n, browserSource };

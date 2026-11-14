'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const i18n = require('../src/i18n/index.cjs');

test('display languages map to zh-CN for every zh variant and to en otherwise', () => {
  for (const language of ['zh-cn', 'zh-CN', 'zh-tw', 'zh_TW', 'zh-hk', 'zh']) assert.equal(i18n.displayLocale(language), 'zh-CN', language);
  for (const language of ['en', 'en-us', 'de', 'ja', 'zhx', '', undefined, null]) assert.equal(i18n.displayLocale(language), 'en', String(language));
});

test('an explicit choice wins over the display language; auto and junk follow the editor', () => {
  assert.equal(i18n.resolveLocale('en', 'zh-cn'), 'en');
  assert.equal(i18n.resolveLocale('zh-CN', 'en'), 'zh-CN');
  assert.equal(i18n.resolveLocale('auto', 'zh-cn'), 'zh-CN');
  assert.equal(i18n.resolveLocale('auto', 'fr'), 'en');
  assert.equal(i18n.resolveLocale('xx', 'fr'), 'en');
  assert.equal(i18n.resolveLocale(undefined, 'zh-tw'), 'zh-CN');
  assert.deepEqual([...i18n.LANGUAGE_CHOICES], ['auto', 'zh-CN', 'en']);
});

test('format fills named placeholders and leaves unknown ones visible', () => {
  assert.equal(i18n.format('{a} / {b}', { a: 1, b: 'x' }), '1 / x');
  assert.equal(i18n.format('{a} {missing}', { a: 0 }), '0 {missing}');
  assert.equal(i18n.format('no params {a}'), 'no params {a}');
});

test('translators default to zh-CN, fall back to zh-CN for an unknown locale, and to the key when nothing matches', () => {
  assert.equal(i18n.translator()('common.cancel'), '取消');
  assert.equal(i18n.translator('en')('common.cancel'), 'Cancel');
  assert.equal(i18n.translator('xx').locale, 'zh-CN');
  assert.equal(i18n.translator('en')('no.such.key'), 'no.such.key');
});

test('the browser prelude defines a working t() and cannot close its <script>', () => {
  for (const locale of i18n.LOCALES) {
    // Every `<` in the table is emitted as <, and the code around it has
    // none, so no table value can ever terminate the page's <script> element.
    assert.equal(i18n.browserSource(locale).includes('<'), false, locale);
  }
  const context = {};
  vm.runInNewContext(i18n.browserSource('en', ['common.']) +
    ';this.result = JSON.stringify([t("common.save"), t("missing.key"), Object.keys(I18N).every(key => key.startsWith("common."))]);', context);
  assert.deepEqual(JSON.parse(context.result), ['Save', 'missing.key', true]);
});

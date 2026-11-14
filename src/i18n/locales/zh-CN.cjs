'use strict';
// 原始中文文案（逐字保留）。新增界面文字时在这里和 en.cjs 同时加同名键；
// test/i18n.test.cjs 会拦下两边键集不一致与 UI 代码里新增的硬编码中文。
module.exports = Object.freeze({
  // ── 通用 ──
  'common.cancel': '取消',
  'common.delete': '删除',
  'common.save': '保存',
  'common.refresh': '刷新',
  'common.remove': '移除',
  'common.unknown': '未知',
});

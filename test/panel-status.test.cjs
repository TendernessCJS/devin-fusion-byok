'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { statusTooltip } = require('../src/panel/status-text.cjs');

const running = (extra = {}) => statusTooltip({ enabled: true, nativeModelCount: 12, cacheErrorCount: 0, matrixCount: 3, ...extra });

test('the status bar reports the four runtime states in precedence order', () => {
  assert.equal(statusTooltip({ enabled: false, nativeModelCount: 12, cacheErrorCount: 2, matrixCount: 3 }),
    'Fusion BYOK：已停用，点击打开面板启用');
  assert.equal(statusTooltip({ enabled: true, nativeModelCount: 0, cacheErrorCount: 2, matrixCount: 3 }),
    'Fusion BYOK：还没收到官方模型——打开一次模型选择器后会自动同步，或点击打开面板手动刷新');
  assert.equal(statusTooltip({ enabled: true, nativeModelCount: 12, cacheErrorCount: 2, matrixCount: 3 }),
    'Fusion BYOK：2 个 CLI 缓存文件写入失败，点击打开面板查看详情');
  assert.equal(running(), 'Fusion BYOK：运行中 · 已镜像 Fusion 组合 3 条，点击打开面板');
});

test('disabled outranks every other state, including cache errors', () => {
  assert.equal(statusTooltip({ enabled: false, nativeModelCount: 0, cacheErrorCount: 9, matrixCount: 0 }),
    'Fusion BYOK：已停用，点击打开面板启用');
});

test('missing native models outranks cache errors', () => {
  assert.match(statusTooltip({ enabled: true, nativeModelCount: 0, cacheErrorCount: 9, matrixCount: 4 }), /还没收到官方模型/);
});

test('an unset enabled flag counts as enabled, matching the extension default', () => {
  assert.equal(statusTooltip({ nativeModelCount: 12, cacheErrorCount: 0, matrixCount: 3 }),
    'Fusion BYOK：运行中 · 已镜像 Fusion 组合 3 条，点击打开面板');
});

test('a zero matrix count is reported as zero, not omitted', () => {
  assert.equal(statusTooltip({ enabled: true, nativeModelCount: 1, cacheErrorCount: 0, matrixCount: 0 }),
    'Fusion BYOK：运行中 · 已镜像 Fusion 组合 0 条，点击打开面板');
});

test('the wording never promises success while a cache write failed', () => {
  const failed = statusTooltip({ enabled: true, nativeModelCount: 5, cacheErrorCount: 1, matrixCount: 2 });
  assert.doesNotMatch(failed, /运行中/);
  assert.match(failed, /1 个 CLI 缓存文件写入失败/);
});

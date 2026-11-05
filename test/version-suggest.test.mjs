// T229 · 版本号建议工具的纯函数测试（不跑 git、不依赖仓库状态）
import assert from 'node:assert/strict';
import test from 'node:test';

import { bumpVersion, suggestBump } from '../scripts/version-suggest.mjs';

test('T229 只改测试/文档/证据/报告 ⇒ patch', () => {
  const { level } = suggestBump([
    'test/inject.test.mjs',
    'docs/调研/51-死字段与活指标.md',
    'evidence/T227-index-consumer.md',
    'reports/audit-13.md',
    'CHANGELOG.md',
    'MAINTENANCE.md',
  ]);
  assert.equal(level, 'patch');
});

test('T229 改 src 或 scripts 的行为 ⇒ minor', () => {
  assert.equal(suggestBump(['src/rooms/inject.mjs']).level, 'minor');
  assert.equal(suggestBump(['scripts/release.mjs']).level, 'minor');
  // 混合时取最高档
  assert.equal(suggestBump(['test/a.test.mjs', 'src/rooms/walk.mjs']).level, 'minor');
});

test('T229 空改动 ⇒ patch（至少不跳 minor）', () => {
  assert.equal(suggestBump([]).level, 'patch');
});

test('T229 bumpVersion：三位数各升一位', () => {
  assert.equal(bumpVersion('0.158.0', 'patch'), '0.158.1');
  assert.equal(bumpVersion('0.158.0', 'minor'), '0.159.0');
  assert.equal(bumpVersion('0.158.0', 'major'), '1.0.0');
  // 回归：主人纠正的那次 —— 只补测试却写成 0.159.0
  assert.equal(bumpVersion('0.158.0', suggestBump(['test/x.test.mjs']).level), '0.158.1');
});

test('T229 非法版本号 ⇒ null（不静默产出怪值）', () => {
  assert.equal(bumpVersion('0.158', 'patch'), null);
  assert.equal(bumpVersion('', 'patch'), null);
  assert.equal(bumpVersion('v0.158.0', 'patch'), null);
});

test('T229 分桶：纯函数不截断（截断是报告的展示层行为）', () => {
  const files = [...Array(25).fill(0).map((_, i) => `test/t${i}.test.mjs`), 'src/rooms/inject.mjs'];
  const { buckets } = suggestBump(files);
  assert.equal(buckets.patch.length, 25, '纯函数返回全部，不替调用方截断');
  assert.deepEqual(buckets.minor, ['src/rooms/inject.mjs']);
});

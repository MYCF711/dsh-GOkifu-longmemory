// T70 · P2 的数字要**能解释**：3565 条里"位置偏"和"本局没有"是两回事。
//
// 白色噪音也是噪音：`support.quote` 是单行视图（生成侧 `clipQuote` 折叠空白），
// 拿它跟多行日志逐字节比 ⇒ 1223 条（34%）"失败"只是差空白。归一化必须同口径。
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeText, formatSummary, NORMALIZE_RULES } from '../scripts/provenance-p2.mjs';

test('T70 ①: 连续空白折叠 —— 引文单行视图与多行日志同口径', () => {
  assert.equal(normalizeText('a\n\n  b\t c'), 'a b c');
  assert.equal(normalizeText('  x  '), 'x');
  assert.equal(normalizeText('a b'), normalizeText('a\nb'));
  assert.ok(NORMALIZE_RULES.some((r) => r.includes('连续空白折叠')), '规则必须写进 NORMALIZE_RULES（可被审计）');
});

test('T70 ②: 归一化不吞掉真实差异（改写仍要判红）', () => {
  assert.notEqual(normalizeText('Error: boom'), normalizeText('Error: bang'));
  assert.ok(!normalizeText('Error: boom').includes('Error: bang'));
});

test('T70 ③: summary 必须把"位置偏 / 本局没有"分开报（一个数看不出该改哪侧）', () => {
  const line = formatSummary({ claims: 1, refs: 10, ok: 2, notSubstring: 8, unreadable: 0, breakdown: { offset: 7, absent: 1 } });
  assert.match(line, /not-substring 8/);
  assert.match(line, /位置偏 7/);
  assert.match(line, /本局没有 1/);
  // 没有 breakdown（旧调用）⇒ 保持旧格式，不炸
  assert.equal(formatSummary({ claims: 1, refs: 2, ok: 1, notSubstring: 1, unreadable: 0 }),
    'claims 1 · refs 2 · ok 1 · not-substring 1 · unreadable 0');
});

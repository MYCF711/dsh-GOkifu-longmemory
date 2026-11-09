// T67 · 引文截断不许加省略号（`support.quote` 是**可机械核验**的出处指针，不是展示文本）。
//
// 实测：4315 条 support 引用里 **400 条（9.3%）** 以 `…` 结尾 —— 那个字符原文里没有，
// 于是这些引文必然"不是子串"。展示层的省略号应该在渲染时加，不能写进证据字段。
import test from 'node:test';
import assert from 'node:assert/strict';

import { clipQuote } from '../src/rooms/claim.mjs';

const LONG = 'Error: '.repeat(80); // 560 字符，远超 maxQuote

test('T67 ①: 截断后仍然是原文的**逐字子串**（这就是全部意义）', () => {
  const q = clipQuote(LONG, 200);
  assert.ok(q.length <= 200, `长度必须 ≤200，实际 ${q.length}`);
  assert.ok(LONG.includes(q), '截断结果必须是原文子串（加了省略号就不是了）');
  assert.ok(!q.endsWith('…'), '不许以省略号结尾');
});

test('T67 ②: 短引文原样返回；空白归一（与审计口径一致）', () => {
  assert.equal(clipQuote('短引用', 200), '短引用');
  assert.equal(clipQuote('a\n\n b\t c', 200), 'a b c');
  assert.ok('a\n\n b\t c'.includes('a') && clipQuote('a\n\n b\t c', 200) === 'a b c');
});

test('T67 ③: 空值不炸', () => {
  assert.equal(clipQuote(null, 200), '');
  assert.equal(clipQuote(undefined, 200), '');
  assert.equal(clipQuote('', 200), '');
});

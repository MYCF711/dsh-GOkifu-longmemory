// T305 · ablation 复发率的单测（纯函数）
import test from 'node:test';
import assert from 'node:assert/strict';
import { failureSignature, recurrenceOf, wilson } from '../scripts/ablation-recurrence.mjs';

test('T305 failureSignature：路径/数字归一化，保证同一错误可对齐', () => {
  const a = failureSignature('Error: ENOENT open "/c/tmp/aaaa/one.log"');
  const b = failureSignature('Error: ENOENT open "/d/other/bbbb/two.log"');
  assert.equal(a, b, '不同路径的同一错误应归一化到同一签名');
  assert.ok(a.includes('<path>'), '路径应被替换：' + a);
  assert.ok(!/\d/.test(a), '数字应被替换：' + a);
});

test('T305 recurrenceOf：同一签名出现 ≥2 次算复发', () => {
  const { first, recur } = recurrenceOf([
    { seq: 1, sig: 'err-A' },
    { seq: 5, sig: 'err-B' },
    { seq: 9, sig: 'err-A' },
    { seq: 12, sig: 'err-A' },
  ]);
  assert.equal(first.get('err-A'), 1, '首个 seq');
  assert.equal(recur.get('err-A'), 2, '复发 2 次');
  assert.equal(recur.has('err-B'), false, 'err-B 只出现一次');
});

test('T305 wilson：已知值 + 空样本', () => {
  const w = wilson(3, 7);
  assert.ok(Math.abs(w.phat - 3 / 7) < 1e-9);
  assert.ok(w.lower > 0 && w.upper < 1 && w.lower < w.phat && w.upper > w.phat);
  assert.equal(wilson(0, 0).phat, null, '空样本返回 null');
});

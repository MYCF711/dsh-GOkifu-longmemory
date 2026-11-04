// R00 Q18 预演的配对检验（0.126.0）：聚合率会掩盖"谁翻转了"，配对比较才说得清。
import test from 'node:test';
import assert from 'node:assert/strict';
import { exactMcNemar, pairedCompare } from '../scripts/q18-preview.mjs';

test('mcnemar: 没有不一致对 ⇒ p=1（不假装有差异）', () => {
  assert.equal(exactMcNemar(0, 0), 1);
  assert.equal(exactMcNemar(2, 2), 1);
});

test('mcnemar: 5 比 0 的不一致对 ⇒ p=0.0625（双侧精确，2/2^5）', () => {
  assert.ok(Math.abs(exactMcNemar(5, 0) - 0.0625) < 1e-9);
  assert.ok(Math.abs(exactMcNemar(0, 5) - 0.0625) < 1e-9, '方向对称');
});

test('mcnemar: 6 比 0 ⇒ p=0.03125（刚好过 0.05）', () => {
  assert.ok(Math.abs(exactMcNemar(6, 0) - 0.03125) < 1e-9);
});

test('mcnemar: 1 比 0 ⇒ p=1（单个不一致对说明不了任何事）', () => {
  assert.equal(exactMcNemar(1, 0), 1);
});

test('pairedCompare: 2×2 与 p 一起给，且能识别"只有 A 对"这种开闸损失', () => {
  const a = [{ specific: true }, { specific: true }, { specific: false }, { specific: true }];
  const b = [{ specific: true }, { specific: false }, { specific: false }, { specific: true }];
  const r = pairedCompare(a, b);
  assert.deepEqual({ n: r.n, bothOk: r.bothOk, onlyA: r.onlyA, onlyB: r.onlyB, bothFail: r.bothFail }, { n: 4, bothOk: 2, onlyA: 1, onlyB: 0, bothFail: 1 });
  assert.equal(r.p, 1, '一个不一致对 ⇒ p=1');
});

test('pairedCompare: 长度不一致按短的配对（不越界）', () => {
  const r = pairedCompare([{ specific: true }], [{ specific: false }, { specific: true }]);
  assert.equal(r.n, 1);
  assert.equal(r.onlyA, 1);
});

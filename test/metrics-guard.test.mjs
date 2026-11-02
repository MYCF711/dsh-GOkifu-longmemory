import test from 'node:test';
import assert from 'node:assert/strict';
import { judge } from '../scripts/metrics-guard.mjs';

const base = () => ({
  axes: {
    A1: { value: 0 },
    A4: { value: 2 },
    A5: { value: 0 },
    A6: { value: 1 },
    A2: { detail: { injectionRecall: { recall: 1, recallSpecific: 0.7 } } },
  },
});

test('metrics-guard: 全部达标 ⇒ PASS', () => {
  const v = judge(base());
  assert.equal(v.ok, true, v.fails.join(', '));
});

test('metrics-guard: A1 超 5% ⇒ FAIL', () => {
  const r = base(); r.axes.A1.value = 0.06;
  assert.equal(judge(r).ok, false);
});

test('metrics-guard: A5 非 0 ⇒ FAIL；A6 不到 100% ⇒ FAIL', () => {
  const r1 = base(); r1.axes.A5.value = 0.01;
  assert.equal(judge(r1).ok, false);
  const r2 = base(); r2.axes.A6.value = 0.99;
  assert.equal(judge(r2).ok, false);
});

test('metrics-guard: A2b 严格低于下限 ⇒ FAIL；缺值也 FAIL（不把缺失当通过）', () => {
  const r = base(); r.axes.A2.detail.injectionRecall.recallSpecific = 0.5;
  assert.equal(judge(r).ok, false);
  const missing = base(); delete missing.axes.A2.detail.injectionRecall;
  assert.equal(judge(missing).ok, false);
});

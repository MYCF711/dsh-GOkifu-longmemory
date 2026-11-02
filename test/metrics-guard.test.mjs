import test from 'node:test';
import assert from 'node:assert/strict';
import { judge } from '../scripts/metrics-guard.mjs';

const base = () => ({
  axes: {
    A1: { value: 0 },
    A4: { value: 2 },
    A5: { value: 0 },
    A6: { value: 1 },
    A2: { detail: { injectionRecall: { recall: 1, recallSpecific: 0.842 } } },
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

test('metrics-guard: A1=0 但 validity 覆盖 0 ⇒ 标 a1Vacuous（不判失败）', () => {
  const r = base();
  r.axes.A1.detail = { validityCoverage: { withValidity: 26, rendered: 0, ratio: 0 } };
  const v = judge(r);
  assert.equal(v.ok, true, '空转不判失败');
  assert.equal(v.values.a1Vacuous, true);
  assert.equal(v.values.a1Coverage, 0);

  const covered = base();
  covered.axes.A1.detail = { validityCoverage: { withValidity: 26, rendered: 13, ratio: 0.5 } };
  const v2 = judge(covered);
  assert.equal(v2.values.a1Vacuous, false);
  assert.equal(v2.values.a1Coverage, 0.5);
});

test('metrics-guard: A2b 严格低于「冻结基线 − 10pp」要报（防慢慢烂掉）', () => {
  const mk = (strict) => {
    const r = base();
    r.axes.A2.detail = { injectionRecall: { recall: 1, recallSpecific: strict, hits: 19, specificHits: Math.round(strict * 19), n: 19 } };
    return judge(r);
  };
  assert.equal(mk(0.842).ok, true, '与基线持平 ⇒ PASS');
  assert.equal(mk(0.76).ok, true, '掉 8pp 仍在容差内');
  const low = mk(0.70);
  assert.equal(low.ok, false, '掉 14pp ⇒ FAIL');
  assert.ok(low.fails.some((f) => f.includes('掉了')), '失败理由要写明掉点');
});

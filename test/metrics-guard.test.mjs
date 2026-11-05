import test from 'node:test';
import assert from 'node:assert/strict';
import { HOLDOUT_BASELINE, judge, loadHoldout } from '../scripts/metrics-guard.mjs';

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

// ---------------------------------------------------------------- T236b（主人改判 2026-11-05）
//
// 层级：主判据 = A2b（召回相关度）· 约束 = A1/A5/A6/A4 · 下游参考 = repeatFailureRate（不参与 exit code）。
// 为什么：把下游结果当源头验收面 = 指标不可归因（源头做对可能被下游浪费，做错也可能被下游兜住）。

test('T236b ①: A2b 掉到门槛下 ⇒ 红（且是主判据层的红）', () => {
  const r = base();
  r.axes.A2.detail.injectionRecall.recallSpecific = 0.5;
  const v = judge(r);
  assert.equal(v.ok, false, 'A2b 低于下限必须红');
  assert.ok(v.layers.main.length >= 1, '要落在主判据层');
  assert.ok(v.layers.main.some((f) => f.includes('A2b 严格')), JSON.stringify(v.layers));
  assert.equal(v.layers.constraints.length, 0, '约束条件本身没越界');
});

test('T236b ②: repeatFailureRate 再差也不影响 exit code（下游参考）', () => {
  // A2 轴的 value 就是 repeatFailureRate（LOO）；把它拉到 99% 也不许红
  const bad = base();
  bad.axes.A2.value = 0.99;
  const v1 = judge(bad);
  assert.equal(v1.ok, true, `repeatFailureRate 不该决定 exit code：${v1.fails.join(' · ')}`);
  assert.equal(v1.values.repeatFailureRate, 0.99, '仍要打印出来');
  // 缺失也一样（不许因为缺值而红）
  const missing = base();
  delete missing.axes.A2.value;
  assert.equal(judge(missing).ok, true);
  assert.equal(judge(missing).values.repeatFailureRate, null, '缺值给 null，不编造 0');
});

test('T236b ③: 输出层级 —— A2b 的失败排在 A1 之前', () => {
  const r = base();
  r.axes.A2.detail.injectionRecall.recallSpecific = 0.4; // A2b 红
  r.axes.A1.value = 0.9; // A1 也红
  const v = judge(r);
  assert.equal(v.ok, false);
  assert.ok(v.fails.length >= 2, JSON.stringify(v.fails));
  const firstA2b = v.fails.findIndex((f) => f.startsWith('A2b'));
  const firstA1 = v.fails.findIndex((f) => f.startsWith('A1'));
  assert.ok(firstA2b >= 0 && firstA1 >= 0);
  assert.ok(firstA2b < firstA1, `A2b 必须排在 A1 之前，实际：${JSON.stringify(v.fails)}`);
});

// ---------------------------------------------------------------- T242（选择偏差进闸）
//
// 主判据以前默认用 n=19 的 repeat-only 冻结集（100% 是选择偏差的产物）；
// 现在默认用 T236a 的 n=108 考卷（repeat + self），实测严格 34.26%。
// 门槛 = 当前实测（37/108、74/108）—— 起点不是目标，任何下降即红。

const HOLDOUT = { n: 108, strict: 37 / 108, cover: 74 / 108, sampleSource: 'holdout' };

test('T242 ①: 考卷不存在 ⇒ 抛错并说清"考卷不存在"（fail-closed，不静默回退）', () => {
  const missingFs = { existsSync: () => false, readFileSync: () => { throw new Error('should not read'); } };
  assert.throws(
    () => loadHoldout('evidence/definitely-missing-a2b.json', { fsImpl: missingFs }),
    /考卷不存在/,
  );
});

test('T242 ②: 用 108 条考卷时 n=108，严格/覆盖取自考卷', () => {
  const v = judge(base(), undefined, HOLDOUT);
  assert.equal(v.values.a2bN, 108);
  assert.equal(v.values.sampleSource, 'holdout');
  assert.equal(v.values.a2bStrict, 37 / 108);
  assert.equal(v.values.a2bCover, 74 / 108);
});

test('T242 ③: 门槛不因换考卷而误报（当前实测 = 门槛 ⇒ PASS）；下降即红', () => {
  assert.equal(HOLDOUT_BASELINE.n, 108);
  assert.equal(HOLDOUT_BASELINE.strictMin, 37 / 108);
  assert.equal(HOLDOUT_BASELINE.coverMin, 74 / 108);
  // 当前实测正好等于门槛 ⇒ PASS（不允许出现"基线被四舍五入卡在门外"的假红）
  assert.equal(judge(base(), undefined, HOLDOUT).ok, true, '当前实测应当 PASS');
  // 严格掉 1 条（36/108）⇒ 红
  const dropped = judge(base(), undefined, { ...HOLDOUT, strict: 36 / 108 });
  assert.equal(dropped.ok, false, '掉一条也要红（起点不是目标）');
  assert.ok(dropped.layers.main.some((f) => f.includes('A2b 严格')), JSON.stringify(dropped.layers));
  // 旧的 repeat-only 回归线不该套到新考卷上：34.26% < 84.21%-10pp，但新考卷口径下不因这条红
  assert.equal(judge(base(), undefined, HOLDOUT).layers.main.some((f) => f.includes('掉了')), false);
});

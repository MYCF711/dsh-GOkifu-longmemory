// 可交付性闸（0.128.0）：只导出 tracked 内容，跑 check + 单测；判据本身也要被钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTestSummary, judgeDeliverable } from '../scripts/deliverability.mjs';

const OUT = ['oooooooooooooooooooooooooooooooooooooooooo',
  '# Subtest: x',
  'ok 1 - x',
  '1..2',
  'ℹ tests 458',
  'ℹ suites 0',
  'ℹ pass 454',
  'ℹ fail 0',
  'ℹ skipped 4'].join(String.fromCharCode(10));

test('deliverability: 解析 node --test 汇总', () => {
  const s = parseTestSummary(OUT);
  assert.deepEqual(s, { total: 458, pass: 454, fail: 0, skip: 4 });
  assert.equal(parseTestSummary('没有汇总'), null);
});

test('deliverability: check 0 + fail 0 ⇒ 可交付', () => {
  const r = judgeDeliverable({ checkCode: 0, checkOut: 'check: PASS', testSummary: { total: 3, pass: 3, fail: 0, skip: 0 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.bad, []);
});

test('deliverability: check 非 0 ⇒ 不可交付（带输出尾部）', () => {
  const r = judgeDeliverable({ checkCode: 1, checkOut: 'ERR 脱敏扫描跑不起来', testSummary: { total: 3, pass: 3, fail: 0, skip: 0 } });
  assert.equal(r.ok, false);
  assert.ok(r.bad[0].includes('check 退出码 1'));
  assert.ok(r.bad[0].includes('脱敏扫描'));
});

test('deliverability: 有测试失败 / 单测 0 条 / 没汇总 ⇒ 都判不可交付', () => {
  assert.equal(judgeDeliverable({ checkCode: 0, testSummary: { total: 5, pass: 4, fail: 1, skip: 0 } }).ok, false);
  assert.equal(judgeDeliverable({ checkCode: 0, testSummary: { total: 0, pass: 0, fail: 0, skip: 0 } }).ok, false);
  assert.equal(judgeDeliverable({ checkCode: 0, testSummary: null }).ok, false);
});

// 台账闸的解析器（0.130.0）：红了要能说出**是哪一条**，解析不到要如实说解析不到。
import test from 'node:test';
import assert from 'node:assert/strict';
import { failingTestNames, parseTestCounts, describeFailure } from '../scripts/ledger-parse.mjs';

const SPEC_OUT = [
  'ok 1 - 好的',
  '✖ sdk: 库不存在 ⇒ 明确标 missing (12.34ms)',
  'ℹ tests 474',
  'ℹ pass 469',
  'ℹ fail 1',
  'ℹ skipped 4',
].join(String.fromCharCode(10));

const TAP_OUT = [
  'ok 1 - 好的',
  'not ok 7 - m5: A5 作用域——越界行 0',
  '# tests 474',
  '# pass 469',
  '# fail 1',
  '# skipped 4',
].join(String.fromCharCode(10));

test('ledger-parse: spec 与 tap 都能解析出计数（并标出用的哪种报告器）', () => {
  assert.deepEqual(parseTestCounts(SPEC_OUT), { total: 474, pass: 469, fail: 1, skip: 4, reporter: 'spec' });
  assert.deepEqual(parseTestCounts(TAP_OUT), { total: 474, pass: 469, fail: 1, skip: 4, reporter: 'tap' });
  assert.equal(parseTestCounts('啥都没有'), null, '解析不到就是 null，不许编 0');
});

test('ledger-parse: 能说出红的是哪一条（两种报告器都认，时长后缀要去掉）', () => {
  assert.deepEqual(failingTestNames(SPEC_OUT), ['sdk: 库不存在 ⇒ 明确标 missing']);
  assert.deepEqual(failingTestNames(TAP_OUT), ['m5: A5 作用域——越界行 0']);
  assert.deepEqual(failingTestNames('全绿', 3), [], '全绿时不给名字');
});

test('ledger-parse: 空输出/无失败行 ⇒ 明确说"没解析出测试名"，不假装知道', () => {
  assert.equal(describeFailure(''), '；且没解析出测试名（输出为空？）');
  assert.match(describeFailure(SPEC_OUT), /红的是：sdk/);
});

test('ledger-parse: 去重保序且受 limit 约束', () => {
  const out = ['✖ a', '✖ a', '✖ b', '✖ c', '✖ d'].join(String.fromCharCode(10));
  assert.deepEqual(failingTestNames(out, 2), ['a', 'b']);
});

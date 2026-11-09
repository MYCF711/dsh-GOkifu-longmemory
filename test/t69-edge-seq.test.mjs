// T69 · 边的 seq 必须与 quote **取自同一条事件**（tombstone test）。
//
// 真库实测：claim 的「图来源」support 403 条里 360 条（89.3%）不是原文子串 —— 根因就是
// `edgeQuote()` 取结果侧文本（`evidence.end`），`edgeSeq()` 却先取动作侧（`evidence.start`）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { edgeSeq } from '../src/rooms/extract.mjs';

const edge = (over = {}) => ({
  id: 'e-test',
  from: 'n1',
  to: 'n2',
  result: 'failure',
  action: 'bash(git status)',
  evidence: { start: 10, end: 12 },
  ...over,
});

test('T69 ①: 引文取结果侧（errorSnippet）⇒ seq 必须是 evidence.end', () => {
  assert.equal(edgeSeq(edge({ errorSnippet: 'Error: boom' })), 12);
});

test('T69 ②: 引文取结果侧（verify.summary + exit/host-error）⇒ 同理', () => {
  assert.equal(edgeSeq(edge({ verify: { kind: 'host-error', summary: 'Error: unknown job x' } })), 12);
  assert.equal(edgeSeq(edge({ verify: { kind: 'exit', summary: 'exit 1' } })), 12);
});

test('T69 ③: 引文取动作侧（只有 action）⇒ seq 仍是 evidence.start', () => {
  assert.equal(edgeSeq(edge({})), 10);
});

test('T69 ④: 测试通过汇总不算结果侧引文（T251 同口径）⇒ 仍取 start', () => {
  const pass = 'ℹ tests 12\nℹ pass 12\nℹ fail 0';
  assert.equal(edgeSeq(edge({ errorSnippet: pass })), 10, '绿色汇总不是失败原文');
});

test('T69 ⑤: 缺对应那头 ⇒ 退另一头；两头都没有 ⇒ null（不猜）', () => {
  assert.equal(edgeSeq(edge({ errorSnippet: 'Error: boom', evidence: { start: 10 } })), 10);
  assert.equal(edgeSeq(edge({ evidence: { end: 12 } })), 12);
  assert.equal(edgeSeq(edge({ evidence: {} })), null);
  assert.equal(edgeSeq(null), null);
});

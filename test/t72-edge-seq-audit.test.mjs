// T72 · 端到端验证 T69（tombstone test）：删掉 scripts/edge-seq-audit.mjs ⇒ 本文件整片红。
//
// 单测只能证明"edgeSeq 取哪一头"，这里证明"真数据上新口径确实指对了"。
import test from 'node:test';
import assert from 'node:assert/strict';

import { compareEdgeSeq } from '../scripts/edge-seq-audit.mjs';
import { normalizeText } from '../scripts/provenance-p2.mjs';

const failEdge = (over = {}) => ({
  id: 'e1', result: 'failure', action: 'bash(x)',
  errorSnippet: 'Error: boom',
  evidence: { start: 10, end: 12 },
  ...over,
});

test('T72 ①: 旧口径（evidence.start）指错、新口径（edgeSeq ⇒ end）指对', () => {
  // seq 10 是动作事件（不含报错），seq 12 是结果事件（含报错）
  const textAt = (seq) => (seq === 12 ? normalizeText('Error: boom') : seq === 10 ? normalizeText('bash(x)') : '');
  const r = compareEdgeSeq({ edges: [failEdge()], textAt });
  assert.equal(r.total, 1);
  assert.equal(r.oldOk, 0, '旧口径必须指错（否则这条测试没意义）');
  assert.equal(r.newOk, 1, '新口径必须指对');
  assert.equal(r.newRate, 100);
});

test('T72 ②: 只统计 result=failure 且带引文的边（别的边不该拉低命中率）', () => {
  const textAt = () => 'whatever';
  const edges = [
    failEdge(),
    failEdge({ id: 'e2', result: 'success' }),
    failEdge({ id: 'e3', errorSnippet: '', verify: {} }),
  ];
  const r = compareEdgeSeq({ edges, textAt });
  assert.equal(r.total, 1, '成功边与无引文的边都不计');
});

test('T72 ③: 没有 evidence.end 时退回 start（不因新口径把样本丢掉）', () => {
  const textAt = (seq) => (seq === 10 ? normalizeText('Error: boom') : '');
  const r = compareEdgeSeq({ edges: [failEdge({ evidence: { start: 10 } })], textAt });
  assert.equal(r.total, 1);
  assert.equal(r.newOk, 1);
});

test('T72 ④: 空输入 ⇒ 比率是 null（不是 0，避免造假读数）', () => {
  const r = compareEdgeSeq({ edges: [], textAt: () => '' });
  assert.equal(r.total, 0);
  assert.equal(r.newRate, null);
  assert.equal(r.oldRate, null);
});

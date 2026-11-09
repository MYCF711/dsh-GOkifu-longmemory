// T68 · P2 失败按**出处来源**分桶（tombstone test）：删掉 scripts/p2-source-audit.mjs ⇒ 本文件整片红。
//
// 这条分桶决定了下一步改哪一侧：图来源（抄自上游 graph.json）坏 → 要在我们这边做引用校正；
// 信号来源坏 → 要改 R03 抽取。
import test from 'node:test';
import assert from 'node:assert/strict';

import { auditBySource } from '../scripts/p2-source-audit.mjs';

const ev = (seq, text) => ({ seq, type: 'tool/result', data: { message: { content: [{ type: 'text', text }] } } });
const EVENTS = [ev(10, 'ok line'), ev(11, 'Error: boom')];

test('T68 ①: 图来源与信号来源分开计数（同一个坏法不能算进同一个桶）', () => {
  const claims = [{
    id: 'c1',
    support: [
      { episode: 'ep-1', seq: 11, quote: 'Error: boom', nodeId: 'n1', edgeId: 'e1' }, // 图来源，指对了
      { episode: 'ep-1', seq: 10, quote: 'Error: boom', nodeId: 'n1' },                // 图来源，指错了
      { episode: 'ep-1', seq: 11, quote: 'Error: boom' },                              // 信号来源，指对了
      { episode: 'ep-1', seq: 10, quote: 'Error: boom' },                              // 信号来源，指错了
    ],
  }];
  const r = auditBySource({ claims, loadEvents: () => EVENTS });
  assert.equal(r.graph.total, 2);
  assert.equal(r.graph.bad, 1);
  assert.equal(r.signal.total, 2);
  assert.equal(r.signal.bad, 1);
  assert.equal(r.graph.badRate, 50);
  assert.equal(r.signal.badRate, 50);
});

test('T68 ②: 日志读不到 ⇒ 单列 skipped（不算坏，也不算好）', () => {
  const claims = [{ id: 'c1', support: [{ episode: 'ep-x', seq: 1, quote: 'q', nodeId: 'n1' }] }];
  const r = auditBySource({ claims, loadEvents: () => null });
  assert.equal(r.skippedNoEvents, 1);
  assert.equal(r.graph.total, 0);
  assert.equal(r.graph.badRate, null, '没样本时坏率是 null，不是 0');
});

test('T68 ③: 缺 seq / 空 quote / 没 support 一律跳过（不猜）', () => {
  const claims = [{ id: 'c1', support: [{ episode: 'ep-1', quote: 'x' }, { episode: 'ep-1', seq: 11, quote: '' }] }, { id: 'c2' }];
  const r = auditBySource({ claims, loadEvents: () => EVENTS });
  assert.equal(r.graph.total + r.signal.total, 0);
});

test('T68 ④: limit 只限制 claim 条数（引用会多于 claim，正常）', () => {
  const claims = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, support: [{ episode: 'ep-1', seq: 11, quote: 'Error: boom' }] }));
  const r = auditBySource({ claims, loadEvents: () => EVENTS, limit: 2 });
  assert.equal(r.scanned, 2);
  assert.equal(r.signal.total, 2);
});

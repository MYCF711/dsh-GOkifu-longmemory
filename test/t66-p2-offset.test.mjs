// T66 · P2 指针偏移诊断（tombstone test）：删掉 scripts/p2-offset-audit.mjs ⇒ 本文件整片红。
//
// 它回答的是"3565 条 quote-not-substring 到底是哪种坏"，所以必须**分得清**：
//   · 指针偏移（引文在另一条 seq）⇒ 记 delta；
//   · 整局没有（改写/截断/指错局）⇒ 记 not-found。
import test from 'node:test';
import assert from 'node:assert/strict';

import { offsetHistogram } from '../scripts/p2-offset-audit.mjs';

const ev = (seq, text) => ({ seq, type: 'tool/result', data: { message: { content: [{ type: 'text', text }] } } });

test('T66 ①: 指针指对 ⇒ 不计入失败', () => {
  const events = [ev(10, 'ok'), ev(11, 'Error: boom')];
  const claims = [{ id: 'c1', support: [{ episode: 'ep-1', seq: 11, quote: 'Error: boom' }] }];
  const r = offsetHistogram({
    claims,
    episodes: new Map([['ep-1', { id: 'ep-1' }]]),
    loadEvents: () => events,
  });
  assert.equal(r.sampled, 0, '指对的引用不该进样本');
});

test('T66 ②: 引文在别的 seq ⇒ 记 delta（正负都要能算）', () => {
  const events = [ev(10, 'Error: boom'), ev(20, 'later text')];
  const claims = [{ id: 'c1', support: [{ episode: 'ep-1', seq: 20, quote: 'Error: boom' }] }];
  const r = offsetHistogram({
    claims,
    episodes: new Map([['ep-1', { id: 'ep-1' }]]),
    loadEvents: () => events,
  });
  assert.equal(r.sampled, 1);
  assert.deepEqual(r.histogram, [[-10, 1]], 'foundSeq - seq = 10 - 20 = -10');
});

test('T66 ③: 整局找不到 ⇒ 记 not-found（与"偏移"分开，别混成一个数）', () => {
  const events = [ev(10, 'something else')];
  const claims = [{ id: 'c1', support: [{ episode: 'ep-1', seq: 10, quote: '这句在日志里没有' }] }];
  const r = offsetHistogram({
    claims,
    episodes: new Map([['ep-1', { id: 'ep-1' }]]),
    loadEvents: () => events,
  });
  assert.deepEqual(r.histogram, [['not-found', 1]]);
  assert.equal(r.rows[0].delta, null);
});

test('T66 ④: 没有 episode / 没有 support / 没有 seq 一律跳过（不猜）', () => {
  const r = offsetHistogram({
    claims: [{ id: 'c1', support: [{ episode: 'ep-x', seq: 1, quote: 'q' }] }, { id: 'c2', support: [] }],
    episodes: new Map(),
    loadEvents: () => [],
  });
  assert.equal(r.sampled, 0);
});

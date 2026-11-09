// T365 · 「源头文字不存在」必须单列（tombstone test）。
//
// 三种失败要分开，别混成一个数：
//   · 位置偏（引文在本局别处）        ⇒ 真 fail（T69 修的是这一类）
//   · 源头不存在（本局任何地方都没有）  ⇒ unverifiable-source（不是我们的缺陷，也不是 ok）
//   · 日志读不到                      ⇒ unreadable（fail-closed）
import test from 'node:test';
import assert from 'node:assert/strict';

import { auditP2, formatSummary } from '../scripts/provenance-p2.mjs';

const events = [
  { seq: 1, data: { message: { content: [{ type: 'text', text: 'alpha beta' }] } } },
  { seq: 2, data: { message: { content: [{ type: 'text', text: 'gamma delta' }] } } },
];
const episodes = new Map([['ep-1', { id: 'ep-1' }]]);

test('T365 ①: 本局任何地方都没有该引文 ⇒ unverifiable-source（不是 fail）', async () => {
  const out = await auditP2({
    claims: [{ id: 'c1', support: [{ episode: 'ep-1', seq: 1, quote: '这段文字日志里没有' }] }],
    episodes,
    loadEvents: async () => events,
  });
  assert.equal(out.stats.notSubstring, 0, '不许算成 fail');
  assert.equal(out.stats.unverifiableSource, 1);
  assert.equal(out.stats.ok, 0, '也不许冒充 ok');
  assert.match(formatSummary(out.stats), /不可核验\(源头不存在\) 1/);
});

test('T365 ②: 引文在本局别处 ⇒ 仍算 fail（偏移是我们的缺陷，不许被"不可核验"吃掉）', async () => {
  const out = await auditP2({
    claims: [{ id: 'c1', support: [{ episode: 'ep-1', seq: 1, quote: 'gamma delta' }] }],
    episodes,
    loadEvents: async () => events,
  });
  assert.equal(out.stats.notSubstring, 1);
  assert.equal(out.stats.unverifiableSource, 0);
  assert.equal(out.refs[0].diagnosis.strictNear.seq, 2, '应指出真实位置是 seq 2');
});

test('T365 ③: 日志读不到 ⇒ unreadable（fail-closed，不进"不可核验"）', async () => {
  const out = await auditP2({
    claims: [{ id: 'c1', support: [{ episode: 'ep-1', seq: 1, quote: 'x' }] }],
    episodes,
    loadEvents: async () => null,
  });
  assert.equal(out.stats.unreadable, 1);
  assert.equal(out.stats.unverifiableSource, 0);
});

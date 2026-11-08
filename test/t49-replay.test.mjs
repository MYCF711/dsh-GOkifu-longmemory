// T49 真库回放的 tombstone test：删掉 `scripts/t49-replay.mjs` 的 `replaySession` ⇒ 本文件整片红。
//
// 这个脚本的价值是"不重启宿主也能拿真库读数"，所以它的判据必须与线上**同一个函数**
// （`messageText` / `CARD_SOURCE_KIND`），并且两套压缩模型都要能复现：
//   · 上界：不看压缩 —— 卡投过就一直算"还在上下文里"；
//   · 下界：压缩即清空历史 —— 卡被压掉就不拦（对应 m5-report 的 necessary 档）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { replaySession } from '../scripts/t49-replay.mjs';
import { CARD_SOURCE_KIND } from '../src/plugin.mjs';

const T0 = Date.UTC(2026, 10, 9, 0, 0, 0);

const userEvent = (text, seq) => ({
  type: 'user/message',
  seq,
  time: T0 + seq * 1000,
  data: { content: [{ type: 'text', text }] },
});
const cardEvent = (text, seq, digest = 'd'.repeat(16)) => ({
  type: 'user/message',
  seq,
  time: T0 + seq * 1000,
  data: {
    content: [{ type: 'text', text }],
    source: { kind: CARD_SOURCE_KIND, form: 'memory-card', digest, pluginVersion: '1' },
  },
});
const compaction = (seq) => ({ type: 'compaction/start', seq, time: T0 + seq * 1000, data: {} });

test('T49 回放 ①: 第一次注入不算"已在"（先判再入列，顺序不能反）', () => {
  const { injections } = replaySession([userEvent('yaml 装不上', 1), cardEvent('CARD-A', 2)]);
  assert.equal(injections.length, 1);
  assert.equal(injections[0].wouldBlock, false, '卡片自己不能被算成"已经在上下文里"');
  assert.equal(injections[0].wouldBlockStrict, false);
});

test('T49 回放 ②: 同一张卡第二次 ⇒ 两套模型都拦（没有压缩）', () => {
  const { injections } = replaySession([
    userEvent('yaml 装不上', 1),
    cardEvent('CARD-A', 2),
    userEvent('yaml 还是装不上', 3),
    cardEvent('CARD-A', 4),
  ]);
  assert.equal(injections.length, 2);
  assert.equal(injections[1].wouldBlock, true, '上界：卡正文还在上下文里 ⇒ 拦');
  assert.equal(injections[1].wouldBlockStrict, true, '下界：期间没压缩 ⇒ 一样拦');
});

test('T49 回放 ③: 中间压过一次 ⇒ 上界仍拦、下界放行（真值在两者之间）', () => {
  const { injections } = replaySession([
    userEvent('yaml 装不上', 1),
    cardEvent('CARD-A', 2),
    compaction(3),
    userEvent('yaml 还是装不上', 4),
    cardEvent('CARD-A', 5),
  ]);
  assert.equal(injections.length, 2);
  assert.equal(injections[1].wouldBlock, true, '上界模型不看压缩 ⇒ 仍算"还在"');
  assert.equal(injections[1].wouldBlockStrict, false, '下界模型：压缩清空历史 ⇒ 不拦（这是"必要重注"）');
});

test('T49 回放 ④: 不同卡互不影响（正文不同就不算重投）', () => {
  const { injections } = replaySession([
    userEvent('yaml 装不上', 1),
    cardEvent('CARD-A', 2, 'a'.repeat(16)),
    userEvent('别的坑', 3),
    cardEvent('CARD-B', 4, 'b'.repeat(16)),
  ]);
  assert.equal(injections.length, 2);
  assert.equal(injections[0].wouldBlock, false);
  assert.equal(injections[1].wouldBlock, false, '正文不同 ⇒ 不是同一张卡');
});

test('T49 回放 ⑤: 非卡消息（普通 user/assistant）不产生注入行；assistant 也进上下文', () => {
  const { injections } = replaySession([
    { type: 'assistant/message', seq: 1, time: T0, data: { content: [{ type: 'text', text: 'CARD-A' }] } },
    userEvent('yaml 装不上', 2),
    cardEvent('CARD-A', 3),
  ]);
  assert.equal(injections.length, 1);
  assert.equal(injections[0].wouldBlock, true, 'assistant 消息也属于上下文（messageText 一视同仁）');
});

// T232 · P2「可重算」守卫：`claim.support[].quote` 必须是该 `(ep, seq)` 原文的**逐字子串**。
//
// 为什么有这条（`docs/调研/52`）：P1 只保证指针**格式**对（episode 存在、seq 在区间内、quote 非空），
// 不保证指针**指向的内容**对。2026-11-05 的 `(ep-62bcb7d2, seq 5736)` 就是格式全对、却指错了地方，
// 写库四小时后才被随机抽样撞见。P2 是那条漏网的机械补丁。
//
// fail-closed：读不到原文 ⇒ `seq-unreadable`，**不算 ok**（未知 ≠ 没问题）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NORMALIZE_RULES,
  normalizeText,
  collectStrings,
  indexEvents,
  firstDifference,
  checkQuoteAtSeq,
  formatSummary,
  auditP2,
} from '../scripts/provenance-p2.mjs';

// ---------------------------------------------------------------------------
// ① 子串命中
// ---------------------------------------------------------------------------

test('P2: quote 是原文的逐字子串 ⇒ ok', () => {
  const events = [{ seq: 10, data: { message: { content: [{ type: 'text', text: 'Error: Cannot find module yaml' }] } } }];
  const index = indexEvents(events);
  const v = checkQuoteAtSeq({ quote: 'Cannot find module yaml', seq: 10, eventIndex: index });
  assert.equal(v.verdict, 'ok');
  assert.equal(v.matchedBy, 'event');
  assert.equal(v.diff, null);
});

// ---------------------------------------------------------------------------
// ② 差一个字符 ⇒ not-substring，并指出第一个不同处
// ---------------------------------------------------------------------------

test('P2: quote 差一个字符 ⇒ quote-not-substring，且能定位第一个不同处', () => {
  const events = [{ seq: 10, data: { text: 'Error: Cannot find module "yaml"' } }];
  const index = indexEvents(events);
  const quote = 'Error: Cannot find module "yam1"'; // 1 ≠ l
  const v = checkQuoteAtSeq({ quote, seq: 10, eventIndex: index });
  assert.equal(v.verdict, 'quote-not-substring');
  assert.ok(v.diff, '必须给出第一个不同处');
  assert.equal(v.diff.actual, '1');
  assert.equal(v.diff.expected, 'l');
});

// ---------------------------------------------------------------------------
// ③ 归一化后命中（NBSP / CRLF）—— 规则必须写进输出，可复核
// ---------------------------------------------------------------------------

test('P2: NBSP / CRLF 归一化后命中 ⇒ ok（归一化规则对外可见）', () => {
  // 原文用 NBSP 与 CRLF；引文用普通空格与 LF
  const events = [{ seq: 7, data: { text: 'line one\r\nline two\u00a0end' } }];
  const index = indexEvents(events);
  const v = checkQuoteAtSeq({ quote: 'one\nline two end', seq: 7, eventIndex: index });
  assert.equal(v.verdict, 'ok', '归一化之后必须命中');
  assert.ok(NORMALIZE_RULES.some((r) => r.includes('NBSP')));
  assert.ok(NORMALIZE_RULES.some((r) => r.includes('CRLF')));
  // T70：连续空白折叠（引文是单行视图，生成侧 clipQuote 会折叠）
  assert.equal(normalizeText('a\u00a0b\r\nc'), 'a b c');
});

// ---------------------------------------------------------------------------
// ④ 原文读不到 ⇒ seq-unreadable（**不是** ok）
// ---------------------------------------------------------------------------

test('P2: seq 读不到 ⇒ seq-unreadable，绝不算进 ok', async () => {
  const events = [{ seq: 10, data: { text: 'something' } }];
  const index = indexEvents(events);
  const missing = checkQuoteAtSeq({ quote: 'something', seq: 99, eventIndex: index });
  assert.equal(missing.verdict, 'seq-unreadable');
  assert.match(missing.reason, /seq-not-found:99/);

  // 端到端：episode 读不到（loader 返回 null）⇒ unreadable，且统计里 ok 不含它
  const claims = [{ id: 'c-1', support: [{ episode: 'ep-deadbeef', seq: 10, quote: 'something' }] }];
  const episodes = new Map([['ep-deadbeef', { id: 'ep-deadbeef' }]]);
  const out = await auditP2({ claims, episodes, loadEvents: async () => null });
  assert.equal(out.stats.ok, 0);
  assert.equal(out.stats.unreadable, 1);
  assert.equal(out.refs[0].reason, 'episode-unreadable');
  // T70：汇总行尾巴会带 breakdown（位置偏 / 本局没有）；这里只钉前五段
  assert.match(formatSummary(out.stats), /^claims 1 · refs 1 · ok 0 · not-substring 0 · unreadable 1( · 其中：位置偏 \d+ · 本局没有 \d+)?$/);
});

// ---------------------------------------------------------------------------
// ⑤ 汇总行格式 + 端到端统计
// ---------------------------------------------------------------------------

test('P2: 汇总行格式固定，端到端三态计数正确', async () => {
  const eventsByEp = {
    'ep-aaaaaaaa': [{ seq: 1, data: { text: 'alpha beta gamma' } }, { seq: 2, data: { text: 'second 事件原文' } }],
  };
  const claims = [
    { id: 'c-ok', support: [{ episode: 'ep-aaaaaaaa', seq: 1, quote: 'beta' }] },
    { id: 'c-bad', support: [{ episode: 'ep-aaaaaaaa', seq: 1, quote: 'beta DELTA' }] },
    { id: 'c-unread', support: [{ episode: 'ep-aaaaaaaa', seq: 404, quote: 'whatever' }] },
    { id: 'c-ok2', support: [{ episode: 'ep-aaaaaaaa', seq: 2, quote: '事件原文' }] },
  ];
  const episodes = new Map([['ep-aaaaaaaa', { id: 'ep-aaaaaaaa' }]]);
  const out = await auditP2({
    claims,
    episodes,
    loadEvents: async (id) => eventsByEp[id] ?? null,
  });
  assert.deepEqual(
    { claims: out.stats.claims, refs: out.stats.refs, ok: out.stats.ok, notSubstring: out.stats.notSubstring, unreadable: out.stats.unreadable },
    { claims: 4, refs: 4, ok: 2, notSubstring: 1, unreadable: 1 },
  );
  assert.match(formatSummary(out.stats), /^claims 4 · refs 4 · ok 2 · not-substring 1 · unreadable 1( · 其中：位置偏 \d+ · 本局没有 \d+)?$/);
  assert.equal(out.failures[0].claimId, 'c-bad');
  assert.equal(out.unreadableRefs[0].claimId, 'c-unread');
});

// ---------------------------------------------------------------------------
// ⑥ 构造性守卫：删掉 P2 判定后这些断言必须红（tombstone）
// ---------------------------------------------------------------------------

test('P2: collectStrings / firstDifference 的边界（空、跨段、对不齐）', () => {
  assert.deepEqual(collectStrings({ a: 'x', b: ['y', { c: 'z' }] }), ['x', 'y', 'z']);
  assert.equal(firstDifference('', 'abc'), null);
  assert.equal(firstDifference('abc', 'xxabcxx'), null, '子串时没有"不同处"');
  const unaligned = firstDifference('ZZZ', 'abc');
  assert.equal(unaligned.unaligned, true);
  // 跨段：两段原文分别含一半，拼起来才命中 ⇒ matchedBy = event
  const idx = indexEvents([{ seq: 5, data: { a: 'foo bar', b: 'baz qux' } }]);
  const v = checkQuoteAtSeq({ quote: 'bar\nbaz', seq: 5, eventIndex: idx });
  assert.equal(v.verdict, 'ok');
  assert.equal(v.matchedBy, 'event');
});

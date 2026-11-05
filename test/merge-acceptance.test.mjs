// T173/T178/T181/T185/T189 的 tombstone test：删掉 `scripts/merge-acceptance.mjs` 的
// `sampleMergeGroups` / `checkMembersResolvable` / `wilsonInterval` ⇒ 本文件红。
//
// 覆盖：
//   - T173 定点抽样：信号 = 合并组的共享正文（真实链路 walk → buildMemoryCard；测试注入假 measure 只验聚合）
//   - T178 三条闸门：④a 不许变差 / ④b 不许丢内容 / ④c 只作参考（不参与退出码）
//   - T181 ④c 分母 = **可折组**（源库卡片里本组成员行 ≥2）
//   - T185 统计功效：Wilson 95% 区间 + 样本量门槛（可折 <10 一律"证据不足"）
//   - T189 加硬：② 成员可解析（只增不改）、④b 按 **claimId 内容身份** 判丢行、④a 载荷缩水只展示、
//           ④c 下界门槛抬到 0.7、① 改逐组配对
//
// 只读：不写任何库；纯函数聚合，零模型调用。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sampleMergeGroups, checkMembersResolvable, wilsonInterval, selectMergeGroups,
  parseArgs, normalizeText, countDuplicateRows,
} from '../scripts/merge-acceptance.mjs';

/** 造一个合并组：成员 id 为 `<id>-m0..m{n-1}`。 */
const group = (id, members = 2, text = `合并组 ${id} 的共享正文`) => ({
  id,
  text,
  scopeKey: 'w:d:/work/demo',
  merge: { members: Array.from({ length: members }, (_, i) => `${id}-m${i}`) },
});

const srcStore = { __key: 'src' };
const shadowStore = { __key: 'shadow' };
const TEXT = 'x'.repeat(20);

/**
 * 假 measure：按"第几次调用"返回一张卡。每组的 spec：
 *   srcMembers    源卡里出现的本组成员行数
 *   shadowMembers 影卡里出现的本组成员行数（默认 = srcMembers）
 *   shared        两张卡都出现的**无关行**数（同 claimId，用于 ④b 的身份对齐）
 *   extraShadow   只出现在影卡的行数（造 ④a 反增）
 *   covered       影卡里是否包含**合并节点行**（claimId = 组 id）⇒ 覆盖缺失的成员
 */
function measureFrom(specs) {
  let call = 0;
  return () => {
    const gi = Math.floor(call / 2);
    const isSource = call % 2 === 0;
    call += 1;
    const spec = specs[gi] ?? { srcMembers: 0 };
    const gid = `g${gi + 1}`;
    const shared = spec.shared ?? 0;
    const members = isSource ? (spec.srcMembers ?? 0) : (spec.shadowMembers ?? spec.srcMembers ?? 0);
    const claims = [];
    for (let k = 0; k < members; k += 1) claims.push({ claimId: `${gid}-m${k}`, text: TEXT });
    for (let k = 0; k < shared; k += 1) claims.push({ claimId: `${gid}-shared${k}`, text: TEXT });
    if (!isSource) {
      for (let k = 0; k < (spec.extraShadow ?? 0); k += 1) claims.push({ claimId: `${gid}-extra${k}`, text: TEXT });
      if (spec.covered) claims.push({ claimId: gid, text: `${TEXT}${TEXT}` });
    }
    // T211：④c 走 mergeStats（inject 的运行时计数）
    const st = !isSource && spec.stats ? spec.stats : null;
    const mergeStats = st
      ? { candidatesHit: st.candidatesHit ?? 0, membersHit: st.membersHit ?? 0, collapsed: st.collapsed ?? 0, bubbled: st.bubbled ?? 0 }
      : { candidatesHit: 0, membersHit: 0, collapsed: 0, bubbled: 0 };
    return { card: { claims, mergeStats } };
  };
}

const mergesOf = (n, membersEach = 2) => Array.from({ length: n }, (_, i) => group(`g${i + 1}`, membersEach));
/** 默认所有成员都能在影库解析（除非测试要验"不可解析"）。 */
const allMemberIds = (merges) => new Set(merges.flatMap((m) => m.merge.members));

// ── T181：可折组的定义 ──────────────────────────────────────────────────────
test('T181 ①: 成员行 ≤1 的组进 notFoldable，不进 ④c 分母', () => {
  const merges = mergesOf(2, 3);
  const measure = measureFrom([{ srcMembers: 1, shared: 2 }, { srcMembers: 3, shadowMembers: 1, covered: true }]);
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure, shadowClaimIds: allMemberIds(merges) });

  assert.equal(res.rows[0].membersSourceRows, 1, 'g1 源库本组成员行 = 1');
  assert.equal(res.rows[0].foldable, false, 'g1 不可折（旧口径 sourceRows>1 会误判成可折）');
  assert.equal(res.rows[1].membersSourceRows, 3);
  assert.equal(res.rows[1].foldable, true);
  assert.equal(res.c.foldable, 1, '④c 分母只有 g2');
  assert.equal(res.c.notFoldable, 1);
  assert.equal(res.c.foldableRatio, 1, '历史列：g2 省了行 ⇒ 1/1');
});

test('T181 ②: 成员行 ≥2 且影库省行 ⇒ 计入 ④c 分子', () => {
  const merges = mergesOf(2);
  const measure = measureFrom([{ srcMembers: 3, shadowMembers: 1, covered: true }, { srcMembers: 4, shadowMembers: 2, covered: true }]);
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure, shadowClaimIds: allMemberIds(merges) });
  assert.equal(res.c.foldable, 2);
  assert.equal(res.c.savedPositive, 2);
  assert.equal(res.c.foldableRatio, 1);
});

test('T181 ③: 成员行 ≥2 但影库没省 ⇒ 分子不加（如实）', () => {
  const merges = mergesOf(2, 3);
  const measure = measureFrom([{ srcMembers: 2 }, { srcMembers: 3, shadowMembers: 1, covered: true }]);
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure, shadowClaimIds: allMemberIds(merges) });
  assert.equal(res.c.foldable, 2);
  assert.equal(res.c.savedPositive, 1, '只有 g2 省行');
  assert.equal(res.c.foldableRatio, 0.5);
  assert.equal(res.pass, true, '④c 低不红（参考指标）');
});

// ── T189 ④b：内容身份（按 claimId 对齐）────────────────────────────────────
test('T189 ②: 源 3 行 → 影 1 行且无合并节点覆盖 ⇒ ④b FAIL（lostRows=2）', () => {
  const merges = mergesOf(1, 3);
  const measure = measureFrom([{ srcMembers: 3, shadowMembers: 1 }]); // 无 covered
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure, shadowClaimIds: allMemberIds(merges) });
  assert.equal(res.rows[0].sourceRows, 3);
  assert.equal(res.rows[0].shadowRows, 1);
  assert.equal(res.rows[0].lostRows, 2, 'g1-m1 / g1-m2 在影卡里既无同 id 也无合并节点覆盖');
  assert.equal(res.b.lostRows, 2);
  assert.equal(res.b.pass, false, '真丢行 ⇒ ④b FAIL');
  assert.equal(res.pass, false);
});

test('T189 ③: 源 3 行 → 影 1 行但合并节点覆盖那 2 行 ⇒ ④b PASS', () => {
  const merges = mergesOf(1, 3);
  const measure = measureFrom([{ srcMembers: 3, shadowMembers: 1, covered: true }]);
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure, shadowClaimIds: allMemberIds(merges) });
  assert.equal(res.rows[0].lostRows, 0, '缺失的 2 行被渲染中的合并节点覆盖');
  assert.equal(res.b.pass, true);
  assert.equal(res.a.pass, true);
});

test('T178 ④a: 任何组反增（影库行数 > 源库）⇒ ④a FAIL', () => {
  const merges = mergesOf(2);
  const measure = measureFrom([{ srcMembers: 2, extraShadow: 2 }, { srcMembers: 2, shadowMembers: 1, covered: true }]);
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure, shadowClaimIds: allMemberIds(merges) });
  assert.equal(res.a.pass, false);
  assert.equal(res.a.worse.length, 1);
  assert.equal(res.pass, false);
});

// ── T189 ②：成员可解析（只增不改）──────────────────────────────────────────
test('T189 ①: 成员不可解析 ⇒ ② FAIL', () => {
  const merges = mergesOf(2);
  const ids = allMemberIds(merges);
  ids.delete('g2-m1'); // 成员记录被删
  const res = checkMembersResolvable({ merges, shadowClaimIds: ids });
  assert.equal(res.unresolvedMembers, 1);
  assert.equal(res.pass, false, '成员消失必须红');
  assert.deepEqual(res.rows[1].missing, ['g2-m1']);

  const ok = checkMembersResolvable({ merges, shadowClaimIds: allMemberIds(merges) });
  assert.equal(ok.pass, true);
  assert.equal(ok.unresolvedMembers, 0);

  const none = checkMembersResolvable({ merges: [], shadowClaimIds: new Set() });
  assert.equal(none.pass, false, '没有合并组 ⇒ fail-closed（不许"0 组被检查 = 通过"）');
});

test('T189 ④: 删光成员后 foldable=0 ⇒ 不得因此变"通过"（② 必须红）', () => {
  const merges = mergesOf(2);
  const measure = measureFrom([{ srcMembers: 3, shadowMembers: 0 }, { srcMembers: 3, shadowMembers: 0 }]);
  const emptyIds = new Set(); // 成员全被删
  const groups = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure, shadowClaimIds: emptyIds });
  assert.equal(groups.c.foldable, 0, '成员不可解析 ⇒ 可折组 = 0');
  assert.equal(groups.c.evidence.verdict, '证据不足');

  const members = checkMembersResolvable({ merges, shadowClaimIds: emptyIds });
  assert.equal(members.pass, false, '② 必须红 —— 不许靠"没有可折组"混过去');
  assert.equal(members.unresolvedMembers, 4);
});

// ── T185：Wilson 区间与样本量门槛 ───────────────────────────────────────────
test('T185 ①: Wilson 对 3/3 给出下界 < 1（不许报 100%）', () => {
  const w = wilsonInterval(3, 3);
  assert.equal(w.phat, 1);
  assert.ok(w.lower < 1);
  assert.ok(Math.abs(w.lower - 3 / (3 + 1.96 * 1.96)) < 1e-9, 'p̂=1 时下界 = n/(n+z²)');
  assert.ok(Math.abs(w.lower - 0.4385) < 0.001);
  assert.equal(w.upper, 1);
  const ten = wilsonInterval(10, 10);
  assert.ok(ten.lower > 0.7 && ten.lower < 1, `10/10 下界应 >0.7，实际 ${ten.lower}`);
  const none = wilsonInterval(0, 0);
  assert.equal(none.lower, null);
});

test('T185 ②: 全组遍历 —— 组数与影库合并节点一致（默认不抽样）', () => {
  const merges = mergesOf(39, 2);
  assert.equal(selectMergeGroups(merges, null).length, 39);
  assert.equal(selectMergeGroups(merges, undefined).length, 39);
  assert.equal(selectMergeGroups(merges, 0).length, 39, '0 = 全量');
  assert.equal(selectMergeGroups(merges, 5).length, 5);
  assert.equal(parseArgs([]).mergeGroups, null);
  assert.equal(parseArgs([]).mergeSample, null, 'T189：② 默认全量检查');
});

test('T185 ③: 可折组 <10 ⇒ 结论"证据不足"（哪怕全中）', () => {
  const merges = mergesOf(3);
  const st = { membersHit: 3, collapsed: 2, bubbled: 1 };
  const measure = measureFrom([{ srcMembers: 3, shadowMembers: 1, covered: true, stats: st }, { srcMembers: 3, shadowMembers: 1, covered: true, stats: st }, { srcMembers: 3, shadowMembers: 1, covered: true, stats: st }]);
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure, shadowClaimIds: allMemberIds(merges) });
  assert.equal(res.c.foldable, 3);
  assert.equal(res.c.foldableRatio, 1);
  assert.equal(res.c.evidence.verdict, '证据不足');
  assert.match(res.c.evidence.reason, /命中的组 3 < 10/);
  assert.equal(res.c.evidence.threshold, 0.7, 'T189：下界门槛 0.7');

  const many = mergesOf(10);
  const measureMany = measureFrom(Array.from({ length: 10 }, () => ({ srcMembers: 3, shadowMembers: 1, covered: true, stats: st })));
  const resMany = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges: many, measure: measureMany, shadowClaimIds: allMemberIds(many) });
  assert.equal(resMany.c.foldable, 10);
  assert.equal(resMany.c.evidence.verdict, '有证据');
  assert.ok(resMany.c.wilson.lower > 0.7);
});

test('T189 ④c: Wilson 下界 < 0.7 ⇒ 证据不足（抬高门槛后不再算"可靠"）', () => {
  const merges = mergesOf(10);
  // 7/10 省行 ⇒ p̂=0.7，Wilson 下界 ≈ 0.397 < 0.7
  const specs = Array.from({ length: 10 }, (_, i) => (i < 7 ? { srcMembers: 3, shadowMembers: 1, covered: true } : { srcMembers: 2 }));
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure: measureFrom(specs), shadowClaimIds: allMemberIds(merges) });
  assert.equal(res.c.foldable, 10);
  assert.equal(res.c.savedPositive, 7);
  assert.ok(res.c.wilson.lower < 0.7);
  assert.equal(res.c.evidence.verdict, '证据不足');
});

// ── 杂项 ───────────────────────────────────────────────────────────────────
test('T178: 一行也没省但无变差无丢失 ⇒ 整体 PASS（④c 为 0 也不红）', () => {
  const merges = mergesOf(2);
  const measure = measureFrom([{ srcMembers: 2 }, { srcMembers: 2 }]);
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure, shadowClaimIds: allMemberIds(merges) });
  assert.equal(res.c.savedPositive, 0);
  assert.equal(res.a.pass, true);
  assert.equal(res.b.pass, true);
  assert.equal(res.pass, true);
});

test('T173: 没有合并组 / 组缺正文 ⇒ 不误判通过（fail-closed）', () => {
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges: [], measure: measureFrom([]) });
  assert.equal(res.groups, 0);
  assert.equal(res.a.pass, false);
  assert.equal(res.b.pass, false);
  const noText = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges: [{ id: 'x', text: '   ', scopeKey: '' }], measure: measureFrom([]) });
  assert.equal(noText.rows[0].why, 'no-text-or-scope');
  assert.equal(noText.c.foldable, 0);
});

test('T173: --merge-groups / --merge-sample 参数解析', () => {
  assert.equal(parseArgs(['--store', 'a', '--merge-groups', '7']).mergeGroups, 7);
  assert.equal(parseArgs([]).mergeGroups, null);
  assert.equal(parseArgs([]).sample, 40);
  assert.equal(parseArgs(['--merge-sample', '3']).mergeSample, 3);
});

test('T173: 归一化与重复行计数（合流收益的两个原子）', () => {
  assert.equal(normalizeText('  a\n\n b\t'), 'a b');
  const dup = countDuplicateRows([
    { claimId: 'c1', text: '同一句话' },
    { claimId: 'c2', text: '同一句话 ' },
    { claimId: 'c1', text: '同一句话' },
    { claimId: 'c3', text: '别的' },
  ]);
  assert.equal(dup.duplicates, 1);
  assert.equal(dup.groups, 1);
});

// ── T211：④c 换 mergeStats 口径（有成员命中的组里，实际折叠了行的占比）───────
test('T211 ①: 有成员命中且折叠了行 ⇒ 计入分子', () => {
  const merges = mergesOf(2);
  const measure = measureFrom([
    { srcMembers: 3, shadowMembers: 1, covered: true, stats: { membersHit: 4, collapsed: 3, bubbled: 1 } },
    { srcMembers: 3, shadowMembers: 2, covered: true, stats: { membersHit: 2, collapsed: 1, bubbled: 1 } },
  ]);
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure, shadowClaimIds: allMemberIds(merges) });
  assert.equal(res.c.hitGroups, 2, '两组都有成员命中');
  assert.equal(res.c.collapsedGroups, 2, '两组都折叠了行');
  assert.equal(res.c.collapsedRows, 4, '折叠总行数 3+1');
  assert.equal(res.c.bubbledRows, 2);
  assert.equal(res.c.ratio, 1);
  assert.equal(res.c.wilson.n, 2);
});

test('T211 ②: 无成员命中 ⇒ 不进分母（④c 无定义）', () => {
  const merges = mergesOf(2);
  const measure = measureFrom([
    { srcMembers: 3, shadowMembers: 1, covered: true, stats: { membersHit: 0, collapsed: 0, bubbled: 0 } },
    { srcMembers: 3, shadowMembers: 1, covered: true, stats: { membersHit: 0, collapsed: 0, bubbled: 0 } },
  ]);
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure, shadowClaimIds: allMemberIds(merges) });
  assert.equal(res.c.hitGroups, 0);
  assert.equal(res.c.ratio, null, '没有命中组 ⇒ 无定义（不是 0%）');
  assert.equal(res.c.evidence.verdict, '证据不足');
  assert.match(res.c.evidence.reason, /没有成员命中的组/);
});

test('T211 ③: 命中但没折叠 ⇒ 分子不加（如实）', () => {
  const merges = mergesOf(3);
  const measure = measureFrom([
    { srcMembers: 3, shadowMembers: 2, covered: true, stats: { membersHit: 3, collapsed: 0, bubbled: 3 } },
    { srcMembers: 3, shadowMembers: 1, covered: true, stats: { membersHit: 2, collapsed: 2, bubbled: 0 } },
    { srcMembers: 3, shadowMembers: 2, covered: true, stats: { membersHit: 1, collapsed: 0, bubbled: 1 } },
  ]);
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure, shadowClaimIds: allMemberIds(merges) });
  assert.equal(res.c.hitGroups, 3);
  assert.equal(res.c.collapsedGroups, 1, '只有一组真折叠');
  assert.equal(res.c.ratio, 1 / 3);
  assert.equal(res.c.bubbledGroups, 2);
  assert.equal(res.c.evidence.verdict, '证据不足', '命中组 3 < 10');
});

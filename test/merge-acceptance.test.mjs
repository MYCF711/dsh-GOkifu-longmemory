// T173/T178/T181 的 tombstone test：删掉 `scripts/merge-acceptance.mjs` 的 `sampleMergeGroups` ⇒ 本文件红。
//
// 覆盖：
//   - T173 定点抽样：信号 = 合并组的共享正文（真实链路 walk → buildMemoryCard；测试注入假 measure 只验聚合）
//   - T178 三条闸门：④a 不许变差 / ④b 不许丢内容 / ④c 只作参考（不参与退出码）
//   - T181 ④c 的**分母**改成"可折组"= 源库卡片里**本组成员行 ≥2** 的组；
//     成员行 ≤1 的组进 `notFoldable`，**不进分母**（旧口径把无关行算进分母，测的不是合流收益）
//
// 只读：不写任何库；纯函数聚合，零模型调用。

import test from 'node:test';
import assert from 'node:assert/strict';

import { sampleMergeGroups, parseArgs, normalizeText, countDuplicateRows } from '../scripts/merge-acceptance.mjs';

/** 造一个合并组：成员 id 为 `<id>-m0..m{n-1}`。 */
const group = (id, members = 2, text = `合并组 ${id} 的共享正文`) => ({
  id,
  text,
  scopeKey: 'w:d:/work/demo',
  merge: { members: Array.from({ length: members }, (_, i) => `${id}-m${i}`) },
});

const srcStore = { __key: 'src' };
const shadowStore = { __key: 'shadow' };

/**
 * 假 measure：按"第几次调用"返回一张卡。
 * `specs[i] = { src: 源库行数, shadow: 影库行数, members: 本组成员数 }`
 * 卡片里前 min(行数, members) 行是**本组成员**，其余是无关 claim。
 */
function measureFrom(specs) {
  let call = 0;
  return () => {
    const gi = Math.floor(call / 2);
    const isSource = call % 2 === 0;
    call += 1;
    const spec = specs[gi] ?? { src: 0, shadow: 0, members: 0 };
    const n = isSource ? spec.src : spec.shadow;
    const memberCap = Math.min(spec.members ?? 0, n);
    const claims = [];
    for (let k = 0; k < n; k += 1) {
      claims.push({ claimId: k < memberCap ? `g${gi + 1}-m${k}` : `g${gi + 1}-other${k}` });
    }
    return { card: { claims } };
  };
}

const mergesOf = (n, membersEach = 2) => Array.from({ length: n }, (_, i) => group(`g${i + 1}`, membersEach));

test('T181 ①: 成员行 ≤1 的组进 notFoldable，不进 ④c 分母', () => {
  // g1：源库 3 行但**本组成员只有 1 行**（另外 2 行是无关 claim）⇒ 不可折
  // g2：源库 2 行、成员 2 行 ⇒ 可折
  const merges = mergesOf(2);
  const measure = measureFrom([{ src: 3, shadow: 3, members: 1 }, { src: 2, shadow: 1, members: 2 }]);
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure });

  assert.equal(res.rows[0].membersSourceRows, 1, 'g1 源库本组成员行 = 1');
  assert.equal(res.rows[0].foldable, false, 'g1 不可折（旧口径 sourceRows=3>1 会误判成可折）');
  assert.equal(res.rows[1].membersSourceRows, 2);
  assert.equal(res.rows[1].foldable, true);

  assert.equal(res.c.foldable, 1, '④c 分母只有 g2');
  assert.equal(res.c.notFoldable, 1, 'g1 单列 notFoldable');
  assert.equal(res.c.ratio, 1, 'g2 省了行 ⇒ 1/1');
  assert.deepEqual(res.c.membersSourceRows.map((r) => [r.id, r.membersSourceRows, r.membersShadowRows]), [
    ['g1', 1, 1],
    ['g2', 2, 1],
  ]);
});

test('T181 ②: 成员行 ≥2 且影库省行 ⇒ 计入 ④c 分子', () => {
  const merges = mergesOf(2);
  const measure = measureFrom([{ src: 3, shadow: 2, members: 2 }, { src: 4, shadow: 3, members: 3 }]);
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure });
  assert.equal(res.c.foldable, 2);
  assert.equal(res.c.savedPositive, 2);
  assert.equal(res.c.ratio, 1);
  assert.equal(res.c.avgSaved, 1, '(3-2 + 4-3) / 2 = 1');
});

test('T181 ③: 成员行 ≥2 但影库没省 ⇒ 分子不加（如实）', () => {
  const merges = mergesOf(2);
  // g1 可折但没省（3→3）；g2 可折且省（2→1）
  const measure = measureFrom([{ src: 3, shadow: 3, members: 2 }, { src: 2, shadow: 1, members: 2 }]);
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure });
  assert.equal(res.c.foldable, 2);
  assert.equal(res.c.savedPositive, 1, '只有 g2 省行');
  assert.equal(res.c.ratio, 0.5);
  assert.equal(res.c.avgSaved, 0.5, '(0 + 1) / 2');
  assert.equal(res.a.pass, true, '没变差');
  assert.equal(res.b.pass, true, '没丢内容');
  assert.equal(res.pass, true, '④c 低不红（参考指标）');
});

test('T178 ④a: 任何组反增（影库行数 > 源库）⇒ ④a FAIL', () => {
  const merges = mergesOf(2);
  const measure = measureFrom([{ src: 3, shadow: 4, members: 2 }, { src: 2, shadow: 1, members: 2 }]);
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure });
  assert.equal(res.a.pass, false);
  assert.deepEqual(res.a.worse, [{ id: 'g1', sourceRows: 3, shadowRows: 4 }]);
  assert.equal(res.pass, false);
});

test('T178 ④b: 源库有行、影库 0 行（丢内容）⇒ ④b FAIL', () => {
  const merges = mergesOf(2);
  const measure = measureFrom([{ src: 2, shadow: 0, members: 2 }, { src: 3, shadow: 3, members: 2 }]);
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure });
  assert.equal(res.a.pass, true, '没有反增组');
  assert.equal(res.b.pass, false, '有丢内容组');
  assert.deepEqual(res.b.losses, [{ id: 'g1', sourceRows: 2, shadowRows: 0 }]);
  assert.equal(res.pass, false, '④b 不过 ⇒ 退出码 1');
});

test('T178: 一行也没省但无变差无丢失 ⇒ 整体 PASS（④c 为 0 也不红）', () => {
  const merges = mergesOf(2);
  const measure = measureFrom([{ src: 2, shadow: 2, members: 2 }, { src: 5, shadow: 5, members: 2 }]);
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure });
  assert.equal(res.c.savedPositive, 0);
  assert.equal(res.c.ratio, 0);
  assert.equal(res.a.pass, true);
  assert.equal(res.b.pass, true);
  assert.equal(res.pass, true, '④c 只是参考');
});

test('T173: 没有合并组 / 组缺正文 ⇒ 不误判通过（fail-closed）', () => {
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges: [], measure: measureFrom([]) });
  assert.equal(res.groups, 0);
  assert.equal(res.c.foldable, 0);
  assert.equal(res.c.ratio, null);
  assert.equal(res.a.pass, false, '没有样品不能算 ④a 通过');
  assert.equal(res.b.pass, false, '没有样品不能算 ④b 通过');

  const noText = sampleMergeGroups({
    source: srcStore,
    shadow: shadowStore,
    sourceCache: {},
    shadowCache: {},
    merges: [{ id: 'x', text: '   ', scopeKey: '' }],
    measure: measureFrom([]),
  });
  assert.equal(noText.rows[0].why, 'no-text-or-scope');
  assert.equal(noText.rows[0].foldable, false);
  assert.equal(noText.c.foldable, 0);
});

test('T173: --merge-groups 参数与既有参数解析', () => {
  assert.equal(parseArgs(['--store', 'a', '--merge-groups', '7']).mergeGroups, 7);
  assert.equal(parseArgs([]).mergeGroups, 20, '默认 20 组');
  assert.equal(parseArgs([]).sample, 40);
  assert.equal(parseArgs(['--merge-sample', '3']).mergeSample, 3);
});

test('T173: 归一化与重复行计数（合流收益的两个原子）', () => {
  assert.equal(normalizeText('  a\n\n b\t'), 'a b');
  const dup = countDuplicateRows([
    { claimId: 'c1', text: '同一句话' },
    { claimId: 'c2', text: '同一句话 ' },
    { claimId: 'c1', text: '同一句话' }, // 同 id 重复不算
    { claimId: 'c3', text: '别的' },
  ]);
  assert.equal(dup.duplicates, 1, 'c1/c2 同文 ⇒ 多出来 1 行');
  assert.equal(dup.groups, 1);
});

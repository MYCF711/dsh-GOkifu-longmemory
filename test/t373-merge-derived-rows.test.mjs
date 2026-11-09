// T373 · ④b「不许丢内容」必须把**源库自己的合并节点行**排除在分母外 —— 删掉这条过滤 ⇒ 本片红。
//
// 真事（2026-11-09，真库）：源库**已含 39 个合并节点**（早前一次合流写进去的）。旧口径下，
// 源卡里那些节点的行在影卡里"没有对应行"（T187 有意不让合并节点成行）⇒ 一律记 lostRows。
// 实测能复现的丢失行 **14/14 都是"源库就是合并节点"**：没有一行是普通内容行、也没有成员行。
// 合并节点的**成员**才是内容，它们由影卡里的合并节点代表。
import test from 'node:test';
import assert from 'node:assert/strict';

import { sampleMergeGroups } from '../scripts/merge-acceptance.mjs';

const SCOPE = 'w:d:/work/demo';
/** 合并组：成员 `<id>-m0..`。 */
const group = (id, members = 2, text = `合并组 ${id} 的共享正文`) => ({
  id, text, scopeKey: SCOPE, merge: { members: Array.from({ length: members }, (_, i) => `${id}-m${i}`) },
});

/** 源/影 store 假体：只提供 `list('claims')`（T373 用它取"源库侧的合并节点 id"）。 */
const store = (records = []) => ({ list: (kind) => (kind === 'claims' ? records.map((r) => ({ record: r })) : []) });

const card = (ids) => ({ card: { claims: ids.map((id) => ({ claimId: id, text: 'x'.repeat(20) })) } });

test('T373 ①: 源库自己的合并节点行不算丢内容（另记 derivedRowSkipped）', () => {
  const g = group('m-merge-1', 2);
  const DERIVED = 'c-alreadymerged';
  const srcStore = store([{ id: DERIVED, merge: { members: ['c-a', 'c-b'] } }]);
  const measure = (s) => (s === srcStore
    ? card(['m-merge-1-m0', DERIVED])          // 源卡：一条成员行 + 一条"源库本来就是合并节点"的行
    : card(['m-merge-1']));                    // 影卡：只剩合并节点行
  const res = sampleMergeGroups({
    source: srcStore, shadow: store(), sourceCache: {}, shadowCache: {}, merges: [g], measure,
    shadowClaimIds: new Set(['m-merge-1', 'm-merge-1-m0']),
  });
  assert.equal(res.rows[0].lostRows, 0, '派生物不算丢内容');
  assert.equal(res.b.lostRows, 0, "④b 汇总为 0");
});

test('T373 ②: 普通内容行真的丢了 ⇒ 仍算 red（过滤不许把真问题一起放过）', () => {
  const g = group('m-merge-2', 2);
  const measure = (s) => (s === globalThis.__src2 ? card(['m-merge-2-m0', 'c-real-content']) : card(['m-merge-2']));
  const srcStore = store([]);   // 源库没有合并节点
  globalThis.__src2 = srcStore;
  const res = sampleMergeGroups({
    source: srcStore, shadow: store(), sourceCache: {}, shadowCache: {}, merges: [g], measure,
    shadowClaimIds: new Set(['m-merge-2', 'm-merge-2-m0']),
  });
  assert.equal(res.rows[0].lostRows, 1, '普通行丢了必须报出来');
  assert.equal(res.b.lostRows, 1, "④b 汇总为 1（真丢行必须红）");
  delete globalThis.__src2;
});

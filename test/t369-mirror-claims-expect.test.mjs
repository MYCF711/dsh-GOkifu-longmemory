// T369 · claims 的「多出来」必须按**实际新增 id** 数，不能按组数 —— 删掉 id 差集 ⇒ 本片红。
//
// 真事（2026-11-09）：源库**已经含 39 个合并节点**（早前一次合流的产物）。于是本轮 73 个组里，
// 32 个的合并 id 在源库里已存在 ⇒ 影库只会多出 41 条。旧公式写死「源库 + 组数」⇒ 必报
// 「claims 不一致」，让人以为镜像漏了。
import test from 'node:test';
import assert from 'node:assert/strict';

import { mirrorAll } from '../scripts/consolidate-apply.mjs';

/** 造一对 store：源的 claim id 集合固定；影库 = 源 ∪ 新增的合并 id。 */
function makeStores({ sourceIds, newIds }) {
  const src = {
    root: '/src',
    list: (kind) => (kind === 'claims' ? sourceIds.map((id) => ({ record: { id } })) : []),
    counts: () => ({ adjudications: 0, claims: sourceIds.length, episodes: 1, joseki: 0, links: 0, threads: 0, topics: 0 }),
  };
  const dstIds = [...sourceIds, ...newIds];
  const dst = {
    root: '/dst',
    putMany: () => ({ written: 0, unchanged: 0 }),
    writeIndex: () => ({ changed: false }),
    writeManifest: () => ({ changed: false, manifest: { files: 0 } }),
    list: (kind) => (kind === 'claims' ? dstIds.map((id) => ({ record: { id } })) : []),
    counts: () => ({ adjudications: 0, claims: dstIds.length, episodes: 1, joseki: 0, links: 0, threads: 0, topics: 0 }),
  };
  return { src, dst };
}

test('T369 ①: 组里有一部分合并 id 已在源库 ⇒ 按 id 差集算，报「一致」', async () => {
  // 73 组里 32 个 id 源库已有 ⇒ 实际新增 41
  const sourceIds = ['c-aaaa0001', 'c-aaaa0002', 'c-merge001', 'c-merge002'];
  const newIds = ['c-new00001', 'c-new00002', 'c-new00003'];
  const { src, dst } = makeStores({ sourceIds, newIds });
  const m = mirrorAll({ src, dst, at: 1, extraClaims: 73 });
  assert.equal(m.extraClaims, 3, '实际新增按 id 差集 = 3，不是组数 73');
  assert.equal(m.groupCount, 73, '组数如实保留，便于对照');
  assert.equal(m.expected.claims, sourceIds.length + 3);
  assert.equal(m.mirrorOk, true, '影库 = 源 ∪ 新增 ⇒ 必须一致');
  assert.deepEqual(m.mismatches, []);
});

test('T369 ②: 影库真的少了一条 ⇒ 仍报不一致（真漏必须红）', async () => {
  const sourceIds = ['c-aaaa0001'];
  const { src, dst } = makeStores({ sourceIds, newIds: [] });
  const m = mirrorAll({ src, dst, at: 1, extraClaims: 0 });
  assert.equal(m.mirrorOk, true);
  // 影库少一条：直接改 dst 的 counts
  const dstShort = { ...dst, counts: () => ({ adjudications: 0, claims: 0, episodes: 1, joseki: 0, links: 0, threads: 0, topics: 0 }) };
  const m2 = mirrorAll({ src, dst: dstShort, at: 1, extraClaims: 0 });
  assert.equal(m2.mirrorOk, false);
  assert.deepEqual(m2.mismatches, ['claims']);
});

// T368 · 镜像「不一致」必须区分「漏了」和「源库变了」—— 删掉 drift 逻辑 ⇒ 本片红。
//
// 真事（2026-11-09）：宿主在跑、会话一结束就归档，一次 `--all` 要 200 秒；
// 期间源库从 1654 局长到 1908 局。旧实现只在**结束时**读 `src.counts()` 去比影库，
// 于是必然报「逐 kind 不一致」—— 可那个「不一致」其实是「源库变了」，不是「镜像漏了」。
import test from 'node:test';
import assert from 'node:assert/strict';

const GROWING = { episodes: [1654, 1908], topics: [4417, 5009], claims: [2671, 2671] };

/** 造一对最小 store：源的计数随调用次数推进（模拟"镜像期间源库在长"）。 */
function makeStores() {
  let reads = 0;
  const src = {
    root: '/src',
    list: () => [],
    counts() {
      reads += 1;
      const phase = reads === 1 ? 0 : 1; // 第一次 = before，之后 = after
      return Object.fromEntries(Object.entries(GROWING).map(([k, [a, b]]) => [k, phase ? b : a]));
    },
    entries: [],
  };
  const shadowCounts = { episodes: 1654, topics: 4417, claims: 2671 }; // 影库 = 开始时的快照
  const dst = { putMany: () => ({ written: 0, unchanged: 0 }), writeIndex: () => ({ changed: false }), writeManifest: () => ({ changed: false, manifest: { files: 0 } }), counts: () => ({ ...shadowCounts }), root: '/dst' };
  return { src, dst };
}

test('T368 ①: 源库在镜像期间长大 ⇒ 报 drift，且**不算**不一致（以开始时快照为准）', async () => {
  const mod = await import('../scripts/consolidate-apply.mjs');
  const { src, dst } = makeStores();
  const m = mod.mirrorAll({ src, dst, at: 1 });
  assert.deepEqual(m.drift.map((d) => d.kind).sort(), ['episodes', 'topics'], '长大的两个 kind 必须报出来');
  assert.equal(m.mirrorOk, true, '影库对应开始时快照 ⇒ 一致');
  assert.ok(m.mismatches.length === 0);
  assert.equal(m.beforeCounts.episodes, 1654, 'expected 必须基于开始时快照');
});

test('T368 ②: 源库没变但影库少了 ⇒ 仍报不一致（真漏必须红）', async () => {
  const mod = await import('../scripts/consolidate-apply.mjs');
  const src = { root: '/src', list: () => [], counts: () => ({ episodes: 10, topics: 20, claims: 30 }) };
  const dst = { putMany: () => ({ written: 0, unchanged: 0 }), writeIndex: () => ({ changed: false }), writeManifest: () => ({ changed: false, manifest: { files: 0 } }), counts: () => ({ episodes: 9, topics: 20, claims: 30 }), root: '/dst' };
  const m = mod.mirrorAll({ src, dst, at: 1 });
  assert.deepEqual(m.mismatches, ['episodes'], '真漏掉的 kind 必须报不一致');
  assert.equal(m.mirrorOk, false);
  assert.deepEqual(m.drift, [], '源库没动 ⇒ 不许有 drift');
});

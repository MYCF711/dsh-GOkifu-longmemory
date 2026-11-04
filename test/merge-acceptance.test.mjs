// T173 的 tombstone test：删掉 `scripts/merge-acceptance.mjs` 的 `sampleMergeGroups` ⇒ 本文件红。
//
// 覆盖（任务书 T173 验收）：
//   - 定点抽样：信号 = 合并组的共享正文（走真实链路 walk → buildMemoryCard；测试里注入假 measure 只验聚合）
//   - 源库该组 ≤1 行 ⇒ **未触发**，不算进分母
//   - 汇总：n 组 · 平均省 X 行 · 至少省 1 行的占比；占比 ≥ 80% 才 `pass`
//   - 影库比源库**多行**的组要单独列出（`worse`）
//   - `--merge-groups` 参数解析
//
// 只读：不写任何库；纯函数聚合，零模型调用。

import test from 'node:test';
import assert from 'node:assert/strict';

import { sampleMergeGroups, parseArgs, normalizeText, countDuplicateRows } from '../scripts/merge-acceptance.mjs';

const group = (id, members = 2, text = `合并组 ${id} 的共享正文`) => ({
  id,
  text,
  scopeKey: 'w:d:/work/demo',
  merge: { members: Array.from({ length: members }, (_, i) => `${id}-m${i}`) },
});

/** 假 measure：按组 id 返回预设行数（sourceRows / shadowRows）。 */
function fakeMeasure(table) {
  return (store, cache) => {
    const key = store?.__key ?? cache?.__key;
    return { card: { claims: new Array(table[key] ?? 0).fill(0).map((_, i) => ({ claimId: `x${i}` })) } };
  };
}

const srcStore = { __key: 'src' };
const shadowStore = { __key: 'shadow' };

test('T173: 定点抽样汇总 —— 未触发不计分母、占比 ≥80% 才 pass', () => {
  const merges = [group('g1'), group('g2'), group('g3'), group('g4')];
  // g1: 3→1 省 2 · g2: 2→1 省 1 · g3: 1→1 未触发 · g4: 2→2 省 0（触发但没省）
  const rows = { src: [3, 2, 1, 2], shadow: [1, 1, 1, 2] };
  let i = 0;
  const measure = () => {
    const idx = i % 4;
    i += 1;
    return { card: { claims: new Array(rows[idx === 0 ? 'src' : 'shadow'][idx] ?? 0).fill(0).map((_, k) => ({ claimId: `c${k}` })) } };
  };
  // 用 index 轮转：第 1 次 src、第 2 次 shadow、第 3 次 src ……（4 组 ×2 = 8 次）
  let call = 0;
  const measure2 = () => {
    const groupIdx = Math.floor(call / 2);
    const isSource = call % 2 === 0;
    call += 1;
    const n = isSource ? rows.src[groupIdx] : rows.shadow[groupIdx];
    return { card: { claims: new Array(n).fill(0).map((_, k) => ({ claimId: `c${k}` })) } };
  };
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure: measure2 });
  assert.equal(res.groups, 4);
  assert.equal(res.untriggered, 1, 'g3 源库只有 1 行 ⇒ 未触发');
  assert.equal(res.triggered, 3);
  assert.equal(res.savedTotal, 3, 'g1 省 2 + g2 省 1 + g4 省 0');
  assert.equal(res.savedPositive, 2, '省 ≥1 行的组：g1/g2');
  assert.equal(res.ratio, 2 / 3);
  assert.equal(res.pass, false, '66.7% < 80% ⇒ 不通过');
  assert.ok(measure);

  // 3/3 触发组都省 ≥1 行 ⇒ 通过
  const allSave = [group('a'), group('b'), group('c')];
  const rows2 = { src: [2, 3, 4], shadow: [1, 1, 1] };
  let call2 = 0;
  const measure3 = () => {
    const gi = Math.floor(call2 / 2);
    const isSrc = call2 % 2 === 0;
    call2 += 1;
    const n = isSrc ? rows2.src[gi] : rows2.shadow[gi];
    return { card: { claims: new Array(n).fill(0).map((_, k) => ({ claimId: `c${k}` })) } };
  };
  const res2 = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges: allSave, measure: measure3 });
  assert.equal(res2.triggered, 3);
  assert.equal(res2.savedPositive, 3);
  assert.equal(res2.ratio, 1);
  assert.equal(res2.pass, true);
  assert.equal(res2.avgSaved, 2);
});

test('T173: 影库比源库多行的组要单列（worse）', () => {
  const merges = [group('w1'), group('w2')];
  const rows = { src: [1, 2], shadow: [2, 3] };
  let call = 0;
  const measure = () => {
    const gi = Math.floor(call / 2);
    const isSrc = call % 2 === 0;
    call += 1;
    const n = isSrc ? rows.src[gi] : rows.shadow[gi];
    return { card: { claims: new Array(n).fill(0).map((_, k) => ({ claimId: `c${k}` })) } };
  };
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges, measure });
  assert.equal(res.worse.length, 2);
  assert.deepEqual(res.worse.map((x) => [x.id, x.sourceRows, x.shadowRows]), [['w1', 1, 2], ['w2', 2, 3]]);
  assert.equal(res.pass, false, 'w1 未触发（分母 1），w2 省 -1 ⇒ 至少省 1 行的占比 0%');
});

test('T173: 没有合并组 / 组缺正文 ⇒ 不误判通过', () => {
  const res = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges: [], measure: fakeMeasure({}) });
  assert.equal(res.groups, 0);
  assert.equal(res.triggered, 0);
  assert.equal(res.ratio, null);
  assert.equal(res.pass, false, '没有样品不能算通过');

  const noText = sampleMergeGroups({ source: srcStore, shadow: shadowStore, sourceCache: {}, shadowCache: {}, merges: [{ id: 'x', text: '   ', scopeKey: '' }], measure: fakeMeasure({}) });
  assert.equal(noText.rows[0].why, 'no-text-or-scope');
  assert.equal(noText.triggered, 0);
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

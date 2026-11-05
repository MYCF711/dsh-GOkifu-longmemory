// T253 · Q18 复评脚本的单测（纯函数为主，不依赖真库）
//
// 覆盖：精确二项（McNemar 用）、配对比较（onlyA/onlyB/Δ/p）、判据（A5 否决优先、Wilson 下界 > 上界才算显著）、分桶。

import test from 'node:test';
import assert from 'node:assert/strict';

import { bucketOf, bucketTable, decide, exactBinomialTwoSided, pairedCompare } from '../scripts/q18-reeval.mjs';

const arm = (hits) => ({ items: hits.map(([id, strict, kind = 'self', signalSource = 'root']) => ({ id, strict, kind, signalSource })), strictHits: hits.filter((x) => x[1]).length, n: hits.length, a5Leaks: 0 });

test('T253 精确二项：k=0/n=5 与 k=5/n=5 都应显著（p≈0.0625），k=2/n=4 不显著', () => {
  assert.ok(Math.abs(exactBinomialTwoSided(0, 5) - 0.0625) < 1e-9, `0/5 p=${exactBinomialTwoSided(0, 5)}`);
  assert.ok(Math.abs(exactBinomialTwoSided(5, 5) - 0.0625) < 1e-9);
  assert.ok(exactBinomialTwoSided(2, 4) > 0.9, `2/4 p=${exactBinomialTwoSided(2, 4)}`);
  assert.equal(exactBinomialTwoSided(0, 0), 1, '没有 discordant 对 ⇒ p=1');
});

test('T253 配对比较：只数 discordant，Δ = onlyB - onlyA', () => {
  const a = arm([['i1', true], ['i2', true], ['i3', false], ['i4', false]]);
  const b = arm([['i1', true], ['i2', false], ['i3', true], ['i4', false]]);
  const p = pairedCompare(a, b);
  assert.equal(p.both, 1);
  assert.equal(p.onlyA, 1);
  assert.equal(p.onlyB, 1);
  assert.equal(p.neither, 1);
  assert.equal(p.discordant, 2);
  assert.equal(p.delta, 0);
  assert.ok(p.pExact > 0.9, `1 vs 1 不显著，p=${p.pExact}`);
});

test('T253 判据：A5 不为 0 ⇒ 否决 B（即使命中更高）', () => {
  const a = { ...arm([['i1', false], ['i2', false]]), a5Leaks: 0 };
  const b = { ...arm([['i1', true], ['i2', true]]), a5Leaks: 3 };
  const p = pairedCompare(a, b);
  const d = decide({ a, b, paired: p });
  assert.equal(d.a5ok, false);
  assert.equal(d.recommend, 'A', '有泄漏就不许开');
  assert.match(d.reason, /A5/);
});

test('T253 判据：命中更高但 Wilson 区间重叠 ⇒ 仍维持 A', () => {
  // n=20，A=4，B=8：区间重叠，不显著
  const a = { ...arm(Array.from({ length: 20 }, (_, i) => [`i${i}`, i < 4])), a5Leaks: 0 };
  const b = { ...arm(Array.from({ length: 20 }, (_, i) => [`i${i}`, i < 8])), a5Leaks: 0 };
  const p = pairedCompare(a, b);
  const d = decide({ a, b, paired: p });
  assert.equal(d.significantlyHigher, false);
  assert.equal(d.recommend, 'A');
});

test('T253 判据：B 显著更高且 A5=0 ⇒ 建议 B', () => {
  // n=100，A=10，B=60：区间不重叠
  const a = { ...arm(Array.from({ length: 100 }, (_, i) => [`i${i}`, i < 10])), a5Leaks: 0 };
  const b = { ...arm(Array.from({ length: 100 }, (_, i) => [`i${i}`, i < 60])), a5Leaks: 0 };
  const p = pairedCompare(a, b);
  const d = decide({ a, b, paired: p });
  assert.equal(d.a5ok, true);
  assert.equal(d.significantlyHigher, true);
  assert.equal(d.recommend, 'B');
});

test('T253 分桶：repeat / shortRoot / firstUser / self-root 各归各的', () => {
  assert.equal(bucketOf({ kind: 'repeat', signalSource: 'signature' }), 'repeat');
  assert.equal(bucketOf({ kind: 'self', signalSource: 'shortRootEntities' }), 'shortRoot');
  assert.equal(bucketOf({ kind: 'self', signalSource: 'firstUser' }), 'firstUser');
  assert.equal(bucketOf({ kind: 'self', signalSource: 'root' }), 'self/root');
  const a = arm([['i1', true, 'self', 'root'], ['i2', false, 'self', 'shortRootEntities'], ['i3', false, 'repeat', 'signature']]);
  const b = arm([['i1', true, 'self', 'root'], ['i2', true, 'self', 'shortRootEntities'], ['i3', false, 'repeat', 'signature']]);
  const t = bucketTable(a, b);
  assert.equal(t['self/root'].n, 1);
  assert.equal(t.shortRoot.n, 1);
  assert.equal(t.shortRoot.onlyB, 1, 'B 在 shortRoot 桶翻转了 1 条');
  assert.equal(t.repeat.n, 1);
  assert.equal(t.repeat.b, 0);
});

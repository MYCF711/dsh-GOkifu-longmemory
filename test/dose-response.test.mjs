// T306 · 剂量-反应的单测（纯函数）
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUCKETS, bucketOfStrength } from '../scripts/dose-response.mjs';

test('T306 分层档位先定死：0 / 1 / 2-3 / 4+', () => {
  assert.deepEqual(BUCKETS.map((b) => b.key), ['0（无记忆）', '1', '2-3', '4+']);
  assert.equal(bucketOfStrength(0), '0（无记忆）');
  assert.equal(bucketOfStrength(1), '1');
  assert.equal(bucketOfStrength(2), '2-3');
  assert.equal(bucketOfStrength(3), '2-3');
  assert.equal(bucketOfStrength(4), '4+');
  assert.equal(bucketOfStrength(99), '4+');
});

test('T306 档位边界不重叠：每个整数只落一层', () => {
  const seen = new Map();
  for (let i = 0; i <= 20; i += 1) {
    const k = bucketOfStrength(i);
    assert.ok(!seen.has(k) || seen.get(k) <= i, `层 ${k} 的取值必须连续`);
    seen.set(k, i);
  }
  assert.equal(new Set([...Array(21).keys()].map(bucketOfStrength)).size, 4, '恰好 4 层');
});

test('T306 缺失/非数字强度按 0 处理（不许静默进高档）', () => {
  assert.equal(bucketOfStrength(undefined), '0（无记忆）');
  assert.equal(bucketOfStrength(null), '0（无记忆）');
  assert.equal(bucketOfStrength('abc'), '0（无记忆）');
  assert.equal(bucketOfStrength(-5), '0（无记忆）');
});

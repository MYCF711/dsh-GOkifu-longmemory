// T404：大数组不许用 `push(...arr)` 展开 —— 真库 163,528 条 links 会把栈打爆。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNeighborhood } from '../src/rooms/view.mjs';

test('T404: links 16 万条时 buildNeighborhood 不栈溢出（不许 push(...arr)）', () => {
  const N = 163_528;
  const links = Array.from({ length: N }, (_, i) => ({
    id: `link-${i}`, kind: 'shared-topic',
    a: { episode: `ep-${i % 1000}` }, b: { episode: 'ep-0' }, topics: [], weight: 1, why: 'x',
  }));
  const view = {
    episodes: Array.from({ length: 1000 }, (_, i) => ({ id: `ep-${i}`, scopeKey: 'w:x' })),
    links,
  };
  let out;
  assert.doesNotThrow(() => { out = buildNeighborhood({ center: { kind: 'episode', id: 'ep-0' }, view, maxNodes: 20, depth: 2 }); });
  assert.ok(out, '必须有返回值');
});

// R11b view（邻域视图）的 tombstone test：删掉 src/rooms/view.mjs ⇒ 本文件整片红。
// 契约：方案.md §14.1/§14.3；这里钉住五件事 —— 有界（≤324 + clamped）、**必带 frontier**、
// 不跨作用域、确定性、坏参数只抛 bad-argument。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNeighborhood,
  MAX_VIEW_NODES,
  MAX_VIEW_DEPTH,
  LIBRARY_ID,
} from '../src/rooms/view.mjs';

const SCOPE = 'w:d:/demo';
const T = (n) => 1_700_000_000_000 + n * 1000;

/** 造一个"星形"视图：中心局 + 40 个相邻局 + 它们各自的 claim。 */
function starView({ count = 40, scope = SCOPE } = {}) {
  const episodesById = new Map();
  const claimsById = new Map();
  const links = [];
  episodesById.set('ep-center', { id: 'ep-center', scopeKey: scope, l0: '中心局', lastEventAt: T(0), topics: ['t:git'] });
  for (let i = 1; i <= count; i += 1) {
    const id = `ep-n${String(i).padStart(2, '0')}`;
    episodesById.set(id, { id, scopeKey: scope, l0: `${id} 局`, lastEventAt: T(i), topics: ['t:git'] });
    claimsById.set(`c-${i}`, { id: `c-${i}`, scopeKey: scope, kind: 'antipattern', text: `坑 ${i}`, occurredAt: T(i), support: [{ episode: id, seq: i }] });
    links.push({ a: { episode: 'ep-center' }, b: { episode: id }, kind: 'shared-topic', topics: ['t:git'], why: 'git', weight: 0.8 - i / 1000 });
  }
  return { view: { episodesById, claimsById, links, scope }, episodesById, claimsById };
}

test('view: 中心必在 nodes[0]，结果是 JSON 安全的', () => {
  const { view } = starView({ count: 5 });
  const r = buildNeighborhood({ center: { kind: 'episode', id: 'ep-center' }, view });
  assert.equal(r.nodes[0].kind, 'episode');
  assert.equal(r.nodes[0].id, 'ep-center');
  assert.equal(r.nodes[0].weight, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r, '不许带 Map/undefined/函数');
  assert.deepEqual(r.center, { kind: 'episode', id: 'ep-center' });
});

test('view: 有界 —— 超 324 夹紧并标 clamped，截断必标 truncated 且 frontier 非空', () => {
  const { view } = starView({ count: 400 });
  const big = buildNeighborhood({ center: { kind: 'episode', id: 'ep-center' }, view, maxNodes: 9999 });
  assert.equal(big.clamped, true);
  assert.ok(big.nodes.length <= MAX_VIEW_NODES, `节点数不得超上限：${big.nodes.length}`);

  const cut = buildNeighborhood({ center: { kind: 'episode', id: 'ep-center' }, view, maxNodes: 12 });
  assert.equal(cut.truncated.nodes, true, '被截断必须如实标');
  assert.ok(cut.frontier.length > 0, '被截掉的边必须进 frontier —— 否则 agent 没法继续走');
});

test('view: frontier 的每条边恰好一端在邻域内（不然就不是边界面）', () => {
  const { view } = starView({ count: 30 });
  const r = buildNeighborhood({ center: { kind: 'episode', id: 'ep-center' }, view, maxNodes: 10 });
  const inside = new Set(r.nodes.map((n) => n.id));
  assert.ok(r.frontier.length > 0);
  for (const e of r.frontier) {
    const ends = [inside.has(e.from), inside.has(e.to)];
    assert.equal(ends.filter(Boolean).length, 1, `frontier 边必须一端在里一端在外：${JSON.stringify(e)}`);
  }
});

test('view: 不跨作用域（同域可见，异域节点一个都不许进来）', () => {
  const { view, episodesById } = starView({ count: 6 });
  episodesById.set('ep-other', { id: 'ep-other', scopeKey: 'w:d:/别的项目', l0: '别人的局', lastEventAt: T(9) });
  view.links.push({ a: { episode: 'ep-center' }, b: { episode: 'ep-other' }, kind: 'shared-topic', topics: ['t:git'], why: 'git', weight: 0.9 });
  const r = buildNeighborhood({ center: { kind: 'episode', id: 'ep-center' }, view, depth: 2 });
  assert.ok(!r.nodes.some((n) => n.id === 'ep-other'), '跨作用域节点不许进 nodes');
  assert.ok(!r.frontier.some((e) => e.from === 'ep-other' || e.to === 'ep-other'), '跨作用域边也不许进 frontier');
});

test('view: 确定性 —— 同输入两次调用逐字节相同；depth 夹到 ≤2', () => {
  const { view } = starView({ count: 8 });
  const a = buildNeighborhood({ center: { kind: 'episode', id: 'ep-center' }, view, depth: 9 });
  const b = buildNeighborhood({ center: { kind: 'episode', id: 'ep-center' }, view, depth: 9 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.ok(a.nodes.length > 0);
  assert.equal(MAX_VIEW_DEPTH, 2);
});

test('view: 知识库是巨型节点 —— 以它为中心才展开成子节点，普通邻域不自动带出', () => {
  const { view } = starView({ count: 3 });
  view.library = { id: LIBRARY_ID, title: '调研知识库', count: 2 };
  // 子节点按 {path, title} 给（实现用 `note:<path>` 造 id）—— 一开始我只写了 id，展开是 0 条
  view.libraryNotes = [
    { path: 'docs/调研/01-a.md', title: '甲' },
    { path: 'docs/调研/02-b.md', title: '乙' },
  ];
  const normal = buildNeighborhood({ center: { kind: 'episode', id: 'ep-center' }, view });
  assert.ok(!normal.nodes.some((n) => n.kind === 'library'), '普通邻域不该被知识库撑大');

  const lib = buildNeighborhood({ center: { kind: 'library', id: LIBRARY_ID }, view });
  assert.equal(lib.nodes[0].kind, 'library');
  assert.equal(lib.nodes[0].label.includes('2'), true, 'label 带篇数');
  assert.equal(lib.nodes.filter((n) => n.kind === 'note').length, 2, '展开成每篇一个子节点');
});

test('view: 坏参数只抛 bad-argument；中心不在视图里 ⇒ 空结构不抛', () => {
  const { view } = starView({ count: 2 });
  for (const center of [null, { kind: 'topic', id: 't:x' }, { kind: 'episode', id: '' }, { kind: 'episode' }]) {
    assert.throws(() => buildNeighborhood({ center, view }), (e) => String(e.message).startsWith('bad-argument'), `应抛 bad-argument：${JSON.stringify(center)}`);
  }
  const ghost = buildNeighborhood({ center: { kind: 'episode', id: 'ep-不存在' }, view });
  assert.deepEqual(ghost.nodes, []);
  assert.deepEqual(ghost.edges, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createStore } from '../src/rooms/persist.mjs';
import { normalizeScopeKey } from '../src/rooms/walk.mjs';
import {
  PRODUCED_IN_KIND,
  PRODUCED_IN_WEIGHT,
  PRODUCED_IN_WHY,
  buildProducedInEdges,
  syntheticHitsForEpisode,
} from '../scripts/produced-in-edge.mjs';

const T0 = 1_760_000_000_000;
const W1 = 'w:d:/work/demo';
const W2 = 'w:d:/work/other';

/** 最小 episode 记录（只放 produced-in 需要的字段）。 */
function episodeRecord({ id, scopeKey = W1, at = T0 + 1_000, state = 'archived' }) {
  return { id, scopeKey, startedAt: at, endedAt: at, lastEventAt: at, firstEventAt: at, state, l0: `局 ${id}` };
}

/** 最小 claim 记录（support 里给 episode + seq）。 */
function claimRecord({ id, scopeKey = W1, kind = 'fact', text = '', support = [], occurredAt = T0 + 2_000 }) {
  return {
    id,
    kind,
    text,
    scopeKey,
    support: support.map((s, i) => ({
      episode: s.episode,
      seq: Number.isFinite(s.seq) ? s.seq : 10 + i,
      quote: s.quote ?? `q-${id}-${i}`,
      occurredAt: Number.isFinite(s.occurredAt) ? s.occurredAt : occurredAt,
    })),
    occurredAt,
    state: 'observed',
  };
}

let tmp;

test.before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'kifuin-produced-in-'));
});

test.after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('produced-in：同局产出边（episode → claim），带 why / 机械权重 / kind', () => {
  const episodes = [
    episodeRecord({ id: 'ep-a' }),
    episodeRecord({ id: 'ep-b' }),
  ];
  const claims = [
    claimRecord({ id: 'c-1', support: [{ episode: 'ep-a', seq: 11 }] }),
    claimRecord({ id: 'c-2', kind: 'antipattern', support: [{ episode: 'ep-a', seq: 12 }] }),
  ];
  const { edges, claimsWithEdges, skipped } = buildProducedInEdges(claims, episodes);
  assert.equal(edges.length, 2, '两条 claim 各一条边');
  assert.equal(claimsWithEdges, 2);
  assert.deepEqual(skipped, { crossScope: 0, missingEpisode: 0, noScope: 0 });
  for (const edge of edges) {
    assert.equal(edge.kind, PRODUCED_IN_KIND);
    assert.equal(edge.why, PRODUCED_IN_WHY, '每条边必须带 why');
    assert.equal(edge.why, '同局产出');
    assert.equal(edge.weight, PRODUCED_IN_WEIGHT, '权重只由机械量决定（同局 = 1）');
    assert.equal(edge.weight, 1);
    assert.equal(edge.scopeKey, W1);
    assert.match(edge.id, /^pin:ep-a->c-[12]$/);
    assert.ok(Number.isFinite(edge.occurredAt), '边带 occurredAt（无时不入）');
  }
  // from 是 episode、to 是 claim
  assert.deepEqual(edges.map((e) => [e.from, e.to]).sort(), [['ep-a', 'c-1'], ['ep-a', 'c-2']]);
});

test('produced-in：同一条 claim 多局支撑 ⇒ 每局各一条边（不跨局推断）', () => {
  const episodes = [episodeRecord({ id: 'ep-a' }), episodeRecord({ id: 'ep-b' }), episodeRecord({ id: 'ep-c' })];
  const claims = [claimRecord({ id: 'c-multi', support: [{ episode: 'ep-a', seq: 21 }, { episode: 'ep-b', seq: 22 }] })];
  const { edges } = buildProducedInEdges(claims, episodes);
  assert.deepEqual(edges.map((e) => e.id).sort(), ['pin:ep-a->c-multi', 'pin:ep-b->c-multi']);
  assert.ok(!edges.some((e) => e.from === 'ep-c'), 'support 里没有的局绝不建边');
});

test('produced-in：跨 scope 不建边（A5 硬约束），只计入 skipped.crossScope', () => {
  const episodes = [episodeRecord({ id: 'ep-same' }), episodeRecord({ id: 'ep-other', scopeKey: W2 })];
  const claims = [
    claimRecord({ id: 'c-ok', scopeKey: W1, support: [{ episode: 'ep-same' }] }),
    claimRecord({ id: 'c-cross', scopeKey: W1, support: [{ episode: 'ep-other' }] }),
  ];
  const { edges, skipped } = buildProducedInEdges(claims, episodes);
  assert.deepEqual(edges.map((e) => e.to), ['c-ok']);
  assert.equal(skipped.crossScope, 1, '跨域被跳过并计数');
  assert.ok(!edges.some((e) => e.to === 'c-cross'));
});

test('produced-in：缺失 episode / 无 scope 各自计数，不抛', () => {
  const episodes = [episodeRecord({ id: 'ep-a' })];
  const claims = [
    claimRecord({ id: 'c-missing', support: [{ episode: 'ep-ghost' }] }),
    claimRecord({ id: 'c-noscope', scopeKey: '', support: [{ episode: 'ep-a' }] }),
  ];
  const { edges, skipped } = buildProducedInEdges(claims, episodes);
  assert.deepEqual(edges, []);
  assert.equal(skipped.missingEpisode, 1);
  assert.equal(skipped.noScope, 1);
});

test('produced-in：幂等（同输入同输出、重复 support 项只出一条、按 id 排序）', () => {
  const episodes = [episodeRecord({ id: 'ep-a' }), episodeRecord({ id: 'ep-b' })];
  const claims = [
    claimRecord({ id: 'c-2', support: [{ episode: 'ep-b' }, { episode: 'ep-b' }] }),
    claimRecord({ id: 'c-1', support: [{ episode: 'ep-a' }] }),
  ];
  const first = buildProducedInEdges(claims, episodes);
  const second = buildProducedInEdges(claims, episodes);
  assert.deepEqual(first.edges, second.edges, '同输入同输出（可复现）');
  assert.equal(first.edges.length, 2, '重复 support 项不产生重复边');
  assert.deepEqual(first.edges.map((e) => e.id), ['pin:ep-a->c-1', 'pin:ep-b->c-2'], '按 id 稳定排序');
});

test('produced-in：空输入 / 坏输入不抛（返回空边集）', () => {
  assert.deepEqual(buildProducedInEdges([], []).edges, []);
  assert.deepEqual(buildProducedInEdges(null, null).edges, []);
  assert.deepEqual(buildProducedInEdges([null, {}, { id: '' }], [null]).edges, []);
});

test('produced-in：A5 —— 每条边两端 scopeKey 归一后必须相同（真 store 上复验）', () => {
  const store = createStore({ root: path.join(tmp, `store-${Date.now()}`), now: T0 });
  store.ensureDirs();
  store.putMany('episodes', [
    episodeRecord({ id: 'ep-a', scopeKey: W1 }),
    episodeRecord({ id: 'ep-b', scopeKey: W2 }),
  ], { at: T0 });
  store.putMany('claims', [
    claimRecord({ id: 'c-w1', scopeKey: W1, support: [{ episode: 'ep-a' }] }),
    claimRecord({ id: 'c-w1b', scopeKey: W1, support: [{ episode: 'ep-b' }] }), // 与 ep-b 不同域 ⇒ 不建边
    claimRecord({ id: 'c-w2', scopeKey: W2, support: [{ episode: 'ep-b' }] }),
  ], { at: T0 });

  const claims = store.list('claims').map((e) => e.record).filter(Boolean);
  const episodes = store.list('episodes').map((e) => e.record).filter(Boolean);
  const { edges, skipped } = buildProducedInEdges(claims, episodes);
  const episodeById = new Map(episodes.map((ep) => [ep.id, ep]));
  const claimById = new Map(claims.map((c) => [c.id, c]));
  assert.ok(edges.length >= 2, '同域的两条要建边');
  for (const edge of edges) {
    const epScope = normalizeScopeKey(String(episodeById.get(edge.from)?.scopeKey ?? ''));
    const claimScope = normalizeScopeKey(String(claimById.get(edge.to)?.scopeKey ?? ''));
    assert.equal(epScope, claimScope, `A5：边 ${edge.id} 两端必须同域`);
  }
  assert.equal(skipped.crossScope, 1, 'c-w1b → ep-b 跨域被跳过');
  assert.ok(!edges.some((e) => e.to === 'c-w1b'));
});

test('produced-in：syntheticHitsForEpisode —— 模拟 hit 的形状（depth=1 / weight=1 / why=同局产出 / kind 映射）', () => {
  const claims = [
    claimRecord({ id: 'c-a', kind: 'antipattern', text: '  失败教训  ', support: [{ episode: 'ep-a', seq: 31, occurredAt: T0 + 5 }], occurredAt: T0 + 6 }),
    claimRecord({ id: 'c-b', kind: 'preference', text: '偏好', support: [{ episode: 'ep-a', seq: 32 }] }),
    claimRecord({ id: 'c-c', kind: 'fact', text: '事实', support: [{ episode: 'ep-a', seq: 33 }] }),
  ];
  const hits = syntheticHitsForEpisode('ep-a', claims);
  assert.equal(hits.length, 3);
  assert.equal(hits[0].claim, 'c-a');
  assert.equal(hits[0].episode, 'ep-a');
  assert.equal(hits[0].depth, 1, '同局 = 同一跳（depth 不变）');
  assert.equal(hits[0].weight, 1);
  assert.deepEqual(hits[0].why, ['同局产出']);
  assert.equal(hits[0].kind, 'failure');
  assert.equal(hits[1].kind, 'constraint');
  assert.equal(hits[2].kind, 'claim');
  assert.equal(hits[0].seq, 31);
  assert.equal(hits[0].occurredAt, T0 + 6, 'occurredAt 优先取 claim 自己的');
  assert.equal(hits[0].text, '失败教训', 'text 去空白');
  for (const hit of hits) assert.equal(hit.scopeKey, W1);
});

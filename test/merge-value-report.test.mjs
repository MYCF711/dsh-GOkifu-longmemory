// T212 · 合流「价值主张」测量的 tombstone test。
// 删掉 scripts/merge-value-report.mjs ⇒ 本文件整片红。
//
// 覆盖：
//   ① 机械工具：Wilson 区间（已知值）、折叠前视图、构造信号、行 id、卡片 token、确定性抽样
//   ② 端到端（临时库）：四个轴在同一批观察上的读数（A 省 token、B 100% 可追、C 成员行归零、D 闸 4 形状）
//   ③ 报告渲染：四轴各自成节、不含 undefined
//   ④ CLI：--help / 缺参 / 库不存在

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStore } from '../src/rooms/persist.mjs';
import {
  axisGate4,
  axisSlots,
  axisTokens,
  axisTraceability,
  buildGroupSignal,
  cardTokens,
  collectGroupObservations,
  main,
  parseArgs,
  renderReport,
  rowIdOf,
  sampleDeterministic,
  storeWithoutMergeNodes,
  wilsonInterval,
} from '../scripts/merge-value-report.mjs';

const T0 = 1_790_000_000_000;
const SCOPE = 'w:test/demo';

const claim = (id, text, seq, over = {}) => ({
  id,
  kind: 'antipattern',
  scopeKey: SCOPE,
  state: 'observed',
  text,
  support: [{ episode: 'ep-test01', seq, quote: text, occurredAt: T0 + seq }],
  counter: [],
  validity: { type: 'none', value: null },
  preconditions: [{ check: 'scope', value: SCOPE, why: 'fixture' }],
  occurredAt: T0 + seq,
  threadIds: [],
  ...over,
});

/** 临时影库：2 条成员（同局不同 seq、正文逐字相同）+ 1 个合并节点 + 1 条无关 claim。 */
function makeShadow() {
  const root = mkdtempSync(join(tmpdir(), 'kifuin-t212-'));
  const store = createStore({ root });
  store.put('episodes', {
    id: 'ep-test01',
    scopeKey: SCOPE,
    state: 'archived',
    startedAt: T0,
    endedAt: T0 + 1000,
    closure: { seqFrom: 1, seqTo: 100 },
    signals: { failures: 2 },
    // 主题 kind 不能是 tool：walk 的 S9 规则只让 tool 主题经"显式实体"起跳
    topics: [{ id: 't:file:boom', key: 'boom.log', kind: 'file', count: 2 }],
  });
  store.put('topics', { id: 't:file:boom', key: 'boom.log', kind: 'file', df: 1, episodes: ['ep-test01'] });
  const m1 = claim('c-member01', 'Error: boom.log: boom happened at start', 10);
  const m2 = claim('c-member02', 'Error: boom.log: boom happened at start', 20);
  const other = claim('c-other01', 'TypeError: unrelated failure in another module', 30);
  for (const record of [m1, m2, other]) store.put('claims', record);
  const merged = {
    id: 'c-merge001',
    kind: 'antipattern',
    scopeKey: SCOPE,
    state: 'candidate',
    text: m1.text,
    support: [m1.support[0], m2.support[0]],
    counter: [],
    validity: { type: 'none', value: null },
    preconditions: m1.preconditions,
    occurredAt: T0 + 10,
    recordedAt: T0 + 20,
    threadIds: [],
    supersedes: null,
    merge: {
      version: 1,
      key: `antipattern|${SCOPE}|merge001`,
      rule: 'multi-criteria',
      members: [m1.id, m2.id],
      representative: { claimId: m1.id, episode: 'ep-test01', seq: 10, quote: m1.text },
      supportEpisodes: 1,
      at: T0 + 20,
    },
  };
  store.put('claims', merged);
  return { root, store, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('T212: Wilson 区间 —— 已知值（0/10、10/10、1/2）', () => {
  const zero = wilsonInterval(0, 10);
  assert.equal(zero.phat, 0);
  assert.equal(zero.lower, 0);
  assert.ok(Math.abs(zero.upper - 0.2775) < 0.001, `0/10 上界应≈0.2775，实得 ${zero.upper}`);
  const full = wilsonInterval(10, 10);
  assert.ok(Math.abs(full.lower - 0.7225) < 0.001, `10/10 下界应≈0.7225，实得 ${full.lower}`);
  assert.equal(full.upper, 1);
  const half = wilsonInterval(1, 2);
  assert.ok(half.lower < 0.5 && half.upper > 0.5);
  assert.deepEqual(wilsonInterval(0, 0), { phat: null, lower: null, upper: null, n: 0, z: 1.96 });
});

test('T212: storeWithoutMergeNodes / buildGroupSignal / rowIdOf / cardTokens', () => {
  const { store, cleanup } = makeShadow();
  try {
    const noFold = storeWithoutMergeNodes(store);
    assert.equal(noFold.list('claims').length, 3, '合并节点被摘掉，真 claim 保留');
    assert.equal(noFold.list('episodes').length, 1);
    assert.equal(store.list('claims').length, 4, '原 store 不受影响');

    const signal = buildGroupSignal([{ text: 'alpha' }, { text: ' beta ' }, { text: '' }]);
    assert.deepEqual(signal.terms, ['alpha', 'beta']);
    assert.equal(signal.kind, 'root-message');

    assert.equal(rowIdOf({ claimId: 'c-a' }), 'c-a');
    assert.equal(rowIdOf({ claim: 'c-b' }), 'c-b');
    assert.equal(rowIdOf({}), '');

    const card = { claims: [{ text: 'abc' }, { text: 'defgh' }] };
    assert.ok(cardTokens(card) >= 0);
    assert.equal(cardTokens({ claims: [] }), 0);
  } finally {
    cleanup();
  }
});

test('T212: sampleDeterministic —— 同 seed 同结果、不重复、不越界', () => {
  const pool = Array.from({ length: 30 }, (_, i) => ({ id: `c-${i}` }));
  const a = sampleDeterministic(pool, 5, 7);
  const b = sampleDeterministic(pool, 5, 7);
  assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id));
  assert.equal(new Set(a.map((x) => x.id)).size, 5);
  assert.equal(sampleDeterministic(pool, 999, 1).length, 30);
  assert.deepEqual(sampleDeterministic([], 5, 1), []);
});

test('T212: 端到端 —— 四个轴在同一批观察上各给读数', () => {
  const { store, cleanup } = makeShadow();
  try {
    const mergedClaims = store.list('claims').map((r) => r.record).filter((c) => c?.merge);
    const observations = collectGroupObservations({ shadow: store, mergedClaims });
    assert.equal(observations.length, 1);
    assert.ok(!observations[0].skipped);

    const A = axisTokens(observations);
    assert.equal(A.id, 'A');
    assert.equal(A.readout.groups, 1);
    assert.ok(A.readout.tokensBefore > 0);
    assert.ok(A.readout.tokensSaved > 0, '折叠后卡片 token 应变少');
    assert.ok(A.readout.duplicateShare >= 0 && A.readout.duplicateShare <= 1);
    assert.ok(A.hypothesis && A.criterion);

    const B = axisTraceability(observations, { samples: 2, seed: 7 });
    assert.equal(B.id, 'B');
    assert.equal(B.readout.collapsedTotal, 2);
    assert.equal(B.readout.traceable, 2, '两个被折叠成员都应可追');
    assert.equal(B.readout.traceabilityRate, 1);
    assert.equal(B.readout.coveredTotal, 2);

    const C = axisSlots(observations);
    assert.equal(C.id, 'C');
    assert.equal(C.readout.memberRowsBefore, 2);
    assert.equal(C.readout.memberRowsAfter, 0, '折叠后本组成员行归零（只剩合并行）');
    assert.ok(Number.isFinite(C.readout.otherRowsDelta));

    const D = axisGate4(observations);
    assert.equal(D.id, 'D');
    assert.ok(D.readout.groups === 1);
    assert.ok(Number.isFinite(D.readout.gate4Before));
    assert.ok(Number.isFinite(D.readout.gate4After));
  } finally {
    cleanup();
  }
});

test('T212: 报告渲染 —— 四轴各自成节、不含 undefined', () => {
  const report = {
    version: 1,
    generatedAt: '2026-11-05T00:00:00.000Z',
    shadowRoot: '/tmp/shadow',
    mergedCount: 1,
    axes: {
      A: { id: 'A', name: '去重即降 token', hypothesis: 'h', criterion: 'c', readout: { tokensSaved: 1 }, verdict: null },
      B: { id: 'B', name: '召回不丢', hypothesis: 'h', criterion: 'c', readout: { traceable: 1 }, verdict: null },
      C: { id: 'C', name: '排序更稳', hypothesis: 'h', criterion: 'c', readout: { otherRowsDelta: 0 }, verdict: null },
      D: { id: 'D', name: '闸 4 可用性', hypothesis: 'h', criterion: 'c', readout: { gate4After: 0 }, verdict: null },
    },
  };
  const text = renderReport(report);
  for (const id of ['## A ·', '## B ·', '## C ·', '## D ·']) assert.ok(text.includes(id), `缺 ${id}`);
  assert.ok(text.includes('假设') && text.includes('机械判据') && text.includes('读数'));
  assert.doesNotMatch(text, /undefined/);
});

test('T212: CLI 参数与兜底', () => {
  assert.deepEqual(parseArgs(['--shadow', 'x']), { shadow: 'x', samples: 20, seed: 20261105, json: false, help: false });
  assert.equal(parseArgs(['--samples', '3']).samples, 3);
  assert.ok(parseArgs(['--bogus']).error);
  assert.equal(main(['--help']), 0);
  assert.equal(main([]), 2, '缺 --shadow ⇒ 2');
  assert.equal(main(['--shadow', join(tmpdir(), 'no-such-shadow-t212')]), 2, '库不存在 ⇒ 2');
});

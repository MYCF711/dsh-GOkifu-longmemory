// T202 · 合流「机制 vs 频率」分离报告的 tombstone test。
// 删掉 scripts/merge-mechanism-report.mjs ⇒ 本文件整片红。
//
// 覆盖：
//   ① 纯函数：成员 id / 构造信号 / 「折叠前」视图 / 行计数 / 确定性抽样
//   ② 端到端（临时库）：成员 + 合并节点 ⇒ 机制臂报告"可折 1 组、真省 1 行"，且判据自洽
//   ③ 频率臂：抽样数、概率与 Wilson 区间形状
//   ④ 报告渲染：两臂分节、不合成一个数
//   ⑤ 参数解析：缺失/未知参数

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStore } from '../src/rooms/persist.mjs';
import {
  buildGroupSignal,
  countMemberRows,
  frequencyArm,
  hasRow,
  main,
  memberIdsOf,
  mechanismArm,
  parseArgs,
  renderReport,
  sampleDeterministic,
  storeWithoutMergeNodes,
} from '../scripts/merge-mechanism-report.mjs';

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

/** 临时库：两条成员 claim（同一局不同 seq）+ 一个合并节点 + 一条无关 claim。 */
function makeShadow() {
  const root = mkdtempSync(join(tmpdir(), 'kifuin-t202-'));
  const store = createStore({ root });
  store.put('episodes', {
    id: 'ep-test01',
    scopeKey: SCOPE,
    state: 'archived',
    startedAt: T0,
    endedAt: T0 + 1000,
    closure: { seqFrom: 1, seqTo: 100 },
    signals: { failures: 2 },
    // 至少一个主题：walk 在「一个主题都没匹配」时会直接返回空 hits（连 claim 文本通路都不走）
    topics: [{ id: 't:file:boom', key: 'boom.log', kind: 'file', count: 2 }],
  });
  // 主题 kind 不能是 tool：walk 的 S9 规则只让 tool 主题经"显式实体"起跳
  store.put('topics', { id: 't:file:boom', key: 'boom.log', kind: 'file', df: 1, episodes: ['ep-test01'] });
  const m1 = claim('c-member01', 'Error: boom.log: boom happened at start', 10);
  // 两条成员正文**逐字相同**：walk 的 pickClaim 只在"同局另一条得分更高"时才换行，
  // 得分打平才各自成行（真实语料里同组正文往往只差易变标识，正是这个形态）。
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

test('T202: memberIdsOf / buildGroupSignal —— 成员 id 与"同时命中全部成员"的构造信号', () => {
  const merged = { merge: { members: ['c-a', 'c-b', ''] } };
  assert.deepEqual(memberIdsOf(merged), ['c-a', 'c-b']);
  assert.deepEqual(memberIdsOf({}), []);
  const signal = buildGroupSignal([{ text: 'alpha' }, { text: 'beta' }, { text: '   ' }]);
  assert.equal(signal.kind, 'root-message');
  assert.deepEqual(signal.terms, ['alpha', 'beta'], '每个成员的正文各一条 term（空串丢掉）');
  assert.deepEqual(signal.entities, []);
});

test('T202: storeWithoutMergeNodes —— 只摘 claims 里的派生节点，其余 kind 原样', () => {
  const { store, cleanup } = makeShadow();
  try {
    const noFold = storeWithoutMergeNodes(store);
    assert.equal(noFold.list('claims').length, 3, '3 条真 claim（合并节点被摘掉）');
    assert.equal(noFold.list('episodes').length, 1, 'episode 原样透传');
    assert.equal(noFold.ids('claims').length, 3);
    assert.equal(store.list('claims').length, 4, '原 store 不受影响');
    assert.ok(noFold.get('claims', 'c-member01'));
  } finally {
    cleanup();
  }
});

test('T202: countMemberRows / hasRow —— 按 claimId 机械计数', () => {
  const card = { claims: [{ claim: 'c-a' }, { claimId: 'c-b' }, { claim: 'c-merge001' }] };
  assert.equal(countMemberRows(card, new Set(['c-a', 'c-b'])), 2);
  assert.equal(countMemberRows({ claims: [] }, new Set(['c-a'])), 0);
  assert.equal(hasRow(card, 'c-merge001'), true);
  assert.equal(hasRow(card, 'c-nope'), false);
});

test('T202: sampleDeterministic —— 同 seed 同结果、不重复、尊重 n', () => {
  const pool = Array.from({ length: 50 }, (_, i) => ({ id: `c-${i}` }));
  const a = sampleDeterministic(pool, 10, 42);
  const b = sampleDeterministic(pool, 10, 42);
  assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id));
  assert.equal(new Set(a.map((x) => x.id)).size, 10, '不重复抽样');
  const c = sampleDeterministic(pool, 10, 43);
  assert.notDeepEqual(a.map((x) => x.id), c.map((x) => x.id), '换 seed 应换样本');
  assert.equal(sampleDeterministic(pool, 999, 1).length, 50, 'n 超过池大小时取全池');
  assert.deepEqual(sampleDeterministic([], 10, 1), []);
});

test('T202: 机制臂端到端 —— 同时命中 2 个成员 ⇒ 折叠省 1 行，且判据自洽', () => {
  const { store, cleanup } = makeShadow();
  try {
    const mergedClaims = store.list('claims').map((r) => r.record).filter((c) => c?.merge);
    const arm = mechanismArm({ shadow: store, mergedClaims });
    assert.equal(arm.groups, 1);
    assert.equal(arm.scopeBlocked, 0);
    assert.equal(arm.foldable, 1, '折叠前卡片里本组 2 个成员成行');
    assert.equal(arm.foldableSaved, 1, '可折 ⇒ 必然省行（机制判据）');
    const row = arm.rows[0];
    assert.equal(row.beforeRows, 2, '折叠前：两条成员各一行');
    assert.equal(row.afterRows, 1, '折叠后：只剩合并节点一行');
    assert.equal(row.memberRowsBefore, 2);
    assert.equal(row.memberRowsAfter, 0);
    assert.equal(row.mergeRowRendered, true);
    assert.equal(row.ownSaved, 1);
    assert.equal(row.ownMatch, true);
    assert.equal(arm.ownTotal, 1);
    assert.equal(arm.cardTotal, 1);
  } finally {
    cleanup();
  }
});

test('T202: 频率臂 —— 抽样数/概率/Wilson 区间形状正确（小库也不崩）', () => {
  const { store, cleanup } = makeShadow();
  try {
    const mergedClaims = store.list('claims').map((r) => r.record).filter((c) => c?.merge);
    // 成员正文只有 26/27 字：合格池按 ≥20 字收，两条都在
    const arm = frequencyArm({ real: store, groups: mergedClaims, samples: 3, seed: 7 });
    assert.equal(arm.samples, 3, '池够大时按 samples 抽');
    assert.ok(arm.pool >= 2);
    assert.ok(arm.hits >= 0 && arm.hits <= arm.samples);
    assert.equal(arm.probability, arm.hits / arm.samples);
    assert.ok(arm.wilson.lower <= arm.wilson.upper);
    assert.ok(arm.wilson.lower >= 0 && arm.wilson.upper <= 1);
    assert.equal(arm.wilson.n, 3);
  } finally {
    cleanup();
  }
});

test('T202: 报告渲染 —— 机制臂与频率臂分节，不合成一个数', () => {
  const mechanism = { groups: 1, scopeBlocked: 0, skipped: 0, foldable: 1, foldableSaved: 1, ownSavedGroups: 1, ownTotal: 1, cardSavedGroups: 1, cardTotal: 1, meanOwnSaved: 1, meanCardSaved: 1, distinctEpisodeGroups: 1, rows: [{ id: 'c-merge001', members: 2, resolved: 2, distinctEpisodes: 1, beforeRows: 2, afterRows: 1, memberRowsBefore: 2, memberRowsAfter: 0, mergeRowRendered: true, foldable: true, ownSaved: 1, ownExpected: 1, ownMatch: true, cardSaved: 1 }] };
  const frequency = { samples: 3, pool: 3, seed: 7, limit: 5, budgetTokens: 500, hits: 0, multiGroupSamples: 0, probability: 0, wilson: { phat: 0, lower: 0, upper: 0.6, n: 3, z: 1.96 }, groupsTouched: 0, examples: [] };
  const text = renderReport({ mechanism, frequency, shadowRoot: '/s', storeRoot: '/r', mergedCount: 1 });
  assert.match(text, /机制臂/);
  assert.match(text, /频率臂/);
  assert.match(text, /可折组/);
  assert.match(text, /Wilson 95%/);
  assert.doesNotMatch(text, /undefined/);
});

test('T202: 参数解析与 CLI 兜底', () => {
  assert.deepEqual(parseArgs(['--shadow', 'a', '--store', 'b']), { shadow: 'a', store: 'b', samples: 1000, seed: 20261105, json: false, help: false });
  assert.equal(parseArgs(['--samples', '5']).samples, 5);
  assert.ok(parseArgs(['--bogus']).error);
  assert.equal(main(['--help']), 0);
  assert.equal(main([]), 2, '缺 --shadow/--store 应报错');
  assert.equal(main(['--shadow', join(tmpdir(), 'no-such-shadow-x'), '--store', join(tmpdir(), 'no-such-store-x')]), 2, '库不存在 ⇒ 2');
});

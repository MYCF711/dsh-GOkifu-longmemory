// R11 walk 的 tombstone test：删掉 src/rooms/walk.mjs（或 store 里的 topics/links）⇒ 本文件整片红。
//
// 覆盖（docs/数据契约.md §7.1/§7.2、方案.md §4.4、AGENTS.md §11 R11）：
//   - 信号 → 主题 → 棋谱：只用 store 的 topics/episodes 定位，命中 ep1/ep2（共享硬主题）
//   - 一跳：ep2 → ep3 经 store links，path 里带 why（主题 key）与 link id；depth=2 的局不再展开
//   - 深度 ≤2：depth=99 不越界（第 3 跳的 ep4 永不出现）；depth=1 只给直接命中
//   - 排序：失败教训 > 约束/偏好 > 定式候选（分类只看 signals 计数与 claim.kind）
//   - limit / budgetTokens 前缀式截断 + omitted 计数（含 reason）
//   - 无命中 = 空数组、零 path、零 tokens、omitted.count=0（沉默是默认）
//   - 只读：走之前/之后 store 的 sha256 快照 + journal 行数完全一致；源码不 import 任何模块
//   - "无时不入"（缺 occurredAt 的棋谱/claim 不入 hits）、folded-into 子代理局不入、invalidated claim 不入
//   - 主题匹配口径：精确/包含/实体/主题 id/大小写；CJK 2 字、ASCII 3 字最小长度闸
//   - token 口径：CJK 1.5 字/token、ASCII 4 字/token；result.tokens = Σ hit.tokens
//   - 作用域（T8b 修复）：同 scope 可见、跨 scope 不可见、u: 用户层可见、scope 缺失降级为"只放用户层"、
//     被拒条目计入 omitted.crossScope；与 R13 闸 1 的一致性（walk 可见 ⇒ 闸 1 必可见）
//
// 夹具：临时目录 createStore（**不碰真实 $DSH_HOME**）；不新增依赖、只用 node: 内置。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createStore } from '../src/rooms/persist.mjs';
import {
  walkFromSignals,
  matchTopics,
  normalizeSignal,
  estimateTokens,
  clampDepth,
  normalizeScopeKey,
  isScopeVisible,
  resolveScope,
  WalkError,
  HIT_KINDS,
  MAX_DEPTH,
  WALK_DEFAULTS,
  TOKEN_RULE,
} from '../src/rooms/walk.mjs';
import {
  normalizeScope as gateNormalizeScope,
  isScopeVisible as gateIsScopeVisible,
} from '../src/rooms/gates.mjs';

const WALK_SOURCE = readFileSync(new URL('../src/rooms/walk.mjs', import.meta.url), 'utf8');

const T0 = 1_760_000_000_000; // 夹具事件时间（固定的过去）
const SCOPE = 'w:d:/work/demo'; // 夹具工作区（与 episode/claim 的 scopeKey 同值）
const OTHER_SCOPE = 'w:e:/other-workspace';

// ---- 主题种子（夹具里的 5 个主题）----
const T = {
  repo: { id: 't:repo:aaaaaaa1', kind: 'repo', key: 'MYCF711/dsh-kifuin', df: 3, idfNorm: 0.72 },
  file: { id: 't:file:bbbbbbb2', kind: 'file', key: 'src/rooms/walk.mjs', df: 2, idfNorm: 0.66 },
  tool: { id: 't:tool:ccccccc3', kind: 'tool', key: 'node --test', df: 2, idfNorm: 0.55 },
  domain: { id: 't:domain:ddddddd4', kind: 'domain', key: 'example.com', df: 2, idfNorm: 0.4 },
  term: { id: 't:term:eeeeeee5', kind: 'term', key: '顺藤摸瓜', df: 1, idfNorm: 0.9 },
};

function epTopic(seed) {
  return { id: seed.id, kind: seed.kind, key: seed.key, occurrences: [{ seq: 1, quote: seed.key, occurredAt: T0 + 1_000 }] };
}

function episodeRecord({
  id, topics = [], failures = 0, constraints = 0, at = T0 + 1_000, l0 = '',
  state = 'archived', delegationDepth = 0, time = true,
}) {
  return {
    id,
    sessionId: `session-${id}`,
    scopeKey: 'w:d:/work/demo',
    startedAt: time ? at : null,
    endedAt: time ? at + 500 : null,
    firstEventAt: time ? at : null,
    lastEventAt: time ? at : null,
    recordedAt: T0,
    timeSource: time ? 'event' : 'inferred',
    agentPreset: 'standard',
    origin: null,
    delegationDepth,
    closure: { logPath: null, graphPath: null, seqFrom: 1, seqTo: 9, eventCount: 9, nodeIds: [], edgeIds: [] },
    l0,
    l1: '',
    signals: { failures, successes: 0, unsettled: 0, constraints, tools: [] },
    threadIds: [],
    state,
    topics,
  };
}

function topicRecord(seed, { episodes = [], df = seed.df, idfNorm = seed.idfNorm } = {}) {
  return {
    id: seed.id,
    kind: seed.kind,
    key: seed.key,
    df,
    idfNorm,
    firstSeenAt: T0,
    lastSeenAt: T0 + 5_000,
    episodes: [...episodes].sort(),
  };
}

function linkRecord({ id, a, b, topics, why, weight = 1, occurredAt = T0 }) {
  return {
    id,
    kind: 'shared-topic',
    a: { episode: a },
    b: { episode: b },
    topics: [...topics],
    why,
    weight,
    occurredAt,
    episodes: [a, b].sort(),
  };
}

function claimRecord({
  id, kind = 'fact', text = '', support = [], occurredAt = null, state = 'candidate',
  scopeKey = 'w:d:/work/demo', preconditions = [],
}) {
  const entries = support.map((s) => ({
    episode: s.episode,
    nodeId: s.nodeId ?? null,
    seq: s.seq ?? null,
    quote: s.quote ?? '',
    occurredAt: s.occurredAt ?? null,
  }));
  return {
    id,
    kind,
    text,
    scopeKey,
    threadIds: [],
    state,
    support: entries,
    counter: [],
    validity: { type: 'none', value: null },
    preconditions: preconditions.length
      ? preconditions
      : [{ check: 'scope', value: scopeKey, why: '证据只覆盖该作用域（夹具）' }],
    occurredAt,
    recordedAt: T0,
    validFrom: null,
    validTo: null,
    counters: { support: entries.length, counter: 0, injections: 0, lastInjectedAt: null },
    supersedes: null,
  };
}

// ---- 夹具：6 局（ep5 = 子代理局、ep6 = 无时间戳局）+ 5 主题 + 3 相关边 + 8 claim ----
function fixtureEpisodes() {
  return [
    episodeRecord({
      id: 'ep-0001', topics: [epTopic(T.repo), epTopic(T.file)], failures: 2, at: T0 + 1_500,
      l0: '依赖缺失：Cannot find module yaml（失败 2 次）',
    }),
    episodeRecord({
      id: 'ep-0002', topics: [epTopic(T.repo), epTopic(T.file), epTopic(T.tool)], at: T0 + 2_500,
      l0: '测试口径：该仓用 node --test',
    }),
    episodeRecord({
      id: 'ep-0003', topics: [epTopic(T.tool), epTopic(T.domain)], failures: 1, at: T0 + 3_500,
      l0: '同一命令在 Windows 下 exit 1',
    }),
    episodeRecord({
      id: 'ep-0004', topics: [epTopic(T.domain), epTopic(T.term)], at: T0 + 4_500,
      l0: '参考：顺藤摸瓜的走法',
    }),
    episodeRecord({
      id: 'ep-0005', topics: [epTopic(T.repo)], failures: 1, at: T0 + 5_500,
      state: 'folded-into:ep-0001', delegationDepth: 1, l0: '子代理局的失败（归并到父局）',
    }),
    episodeRecord({ id: 'ep-0006', topics: [epTopic(T.repo)], time: false, l0: '无时间戳的局（假记忆，不入）' }),
  ];
}

function fixtureTopics() {
  return [
    topicRecord(T.repo, { episodes: ['ep-0001', 'ep-0002', 'ep-0006'] }),
    topicRecord(T.file, { episodes: ['ep-0001', 'ep-0002'] }),
    topicRecord(T.tool, { episodes: ['ep-0002', 'ep-0003'] }),
    topicRecord(T.domain, { episodes: ['ep-0003', 'ep-0004'] }),
    topicRecord(T.term, { episodes: ['ep-0004'] }),
  ];
}

function fixtureLinks() {
  return [
    linkRecord({ id: 'link-0001', a: 'ep-0001', b: 'ep-0002', topics: [T.repo.id], why: T.repo.key, weight: 1, occurredAt: T0 + 1_600 }),
    linkRecord({ id: 'link-0002', a: 'ep-0002', b: 'ep-0003', topics: [T.tool.id], why: T.tool.key, weight: 0.8, occurredAt: T0 + 2_600 }),
    linkRecord({ id: 'link-0003', a: 'ep-0003', b: 'ep-0004', topics: [T.domain.id], why: T.domain.key, weight: 0.6, occurredAt: T0 + 3_600 }),
  ];
}

function fixtureClaims() {
  return [
    claimRecord({
      id: 'c-antipattern-1', kind: 'antipattern', text: '依赖缺失时先 npm view 再装（postinstall 会删缓存）',
      support: [{ episode: 'ep-0001', nodeId: 'n-3', seq: 3, occurredAt: T0 + 1_200 }], occurredAt: T0 + 1_200,
    }),
    claimRecord({
      id: 'c-preference-1', kind: 'preference', text: '该仓的测试必须用 node --test（不是 npm test）',
      support: [{ episode: 'ep-0002', seq: 5, occurredAt: T0 + 2_100 }], occurredAt: T0 + 2_100,
    }),
    claimRecord({
      id: 'c-fact-1', kind: 'fact', text: '记忆库是 sidecar：<DSH_HOME>/memory-context',
      support: [{ episode: 'ep-0002', seq: 6, occurredAt: T0 + 2_300 }], occurredAt: T0 + 2_300,
    }),
    claimRecord({
      id: 'c-antipattern-2', kind: 'antipattern', text: 'Windows 下 bash 的管道退出码会被吞',
      support: [{ episode: 'ep-0003', seq: 7, occurredAt: T0 + 3_400 }], occurredAt: T0 + 3_400,
    }),
    claimRecord({
      id: 'c-text-1', kind: 'fact', text: '顺藤摸瓜：默认 depth=2、budgetTokens=500',
      support: [{ episode: 'ep-0006', seq: 9 }], occurredAt: T0 + 3_000,
    }),
    claimRecord({
      id: 'c-unrelated-1', kind: 'fact', text: '无关的事实：端口 3425 是 magpie',
      support: [{ episode: 'ep-0004', seq: 11, occurredAt: T0 + 4_000 }], occurredAt: T0 + 4_000,
    }),
    claimRecord({
      id: 'c-invalidated-1', kind: 'fact', text: '已作废：npm test 可以跑',
      support: [{ episode: 'ep-0001', seq: 4, occurredAt: T0 + 1_300 }], occurredAt: T0 + 1_300, state: 'invalidated',
    }),
    claimRecord({ id: 'c-noTime-1', kind: 'fact', text: '顺藤摸瓜的无时间戳版本', support: [], occurredAt: null }),
  ];
}

const REPO_SIGNAL = Object.freeze({ kind: 'root-message', terms: ['dsh-kifuin'], entities: [], at: T0 + 9_000 });
const TERM_SIGNAL = Object.freeze({ kind: 'user-explicit', terms: ['顺藤摸瓜'], entities: [], at: T0 + 9_000 });

let tmp;
let store;
let seq = 0;

test.before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'kifuin-walk-'));
  store = createStore({ root: path.join(tmp, `store-${(seq += 1)}`), now: T0 });
  store.ensureDirs();
  store.putMany('episodes', fixtureEpisodes(), { at: T0 });
  store.putMany('topics', fixtureTopics(), { at: T0 });
  store.putMany('links', fixtureLinks(), { at: T0 });
  store.putMany('claims', fixtureClaims(), { at: T0 });
});

test.after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function walk(opts = {}) {
  return walkFromSignals({
    signal: REPO_SIGNAL,
    store,
    scope: SCOPE,
    depth: 2,
    limit: 10,
    budgetTokens: 10_000,
    ...opts,
  });
}

function episodeIds(result) {
  return result.hits.filter((hit) => !hit.claim && hit.episode).map((hit) => hit.episode);
}

function claimIds(result) {
  return result.hits.filter((hit) => hit.claim).map((hit) => hit.claim);
}

function fingerprint(target) {
  const snap = target.snapshot();
  const files = {};
  for (const key of [...snap.files.keys()].sort()) files[key] = snap.files.get(key);
  return {
    files,
    counts: snap.counts,
    bytes: snap.bytes,
    journal: target.readJournal().parsed,
  };
}

function assertInvariants(result) {
  for (const hit of result.hits) {
    assert.ok(HIT_KINDS.includes(hit.kind), `未知 hit.kind: ${hit.kind}`);
    assert.ok(Array.isArray(hit.why) && hit.why.length > 0, '每 hit 必须有 why（主题 key）');
    assert.ok(Number.isFinite(hit.occurredAt), '每 hit 必须有 occurredAt');
    assert.ok(Number.isInteger(hit.depth) && hit.depth >= 1 && hit.depth <= MAX_DEPTH, `depth 越界: ${hit.depth}`);
    assert.ok(Number.isInteger(hit.tokens) && hit.tokens > 0, '每 hit 必须带 token 估计');
    assert.equal(typeof hit.weight, 'number');
  }
  assert.equal(result.tokens, result.hits.reduce((sum, hit) => sum + hit.tokens, 0), 'tokens 必须等于各 hit 之和');
  for (const hop of result.path) {
    assert.equal(typeof hop.from, 'string');
    assert.equal(typeof hop.to, 'string');
    assert.ok(Array.isArray(hop.why) && hop.why.length > 0, `每跳必须有 why：${JSON.stringify(hop)}`);
  }
}

// ---------------------------------------------------------------------------
// 1 · 信号 → 主题 → 棋谱
// ---------------------------------------------------------------------------

test('R11: 信号命中硬主题 ⇒ 命中 ep1/ep2（直接命中，depth=1，带 why 与日期）', () => {
  const result = walk();
  assertInvariants(result);

  assert.equal(result.maxDepth, 2);
  assert.deepEqual(result.matched.topics.map((t) => t.key), [T.repo.key]);
  assert.equal(result.matched.topics[0].matchedBy, 'term');
  assert.equal(result.matched.topics[0].score, 0.6, '「dsh-kifuin」是 key 的子串 ⇒ 包含匹配 0.6');

  const episodes = episodeIds(result);
  assert.ok(episodes.includes('ep-0001'));
  assert.ok(episodes.includes('ep-0002'));

  const ep1 = result.hits.find((hit) => hit.episode === 'ep-0001' && !hit.claim);
  assert.equal(ep1.depth, 1);
  assert.equal(ep1.link, null, '直接命中不是沿边来的 ⇒ link=null');
  assert.deepEqual(ep1.why, [T.repo.key]);
  assert.equal(ep1.occurredAt, T0 + 1_500, 'occurredAt 取事件时间窗右端（lastEventAt）');
  assert.equal(ep1.kind, 'failure', 'signals.failures>0 ⇒ 失败教训');
  assert.equal(ep1.text, '依赖缺失：Cannot find module yaml（失败 2 次）');
});

test('R11: 一跳 ep2→ep3 带 why（主题 key + link id），且 path 里能查到两条 ep1↔ep2 的 why', () => {
  const result = walk();
  const ep3 = result.hits.find((hit) => hit.episode === 'ep-0003' && !hit.claim);
  assert.ok(ep3, 'ep-0003 只能由 ep-0002 沿 link-0002 走到');
  assert.equal(ep3.depth, 2);
  assert.equal(ep3.link, 'link-0002');
  assert.deepEqual(ep3.why, [T.tool.key]);

  const hop = result.path.find((p) => p.kind === 'link' && p.from === 'ep-0002' && p.to === 'ep-0003');
  assert.ok(hop, 'path 必须记录这一跳');
  assert.deepEqual(hop.why, [T.tool.key]);
  assert.equal(hop.link, 'link-0002');
  assert.equal(hop.new, true);

  // 两端都入选的棋谱：相关边也入 path（"为什么相关"可查），且只记一个方向
  const back = result.path.find((p) => p.kind === 'link' && p.from === 'ep-0001' && p.to === 'ep-0002');
  assert.ok(back, 'ep1→ep2 的一跳必须带 why 出现在 path 里');
  assert.deepEqual(back.why, [T.repo.key]);
  assert.equal(back.link, 'link-0001');
  assert.equal(back.new, false);
  assert.equal(
    result.path.filter((p) => p.kind === 'link' && p.from === 'ep-0002' && p.to === 'ep-0001').length,
    0,
    '不记镜像方向',
  );

  // 有命中的棋谱都必须能从 signal 起追到（match → mention/claim 链）
  assert.ok(result.path.some((p) => p.kind === 'match' && p.from === 'signal' && p.to === T.repo.id));
  assert.ok(result.path.some((p) => p.kind === 'mention' && p.from === T.repo.id && p.to === 'ep-0001'));
});

test('R11: 深度 ≤2 —— depth=99 与 depth=2 等价，第 3 跳的 ep4 永不出现', () => {
  const deep = walk({ depth: 99 });
  assertInvariants(deep);
  assert.equal(deep.maxDepth, 2, 'depth 被 clamp 到 2');
  assert.equal(Math.max(...deep.hits.map((hit) => hit.depth)), 2);
  assert.ok(episodeIds(deep).includes('ep-0003'), '第 2 跳可达');
  assert.ok(!episodeIds(deep).includes('ep-0004'), '第 3 跳不可达（ep-0003 不再展开）');
  assert.ok(!episodeIds(deep).includes('ep-0005'), '子代理局不独立成谱');

  const one = walk({ depth: 1 });
  assertInvariants(one);
  assert.equal(one.maxDepth, 1);
  assert.ok(one.hits.every((hit) => hit.depth === 1));
  assert.ok(!episodeIds(one).includes('ep-0003'));

  assert.equal(clampDepth(0), 1, '≤0 抬到 1（直接命中总是做）');
  assert.equal(clampDepth(2), 2);
  assert.equal(clampDepth(99), MAX_DEPTH);
  assert.equal(clampDepth(undefined), WALK_DEFAULTS.depth);
});

test('R11: folded-into 的子代理局不入网、"无时不入"的局不入网（只计数，不抛）', () => {
  const result = walk();
  assert.equal(result.dropped.folded, 1);
  assert.ok(!episodeIds(result).includes('ep-0005'));
  assert.equal(result.dropped.noTime, 2, 'ep-0006（无时间戳）+ c-noTime-1（claim 无时间戳）');
  assert.ok(!episodeIds(result).includes('ep-0006'));
  assert.equal(result.dropped.invalidated, 1);
  assert.ok(!claimIds(result).includes('c-invalidated-1'));
});

// ---------------------------------------------------------------------------
// 2 · 排序：失败教训 > 约束/偏好 > 定式候选
// ---------------------------------------------------------------------------

test('R11: 排序按档位（失败 > 约束/偏好 > 定式候选），分类只看机械信号', () => {
  const result = walk();
  assertInvariants(result);

  const rank = { failure: 0, constraint: 1, claim: 2 };
  const ranks = result.hits.map((hit) => rank[hit.kind]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), '档位必须单调不减');
  assert.equal(result.hits[0].kind, 'failure', '失败教训排最前');

  const classes = result.hits.map((hit) => `${hit.claim ?? hit.episode}:${hit.kind}`);
  // 失败档：antipattern claim + failures>0 的棋谱
  assert.ok(classes.includes('c-antipattern-1:failure'));
  assert.ok(classes.includes('ep-0001:failure'));
  assert.ok(classes.includes('ep-0003:failure'), '一跳来的棋谱同样按 signals 分类');
  assert.ok(classes.includes('c-antipattern-2:failure'));
  // 约束/偏好档：preference claim
  assert.ok(classes.includes('c-preference-1:constraint'));
  // 定式候选档：无失败无约束的棋谱 + fact claim
  assert.ok(classes.includes('ep-0002:claim'));
  assert.ok(classes.includes('c-fact-1:claim'));

  const firstConstraint = result.hits.findIndex((hit) => hit.kind === 'constraint');
  const lastFailure = result.hits.findLastIndex((hit) => hit.kind === 'failure');
  assert.ok(lastFailure < firstConstraint, '所有失败教训必须排在约束/偏好之前');
  assert.ok(!result.hits.some((hit) => hit.claim === 'c-unrelated-1'), '无关 claim 不出现');
});

// ---------------------------------------------------------------------------
// 3 · limit / budget / omitted
// ---------------------------------------------------------------------------

test('R11: limit 前缀式截断（omitted.count/reason/byLimit 对得上）', () => {
  const all = walk({ limit: 100 });
  assert.equal(all.hits.length, 7);
  assert.deepEqual(all.omitted, { count: 0, reason: null, byLimit: 0, byBudget: 0, crossScope: 0 });

  const two = walk({ limit: 2 });
  assert.equal(two.hits.length, 2);
  assert.deepEqual(two.hits.map((hit) => hit.claim ?? hit.episode), all.hits.slice(0, 2).map((hit) => hit.claim ?? hit.episode));
  assert.deepEqual(two.omitted, { count: 5, reason: 'limit', byLimit: 5, byBudget: 0, crossScope: 0 });
  assert.equal(two.tokens, two.hits.reduce((sum, hit) => sum + hit.tokens, 0));

  const zero = walk({ limit: 0 });
  assert.equal(zero.hits.length, 0);
  assert.deepEqual(zero.omitted, { count: 7, reason: 'limit', byLimit: 7, byBudget: 0, crossScope: 0 });

  const dflt = walk({ limit: undefined, budgetTokens: 10_000 });
  assert.equal(dflt.hits.length, WALK_DEFAULTS.limit, '默认 limit=5');
  assert.equal(dflt.omitted.count, 2);
});

test('R11: budgetTokens 前缀式截断（token 超了就停，后面的全计入 omitted）', () => {
  const all = walk({ limit: 100 });
  const first = all.hits[0];
  assert.ok(first.tokens > 0);

  const exact = walk({ limit: 100, budgetTokens: first.tokens });
  assert.equal(exact.hits.length, 1, '刚好塞下第一条');
  assert.equal(exact.tokens, first.tokens);
  assert.deepEqual(exact.omitted, { count: 6, reason: 'budget', byLimit: 0, byBudget: 6, crossScope: 0 });

  const none = walk({ limit: 100, budgetTokens: 0 });
  assert.equal(none.hits.length, 0);
  assert.equal(none.tokens, 0);
  assert.deepEqual(none.omitted, { count: 7, reason: 'budget', byLimit: 0, byBudget: 7, crossScope: 0 });
  assert.ok(none.path.every((hop) => hop.from === 'signal' || hop.kind === 'match'), '没命中就不该有证据路径');

  const full = walk({ limit: 100, budgetTokens: 10_000 });
  assert.ok(full.tokens <= 10_000);
  assert.equal(full.tokens, all.hits.reduce((sum, hit) => sum + hit.tokens, 0));
});

// ---------------------------------------------------------------------------
// 4 · 无命中 / 沉默
// ---------------------------------------------------------------------------

test('R11: 无命中 ⇒ 空 hits、零 tokens、零 path、omitted.count=0（沉默是默认）', () => {
  const result = walk({ signal: { kind: 'root-message', terms: ['完全不存在zzz'], entities: [], at: T0 } });
  assert.deepEqual(result.hits, []);
  assert.deepEqual(result.path, []);
  assert.equal(result.tokens, 0);
  assert.deepEqual(result.omitted, { count: 0, reason: null, byLimit: 0, byBudget: 0, crossScope: 0 });
  assert.deepEqual(result.matched.topics, []);
  assert.equal(result.dropped.noTopic, 1);

  // 空信号（无词无实体）同样沉默，不抛
  const blank = walk({ signal: {} });
  assert.deepEqual(blank.hits, []);
  assert.equal(blank.signal.kind, 'root-message');
});

test('R11: 空 store（连目录都没有）⇒ 空结果，不建目录不抛', () => {
  const bare = createStore({ root: path.join(tmp, `bare-${(seq += 1)}`), now: T0 });
  const result = walkFromSignals({ signal: REPO_SIGNAL, store: bare, scope: SCOPE });
  assert.deepEqual(result.hits, []);
  assert.equal(result.tokens, 0);
});

// ---------------------------------------------------------------------------
// 5 · 只读
// ---------------------------------------------------------------------------

test('R11: 不写盘 —— 走之前/之后 store 的 sha256 快照与 journal 行数完全一致', () => {
  const before = fingerprint(store);
  const result = walkFromSignals({ signal: REPO_SIGNAL, store, scope: SCOPE, depth: 2, limit: 10, budgetTokens: 10_000 });
  assert.ok(result.hits.length > 0);
  const after = fingerprint(store);
  assert.deepEqual(after, before, 'walk 不得写盘（条目字节、manifest 计数、journal 全部不变）');
});

test('R11: 只读结构 —— 源码不 import 任何模块（连 node: 内置都没有）', () => {
  assert.equal(/^\s*import\s/m.test(WALK_SOURCE), false, 'R11 必须零 import：没有 fs 句柄就不可能写盘');
  assert.equal(/require\s*\(/.test(WALK_SOURCE), false);
  // 只读 store 面：只需要 list()；给一个只有 list 的 wrapper 也能跑通
  const readOnly = { list: (kind) => store.list(kind) };
  const result = walkFromSignals({ signal: REPO_SIGNAL, store: readOnly, scope: SCOPE, limit: 3, budgetTokens: 10_000 });
  assert.equal(result.hits.length, 3);
});

test('R11: 同输入同输出（可复现）', () => {
  const a = walk({ limit: 5, budgetTokens: 500 });
  const b = walk({ limit: 5, budgetTokens: 500 });
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// 6 · 主题匹配口径 / 信号校验 / token 口径
// ---------------------------------------------------------------------------

test('R11: 主题匹配 —— 精确 / 包含 / 实体 kind 过滤 / 主题 id / 大小写 / 最小长度闸', () => {
  const topics = [...fixtureTopics(), topicRecord({ id: 't:tool:ffff0000', kind: 'tool', key: 'ls', df: 1, idfNorm: 0.3 })];

  const exact = matchTopics({ signal: { terms: [T.repo.key] }, topics });
  assert.equal(exact.length, 1);
  assert.equal(exact[0].topic.id, T.repo.id);
  assert.equal(exact[0].score, 1);
  assert.equal(exact[0].matchedBy, 'term');

  const contains = matchTopics({ signal: { terms: ['dsh-kifuin'] }, topics });
  assert.equal(contains[0].score, 0.6);

  const upper = matchTopics({ signal: { terms: ['MYCF711/DSH-KIFUIN'] }, topics });
  assert.equal(upper.length, 1);
  assert.equal(upper[0].score, 1, '大小写不敏感');

  const cjk = matchTopics({ signal: { terms: ['摸瓜'] }, topics });
  assert.deepEqual(cjk.map((m) => m.topic.key), [T.term.key], 'CJK 2 字参与包含匹配');

  assert.deepEqual(matchTopics({ signal: { terms: ['摸'] }, topics }), [], 'CJK 1 字闸');
  assert.deepEqual(
    matchTopics({ signal: { terms: ['ls'] }, topics: [topicRecord({ id: 't:tool:ffff1111', kind: 'tool', key: 'lsof', df: 2, idfNorm: 0.2 })] }),
    [],
    'ASCII 2 字闸：`ls` 不能"包含"进 `lsof`',
  );
  assert.deepEqual(
    matchTopics({ signal: { terms: ['ls'] }, topics }).map((m) => m.topic.key),
    ['ls'],
    '与主题 key 完全相等仍然算精确命中（2 字闸只挡包含匹配）',
  );

  const byEntity = matchTopics({ signal: { entities: [{ kind: 'repo', key: T.repo.key }] }, topics });
  assert.equal(byEntity[0].score, 1);
  assert.equal(byEntity[0].matchedBy, 'entity');

  const wrongKind = matchTopics({ signal: { entities: [{ kind: 'file', key: T.repo.key }] }, topics });
  assert.deepEqual(wrongKind, [], '实体 kind 与主题 kind 不符 ⇒ 不匹配');

  const byId = matchTopics({ signal: { entities: [{ key: T.repo.id }] }, topics });
  assert.deepEqual(byId.map((m) => m.topic.id), [T.repo.id], '实体 key 可以是主题 id');

  const multi = matchTopics({ signal: { terms: ['dsh-kifuin', 'walk.mjs'] }, topics });
  assert.deepEqual(multi.map((m) => m.topic.key), [T.file.key, T.repo.key], 'df 越小（越稀有）越先跳');
});

test('R11: maxTopics 截断（matched.truncated 计数，命中变少）', () => {
  const signal = { kind: 'activity', terms: ['dsh-kifuin', 'walk.mjs'], entities: [], at: T0 };
  const all = walk({ signal, maxTopics: 10 });
  assert.equal(all.matched.topics.length, 2);
  assert.equal(all.matched.truncated, 0);

  const one = walk({ signal, maxTopics: 1 });
  assert.equal(one.matched.topics.length, 1);
  assert.equal(one.matched.truncated, 1);
});

test('R11: 信号校验（坏 signal / 坏 store 抛 WalkError；宽容字段不抛）', () => {
  assert.throws(() => normalizeSignal(null), (err) => err instanceof WalkError && err.code === 'walk/invalid-signal');
  assert.throws(() => normalizeSignal({ kind: '从来没见过' }), (err) => err.code === 'walk/invalid-signal');
  assert.throws(
    () => walkFromSignals({ signal: REPO_SIGNAL, store: {} }),
    (err) => err instanceof WalkError && err.code === 'walk/invalid-store',
  );
  assert.throws(() => walkFromSignals({ signal: REPO_SIGNAL }), (err) => err.code === 'walk/invalid-store');

  const lenient = normalizeSignal({ kind: 'activity', terms: 'not-an-array', entities: [null, { key: '  ' }] });
  assert.deepEqual(lenient.terms, []);
  assert.deepEqual(lenient.entities, []);
  assert.equal(lenient.kind, 'activity');
});

test('R11: token 口径 —— CJK 1.5 字/token、ASCII 4 字/token', () => {
  assert.equal(TOKEN_RULE.cjkCharsPerToken, 1.5);
  assert.equal(TOKEN_RULE.asciiCharsPerToken, 4);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('棋院'), 2); // 2/1.5 = 1.33 → 2
  assert.equal(estimateTokens('记忆系统'), 3); // 4/1.5 = 2.67 → 3
  assert.equal(estimateTokens('abcd记忆'), 3); // 1 + 1.33 → 3
  assert.equal(estimateTokens(null), 0);

  const result = walk({ limit: 100 });
  for (const hit of result.hits) {
    assert.ok(hit.tokens >= estimateTokens(hit.episode ?? ''), 'hit.tokens 至少覆盖指针本身');
  }
  assert.equal(result.tokens, result.hits.reduce((sum, hit) => sum + hit.tokens, 0));
});

// ---------------------------------------------------------------------------
// 7 · 文本命中主题 key 的 claim（依附不到命中棋谱时的唯一机械通路）
// ---------------------------------------------------------------------------

test('R11: 另外一条信号（CJK 主题）—— claim 文本命中主题 key 也能成为指针', () => {
  const result = walk({ signal: TERM_SIGNAL, limit: 10 });
  assertInvariants(result);
  assert.deepEqual(result.matched.topics.map((t) => t.key), [T.term.key]);
  assert.equal(result.matched.topics[0].score, 1, 'CJK 词完全相等 ⇒ 精确匹配');

  const ep4 = result.hits.find((hit) => hit.episode === 'ep-0004' && !hit.claim);
  assert.ok(ep4, 'ep-0004 命中「顺藤摸瓜」');
  assert.equal(ep4.depth, 1);

  // ep-0003 由 link-0003 一跳而来（why = example.com，不是起始主题）
  const ep3 = result.hits.find((hit) => hit.episode === 'ep-0003' && !hit.claim);
  assert.ok(ep3);
  assert.equal(ep3.depth, 2);
  assert.deepEqual(ep3.why, [T.domain.key]);

  // c-text-1 依附不到任何命中棋谱（support 的 ep-0006 从不入网）⇒ 靠文本里出现主题 key 命中
  const textClaim = result.hits.find((hit) => hit.claim === 'c-text-1');
  assert.ok(textClaim, 'claim 文本里出现主题 key ⇒ 可以成为指针');
  assert.deepEqual(textClaim.why, [T.term.key]);
  assert.equal(textClaim.episode, 'ep-0006', 'episode 字段回指 support 里的棋谱（provenance）');
  assert.ok(result.path.some((hop) => hop.kind === 'claim' && hop.to === 'c-text-1' && hop.from === T.term.id));

  // 无时间戳的 claim 依然"无时不入"
  assert.equal(result.dropped.noTime, 1);
  assert.ok(!claimIds(result).includes('c-noTime-1'));
});

// ---------------------------------------------------------------------------
// 8 · 作用域（T8b 修复：闸 1 抓到的越界 —— 候选入 hits 之前先过 scope 闸）
// ---------------------------------------------------------------------------

const T_SCOPE = { id: 't:term:1000aaa1', kind: 'term', key: 'yaml', df: 4, idfNorm: 0.8 };

function scopeFixture() {
  const topics = [{
    id: T_SCOPE.id, kind: T_SCOPE.kind, key: T_SCOPE.key, df: T_SCOPE.df, idfNorm: T_SCOPE.idfNorm,
    firstSeenAt: T0, lastSeenAt: T0 + 4_000, episodes: ['ep-a1', 'ep-a2', 'ep-b1'],
  }];
  const episodes = [
    episodeRecord({ id: 'ep-a1', topics: [epTopic(T_SCOPE)], failures: 1, at: T0 + 1_000, l0: '同工作区的失败' }),
    episodeRecord({ id: 'ep-a2', topics: [epTopic(T_SCOPE)], at: T0 + 2_000, l0: '同工作区的参考（盘符大小写/尾斜杠不同）' }),
    episodeRecord({ id: 'ep-b1', topics: [epTopic(T_SCOPE)], failures: 2, at: T0 + 3_000, l0: '另一个工作区的失败' }),
    episodeRecord({ id: 'ep-noscope', topics: [epTopic(T_SCOPE)], failures: 1, at: T0 + 3_500, l0: '没有 scopeKey 的棋谱' }),
  ];
  episodes[1].scopeKey = String.raw`w:D:\work\demo`; // 同工作区的另一种写法（反斜杠 + 盘符大写；归一后 == SCOPE）
  episodes[2].scopeKey = OTHER_SCOPE;
  delete episodes[3].scopeKey;

  const links = [
    linkRecord({ id: 'link-scope-1', a: 'ep-a1', b: 'ep-a2', topics: [T_SCOPE.id], why: T_SCOPE.key, weight: 1, occurredAt: T0 + 2_500 }),
    linkRecord({ id: 'link-scope-2', a: 'ep-a1', b: 'ep-b1', topics: [T_SCOPE.id], why: T_SCOPE.key, weight: 1, occurredAt: T0 + 3_100 }),
  ];
  const claims = [
    claimRecord({
      id: 'c-scope-a', kind: 'antipattern', text: '同工作区的失败：先 npm view 再装',
      support: [{ episode: 'ep-a1', seq: 3, occurredAt: T0 + 1_100 }], occurredAt: T0 + 1_100, scopeKey: SCOPE,
    }),
    claimRecord({
      id: 'c-scope-u', kind: 'preference', text: 'yaml 装不上时先 npm view 再装（用户层偏好）',
      support: [{ episode: 'ep-a1', seq: 4, occurredAt: T0 + 1_400 }], occurredAt: T0 + 1_400, scopeKey: 'u:owner',
    }),
    claimRecord({
      id: 'c-scope-b', kind: 'fact', text: '另一个工作区的事实：端口 3425',
      support: [{ episode: 'ep-b1', seq: 5, occurredAt: T0 + 1_200 }], occurredAt: T0 + 1_200, scopeKey: OTHER_SCOPE,
    }),
    claimRecord({
      id: 'c-scope-cross2', kind: 'fact', text: 'yaml 要先查版本（同域证据、别域的结论）',
      support: [{ episode: 'ep-a1', seq: 8, occurredAt: T0 + 1_500 }], occurredAt: T0 + 1_500, scopeKey: OTHER_SCOPE,
    }),
    claimRecord({
      id: 'c-scope-noscope', kind: 'fact', text: '没有 scopeKey 的 claim',
      support: [{ episode: 'ep-a1', seq: 6 }], occurredAt: T0 + 1_300, scopeKey: null,
    }),
  ];
  return { topics, episodes, links, claims };
}

let scopeSeq = 0;
function scopeStore() {
  const target = createStore({ root: path.join(tmp, `scope-store-${(scopeSeq += 1)}`), now: T0 });
  target.ensureDirs();
  const fixture = scopeFixture();
  target.putMany('episodes', fixture.episodes, { at: T0 });
  target.putMany('topics', fixture.topics, { at: T0 });
  target.putMany('links', fixture.links, { at: T0 });
  target.putMany('claims', fixture.claims, { at: T0 });
  return target;
}

function walkScope(target, opts = {}) {
  return walkFromSignals({
    signal: { kind: 'root-message', terms: ['yaml'], entities: [], at: T0 + 9_000 },
    store: target,
    scope: SCOPE,
    limit: 10,
    budgetTokens: 10_000,
    ...opts,
  });
}

test('R11 作用域: 同 scope 命中（含写法归一）、跨 scope 不命中、u: 用户层可见', () => {
  const target = scopeStore();
  const result = walkScope(target);
  assertInvariants(result);

  const episodes = episodeIds(result).sort();
  assert.deepEqual(episodes, ['ep-a1', 'ep-a2'], '同工作区可见（盘符大小写/反斜杠/尾斜杠归一）；跨域与无域不可见');

  const claims = claimIds(result).sort();
  assert.deepEqual(claims, ['c-scope-a', 'c-scope-u'], 'claim 自己的 scopeKey 才是判据；u: 用户层跨工作区可见');

  assert.equal(result.scope.current, SCOPE);
  assert.equal(result.scope.mode, 'same-scope+user-layer');
  assert.equal(result.omitted.count, 0, '作用域拒掉的不算 limit/budget 的 omitted.count');
  assert.equal(result.omitted.crossScope, 4, '相关但被闸挡下：ep-b1 + c-scope-cross2（跨域）+ ep-noscope + c-scope-noscope（缺域）');
  assert.equal(result.dropped.crossScope, 2);
  assert.equal(result.dropped.scopeMissing, 2);
  for (const hit of result.hits) {
    assert.ok([SCOPE, 'u:owner'].includes(hit.scopeKey), `hit 的 scopeKey 越界: ${hit.scopeKey}`);
  }
});

test('R11 作用域: 跨域相关边不进 path（不留跨工作区指针）', () => {
  const result = walkScope(scopeStore());
  assert.equal(result.path.some((hop) => hop.to === 'ep-b1' || hop.from === 'ep-b1'), false);
  assert.equal(result.path.some((hop) => hop.link === 'link-scope-2'), false, '跨域边不跳、不记录');
  assert.ok(result.path.some((hop) => hop.link === 'link-scope-1'), '同域边照常记录（why 可查）');
});

test('R11 作用域: scope 缺失 ⇒ 降级为「只放用户层」（默认拒绝跨域）', () => {
  const target = scopeStore();
  const result = walkFromSignals({
    signal: { kind: 'root-message', terms: ['yaml'], entities: [], at: T0 + 9_000 },
    store: target,
    limit: 10,
    budgetTokens: 10_000,
  });
  assertInvariants(result);
  assert.equal(result.scope.current, null);
  assert.equal(result.scope.mode, 'user-layer-only');
  assert.deepEqual(episodeIds(result), [], '拿不到当前工作区 ⇒ 一个 w: 棋谱都不放');
  assert.deepEqual(claimIds(result), ['c-scope-u'], '只放 u: 用户层（claim 靠文本命中主题 key 进来）');
  assert.equal(result.omitted.crossScope, 5, '3 个 w: 棋谱 + c-scope-cross2 跨域，ep-noscope 缺域');
  assert.equal(result.dropped.crossScope, 4);
  assert.equal(result.dropped.scopeMissing, 1);
});

test('R11 作用域: 解析优先级（opts > signal.scope > signal.scopeKey > store.scopeKey）与归一化', () => {
  assert.equal(resolveScope({ scope: SCOPE }), SCOPE);
  assert.equal(resolveScope({ scope: OTHER_SCOPE, signal: { scope: SCOPE } }), OTHER_SCOPE);
  assert.equal(resolveScope({ signal: { scope: SCOPE } }), SCOPE);
  assert.equal(resolveScope({ signal: { scopeKey: String.raw`w:D:\work\demo` } }), SCOPE);
  assert.equal(resolveScope({ store: { scopeKey: SCOPE } }), SCOPE);
  assert.equal(resolveScope({ store: { currentScope: SCOPE } }), SCOPE);
  assert.equal(resolveScope({ signal: {}, store: {} }), null);
  assert.equal(resolveScope({ scope: 'w:unknown' }), null, '未知哨兵不算作用域');
  assert.equal(resolveScope({ scope: 'w:<unknown>' }), null);
  assert.equal(resolveScope({}), null);

  assert.equal(normalizeScopeKey(String.raw`w:D:\work\demo`), SCOPE);
  assert.equal(normalizeScopeKey('D:/work/demo/'), SCOPE);
  assert.equal(normalizeScopeKey('u:Owner'), 'u:owner');
  assert.equal(normalizeScopeKey(''), '');

  // opts.scope 优先：把当前作用域指到另一个工作区 ⇒ 只看那边
  const other = walkScope(scopeStore(), { scope: OTHER_SCOPE, signal: { kind: 'root-message', terms: ['yaml'], scopeKey: SCOPE } });
  assert.deepEqual(episodeIds(other), ['ep-b1']);
  // 2026-11-02：u:/claim 也必须有**同作用域证据棋谱**才进卡片（A5 独立复核要求 0 越界行）。
  // c-scope-cross2 的证据在 demo、c-scope-u 的证据也不在 e:/other-workspace ⇒ 两者都不出现。
  assert.deepEqual(claimIds(other).sort(), ['c-scope-b']);
});

test('R11 作用域: 与 R13 闸 1 同口径（walk 可见 ⇒ 闸 1 必可见；归一化一致）', () => {
  const scopes = [
    'w:d:/work/demo', 'w:D:/Work/Demo', 'w:d:/work/demo/', 'w:e:/other-workspace', 'w:d:/work',
    'w:d:/work/demo/sub', 'u:owner', 'u:other', 'w:unknown', 'w:<unknown>', '',
  ];
  for (const s of scopes) assert.equal(normalizeScopeKey(s), gateNormalizeScope(s), `归一化与闸 1 不一致: ${s}`);

  let allowed = 0;
  for (const entry of scopes) {
    for (const current of scopes) {
      if (!isScopeVisible(entry, current)) continue;
      allowed += 1;
      assert.equal(gateIsScopeVisible(entry, current), true, `walk 可见但闸 1 会判红: ${entry} @ ${current}`);
    }
  }
  assert.ok(allowed > 0);

  // 已知且是故意的差异：闸 1 允许「子看父」的 w: 路径前缀；walk 更严（不跨工作区）
  assert.equal(gateIsScopeVisible('w:d:/work', 'w:d:/work/demo'), true);
  assert.equal(isScopeVisible('w:d:/work', 'w:d:/work/demo'), false);
});

test('R11 作用域: omitted.crossScope 与 limit/budget 分开记（可审计、不混算）', () => {
  const target = scopeStore();
  const full = walkScope(target);
  assert.equal(full.omitted.crossScope, full.dropped.crossScope + full.dropped.scopeMissing);
  assert.ok(full.omitted.crossScope > 0);

  const tight = walkScope(target, { limit: 1 });
  assert.equal(tight.omitted.reason, 'limit');
  assert.equal(tight.omitted.crossScope, full.omitted.crossScope, '作用域先行 ⇒ limit 截断不改变 crossScope');
  assert.equal(tight.omitted.byLimit, full.hits.length - 1);
});

// D3（2026-11-02）：跨局重复次数优先于权重
test('D3: 反复出现的坑排在一次性高权重命中之前', async () => {
  const { compareHits } = await import('../src/rooms/walk.mjs');
  const base = { kind: 'claim', depth: 1, weight: 0.5, occurredAt: 1, episode: 'ep-a', claim: 'c-a' };
  const repeated = { ...base, repeat: 9, claim: 'c-repeat' };
  const oneOff = { ...base, repeat: 1, weight: 0.9, claim: 'c-oneoff' };
  // repeat 高者排在前面（返回负数）
  assert.ok(compareHits(repeated, oneOff) < 0, 'repeat 9 必须排在 weight 0.9 的一次性命中之前');
  assert.ok(compareHits(oneOff, repeated) > 0);
  // repeat 相同才比较 weight
  const a = { ...base, repeat: 2, weight: 0.9, claim: 'c-a' };
  const b = { ...base, repeat: 2, weight: 0.5, claim: 'c-b' };
  assert.ok(compareHits(a, b) < 0);
});

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
  WalkError,
  HIT_KINDS,
  MAX_DEPTH,
  WALK_DEFAULTS,
  TOKEN_RULE,
} from '../src/rooms/walk.mjs';

const WALK_SOURCE = readFileSync(new URL('../src/rooms/walk.mjs', import.meta.url), 'utf8');

const T0 = 1_760_000_000_000; // 夹具事件时间（固定的过去）

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
  assert.deepEqual(all.omitted, { count: 0, reason: null, byLimit: 0, byBudget: 0 });

  const two = walk({ limit: 2 });
  assert.equal(two.hits.length, 2);
  assert.deepEqual(two.hits.map((hit) => hit.claim ?? hit.episode), all.hits.slice(0, 2).map((hit) => hit.claim ?? hit.episode));
  assert.deepEqual(two.omitted, { count: 5, reason: 'limit', byLimit: 5, byBudget: 0 });
  assert.equal(two.tokens, two.hits.reduce((sum, hit) => sum + hit.tokens, 0));

  const zero = walk({ limit: 0 });
  assert.equal(zero.hits.length, 0);
  assert.deepEqual(zero.omitted, { count: 7, reason: 'limit', byLimit: 7, byBudget: 0 });

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
  assert.deepEqual(exact.omitted, { count: 6, reason: 'budget', byLimit: 0, byBudget: 6 });

  const none = walk({ limit: 100, budgetTokens: 0 });
  assert.equal(none.hits.length, 0);
  assert.equal(none.tokens, 0);
  assert.deepEqual(none.omitted, { count: 7, reason: 'budget', byLimit: 0, byBudget: 7 });
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
  assert.deepEqual(result.omitted, { count: 0, reason: null, byLimit: 0, byBudget: 0 });
  assert.deepEqual(result.matched.topics, []);
  assert.equal(result.dropped.noTopic, 1);

  // 空信号（无词无实体）同样沉默，不抛
  const blank = walk({ signal: {} });
  assert.deepEqual(blank.hits, []);
  assert.equal(blank.signal.kind, 'root-message');
});

test('R11: 空 store（连目录都没有）⇒ 空结果，不建目录不抛', () => {
  const bare = createStore({ root: path.join(tmp, `bare-${(seq += 1)}`), now: T0 });
  const result = walkFromSignals({ signal: REPO_SIGNAL, store: bare });
  assert.deepEqual(result.hits, []);
  assert.equal(result.tokens, 0);
});

// ---------------------------------------------------------------------------
// 5 · 只读
// ---------------------------------------------------------------------------

test('R11: 不写盘 —— 走之前/之后 store 的 sha256 快照与 journal 行数完全一致', () => {
  const before = fingerprint(store);
  const result = walkFromSignals({ signal: REPO_SIGNAL, store, depth: 2, limit: 10, budgetTokens: 10_000 });
  assert.ok(result.hits.length > 0);
  const after = fingerprint(store);
  assert.deepEqual(after, before, 'walk 不得写盘（条目字节、manifest 计数、journal 全部不变）');
});

test('R11: 只读结构 —— 源码不 import 任何模块（连 node: 内置都没有）', () => {
  assert.equal(/^\s*import\s/m.test(WALK_SOURCE), false, 'R11 必须零 import：没有 fs 句柄就不可能写盘');
  assert.equal(/require\s*\(/.test(WALK_SOURCE), false);
  // 只读 store 面：只需要 list()；给一个只有 list 的 wrapper 也能跑通
  const readOnly = { list: (kind) => store.list(kind) };
  const result = walkFromSignals({ signal: REPO_SIGNAL, store: readOnly, limit: 3, budgetTokens: 10_000 });
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

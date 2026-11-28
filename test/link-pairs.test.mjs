// P1-2 等价性测试：**端点对限定**（默认 pairStrategy:'scoped'）vs **全量两两配对**（'full'）。
//
// 为什么单独立一个文件（与 R05 的 tombstone test/link.test.mjs 并列）：
//   这一刀改的是**生成期候选范围**，不是判据。判据正确性由 link.test.mjs 钉住；
//   这里钉的是「换了枚举范围，边集合一条不多、一条不少」+「枚举范围真的变小了」。
//
// 三条独立证据（互不替代）：
//   1. 全量对照：同一语料，'full' 与默认（'scoped'）输出逐条相等（顺序允许不同，这里更强：顺序也相同）。
//   2. 独立实现：按契约（硬主题判别性 / 软主题 ≥2）在测试内重写一份**朴素全对** oracle，
//      与默认输出的 shared-topic 子集逐条比对 —— 不依赖 link.mjs 的内部视图与预计算。
//   3. 成本 tombstone：`scan.pairsExamined` 必须等于测试自己算出的候选对数、且远小于 C(N,2)。
//      **删掉端点对过滤 ⇒ 枚举退化回全量 ⇒ pairsExamined === pairSpace ⇒ 本文件红**（见「候选范围」测试）。
//
// 另覆盖：稠密语料回退（候选登记比全扫更贵 ⇒ 自动走全量，输出不变）、同 id 重复棋谱、确定性。

import test from 'node:test';
import assert from 'node:assert/strict';

import { HARD_KINDS, SOFT_KINDS } from '../src/rooms/topic.mjs';
import { buildLinks, DEFAULT_LINK_OPTIONS } from '../src/rooms/link.mjs';

const T0 = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// fixture 工具
// ---------------------------------------------------------------------------

/** 确定性 PRNG（mulberry32）：fixture 可重放，不依赖 Math.random。 */
function mulberry32(a) {
  let s = a | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let topicSeq = 0;
/** 造一个主题视图（id 形状与 R04 一致：t:<kind>:<8 hex>）。 */
function topic(kind, key, occurrences) {
  topicSeq += 1;
  return { id: `t:${kind}:${topicSeq.toString(16).padStart(8, '0')}`, kind, key, occurrences };
}

/** 造一条 occurrence（可带 nodeId/edgeId，节点级边靠它溯源）。 */
function occ(epIndex, seq, quote, extra = {}) {
  return { ...extra, seq, quote, occurredAt: T0 + epIndex * 1000 + seq };
}

function mkEpisode(id, index) {
  return { id, scopeKey: 'w:d:/work/demo', startedAt: T0 + index * 1000, topics: [] };
}

/** 边的内容指纹：任一字段不同即视为「不是同一条边」。 */
function linkKey(l) {
  const side = (s) => `${s.episode}|${s.nodeId ?? ''}|${s.edgeId ?? ''}`;
  return [
    l.kind,
    side(l.a),
    side(l.b),
    (l.topics ?? []).join(','),
    String(l.why),
    String(l.weight),
    String(l.occurredAt),
  ].join('\u0001');
}

/** 边集合相等（允许顺序不同）+ 逐条给出差异，便于定位。 */
function assertSameLinkSet(actual, expected, label) {
  const keyOf = (l) => linkKey(l);
  const a = new Map(actual.map((l) => [keyOf(l), l]));
  const b = new Map(expected.map((l) => [keyOf(l), l]));
  const onlyActual = [...a.keys()].filter((k) => !b.has(k));
  const onlyExpected = [...b.keys()].filter((k) => !a.has(k));
  assert.deepEqual(onlyActual, [], `${label}：多出的边`);
  assert.deepEqual(onlyExpected, [], `${label}：缺失的边`);
  assert.equal(actual.length, expected.length, `${label}：条数`);
}

// ---------------------------------------------------------------------------
// 独立 oracle：按契约朴素实现「棋谱↔棋谱」边（不看 link.mjs 的内部视图）
// ---------------------------------------------------------------------------

/** 与 R04/R05 同式的 IDF 归一（测试内独立写一份，避免与被测实现共用同一个错误）。 */
function idfNormOf(df, n) {
  const raw = Math.log((n + 1) / (df + 0.5)) / Math.log(n + 2);
  return Math.min(1, Math.max(0, raw));
}

function eligibleOf(df, n) {
  return df >= 2 && df < n && df <= Math.max(2, Math.ceil(n * 0.1));
}

/**
 * 朴素全对 oracle：只产出 shared-topic 边（硬主题优先，否则 ≥2 判别性软主题）。
 * 直接用 episodes 的原始 topics 数组算 df，不经过 buildLinks 的任何内部结构。
 */
function naiveSharedTopicLinks(episodes) {
  const ordered = [...episodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = ordered.length;
  const holders = new Map(); // topicId -> Set(epId)
  const perEp = new Map(); // epId -> Map(topicId -> view)
  for (const ep of ordered) {
    const byId = new Map();
    for (const t of ep.topics ?? []) {
      if (!t?.id) continue;
      if (!byId.has(t.id)) byId.set(t.id, t); // 同 id 取第一条（fixture 里不会有重复）
    }
    perEp.set(ep.id, byId);
    for (const id of byId.keys()) {
      if (!holders.has(id)) holders.set(id, new Set());
      holders.get(id).add(ep.id);
    }
  }
  const dfOf = (id) => holders.get(id)?.size ?? 0;
  const firstOcc = (t) => {
    const list = [...(t.occurrences ?? [])].sort((x, y) => {
      const sx = Number.isFinite(x?.seq) ? x.seq : Number.MAX_SAFE_INTEGER;
      const sy = Number.isFinite(y?.seq) ? y.seq : Number.MAX_SAFE_INTEGER;
      return sx - sy;
    });
    return list[0] ?? null;
  };

  const out = [];
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const ea = ordered[i];
      const eb = ordered[j];
      const a = perEp.get(ea.id);
      const b = perEp.get(eb.id);
      const hardA = [];
      const softA = [];
      for (const t of a.values()) {
        const df = dfOf(t.id);
        if (HARD_KINDS.has(t.kind) && t.kind !== 'error' && eligibleOf(df, n)) hardA.push(t);
        if (SOFT_KINDS.has(t.kind) && eligibleOf(df, n)) softA.push(t);
      }
      const sharedHard = hardA.filter((t) => b.has(t.id));
      if (sharedHard.length) {
        sharedHard.sort((x, y) => (idfNormOf(dfOf(y.id), n) - idfNormOf(dfOf(x.id), n)) || (x.key < y.key ? -1 : 1));
        const pa = firstOcc(sharedHard[0]);
        const pb = firstOcc(b.get(sharedHard[0].id));
        const at = Math.min(
          Number.isFinite(pa?.occurredAt) ? pa.occurredAt : Infinity,
          Number.isFinite(pb?.occurredAt) ? pb.occurredAt : Infinity,
        );
        out.push({
          kind: 'shared-topic',
          a: { episode: ea.id },
          b: { episode: eb.id },
          topics: sharedHard.map((t) => t.id),
          why: sharedHard.map((t) => t.key).join(', '),
          weight: 1,
          occurredAt: Number.isFinite(at) ? at : (ea.startedAt ?? null),
        });
        continue;
      }
      const sharedSoft = softA.filter((t) => b.has(t.id));
      if (sharedSoft.length >= 2) {
        sharedSoft.sort((x, y) => (idfNormOf(dfOf(y.id), n) - idfNormOf(dfOf(x.id), n)) || (x.key < y.key ? -1 : 1));
        const mean = sharedSoft.reduce((s, t) => s + idfNormOf(dfOf(t.id), n), 0) / sharedSoft.length;
        const pa = firstOcc(sharedSoft[0]);
        const pb = firstOcc(b.get(sharedSoft[0].id));
        const at = Math.min(
          Number.isFinite(pa?.occurredAt) ? pa.occurredAt : Infinity,
          Number.isFinite(pb?.occurredAt) ? pb.occurredAt : Infinity,
        );
        out.push({
          kind: 'shared-topic',
          a: { episode: ea.id },
          b: { episode: eb.id },
          topics: sharedSoft.map((t) => t.id),
          why: sharedSoft.map((t) => t.key).join(', '),
          weight: Math.round(0.5 * mean * 10000) / 10000,
          occurredAt: Number.isFinite(at) ? at : (ea.startedAt ?? null),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 语料 A：稀疏（主体）——硬主题成簇、软主题成对、error/file 造 same-error / same-file
// ---------------------------------------------------------------------------

const N_MAIN = 40;

function mainCorpus() {
  topicSeq = 0;
  const n = N_MAIN;
  const eps = [];
  for (let i = 0; i < n; i += 1) eps.push(mkEpisode(`ep-${String(i + 1).padStart(8, '0')}`, i));
  const add = (i, t) => eps[i].topics.push(t);

  // 通用主题：每局都有（df = N ⇒ 判别性不通过 ⇒ 只进 mention，不建棋谱↔棋谱边）
  const echo = topic('tool', 'bash', []);
  for (let i = 0; i < n; i += 1) add(i, { ...echo, occurrences: [occ(i, 1, 'bash')] });

  // 硬主题：repo 成簇（df ≤ 4 ⇒ 判别性通过）
  const repos = ['acme/kifu', 'acme/link', 'acme/view', 'acme/store', 'acme/gate'].map(
    (k) => topic('repo', k, []),
  );
  const repoHolders = [[0, 1, 2], [1, 2], [3, 4, 5, 6], [7, 8], [9, 10, 11]];
  repos.forEach((t, ti) => {
    for (const i of repoHolders[ti]) add(i, { ...t, occurrences: [occ(i, 2, t.key)] });
  });

  // 硬主题：dependency 成簇（df = 4 ⇒ 上限内）
  const dep = topic('dependency', 'dsh-gokifu-compact', []);
  for (const i of [12, 13, 14, 15]) add(i, { ...dep, occurrences: [occ(i, 2, 'dsh-gokifu-compact')] });

  // 硬主题：file + error 同时出现 ⇒ same-file；error 自己也成 same-error
  const file = topic('file', 'src/rooms/link.mjs', []);
  const err = topic('error', "Error: Cannot find module 'yaml'", []);
  for (const i of [16, 17, 18]) {
    add(i, { ...file, occurrences: [occ(i, 3, 'src/rooms/link.mjs')] });
    add(i, {
      ...err,
      occurrences: [occ(i, 4, "Error: Cannot find module 'yaml'", { edgeId: `e${i}` })],
    });
  }

  // 另一条 error 只在 2 局（跨文件 ⇒ 只有 same-error，没有 same-file）
  const err2 = topic('error', 'TypeError: undefined is not a function', []);
  for (const i of [19, 20]) {
    add(i, {
      ...err2,
      occurrences: [occ(i, 5, 'TypeError: undefined is not a function', { edgeId: `x${i}` })],
    });
  }

  // 软主题：21/22 只共享 2 个判别性 term（无共享硬主题）⇒ 软边
  const termA = topic('term', '端点对', []);
  const termB = topic('term', '判别性', []);
  for (const i of [21, 22]) {
    add(i, { ...termA, occurrences: [occ(i, 6, '端点对')] });
    add(i, { ...termB, occurrences: [occ(i, 7, '判别性')] });
  }

  // 只有 1 个共享软主题 ⇒ 不够，不建边
  const termC = topic('term', '唯一交集', []);
  for (const i of [23, 24]) add(i, { ...termC, occurrences: [occ(i, 8, '唯一交集')] });

  // 判别性不通过（df > 上限）的硬主题：不建边，也不能进候选
  const wide = topic('domain', 'example.com', []);
  for (const i of [25, 26, 27, 28, 29, 30, 31, 32]) add(i, { ...wide, occurrences: [occ(i, 9, 'example.com')] });

  // 噪声：随机软/硬主题（大部分只出现 1 局以上、部分成对），覆盖更多「共享但不够」的组合
  const rnd = mulberry32(20261128);
  for (let k = 0; k < 26; k += 1) {
    const kind = k % 3 === 0 ? 'goal' : k % 3 === 1 ? 'term' : 'scaffold';
    const t = topic(kind, `noise-${kind}-${k}`, []);
    for (let i = 0; i < n; i += 1) {
      if (rnd() < 0.12) add(i, { ...t, occurrences: [occ(i, 10 + k, t.key)] });
    }
  }
  return eps;
}

// ---------------------------------------------------------------------------
// 语料 B：稠密 —— 候选登记代价 > C(N,2)，必须自动回退全量
// ---------------------------------------------------------------------------

function denseCorpus() {
  topicSeq = 0;
  const n = 100;
  const eps = [];
  for (let i = 0; i < n; i += 1) eps.push(mkEpisode(`ep-${String(i + 1).padStart(8, '0')}`, i));
  const bash = topic('tool', 'bash', []);
  for (let i = 0; i < n; i += 1) eps[i].topics.push({ ...bash, occurrences: [occ(i, 1, 'bash')] });
  // 120 个硬主题 × df=10（判别性上限正好 10）⇒ Σ C(10,2) = 5400 > C(100,2) = 4950
  for (let k = 0; k < 120; k += 1) {
    const t = topic('repo', `dense/${k}`, []);
    for (let m = 0; m < 10; m += 1) {
      const i = (k * 7 + m * 11) % n;
      eps[i].topics.push({ ...t, occurrences: [occ(i, 2 + m, t.key)] });
    }
  }
  return eps;
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

const INF = { maxLinksPerEpisode: Infinity };

test('P1-2: 端点对限定 vs 全量两两 —— 边集合逐条相等（maxLinksPerEpisode=Infinity）', () => {
  const episodes = mainCorpus();
  const scoped = buildLinks({ episodes, options: INF });
  const full = buildLinks({ episodes, options: { ...INF, pairStrategy: 'full' } });

  assert.ok(full.links.length > 0, 'fixture 必须真的产边，否则等价性测试没有覆盖面');
  assertSameLinkSet(scoped.links, full.links, 'scoped vs full');
  assert.deepEqual(scoped.mentions, full.mentions, 'mention 与配对范围无关');

  // 三类边都要出现，证明覆盖到了各自的生成路径
  const kinds = new Set(scoped.links.map((l) => l.kind));
  for (const k of ['shared-topic', 'same-error', 'same-file']) assert.ok(kinds.has(k), `fixture 缺 ${k} 边`);
  // 强一档：顺序也一致（不是要求，但本实现保持了旧顺序，回退时能立刻看出来）
  assert.deepEqual(scoped.links.map(linkKey), full.links.map(linkKey), '顺序亦一致');
});

test('P1-2: 独立实现核对 —— 朴素全对 oracle 的 shared-topic 边与默认输出逐条相同', () => {
  for (const [label, episodes] of [['稀疏语料', mainCorpus()], ['稠密语料', denseCorpus()]]) {
    const got = buildLinks({ episodes, options: INF }).links.filter((l) => l.kind === 'shared-topic');
    const want = naiveSharedTopicLinks(episodes);
    assert.ok(want.length > 0, `${label}：oracle 必须产边`);
    assertSameLinkSet(got, want, `${label} shared-topic vs oracle`);
  }
});

/** 测试自己按契约算候选对数（不读被测实现的内部结构）。 */
function expectedCandidatePairs(episodes) {
  const n = episodes.length;
  const holders = new Map(); // topicId -> {kind, ids:Set}
  for (const ep of episodes) {
    for (const t of ep.topics ?? []) {
      if (!t?.id) continue;
      if (!holders.has(t.id)) holders.set(t.id, { kind: t.kind, ids: new Set() });
      holders.get(t.id).ids.add(ep.id);
    }
  }
  const pairs = new Set();
  const softCount = new Map();
  const keyOf = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  for (const [, t] of holders) {
    const ids = [...t.ids];
    const df = ids.length;
    if (df < 2) continue;
    if (HARD_KINDS.has(t.kind) && t.kind !== 'error') {
      if (!eligibleOf(df, n)) continue;
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) pairs.add(keyOf(ids[i], ids[j]));
      }
    } else if (SOFT_KINDS.has(t.kind)) {
      if (!eligibleOf(df, n)) continue;
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const k = keyOf(ids[i], ids[j]);
          softCount.set(k, (softCount.get(k) ?? 0) + 1);
        }
      }
    }
  }
  for (const [k, c] of softCount) if (c >= 2) pairs.add(k);
  return pairs.size;
}

test('P1-2: 候选范围 tombstone —— 只枚举可能产边的端点对（删掉过滤 ⇒ 红）', () => {
  const episodes = mainCorpus();
  const out = buildLinks({ episodes, options: { ...INF, diagnostics: true } });
  const { scan } = out;
  assert.ok(scan, 'diagnostics 必须返回 scan');
  assert.equal(scan.requested, 'scoped', '默认口径 = 端点对限定');

  const n = episodes.length;
  assert.equal(scan.pairSpace, (n * (n - 1)) / 2, 'pairSpace = C(N,2)');
  assert.equal(scan.candidatePairs, expectedCandidatePairs(episodes), '候选对数 = 契约算出的对数');
  assert.equal(scan.pairsExamined, scan.candidatePairs, '实际过判据的对数 = 候选对数');
  assert.equal(scan.effective, 'scoped', '稀疏语料应走候选枚举而不是全量回退');

  // 核心判据：枚举量必须**显著**小于全量。把端点评选换成两两全量 ⇒ pairsExamined === pairSpace ⇒ 这里红。
  assert.ok(scan.pairsExamined < scan.pairSpace, `端点对限定必须少于全量（${scan.pairsExamined} vs ${scan.pairSpace}）`);
  assert.ok(
    scan.pairsExamined < scan.pairSpace / 2,
    `候选量应远小于全量（${scan.pairsExamined} vs ${scan.pairSpace}）`,
  );

  // 对照：显式走全量口径时，枚举量就是全量
  const full = buildLinks({ episodes, options: { ...INF, pairStrategy: 'full', diagnostics: true } });
  assert.equal(full.scan.effective, 'full');
  assert.equal(full.scan.pairsExamined, full.scan.pairSpace);
  assert.equal(full.scan.candidatePairs, null);
});

test('P1-2: 稠密语料 ⇒ 自动回退全量，输出与两种口径都一致', () => {
  const episodes = denseCorpus();
  const scoped = buildLinks({ episodes, options: { ...INF, diagnostics: true } });
  const full = buildLinks({ episodes, options: { ...INF, pairStrategy: 'full' } });
  assert.equal(scoped.scan.effective, 'full', 'Σ C(df,2) > C(N,2) ⇒ 走全量更省');
  assert.equal(scoped.scan.pairsExamined, scoped.scan.pairSpace);
  assertSameLinkSet(scoped.links, full.links, '稠密语料 scoped(fallback) vs full');
  // 与独立 oracle 也对得上（防止"两条路一起错"）
  assertSameLinkSet(
    scoped.links.filter((l) => l.kind === 'shared-topic'),
    naiveSharedTopicLinks(episodes),
    '稠密语料 shared-topic vs oracle',
  );
});

test('P1-2: 默认每局上限（k=16）下两种口径输出仍相等', () => {
  const episodes = mainCorpus();
  const a = buildLinks({ episodes });
  const b = buildLinks({ episodes, options: { pairStrategy: 'full' } });
  assert.equal(DEFAULT_LINK_OPTIONS.maxLinksPerEpisode, 16, '默认上限仍取 limits.mjs 的唯一来源');
  assertSameLinkSet(a.links, b.links, 'capped scoped vs full');
  assert.deepEqual(a.stats, b.stats, 'stats 形状与数字一致');
});

test('P1-2: 同一 id 重复的棋谱（畸形入参）——两种口径仍等价', () => {
  const eps = mainCorpus();
  const dup = { ...eps[0] };
  const input = [dup, ...eps]; // eps[0] 出现两次
  const scoped = buildLinks({ episodes: input, options: INF });
  const full = buildLinks({ episodes: input, options: { ...INF, pairStrategy: 'full' } });
  assertSameLinkSet(scoped.links, full.links, 'duplicate id scoped vs full');
});

test('P1-2: 确定性 —— 同输入两次同输出；空/单局不抛', () => {
  const episodes = mainCorpus();
  const one = buildLinks({ episodes, options: INF });
  const two = buildLinks({ episodes, options: INF });
  assert.deepEqual(one.links, two.links);
  assert.deepEqual(one.mentions, two.mentions);

  const empty = buildLinks({ episodes: [], options: { diagnostics: true } });
  assert.deepEqual(empty.links, []);
  assert.equal(empty.scan.pairsExamined, 0);
  assert.equal(empty.scan.pairSpace, 0);

  const single = buildLinks({ episodes: [episodes[0]], options: INF });
  assert.deepEqual(single.links, []);
});
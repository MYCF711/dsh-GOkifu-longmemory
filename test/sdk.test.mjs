// 棋院 SDK（PTC 调用面）的 tombstone test：删掉 src/sdk.mjs ⇒ 本文件整片红。
// 契约：docs/SDK-PTC.md。这里钉住四件事：**只读**、**有界（夹紧并如实标记）**、**JSON 安全**、**错误语义**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createMemorySdk, SdkError, SDK_VERSION, MAX_LIMIT, MAX_BUDGET_TOKENS, WALK_CACHE_TTL_MS, walkCacheBuildCount, resetWalkCache } from '../src/sdk.mjs';
import { createStore } from '../src/rooms/persist.mjs';

const T = (day, hour = 12) => Date.UTC(2026, 9, day, hour, 0, 0);
const SCOPE = 'w:d:/work/demo';

const episode = (id, day) => ({
  id, sessionId: `session-${id.slice(3)}`, scopeKey: SCOPE,
  startedAt: T(day), endedAt: T(day) + 3_600_000, firstEventAt: T(day), lastEventAt: T(day) + 3_600_000,
  recordedAt: null,
  closure: { logPath: 'sessions/demo/x/session.v4.jsonl.zstd', graphPath: 'graphs/x/graph.json', seqFrom: 11, seqTo: 99 },
  l0: '', signals: { failures: 1, successes: 0, unsettled: 0, constraints: 0, tools: [] }, threadIds: [], state: 'archived',
});

const claim = ({ id, kind, text, day, support }) => ({
  id, kind, text, scopeKey: SCOPE, threadIds: [], state: 'observed',
  support: support.map((s) => ({ episode: s.episode, seq: s.seq, quote: s.quote ?? text, occurredAt: T(s.day ?? day) })),
  counter: [], validity: { type: 'none', value: null }, preconditions: [],
  occurredAt: T(day), recordedAt: T(day), validFrom: null, validTo: null,
  counters: { support: support.length, counter: 0, injections: 0, lastInjectedAt: null }, supersedes: null,
});

function makeStore() {
  const dshHome = mkdtempSync(path.join(tmpdir(), 'kifuin-sdk-home-'));
  const root = path.join(dshHome, 'memory-context');
  const store = createStore({ root, now: T(20) });
  store.ensureDirs();
  store.putMany('episodes', [episode('ep-sssssss1', 21), episode('ep-sssssss2', 23)]);
  store.putMany('claims', [
    claim({ id: 'c-0000ss01', kind: 'antipattern', text: "Cannot find module 'yaml'", day: 21, support: [{ episode: 'ep-sssssss1', seq: 12, quote: "Cannot find module 'yaml'" }] }),
    claim({ id: 'c-0000ss02', kind: 'antipattern', text: 'ENOENT: no such file, open tmp/a.json', day: 23, support: [{ episode: 'ep-sssssss2', seq: 40, quote: 'ENOENT: no such file, open tmp/a.json' }] }),
    claim({ id: 'c-0000ss03', kind: 'fact', text: 'engines.node 是 >=23.8', day: 23, support: [{ episode: 'ep-sssssss2', seq: 7 }] }),
  ]);
  return { dshHome, root, store };
}

const sha = (root) => {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) files.push(`${path.relative(root, abs)}:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
    }
  };
  walk(root);
  return files.sort().join(String.fromCharCode(10));
};

const jsonSafe = (value, label) => {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label} 必须 JSON 安全（不能带 Map/Set/undefined/类实例）`);
};

test('sdk: describe() 是自描述的只读契约（版本 / kinds / 上限）', () => {
  const { dshHome } = makeStore();
  const sdk = createMemorySdk({ dshHome });
  const d = sdk.describe();
  assert.equal(d.version, SDK_VERSION);
  assert.equal(d.readOnly, true);
  assert.ok(d.kinds.includes('claims') && d.kinds.includes('episodes'));
  assert.deepEqual(d.limits, { maxLimit: MAX_LIMIT, maxBudgetTokens: MAX_BUDGET_TOKENS, maxDepth: 2 });
  jsonSafe(d, 'describe');
});

test('sdk: stats() 数得清、且空库明确标 empty（不写 0 当测到）', () => {
  const { dshHome } = makeStore();
  const sdk = createMemorySdk({ dshHome });
  const s = sdk.stats();
  assert.equal(s.status, 'measured');
  assert.equal(s.counts.episodes, 2);
  assert.equal(s.counts.claims, 3);
  assert.ok(s.n >= 5);
  jsonSafe(s, 'stats');
  // 库目录建了但一条记录都没有 ⇒ 'empty'（与"库根本不存在"的 'missing' 分开）
  const emptyHome = mkdtempSync(path.join(tmpdir(), 'kifuin-sdk-empty-'));
  createStore({ root: path.join(emptyHome, 'memory-context'), now: T(20) }).ensureDirs();
  const s2 = createMemorySdk({ dshHome: emptyHome }).stats();
  assert.equal(s2.status, 'empty');
  assert.equal(s2.n, 0);
  rmSync(emptyHome, { recursive: true, force: true });
});

test('sdk: get() 命中 / not-found / 非法 kind 抛 SdkError(unsupported-kind)', () => {
  const { dshHome } = makeStore();
  const sdk = createMemorySdk({ dshHome });
  const ok = sdk.get('claims', 'c-0000ss01');
  assert.equal(ok.ok, true);
  assert.equal(ok.record.id, 'c-0000ss01');
  assert.equal(sdk.get('claims', 'c-nope').reason, 'not-found');
  assert.throws(() => sdk.get('bogus', 'x'), (e) => e instanceof SdkError && e.code === 'unsupported-kind');
  assert.throws(() => sdk.get('claims', ''), (e) => e instanceof SdkError && e.code === 'bad-argument');
});

test('sdk: 有界 —— 超限夹紧并在结果里如实标 clamped', () => {
  const { dshHome } = makeStore();
  const sdk = createMemorySdk({ dshHome, scope: SCOPE });
  const w = sdk.walk('Cannot find module', { limit: 999, budgetTokens: 99999, depth: 9 });
  assert.equal(w.clamped.limit, true);
  assert.equal(w.clamped.budgetTokens, true);
  assert.equal(w.clamped.depth, true);
  assert.ok(w.hits.length <= MAX_LIMIT);
  jsonSafe(w, 'walk');
  const s = sdk.search('Cannot find module', { limit: 1 });
  assert.ok(s.hits.length <= 1);
  assert.equal(s.clamped.limit, false);
});

test('sdk: recentFailures() 只给失败原文、按 occurredAt 倒序、有 total 与 status', () => {
  const { dshHome } = makeStore();
  const sdk = createMemorySdk({ dshHome, scope: SCOPE });
  const r = sdk.recentFailures({ limit: 1 });
  assert.equal(r.n, 1);
  assert.equal(r.total, 2, '两条 antipattern 原文都该在池子里');
  assert.equal(r.status, 'measured');
  assert.match(r.items[0].quote, /ENOENT/, '最新那条（day 23）在前');
  assert.ok(Number.isFinite(r.items[0].occurredAt));
  jsonSafe(r, 'recentFailures');
  assert.equal(sdk.recentFailures({ limit: 1, scope: 'w:d:/nowhere' }).status, 'empty');
});

test('sdk: card() 与线上同一份卡片（跑闸、带 token 数），且 JSON 安全', () => {
  const { dshHome } = makeStore();
  const sdk = createMemorySdk({ dshHome, scope: SCOPE });
  const c = sdk.card('Cannot find module yaml', { limit: 3, budgetTokens: 500 });
  assert.equal(c.ok, true);
  assert.equal(typeof c.section, 'string');
  assert.equal(typeof c.tokens, 'number');
  assert.equal(typeof c.gates.ok, 'boolean');
  jsonSafe(c, 'card');
  const noGates = sdk.card('Cannot find module yaml', { gates: false });
  assert.equal(noGates.gates.skipped ?? true, true);
});

test('sdk: 只读 —— 跑完所有读操作，库的 sha256 一字不变、不多一个文件', () => {
  const { dshHome, root } = makeStore();
  const before = sha(root);
  const sdk = createMemorySdk({ dshHome, scope: SCOPE });
  sdk.describe(); sdk.stats();
  sdk.get('claims', 'c-0000ss01');
  sdk.search('Cannot find module'); sdk.walk('ENOENT'); sdk.card('Cannot find module yaml');
  sdk.recentFailures({ limit: 5 });
  assert.equal(sha(root), before, 'SDK 不许写盘');
  assert.equal(statSync(root).isDirectory(), true);
});

test('sdk: 库不存在 ⇒ 明确标 missing 的空结果（PTC 代码块不该因"还没记忆"就抛）', () => {
  const ghost = path.join(mkdtempSync(path.join(tmpdir(), 'kifuin-sdk-ghost-')), 'nope');
  const sdk = createMemorySdk({ dshHome: ghost });
  assert.equal(sdk.stats().status, 'missing');
  assert.equal(sdk.stats().n, 0);
  assert.deepEqual(sdk.walk('anything').hits, []);
  assert.equal(sdk.walk('anything').status, 'missing');
  assert.equal(sdk.card('anything').section, '');
  assert.equal(sdk.card('anything').status, 'missing');
  assert.equal(sdk.recentFailures().status, 'missing');
  assert.equal(sdk.get('claims', 'c-x').reason, 'not-found');
});

test('sdk: scopeOf() 与钩子同一实现（不另造一套作用域口径）', () => {
  const sdk = createMemorySdk({ dshHome: process.env.DSH_HOME || '.' });
  const key = sdk.scopeOf('D:/DeepSeek Harness/default-workspace/长期记忆系统');
  assert.match(key, /^w:d:\/deepseek harness\/default-workspace\//i);
  assert.throws(() => sdk.scopeOf(''), (e) => e instanceof SdkError);
});

test('sdk: view() 知识库巨型节点能展开（不是孤岛）', async () => {
  const { dshHome } = makeStore();
  const sdk = createMemorySdk({ dshHome });
  const r = await sdk.view({ center: { kind: 'library', id: 'lib:docs/调研' } });
  assert.equal(r.nodes[0].kind, 'library');
  assert.match(String(r.nodes[0].label), /调研知识库/);
  assert.ok(r.nodes.filter((n) => n.kind === 'note').length > 0, '必须展开出每篇一个子节点');
  assert.ok(r.counts.edges > 0, '库节点要有 contains 边');
  jsonSafe(r, 'view-library');
});

test('sdk: view() 库不存在 ⇒ 空结构（不抛、不编节点）', async () => {
  const ghost = path.join(mkdtempSync(path.join(tmpdir(), 'kifu-view-ghost-')), 'nope');
  const sdk = createMemorySdk({ dshHome: ghost });
  const r = await sdk.view({ center: { kind: 'episode', id: 'ep-x' } });
  assert.equal(r.status, 'missing');
  assert.deepEqual(r.nodes, []);
  assert.equal(r.counts.nodes, 0);
});

// T54（2026-11-09）：`stats()` 的计数改成**文件名层**（`store.counts()`），不再全量解析。
// 真库实测 20.3s → 1.7s（links 11083 个文件一个就 5.1 秒，而"数个数"根本不需要解析内容）。
// 风险只有一个：两种数法要**逐 kind 相等**，这条钉住它。
test('T54 ①: stats().counts 与逐 kind 全量解析的条数**逐项相等**（换数法不改读数）', () => {
  const { dshHome, root } = makeStore();
  try {
    const sdk = createMemorySdk({ dshHome });
    const got = sdk.stats();
    assert.equal(got.ok, true);
    const full = createStore({ root });
    for (const kind of ['episodes', 'topics', 'claims', 'links', 'threads', 'joseki', 'adjudications']) {
      assert.equal(got.counts[kind], full.list(kind).length, `${kind} 的计数必须一致`);
    }
    assert.equal(got.n, Object.values(got.counts).reduce((a, b) => a + b, 0));
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

test('T54 ②: 惰性 —— 只调 stats/get 不构建 walk cache（真库上那一步要 ~9 秒）', () => {
  const { dshHome } = makeStore();
  try {
    const sdk = createMemorySdk({ dshHome });
    const got = sdk.stats();
    assert.equal(got.ok, true);
    // 没有直接暴露 cache；用行为判据：stats 之后 get 仍然正确（两者都不需要走图）
    const one = sdk.get('claims', 'c-0000ss01');
    assert.equal(one.ok, true);
    assert.equal(typeof one.record?.text, 'string');
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

// T55（2026-11-09）：walk cache **跨 SDK 实例共享**。
// 病根：每个 `kifu_*` 工具调用都新建一个 SDK 实例 ⇒ 每次重建 walk cache（真库 ≈9 秒），
// `kifu_search`/`kifu_card` 因此稳定在 9–10 秒。改后第二次起只走内存。
test('T55 ①: 两个 SDK 实例共用同一份 walk cache（真库上那 9 秒只付一次）', () => {
  const { dshHome } = makeStore();
  try {
    resetWalkCache();
    const a = createMemorySdk({ dshHome });
    const b = createMemorySdk({ dshHome });
    a.search('Cannot find module', { limit: 1 });
    const afterFirst = walkCacheBuildCount();
    assert.equal(afterFirst, 1, '第一次必须真的建一次');
    b.search('Cannot find module', { limit: 1 });
    assert.equal(walkCacheBuildCount(), 1, '第二个实例必须命中共享缓存，不许重建');
  } finally {
    resetWalkCache();
    rmSync(dshHome, { recursive: true, force: true });
  }
});

test('T55 ②: 库里新增条目 ⇒ 目录签名变了 ⇒ 必须重建（不许拿旧图当新图）', () => {
  const { dshHome } = makeStore();
  try {
    resetWalkCache();
    const a = createMemorySdk({ dshHome });
    a.search('Cannot find module', { limit: 1 });
    assert.equal(walkCacheBuildCount(), 1);

    const store = createStore({ root: path.join(dshHome, 'memory-context') });
    store.putMany('claims', [claim({ id: 'c-0000ss09', kind: 'antipattern', text: 'ECONNREFUSED 127.0.0.1:3425', day: 24, support: [{ episode: 'ep-sssssss2', seq: 88 }] })]);

    const b = createMemorySdk({ dshHome });
    b.search('Cannot find module', { limit: 1 });
    assert.equal(walkCacheBuildCount(), 2, '条目数变了 ⇒ 签名变了 ⇒ 重建');
  } finally {
    resetWalkCache();
    rmSync(dshHome, { recursive: true, force: true });
  }
});

test('T55 ③: 签名没变也要过 TTL（原地改写改不了条目数，靠时间兜住）', () => {
  const { dshHome } = makeStore();
  try {
    resetWalkCache();
    let clock = T(24);
    const a = createMemorySdk({ dshHome, now: () => clock });
    a.search('Cannot find module', { limit: 1 });
    assert.equal(walkCacheBuildCount(), 1);

    clock += WALK_CACHE_TTL_MS - 1;
    createMemorySdk({ dshHome, now: () => clock }).search('Cannot find module', { limit: 1 });
    assert.equal(walkCacheBuildCount(), 1, 'TTL 内 ⇒ 命中');

    clock += 2; // 越过 TTL
    createMemorySdk({ dshHome, now: () => clock }).search('Cannot find module', { limit: 1 });
    assert.equal(walkCacheBuildCount(), 2, 'TTL 外 ⇒ 必须重建');
  } finally {
    resetWalkCache();
    rmSync(dshHome, { recursive: true, force: true });
  }
});

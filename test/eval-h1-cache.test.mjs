// T169 · `runH1` 接受 walk 缓存 —— 结构性还债的 tombstone test。
//
// 背景：A1 的每个信号都跑 walk → buildMemoryCard → runGates，三者拿不到缓存时各自 `store.list()`
// 四类（真库 ≈1.02 万个小 JSON）。176 个信号 ⇒ 180 万次文件读（Windows 单文件 ~1.1 ms）≈ 46 分钟，
// T167 只能靠"读穿缓存"兜住。这里锁住：**缓存可选、复用后 A1 逐位不变**。
//
// 覆盖：
//   ① 回归守卫：同一份库跑两遍（默认路径）⇒ 除墙钟外逐字节相同
//   ② 对拍：不传缓存 vs `cache:false`（改动前的取数方式）⇒ A1 的分子/分母/数值逐位相同
//   ③ 三种注入形状：现成 cache 对象 / 工厂函数 / 默认自建 ⇒ 数字一致
//   ④ `resolveWalkCache` 的边界：false/对象/函数/无 walkRoom/工厂抛错 ⇒ 不抛、退回逐次读
//   ⑤ A1 的"定义"没变：perSignal 条数 = 信号数，分子分母自洽
//
// 夹具全部在 os.tmpdir；不写 <DSH_HOME>；零模型调用。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { runH1, resolveWalkCache } from '../scripts/eval.mjs';
import { createStore } from '../src/rooms/persist.mjs';
import { createWalkCache } from '../src/rooms/walk.mjs';

const T0 = 1_700_000_000_000;
const ARCHIVE_TS = 1_709_000_000_000;
const TOPIC_KEY = 'src/rooms/x.mjs';
const MISSING_FILE = 'docs/not-there.md';

function zframe(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

function writeSessionLog(root, { sid, events }) {
  const dir = path.join(root, 'sessions', '--D-work-demo--', sid);
  mkdirSync(dir, { recursive: true });
  const header = { type: 'session', version: 4, id: sid, createdAt: T0, cwd: 'D:\\work\\demo', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' };
  writeFileSync(
    path.join(dir, 'session.v4.jsonl.zstd'),
    Buffer.concat([zframe(`${JSON.stringify(header)}\n`), zframe(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`)]),
  );
  return `sessions/--D-work-demo--/${sid}/session.v4.jsonl.zstd`;
}

function writeGraph(root, { sid, failures }) {
  const dir = path.join(root, 'chess-context', 'sessions', sid);
  mkdirSync(dir, { recursive: true });
  const edges = {};
  failures.forEach((f, i) => {
    edges[`e${i + 1}`] = {
      id: `e${i + 1}`, from: 'n1', to: 'n2', action: 'bash(command=node scripts/x.mjs)', result: 'failure',
      errorSnippet: f, evidence: { start: i + 1 }, ts: T0 + (i + 1) * 1_000,
    };
  });
  writeFileSync(path.join(dir, 'graph.json'), `${JSON.stringify({
    version: 1, sessionId: sid, createdAt: T0, updatedAt: T0 + 9_000, nextNode: 3, nextEdge: failures.length + 1,
    nodes: { n1: { id: 'n1', kind: 'user', seq: 1, text: '跑一下', ts: T0 + 1_000 }, n2: { id: 'n2', kind: 'agent', seq: 2, turn: 1, ts: T0 + 2_000 } },
    edges, order: ['n1', 'n2'], stateIndex: {}, rootUserNodeIds: ['n1'], checkpointSeq: 2, foldCount: 0,
  }, null, 2)}\n`);
  return `chess-context/sessions/${sid}/graph.json`;
}

function putEpisode(storeRoot, { id, startedAt, scopeKey, logPath, graphPath }) {
  const store = createStore({ root: storeRoot, now: ARCHIVE_TS });
  store.ensureDirs();
  store.put('episodes', {
    id,
    sessionId: `session-${id.replace(/^ep-/, '')}-0000-4000-8000-000000000000`,
    scopeKey,
    startedAt,
    endedAt: startedAt + 600_000,
    firstEventAt: startedAt + 1_000,
    lastEventAt: startedAt + 500_000,
    recordedAt: ARCHIVE_TS,
    timeSource: 'event',
    delegationDepth: 0,
    closure: { logPath, graphPath, seqFrom: 1, seqTo: 9, eventCount: 9, nodeIds: [], edgeIds: [] },
    l0: '', l1: '',
    signals: { failures: 1, successes: 0, unsettled: 0, constraints: 0, tools: ['bash'] },
    threadIds: [],
    state: 'archived',
    sourceRoot: 'DSH_HOME',
    sourceStatus: 'present',
    topics: [{ id: 't:file:11111111', kind: 'file', key: TOPIC_KEY, count: 1, occurrences: [{ seq: 3, quote: `node ${TOPIC_KEY}`, occurredAt: startedAt + 3_000 }] }],
  }, { at: ARCHIVE_TS });
}

function putTopic(storeRoot, scopeKey) {
  const store = createStore({ root: storeRoot, now: ARCHIVE_TS });
  store.put('topics', {
    id: 't:file:11111111', kind: 'file', key: TOPIC_KEY, df: 2,
    firstSeenAt: T0, lastSeenAt: T0 + 10_000, scopeKey,
  }, { at: ARCHIVE_TS });
}

function putClaim(storeRoot, scopeKey, { id, validity = null, text = `${TOPIC_KEY} 在干净环境会报 Cannot find module` } = {}) {
  const store = createStore({ root: storeRoot, now: ARCHIVE_TS });
  store.put('claims', {
    id,
    kind: 'antipattern',
    text,
    scopeKey,
    threadIds: [],
    state: 'observed',
    support: [{ episode: 'ep-aaaaaaa1', seq: 3, quote: 'Cannot find module', occurredAt: T0 + 3_000 }],
    counter: [],
    validity: validity ?? { type: 'none', value: null },
    preconditions: [],
    occurredAt: T0 + 3_000,
    recordedAt: ARCHIVE_TS,
    counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null },
    supersedes: null,
  }, { at: ARCHIVE_TS });
}

/**
 * 夹具：2 局 + 1 主题 + 2 条 claim（其中 1 条带 validity 指向不存在的文件 ⇒ 走 stale 分支）。
 * 带 validity 的那条是 A1 的**针对性信号**来源 —— 没有它 A1 会空转（0/0），对拍就没有意义。
 */
function buildFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-h1cache-'));
  const storeRoot = path.join(root, 'memory-context');
  const scopeKey = `w:${root.replace(/\\/g, '/')}`;
  const sids = ['session-aaaaaaa1-0000-4000-8000-000000000001', 'session-bbbbbbb2-0000-4000-8000-000000000002'];
  const events = [
    { type: 'user/message', seq: 1, time: T0 + 1_000, data: { content: [{ type: 'text', text: '跑一下测试' }] } },
    { type: 'tool/call', seq: 2, time: T0 + 2_000, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"node scripts/x.mjs"}' } },
    { type: 'tool/result', seq: 3, time: T0 + 3_000, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } } },
  ];
  const log1 = writeSessionLog(root, { sid: sids[0], events });
  const log2 = writeSessionLog(root, { sid: sids[1], events });
  const graph1 = writeGraph(root, { sid: sids[0], failures: ["Error: Cannot find module 'yaml'"] });
  const graph2 = writeGraph(root, { sid: sids[1], failures: ["Error: Cannot find module 'yaml'", 'Error: EPERM: operation not permitted'] });

  putEpisode(storeRoot, { id: 'ep-aaaaaaa1', startedAt: T0 + 10_000, scopeKey, logPath: log1, graphPath: graph1 });
  putEpisode(storeRoot, { id: 'ep-bbbbbbb2', startedAt: T0 + 20_000, scopeKey, logPath: log2, graphPath: graph2 });
  putTopic(storeRoot, scopeKey);
  putClaim(storeRoot, scopeKey, { id: 'c-11111111' });
  putClaim(storeRoot, scopeKey, { id: 'c-22222222', validity: { type: 'file', value: MISSING_FILE }, text: `${TOPIC_KEY} 的产物已过期` });
  const store = createStore({ root: storeRoot, now: ARCHIVE_TS });
  store.writeManifest({ at: ARCHIVE_TS });
  return { root, storeRoot, scopeKey };
}

/** 去掉墙钟字段：A1 的 elapsedMs 必然不同，其余必须逐位相同。 */
function stable(report) {
  const { elapsedMs, ...rest } = report;
  return rest;
}

let fixture;
test.before(() => {
  fixture = buildFixture();
});
test.after(() => {
  if (fixture?.root) rmSync(fixture.root, { recursive: true, force: true });
});

const baseOpts = () => ({ storeRoot: fixture.storeRoot, workspace: fixture.root, now: ARCHIVE_TS, signals: 3 });

// ---------------------------------------------------------------------------
// ① 回归守卫
// ---------------------------------------------------------------------------

test('h1 缓存: 同一份库跑两遍（默认路径）除墙钟外逐字节相同', async () => {
  const a = await runH1(baseOpts());
  const b = await runH1(baseOpts());
  assert.deepEqual(stable(b), stable(a), '两次运行的报告必须完全一致（默认 = 每次自建一份缓存）');
  assert.equal(typeof a.elapsedMs, 'number');
  assert.ok(a.signals > 0, '信号集不能为空，否则这条断言是空的');
});

// ---------------------------------------------------------------------------
// ② 对拍：不传缓存 vs cache:false（改动前的取数方式）
// ---------------------------------------------------------------------------

test('h1 缓存: 不传缓存 vs cache:false ⇒ A1 分子/分母/数值逐位相同', async () => {
  const withCache = await runH1(baseOpts());
  const without = await runH1({ ...baseOpts(), cache: false });
  assert.deepEqual(stable(without), stable(withCache), 'A1 全字段（含 perSignal）必须逐位相同');

  // 再单独钉住 A1 的分子/分母/主值（ledger-check / metrics-guard 按这几个字段读）
  assert.equal(withCache.injected, without.injected, '分母：注入条目数');
  assert.equal(withCache.staleInjected, without.staleInjected, '分子：stale 条目数');
  assert.equal(withCache.staleTransferRate, without.staleTransferRate, '主值：staleTransferRate（闸前）');
  assert.equal(withCache.postGateInjected, without.postGateInjected, '分母：闸后仍然注入的条目数');
  assert.equal(withCache.postGateStale, without.postGateStale, '分子：闸后 stale 数');
  assert.equal(withCache.postGateStaleRate, without.postGateStaleRate, '主值：postGateStaleRate');
  assert.deepEqual(withCache.validityCoverage, without.validityCoverage, 'validity 覆盖率（分子/分母/比值）');
  assert.deepEqual(withCache.signalsByKind, without.signalsByKind, '信号集构成（topic/validity 条数）');
  assert.equal(withCache.tokensTotal, without.tokensTotal, '卡片 token 合计');

  // 这份快照给主人看：两行 JSON 应当一模一样
  const pick = (r) => JSON.stringify({
    injected: r.injected, staleInjected: r.staleInjected, staleTransferRate: r.staleTransferRate,
    postGateInjected: r.postGateInjected, postGateStale: r.postGateStale, postGateStaleRate: r.postGateStaleRate,
    validityCoverage: r.validityCoverage, signals: r.signals, tokensTotal: r.tokensTotal,
  });
  console.log(`[T169] runH1 默认（自建缓存）: ${pick(withCache)}`);
  console.log(`[T169] runH1 cache:false      : ${pick(without)}`);
  assert.equal(pick(without), pick(withCache));
});

// ---------------------------------------------------------------------------
// ③ 三种注入形状
// ---------------------------------------------------------------------------

test('h1 缓存: 现成 cache 对象 / 工厂函数 / 默认自建 —— 三者数字一致', async () => {
  const store = createStore({ root: fixture.storeRoot });
  const shared = createWalkCache(store);
  const viaObject = await runH1({ ...baseOpts(), cache: shared });
  const viaFactory = await runH1({ ...baseOpts(), cache: (s) => createWalkCache(s) });
  const viaDefault = await runH1(baseOpts());
  assert.deepEqual(stable(viaObject), stable(viaDefault), '传现成缓存对象 == 默认自建');
  assert.deepEqual(stable(viaFactory), stable(viaDefault), '传工厂 == 默认自建');
});

// ---------------------------------------------------------------------------
// ④ resolveWalkCache 的边界（纯函数）
// ---------------------------------------------------------------------------

test('h1 缓存: resolveWalkCache 边界 —— false/对象/函数/无 walkRoom/工厂抛错', () => {
  const fakeStore = { list: () => [] };
  const obj = { claims: [] };
  assert.equal(resolveWalkCache(fakeStore, null, false), null, 'false ⇒ 不用缓存');
  assert.equal(resolveWalkCache(fakeStore, null, null), null, 'null ⇒ 不用缓存');
  assert.equal(resolveWalkCache(fakeStore, null, obj), obj, '对象 ⇒ 原样返回');
  assert.equal(resolveWalkCache(fakeStore, null, () => obj), obj, '函数 ⇒ 当工厂调用');
  assert.equal(resolveWalkCache(fakeStore, null, undefined), null, '没有 walkRoom 且未注入 ⇒ null（退回逐次读）');
  assert.equal(resolveWalkCache(fakeStore, null, () => { throw new Error('boom'); }), null, '工厂抛错 ⇒ 退回逐次读，不炸');
  const real = resolveWalkCache(fakeStore, { createWalkCache: () => obj }, undefined);
  assert.equal(real, obj, '默认走 walkRoom.createWalkCache');
});

// ---------------------------------------------------------------------------
// ⑤ A1 的"定义"没变
// ---------------------------------------------------------------------------

test('h1 缓存: A1 的定义不变 —— perSignal 条数 = 信号数，分子分母自洽', async () => {
  const r = await runH1(baseOpts());
  assert.equal(r.perSignal.length, r.signals, 'perSignal 每个信号一条');
  assert.equal(r.signalsByKind.topic + r.signalsByKind.validity, r.signals);
  // 主值 = 分子/分母（分母 0 ⇒ null，不编造 0）
  if (r.injected > 0) assert.equal(r.staleTransferRate, r.staleInjected / r.injected);
  else assert.equal(r.staleTransferRate, null);
  if (r.postGateInjected > 0) assert.equal(r.postGateStaleRate, r.postGateStale / r.postGateInjected);
  else assert.equal(r.postGateStaleRate, null);
  // 闸后 ⊆ 闸前
  assert.ok(r.postGateInjected <= r.injected);
  assert.ok(r.postGateStale <= r.staleInjected);
  assert.equal(r.validityCoverage.withValidity >= 1, true, '夹具里必须有带 validity 的条目，否则覆盖率恒为空转');
});

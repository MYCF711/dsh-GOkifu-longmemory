// T174 · `createWalkCache` 支持"从已读记录构建" —— tombstone test。
//
// 背景：A1 先 `read('claims')` / `read('topics')` 各读一遍全量，紧接着 `createWalkCache(store)`
// 又把同样四类重读一遍（真库 ≈1.02 万个小 JSON，~2.4s）。T174 让缓存可以吃调用方已经读到的记录。
//
// 覆盖：
//   ① 回归守卫：不传 records ⇒ 与改动前的 `createWalkCache(store)` 逐字节相同（数组/索引/get 全 deepEqual）
//   ② 传 records ⇒ **不再读盘**（用计数 store 断言 list 调用次数）
//   ③ 口径一致：records 里的坏条目/无 id 条目被同样丢掉（与 store 路径一致，不许让 walk 多出候选）
//   ④ 四类全覆盖时 store 可以传 null；覆盖不全且无 store ⇒ 返回 null（与改动前一致）
//   ⑤ 行为一致：同一份数据，store 建 vs records 建 ⇒ `walkFromSignals` 结果 deepEqual
//
// 夹具全部在 os.tmpdir；不写 <DSH_HOME>；零模型调用。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createWalkCache, walkFromSignals, WALK_CACHE_KINDS } from '../src/rooms/walk.mjs';
import { createStore } from '../src/rooms/persist.mjs';

const T0 = 1_700_000_000_000;
const ARCHIVE_TS = 1_709_000_000_000;
const TOPIC_KEY = 'src/rooms/x.mjs';

function buildStore() {
  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-walkcache-'));
  const storeRoot = path.join(root, 'memory-context');
  const scopeKey = `w:${root.replace(/\\/g, '/')}`;
  const store = createStore({ root: storeRoot, now: ARCHIVE_TS });
  store.ensureDirs();

  store.putMany('episodes', [
    { id: 'ep-aaaaaaa1', sessionId: 'session-aaaaaaa1', scopeKey, startedAt: T0 + 10_000, endedAt: T0 + 600_000, state: 'archived' },
    { id: 'ep-bbbbbbb2', sessionId: 'session-bbbbbbb2', scopeKey, startedAt: T0 + 20_000, endedAt: T0 + 610_000, state: 'archived' },
  ], { at: ARCHIVE_TS });
  store.putMany('topics', [
    { id: 't:file:11111111', kind: 'file', key: TOPIC_KEY, df: 2, firstSeenAt: T0, lastSeenAt: T0 + 10_000, scopeKey },
    { id: 't:file:22222222', kind: 'file', key: 'src/rooms/y.mjs', df: 1, firstSeenAt: T0, lastSeenAt: T0 + 10_000, scopeKey },
  ], { at: ARCHIVE_TS });
  store.putMany('links', [
    { id: 'l-11111111', a: { episode: 'ep-aaaaaaa1' }, b: { episode: 'ep-bbbbbbb2' }, kind: 'shared-topic', topics: ['t:file:11111111'], why: '同一文件', weight: 1, occurredAt: T0 + 5_000 },
  ], { at: ARCHIVE_TS });
  store.putMany('claims', [
    {
      id: 'c-11111111', kind: 'antipattern', text: `${TOPIC_KEY} 在干净环境会报 Cannot find module`, scopeKey, threadIds: [],
      state: 'observed', support: [{ episode: 'ep-aaaaaaa1', seq: 3, quote: 'Cannot find module', occurredAt: T0 + 3_000 }],
      counter: [], validity: { type: 'none', value: null }, preconditions: [], occurredAt: T0 + 3_000, recordedAt: ARCHIVE_TS,
      counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null }, supersedes: null,
    },
    {
      id: 'c-22222222', kind: 'fact', text: `node 版本 0.2.1`, scopeKey, threadIds: [],
      state: 'observed', support: [{ episode: 'ep-bbbbbbb2', seq: 5, quote: 'node 版本 0.2.1', occurredAt: T0 + 5_000 }],
      counter: [], validity: { type: 'none', value: null }, preconditions: [], occurredAt: T0 + 5_000, recordedAt: ARCHIVE_TS,
      counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null }, supersedes: null,
    },
  ], { at: ARCHIVE_TS });
  store.writeManifest({ at: ARCHIVE_TS });
  return { root, storeRoot, scopeKey, store };
}

/**
 * 缓存的可比数据面（去掉 `get` —— 每次构造都是新闭包，strict deepEqual 会按引用判不等）。
 * Map 转数组，保证顺序参与比较。
 */
const cacheData = (cache) => ({
  episodes: cache.episodes,
  topics: cache.topics,
  topicsByKey: [...cache.topicsByKey].map(([k, v]) => [k, v.map((r) => r.id)]),
  links: cache.links,
  claims: cache.claims,
});

/** 四条记录数组（与 store.list(kind).map(x => x.record) 等价）。 */
function recordsOf(store) {
  const out = {};
  for (const kind of WALK_CACHE_KINDS) out[kind] = store.list(kind).map((x) => x.record);
  return out;
}

let fx;
test.before(() => {
  fx = buildStore();
});
test.after(() => {
  if (fx?.root) rmSync(fx.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ① 回归守卫
// ---------------------------------------------------------------------------

test('walk 缓存: 不传 records ⇒ 与改动前的构造逐字节相同', () => {
  const a = createWalkCache(fx.store);
  const b = createWalkCache(fx.store, {});
  const c = createWalkCache(fx.store, { records: null });
  for (const [name, cache] of [['{}', b], ['{records:null}', c]]) {
    assert.deepEqual(cacheData(cache), cacheData(a), `${name} 必须与默认构造逐字节相同`);
    assert.equal(cache.get('claims', 'c-11111111')?.id, a.get('claims', 'c-11111111')?.id, `${name} 的 get 也要一致`);
  }
  assert.ok(a && Array.isArray(a.topics) && Array.isArray(a.claims));
  assert.ok(a.topicsByKey instanceof Map);
  // 四类条目数与 store 一致（口径没漂）
  for (const kind of WALK_CACHE_KINDS) {
    const expected = fx.store.list(kind).map((x) => x.record).filter((r) => r && typeof r.id === 'string' && r.id !== '');
    assert.equal(a[kind].length, expected.length, `${kind} 条数`);
  }
  assert.equal(a.get('claims', 'c-11111111')?.id, 'c-11111111');
});

// ---------------------------------------------------------------------------
// ② 传 records ⇒ 不再读盘
// ---------------------------------------------------------------------------

function countingStore(store) {
  const calls = [];
  return {
    calls,
    list(kind) {
      calls.push(kind);
      return store.list(kind);
    },
    get: (...args) => store.get(...args),
  };
}

test('walk 缓存: 传 records ⇒ 已给的四类一次都不读盘，只读缺的那几类', () => {
  const all = recordsOf(fx.store);
  const spy = countingStore(fx.store);

  const partial = createWalkCache(spy, { records: { claims: all.claims, topics: all.topics } });
  assert.deepEqual([...spy.calls].sort(), ['episodes', 'links'], '只该读没给的 episodes/links');
  assert.equal(partial.claims.length, all.claims.length);
  assert.equal(partial.topics.length, all.topics.length);

  spy.calls.length = 0;
  const full = createWalkCache(spy, { records: all });
  assert.deepEqual(spy.calls, [], '四类都给了 ⇒ 零读盘');
  assert.deepEqual(cacheData(full), cacheData(createWalkCache(fx.store)), '与 store 路径逐字节相同');
});

test('walk 缓存: 全覆盖时 store 可传 null（完全离线构建）', () => {
  const all = recordsOf(fx.store);
  const offline = createWalkCache(null, { records: all });
  assert.deepEqual(cacheData(offline), cacheData(createWalkCache(fx.store)), '离线构建 == store 构建');
  assert.equal(offline.get('topics', all.topics[0].id)?.key, all.topics[0].key);
  assert.equal(createWalkCache(null, { records: { claims: all.claims } }), null, '没 store 又没覆盖全 ⇒ null（与改动前一致）');
});

// ---------------------------------------------------------------------------
// ③ 口径一致：坏条目 / 无 id 条目
// ---------------------------------------------------------------------------

test('walk 缓存: records 里的坏条目与无 id 条目被同样丢掉', () => {
  const topics = [
    { id: 't:ok', key: 'a' },
    { key: 'no-id' },                       // 无 id ⇒ 丢
    { id: '' },                             // 空 id ⇒ 丢
    null,                                   // 非对象 ⇒ 丢
    { id: 't:corrupt', record: null },      // store.list 坏条目的形状（record:null）⇒ 丢
  ];
  const cache = createWalkCache(null, { records: { topics, episodes: [], links: [], claims: [] } });
  assert.deepEqual(cache.topics.map((t) => t.id), ['t:ok'], '只留合法记录');
  assert.equal(cache.topicsByKey.get('a')?.length, 1);
});

test('walk 缓存: 也接受 store.list 的原始条目（{record} 包装）', () => {
  const rows = fx.store.list('topics');
  const wrapped = createWalkCache(null, {
    records: { topics: rows, episodes: fx.store.list('episodes'), links: fx.store.list('links'), claims: fx.store.list('claims') },
  });
  assert.deepEqual(cacheData(wrapped), cacheData(createWalkCache(fx.store)), '包装条目与裸记录等价');
});

// ---------------------------------------------------------------------------
// ④ 只读
// ---------------------------------------------------------------------------

test('walk 缓存: 返回对象被冻结（缓存不许被调用方改坏）', () => {
  const cache = createWalkCache(fx.store);
  assert.equal(Object.isFrozen(cache), true);
  assert.throws(() => { 'use strict'; cache.claims = []; }, TypeError);
});

// ---------------------------------------------------------------------------
// ⑤ 行为一致：walk 结果逐位相同
// ---------------------------------------------------------------------------

test('walk 缓存: store 建 vs records 建 ⇒ walkFromSignals 结果 deepEqual', () => {
  const fromStore = createWalkCache(fx.store);
  const fromRecords = createWalkCache(fx.store, { records: recordsOf(fx.store) });
  const signal = { text: `${TOPIC_KEY} 报错`, scopeKey: fx.scopeKey };
  const a = walkFromSignals({ signal, store: fx.store, scope: fx.scopeKey, cache: fromStore, depth: 2, limit: 5, budgetTokens: 500 });
  const b = walkFromSignals({ signal, store: fx.store, scope: fx.scopeKey, cache: fromRecords, depth: 2, limit: 5, budgetTokens: 500 });
  assert.deepEqual(b, a, 'hit/path/omitted/tokens 全部逐位相同');
  assert.ok(Array.isArray(a.hits));
});

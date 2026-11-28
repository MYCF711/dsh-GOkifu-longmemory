// A7.cacheBreak 的 tombstone test（task-18 / P0-5）：
// **删掉 prefixHash 计算 ⇒ 本文件红**；删掉注入段的读数埋点 ⇒ 第三、四节红；把 A7 接进 exit code ⇒ 第四节红。
//
// 上游依据（Anthropic prompt caching，代码级转述见 evidence/research/mem-vendors.md §1）：
//   缓存是**前缀累积哈希**，层级 `tools → system → messages`；改早层 ⇒ 该层及其后全废；
//   **只有尾部追加能全命中**；breakpoint 放在"每请求都变的块"上 = 每次写、永不读。
// 所以 A7 的口径只有一句：**这一轮有没有把上一轮已经发出去的前缀改掉**（次数 / 轮数）。
//
// 覆盖：
//   一、纯函数判据：`prefixHashOf` 的稳定性与敏感性；`planCacheBreakRow` 的四种判定
//       （首轮 / 尾部追加 / 早层改写 / 前缀变短）。
//   二、sidecar 账本 `cache-breaks.jsonl`：append-only、坏行跳过、不认识的版本不认、
//       同会话取最近一条、撞上限**轮转**而不是停写。
//   三、接线证据（真插件 + 真 store 跑 `agent/pre-step`）：
//        ① 同一注入内容连跑两轮 ⇒ A7 = 0/2；② 只加尾部消息 ⇒ 仍 0（"只有尾部追加全命中"的正例）；
//        ③ 早层被改写 ⇒ 1/2；④ 跨 apply（内存清空）仍判得出 ⇒ 判据在账本里，不在内存里。
//   四、`metrics-guard` 侧：A7 出现在约束条件行、**不参与 exit code**（再差也不 push fails）。
//   五、tombstone：`prefixHashOf` 与两处接线都必须还在（删掉即红）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CACHE_BREAKS_FILE,
  CACHE_BREAKS_SCHEMA_VERSION,
  aggregateCacheBreak,
  appendCacheBreak,
  lastCacheBreakRow,
  planCacheBreakRow,
  prefixHashOf,
  readCacheBreakStats,
  readCacheBreaks,
} from '../src/cache.mjs';
import { CACHE_BREAKS_MAX_BYTES, CACHE_BREAKS_TAIL_BYTES } from '../src/rooms/limits.mjs';
import { HOOK, cacheTokenOf, cacheTokensOf } from '../src/hooks.mjs';
import { apply } from '../src/plugin.mjs';
import { judge, renderSummary } from '../scripts/metrics-guard.mjs';
import { buildMemoryCard, scopeKeyFromPath } from '../src/rooms/inject.mjs';
import { createStore } from '../src/rooms/persist.mjs';

const T = (day) => Date.UTC(2026, 10, day, 12, 0, 0); // 2026-11-DD
const tmpDir = (tag) => mkdtempSync(path.join(tmpdir(), `kifuin-${tag}-`));
const sourceOf = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// 一、纯函数判据
// ---------------------------------------------------------------------------

test('A7 ①: prefixHashOf 是稳定投影的累积 hash（同输入同值 / 16 hex / 分隔不歧义）', () => {
  const tokens = ['user\u001f甲', 'assistant\u001f乙'];
  assert.equal(prefixHashOf(tokens), prefixHashOf([...tokens]), '同输入必须同 hash（判等的地基）');
  assert.match(prefixHashOf(tokens), /^[0-9a-f]{16}$/, '取 sha256 前 16 hex');
  assert.notEqual(prefixHashOf(['user\u001f甲']), prefixHashOf(['user\u001f乙']), '内容变一个字也必须变');
  // 分隔符：拼起来一样的序列不能撞（"两条消息" ≠ "一条长消息"）
  assert.notEqual(prefixHashOf(['user\u001fab']), prefixHashOf(['user\u001fa', 'user\u001fb']));
  // 前缀语义：count = 第 3 条的 hash 必须等于"只取前 2 条 + 第 3 条"的前缀
  const five = ['a', 'b', 'c', 'd', 'e'];
  assert.equal(prefixHashOf(five, { count: 2 }), prefixHashOf(['a', 'b']), 'count 取的是**前缀**');
  assert.equal(prefixHashOf(five, { count: 99 }), prefixHashOf(five), 'count 超过长度按整段算');
  assert.equal(prefixHashOf([]), prefixHashOf([], { count: 0 }), '空序列也是一个确定的 hash');
});

test('A7 ①: 消息投影不带 id / 时间戳（同一段内容重建对象不许判成变化）', () => {
  const a = { id: 'msg-aaa', role: 'user', content: [{ type: 'text', text: 'yaml 装不上' }] };
  const b = { id: 'msg-bbb', role: 'user', content: [{ type: 'text', text: 'yaml 装不上' }] };
  assert.equal(cacheTokenOf(a), cacheTokenOf(b), 'id 不同、内容相同 ⇒ 同一个投影（否则 A7 恒为 100% 的假红）');
  assert.notEqual(cacheTokenOf(a), cacheTokenOf({ ...a, role: 'assistant' }), 'role 变了要算不同（角色翻转会改前缀）');
  assert.deepEqual(cacheTokensOf([a, b]), [cacheTokenOf(a), cacheTokenOf(b)]);
  assert.deepEqual(cacheTokensOf(null), [], '非数组按空序列（不许炸）');
});

test('A7 ①: 首轮 ⇒ 不记 break（round=1，first-round），字符数照记', () => {
  const { row, intact } = planCacheBreakRow({
    at: T(20), sessionId: 's1', action: 'inject',
    beforeTokens: ['user\u001f问题'], afterTokens: ['user\u001f问题', 'user\u001f卡'],
    injectedChars: 42,
  });
  assert.equal(intact, true, '没有上一轮可比 ⇒ 不许算成"失效"');
  assert.equal(row.cacheBreak, false);
  assert.equal(row.breakReason, 'first-round');
  assert.equal(row.round, 1);
  assert.equal(row.schemaVersion, CACHE_BREAKS_SCHEMA_VERSION);
  assert.equal(row.sid, 's1');
  assert.equal(row.injectedChars, 42, '注入字符数必须落账');
  assert.equal(row.msgsBefore, 1);
  assert.equal(row.msgsAfter, 2);
  assert.equal(row.prevHash, null);
});

test('A7 ①: **尾部追加不是 break**（只有尾部追加能全命中）', () => {
  const prev = planCacheBreakRow({
    at: T(20), sessionId: 's1', action: 'inject',
    beforeTokens: ['user\u001f一'], afterTokens: ['user\u001f一', 'user\u001f卡A'],
  }).row;
  const { row, intact } = planCacheBreakRow({
    at: T(21), sessionId: 's1', action: 'skip',
    beforeTokens: ['user\u001f一', 'user\u001f卡A', 'assistant\u001f好'],
    afterTokens: ['user\u001f一', 'user\u001f卡A', 'assistant\u001f好', 'user\u001f二'],
    prev,
  });
  assert.equal(intact, true, '上一轮发出去的两条逐字保留 ⇒ 全命中');
  assert.equal(row.cacheBreak, false);
  assert.equal(row.breakReason, 'tail-append');
  assert.equal(row.round, 2);
  assert.equal(row.prevHash, prev.afterHash);
  assert.equal(row.prevCount, 2);
});

test('A7 ①: **早层被改写 ⇒ break**（槽位覆盖 / 压缩改掉已发出的正文）', () => {
  const prev = planCacheBreakRow({
    at: T(20), sessionId: 's1', action: 'inject',
    beforeTokens: ['user\u001f一'], afterTokens: ['user\u001f一', 'user\u001f卡A'],
  }).row;
  const { row, intact } = planCacheBreakRow({
    at: T(21), sessionId: 's1', action: 'inject',
    beforeTokens: ['user\u001f一', 'user\u001f卡B'], afterTokens: ['user\u001f一', 'user\u001f卡B'],
    prev,
  });
  assert.equal(intact, false);
  assert.equal(row.cacheBreak, true);
  assert.equal(row.breakReason, 'prefix-changed');
  assert.equal(row.beforeHash, row.afterHash, '这一轮没注入任何东西，但它把上一轮的前缀改掉了 —— 这正是要测的那件事');
});

test('A7 ①: **前缀变短 ⇒ break**（压缩 / 截断把前面几条丢掉）', () => {
  const prev = planCacheBreakRow({
    at: T(20), sessionId: 's1', action: 'inject',
    beforeTokens: ['user\u001f一'], afterTokens: ['user\u001f一', 'user\u001f卡A', 'assistant\u001f好'],
  }).row;
  const { row } = planCacheBreakRow({
    at: T(21), sessionId: 's1', action: 'skip',
    beforeTokens: ['user\u001f一'], afterTokens: ['user\u001f一'],
    prev,
  });
  assert.equal(row.cacheBreak, true);
  assert.equal(row.breakReason, 'prefix-shrunk');
  assert.equal(row.prevCount, 3);
  assert.equal(row.msgsAfter, 1);
});

test('A7 ①: 汇总 = 前缀变化次数 / 轮数；0 轮 ⇒ rate=null（不编造 0%）', () => {
  const mk = (cacheBreak, breakReason, injectedChars = 100) => ({ schemaVersion: 1, cacheBreak, breakReason, injectedChars, at: 1 });
  const stats = aggregateCacheBreak([
    mk(false, 'first-round'),
    mk(false, 'tail-append'),
    mk(true, 'prefix-changed'),
    mk(true, 'prefix-shrunk'),
    { garbage: true }, // 不是读数行（老格式/坏行）⇒ 不计入
  ]);
  assert.equal(stats.rounds, 4, '只数有效读数行');
  assert.equal(stats.breaks, 2);
  assert.equal(stats.rate, 0.5, 'rate = 变化次数 / 轮数');
  assert.equal(stats.injectedChars, 400);
  assert.deepEqual(stats.byReason, { 'first-round': 1, 'tail-append': 1, 'prefix-changed': 1, 'prefix-shrunk': 1 });
  const empty = aggregateCacheBreak([]);
  assert.equal(empty.rounds, 0);
  assert.equal(empty.rate, null, '0/0 的 0% 不是"没有失效"，是"没有观测"');
});

// ---------------------------------------------------------------------------
// 二、sidecar 账本（append-only + 有界轮转）
// ---------------------------------------------------------------------------

const ledgerRows = (storeRoot) => {
  const file = path.join(storeRoot, CACHE_BREAKS_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
};

const rowOf = (over = {}) => ({
  schemaVersion: CACHE_BREAKS_SCHEMA_VERSION,
  at: T(20), sid: 's1', round: 1, action: 'inject',
  beforeHash: 'aaaa', afterHash: 'bbbb', prevHash: null, prevCount: null,
  intact: true, cacheBreak: false, breakReason: 'first-round',
  injectedChars: 10, msgsBefore: 1, msgsAfter: 2,
  ...over,
});

test('A7 ②: 账本 append-only（两轮两行、不覆盖），库不存在时不写', () => {
  const root = tmpDir('a7-append');
  try {
    assert.deepEqual(appendCacheBreak({ storeRoot: root, row: rowOf() }), { status: 'written', file: path.join(root, CACHE_BREAKS_FILE), fileBytes: 0, rotated: false });
    const second = appendCacheBreak({ storeRoot: root, row: rowOf({ round: 2, at: T(21) }) });
    assert.equal(second.status, 'written');
    const rows = ledgerRows(root);
    assert.equal(rows.length, 2, 'append-only：追加不覆盖');
    assert.equal(rows[0].round, 1);
    assert.equal(rows[1].round, 2);
    // 库目录不存在 ⇒ absent（不创建目录，避免把"无库"变成"有库"）
    assert.equal(appendCacheBreak({ storeRoot: path.join(root, 'nope'), row: rowOf() }).status, 'absent');
    assert.equal(appendCacheBreak({ storeRoot: '', row: rowOf() }).status, 'absent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A7 ②: 读侧容错 —— 坏行跳过、不认识的版本不认、按会话取最近一条', () => {
  const root = tmpDir('a7-read');
  try {
    const file = path.join(root, CACHE_BREAKS_FILE);
    writeFileSync(file, [
      JSON.stringify(rowOf({ round: 1, afterHash: 'h1' })),
      '{这不是 JSON',
      JSON.stringify(rowOf({ round: 2, at: T(21), afterHash: 'h2', breakReason: 'tail-append' })),
      JSON.stringify(rowOf({ round: 3, at: T(22), afterHash: 'h3', sid: 'other' })),
      JSON.stringify(rowOf({ schemaVersion: 99, round: 9, afterHash: 'h9', at: T(23) })), // 未来版本：不认
    ].join('\n') + '\n', 'utf8');
    const rows = readCacheBreaks({ storeRoot: root });
    assert.equal(rows.length, 4, '坏行被跳过，其余照读');
    const last = lastCacheBreakRow({ storeRoot: root, sessionId: 's1' });
    assert.equal(last.round, 2, '同会话取**最近一条**（且跳过未来版本第 9 行）');
    assert.equal(last.afterHash, 'h2');
    assert.equal(lastCacheBreakRow({ storeRoot: root, sessionId: 'missing' }), null, '没有该会话 ⇒ null（首轮）');
    const stats = readCacheBreakStats({ storeRoot: root });
    assert.equal(stats.rounds, 3, '未来版本的行不进统计（口径不许静默漂移）');
    assert.equal(stats.breaks, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A7 ②: 撞上限 **轮转**（`.1`）+ 读数仍连续（不许停写让指标静默变旧）', () => {
  const root = tmpDir('a7-rotate');
  try {
    const cap = 1; // 一个字节就"满"：第一次写之后必然轮转
    const first = appendCacheBreak({ storeRoot: root, row: rowOf({ round: 1, afterHash: 'h1' }), maxBytes: cap });
    assert.equal(first.status, 'written');
    const second = appendCacheBreak({ storeRoot: root, row: rowOf({ round: 2, at: T(21), afterHash: 'h2' }), maxBytes: cap });
    assert.equal(second.status, 'rotated', '超过上限 ⇒ 旧行整体改名成 .1');
    assert.equal(existsSync(`${path.join(root, CACHE_BREAKS_FILE)}.1`), true, '轮转备份必须在');
    assert.equal(ledgerRows(root).length, 1, '当前文件只剩新的一行');
    const rows = readCacheBreaks({ storeRoot: root });
    assert.equal(rows.length, 2, '读侧把 .1 与当前文件都读上 ⇒ 读数连续');
    assert.deepEqual(rows.map((r) => r.round), [1, 2], '旧行在前、新行在后');
    const stats = readCacheBreakStats({ storeRoot: root });
    assert.equal(stats.rounds, 2);
    // 上限值只有一份：来自 limits.mjs
    assert.equal(CACHE_BREAKS_MAX_BYTES, 2 * 1024 * 1024);
    assert.equal(CACHE_BREAKS_TAIL_BYTES, 256 * 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 三、接线证据（真插件 + 真 store 跑 agent/pre-step）
//
// 夹具与 test/inject-slot.test.mjs 同形（假 ctx / 假 session / 临时 store），但只测缓存读数这一条。
// ---------------------------------------------------------------------------

function makeCtx() {
  const hooks = {};
  const warns = [];
  const ctx = {
    logger: { warn: (line) => warns.push(String(line)), info: () => {}, debug: () => {} },
    on: (event, handler) => {
      hooks[event] = handler;
      return () => { if (hooks[event] === handler) delete hooks[event]; };
    },
  };
  return { ctx, hooks, warns };
}

function makeSession(cwd, id = 'session-a7-0001') {
  return { id, cwd, append: () => { throw new Error('棋院不写会话事件'); } };
}

const fakeCreateUserMessage = (input) => ({ id: `msg-${Math.random().toString(36).slice(2, 10)}`, role: 'user', ...input, __fake: true });
const userMessage = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const enterDecision = (messages) => ({ kind: 'enter', messages, meta: { tagged: true } });

/** 临时工作区 + 同域临时记忆库（一局 + 一个主题 + 一条 antipattern claim，保证 walk 命中）。 */
function makeWorkspace(tag = 'a7') {
  const workspace = mkdtempSync(path.join(tmpdir(), `kifuin-${tag}-`));
  const storeRoot = mkdtempSync(path.join(tmpdir(), `kifuin-${tag}-store-`));
  const scope = scopeKeyFromPath(workspace);
  const store = createStore({ root: storeRoot, now: T(20) });
  store.ensureDirs();
  store.putMany('episodes', [{
    id: 'ep-aaaaaaa1',
    sessionId: 'session-aaaaaaa1',
    scopeKey: scope,
    startedAt: T(21),
    firstEventAt: T(21),
    lastEventAt: T(21),
    recordedAt: T(21),
    closure: { logPath: 'sessions/a/x/session.v4.jsonl.zstd', graphPath: 'graphs/a/graph.json', seqFrom: 11, seqTo: 99 },
    l0: 'demo episode',
    signals: { failures: 3, successes: 0, unsettled: 0, constraints: 0, tools: [] },
    state: 'archived',
  }]);
  store.replaceDerived('topics', [
    { id: 't:term:aaaa0001', kind: 'term', key: 'yaml', df: 2, idfNorm: 0.7, firstSeenAt: T(21), lastSeenAt: T(21), episodes: ['ep-aaaaaaa1'] },
  ], { at: T(24) });
  store.putMany('claims', [{
    id: 'c-scope001',
    kind: 'antipattern',
    text: "Cannot find module 'yaml'",
    scopeKey: scope,
    threadIds: [],
    state: 'observed',
    support: [{ episode: 'ep-aaaaaaa1', seq: 30, quote: 'Error: boom' }],
    counter: [],
    validity: { type: 'none', value: null },
    preconditions: [],
    occurredAt: T(21),
    recordedAt: T(21),
    counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null },
    supersedes: null,
  }]);
  return { workspace, storeRoot, cleanup: () => { rmSync(workspace, { recursive: true, force: true }); rmSync(storeRoot, { recursive: true, force: true }); } };
}

const baseConfig = (over = {}) => ({
  enabled: true, shadow: false, autoBuild: false, autoArchive: false,
  oncePerSession: false, repeatHint: false, liveStats: false, sampleCards: false, collectMessages: false,
  probeValidity: false,
  now: T(24), limit: 5, budgetTokens: 500,
  createUserMessage: fakeCreateUserMessage,
  ...over,
});

const runHook = async (hooks, payload, decision) => {
  const hook = hooks[HOOK];
  assert.equal(typeof hook, 'function', 'apply() 必须挂上 agent/pre-step');
  return hook(payload, async () => decision);
};

/** 一轮：跑 pre-step 并把**真正要交出去的那一份**（宿主会保留下来继续下一轮）返回。 */
async function round({ ctx, hooks, session, messages }) {
  const decision = await runHook(hooks, { agent: { session }, messages }, enterDecision(messages));
  return decision.messages;
}

test('A7 ③: 同一注入内容连跑两轮 ⇒ A7 = 0/2（读数是 0，不是 1）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace('a7-e2e-same');
  try {
    const { ctx, hooks } = makeCtx();
    apply(ctx, baseConfig({ storeRoot }));
    const session = makeSession(workspace, 'session-a7-same');
    const turn1 = [userMessage('yaml 装不上')];

    const afterRound1 = await round({ ctx, hooks, session, messages: turn1 });
    assert.equal(afterRound1.length, 2, '第一轮必须真注入（1 条用户消息 + 1 条卡）');
    // 第二轮：宿主把上一轮的卡留在上下文里，信号再来一次（卡正文一个字都没变）
    const afterRound2 = await round({ ctx, hooks, session, messages: [...afterRound1] });
    assert.equal(afterRound2.length, 2, '卡已在上下文里 ⇒ 不再重投（A7 就是要看见这件事**没有**改掉前缀）');

    const rows = ledgerRows(storeRoot);
    assert.equal(rows.length, 2, '每轮一条读数');
    assert.equal(rows[0].cacheBreak, false);
    assert.equal(rows[0].breakReason, 'first-round');
    assert.equal(rows[0].injectedChars > 0, true, '第一轮的注入字符数必须落账');
    assert.equal(rows[1].cacheBreak, false, '**同注入内容连跑两轮 ⇒ 不许记 break**');
    assert.equal(rows[1].breakReason, 'tail-append');
    assert.equal(rows[1].injectedChars, 0, '第二轮没真注入 ⇒ 字符数为 0');

    const stats = readCacheBreakStats({ storeRoot });
    assert.equal(stats.rounds, 2);
    assert.equal(stats.breaks, 0, 'A7 = 变化次数 / 轮数 = 0/2');
    assert.equal(stats.rate, 0);
  } finally {
    cleanup();
  }
});

test('A7 ③: 只往尾部加消息 ⇒ 仍然 0（"只有尾部追加全命中"的正例）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace('a7-e2e-tail');
  try {
    const { ctx, hooks } = makeCtx();
    apply(ctx, baseConfig({ storeRoot }));
    const session = makeSession(workspace, 'session-a7-tail');
    const turn1 = [userMessage('yaml 装不上')];
    const afterRound1 = await round({ ctx, hooks, session, messages: turn1 });
    const turn2 = [...afterRound1, { role: 'assistant', content: [{ type: 'text', text: '先看 package.json' }] }, userMessage('yaml 还是装不上')];
    const afterRound2 = await round({ ctx, hooks, session, messages: turn2 });
    assert.equal(afterRound2.length, 4, '尾部追加 + 不重投');

    const stats = readCacheBreakStats({ storeRoot });
    assert.equal(stats.rounds, 2);
    assert.equal(stats.breaks, 0, '尾部追加**不是** break —— 判据不是"任何变化都算"');
  } finally {
    cleanup();
  }
});

test('A7 ③: 早层被改写（已发出的卡正文变了）⇒ A7 = 1/2', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace('a7-e2e-break');
  try {
    const { ctx, hooks } = makeCtx();
    apply(ctx, baseConfig({ storeRoot }));
    const session = makeSession(workspace, 'session-a7-break');
    const turn1 = [userMessage('yaml 装不上')];
    const afterRound1 = await round({ ctx, hooks, session, messages: turn1 });
    assert.equal(afterRound1.length, 2);

    // 模拟"槽位覆盖 / 压缩"改写已发出的那一块：位置不变，正文换了
    const rewritten = [afterRound1[0], userMessage('旧卡（已过期）：yaml 装不上 → 升级 node 即可')];
    await round({ ctx, hooks, session, messages: rewritten });

    const rows = ledgerRows(storeRoot);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].cacheBreak, true, '**内容变化 ⇒ 记一次 break**');
    assert.equal(rows[1].breakReason, 'prefix-changed');
    assert.equal(rows[1].prevHash, rows[0].afterHash, '比的是上一轮**发出去**的那一段');

    const stats = readCacheBreakStats({ storeRoot });
    assert.equal(stats.breaks, 1);
    assert.equal(stats.rounds, 2);
    assert.equal(stats.rate, 0.5, 'A7 = 1/2');
  } finally {
    cleanup();
  }
});

test('A7 ③: 跨 apply（内存清空）仍判得出 ⇒ 判据在账本里，不在内存里', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace('a7-e2e-cross');
  try {
    const first = makeCtx();
    apply(first.ctx, baseConfig({ storeRoot }));
    const session1 = makeSession(workspace, 'session-a7-cross');
    const afterRound1 = await round({ ctx: first.ctx, hooks: first.hooks, session: session1, messages: [userMessage('yaml 装不上')] });
    assert.equal(afterRound1.length, 2);

    // 宿主重新 apply（新实例，`cacheBreakPrev` 是空的）⇒ 上一轮那一条只能从账本读回来
    const second = makeCtx();
    let buildCalls = 0;
    apply(second.ctx, baseConfig({ storeRoot, deps: { buildMemoryCard: (input) => { buildCalls += 1; return buildMemoryCard(input); } } }));
    const session2 = makeSession(workspace, 'session-a7-cross');
    const rewritten = [afterRound1[0], userMessage('旧卡（已过期）：换个说法）')];
    await round({ ctx: second.ctx, hooks: second.hooks, session: session2, messages: rewritten });
    assert.equal(buildCalls, 1, '新实例仍然重建了卡（说明它真的走到了注入决策，不是早退）');

    const rows = ledgerRows(storeRoot);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].round, 2, '轮次接着账本里的 1 往下数');
    assert.equal(rows[1].cacheBreak, true, '跨 apply 仍能判出前缀失效（内存里没有上一条）');
    assert.equal(rows[1].prevHash, rows[0].afterHash);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 四、metrics-guard 侧：A7 出现在约束条件行，且**不参与 exit code**
// ---------------------------------------------------------------------------

const baseReport = () => ({
  axes: {
    A1: { value: 0 },
    A4: { value: 2 },
    A5: { value: 0 },
    A6: { value: 1 },
    A2: { detail: { injectionRecall: { recall: 1, recallSpecific: 0.842 } } },
  },
});

test('A7 ④: A7 再差也不影响 exit code（judge 绝不把它 push 进 fails）', () => {
  const worst = { rounds: 10, breaks: 10, rate: 1, injectedChars: 99999 };
  const v = judge(baseReport(), undefined, null, worst);
  assert.equal(v.ok, true, `A7 不该决定 exit code：${v.fails.join(' · ')}`);
  assert.deepEqual(v.fails, []);
  assert.equal(v.values.a7Rounds, 10);
  assert.equal(v.values.a7Breaks, 10);
  assert.equal(v.values.a7CacheBreak, 1);
  // 没有读数（账本不存在 / 还没轮次）⇒ null，不是 0，也**不是红**
  const missing = judge(baseReport(), undefined, null, null);
  assert.equal(missing.ok, true);
  assert.equal(missing.values.a7Rounds, null);
  assert.equal(missing.values.a7CacheBreak, null);
  const empty = judge(baseReport(), undefined, null, aggregateCacheBreak([]));
  assert.equal(empty.ok, true);
  assert.equal(empty.values.a7Rounds, 0);
  assert.equal(empty.values.a7CacheBreak, null, '0/0 ⇒ null（不编造 0%）');
});

test('A7 ④: 输出里 A7 长这样 —— 约束条件行带 `A7.cacheBreak=次数/轮数（只统计·不判红）`', () => {
  const values = {
    sampleSource: 'holdout', a2bN: 118, a2bStrict: 0.466, a2bCover: 0.797,
    a1: 0, a1Vacuous: false, a5: 0, a6: 1, p50: 22.8,
    a1Opposite: 0, a1OppositeDecidability: 0.2245, a1OppositeN: 1586, a1OppositeDecisionGrade: false,
    a1Redundant: null, a1RedundantNecessary: null, a1RedundantN: null, a1RedundantPowered: false,
    repeatFailureRate: 0.146,
    a7Rounds: 2, a7Breaks: 1, a7CacheBreak: 0.5,
  };
  const lines = renderSummary({ values }, { ok: true, fails: [] });
  assert.equal(lines.length, 7, '汇总行数固定（A7 挂在约束条件行里，不新增行）');
  assert.equal(lines[0], 'metrics-guard PASS');
  const constraint = lines.find((l) => l.includes('约束条件'));
  assert.ok(constraint, '必须有约束条件行');
  assert.match(constraint, /A7\.cacheBreak=1\/2（只统计·不判红）/, `A7 的打印形态变了：${constraint}`);
  assert.match(constraint, /A1=0 A5=0 A6=1 A4\.p50=22\.80ms/, '原有约束字段一个都不许丢');
  // 没有读数 ⇒ n/a（不编造 0/0）
  const noA7 = renderSummary({ values: { ...values, a7Rounds: null, a7Breaks: null } }, { ok: true, fails: [] });
  assert.match(noA7.find((l) => l.includes('约束条件')), /A7\.cacheBreak=n\/a（只统计·不判红）/);
});

// ---------------------------------------------------------------------------
// 五、tombstone：删掉 prefixHash 计算 / 删掉接线 ⇒ 本文件红
// ---------------------------------------------------------------------------

test('A7 tombstone: prefixHash 计算与两处接线都必须还在（删掉任一处即红）', () => {
  const cacheSrc = sourceOf('src/cache.mjs');
  const hooksSrc = sourceOf('src/hooks.mjs');
  // ① 判据本体（删掉 prefixHashOf ⇒ 上面的纯函数断言与这里的结构断言一起红）
  assert.match(cacheSrc, /export function prefixHashOf\(/, 'cache.mjs 必须定义 prefixHashOf');
  assert.match(cacheSrc, /createHash\('sha256'\)[\s\S]{0,400}digest\('hex'\)/, '前缀 hash 必须是真 hash，不许用长度/条数代替');
  assert.match(cacheSrc, /export function planCacheBreakRow\(/, '失效判定必须是可单测的纯函数');
  assert.match(cacheSrc, /export function appendCacheBreak\(/, '落盘只有一处');
  assert.match(cacheSrc, /export function aggregateCacheBreak\(/, 'A7 的汇总口径只有一处');
  // ② 注入段埋点（删掉这段 ⇒ 第四节之外，第三节也会红；这里再钉一次位置）
  assert.match(hooksSrc, /planCacheBreakRow\(/, 'hooks 必须真的调用判定（不是自己另写一份）');
  assert.match(hooksSrc, /appendCacheBreak\(/, 'hooks 必须真的落账');
  assert.match(hooksSrc, /const recordCacheBreak = /, '埋点必须收在一个函数里（只有一个注入决策点，也只有一处埋点）');
  assert.match(hooksSrc, /export function cacheTokenOf\(/, '稳定投影必须由 hooks 定义（与 messageText 同一处口径）');
  // ③ 阈值只许在 limits.mjs（上限值不许在落盘点再写一份）
  const limitsSrc = sourceOf('src/rooms/limits.mjs');
  assert.match(limitsSrc, /CACHE_BREAKS_MAX_BYTES = /, '账本上限必须定义在 limits.mjs');
  assert.match(limitsSrc, /CACHE_BREAKS_TAIL_BYTES = /, '尾读窗口必须定义在 limits.mjs');
  assert.equal(/CACHE_BREAKS_MAX_BYTES\s*=\s*\d/.test(cacheSrc), false, 'cache.mjs 不许再写一份上限数值（应当 import）');
});
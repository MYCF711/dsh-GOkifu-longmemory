// inject-slot 的 tombstone test（task-11 / 重构 B 期）：
// 删掉 `src/rooms/inject-slot.mjs` ⇒ 本文件整片红；插件把去重改回「纯内存集合」⇒ 第三节红。
//
// 覆盖（方案 P0-1、docs/优化方案-对标市场记忆系统.md §2 P0-1）：
//   一、纯函数判据（`planSlotWrite` 是本房的核心）：同 slot + hash 相同 ⇒ 不写不投；
//        hash 变了 ⇒ **覆盖同一条**（`seq+1`）而不是追加新块；键 = 会话 + 槽位。
//   二、sidecar 账本（`inject-slots.json`）：原子写、幂等（重放同 hash 字节不动）、
//        **不认识的 version 显式抛**（不静默降级）、文件缺失按首次运行。
//   三、接线证据（真插件 + 真 store，端到端跑 `agent/pre-step`）：
//        ① 同 session 第二次 pre-step ⇒ 注入为空（且账本里只留一条记录）；
//        ② `session/end-seed` 后**重新 apply**（内存状态清空）⇒ 0 重复注入，且**不重建卡**
//           （`buildMemoryCard` 调用计数 0）—— 这是内存集合做不到的那一格；
//        ③ 对照：`KIFU_INJECT_SLOT_IDEMPOTENT=0` 走老的纯内存路径 ⇒ 同一场景会重建卡（计数 1）；
//        ④ 卡被压缩掉（正文不在 messages 里）⇒ **仍然重投**（"必要重注"那一档，T49 ② 不退化）；
//        ⑤ 账本坏了（未知 version）⇒ 不炸、照常注入、留一次 warn（判据不对称：宁可多投不许吞卡）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  INJECT_SLOT_ID,
  INJECT_SLOT_IDEMPOTENT_ENV,
  INJECT_SLOT_LEDGER_FILE,
  INJECT_SLOT_LEDGER_VERSION,
  SLOT_LEDGER_MAX,
  SlotLedgerError,
  emptySlotLedger,
  lookupSlot,
  planSlotWrite,
  pruneSlotLedger,
  readSlotLedger,
  recordSlot,
  slotContentHash,
  slotContentPresent,
  slotIdempotencyEnabled,
  slotKeyOf,
  slotSeen,
  writeSlotLedger,
} from '../src/rooms/inject-slot.mjs';
import { apply, HOOK, messageText } from '../src/plugin.mjs';
import { buildMemoryCard, scopeKeyFromPath, signalFromText } from '../src/rooms/inject.mjs';
import { createStore } from '../src/rooms/persist.mjs';

const T = (day) => Date.UTC(2026, 9, day, 12, 0, 0); // 2026-10-DD

const tmpDir = (tag) => mkdtempSync(path.join(tmpdir(), `kifuin-${tag}-`));

// ---------------------------------------------------------------------------
// 一、纯函数判据：同 slot + hash 相同 ⇒ 不写；变了 ⇒ 覆盖同一条
// ---------------------------------------------------------------------------

test('S1 ①: 内容 hash 是纯函数（同文本同 hash / 异文本异 hash / sha256 向量）', () => {
  assert.equal(slotContentHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256("abc") 的标准值');
  assert.equal(slotContentHash('记忆卡'), slotContentHash('记忆卡'), '同文本必须同 hash（判等的地基）');
  assert.notEqual(slotContentHash('记忆卡'), slotContentHash('记忆卡 '), '一个空格也算不同内容');
  assert.equal(slotContentHash(null), slotContentHash(''), 'null / 空串同归一');
});

test('S1 ②: 槽位键 = 会话 + 槽位（没有会话 id ⇒ 空键，不记账）', () => {
  const key = slotKeyOf('session-a');
  assert.ok(key.startsWith('session-a'), '键里必须有会话 id');
  assert.ok(key.includes(INJECT_SLOT_ID), '键里必须有槽位 id');
  assert.notEqual(slotKeyOf('session-a'), slotKeyOf('session-b'), '不同会话不同键');
  assert.equal(slotKeyOf(''), '', '没有会话 id ⇒ 空键（无从记账）');
});

test('S1 ③: 首次记账 ⇒ written（seq=1，reason=created）', () => {
  const plan = planSlotWrite(emptySlotLedger(), { sessionId: 'session-a', contentHash: slotContentHash('卡A'), at: T(21) });
  assert.equal(plan.written, true);
  assert.equal(plan.reason, 'slot/created');
  assert.equal(plan.entry.seq, 1);
  assert.equal(plan.entry.at, T(21));
  assert.equal(Object.keys(plan.ledger.slots).length, 1);
});

test('S1 ④: **同 slot + hash 相同 ⇒ 不写**（账本连引用都不换 = 一个字节都没动）', () => {
  const hash = slotContentHash('卡A');
  const first = planSlotWrite(emptySlotLedger(), { sessionId: 'session-a', contentHash: hash, at: T(21) });
  const again = planSlotWrite(first.ledger, { sessionId: 'session-a', contentHash: hash, at: T(22) });
  assert.equal(again.written, false, 'hash 相同不许写');
  assert.equal(again.reason, 'slot/unchanged');
  assert.equal(again.ledger, first.ledger, '必须原样返回同一个账本对象（不新造）');
  assert.equal(again.entry.seq, 1, 'seq 不许涨（没发生新的注入）');
});

test('S1 ⑤: **hash 变了 ⇒ 覆盖同一条**（不是追加新块，seq+1）', () => {
  const a = planSlotWrite(emptySlotLedger(), { sessionId: 'session-a', contentHash: slotContentHash('卡A'), at: T(21) });
  const b = planSlotWrite(a.ledger, { sessionId: 'session-a', contentHash: slotContentHash('卡B'), at: T(22) });
  assert.equal(b.written, true);
  assert.equal(b.reason, 'slot/overwritten');
  assert.equal(b.entry.seq, 2, '覆盖同一条 ⇒ seq 递增（这是"第几次真注入"，不是条数）');
  assert.equal(Object.keys(b.ledger.slots).length, 1, '**同 slot 只有一条记录**（覆盖，不追加）');
  assert.equal(lookupSlot(b.ledger, 'session-a').contentHash, slotContentHash('卡B'), '记的是新内容');
});

test('S1 ⑥: 不同会话各自一条（同 slot 不互相覆盖）', () => {
  let ledger = emptySlotLedger();
  ledger = planSlotWrite(ledger, { sessionId: 'session-a', contentHash: slotContentHash('卡A'), at: T(21) }).ledger;
  ledger = planSlotWrite(ledger, { sessionId: 'session-b', contentHash: slotContentHash('卡A'), at: T(22) }).ledger;
  assert.equal(Object.keys(ledger.slots).length, 2);
  assert.equal(lookupSlot(ledger, 'session-a').seq, 1);
  assert.equal(lookupSlot(ledger, 'session-b').seq, 1);
});

test('S1 ⑦: 没有会话 id / 没有 hash ⇒ 不记账（reason 说明原因，账本原样）', () => {
  const ledger = emptySlotLedger();
  const noSession = planSlotWrite(ledger, { sessionId: '', contentHash: 'x' });
  assert.equal(noSession.written, false);
  assert.equal(noSession.reason, 'slot/no-session');
  const noHash = planSlotWrite(ledger, { sessionId: 'session-a', contentHash: '' });
  assert.equal(noHash.written, false);
  assert.equal(noHash.reason, 'slot/no-hash');
  assert.equal(noHash.ledger, ledger);
});

test('S1 ⑧: 记账内容还在上下文里 ⇒ true；不在 ⇒ false（"必要重注"的判据）', () => {
  const entry = { slotId: INJECT_SLOT_ID, contentHash: slotContentHash('卡A'), seq: 1, at: T(21) };
  assert.equal(slotContentPresent(entry, ['随便', '卡A']), true);
  assert.equal(slotContentPresent(entry, ['卡B']), false, '内容不在上下文 ⇒ 该重投，不许拦');
  assert.equal(slotContentPresent(entry, []), false);
  assert.equal(slotContentPresent(null, ['卡A']), false, '没有记账 ⇒ 不拦');
});

test('S1 ⑨: 淘汰按 at 新的留（上限内不动，超了只留新的）', () => {
  let ledger = emptySlotLedger();
  for (let i = 0; i < 10; i += 1) {
    ledger = planSlotWrite(ledger, { sessionId: `session-${i}`, contentHash: slotContentHash(`卡${i}`), at: T(10 + i) }).ledger;
  }
  const pruned = pruneSlotLedger(ledger, 3);
  assert.equal(Object.keys(pruned.slots).length, 3);
  assert.ok(lookupSlot(pruned, 'session-9'), '最新的必须在');
  assert.equal(lookupSlot(pruned, 'session-0'), null, '最旧的被淘汰');
  assert.equal(Object.keys(pruneSlotLedger(ledger, SLOT_LEDGER_MAX).slots).length, 10, '上限内不淘汰');
});

test('S1 ⑩: 回滚开关只认 "0" / "false"（未设置 = 开启）', () => {
  assert.equal(slotIdempotencyEnabled({}), true, '未设置 ⇒ 新行为');
  assert.equal(slotIdempotencyEnabled({ [INJECT_SLOT_IDEMPOTENT_ENV]: '1' }), true);
  assert.equal(slotIdempotencyEnabled({ [INJECT_SLOT_IDEMPOTENT_ENV]: '0' }), false);
  assert.equal(slotIdempotencyEnabled({ [INJECT_SLOT_IDEMPOTENT_ENV]: 'false' }), false);
  assert.equal(slotIdempotencyEnabled({ [INJECT_SLOT_IDEMPOTENT_ENV]: 'FALSE' }), false, '大小写不敏感');
});

// ---------------------------------------------------------------------------
// 二、sidecar 账本：原子写 / 幂等 / 版本拒绝
// ---------------------------------------------------------------------------

test('S2 ①: 文件不存在 ⇒ 空账本（首次运行不是错误）', () => {
  const root = tmpDir('slot-missing');
  try {
    const ledger = readSlotLedger({ storeRoot: root });
    assert.deepEqual(ledger, { version: INJECT_SLOT_LEDGER_VERSION, slots: {} });
    assert.equal(existsSync(path.join(root, INJECT_SLOT_LEDGER_FILE)), false, '读不许顺手创建文件');
    assert.equal(slotSeen({ storeRoot: root, sessionId: 'session-a' }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('S2 ②: 写—读往返 + 原子写不留 .tmp（落盘文件名/形状固定）', () => {
  const root = tmpDir('slot-rw');
  try {
    const hash = slotContentHash('卡A');
    const out = recordSlot({ storeRoot: root, sessionId: 'session-a', contentHash: hash, at: T(21) });
    assert.equal(out.written, true);
    assert.equal(out.seq, 1);
    assert.equal(out.path, path.join(root, INJECT_SLOT_LEDGER_FILE));
    const raw = JSON.parse(readFileSync(path.join(root, INJECT_SLOT_LEDGER_FILE), 'utf8'));
    assert.equal(raw.version, INJECT_SLOT_LEDGER_VERSION);
    const entry = raw.slots[slotKeyOf('session-a')];
    assert.equal(entry.slotId, INJECT_SLOT_ID);
    assert.equal(entry.contentHash, hash);
    assert.equal(entry.seq, 1);
    assert.equal(readdirSync(root).filter((n) => n.includes('.tmp-')).length, 0, '不许留临时文件');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('S2 ③: 重放同 hash ⇒ 第二次 written:false 且文件**字节不变**（幂等）', () => {
  const root = tmpDir('slot-idem');
  try {
    const hash = slotContentHash('卡A');
    recordSlot({ storeRoot: root, sessionId: 'session-a', contentHash: hash, at: T(21) });
    const before = readFileSync(path.join(root, INJECT_SLOT_LEDGER_FILE));
    const second = recordSlot({ storeRoot: root, sessionId: 'session-a', contentHash: hash, at: T(22) });
    const after = readFileSync(path.join(root, INJECT_SLOT_LEDGER_FILE));
    assert.equal(second.written, false, 'hash 相同 ⇒ 不写');
    assert.equal(Buffer.compare(before, after), 0, '文件必须逐字节不变（没写就不该有时间戳/内容变化）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('S2 ④: 内容变了 ⇒ 覆盖同一条（磁盘上仍只有一条，seq=2）', () => {
  const root = tmpDir('slot-cover');
  try {
    recordSlot({ storeRoot: root, sessionId: 'session-a', contentHash: slotContentHash('卡A'), at: T(21) });
    recordSlot({ storeRoot: root, sessionId: 'session-a', contentHash: slotContentHash('卡B'), at: T(22) });
    const raw = JSON.parse(readFileSync(path.join(root, INJECT_SLOT_LEDGER_FILE), 'utf8'));
    assert.equal(Object.keys(raw.slots).length, 1, '**覆盖同 slot，不追加新块**');
    assert.equal(slotSeen({ storeRoot: root, sessionId: 'session-a' }).seq, 2);
    assert.equal(slotSeen({ storeRoot: root, sessionId: 'session-a' }).contentHash, slotContentHash('卡B'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('S2 ⑤: 未知 version ⇒ 显式抛（不静默降级）；坏 JSON 同理', () => {
  const root = tmpDir('slot-bad');
  try {
    writeFileSync(path.join(root, INJECT_SLOT_LEDGER_FILE), JSON.stringify({ version: 999, slots: {} }), 'utf8');
    assert.throws(
      () => readSlotLedger({ storeRoot: root }),
      (err) => err instanceof SlotLedgerError && err.code === 'slot/unsupported-version',
      '不认识的版本必须抛 slot/unsupported-version',
    );
    writeFileSync(path.join(root, INJECT_SLOT_LEDGER_FILE), '{不是 JSON', 'utf8');
    assert.throws(
      () => readSlotLedger({ storeRoot: root }),
      (err) => err instanceof SlotLedgerError && err.code === 'slot/invalid',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('S2 ⑥: 没有 storeRoot ⇒ 写抛 slot/no-store（读给空账本，不炸）', () => {
  assert.throws(() => writeSlotLedger({ storeRoot: '', ledger: emptySlotLedger() }), (err) => err.code === 'slot/no-store');
  assert.deepEqual(readSlotLedger({ storeRoot: '' }), emptySlotLedger());
});

// ---------------------------------------------------------------------------
// 三、接线证据：真插件 + 真 store 跑 agent/pre-step
//
// 夹具与 test/plugin.test.mjs 同形（假 ctx / 假 session / 临时 store），但**只测去重这一条**。
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

function makeSession(cwd, id = 'session-test0001') {
  return { id, cwd, append: () => { throw new Error('棋院不写会话事件'); } };
}

const fakeCreateUserMessage = (input) => ({ id: `msg-${Math.random().toString(36).slice(2, 10)}`, role: 'user', ...input, __fake: true });
const userMessage = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const enterDecision = (messages) => ({ kind: 'enter', messages, meta: { tagged: true } });

/** 临时工作区 + 同域临时记忆库（一局 + 一个主题 + 一条 antipattern claim，保证 walk 命中）。 */
function makeWorkspace(tag = 'ws') {
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
  enabled: true,
  shadow: false,
  autoBuild: false,
  now: T(24),
  limit: 5,
  budgetTokens: 500,
  createUserMessage: fakeCreateUserMessage,
  ...over,
});

const runHook = async (hooks, payload, decision) => {
  const hook = hooks[HOOK];
  assert.equal(typeof hook, 'function', 'apply() 必须挂上 agent/pre-step');
  return hook(payload, async () => decision);
};

const ledgerRows = (storeRoot) => {
  const file = path.join(storeRoot, INJECT_SLOT_LEDGER_FILE);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
};

test('S3 ①: 同 session 第二次 pre-step ⇒ **注入为空**，账本只留一条记录', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace('s3a');
  try {
    const { ctx, hooks } = makeCtx();
    apply(ctx, baseConfig({ storeRoot }));
    const session = makeSession(workspace, 'session-slot-aaaa');

    const a = await runHook(hooks, { agent: { session }, messages: [userMessage('yaml 装不上')] }, enterDecision([userMessage('yaml 装不上')]));
    assert.equal(a.messages.length, 2, '第一次应当注入（1 条用户消息 + 1 条卡）');

    const secondOriginal = enterDecision([userMessage('yaml 还是装不上')]);
    const b = await runHook(hooks, { agent: { session }, messages: [userMessage('yaml 还是装不上')] }, secondOriginal);
    assert.equal(b, secondOriginal, '同 session 第二次 pre-step 必须原样返回（注入为空）');

    const raw = ledgerRows(storeRoot);
    assert.ok(raw, '注入成功必须落账（sidecar 文件要在）');
    assert.equal(raw.version, INJECT_SLOT_LEDGER_VERSION);
    const rows = Object.values(raw.slots);
    assert.equal(rows.length, 1, '一个会话一个槽：只有一条记录');
    assert.equal(rows[0].slotId, INJECT_SLOT_ID);
    assert.equal(rows[0].seq, 1);
    assert.equal(rows[0].contentHash, slotContentHash(messageText(a.messages[1])), '记的必须是**实际投出去的正文**的 hash');
  } finally {
    cleanup();
  }
});

test('S3 ②: end-seed 后**重新 apply**（内存清空）⇒ 0 重复注入，且**不重建卡**', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace('s3b');
  try {
    // 第一段生命周期：注入一次，账本落盘
    const first = makeCtx();
    apply(first.ctx, baseConfig({ storeRoot }));
    const session1 = makeSession(workspace, 'session-slot-bbbb');
    const turn1 = [userMessage('yaml 装不上')];
    const a = await runHook(first.hooks, { agent: { session: session1 }, messages: turn1 }, enterDecision(turn1));
    assert.equal(a.messages.length, 2, '第一次应当注入');

    // 宿主 session/end-seed ⇒ 下一轮 agent 重建 ⇒ **重新 apply**（新实例，内存里什么都没有）
    const second = makeCtx();
    let buildCalls = 0;
    apply(second.ctx, baseConfig({
      storeRoot,
      deps: {
        buildMemoryCard: (input) => { buildCalls += 1; return buildMemoryCard(input); },
      },
    }));
    const session2 = makeSession(workspace, 'session-slot-bbbb'); // 同一个 session.id（宿主每步都可能换对象）
    const turn2 = [...a.messages, userMessage('yaml 装不上')]; // 卡还在上下文里，信号又来一次
    const b = await runHook(second.hooks, { agent: { session: session2 }, messages: turn2 }, enterDecision(turn2));

    assert.equal(b.messages, turn2, '必须原样返回同一个 messages 引用（不复制、不原地改）');
    assert.equal(b.messages.length, 3, '**0 重复**：卡已在上下文里 ⇒ 不许再投一条（重投会变成 4）');
    assert.equal(buildCalls, 0, '账本命中 ⇒ 连卡都不用重建（这是内存集合做不到的那一格）');
    assert.equal(Object.values(ledgerRows(storeRoot).slots).length, 1, '账本仍然只有一条');
  } finally {
    cleanup();
  }
});

test('S3 ③: 回滚开关 `KIFU_INJECT_SLOT_IDEMPOTENT=0` ⇒ 退回纯内存去重（同一场景要重建卡）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace('s3c');
  const prev = process.env[INJECT_SLOT_IDEMPOTENT_ENV];
  try {
    const first = makeCtx();
    apply(first.ctx, baseConfig({ storeRoot }));
    const session1 = makeSession(workspace, 'session-slot-cccc');
    const turn1 = [userMessage('yaml 装不上')];
    const a = await runHook(first.hooks, { agent: { session: session1 }, messages: turn1 }, enterDecision(turn1));
    assert.equal(a.messages.length, 2);

    process.env[INJECT_SLOT_IDEMPOTENT_ENV] = '0';
    const second = makeCtx();
    let buildCalls = 0;
    apply(second.ctx, baseConfig({
      storeRoot,
      deps: { buildMemoryCard: (input) => { buildCalls += 1; return buildMemoryCard(input); } },
    }));
    const session2 = makeSession(workspace, 'session-slot-cccc');
    const turn2 = [...a.messages, userMessage('yaml 装不上')];
    await runHook(second.hooks, { agent: { session: session2 }, messages: turn2 }, enterDecision(turn2));
    assert.equal(buildCalls, 1, '关掉槽位幂等 ⇒ 没有账本判据，只能重建卡（再由 T49 的正文比对兜住）');
  } finally {
    if (prev === undefined) delete process.env[INJECT_SLOT_IDEMPOTENT_ENV];
    else process.env[INJECT_SLOT_IDEMPOTENT_ENV] = prev;
    cleanup();
  }
});

test('S3 ④: 卡被压缩掉（正文不在上下文）⇒ **仍然重投**（"必要重注"不退化），账本不因同内容而变', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace('s3d');
  try {
    const first = makeCtx();
    apply(first.ctx, baseConfig({ storeRoot }));
    const session1 = makeSession(workspace, 'session-slot-dddd');
    const turn1 = [userMessage('yaml 装不上')];
    const a = await runHook(first.hooks, { agent: { session: session1 }, messages: turn1 }, enterDecision(turn1));
    assert.equal(a.messages.length, 2);

    // 压缩后：卡消息没了（只剩用户原话 + 新信号）
    const second = makeCtx();
    apply(second.ctx, baseConfig({ storeRoot }));
    const session2 = makeSession(workspace, 'session-slot-dddd');
    const compacted = [userMessage('yaml 装不上'), userMessage('还是 yaml 装不上')];
    const b = await runHook(second.hooks, { agent: { session: session2 }, messages: compacted }, enterDecision(compacted));
    assert.equal(b.messages.length, 3, '卡不在上下文里 ⇒ 该重投（否则压缩后模型再也看不到它）');

    const rows = Object.values(ledgerRows(storeRoot).slots);
    assert.equal(rows.length, 1, '还是那一条（同 slot）');
    assert.equal(rows[0].seq, 1, '内容没变 ⇒ 不写账本（seq 不涨）：哈希相同就不记账');
  } finally {
    cleanup();
  }
});

test('S3 ⑤: 账本坏了（未知 version）⇒ 不炸、照常注入、留一次 warn（宁可多投不许吞卡）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace('s3e');
  try {
    writeFileSync(path.join(storeRoot, INJECT_SLOT_LEDGER_FILE), JSON.stringify({ version: 999, slots: {} }), 'utf8');
    const { ctx, hooks, warns } = makeCtx();
    apply(ctx, baseConfig({ storeRoot }));
    const session = makeSession(workspace, 'session-slot-eeee');
    const turn = [userMessage('yaml 装不上')];
    const a = await runHook(hooks, { agent: { session }, messages: turn }, enterDecision(turn));
    assert.equal(a.messages.length, 2, '账本坏了也必须照常注入（fail-open）');
    assert.ok(warns.some((w) => w.includes('槽位账本不可用')), `应当留一条 warn，实际：${warns.join(' | ')}`);
    // 第二次仍然不炸（同实例内存判据兜住）
    const second = enterDecision([userMessage('yaml 还是装不上')]);
    const b = await runHook(hooks, { agent: { session }, messages: [userMessage('yaml 还是装不上')] }, second);
    assert.equal(b, second, '同实例第二次仍被内存判据拦住');
  } finally {
    cleanup();
  }
});

// 与 `signalFromText` 的接线无关，但这里断言一次"搜索入口没被拆坏"（拆房后仍有同名导出）。
test('S3 ⑥: 拆房后 `signalFromText` / `buildMemoryCard` 仍从垫片可用（导出面一字不变）', () => {
  const signal = signalFromText('yaml 装不上', { at: T(21) });
  assert.equal(signal.kind, 'root-message');
  assert.ok(signal.terms.includes('yaml'));
  assert.equal(typeof buildMemoryCard, 'function');
});
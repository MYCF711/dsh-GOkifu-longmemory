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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CLAIM_EVIDENCE_FILE,
  CLAIM_EVIDENCE_IDEMPOTENT_ENV,
  CLAIM_EVIDENCE_MAX,
  CLAIM_EVIDENCE_VERSION,
  INJECT_SLOT_ID,
  INJECT_SLOT_IDEMPOTENT_ENV,
  INJECT_SLOT_LEDGER_FILE,
  INJECT_SLOT_LEDGER_VERSION,
  SLOT_LEDGER_MAX,
  SlotLedgerError,
  cardEvidenceItems,
  claimEvidenceEnabled,
  claimEvidenceKeyOf,
  claimIdentityOf,
  contextLineHashes,
  emptyClaimEvidenceLedger,
  emptySlotLedger,
  evidenceLineHash,
  evidencePresent,
  evidenceSeen,
  lookupEvidence,
  lookupSlot,
  planEvidenceWrite,
  planSlotWrite,
  pruneEvidenceLedger,
  pruneSlotLedger,
  readClaimEvidenceLedger,
  readSlotLedger,
  recordEvidence,
  recordSlot,
  restatedEvidenceOf,
  slotContentHash,
  slotContentPresent,
  slotIdempotencyEnabled,
  slotKeyOf,
  slotSeen,
  writeClaimEvidenceLedger,
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

// ---------------------------------------------------------------------------
// 四、P0-2 记忆侧去重：**内容身份** `(scopeKey, episodeId, seq, claimId)` + 持久化
//
// 为什么要有这一节（上游依据是代码级 + issue 级）：
//   · Mem0 现行 = `hashlib.md5(text)` 精确去重 + 只跟 `top_k=10` 检索结果比对 ⇒ issue #7123
//     「1 小时内同一事实 8 条近重复」：**文本哈希挡不住复述，top-k 窗口挡不住历史**。
//   · Cognee 用 `uuid5(内容)` 做内容寻址：幂等是**键**给的，不是窗口给的。
// 本仓的判据因此有两条硬要求：
//   ① 键是**来源身份**（不是文本）：同一 claim 的同一 seq 证据 ⇒ 命中；同文本不同 episode ⇒ 各自保留；
//   ② 判重窗口**只来自 sidecar 持久账本**（+ "那一行还在上下文里"这条机械事实），不吃本轮命中集合。
// -------------------------------

const EVID = { scope: 'w:d:/work/dedupe', epA: 'ep-aaaaaaa1', epB: 'ep-bbbbbbb2' };
const evLine = ({ ep = EVID.epA, seq = 11, marker = 'antipattern', body = 'Error: boom A', date = '2026-10-21' } = {}) =>
  `- [${marker}] ${body} (${ep}, ${date}, seq ${seq})`;

test('E1 ①: 身份键 = (scopeKey, episodeId, seq, claimId)，键里四个维度都可区分', () => {
  const base = { scopeKey: EVID.scope, episodeId: EVID.epA, seq: 11, claimId: 'c-dedupe11' };
  const key = claimEvidenceKeyOf(base);
  assert.equal(key, claimEvidenceKeyOf({ ...base }), '同一身份必须同键（判等的地基）');
  assert.equal(claimEvidenceKeyOf(base).split('\u001f').length, 4, '键由四段组成');
  // 任一个维度变了 ⇒ 另一个键（**这是与文本哈希的关键差别**：文本相同也能分开）
  assert.notEqual(claimEvidenceKeyOf({ ...base, scopeKey: 'w:d:/other' }), key, 'scope 参与身份');
  assert.notEqual(claimEvidenceKeyOf({ ...base, episodeId: EVID.epB }), key, 'episode 参与身份');
  assert.notEqual(claimEvidenceKeyOf({ ...base, seq: 12 }), key, 'seq 参与身份');
  assert.notEqual(claimEvidenceKeyOf({ ...base, claimId: 'c-dedupe12' }), key, 'claimId 参与身份');
  // 缺字段用**稳定占位符**（同一个"缺"永远同一个键，不随调用顺序变）
  assert.deepEqual(claimIdentityOf({ scopeKey: '', episodeId: EVID.epA, seq: 0, claimId: null }),
    { scopeKey: '-', episodeId: EVID.epA, seq: '-', claimId: '-' });
  assert.equal(claimEvidenceKeyOf({ scopeKey: '', episodeId: EVID.epA, seq: 0, claimId: null }),
    claimEvidenceKeyOf({ episodeId: EVID.epA }), '缺失字段归一后同一键');
  assert.equal(claimEvidenceKeyOf({}), '', 'episode 与 claim 都缺 ⇒ 定位不到来源 ⇒ 空键（不记账）');
});

test('E1 ②: 渲染行 hash 是纯函数（空白归一；空行不参与比对）', () => {
  const line = evLine();
  assert.equal(evidenceLineHash(line), evidenceLineHash(line), '同一行必须同 hash');
  assert.equal(evidenceLineHash(`  ${line}  `), evidenceLineHash(line), '首尾空白不算改内容');
  assert.equal(evidenceLineHash(line.replace(' ', '  ')), evidenceLineHash(line), '连续空白归一');
  assert.notEqual(evidenceLineHash(evLine({ seq: 12 })), evidenceLineHash(line), '**坐标不同 ⇒ 不同的行**（文本哈希会在这里撞上）');
  assert.equal(evidenceLineHash(''), '', '空行 ⇒ 空串（不进比对集合）');
  assert.equal(evidenceLineHash(null), '');
});

test('E1 ③: 记账计划：首次 created / 同行 unchanged（不换账本对象）/ 换行 overwritten（times+1）', () => {
  const identity = { scopeKey: EVID.scope, episodeId: EVID.epA, seq: 11, claimId: 'c-dedupe11' };
  const hash = evidenceLineHash(evLine());
  const first = planEvidenceWrite(emptyClaimEvidenceLedger(), { identity, lineHash: hash, at: T(21) });
  assert.equal(first.written, true);
  assert.equal(first.reason, 'evidence/created');
  assert.equal(first.entry.times, 1);
  assert.equal(Object.keys(first.ledger.identities).length, 1);

  const again = planEvidenceWrite(first.ledger, { identity, lineHash: hash, at: T(22) });
  assert.equal(again.written, false, '同一份证据同一渲染 ⇒ 一个字节都不写');
  assert.equal(again.reason, 'evidence/unchanged');
  assert.equal(again.ledger, first.ledger, '必须原样返回同一个账本对象（不新造）');

  const rerender = planEvidenceWrite(first.ledger, { identity, lineHash: evidenceLineHash(evLine({ marker: 'observed' })), at: T(23) });
  assert.equal(rerender.written, true);
  assert.equal(rerender.reason, 'evidence/overwritten');
  assert.equal(rerender.entry.times, 2, '同一份证据换了渲染 ⇒ 还是同一条身份，times+1');
  assert.equal(Object.keys(rerender.ledger.identities).length, 1, '**身份只有一条**（覆盖，不追加）');

  const noIdentity = planEvidenceWrite(first.ledger, { identity: {}, lineHash: hash, at: T(23) });
  assert.equal(noIdentity.written, false);
  assert.equal(noIdentity.reason, 'evidence/no-identity');
  const noHash = planEvidenceWrite(first.ledger, { identity, lineHash: '', at: T(23) });
  assert.equal(noHash.reason, 'evidence/no-hash');
  assert.equal(noHash.ledger, first.ledger);
});

test('E1 ④: "全卡都是复述"的判据：全命中 ⇒ true；有一条新证据 ⇒ false（fail-open）', () => {
  const lines = [evLine(), evLine({ seq: 12, marker: 'fact', body: 'node v23.8.0' })];
  const present = contextLineHashes([`MEMORY: …\n<memory-ledger>\n${lines.join('\n')}\n</memory-ledger>`]);
  assert.equal(present.size, 5, 'indexLine + 头行 + 两行证据 + 尾行都进集合（空行不进）');

  let ledger = emptyClaimEvidenceLedger();
  for (const seq of [11, 12]) {
    ledger = planEvidenceWrite(ledger, {
      identity: { scopeKey: EVID.scope, episodeId: EVID.epA, seq, claimId: `c-dedupe${seq}` },
      lineHash: evidenceLineHash(seq === 11 ? lines[0] : lines[1]),
      at: T(21),
    }).ledger;
  }
  const items = cardEvidenceItems({
    claims: [
      { line: lines[0], source: { episode: EVID.epA, seq: 11 }, claimId: 'c-dedupe11' },
      { line: lines[1], source: { episode: EVID.epA, seq: 12 }, claimId: 'c-dedupe12' },
    ],
  }, EVID.scope);
  assert.equal(items.length, 2);
  assert.deepEqual(restatedEvidenceOf(ledger, items, present), { restated: true, checked: 2, freshCount: 0, fresh: [] });

  // ① 有一条是新证据（账本里没有）⇒ 不是"全复述"
  const withNew = [...items, { ...claimIdentityOf({ scopeKey: EVID.scope, episodeId: EVID.epB, seq: 21, claimId: 'c-dedupe21' }), lineHash: evidenceLineHash(evLine({ ep: EVID.epB, seq: 21 })) }];
  const mixed = restatedEvidenceOf(ledger, withNew, present);
  assert.equal(mixed.restated, false);
  assert.equal(mixed.freshCount, 1, '只有那条新证据算 fresh');

  // ② **同文本不同来源** ⇒ 身份不同 ⇒ 不算复述（文本哈希会在这里误判）
  const sameTextOtherEpisode = [{
    ...claimIdentityOf({ scopeKey: EVID.scope, episodeId: EVID.epB, seq: 21, claimId: 'c-dedupe21' }),
    lineHash: evidenceLineHash(evLine()), // 正文与 c-dedupe11 **逐字相同**
  }];
  const crossEpisode = restatedEvidenceOf(ledger, sameTextOtherEpisode, present);
  assert.equal(crossEpisode.restated, false, '同文本不同 episode 不许判成重复');
  assert.equal(crossEpisode.freshCount, 1);

  // ③ 账本里有、但那一行**不在上下文里**（被压缩掉了）⇒ 不是复述（必要重注，不许拦）
  const compacted = restatedEvidenceOf(ledger, items, contextLineHashes([]));
  assert.equal(compacted.restated, false);
  assert.equal(compacted.freshCount, 2);
  assert.equal(restatedEvidenceOf(ledger, [], present).restated, false, '空卡不算复述（没有可投的东西）');
});

test('E1 ⑤: `cardEvidenceItems` 只收有行 + 有出处的行（无源不入：没行号/没 episode 的丢掉）', () => {
  const card = {
    claims: [
      { line: evLine(), source: { episode: EVID.epA, seq: 11 }, claimId: 'c-dedupe11' },
      { line: '', source: { episode: EVID.epA, seq: 12 } },                                  // 没行 ⇒ 丢
      { line: evLine({ seq: 12 }), source: {} },                                             // 没出处 ⇒ 丢
      { line: evLine({ ep: EVID.epB, seq: 21 }), source: { episode: EVID.epB, seq: 21 } },   // 无 claimId ⇒ 稳定键 '-'
    ],
  };
  const items = cardEvidenceItems(card, EVID.scope);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    scopeKey: EVID.scope,
    episodeId: EVID.epA,
    seq: 11,
    claimId: 'c-dedupe11',
    lineHash: evidenceLineHash(evLine()),
  });
  assert.equal(items[1].claimId, '-', '缺 claimId 用稳定占位符');
  assert.equal(cardEvidenceItems({ claims: [] }, EVID.scope).length, 0);
  assert.equal(cardEvidenceItems(null, EVID.scope).length, 0);
});

test('E2 ①: 身份账本落 sidecar（文件名/形状/原子写/与槽位账本互不干扰）', () => {
  const root = tmpDir('evid-rw');
  try {
    const items = [
      { scopeKey: EVID.scope, episodeId: EVID.epA, seq: 11, claimId: 'c-dedupe11', lineHash: evidenceLineHash(evLine()) },
      { scopeKey: EVID.scope, episodeId: EVID.epA, seq: 12, claimId: 'c-dedupe12', lineHash: evidenceLineHash(evLine({ seq: 12 })) },
    ];
    const out = recordEvidence({ storeRoot: root, items, at: T(21) });
    assert.equal(out.written, true);
    assert.equal(out.writtenCount, 2);
    assert.equal(out.path, path.join(root, CLAIM_EVIDENCE_FILE), '必须落在 <storeRoot>/claim-evidence.json');

    const raw = JSON.parse(readFileSync(path.join(root, CLAIM_EVIDENCE_FILE), 'utf8'));
    assert.equal(raw.version, CLAIM_EVIDENCE_VERSION);
    const key = claimEvidenceKeyOf({ scopeKey: EVID.scope, episodeId: EVID.epA, seq: 11, claimId: 'c-dedupe11' });
    assert.equal(raw.identities[key].episodeId, EVID.epA);
    assert.equal(raw.identities[key].seq, 11);
    assert.equal(raw.identities[key].claimId, 'c-dedupe11');
    assert.equal(raw.identities[key].times, 1);
    assert.equal(readdirSync(root).filter((n) => n.includes('.tmp-')).length, 0, '不许留临时文件');
    assert.equal(existsSync(path.join(root, INJECT_SLOT_LEDGER_FILE)), false, '两本账分文件：写身份账本不许碰槽位账本');

    // 幂等：重放同内容 ⇒ written:false 且文件**字节不变**
    const before = readFileSync(path.join(root, CLAIM_EVIDENCE_FILE));
    const replay = recordEvidence({ storeRoot: root, items, at: T(22) });
    assert.equal(replay.written, false, '同一批证据重复记账 ⇒ 不写');
    assert.equal(Buffer.compare(before, readFileSync(path.join(root, CLAIM_EVIDENCE_FILE))), 0, '文件必须逐字节不变');

    // I/O 版查询
    assert.equal(evidenceSeen({ storeRoot: root, identity: items[0] }).lineHash, items[0].lineHash);
    assert.equal(evidenceSeen({ storeRoot: root, identity: { scopeKey: EVID.scope, episodeId: EVID.epB, seq: 21, claimId: 'c-dedupe21' } }), null);
    // 淘汰上限（写死在小账本上验证机制，不改生产上限）
    const pruned = pruneEvidenceLedger(readClaimEvidenceLedger({ storeRoot: root }), 1);
    assert.equal(Object.keys(pruned.identities).length, 1);
    assert.equal(CLAIM_EVIDENCE_MAX, 4096, '生产上限（无界增长的最后一道闸）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E2 ②: 未知 version / 坏 JSON ⇒ 显式抛；没有 storeRoot ⇒ 写抛、读给空账本', () => {
  const root = tmpDir('evid-bad');
  try {
    writeFileSync(path.join(root, CLAIM_EVIDENCE_FILE), JSON.stringify({ version: 999, identities: {} }), 'utf8');
    assert.throws(
      () => readClaimEvidenceLedger({ storeRoot: root }),
      (err) => err instanceof SlotLedgerError && err.code === 'evidence/unsupported-version',
      '不认识的版本必须抛（不静默降级）',
    );
    writeFileSync(path.join(root, CLAIM_EVIDENCE_FILE), '{不是 JSON', 'utf8');
    assert.throws(() => readClaimEvidenceLedger({ storeRoot: root }), (err) => err.code === 'evidence/invalid');
    assert.throws(() => writeClaimEvidenceLedger({ storeRoot: '', ledger: emptyClaimEvidenceLedger() }), (err) => err.code === 'evidence/no-store');
    assert.deepEqual(readClaimEvidenceLedger({ storeRoot: '' }), emptyClaimEvidenceLedger());
    // 空账本本身就是"没记过任何东西"（首次运行不是错误）
    assert.deepEqual(readClaimEvidenceLedger({ storeRoot: tmpDir('evid-empty') }), emptyClaimEvidenceLedger());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E2 ③: 回滚开关只认 "0" / "false"（未设置 = 开启）', () => {
  assert.equal(claimEvidenceEnabled({}), true, '未设置 ⇒ 新行为');
  assert.equal(claimEvidenceEnabled({ [CLAIM_EVIDENCE_IDEMPOTENT_ENV]: '1' }), true);
  assert.equal(claimEvidenceEnabled({ [CLAIM_EVIDENCE_IDEMPOTENT_ENV]: '0' }), false);
  assert.equal(claimEvidenceEnabled({ [CLAIM_EVIDENCE_IDEMPOTENT_ENV]: 'FALSE' }), false);
  assert.notEqual(CLAIM_EVIDENCE_IDEMPOTENT_ENV, INJECT_SLOT_IDEMPOTENT_ENV, '两档去重各有独立开关');
});

// ---------------------------------------------------------------------------
// 五、接线证据：真插件 + 真 store，按**内容身份**判重（跨 apply / 跨重启）
//
// 夹具与第三节同形（假 ctx / 假 session / 临时 store），但命中用**可控制的 walk** 喂进去：
// 这样每一轮的命中集合（top-k 窗口）都是写死的，能证明"判重窗口不是本轮命中"。
// ---------------------------------------------------------------------------

/** 一局的标准形状（与 test/plugin.test.mjs 的夹具同形）。 */
const dedupeEpisode = (id, { day, seqFrom, failures }) => ({
  id,
  sessionId: `session-${id.slice(3)}`,
  scopeKey: null, // 调用方补（= 临时工作区的 scopeKey）
  startedAt: T(day),
  endedAt: T(day) + 3_600_000,
  firstEventAt: T(day),
  lastEventAt: T(day) + 3_600_000,
  recordedAt: T(day),
  closure: { logPath: 'sessions/a/x/session.v4.jsonl.zstd', graphPath: 'graphs/a/graph.json', seqFrom, seqTo: 99 },
  l0: '',
  signals: { failures, successes: 0, unsettled: 0, constraints: 0, tools: [] },
  threadIds: [],
  state: 'archived',
});

/** 一条 claim（support 与 hit 的 (episode, seq) 对齐 ⇒ 卡上成 claim 行，带 claimId）。 */
const dedupeClaim = ({ id, kind, text, episode, seq, quote, day, scopeKey }) => ({
  id,
  kind,
  text,
  scopeKey,
  threadIds: [],
  state: 'observed',
  support: [{ episode, seq, quote, occurredAt: T(day) }],
  counter: [],
  validity: { type: 'none', value: null },
  preconditions: [],
  occurredAt: T(day),
  recordedAt: T(day),
  counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null },
  supersedes: null,
});

/**
 * 去重专用夹具：
 *   ep-a（seqFrom 11）上两条 claim（c-dedupe11 / c-dedupe12，两条**不同正文**的证据）；
 *   ep-b（seqFrom 21）上一条 claim（c-dedupe21，正文与 c-dedupe11 **逐字相同**、仅来源不同）。
 */
function makeDedupeWorkspace(tag = 'dedupe') {
  const workspace = mkdtempSync(path.join(tmpdir(), `kifuin-${tag}-`));
  const storeRoot = mkdtempSync(path.join(tmpdir(), `kifuin-${tag}-store-`));
  const scope = scopeKeyFromPath(workspace);
  const store = createStore({ root: storeRoot, now: T(20) });
  store.ensureDirs();
  store.putMany('episodes', [
    { ...dedupeEpisode('ep-aaaaaaa1', { day: 21, seqFrom: 11, failures: 3 }), scopeKey: scope },
    { ...dedupeEpisode('ep-bbbbbbb2', { day: 22, seqFrom: 21, failures: 1 }), scopeKey: scope },
  ]);
  store.replaceDerived('topics', [
    { id: 't:term:yaml0001', kind: 'term', key: 'yaml', df: 1, idfNorm: 0.7, firstSeenAt: T(21), lastSeenAt: T(21), episodes: ['ep-aaaaaaa1'] },
    { id: 't:term:zod00002', kind: 'term', key: 'zod', df: 1, idfNorm: 0.7, firstSeenAt: T(22), lastSeenAt: T(22), episodes: ['ep-bbbbbbb2'] },
  ], { at: T(24) });
  store.putMany('claims', [
    dedupeClaim({ id: 'c-dedupe11', kind: 'antipattern', text: "Cannot find module 'yaml'", episode: 'ep-aaaaaaa1', seq: 11, quote: 'Error: boom A', day: 21, scopeKey: scope }),
    dedupeClaim({ id: 'c-dedupe12', kind: 'fact', text: 'package.json requires node >=23.8', episode: 'ep-aaaaaaa1', seq: 12, quote: 'node v23.8.0', day: 21, scopeKey: scope }),
    // **同文本、同原文、只换来源**：身份不同 ⇒ 不许被当成重复。
    dedupeClaim({ id: 'c-dedupe21', kind: 'antipattern', text: "Cannot find module 'yaml'", episode: 'ep-bbbbbbb2', seq: 21, quote: 'Error: boom A', day: 22, scopeKey: scope }),
  ]);
  return {
    workspace,
    storeRoot,
    scope,
    cleanup: () => {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(storeRoot, { recursive: true, force: true });
    },
  };
}

/** 一条 hit（与 R11 walk 的形态一致：**必须带 scopeKey**，否则会被作用域闸当"未知"丢掉）。 */
const dedupeHit = ({ episode, seq, scopeKey, why = ['yaml'], kind = 'failure', day = 21 }) => ({
  episode,
  nodeId: null,
  link: null,
  why,
  weight: 1,
  occurredAt: T(day),
  kind,
  seq,
  depth: 1,
  scopeKey,
});

/** 固定窗（本轮 top-k）的 walk：命中集合由调用方写死，不看库。 */
const fixedWalk = (hits) => () => ({ hits: hits.map((h) => ({ ...h })), path: [], omitted: { count: 0, reason: '' }, tokens: 0, depth: 1 });

const evidenceLedgerOf = (storeRoot) => {
  const file = path.join(storeRoot, CLAIM_EVIDENCE_FILE);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
};

test('E3 ①: 复述级重复 ⇒ 跳过（**跨 apply 重启用**，且卡正文不同——不是文本哈希能挡的那一格）', async () => {
  const { workspace, storeRoot, scope, cleanup } = makeDedupeWorkspace('e3a');
  try {
    // 第一段生命周期：本轮窗口有 2 条命中 ⇒ 卡上 2 行，身份落盘
    const first = makeCtx();
    const hits = [
      dedupeHit({ episode: 'ep-aaaaaaa1', seq: 11, scopeKey: scope }),
      dedupeHit({ episode: 'ep-aaaaaaa1', seq: 12, scopeKey: scope, why: ['yaml'], kind: 'episode' }),
    ];
    apply(first.ctx, baseConfig({ storeRoot, oncePerSession: false, liveStats: true, deps: { walk: fixedWalk(hits) } }));
    const session1 = makeSession(workspace, 'session-evid-aaaa');
    const turn1 = [userMessage('yaml 装不上')];
    const a = await runHook(first.hooks, { agent: { session: session1 }, messages: turn1 }, enterDecision(turn1));
    assert.equal(a.messages.length, 2, '第一次应当注入（原 1 条 + 卡 1 条）');
    const rows = Object.values(evidenceLedgerOf(storeRoot).identities);
    assert.equal(rows.length, 2, '卡上两行 ⇒ 两条身份落盘');
    assert.deepEqual(rows.map((r) => r.seq).sort((x, y) => x - y), [11, 12]);

    // 第二个 turn：宿主重新 apply（内存清空）+ **本轮窗口只剩 1 条**（limit=1）+ 卡正文必然与第一张不同
    const second = makeCtx();
    apply(second.ctx, baseConfig({ storeRoot, oncePerSession: false, liveStats: true, limit: 1, deps: { walk: fixedWalk(hits) } }));
    const session2 = makeSession(workspace, 'session-evid-aaaa'); // 同一个 session.id
    const turn2 = [...a.messages, userMessage('yaml 还是装不上')];
    const decision2 = enterDecision(turn2);
    const b = await runHook(second.hooks, { agent: { session: session2 }, messages: turn2 }, decision2);

    assert.equal(b, decision2, '全卡都是复述 ⇒ 原样返回（注入为空）');
    assert.equal(b.messages, turn2, '不许复制/原地改 messages');
    assert.equal(b.messages.length, 3, '**0 复述**：卡已在上下文里 ⇒ 不许再投一条');
    // 判重窗口来自持久账本：本轮窗口只有 1 条，账本里仍然是 2 条（没有被"本轮命中"重写）
    assert.equal(Object.values(evidenceLedgerOf(storeRoot).identities).length, 2, '账本不随本轮 top-k 缩水');
    // 理由可观测：走的是 T49 之外的新判据（`restated-evidence`），不是 `already-in-context`
    const stats = readFileSync(path.join(storeRoot, 'live-stats.jsonl'), 'utf8')
      .split(String.fromCharCode(10)).filter(Boolean).map((line) => JSON.parse(line));
    const restated = stats.filter((r) => r.reason === 'restated-evidence');
    assert.equal(restated.length, 1, `必须有且只有一条 restated-evidence 心跳，实际：${JSON.stringify(stats.map((s) => s.reason))}`);
    assert.equal(restated[0].action, 'skip');
  } finally {
    cleanup();
  }
});

test('E3 ⑥: **真重启**（另一个进程）也生效：子进程只读 sidecar 账本就判出"全复述"', async () => {
  const { workspace, storeRoot, scope, cleanup } = makeDedupeWorkspace('e3f');
  try {
    const hits = [
      dedupeHit({ episode: 'ep-aaaaaaa1', seq: 11, scopeKey: scope }),
      dedupeHit({ episode: 'ep-aaaaaaa1', seq: 12, scopeKey: scope }),
    ];
    const { ctx, hooks } = makeCtx();
    apply(ctx, baseConfig({ storeRoot, oncePerSession: false, deps: { walk: fixedWalk(hits) } }));
    const session = makeSession(workspace, 'session-evid-ffff');
    const turn = [userMessage('yaml 装不上')];
    const a = await runHook(hooks, { agent: { session }, messages: turn }, enterDecision(turn));
    assert.equal(a.messages.length, 2, '第一次应当注入');

    // 另一个 node 进程：只读 `<storeRoot>/claim-evidence.json` + 上下文里的卡正文，独立复算判据。
    const modulePath = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'rooms', 'inject-slot.mjs')).href;
    const items = [
      { scopeKey: scope, episodeId: 'ep-aaaaaaa1', seq: 11, claimId: 'c-dedupe11' },
      { scopeKey: scope, episodeId: 'ep-aaaaaaa1', seq: 12, claimId: 'c-dedupe12' },
    ];
    const script = [
      `const m = await import(${JSON.stringify(modulePath)});`,
      `const ledger = m.readClaimEvidenceLedger({ storeRoot: ${JSON.stringify(storeRoot)} });`,
      `const lines = m.contextLineHashes([${JSON.stringify(messageText(a.messages[1]))}]);`,
      `const items = ${JSON.stringify(items)};`,
      'console.log(JSON.stringify({ entries: Object.keys(ledger.identities).length, verdict: m.restatedEvidenceOf(ledger, items, lines) }));',
    ].join(String.fromCharCode(10));
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000 }).trim();
    const parsed = JSON.parse(out.split(String.fromCharCode(10)).pop());
    assert.equal(parsed.entries, 2, '子进程读到的账本里有两条身份（跨进程 = 跨重启）');
    assert.equal(parsed.verdict.restated, true, '子进程独立复算：全卡都是复述');
    assert.equal(parsed.verdict.freshCount, 0);
  } finally {
    cleanup();
  }
});

test('E3 ②: tombstone —— 删掉持久账本 ⇒ 同一场景**照常注入**（去重只能来自落盘的身份，不能来自内存）', async () => {
  const { workspace, storeRoot, scope, cleanup } = makeDedupeWorkspace('e3b');
  try {
    const hits = [
      dedupeHit({ episode: 'ep-aaaaaaa1', seq: 11, scopeKey: scope }),
      dedupeHit({ episode: 'ep-aaaaaaa1', seq: 12, scopeKey: scope }),
    ];
    const first = makeCtx();
    apply(first.ctx, baseConfig({ storeRoot, oncePerSession: false, deps: { walk: fixedWalk(hits) } }));
    const session1 = makeSession(workspace, 'session-evid-bbbb');
    const turn1 = [userMessage('yaml 装不上')];
    const a = await runHook(first.hooks, { agent: { session: session1 }, messages: turn1 }, enterDecision(turn1));
    assert.equal(a.messages.length, 2);

    // 持久账本被删（= 没有这份落盘身份）
    rmSync(path.join(storeRoot, CLAIM_EVIDENCE_FILE), { force: true });
    assert.equal(evidenceLedgerOf(storeRoot), null);

    const second = makeCtx();
    apply(second.ctx, baseConfig({ storeRoot, oncePerSession: false, limit: 1, deps: { walk: fixedWalk(hits) } }));
    const session2 = makeSession(workspace, 'session-evid-bbbb');
    const turn2 = [...a.messages, userMessage('yaml 还是装不上')];
    const b = await runHook(second.hooks, { agent: { session: session2 }, messages: turn2 }, enterDecision(turn2));
    assert.notEqual(b, turn2, '账本没了 ⇒ 必须照常注入（去重窗口不能是本轮命中，也不能是内存）');
    assert.equal(b.messages.length, 4, '原 3 条 + 新卡 1 条');
    // 同时证明：这一轮**不是**被 T49（正文逐字相同）挡住的——第二张卡的正文与第一张不同
    assert.notEqual(messageText(b.messages[3]), messageText(a.messages[1]), '第二张卡正文与第一张不同（所以只能靠身份判据挡）');
    // 注入后账本重建：只记这一轮真的投出去的那一行
    assert.equal(Object.values(evidenceLedgerOf(storeRoot).identities).length, 1);
  } finally {
    cleanup();
  }
});

test('E3 ③: 同文本不同 episode ⇒ **各自保留**（文本哈希会误判成重复的那一格）', async () => {
  const { workspace, storeRoot, scope, cleanup } = makeDedupeWorkspace('e3c');
  try {
    // 第一轮：只命中 ep-a 那条（c-dedupe11），卡上一行
    const first = makeCtx();
    apply(first.ctx, baseConfig({ storeRoot, oncePerSession: false, deps: { walk: fixedWalk([dedupeHit({ episode: 'ep-aaaaaaa1', seq: 11, scopeKey: scope })]) } }));
    const session1 = makeSession(workspace, 'session-evid-cccc');
    const turn1 = [userMessage('yaml 装不上')];
    const a = await runHook(first.hooks, { agent: { session: session1 }, messages: turn1 }, enterDecision(turn1));
    assert.equal(a.messages.length, 2);
    assert.ok(messageText(a.messages[1]).includes('ep-aaaaaaa1'), '卡上第一行走 ep-a');

    // 第二轮：只命中 ep-b 那条（c-dedupe21）——**claim 正文与第一轮逐字相同**，只是来源不同
    const second = makeCtx();
    apply(second.ctx, baseConfig({ storeRoot, oncePerSession: false, deps: { walk: fixedWalk([dedupeHit({ episode: 'ep-bbbbbbb2', seq: 21, scopeKey: scope })]) } }));
    const session2 = makeSession(workspace, 'session-evid-cccc');
    const turn2 = [...a.messages, userMessage('换成 zod 那个项目又炸了')];
    const b = await runHook(second.hooks, { agent: { session: session2 }, messages: turn2 }, enterDecision(turn2));

    assert.notEqual(b, turn2, '同文本不同来源 ⇒ 不许判成重复 ⇒ 必须注入');
    assert.equal(b.messages.length, 4, '原 3 条 + 新卡 1 条');
    const cardText2 = messageText(b.messages[3]);
    assert.ok(cardText2.includes('ep-bbbbbbb2'), '第二张卡带的是 ep-b 的出处');
    assert.ok(!cardText2.includes('ep-aaaaaaa1'), '不是把 ep-a 那一行再复述一遍');

    // 两轮的身份都在账本里（同文本、两个来源各自一条）
    const rows = Object.values(evidenceLedgerOf(storeRoot).identities);
    assert.equal(rows.length, 2, '同文本不同来源 ⇒ 两个身份各自记账');
    assert.deepEqual(rows.map((r) => r.episodeId).sort(), ['ep-aaaaaaa1', 'ep-bbbbbbb2']);
    assert.deepEqual(rows.map((r) => r.claimId).sort(), ['c-dedupe11', 'c-dedupe21']);
  } finally {
    cleanup();
  }
});

test('E3 ④: 回滚开关 `KIFU_CLAIM_EVIDENCE_IDEMPOTENT=0` ⇒ 这一档去重关掉（槽位账本不受影响）', async () => {
  const { workspace, storeRoot, scope, cleanup } = makeDedupeWorkspace('e3d');
  const prev = process.env[CLAIM_EVIDENCE_IDEMPOTENT_ENV];
  try {
    const hits = [
      dedupeHit({ episode: 'ep-aaaaaaa1', seq: 11, scopeKey: scope }),
      dedupeHit({ episode: 'ep-aaaaaaa1', seq: 12, scopeKey: scope }),
    ];
    const first = makeCtx();
    apply(first.ctx, baseConfig({ storeRoot, oncePerSession: false, deps: { walk: fixedWalk(hits) } }));
    const session1 = makeSession(workspace, 'session-evid-dddd');
    const turn1 = [userMessage('yaml 装不上')];
    const a = await runHook(first.hooks, { agent: { session: session1 }, messages: turn1 }, enterDecision(turn1));
    assert.equal(a.messages.length, 2);

    process.env[CLAIM_EVIDENCE_IDEMPOTENT_ENV] = '0';
    const second = makeCtx();
    apply(second.ctx, baseConfig({ storeRoot, oncePerSession: false, limit: 1, deps: { walk: fixedWalk(hits) } }));
    const session2 = makeSession(workspace, 'session-evid-dddd');
    const turn2 = [...a.messages, userMessage('yaml 还是装不上')];
    const b = await runHook(second.hooks, { agent: { session: session2 }, messages: turn2 }, enterDecision(turn2));
    assert.equal(b.messages.length, 4, '关掉 ⇒ 没有身份判据 ⇒ 照常注入（行为回到 P0-2 之前）');
  } finally {
    if (prev === undefined) delete process.env[CLAIM_EVIDENCE_IDEMPOTENT_ENV];
    else process.env[CLAIM_EVIDENCE_IDEMPOTENT_ENV] = prev;
    cleanup();
  }
});

test('E3 ⑤: 身份账本坏了（未知 version）⇒ 不炸、照常注入、留一次 warn（宁可多投不许吞卡）', async () => {
  const { workspace, storeRoot, scope, cleanup } = makeDedupeWorkspace('e3e');
  try {
    writeFileSync(path.join(storeRoot, CLAIM_EVIDENCE_FILE), JSON.stringify({ version: 999, identities: {} }), 'utf8');
    const { ctx, hooks, warns } = makeCtx();
    apply(ctx, baseConfig({ storeRoot, oncePerSession: false, deps: { walk: fixedWalk([dedupeHit({ episode: 'ep-aaaaaaa1', seq: 11, scopeKey: scope })]) } }));
    const session = makeSession(workspace, 'session-evid-eeee');
    const turn = [userMessage('yaml 装不上')];
    const a = await runHook(hooks, { agent: { session }, messages: turn }, enterDecision(turn));
    assert.equal(a.messages.length, 2, '账本坏了也必须照常注入（fail-open）');
    assert.ok(warns.some((w) => w.includes('内容身份账本')), `应当留一条 warn，实际：${warns.join(' | ')}`);
    // 记账失败也不许影响本轮（卡已经投出去了）
    assert.equal(a.messages.length, 2);
  } finally {
    cleanup();
  }
});
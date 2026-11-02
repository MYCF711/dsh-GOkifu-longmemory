// R16 plugin（宿主入口 · agent/pre-step）的 tombstone test：删掉 src/plugin.mjs ⇒ 本文件整片红。
//
// 覆盖（任务书 T9 的六个场景 + 边界）：
//   1. 没有记忆库 ⇒ 原 decision 原样返回（**引用相等**）
//   2. 有命中 ⇒ 注入一条 user 消息：source.kind = "dsh-kifuin"、文本含 indexLine
//   3. 同一会话第二次 ⇒ 不再注入（WeakSet）
//   4. buildMemoryCard 抛错 ⇒ 原 decision + `ctx.logger.warn` 被记录（失败不阻塞会话）
//   5. gates.ok === false ⇒ 不注入（降级为原 decision）
//   6. shadow:true ⇒ 不注入、写 evidence/shadow、原 decision
//   7. 默认配置（enabled:false, shadow:false）⇒ 什么都不做
//   8. decision.kind !== "enter" ⇒ 原样返回
//   9. **不写会话事件**：session.append 一次都没被调用；原数组不被原地改
//  10. 插入位置 = 最后一条 claimed 消息之后（与压缩插件同一语义，互不代管）
//  11. 宿主没有 @deepseek-ai/dsh-llm 且没给替身 ⇒ 安静跳过 + warn（这里真的没有那个包）
//  12. 纯函数：messageText / lastUserText / digestOf / insertAfterClaimed / cardText / sanitizeConfig

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CARD_SOURCE_FORM,
  CARD_SOURCE_KIND,
  DEFAULT_CONFIG,
  HOOK,
  PLUGIN_VERSION,
  apply,
  cardText,
  digestOf,
  insertAfterClaimed,
  lastUserText,
  messageText,
  name,
  sanitizeConfig,
} from '../src/plugin.mjs';
import { scopeKeyFromPath } from '../src/rooms/inject.mjs';
import { createStore } from '../src/rooms/persist.mjs';

const T = (day) => Date.UTC(2026, 9, day, 12, 0, 0); // 2026-10-DD

// ---------------------------------------------------------------------------
// 夹具：假 ctx / 假 session / 临时记忆库 / 假 createUserMessage
// ---------------------------------------------------------------------------

function makeCtx() {
  const hooks = {};
  const warns = [];
  const ctx = {
    logger: {
      warn: (line) => warns.push(String(line)),
      info: () => {},
      debug: () => {},
    },
    on: (event, handler) => {
      hooks[event] = handler;
    },
  };
  return { ctx, hooks, warns };
}

/** 假 session：`append` 一旦被调用就记下来（用来证明"不写会话事件"）。 */
function makeSession(cwd) {
  const appended = [];
  const session = {
    id: 'session-test0001',
    cwd,
    append: (...args) => {
      appended.push(args);
      throw new Error('棋院不写会话事件');
    },
  };
  return { session, appended };
}

/** 假消息构造器（替身；真实宿主里是 @deepseek-ai/dsh-llm 的 createUserMessage）。 */
function fakeCreateUserMessage(input) {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    role: 'user',
    ...input,
    __fake: true,
  };
}

const userMessage = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const enterDecision = (messages) => ({ kind: 'enter', messages, meta: { tagged: true } });

/** 临时工作区 + 与之同域的临时记忆库（含主题/棋谱/claim，保证 walk 能命中）。 */
function makeWorkspace() {
  const workspace = mkdtempSync(path.join(tmpdir(), 'kifuin-ws-'));
  const storeRoot = mkdtempSync(path.join(tmpdir(), 'kifuin-store-'));
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
  return { workspace, storeRoot, scope, cleanup: () => { rmSync(workspace, { recursive: true, force: true }); rmSync(storeRoot, { recursive: true, force: true }); } };
}

/** 跑一次 pre-step：返回 hook 的返回值（= 宿主拿到的 decision）。 */
async function runHook({ hooks, payload, decision }) {
  const hook = hooks[HOOK];
  assert.equal(typeof hook, 'function', 'apply() 必须挂上 agent/pre-step');
  return hook(payload, async () => decision);
}

const baseConfig = (over = {}) => ({
  enabled: true,
  shadow: false,
  autoBuild: false, // 测试里不真的建库（autoBuild 会写盘并跑 14s 归档）
  now: T(24),
  limit: 5,
  budgetTokens: 500,
  createUserMessage: fakeCreateUserMessage,
  ...over,
});

// ---------------------------------------------------------------------------
// 1. 没有记忆库 ⇒ 原 decision（引用相等）
// ---------------------------------------------------------------------------

test('R16: 没有记忆库 ⇒ 原 decision 原样返回（引用相等），并且记一条 warn', async () => {
  const { ctx, hooks, warns } = makeCtx();
  const { session } = makeSession(mkdtempSync(path.join(tmpdir(), 'kifuin-nows-')));
  const res = apply(ctx, baseConfig({ storeRoot: path.join(tmpdir(), 'kifuin-missing-store-xyz') }));
  assert.equal(res.registered, true);

  const original = enterDecision([userMessage('yaml 装不上')]);
  const out = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 装不上')] }, decision: original });

  assert.equal(out, original, '必须是同一个对象（引用相等）');
  assert.ok(warns.some((w) => w.includes('记忆库不存在')), `应当记录 warn，实际：${warns.join(' | ')}`);
});

// ---------------------------------------------------------------------------
// 2. 有命中 ⇒ 注入一条
// ---------------------------------------------------------------------------

test('R16: 有命中 ⇒ 注入一条 user 消息（source.kind="dsh-kifuin"、文本含 indexLine）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  try {
    const { ctx, hooks } = makeCtx();
    const { session, appended } = makeSession(workspace);
    apply(ctx, baseConfig({ storeRoot }));

    const claimed = [userMessage('yaml 装不上')];
    const original = enterDecision([...claimed]);
    const out = await runHook({ hooks, payload: { agent: { session }, messages: claimed }, decision: original });

    assert.notEqual(out, original, '注入后必须是新 decision');
    assert.equal(out.kind, 'enter');
    assert.equal(out.messages.length, 2, '原 1 条 + 注入 1 条');
    const injected = out.messages[1];
    assert.equal(injected.role, 'user');
    assert.equal(injected.source.kind, CARD_SOURCE_KIND);
    assert.equal(injected.source.form, CARD_SOURCE_FORM);
    assert.equal(injected.source.pluginVersion, PLUGIN_VERSION);
    assert.match(injected.source.digest, /^[0-9a-f]{16}$/);

    const text = messageText(injected);
    assert.ok(text.includes('MEMORY:'), '文本里要有首轮那一行 INDEX 指针');
    assert.ok(text.includes('<memory-ledger>'), '命中就要展开');
    assert.ok(text.includes('ep-aaaaaaa1'), '展开行要带出处');
    assert.ok(text.includes('2026-10-21'), '展开行要带绝对日期');

    // 原数组没被原地改；也没写会话事件
    assert.equal(original.messages.length, 1, '原 decision.messages 不许被原地修改');
    assert.equal(appended.length, 0, '不许调用 session.append');
    assert.equal(out.meta.tagged, true, '其余字段原样透传');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. 每会话只注入一次
// ---------------------------------------------------------------------------

test('R16: 同一会话第二次调用 ⇒ 不再注入（WeakSet 记住这个 session）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  try {
    const { ctx, hooks } = makeCtx();
    const { session } = makeSession(workspace);
    apply(ctx, baseConfig({ storeRoot }));
    const payload = { agent: { session }, messages: [userMessage('yaml 装不上')] };

    const first = await runHook({ hooks, payload, decision: enterDecision([userMessage('yaml 装不上')]) });
    assert.equal(first.messages.length, 2, '第一次应当注入');

    const secondOriginal = enterDecision([userMessage('yaml 还是装不上')]);
    const second = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 还是装不上')] }, decision: secondOriginal });
    assert.equal(second, secondOriginal, '第二次必须原样返回');

    // 换一个会话（新对象）⇒ 又能注入
    const other = makeSession(workspace).session;
    const third = await runHook({ hooks, payload: { agent: { session: other }, messages: [userMessage('yaml 装不上')] }, decision: enterDecision([userMessage('yaml 装不上')]) });
    assert.equal(third.messages.length, 2, '新会话仍然只注入一次');
  } finally {
    cleanup();
  }
});

test('R16: oncePerSession:false ⇒ 每步都能注入（配置可关掉这条限流）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  try {
    const { ctx, hooks } = makeCtx();
    const { session } = makeSession(workspace);
    apply(ctx, baseConfig({ storeRoot, oncePerSession: false }));
    const payload = { agent: { session }, messages: [userMessage('yaml 装不上')] };
    const a = await runHook({ hooks, payload, decision: enterDecision([userMessage('yaml 装不上')]) });
    const b = await runHook({ hooks, payload, decision: enterDecision([userMessage('yaml 装不上')]) });
    assert.equal(a.messages.length, 2);
    assert.equal(b.messages.length, 2);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. 构建抛错 ⇒ 原 decision + warn
// ---------------------------------------------------------------------------

test('R16: buildMemoryCard 抛错 ⇒ 原 decision + warn 被记录（失败不阻塞会话）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  try {
    const { ctx, hooks, warns } = makeCtx();
    const { session, appended } = makeSession(workspace);
    apply(ctx, baseConfig({
      storeRoot,
      deps: {
        buildMemoryCard: () => {
          throw new Error('boom: 构建炸了');
        },
      },
    }));

    const original = enterDecision([userMessage('yaml 装不上')]);
    const out = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 装不上')] }, decision: original });

    assert.equal(out, original, '异常时必须原样返回');
    assert.ok(warns.some((w) => w.includes('注入失败') && w.includes('boom')), `warn 内容：${warns.join(' | ')}`);
    assert.equal(appended.length, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. 闸门不过 ⇒ 不注入
// ---------------------------------------------------------------------------

test('R16: gates.ok === false ⇒ 不注入、原 decision、并记 warn', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  try {
    const { ctx, hooks, warns } = makeCtx();
    const { session } = makeSession(workspace);
    apply(ctx, baseConfig({
      storeRoot,
      deps: {
        runGates: () => ({ ok: false, errors: [{ gate: '0', code: 'gate0/missing-seq', detail: null }], checks: {} }),
      },
    }));

    const original = enterDecision([userMessage('yaml 装不上')]);
    const out = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 装不上')] }, decision: original });

    assert.equal(out, original, '闸门不过就不注入');
    assert.ok(warns.some((w) => w.includes('闸门未通过') && w.includes('gate0/missing-seq')), warns.join(' | '));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. shadow ⇒ 不注入 + 写记录
// ---------------------------------------------------------------------------

test('R16: shadow:true ⇒ 不注入、写 evidence/shadow、原 decision', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  const shadowDir = mkdtempSync(path.join(tmpdir(), 'kifuin-shadow-'));
  try {
    const { ctx, hooks } = makeCtx();
    const { session, appended } = makeSession(workspace);
    apply(ctx, baseConfig({ storeRoot, shadow: true, shadowDir }));

    const original = enterDecision([userMessage('yaml 装不上')]);
    const out = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 装不上')] }, decision: original });

    assert.equal(out, original, '影子模式必须原样返回');
    const file = path.join(shadowDir, 'shadow.jsonl');
    assert.equal(existsSync(file), true, '影子记录要落盘');
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.injected, false, '影子记录必须标 injected:false');
    assert.equal(record.mode, 'shadow');
    assert.ok(record.card.section.includes('<memory-ledger>'));
    assert.equal(appended.length, 0);

    // 同一会话再来一次：不重复写影子（每会话一次）
    await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 装不上')] }, decision: enterDecision([userMessage('yaml 装不上')]) });
    const again = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(again.length, 1, '同一会话只记一条');
  } finally {
    rmSync(shadowDir, { recursive: true, force: true });
    cleanup();
  }
});

test('R16: shadow 写不进去（目录在 $DSH_HOME 内）⇒ 不注入、不抛、warn', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  const home = path.join(tmpdir(), `fake-dsh-home-${process.pid}`);
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { ctx, hooks, warns } = makeCtx();
    const { session } = makeSession(workspace);
    apply(ctx, baseConfig({ storeRoot, shadow: true, shadowDir: path.join(home, 'evidence', 'shadow') }));

    const original = enterDecision([userMessage('yaml 装不上')]);
    const out = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 装不上')] }, decision: original });

    assert.equal(out, original);
    assert.ok(warns.some((w) => w.includes('影子记录写入失败')), warns.join(' | '));
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7/8. 默认关 & 非 enter
// ---------------------------------------------------------------------------

test('R16: 显式关掉（enabled:false）⇒ 什么都不做', async () => {
  assert.equal(DEFAULT_CONFIG.enabled, true, '零配置默认开（2026-11-02 主人裁定）');
  assert.equal(DEFAULT_CONFIG.shadow, false, '零配置默认真注入');
  assert.equal(DEFAULT_CONFIG.autoBuild, true, '零配置默认自动建库');

  const { ctx, hooks, warns } = makeCtx();
  const { session } = makeSession(tmpdir());
  apply(ctx, { enabled: false, shadow: false, createUserMessage: fakeCreateUserMessage });
  const original = enterDecision([userMessage('任意')]);
  const out = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('任意')] }, decision: original });
  assert.equal(out, original);
  assert.deepEqual(warns, [], '关掉的时候连 warn 都不该有');
});

test('R16: apply 默认参数 ⇒ 注册钩子且默认开启（无库时沉默）', async () => {
  const { ctx, hooks } = makeCtx();
  const res = apply(ctx);
  assert.equal(res.registered, true);
  assert.equal(res.config.enabled, true);
  assert.equal(typeof hooks[HOOK], 'function');
});

test('R16: decision.kind !== "enter" ⇒ 原样返回（不碰 messages）', async () => {
  const { ctx, hooks } = makeCtx();
  const { session } = makeSession(tmpdir());
  apply(ctx, baseConfig({ storeRoot: path.join(tmpdir(), 'nope-store-123') }));
  const decision = { kind: 'skip', messages: [userMessage('x')] };
  const out = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('x')] }, decision });
  assert.equal(out, decision);
});

test('R16: 没有 user 文本 ⇒ 不注入（signal 缺失就沉默）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  try {
    const { ctx, hooks } = makeCtx();
    const { session } = makeSession(workspace);
    apply(ctx, baseConfig({ storeRoot }));
    const original = enterDecision([]);
    const out = await runHook({ hooks, payload: { agent: { session }, messages: [] }, decision: original });
    assert.equal(out, original);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9/10. 不写会话事件 + 插入位置
// ---------------------------------------------------------------------------

test('R16: 注入位置 = 最后一条 claimed 消息之后（后面的非 claimed 消息保持在尾部）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  try {
    const { ctx, hooks } = makeCtx();
    const { session } = makeSession(workspace);
    apply(ctx, baseConfig({ storeRoot }));

    const a = userMessage('第一条');
    const b = userMessage('yaml 装不上');
    const tail = { role: 'user', content: [{ type: 'text', text: '非 claimed：后加的' }] };
    const claimed = [a, b];
    const original = enterDecision([a, b, tail]);
    const out = await runHook({ hooks, payload: { agent: { session }, messages: claimed }, decision: original });

    assert.equal(out.messages.length, 4);
    assert.equal(out.messages[0], a);
    assert.equal(out.messages[1], b);
    assert.equal(out.messages[2].source.kind, CARD_SOURCE_KIND, '插在最后一条 claimed（b）之后');
    assert.equal(out.messages[3], tail, '非 claimed 的消息仍在其后');
    // 原数组未变
    assert.deepEqual(original.messages.map((m) => m === tail), [false, false, true]);
  } finally {
    cleanup();
  }
});

test('R16: 宿主没有 @deepseek-ai/dsh-llm 且没给替身 ⇒ 安静跳过 + warn（本机确实没这个包）', async () => {
  const { workspace, storeRoot, cleanup } = makeWorkspace();
  try {
    const { ctx, hooks, warns } = makeCtx();
    const { session } = makeSession(workspace);
    apply(ctx, { enabled: true, shadow: false, storeRoot, now: T(24) }); // 故意不给 createUserMessage
    const original = enterDecision([userMessage('yaml 装不上')]);
    const out = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 装不上')] }, decision: original });
    assert.equal(out, original, '造不出消息就不注入，但绝不抛');
    assert.ok(warns.some((w) => w.includes('注入失败')), warns.join(' | '));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 12. 纯函数
// ---------------------------------------------------------------------------

test('R16: messageText / lastUserText 兼容三种消息形态', () => {
  assert.equal(messageText({ role: 'user', content: 'hi' }), 'hi');
  assert.equal(messageText({ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image', url: 'x' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(messageText({ role: 'user', content: { text: 'obj' } }), 'obj');
  assert.equal(messageText({ text: 'bare' }), 'bare');
  assert.equal(messageText(null), '');
  assert.equal(messageText({ role: 'user', content: [] }), '');

  assert.equal(lastUserText([userMessage('一'), { role: 'assistant', content: '二' }, userMessage('三')]), '三');
  assert.equal(lastUserText([{ role: 'assistant', content: '只有助手' }]), '');
  assert.equal(lastUserText([]), '');
  assert.equal(lastUserText(null), '');
});

test('R16: digestOf 同输入同输出、不同 scope/文本不同', () => {
  const a = digestOf('w:d:/x', 'MEMORY: a');
  const b = digestOf('w:d:/x', 'MEMORY: a');
  const c = digestOf('w:d:/y', 'MEMORY: a');
  const d = digestOf('w:d:/x', 'MEMORY: b');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});

test('R16: insertAfterClaimed 用引用判 claimed，且不改原数组', () => {
  const a = userMessage('a');
  const b = userMessage('b');
  const extra = userMessage('extra');
  const message = { role: 'user', injected: true };
  const messages = [a, b, extra];
  const out = insertAfterClaimed(messages, [a, b], message);
  assert.equal(out.length, 4);
  assert.equal(out[2], message);
  assert.equal(messages.length, 3, '原数组不变');

  // 只有 a 是 claimed ⇒ 插在 a 之后
  const out2 = insertAfterClaimed(messages, [a], message);
  assert.equal(out2[1], message);

  // 找不到 claimed ⇒ 插到开头之后（与上游 Math.max(lastClaimed,0)+1 一致）
  const out3 = insertAfterClaimed(messages, [], message);
  assert.equal(out3[1], message);

  assert.equal(insertAfterClaimed(null, [], message), null);
});

test('R16: cardText = indexLine + section；两条都缺就空串', () => {
  assert.equal(cardText({ indexLine: 'MEMORY: x', section: '<memory-ledger>y</memory-ledger>' }), 'MEMORY: x\n<memory-ledger>y</memory-ledger>');
  assert.equal(cardText({ indexLine: 'MEMORY: x', section: null }), 'MEMORY: x');
  assert.equal(cardText(null), '');
});

test('R16: sanitizeConfig 只认已知键、类型不对退回默认', () => {
  assert.deepEqual(sanitizeConfig(), { ...DEFAULT_CONFIG });
  const c = sanitizeConfig({ enabled: 'true', shadow: 'false', budgetTokens: 200, limit: '3', storeRoot: ' D:/x/ ', deps: { a: 1 }, createUserMessage: () => 'x' });
  assert.equal(c.enabled, true);
  assert.equal(c.shadow, false);
  assert.equal(c.budgetTokens, 200);
  assert.equal(c.limit, 3);
  assert.equal(c.storeRoot, 'D:/x/');
  assert.equal(typeof c.deps, 'object');
  assert.equal(typeof c.createUserMessage, 'function');
  // 垃圾值
  const bad = sanitizeConfig({ enabled: 123, budgetTokens: -5, limit: 'abc', storeRoot: 42, deps: 'nope', createUserMessage: 'nope' });
  assert.equal(bad.enabled, DEFAULT_CONFIG.enabled);
  assert.equal(bad.budgetTokens, DEFAULT_CONFIG.budgetTokens);
  assert.equal(bad.limit, DEFAULT_CONFIG.limit);
  assert.equal(bad.storeRoot, null);
  assert.equal(bad.deps, null);
  assert.equal(bad.createUserMessage, null);
});

test('R16: 插件名与常量（宿主靠它认人）', () => {
  assert.equal(name, 'dsh-gokifu-longmemory');
  assert.equal(HOOK, 'agent/pre-step');
  assert.equal(CARD_SOURCE_KIND, 'dsh-gokifu-longmemory');
  assert.equal(CARD_SOURCE_FORM, 'memory-card');
  assert.equal(PLUGIN_VERSION, 1);
});

// ---------------------------------------------------------------------------
// T12：闸 3 真核验接进注入路径（validity 核不过 ⇒ 不注入）
// ---------------------------------------------------------------------------

test('R16: 闸 3 真核验 —— validity 核不过 ⇒ 闸不过 ⇒ 不注入（probeValidity:false 才退回 unverified）', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'kifuin-ws-bad-'));
  const storeRoot = mkdtempSync(path.join(tmpdir(), 'kifuin-store-bad-'));
  try {
    const scope = scopeKeyFromPath(workspace);
    const store = createStore({ root: storeRoot, now: T(20) });
    store.ensureDirs();
    store.putMany('episodes', [{
      id: 'ep-badaaaa1', sessionId: 'session-badaaaa1', scopeKey: scope,
      startedAt: T(21), firstEventAt: T(21), lastEventAt: T(21), recordedAt: T(21),
      closure: { logPath: 'sessions/a/x/session.v4.jsonl.zstd', graphPath: 'graphs/a/graph.json', seqFrom: 11, seqTo: 99 },
      l0: 'demo', signals: { failures: 1, successes: 0, unsettled: 0, constraints: 0, tools: [] }, state: 'archived',
    }]);
    store.replaceDerived('topics', [{ id: 't:term:bad00001', kind: 'term', key: 'yaml', df: 2, idfNorm: 0.7, firstSeenAt: T(21), lastSeenAt: T(21), episodes: ['ep-badaaaa1'] }], { at: T(24) });
    store.putMany('claims', [{
      id: 'c-bad00001', kind: 'antipattern', text: "Cannot find module 'yaml'", scopeKey: scope, threadIds: [],
      state: 'observed', support: [{ episode: 'ep-badaaaa1', seq: 30, quote: 'Error: boom' }], counter: [],
      validity: { type: 'file', value: 'definitely-missing.yaml' }, preconditions: [],
      occurredAt: T(21), recordedAt: T(21), counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null }, supersedes: null,
    }]);

    // 默认 probeValidity=true ⇒ 真核验 ⇒ 核不过 ⇒ 闸 3 打回 ⇒ 不注入
    const a = makeCtx();
    apply(a.ctx, baseConfig({ storeRoot }));
    const original = enterDecision([userMessage('yaml 装不上')]);
    const out = await runHook({ hooks: a.hooks, payload: { agent: { session: makeSession(workspace).session }, messages: [userMessage('yaml 装不上')] }, decision: original });
    assert.equal(out, original, 'validity 核不过就不许注入');
    assert.ok(a.warns.some((w) => w.includes('gate3/')), a.warns.join(' | '));

    // probeValidity:false ⇒ 不核 ⇒ 闸 3 记 unverified ⇒ 照常注入（不假绿，但也不假红）
    const b = makeCtx();
    apply(b.ctx, baseConfig({ storeRoot, probeValidity: false }));
    const out2 = await runHook({ hooks: b.hooks, payload: { agent: { session: makeSession(workspace).session }, messages: [userMessage('yaml 装不上')] }, decision: enterDecision([userMessage('yaml 装不上')]) });
    assert.equal(out2.messages.length, 2, '不核验时行为与 T9 一致');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(storeRoot, { recursive: true, force: true });
  }
});

test('R16: storeRoot 支持 <DSH_HOME> / $DSH_HOME 占位符；无 home 时视为未配置', async () => {
  const { enforceStoreRoot } = await import('../src/plugin.mjs');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(tmpdir(), 'kifuin-home-placeholder');
  try {
    assert.equal(enforceStoreRoot('<DSH_HOME>/memory-context'), path.resolve(process.env.DSH_HOME, 'memory-context'));
    assert.equal(enforceStoreRoot('$DSH_HOME/memory-context'), path.resolve(process.env.DSH_HOME, 'memory-context'));
  } finally {
    delete process.env.DSH_HOME;
    assert.equal(enforceStoreRoot('<DSH_HOME>/memory-context'), null, '无 home 时占位符不可解析 ⇒ null（沉默，不猜路径）');
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  }
});

test('R16: 零配置自动建库 —— 库不存在时后台调 buildStore 一次，本次沉默', async () => {
  const { ctx, hooks, warns } = makeCtx();
  const { session } = makeSession(tmpdir());
  let calls = 0;
  const storeRoot = path.join(tmpdir(), `kifuin-autobuild-${process.pid}-${Date.now()}`);
  apply(ctx, baseConfig({
    storeRoot,
    autoBuild: true,
    deps: { buildStore: async () => { calls += 1; } },
  }));
  const original = enterDecision([userMessage('yaml 装不上')]);
  const out = await runHook({ hooks, payload: { agent: { session }, messages: [userMessage('yaml 装不上')] }, decision: original });
  assert.equal(out, original, '建库期间必须沉默');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 1, '后台应当只建一次');
  assert.ok(warns.some((w) => w.includes('记忆库不存在')), warns.join(' | '));
});

test('R16: 设置页 schema —— 暴露 storeRoot（记忆库地址）等字段，validate 归一化', async () => {
  const { Config } = await import('../src/plugin.mjs');
  const schema = Config.toJSON();
  assert.equal(schema.type, 'object');
  assert.ok(schema.dict.storeRoot, '必须暴露 storeRoot，GUI 才能选地址');
  assert.match(schema.dict.storeRoot.meta.description, /memory-context/);
  assert.equal(Config['~standard'].validate({ storeRoot: ' D:/mem ' }).value.storeRoot, 'D:/mem');
  assert.equal(Config['~standard'].validate({}).value.enabled, true);
  assert.equal(Config['~standard'].validate(null).value.shadow, false);
});

// D1（2026-11-02）：轮次收尾时按时间阈值增量刷新
test('D1: turn-stopping 在库过期时触发一次刷新，未过期不触发', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(path.join(tmpdir(), 'kifu-d1-'));
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ updatedAt: Date.now() - 2 * 3600 * 1000 }));

  const { ctx, hooks } = makeCtx();
  let calls = 0;
  const res = apply(ctx, baseConfig({
    storeRoot: root,
    autoArchive: true,
    autoArchiveMinutes: 30,
    deps: { buildStore: async () => { calls += 1; } },
  }));
  assert.equal(res.registered, true);
  assert.equal(typeof hooks['agent/turn-stopping'], 'function', '必须挂上 turn-stopping');

  await hooks['agent/turn-stopping']({});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1, '过期库应当刷新一次');

  // 未过期（刚写过未来时间）⇒ 不再触发
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ updatedAt: Date.now() + 3600 * 1000 }));
  await hooks['agent/turn-stopping']({});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1, '未过期不应刷新');
});

// D5（2026-11-02，主人批准）：同会话同类失败 ≥N 次 ⇒ 补一次事实卡
test('D5: 同类失败第二次出现才触发，且每会话只补一次', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(path.join(tmpdir(), 'kifu-d5-'));
  const { ctx, hooks } = makeCtx();
  let injectedCount = 0;
  const res = apply(ctx, baseConfig({
    storeRoot: root,
    repeatHint: true,
    repeatHintAfter: 2,
    repeatHintMax: 1,
    createUserMessage: (m) => ({ role: 'user', content: [{ type: 'text', text: `CARD:${m.content[0].text}` }] }),
    deps: {
      createStore: () => ({ list: () => [], get: () => null }),
      walk: () => ({ hits: [{ episode: 'ep-x', seq: 1, occurredAt: 1, kind: 'failure', text: 'boom', why: ['x'] }], dropped: {} }),
      buildMemoryCard: () => ({ section: '- [antipattern] boom  (ep-x, 2026-11-02, seq 1)', tokens: 12 }),
      runGates: () => ({ ok: true, errors: [] }),
      createWalkCache: () => ({}),
    },
  }));
  assert.equal(res.registered, true);

  const session = { id: 's-d5' };
  const step = (texts) => hooks['agent/pre-step'](
    { agent: { session }, messages: texts.map((t) => ({ role: 'user', content: [{ type: 'text', text: t }] })) },
    async () => ({ kind: 'enter', messages: [{ role: 'assistant', content: [] }] }),
  );

  const first = await step(['hello', 'Error: file has not been read — read the file, then retry']);
  assert.equal(first.kind, 'enter');
  // 第一次是「首轮正常注入」；D5 不在这一步动手
  assert.equal(first.messages.length, 2, '第一次同类失败只走正常首轮注入');

  const second = await step(['hello', 'Error: file has not been read — read the file, then retry', 'step', 'Error: file changed since it was read — re-read the file, then retry']);
  assert.ok(second.messages.some((m) => String(m.content?.[0]?.text ?? '').startsWith('CARD:')), '第二次同类失败应补一张卡（oncePerSession 已被首轮占用）');
  injectedCount += 1;

  const third = await step(['a', 'b', 'c', 'd', 'Error: unknown tool "bash"', 'e', 'f', 'Error: unknown tool "bash"', 'g']);
  assert.equal(third.messages.some((m) => String(m.content?.[0]?.text ?? '').startsWith('CARD:')), false, '每会话最多补一次');
  assert.equal(injectedCount, 1);
});

// D5（2026-11-02 补）：闸不过时 D5 也不许强塞——它必须和首轮走同一套十道闸
test('D5: 闸不通过 ⇒ 不补卡（不绕过十道闸）', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(path.join(tmpdir(), 'kifu-d5-gate-'));
  const { ctx, hooks } = makeCtx();
  const res = apply(ctx, baseConfig({
    storeRoot: root,
    repeatHint: true,
    repeatHintAfter: 2,
    repeatHintMax: 1,
    createUserMessage: (m) => ({ role: 'user', content: [{ type: 'text', text: `CARD:${m.content[0].text}` }] }),
    deps: {
      createStore: () => ({ list: () => [], get: () => null }),
      walk: () => ({ hits: [{ episode: 'ep-x', seq: 1, occurredAt: 1, kind: 'failure', text: 'boom', why: ['x'] }], dropped: {} }),
      buildMemoryCard: () => ({ section: '- [antipattern] boom', tokens: 12 }),
      runGates: () => ({ ok: false, errors: ['imperative'] }),
      createWalkCache: () => ({}),
    },
  }));
  assert.equal(res.registered, true);
  const session = { id: 's-d5-gate' };
  const step = (texts) => hooks['agent/pre-step'](
    { agent: { session }, messages: texts.map((t) => ({ role: 'user', content: [{ type: 'text', text: t }] })) },
    async () => ({ kind: 'enter', messages: [{ role: 'assistant', content: [] }] }),
  );
  await step(['hello', 'Error: file has not been read — read the file, then retry']);
  const second = await step(['hello', 'Error: file has not been read — read the file, then retry', 'step', 'Error: file changed since it was read — re-read the file, then retry']);
  assert.equal(second.messages.some((m) => String(m.content?.[0]?.text ?? '').startsWith('CARD:')), false, '闸不过不得补卡');
});

// A3 心跳（2026-11-03）：default 开 ⇒ 每步一行 live-stats.jsonl；liveStats:false ⇒ 不写
test('A3 心跳: liveStats 默认写 live-stats.jsonl，关掉则不写', async () => {
  const { mkdtempSync, existsSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const mk = async (liveStats) => {
    const root = mkdtempSync(path.join(tmpdir(), 'kifu-live-'));
    const { ctx, hooks } = makeCtx();
    apply(ctx, baseConfig({
      storeRoot: root,
      ...(liveStats === undefined ? {} : { liveStats }),
      deps: {
        createStore: () => ({ list: () => [], get: () => null }),
        walk: () => ({ hits: [], dropped: {} }),
        buildMemoryCard: () => ({ section: null, tokens: 0, claims: [] }),
        runGates: () => ({ ok: true, errors: [] }),
        createWalkCache: () => ({}),
      },
    }));
    await hooks['agent/pre-step'](
      { agent: { session: { id: `s-${Math.random()}` } }, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
      async () => ({ kind: 'enter', messages: [{ role: 'assistant', content: [] }] }),
    );
    const file = path.join(root, 'live-stats.jsonl');
    return { exists: existsSync(file), text: existsSync(file) ? readFileSync(file, 'utf8') : '' };
  };
  const on = await mk(undefined);
  assert.equal(on.exists, true, '默认应写心跳');
  assert.ok(on.text.split('\n').filter(Boolean).length >= 1);
  const off = await mk(false);
  assert.equal(off.exists, false, 'liveStats:false 不应写');
});

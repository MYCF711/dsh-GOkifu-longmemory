// T213 · 工具面端到端：5 个 `kifu_*` 工具"真的注册 + 真的能调"。
//
// 为什么要这个测试：`tools-registered.json` 长期是 `{"via":"none","count":0}` —— 工具写好了却
// **一次都没跑起来过**。配置要等主人重启，但"它能不能跑"现在就能验；等重启后发现工具是坏的、
// 才是最坏的形状。
//
// 契约（读 `src/tools-plugin.mjs` / `src/tools.mjs`，不猜）：
//   · 插件导出 `inject = ['tools']`；`apply(ctx)` 里调 `ctx.tools.register(tool)`
//   · `tool = { name, description, parameters, output, execute(args) → Promise<object> }`
//   · `execute` **不抛**：失败翻成 `{ ok:false, error:{ code, message } }`
//
// 只读真库：`apply` 会写 `tools-registered.json`（凭据），所以注册那一步把 `DSH_HOME` 指到 tmp；
// 真调用那一步直接把 env 指回真库，但只调 `execute`（不写任何东西）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildMemoryTools, TOOL_PREFIX } from '../src/tools.mjs';
import * as plugin from '../src/tools-plugin.mjs';

const REAL_HOME = process.env.DSH_HOME || path.join(os.homedir(), 'DeepSeek Harness', 'home');
const REAL_STORE = path.join(REAL_HOME, 'memory-context');
const HAS_REAL = fs.existsSync(path.join(REAL_STORE, 'manifest.json'));

/** 假 ctx：只实现 `tools.register` 的最小契约（与 DSH 一致）。 */
function fakeCtx() {
  const seen = [];
  return {
    tools: { register: (tool) => { seen.push(tool); } },
    logger: { warn: () => {} },
    seen,
  };
}

const truncate = (v, n = 200) => {
  const s = typeof v === 'string' ? v : String(JSON.stringify(v));
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

test('T213: 插件契约 —— inject 声明了 tools，apply 注册，名字与导出对应', () => {
  assert.deepEqual(plugin.inject, ['tools'], '缺 tools 服务时插件不加载（inject 语义）');
  assert.equal(typeof plugin.apply, 'function');

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-t213-'));
  fs.mkdirSync(path.join(tmpHome, 'memory-context'), { recursive: true });
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = tmpHome;
  try {
    const ctx = fakeCtx();
    const res = plugin.apply(ctx);
    const built = buildMemoryTools().map((t) => t.name);
    assert.equal(ctx.seen.length, built.length, '注册数必须等于 buildMemoryTools() 的数量');
    assert.deepEqual(ctx.seen.map((t) => t.name), built, '注册顺序/名字必须一一对应');
    assert.equal(res.registered, built.length);
    // 每个工具的形状
    for (const tool of ctx.seen) {
      assert.ok(tool.name.startsWith(`${TOOL_PREFIX}_`), `${tool.name} 必须以 kifu_ 开头`);
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.description.length > 0, `${tool.name} 缺 description`);
      assert.equal(tool.parameters?.type, 'object', `${tool.name} 的 parameters 必须是 object schema`);
      assert.ok(tool.parameters.properties && typeof tool.parameters.properties === 'object', `${tool.name} 缺 properties`);
      assert.equal(typeof tool.execute, 'function');
      // 参数必须是合法 JSON Schema（可被 JSON 序列化 + 无循环）
      JSON.stringify(tool.parameters);
    }
    // 凭据写到了 tmp（不是真库）
    const record = JSON.parse(fs.readFileSync(path.join(tmpHome, 'memory-context', 'tools-registered.json'), 'utf8'));
    assert.equal(record.count, built.length);
    assert.equal(record.via, 'tools-plugin');
    assert.equal(record.ctxHasRegister, true);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('T213: 真库只读 —— 每个工具都真调一次，返回非空且结构正确', { skip: !HAS_REAL && '没有真库' }, async () => {
  if (!process.env.DSH_HOME) process.env.DSH_HOME = REAL_HOME;
  const tools = buildMemoryTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  // 从真库里取一个真 id（不猜）
  const { createStore } = await import('../src/rooms/persist.mjs');
  const store = createStore({ root: REAL_STORE });
  const episodeId = store.list('episodes').map((e) => e.id)[0];
  const claimEntry = store.list('claims')[0];
  const claimId = claimEntry.id;
  const scope = claimEntry.record?.scopeKey ?? null; // 真作用域（不猜）
  assert.ok(episodeId && claimId, '真库必须至少各有一条 episode / claim');

  const calls = [
    ['kifu_stats', {}],
    ['kifu_search', { text: 'stale', limit: 3, scope }],
    ['kifu_card', { text: 'stale', limit: 3, scope }],
    ['kifu_recent_failures', { limit: 3 }],
    ['kifu_view', { kind: 'episode', id: episodeId, maxNodes: 20 }],
    ['kifu_get', { kind: 'claims', id: claimId }],
  ];
  const results = [];
  for (const [name, args] of calls) {
    const tool = byName.get(name);
    assert.ok(tool, `工具 ${name} 必须存在（实际：${[...byName.keys()].join(', ')}）`);
    const value = await tool.execute(args);
    assert.ok(value !== null && value !== undefined, `${name} 返回了空值`);
    assert.equal(typeof value, 'object');
    assert.notEqual(value?.ok, false, `${name} 失败：${truncate(value?.error ?? value)}`);
    assert.ok(!value?.error, `${name} 返回了结构化错误：${truncate(value?.error)}`);
    const text = JSON.stringify(value);
    assert.ok(text && text !== '{}', `${name} 返回了空对象`);
    results.push({ name, size: text.length, head: truncate(text) });
  }
  assert.equal(results.length, 6);
  test.diagnostic?.(results.map((r) => `${r.name} ${r.size}B :: ${r.head}`).join('\n'));
});

test('T213: 缺库/坏库 ⇒ 优雅失败（返回结构化错误，不抛未捕获异常）', async () => {
  const tools = buildMemoryTools();
  const badHome = path.join(os.tmpdir(), `kifu-t213-missing-${Date.now()}`);
  for (const tool of tools) {
    let value;
    // 关键：**不许抛未捕获异常**
    await assert.doesNotReject(async () => { value = await tool.execute({ dshHome: badHome }); }, `${tool.name} 缺库时抛了异常`);
    assert.ok(value && typeof value === 'object', `${tool.name} 必须返回对象`);
    if (value.ok === false) {
      // 走"结构化错误"路径
      assert.equal(typeof value.error?.code, 'string', `${tool.name} 缺 code`);
      assert.equal(typeof value.error?.message, 'string', `${tool.name} 缺 message`);
    } else {
      // 走"空结果"路径（如 kifu_stats 的 status:'missing'）——同样是优雅失败
      assert.ok(JSON.stringify(value).length > 0, `${tool.name} 返回了空对象`);
      assert.notEqual(value.status, undefined, `${tool.name} 缺库时应带 status 说明（实际 ${truncate(value)}）`);
    }
  }
});

test('T213: 没有 ctx.tools 时 registerMemoryTools 不抛（返回空数组）', async () => {
  const { registerMemoryTools } = await import('../src/tools.mjs');
  const names = registerMemoryTools({}, {});
  assert.deepEqual(names, [], '宿主不给工具面 ⇒ 一个都不注册，且不抛');
  const names2 = registerMemoryTools({ tools: { register: () => { throw new Error('boom'); } } }, { warn: () => {} });
  assert.deepEqual(names2, [], '单个注册失败不影响其它（不抛）');
});

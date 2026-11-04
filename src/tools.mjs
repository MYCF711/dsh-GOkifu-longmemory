import fs from 'node:fs';
// 棋院 · 工具面（PTC / run_code）：把 SDK 的能力注册成**工具**，让代码块里能直接调用、循环、聚合。
//
// 为什么需要这一层（主人的原话）："要做成 SDK 化 PTC 运行时，不依赖会话的本身模式" ——
//   自动注入是"会话模式"下的推送；工具是"任何时刻都能按需查"的拉取。两者并存：
//   注入负责"不用问就来"，工具负责"要查几次就查几次，不靠模型反复召回"。
//
// 三条纪律（与 src/sdk.mjs 一致，这里不重复实现，只做壳）：
//   ① 只读：没有任何写入/入馆工具（入馆只走会话钩子）；
//   ② 零模型、零网络：工具体就是读 sidecar + 机械 walk；
//   ③ 结果有界且 JSON 安全：limit/budgetTokens 由 SDK 夹紧，并在结果里如实标 clamped。
//
// 本文件不碰宿主 API：只导出 ToolDefinition 形状的对象数组，由 `src/plugin.mjs` 在 apply() 里注册。
import { createMemorySdk } from './sdk.mjs';

/** 工具名前缀：`kifu_*`。PTC 模式下宿主会据此生成 SDK 绑定。 */
export const TOOL_PREFIX = 'kifu';

const jsonOutput = {
  schema: { type: 'object' },
  render(_args, value) {
    return [{ type: 'text', text: JSON.stringify(value) }];
  },
};

const argsSchema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const textProp = { type: 'string', description: '要查的文本（用户这句话 / 报错原文 / 主题词）。空串会被拒。' };
const limitProp = { type: 'integer', minimum: 1, maximum: 50, description: '返回条数上限（会被夹紧到 1–50）。' };
const scopeProp = { type: 'string', description: '作用域键（w:…）。不传 = 不限域；传了就只返回该域可见内容（A5 同语义）。' };

/**
 * 构造工具定义。`createSdk` 可注入（单测用假 SDK，不碰真库）。
 * 每个 `execute` 都不会抛：SDK 的 SdkError 会翻成 `{ok:false, error:{code,message}}`，
 * 这样代码块里可以用返回值分支，而不是被 try/catch 包起来。
 */
export function buildMemoryTools({ createSdk = createMemorySdk } = {}) {
  const run = (fn) => async (args = {}) => {
    try {
      const sdk = createSdk({ dshHome: args?.dshHome ?? null, scope: args?.scope ?? null });
      return await fn(sdk, args ?? {});
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'internal';
      return { ok: false, error: { code, message: String(error?.message ?? error) } };
    }
  };

  return [
    {
      name: `${TOOL_PREFIX}_stats`,
      description: '记忆库概览：棋谱/主题/claim/边/卷/定式的条数 + 最新时间。只读、零模型。',
      parameters: argsSchema({ dshHome: { type: 'string', description: '可选：记忆库所在的 DSH_HOME（默认取环境变量）。' } }),
      output: jsonOutput,
      execute: run((sdk) => sdk.stats()),
      isConcurrencySafe: () => true,
    },
    {
      name: `${TOOL_PREFIX}_search`,
      description: '按文本找相关记忆（轻量命中列表：棋谱 + seq + 种类 + 权重 + 命中理由）。只读、零模型。',
      parameters: argsSchema({ text: textProp, limit: limitProp, depth: { type: 'integer', minimum: 1, maximum: 2 }, scope: scopeProp }, ['text']),
      output: jsonOutput,
      execute: run((sdk, args) => sdk.search(args.text, { limit: args.limit, depth: args.depth, scope: args.scope })),
      isConcurrencySafe: () => true,
    },
    {
      name: `${TOOL_PREFIX}_card`,
      description: '生成与线上注入**同一份**记忆卡（跑十道闸）：给定文本，返回卡片正文、token 数、逐条 claim 与闸门结论。',
      parameters: argsSchema({ text: textProp, limit: limitProp, budgetTokens: { type: 'integer', minimum: 100, maximum: 2000 }, scope: scopeProp, gates: { type: 'boolean' } }, ['text']),
      output: jsonOutput,
      execute: run((sdk, args) => sdk.card(args.text, { limit: args.limit, budgetTokens: args.budgetTokens, scope: args.scope, gates: args.gates })),
      isConcurrencySafe: () => true,
    },
    {
      name: `${TOOL_PREFIX}_recent_failures`,
      description: '最近的失败原文（按 occurredAt 倒序，带 ep+seq 出处）：用来"先取已付过代价的失败"。只读、零模型。',
      parameters: argsSchema({ limit: limitProp, scope: scopeProp }),
      output: jsonOutput,
      execute: run((sdk, args) => sdk.recentFailures({ limit: args.limit, scope: args.scope })),
      isConcurrencySafe: () => true,
    },
    {
      name: `${TOOL_PREFIX}_get`,
      description: '按 id 取一条记录（kinds: episodes/topics/claims/links/threads/joseki/adjudications）。只读。',
      parameters: argsSchema({
        kind: { type: 'string', enum: ['episodes', 'topics', 'claims', 'links', 'threads', 'joseki', 'adjudications'] },
        id: { type: 'string', description: '记录 id（如 c-xxxxxxxx / ep-xxxxxxxx / t:…）。' },
        dshHome: { type: 'string' },
      }, ['kind', 'id']),
      output: jsonOutput,
      execute: run((sdk, args) => sdk.get(args.kind, args.id)),
      isConcurrencySafe: () => true,
    },
  ];
}

/** 注册进宿主工具面（`ctx.tools.register`）。返回已注册的工具名，失败只 warn、不影响会话。 */
export function registerMemoryTools(ctx, { createSdk = createMemorySdk, warn = () => {} } = {}) {
  const registered = [];
  try {
    if (typeof ctx?.tools?.register !== 'function') return registered;
    for (const tool of buildMemoryTools({ createSdk })) {
      try {
        ctx.tools.register(tool);
        registered.push(tool.name);
      } catch (error) {
        warn(ctx, `工具 ${tool.name} 注册失败（不影响注入）：${String(error?.message ?? error)}`);
      }
    }
  } catch (error) {
    warn(ctx, `工具面不可用（不影响注入）：${String(error?.message ?? error)}`);
  }
  return registered;
}

/**
 * 记一条「本次插件加载把哪些工具注册到宿主」的凭据（`<storeRoot>/tools-registered.json`）。
 *
 * 为什么要这个文件：工具是在**插件加载时**注册的，而"注册到底成没成"从会话里看不出来 ——
 * 2026-11-04 重启后我们只能猜。有了这条凭据，重启一次就能确定：宿主是否把 `ctx.tools` 交给了插件、
 * 五个工具是否都进去了。写盘用 tmp + rename（崩了也不会留半截 JSON），失败只返回 false（不影响注入）。
 */
export function recordToolRegistration(dir, names, { at = Date.now(), host = null, via = null, ctxHasRegister = null } = {}) {
  try {
    if (typeof dir !== 'string' || dir === '') return false;
    const target = `${dir}/tools-registered.json`;
    const list = Array.isArray(names) ? names : [];
    const payload = JSON.stringify({ at, names: list, count: list.length, host, via, ctxHasRegister }, null, 2);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

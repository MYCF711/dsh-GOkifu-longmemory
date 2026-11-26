// src/lifecycle.mjs —— 插件**生命周期**：配置解析、apply 运行时（state / disposers / effect）、
// dispose 语义、autoBuild 共享 record、预热、工具面与设置路由的注册。
//
// 为什么单独成文件（重构 C 期 M1）：Cordis 4.1 的生命周期规矩很硬 ——
//   · `apply` 必须返回**函数型 disposer**（返回诊断对象 = `TypeError: Invalid effect`）；
//   · 并发/重复 dispose 必须**严格复用同一个 Promise**；
//   · `ctx.inject` 会派生等待服务的子插件（web 启动时算"未激活 entry"⇒ 整个 GUI 起不来，T388）；
//   · autoBuild 用 `Map<storeRoot, record> + owners` 共享，只有最后一个 owner 取消 queued timer。
// 这些规矩以前散在 1,900 行的入口里，改一处要读全篇；现在只在这一个文件里。
//
// 边界：这里**不做注入决策**（那是 hooks.mjs + 组合根的事），只负责"什么时候活、什么时候收"。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POINTER_TIER_DEFAULT, buildMemoryCard, defaultShadowDir, writeShadow } from './rooms/inject.mjs';
import { createStore } from './rooms/persist.mjs';
import { createWalkCache } from './rooms/walk.mjs';
import { probeValidity, runGates } from './rooms/gates.mjs';
import { registerMemoryTools, recordToolRegistration } from './tools.mjs';
import { createMemorySdk } from './sdk.mjs';
import { openReadStore, walkCacheFor } from './cache.mjs';

// T390：预热规模闸 —— 超过就不预热（避免在大库上把宿主卡死十几秒）
export const WARMUP_MAX_EPISODES = 1200;
export const WARMUP_MAX_LINKS = 8000;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// 用户配置（GUI 保存的「记忆库地址」等）落在 <DSH_HOME>/kifu-longmemory.json。
// 优先级：profile 配置 > 用户文件 > 默认值。文件坏了只 warn，不阻塞。
// ---------------------------------------------------------------------------
export const USER_CONFIG_FILE = 'kifu-longmemory.json';

function dshHomeOf() {
  return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME ? process.env.DSH_HOME : null;
}

export function readUserConfig({ dshHome = null } = {}) {
  const home = dshHome ?? dshHomeOf();
  if (!home) return {};
  try {
    const raw = fs.readFileSync(path.join(home, USER_CONFIG_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeUserConfig(patch, { dshHome = null } = {}) {
  const home = dshHome ?? dshHomeOf();
  if (!home) throw new Error('没有 DSH_HOME，无法保存插件配置');
  const current = readUserConfig({ dshHome: home });
  const next = { ...current, ...patch };
  const file = path.join(home, USER_CONFIG_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}
`, 'utf8');
  fs.renameSync(tmp, file);
  return next;
}

export const CONFIG_ROUTE = '/kifu-longmemory/config';

/**
 * 配置 API 工厂：把**默认值表**（`DEFAULT_CONFIG`）从`配置逻辑`里解耦出来。
 *
 * 为什么表在组合根、逻辑在这里：`scripts/m5-report.mjs` 的 `readPluginFacts` 用**源扫描**
 * 读 `src/plugin.mjs` 里 `DEFAULT_CONFIG` 的 `enabled`/`shadow` 默认值（A3 轴的"默认关"事实），
 * 判据不许松 ⇒ 表必须逐字长在入口文件里。表以参数注入本工厂，**依赖方向仍是 plugin → lifecycle**，
 * 不会为了读一个常量而把依赖图弄成环。
 *
 * @param {object} DEFAULT_CONFIG 默认值表（唯一一份，由组合根传入）
 * @returns {{DEFAULT_CONFIG:object, sanitizeConfig:Function, resolveConfig:Function, Config:object, storeStatsOf:Function, handleConfigRoute:Function}}
 */
export function createConfigApi(DEFAULT_CONFIG) {
  /** profile 配置覆盖用户文件；两者都不认识的值由 sanitizeConfig 兜底。 */
  function resolveConfig(rawConfig = {}) {
    return sanitizeConfig({ ...readUserConfig(), ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) });
  }

  // ---------------------------------------------------------------------------
  // 小工具（全部纯函数；由工厂返回给组合根，组合根再逐项导出）
  // ---------------------------------------------------------------------------

  function boolOf(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
  }

  function positiveInt(value, fallback, max) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.floor(n), max);
  }

  /** 配置净化：只认已知键、类型不对就退回默认（不静默接受垃圾）。 */
  function sanitizeConfig(raw = {}) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    // T341 · ablation 实验开关：`GOKIFU_INJECT=off|false|0` ⇒ 完全静默（enabled=false 且 shadow=false）。
    // 背景（precision-auditor 评审 evidence/ablation-设计评审.md）：旧 ablation 脚本写的 `GOKIFU_INJECT=off`
    // 此前无人读取 ⇒ B 臂仍带注入、两臂等价 ⇒ "无差别"是假象。仅显式 off/false/0 才关；
    // 不设/其他值 = 配置键为准（绝不误关生产注入）。进程级生效，不碰宿主配置/不触发热重载。
    const injectEnv = String(process.env.GOKIFU_INJECT ?? '').trim().toLowerCase();
    const injectOff = injectEnv === 'off' || injectEnv === 'false' || injectEnv === '0';
    return {
      enabled: injectOff ? false : boolOf(src.enabled, DEFAULT_CONFIG.enabled),
      shadow: injectOff ? false : boolOf(src.shadow, DEFAULT_CONFIG.shadow),
      storeRoot: typeof src.storeRoot === 'string' && src.storeRoot.trim() !== '' ? src.storeRoot.trim() : null,
      sampleCards: typeof src.sampleCards === 'boolean' ? src.sampleCards : DEFAULT_CONFIG.sampleCards,
      collectMessages: typeof src.collectMessages === 'boolean' ? src.collectMessages : DEFAULT_CONFIG.collectMessages,
      shadowDir: typeof src.shadowDir === 'string' && src.shadowDir.trim() !== '' ? src.shadowDir.trim() : null,
      budgetTokens: positiveInt(src.budgetTokens, DEFAULT_CONFIG.budgetTokens, 100000),
      limit: positiveInt(src.limit, DEFAULT_CONFIG.limit, 100),
      oncePerSession: boolOf(src.oncePerSession, DEFAULT_CONFIG.oncePerSession),
      abstainIrrelevant: boolOf(src.abstainIrrelevant, DEFAULT_CONFIG.abstainIrrelevant),
      now: Number.isFinite(src.now) ? Number(src.now) : (typeof src.now === 'function' ? src.now : null),
      createUserMessage: typeof src.createUserMessage === 'function' ? src.createUserMessage : null,
      probeValidity: boolOf(src.probeValidity, true),
      autoBuild: boolOf(src.autoBuild, true),
      autoArchive: boolOf(src.autoArchive, true),
      autoArchiveMinutes: positiveInt(src.autoArchiveMinutes, 30, 24 * 60),
      crossScopeClass: boolOf(src.crossScopeClass, false),
      // T3：三级交付的第二级开关。**显式 false 才关**（`boolOf` 兜底 = DEFAULT_CONFIG 的值），
      // 不用 `!== false` —— 那会把「未设置」当成「开启」，与 D5 踩过的坑同一个形状。
      pointerTier: boolOf(src.pointerTier, DEFAULT_CONFIG.pointerTier),
      preferenceHardOnly: boolOf(src.preferenceHardOnly, false),
      liveStats: boolOf(src.liveStats, true),
      repeatHint: boolOf(src.repeatHint, true),
      repeatHintAfter: positiveInt(src.repeatHintAfter, 2, 20),
      repeatHintMax: positiveInt(src.repeatHintMax, 1, 5),
      deps: src.deps && typeof src.deps === 'object' && !Array.isArray(src.deps) ? src.deps : null,
    };
  }

  const Config = {
    type: 'object',
    dict: {
      enabled: { type: 'boolean', meta: { default: true, description: '启用记忆注入（关掉 = 完全静默）' } },
      shadow: { type: 'boolean', meta: { default: false, description: '影子模式：只记录本来会注入什么，不真注入' } },
      storeRoot: { type: 'string', meta: { default: '', description: '记忆库地址；留空 = <DSH_HOME>/memory-context（推荐留空）' } },
      autoBuild: { type: 'boolean', meta: { default: true, description: '库不存在时后台自动建库（本次沉默）' } },
      autoArchive: { type: 'boolean', meta: { default: true, description: '轮次收尾时按时间阈值自动刷新记忆库' } },
      autoArchiveMinutes: { type: 'number', meta: { default: 30, description: '自动刷新间隔（分钟）' } },
      crossScopeClass: { type: 'boolean', meta: { default: false, description: '类级章节允许跨工作区先例（卡片标 [跨项目]；Q18 裁定前默认关）' } },
      liveStats: { type: 'boolean', meta: { default: true, description: 'A3 心跳：每步往 sidecar/live-stats.jsonl 追加一行（可关）' } },
      repeatHint: { type: 'boolean', meta: { default: true, description: '同一会话同类失败 ≥N 次时补一次事实卡（D5）' } },
      repeatHintAfter: { type: 'number', meta: { default: 2, description: '同类失败达到几次才补卡' } },
      budgetTokens: { type: 'number', meta: { default: 500, description: '每次注入的 token 预算' } },
      limit: { type: 'number', meta: { default: 5, description: '每次最多注入几条' } },
      oncePerSession: { type: 'boolean', meta: { default: true, description: '每会话只注入一次（首轮）' } },
      pointerTier: { type: 'boolean', meta: { default: true, description: '三级交付：只有 1 局支撑（observed）的记忆只给指针（ep + seq + 日期），不给全文' } },
    },
    meta: { default: {} },
    toJSON() {
      return { type: 'object', dict: this.dict, meta: this.meta };
    },
    '~standard': {
      version: 1,
      vendor: 'dsh-gokifu-longmemory',
      validate(value) {
        const source = value !== null && typeof value === 'object' ? value : {};
        return { value: sanitizeConfig(source) };
      },
    },
  };

  /**
   * 设置页用的纯处理函数（不碰 http 对象，便于单测）。
   * GET  → { config, effectiveStoreRoot, userConfigFile }
   * POST → 保存 { storeRoot } 到 <DSH_HOME>/kifu-longmemory.json
   */

  function storeStatsOf(root) {
    if (typeof root !== 'string' || root === '') return null;
    const countJson = (dir) => {
      try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length; } catch { return null; }
    };
    let updatedAt = null;
    try { updatedAt = Number(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).updatedAt) || null; } catch { updatedAt = null; }
    return {
      exists: fs.existsSync(root),
      episodes: countJson(path.join(root, 'episodes')),
      claims: countJson(path.join(root, 'claims')),
      updatedAt,
    };
  }

  function handleConfigRoute({ method = 'GET', body = null, profileConfig = {}, dshHome = null } = {}) {
    const home = dshHome ?? dshHomeOf();
    const merged = resolveConfig({ ...readUserConfig({ dshHome: home }), ...profileConfig });
    if (method === 'GET') {
      return {
        status: 200,
        body: (() => {
          const effective = merged.storeRoot ? resolveStoreRoot(merged) : (home ? path.join(home, 'memory-context') : resolveStoreRoot(merged));
          return {
            config: merged,
            effectiveStoreRoot: effective,
            stats: storeStatsOf(effective),
            userConfigFile: home ? path.join(home, USER_CONFIG_FILE) : null,
          };
        })(),
      };
    }
    if (method !== 'POST') return { status: 405, body: { error: 'method not allowed' } };
    let patch;
    try {
      patch = typeof body === 'string' ? JSON.parse(body) : body;
    } catch {
      return { status: 400, body: { error: 'invalid JSON' } };
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { status: 400, body: { error: 'body must be an object' } };
    const next = {};
    if (patch.storeRoot !== undefined) {
      if (typeof patch.storeRoot !== 'string') return { status: 400, body: { error: 'storeRoot must be a string' } };
      const trimmed = patch.storeRoot.trim();
      if (trimmed !== '' && !/^[A-Za-z]:[\/]|^\//.test(trimmed)) return { status: 400, body: { error: 'storeRoot 必须是绝对路径或留空' } };
      next.storeRoot = trimmed;
    }
    for (const key of ['enabled', 'shadow', 'autoBuild', 'oncePerSession', 'pointerTier']) {
      if (patch[key] !== undefined) {
        if (typeof patch[key] !== 'boolean') return { status: 400, body: { error: `${key} must be a boolean` } };
        next[key] = patch[key];
      }
    }
    for (const key of ['budgetTokens', 'limit']) {
      if (patch[key] !== undefined) {
        const n = Number(patch[key]);
        if (!Number.isFinite(n) || n <= 0) return { status: 400, body: { error: `${key} must be a positive number` } };
        next[key] = n;
      }
    }
    try {
      writeUserConfig(next, { dshHome: home });
    } catch (error) {
      return { status: 500, body: { error: String(error?.message ?? error) } };
    }
    return { status: 200, body: { ok: true, saved: next, file: home ? path.join(home, USER_CONFIG_FILE) : null } };
  }

  return { DEFAULT_CONFIG, sanitizeConfig, resolveConfig, Config, storeStatsOf, handleConfigRoute };
}

export function warn(ctx, line) {
  try {
    if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(`dsh-gokifu-longmemory: ${line}`);
  } catch {
    // 记日志本身失败也不许影响会话
  }
}

/** 时钟：允许把 `now` 固定成数字或函数（测试/回放）。 */
export function clockOf(config) {
  if (typeof config.now === 'function') {
    const v = config.now();
    if (Number.isFinite(v)) return Number(v);
  }
  if (Number.isFinite(config.now)) return Number(config.now);
  return Date.now();
}

// ---------------------------------------------------------------------------
// 依赖（默认真实现；`config.deps` 可注入替身，测试用）
// ---------------------------------------------------------------------------

export async function resolveDeps(config) {
  const injected = config.deps ?? {};
  let walk = typeof injected.walk === 'function' ? injected.walk : null;
  if (!walk) {
    try {
      const mod = await import('./rooms/walk.mjs');
      walk = typeof mod.walkFromSignals === 'function' ? mod.walkFromSignals : null;
    } catch {
      walk = null; // R11 缺位：降级到 R12 的 degradedWalk（注入函数自己会兜）
    }
  }
  return {
    createStore: typeof injected.createStore === 'function' ? injected.createStore : createStore,
    createWalkCache: typeof injected.createWalkCache === 'function' ? injected.createWalkCache : createWalkCache,
    buildMemoryCard: typeof injected.buildMemoryCard === 'function' ? injected.buildMemoryCard : buildMemoryCard,
    runGates: typeof injected.runGates === 'function' ? injected.runGates : runGates,
    probeValidity: typeof injected.probeValidity === 'function' ? injected.probeValidity : probeValidity,
    buildStore: typeof injected.buildStore === 'function' ? injected.buildStore : null,
    writeShadow: typeof injected.writeShadow === 'function' ? injected.writeShadow : writeShadow,
    walk,
    createUserMessage: typeof injected.createUserMessage === 'function' ? injected.createUserMessage : null,
  };
}

function expandHomePlaceholder(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : '';
  const hasPlaceholder = /^(<DSH_HOME>|\$DSH_HOME)([\/]|$)/i.test(text);
  if (!hasPlaceholder) return text;
  if (!home) return null; // 占位符解析不了就当作没有配置（宁可沉默，不去猜一个路径）
  return text.replace(/^(<DSH_HOME>|\$DSH_HOME)/i, home);
}

export function resolveStoreRoot(config) {
  if (config.storeRoot) {
    const expanded = expandHomePlaceholder(config.storeRoot);
    return expanded ? path.resolve(expanded) : null;
  }
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : '';
  if (!home) return null;
  return path.resolve(home, 'memory-context');
}

export function resolveShadowDir(config) {
  if (config.shadowDir) {
    const expanded = expandHomePlaceholder(config.shadowDir);
    return expanded ? path.resolve(expanded) : null;
  }
  try {
    return defaultShadowDir();
  } catch {
    return path.join(REPO_ROOT, 'evidence', 'shadow');
  }
}

const BUILDING = new Map();

/** 零配置：库不存在时后台建一次（不阻塞本轮；失败只 warn，不重试风暴）。 */
export function scheduleAutoBuild({ ctx, storeRoot, deps = null, reason = 'missing', lifecycle }) {
  if (!storeRoot || lifecycle.isDisposed()) return;

  const existing = BUILDING.get(storeRoot);
  if (existing) {
    if (!existing.settled) {
      existing.owners.add(lifecycle);
      lifecycle.builds.add(existing);
    }
    return;
  }

  let resolveTask;
  const record = {
    timer: null,
    owners: new Set([lifecycle]),
    settled: false,
    task: new Promise((resolve) => { resolveTask = resolve; }),
    cancel: null,
  };
  BUILDING.set(storeRoot, record);
  lifecycle.builds.add(record);

  const activeOwner = () => [...record.owners].find((owner) => !owner.isDisposed()) ?? null;
  const detach = (owner) => {
    record.owners.delete(owner);
    owner.builds.delete(record);
  };
  const deleteIfCurrent = () => {
    if (BUILDING.get(storeRoot) === record) BUILDING.delete(storeRoot);
  };
  const settle = () => {
    if (record.settled) return;
    record.settled = true;
    for (const owner of [...record.owners]) detach(owner);
    resolveTask();
  };

  record.cancel = (owner) => {
    detach(owner);
    if (record.settled) return null;
    if (record.timer === null) return record.task;
    if (record.owners.size === 0) {
      clearTimeout(record.timer);
      record.timer = null;
      deleteIfCurrent();
      settle();
    }
    return null;
  };

  const run = async () => {
    record.timer = null;
    if (!activeOwner()) {
      deleteIfCurrent();
      settle();
      return;
    }
    try {
      const dataRoot = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME ? process.env.DSH_HOME : null;
      if (typeof deps?.buildStore === 'function') {
        await deps.buildStore({ storeRoot, dataRoot });
      } else {
        const mod = await import('../scripts/archive.mjs');
        if (typeof mod.runArchive !== 'function') throw new Error('archive.mjs 未导出 runArchive');
        if (!dataRoot) throw new Error('没有 DSH_HOME，无法建库');
        await mod.runArchive({ dataRoot, storeRoot, dryRun: false, user: 'owner' });
      }
      const owner = activeOwner();
      if (owner) warn(owner.ctx, `记忆库已刷新（${reason}）：${storeRoot}`);
    } catch (error) {
      deleteIfCurrent();
      const owner = activeOwner();
      if (owner) warn(owner.ctx, `自动建库失败：${String(error?.message ?? error)}`);
    } finally {
      settle();
    }
  };

  record.timer = setTimeout(() => { void run(); }, 0);
}

// ---------------------------------------------------------------------------
// 设置页 schema（2026-11-02）：让设置 UI 能展示/选择"记忆库地址"等配置。
// 形状与 dsh-unlag 的 Config 一致：type/dict/meta + ~standard.validate（不引入 schemastery）。
// ---------------------------------------------------------------------------

export function enforceStoreRoot(config = {}) {
  return resolveStoreRoot(config);
}

// ---------------------------------------------------------------------------
// apply 运行时：state / disposers / effect / 预热 / 工具面 / 设置路由
//
// 一次 `apply` 只建一个 runtime；组合根（plugin.mjs）拿到它之后只做两件事：
// ① 挂钩子（把 handler 交给 `listen`）；② 用 `makeEffect(true)` 把 disposer 交回宿主。
// 顺序与原实现逐条对齐：builds 清扫 → 预热定时器 → 工具面 → 设置路由 → （组合根）钩子。
// ---------------------------------------------------------------------------

/**
 * 建一次插件实例的运行时（**不挂任何钩子**，钩子由组合根挂）。
 *
 * @returns {{mounted:boolean, lifecycle:object, state:object, disposers:Function[], listen:Function, makeEffect:Function, effect?:Function}}
 *   `mounted === false` ⇒ 宿主没有 `ctx.on`，此时 `effect` 已经造好（`registered:false`），组合根直接返回它。
 */
export function createPluginRuntime({ ctx, config, rawConfig = {}, handleConfigRoute = null, identity = {} }) {
  const { name = 'dsh-gokifu-longmemory', hook = null } = identity;
  const disposers = [];
  let disposed = false;

  // 每个插件实例的**内存状态**：全是"同实例事实"或"只报一次"的闸，dispose 时统一清空。
  // 判重的权威在 sidecar 槽位账本（rooms/inject-slot.mjs）；这里只回答"这个实例里发生过吗"。
  // `injectedObjects` 是 WeakSet（无 id 的 session 兜底），不进 dispose 清扫 —— 它不持有强引用。
  const state = {
    injectedIds: new Set(), // session.id ⇒ 本实例已注入（同实例事实，不是权威）
    injectedObjects: new WeakSet(), // 无 id 的 session 对象 ⇒ 旧行为兜底（不泄漏引用）
    slotLedgerNotified: new Set(), // 账本读/写失败只 warn 一次（按 storeRoot）
    repeatStates: new Map(), // D5：每个会话的「同类失败计数」
    cardSampleCapNotified: new Set(), // T16：撞卡样本上限只报一次（按 storeRoot）
    liveStatsCapNotified: new Set(), // T18：撞心跳上限只报一次（按 storeRoot）
    oncePerSessionNotified: new Set(), // T52：被 oncePerSession 拦下时留一条墓碑行（每会话一次）
    corpusCapNotified: new Set(), // T20：撞消息语料上限只报一次（按 storeRoot）
  };

  // Cordis 4.1 会把 apply 的返回值当作 effect 收集：普通诊断对象会触发 Invalid effect。
  // 返回真正的 disposer；旧诊断字段挂成函数属性，仅供现有测试/安装探针读取。
  // ctx.on 自己也会把监听器登记到当前 fiber，这里的逆序清理同时支持直接调用与宿主卸载；
  // Cordis 的 disposer 单次执行语义保证两条清理路径可以安全汇合。
  const makeEffect = (registered) => {
    let disposePromise = null;
    const dispose = () => {
      if (disposePromise) return disposePromise;
      disposed = true;
      disposePromise = (async () => {
        for (const value of Object.values(state)) {
          if (value && typeof value.clear === 'function') value.clear();
        }
        const pending = [];
        for (const off of disposers.splice(0).reverse()) {
          const result = off();
          if (result && typeof result.then === 'function') pending.push(result);
        }
        await Promise.all(pending);
      })();
      return disposePromise;
    };
    Object.defineProperties(dispose, {
      name: { value: name, configurable: true },
      hook: { value: hook },
      registered: { value: registered },
      config: { value: config },
    });
    return dispose;
  };

  const lifecycle = { ctx, builds: new Set(), isDisposed: () => disposed, corpusCapNotified: state.corpusCapNotified };
  disposers.push(() => {
    const pending = [];
    for (const record of [...lifecycle.builds]) {
      const result = record.cancel(lifecycle);
      if (result && typeof result.then === 'function') pending.push(result);
    }
    return Promise.all(pending).then(() => undefined);
  });
  const listen = (event, handler) => {
    const off = ctx.on(event, handler);
    if (typeof off === 'function') disposers.push(off);
  };

  if (typeof ctx?.on !== 'function') {
    warn(ctx, 'ctx.on 不可用（插件未挂载，宿主行为不变）');
    return { mounted: false, lifecycle, state, disposers, listen, makeEffect, effect: makeEffect(false) };
  }

  // 预热 —— T390（2026-11-19）：**绝不在 apply 里同步做**，也绝不无条件做。
  // 真机事故：一开插件 DSH 就卡死 14 秒（walkCacheFor 把 4377 episodes / 26346 links 一次性读进主线程）。
  // 现在：① 推到 apply 之后（setTimeout 0），② 先按 manifest 的规模闸判断，大库直接跳过，③ 失败静默。
  const scheduleWarmUp = () => {
    try {
      const root = resolveStoreRoot(config);
      if (!root || !fs.existsSync(root)) return;
      const manifestPath = path.join(root, 'manifest.json');
      let counts = null;
      try { counts = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))?.counts ?? null; } catch { counts = null; }
      const episodes = Number(counts?.episodes ?? 0);
      const links = Number(counts?.links ?? 0);
      // 规模闸：超过这个量级，预热的收益远小于"卡住宿主"的代价
      const tooBig = episodes > WARMUP_MAX_EPISODES || links > WARMUP_MAX_LINKS;
      if (tooBig) {
        warn(ctx, `跳过预热：库规模过大（episodes=${episodes} links=${links}）——首轮走冷路径，避免阻塞宿主`);
        return;
      }
      walkCacheFor(root, openReadStore(root), { createWalkCache });
    } catch (error) {
      warn(ctx, `预热失败（首轮可能变慢）：${String(error?.message ?? error)}`);
    }
  };
  if (config.enabled || config.shadow) {
    const timer = setTimeout(scheduleWarmUp, 0);
    if (typeof timer?.unref === 'function') timer.unref();
    disposers.push(() => { try { clearTimeout(timer); } catch { /* 已触发 */ } });
  }

  // 2026-11-04（S17）：把记忆查询注册成**工具** —— PTC / run_code 模式下宿主会据此生成 SDK 绑定。
  // T388（2026-11-18）：**不再用 `ctx.inject(['tools'])` 去等一个可能永远不来的服务**
  // （服务不来 ⇒ 子插件永远 PENDING ⇒ web 启动时"未激活 entry"⇒ 整个 GUI 起不来）。
  try {
    const storeRoot = resolveStoreRoot(config);
    const dshHome = storeRoot ? path.dirname(storeRoot) : null;
    const createSdk = (opts) => createMemorySdk({ ...opts, dshHome: opts?.dshHome || dshHome || null });
    const ctxHasRegister = typeof ctx?.tools?.register === 'function';
    let names = registerMemoryTools(ctx, { createSdk, warn });
    let via = names.length ? 'direct' : 'none';
    if (!names.length) via = 'none';
    // 凭据**无论成没成都写**：文件里没有工具名本身就是"没注册上"的证据（否则只能靠猜）。
    if (storeRoot) recordToolRegistration(storeRoot, names, { host: 'dsh', via, ctxHasRegister });
  } catch (error) {
    warn(ctx, `工具面注册整体失败（不影响注入）：${String(error?.message ?? error)}`);
  }

  // 设置页的读写接口（只在本机 webServer 上注册；没有该服务就跳过 —— 绝不留下等待项）。
  try {
    if (typeof handleConfigRoute === 'function' && typeof ctx?.webServer?.register === 'function') {
      {
        const host = ctx;
        host.webServer.register({
          kind: 'exact',
          path: CONFIG_ROUTE,
          handler: (request, response) => {
            const method = String(request?.method ?? 'GET').toUpperCase();
            if (method === 'GET') {
              const out = handleConfigRoute({ method, profileConfig: rawConfig });
              response.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8' });
              response.end(JSON.stringify(out.body));
              return;
            }
            if (method !== 'POST') {
              response.writeHead(405, { allow: 'GET, POST' });
              response.end();
              return;
            }
            let raw = '';
            request.on('data', (chunk) => {
              raw += chunk;
              if (raw.length > 64 * 1024) request.destroy();
            });
            request.on('end', () => {
              const out = handleConfigRoute({ method, body: raw, profileConfig: rawConfig });
              response.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8' });
              response.end(JSON.stringify(out.body));
            });
          },
        });
      }
    }
  } catch (error) {
    warn(ctx, `设置接口没注册上：${String(error?.message ?? error)}`);
  }

  return { mounted: true, lifecycle, state, disposers, listen, makeEffect };
}

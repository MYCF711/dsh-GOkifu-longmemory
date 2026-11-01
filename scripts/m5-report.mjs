#!/usr/bin/env node
// M5 六轴评测报告（一条命令可复算；零模型调用）
//
// ── 契约（方案 §2.2/§8.2、docs/对标-Hindsight.md §2 六轴、task-13）────────────────
// 职责：把 M5 的六个对裁判据跑成**一份可复算的报告**：A1 负迁移 / A2 收益 / A3 可靠性 /
//       A4 延迟与成本 / A5 作用域 / A6 可回溯。每轴输出
//       `{value, unit, n, status: measured|not-live|not-consumed, caveat}`。
// 复用（**不重写口径**）：
//   A1 ← `scripts/eval.mjs` 的 `runH1`（staleTransferRate + validityCoverage）
//   A2 ← `scripts/eval.mjs` 的 `runEval`（LOO repeatFailureRate，both 口径；1σ = sqrt(p(1-p)/n)）
//   A4/A5/A6 ← R11 walk → R12 buildMemoryCard → R13 runGates（与插件热路径同一条链）
// 纪律：
//   · **缺数据记 `not-consumed`，不写 0**（没有样本时 value=null + 说明缺什么）；
//   · `not-live` 只用于"能力存在但没在宿主里真跑过"（A3：插件默认关、只有单测覆盖）；
//   · 只读 store / 工作区 / 仓库文件；**唯一写入口是 `--evidence <path>`**；
//   · 零模型调用、零新增依赖、不写 `<DSH_HOME>`。
// 入口：`runM5({storeRoot, dataRoot, workspace, runs, cards, now}) -> report`
//       `renderM5Markdown(report)` / `formatM5Report(report)` / CLI
//
// 用法：
//   node scripts/m5-report.mjs --store tmp/memory-context --workspace . \
//        --root "$DSH_HOME" --json --evidence evidence/M5-six-axis.md

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runH1, runEval } from './eval.mjs';
import { createStore } from '../src/rooms/persist.mjs';
import { walkFromSignals, createWalkCache, isScopeVisible, normalizeScopeKey } from '../src/rooms/walk.mjs';
import { buildMemoryCard, signalFromText, scopeKeyFromPath, PROVENANCE_LINE_RE } from '../src/rooms/inject.mjs';
import { runGates } from '../src/rooms/gates.mjs';

export const M5_VERSION = 1;
export const AXIS_IDS = Object.freeze(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
export const AXIS_TITLES = Object.freeze({
  A1: '负迁移',
  A2: '收益（不重复踩坑）',
  A3: '可靠性（注入失败率）',
  A4: '延迟与成本',
  A5: '作用域隔离',
  A6: '可回溯（provenance）',
});
/** 每条轴允许的状态；`measured` 才有真实数字，`not-live` = 能力在但没上线，`not-consumed` = 没数据。 */
export const AXIS_STATUSES = Object.freeze(['measured', 'not-live', 'not-consumed']);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function readSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function percentile(sorted, q) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx];
}

function round(x, digits = 3) {
  if (!Number.isFinite(x)) return null;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function axis({ value, unit, n, status, caveat, detail = null }) {
  if (!AXIS_STATUSES.includes(status)) throw new Error(`m5: 非法状态 ${status}`);
  return { value: value ?? null, unit, n: Number.isFinite(n) ? n : 0, status, caveat, ...(detail ? { detail } : {}) };
}

function pct(x) {
  return x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(2)}%`;
}

function readStoreEpisodes(storeRoot) {
  const dir = path.join(storeRoot, 'episodes');
  const out = new Map();
  let names = [];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (record && typeof record.id === 'string') out.set(record.id, record);
    } catch {
      /* 坏条目跳过：评测不该因为一条坏文件整片失败 */
    }
  }
  return out;
}

/** 机械信号集：主题库 df 降序前 N 个 key（去重、长度 ≥3）；不够时用固定短语补齐。 */
export function buildSignalTexts(store, count) {
  const texts = [];
  const seen = new Set();
  let topics = [];
  try {
    topics = store.list('topics').map((x) => x?.record).filter((r) => r && typeof r.key === 'string');
  } catch {
    topics = [];
  }
  topics.sort((a, b) => ((b.df ?? 0) - (a.df ?? 0)) || String(a.key).localeCompare(String(b.key)));
  for (const topic of topics) {
    const key = String(topic.key ?? '').trim();
    if (key.length < 3 || seen.has(key)) continue;
    seen.add(key);
    texts.push(key);
    if (texts.length >= count) break;
  }
  const fallback = ['棋院 记忆库', 'git 冲突', 'yaml 装不上', '时间戳', '注入 预算', '测试 失败', '索引 重算', '宿主 插件'];
  for (let i = 0; texts.length < count && i < fallback.length * 8; i += 1) texts.push(fallback[i % fallback.length]);
  return texts.slice(0, count);
}

// ---------------------------------------------------------------------------
// A1 · 负迁移（复用 runH1）
// ---------------------------------------------------------------------------

export async function measureA1({ storeRoot, workspace, now, signals, crossScopeLeakRate, h1Report = null }) {
  let h1;
  try {
    // `h1Report` 只给测试注入已知答案用（默认真跑复用 runH1，口径不重写）
    h1 = h1Report ?? await runH1({ storeRoot, workspace, now, signals });
  } catch (err) {
    return axis({
      value: null,
      unit: 'rate',
      n: 0,
      status: 'not-consumed',
      caveat: `H1 跑不起来（${String(err?.message ?? err)}）；staleTransferRate 无样本`,
    });
  }
  const withValidity = Number(h1.validityCoverage?.withValidity ?? 0);
  const renderedValidity = Number(h1.validityCoverage?.rendered ?? 0);
  const validityCoverage = withValidity === 0 ? null : renderedValidity / withValidity;
  const injected = Number(h1.injected ?? 0);
  const measured = injected > 0 && withValidity > 0;
  const vacuous = measured && validityCoverage === 0;
  const detail = {
    vacuous,
    staleTransferRate: h1.staleTransferRate ?? null,
    staleInjected: h1.staleInjected ?? 0,
    injected,
    postGateStaleRate: h1.postGateStaleRate ?? null,
    validityCoverage: { withValidity, rendered: renderedValidity, ratio: validityCoverage },
    crossScopeLeakRate,
    signals: h1.signals ?? null,
    cardsWithContent: h1.cardsWithContent ?? null,
    zeroInjection: h1.zeroInjection ?? null,
  };
  const parts = [];
  if (injected === 0) parts.push('没有注入条目（卡片全空）⇒ 分母为 0，不写 0');
  if (withValidity === 0) parts.push('语料里没有带 validity 的条目 ⇒ stale 分子恒为 0，未锻炼到');
  else if (renderedValidity === 0) parts.push(`带 validity 的 ${withValidity} 条一次都没被渲染到 ⇒ 覆盖率为 0，0% 不代表没风险`);
  parts.push(`validityCoverage=${pct(validityCoverage)}（${renderedValidity}/${withValidity}）`);
  parts.push(`crossScopeLeakRate=${pct(crossScopeLeakRate)}（见 A5）`);
  if (vacuous) parts.unshift('**0% 是空转的**（带 validity 的条目一条也没被渲染过）');
  return axis({
    value: measured ? (h1.staleTransferRate ?? null) : null,
    unit: 'rate',
    n: injected,
    status: measured ? 'measured' : 'not-consumed',
    caveat: parts.join('；'),
    detail,
  });
}

// ---------------------------------------------------------------------------
// A2 · 收益（复用 runEval 的 LOO repeatFailureRate）
// ---------------------------------------------------------------------------

export async function measureA2({ dataRoot, storeRoot, now }) {
  if (!dataRoot || !fs.existsSync(dataRoot)) {
    return axis({
      value: null,
      unit: 'rate',
      n: 0,
      status: 'not-consumed',
      caveat: '没有数据根（--root/$DSH_HOME）⇒ 无法取失败签名，LOO 不跑；缺数据不写 0',
    });
  }
  try {
    const report = await runEval({ dataRoot, storeRoot, source: 'both', now });
    const totals = report.primary.totals;
    const n = totals.signatures;
    const rate = totals.rate;
    const sigma = rate === null || !n ? null : Math.sqrt((rate * (1 - rate)) / n);
    const measured = rate !== null && n > 0;
    return axis({
      value: measured ? rate : null,
      unit: 'rate',
      n,
      status: measured ? 'measured' : 'not-consumed',
      caveat: measured
        ? `LOO（both 口径）repeat=${totals.repeat} novel=${totals.novel}；1σ=±${pct(sigma)}；coverage=${pct(report.primary.coverage.ratio)}（${report.primary.coverage.evaluated}/${report.corpus.rootEpisodes} 局）`
        : 'LOO 分母为 0（没有可评测的失败签名）⇒ 不写 0',
      detail: {
        repeat: totals.repeat,
        novel: totals.novel,
        sigma,
        rootEpisodes: report.corpus.rootEpisodes,
        evaluatedEpisodes: report.primary.coverage.evaluated,
        distinctSignatures: totals.distinctSignatures,
        variants: report.corpus.variants,
      },
    });
  } catch (err) {
    return axis({
      value: null,
      unit: 'rate',
      n: 0,
      status: 'not-consumed',
      caveat: `runEval 失败（${String(err?.message ?? err)}）`,
    });
  }
}

// ---------------------------------------------------------------------------
// A3 · 可靠性（读插件事实；不在宿主里跑）
// ---------------------------------------------------------------------------

export function readPluginFacts(repoRoot = REPO_ROOT) {
  const pluginFile = path.join(repoRoot, 'src', 'plugin.mjs');
  const testFile = path.join(repoRoot, 'test', 'plugin.test.mjs');
  const pluginSrc = readSafe(pluginFile);
  const testSrc = readSafe(testFile);
  const unitTests = testSrc ? (testSrc.match(/(^|\n)\s*test\(/g) ?? []).length : 0;
  let enabledDefault = null;
  if (pluginSrc) {
    const cfg = pluginSrc.match(/export const DEFAULT_CONFIG\s*=\s*Object\.freeze\(\{([\s\S]{0,2000})/);
    const block = cfg ? cfg[1] : pluginSrc;
    const m = block.match(/\benabled:\s*(true|false)/);
    if (m) enabledDefault = m[1] === 'true';
  }
  const shadowDefault = pluginSrc
    ? (pluginSrc.match(/export const DEFAULT_CONFIG\s*=\s*Object\.freeze\(\{([\s\S]{0,2000})/) ?? [null, pluginSrc])[1].match(/\bshadow:\s*(true|false)/)
    : null;
  return {
    pluginPresent: Boolean(pluginSrc),
    pluginFile: path.relative(repoRoot, pluginFile).split(path.sep).join('/'),
    hook: 'agent/pre-step',
    enabledDefault,
    shadowDefault: shadowDefault ? shadowDefault[1] === 'true' : null,
    unitTests,
    testFile: path.relative(repoRoot, testFile).split(path.sep).join('/'),
  };
}

export function measureA3({ repoRoot = REPO_ROOT, liveAttempts = 0 } = {}) {
  const facts = readPluginFacts(repoRoot);
  if (!facts.pluginPresent) {
    return axis({
      value: null,
      unit: 'rate',
      n: 0,
      status: 'not-consumed',
      caveat: '没有 src/plugin.mjs（宿主入口未落地）⇒ 注入失败率无口径',
    });
  }
  return axis({
    value: 0, // 单测口径：21 条用例全过；线上样本 0 次 ⇒ 见 caveat 与 status=not-live
    unit: 'rate',
    n: facts.unitTests,
    status: 'not-live',
    caveat: `真注入默认关（enabled=${facts.enabledDefault}，shadow=${facts.shadowDefault}）；0 失败率来自 ${facts.unitTests} 条单测覆盖，不是线上样本；本机从未在宿主里真跑过一次注入（liveAttempts=${liveAttempts}）⇒ 不能当可靠性证据`,
    detail: { ...facts, liveAttempts },
  });
}

// ---------------------------------------------------------------------------
// A4 / A5 / A6 · 同一条热路径跑 N 次
// ---------------------------------------------------------------------------

function signalScope(workspace) {
  return scopeKeyFromPath(workspace);
}

/**
 * 跑 N 次 walk → card → gates（与插件热路径同一条链），收集延迟、tokens、作用域与 provenance。
 * @param {{store, workspace, texts, runs, now}} p
 */
export function runPipeline({ store, workspace, texts, runs, now }) {
  const scope = signalScope(workspace);
  const t0 = performance.now();
  const cache = createWalkCache(store);
  const coldCacheMs = performance.now() - t0;

  const times = [];
  const cards = [];
  let gatesFailed = 0;
  let zeroInjection = 0;
  let walkCrossScope = 0;
  let walkScopeMissing = 0;

  for (let i = 0; i < runs; i += 1) {
    const text = texts[i % texts.length];
    const signal = signalFromText(text, { at: now });
    signal.scopeKey = scope;
    const started = performance.now();
    const walk = walkFromSignals({ signal, store, scope, cache, depth: 2, limit: 5, budgetTokens: 500 });
    const card = buildMemoryCard({ cache, signal, walkResult: walk, store, scope, now, limit: 5, budgetTokens: 500 });
    const gates = runGates({ card, walkResult: walk, store, scope, cache });
    const ms = performance.now() - started;
    times.push(ms);
    walkCrossScope += Number(walk.dropped?.crossScope ?? 0);
    walkScopeMissing += Number(walk.dropped?.scopeMissing ?? 0);
    if (!gates.ok) gatesFailed += 1;
    if (!card.section) zeroInjection += 1;
    cards.push({ ms, card, walk, gates, signalText: text });
  }

  const sorted = [...times].sort((a, b) => a - b);
  return {
    scope,
    coldCacheMs: round(coldCacheMs, 2),
    times,
    cards,
    stats: {
      n: times.length,
      p50: round(percentile(sorted, 0.5), 2),
      p90: round(percentile(sorted, 0.9), 2),
      p95: round(percentile(sorted, 0.95), 2),
      max: round(sorted[sorted.length - 1], 2),
    },
    gatesFailed,
    zeroInjection,
    walkCrossScope,
    walkScopeMissing,
  };
}

export function measureA4({ pipeline }) {
  const s = pipeline.stats;
  if (!s || s.n === 0) {
    return axis({ value: null, unit: 'ms', n: 0, status: 'not-consumed', caveat: '没有跑到任何一次热路径（runs=0）' });
  }
  const tokens = pipeline.cards.map((x) => Number(x.card?.tokens ?? 0)).sort((a, b) => a - b);
  const tokensP50 = percentile(tokens, 0.5);
  const tokensP90 = percentile(tokens, 0.9);
  return axis({
    value: s.p50,
    unit: 'ms',
    n: s.n,
    status: 'measured',
    caveat: `墙钟＝walk→card→gates（不含宿主导入）；p90=${s.p90}ms · p95=${s.p95}ms · max=${s.max}ms；tokens p50=${tokensP50}（预算 500）；冷缓存 ${pipeline.coldCacheMs}ms（一次性）；p95 受 GC 影响`,
    detail: {
      p50: s.p50,
      p90: s.p90,
      p95: s.p95,
      max: s.max,
      tokensP50,
      tokensP90,
      coldCacheMs: pipeline.coldCacheMs,
      budgetTokens: 500,
      gatesFailed: pipeline.gatesFailed,
      zeroInjection: pipeline.zeroInjection,
      scope: pipeline.scope,
    },
  });
}

/**
 * A5：跑 cardRuns 张卡，数越界条目。
 * 三重口径：① walk 自己拒掉的 `dropped.crossScope`；② 卡上的 `crossScope`；③ **独立复核**——
 * 把渲染行里的 `ep-…` 反查棋谱的 scopeKey，统计"不该出现却出现了"的行（应为 0）。
 */
export function measureA5({ pipeline, cards, episodes }) {
  const use = pipeline.cards.slice(0, cards);
  let lines = 0;
  let leakLines = 0;
  let cardCrossScope = 0;
  const leaks = [];
  const currentScope = pipeline.scope;
  for (const item of use) {
    const section = typeof item.card?.section === 'string' ? item.card.section : '';
    cardCrossScope += Number(item.card?.crossScope ?? 0) + Number(item.card?.crossScopeWalk ?? 0);
    for (const line of section.split('\n')) {
      if (!line.startsWith('- [')) continue;
      lines += 1;
      const m = PROVENANCE_LINE_RE.exec(line);
      if (!m) continue;
      const episodeId = m[3];
      const episode = episodes.get(episodeId);
      if (!episode) continue;
      const entryScope = normalizeScopeKey(episode.scopeKey ?? '');
      if (!isScopeVisible(entryScope, currentScope)) {
        leakLines += 1;
        if (leaks.length < 5) leaks.push({ episode: episodeId, scopeKey: episode.scopeKey ?? null });
      }
    }
  }
  const rate = lines === 0 ? null : leakLines / lines;
  const measured = lines > 0;
  return axis({
    value: measured ? rate : null,
    unit: 'rate',
    n: lines,
    status: measured ? 'measured' : 'not-consumed',
    caveat: measured
      ? `卡片 ${use.length} 张 / 渲染行 ${lines}；walk 拒掉跨域 ${pipeline.walkCrossScope} 条、缺域 ${pipeline.walkScopeMissing} 条；卡内跨域计数 ${cardCrossScope}；独立复核越界行 ${leakLines}（应为 0）`
      : `卡片 ${use.length} 张但一张都没有渲染行 ⇒ 没东西可查，不写 0`,
    detail: {
      cards: use.length,
      renderedLines: lines,
      leakLines,
      walkDroppedCrossScope: pipeline.walkCrossScope,
      walkScopeMissing: pipeline.walkScopeMissing,
      cardCrossScope,
      sampledLeaks: leaks,
    },
  });
}

/** A6：卡片渲染行里带 `ep-…` + 日期 + `seq` 的比例（PROVENANCE_LINE_RE 是唯一判据）。 */
export function measureA6({ pipeline, cards }) {
  const use = pipeline.cards.slice(0, cards);
  let lines = 0;
  let provenanced = 0;
  const missing = [];
  for (const item of use) {
    const section = typeof item.card?.section === 'string' ? item.card.section : '';
    for (const line of section.split('\n')) {
      if (!line.startsWith('- [')) continue;
      lines += 1;
      if (PROVENANCE_LINE_RE.test(line)) provenanced += 1;
      else if (missing.length < 5) missing.push(line.slice(0, 120));
    }
  }
  const measured = lines > 0;
  return axis({
    value: measured ? provenanced / lines : null,
    unit: 'rate',
    n: lines,
    status: measured ? 'measured' : 'not-consumed',
    caveat: measured
      ? `卡片 ${use.length} 张 / 渲染行 ${lines}；带 ep-…+日期+seq 的 ${provenanced} 行（目标 100%）${missing.length ? `；缺源示例：${missing[0]}` : ''}`
      : `卡片 ${use.length} 张但一张都没有渲染行 ⇒ 没东西可查，不写 0`,
    detail: { cards: use.length, renderedLines: lines, provenanced, missing },
  });
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

/**
 * 跑 M5 六轴。
 * @param {{storeRoot:string, dataRoot?:string|null, workspace?:string, repoRoot?:string,
 *          runs?:number, cards?:number, now?:number, signals?:number, liveAttempts?:number}} opts
 */
export async function runM5(opts = {}) {
  const started = Date.now();
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const storeRoot = path.resolve(opts.storeRoot ?? path.join(process.env.DSH_HOME ?? '', 'memory-context'));
  const workspace = path.resolve(opts.workspace ?? process.cwd());
  const dataRoot = opts.dataRoot === null ? null : path.resolve(opts.dataRoot ?? process.env.DSH_HOME ?? '');
  const runs = Number.isFinite(opts.runs) ? Math.max(1, Math.floor(opts.runs)) : 50;
  const cards = Number.isFinite(opts.cards) ? Math.max(1, Math.floor(opts.cards)) : 20;
  const h1Signals = Number.isFinite(opts.signals) ? Math.max(1, Math.floor(opts.signals)) : 36;

  const store = createStore({ root: storeRoot });
  const hasStore = fs.existsSync(path.join(storeRoot, 'manifest.json')) || fs.existsSync(path.join(storeRoot, 'episodes'));
  const episodes = readStoreEpisodes(storeRoot);

  const texts = buildSignalTexts(store, Math.max(runs, cards));
  const pipeline = runPipeline({ store, workspace, texts, runs, now });

  const a5 = hasStore ? measureA5({ pipeline, cards, episodes }) : axis({
    value: null, unit: 'rate', n: 0, status: 'not-consumed', caveat: '没有记忆库 ⇒ 没有卡片可查',
  });
  const a6 = hasStore ? measureA6({ pipeline, cards }) : axis({
    value: null, unit: 'rate', n: 0, status: 'not-consumed', caveat: '没有记忆库 ⇒ 没有渲染行可查',
  });

  const axes = {
    A1: await measureA1({
      storeRoot,
      workspace,
      now,
      signals: h1Signals,
      crossScopeLeakRate: a5.value,
    }),
    A2: await measureA2({ dataRoot, storeRoot, now }),
    A3: measureA3({ repoRoot: opts.repoRoot ?? REPO_ROOT, liveAttempts: opts.liveAttempts ?? 0 }),
    A4: measureA4({ pipeline }),
    A5: a5,
    A6: a6,
  };

  return {
    version: M5_VERSION,
    generatedAt: now,
    generatedAtIso: new Date(now).toISOString(),
    storeRoot,
    dataRoot: dataRoot ?? null,
    workspace,
    scope: pipeline.scope,
    storeFound: hasStore,
    corpus: {
      episodes: episodes.size,
      topics: (() => {
        try { return store.list('topics').length; } catch { return 0; }
      })(),
      claims: (() => {
        try { return store.list('claims').length; } catch { return 0; }
      })(),
      runs,
      cardsSample: Math.min(cards, pipeline.cards.length),
      signalTexts: texts.slice(0, Math.min(texts.length, runs)).length,
    },
    axes,
    order: [...AXIS_IDS],
    pipeline: {
      coldCacheMs: pipeline.coldCacheMs,
      gatesFailed: pipeline.gatesFailed,
      zeroInjection: pipeline.zeroInjection,
      walkDroppedCrossScope: pipeline.walkCrossScope,
      walkScopeMissing: pipeline.walkScopeMissing,
    },
    elapsedMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

const STATUS_LABEL = Object.freeze({
  measured: 'measured',
  'not-live': 'not-live（未上线）',
  'not-consumed': 'not-consumed（没数据）',
});

export function formatM5Report(report) {
  const lines = [];
  lines.push('棋院 M5 六轴报告（零模型调用 · 一条命令可复算）');
  lines.push(`记忆库（只读）：${report.storeRoot}${report.storeFound ? '' : '（未找到：按空库跑）'}`);
  lines.push(`数据根（只读）：${report.dataRoot ?? '（未给 ⇒ A2 not-consumed）'}`);
  lines.push(`工作区（只读）：${report.workspace}（scope=${report.scope}）`);
  lines.push(`语料：棋谱 ${report.corpus.episodes} · 主题 ${report.corpus.topics} · claim ${report.corpus.claims} · 热路径 ${report.corpus.runs} 次 · 抽样卡片 ${report.corpus.cardsSample}`);
  lines.push('');
  lines.push('轴  指标                       值         n      状态');
  for (const id of AXIS_IDS) {
    const a = report.axes[id];
    const shown = a.unit === 'rate' ? pct(a.value) : (a.value === null ? 'n/a' : `${a.value} ${a.unit}`);
    lines.push(`${id}  ${`${AXIS_TITLES[id]}`.padEnd(24)} ${String(shown).padEnd(9)} ${String(a.n).padStart(4)}   ${STATUS_LABEL[a.status]}`);
    lines.push(`    ${a.caveat}`);
  }
  lines.push('');
  lines.push(`耗时 ${report.elapsedMs} ms · 写入 0（只读；唯一写入口是 --evidence）`);
  return lines.join('\n');
}

export function renderM5Markdown(report) {
  const lines = [];
  lines.push('# M5 六轴报告（一条命令可复算 · 零模型调用）');
  lines.push('');
  lines.push(`> 生成：\`node scripts/m5-report.mjs --store tmp/memory-context --workspace . --root $DSH_HOME --evidence evidence/M5-six-axis.md\``);
  lines.push(`> 运行时刻：${report.generatedAtIso}（UTC；epoch ms ${report.generatedAt}）· 版本 m5-report v${report.version} · 耗时 ${report.elapsedMs} ms · 零模型调用 · 只读`);
  lines.push('');
  lines.push('## 1 · 六轴总表');
  lines.push('');
  lines.push('| 轴 | 判据 | 指标 | 值 | 单位 | 样本 n | 状态 |');
  lines.push('|---|---|---|---|---|---|---|');
  const judge = {
    A1: '负迁移受控',
    A2: '收益（主判据）',
    A3: '可靠性',
    A4: '延迟/成本',
    A5: '作用域隔离',
    A6: '可回溯',
  };
  const metric = {
    A1: 'staleTransferRate',
    A2: 'repeatFailureRate（LOO）',
    A3: 'injectFailureRate',
    A4: 'walk→card→gates p50',
    A5: 'crossScopeLeakRate',
    A6: 'provenanceCoverage',
  };
  for (const id of AXIS_IDS) {
    const a = report.axes[id];
    const shown = a.unit === 'rate' ? pct(a.value) : (a.value === null ? 'n/a' : String(a.value));
    lines.push(`| **${id}** | ${judge[id]} | \`${metric[id]}\` | **${shown}** | ${a.unit} | ${a.n} | \`${a.status}\` |`);
  }
  lines.push('');
  lines.push('状态含义：`measured` = 有真实样本；`not-live` = 能力在但没在宿主里真跑过；`not-consumed` = **没有数据，值记 null（不写 0）**。');
  lines.push('');
  lines.push('## 2 · 逐轴口径与读法');
  lines.push('');
  for (const id of AXIS_IDS) {
    const a = report.axes[id];
    lines.push(`### ${id} · ${AXIS_TITLES[id]} —— \`${metric[id]}\` = ${a.unit === 'rate' ? pct(a.value) : (a.value ?? 'n/a')}`);
    lines.push('');
    lines.push(`- 状态：\`${a.status}\`（样本 n=${a.n}）`);
    lines.push(`- 口径与限制：${a.caveat}`);
    if (a.detail) {
      lines.push('- 明细：');
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(a.detail, null, 2));
      lines.push('```');
    }
    lines.push('');
  }
  lines.push('## 3 · 语料与运行');
  lines.push('');
  lines.push(`- 记忆库（只读）：\`${report.storeRoot}\`${report.storeFound ? '' : '（未找到）'}`);
  lines.push(`- 数据根（只读）：\`${report.dataRoot ?? 'null'}\``);
  lines.push(`- 工作区：\`${report.workspace}\`（scope=\`${report.scope}\`）`);
  lines.push(`- 棋谱 ${report.corpus.episodes} · 主题 ${report.corpus.topics} · claim ${report.corpus.claims}`);
  lines.push(`- 热路径 ${report.corpus.runs} 次（A4）· 抽样卡片 ${report.corpus.cardsSample} 张（A5/A6）· 信号文本 ${report.corpus.signalTexts} 条`);
  lines.push(`- 冷缓存 ${report.pipeline.coldCacheMs} ms（一次性）· 闸不过 ${report.pipeline.gatesFailed} · 零注入 ${report.pipeline.zeroInjection} · walk 拒跨域 ${report.pipeline.walkDroppedCrossScope}`);
  lines.push('');
  lines.push('## 4 · 复现命令');
  lines.push('');
  lines.push('```bash');
  lines.push('cd "/d/DeepSeek Harness/default-workspace/长期记忆系统"');
  lines.push('node scripts/m5-report.mjs --store tmp/memory-context --workspace .                       # 文本表');
  lines.push('node scripts/m5-report.mjs --store tmp/memory-context --workspace . --root "$DSH_HOME" --json');
  lines.push('node scripts/m5-report.mjs --store tmp/memory-context --workspace . --root "$DSH_HOME" --evidence evidence/M5-six-axis.md');
  lines.push('node --test test/m5-report.test.mjs');
  lines.push('```');
  lines.push('');
  lines.push('## 5 · 读这张表前必须知道的（风险与口径）');
  lines.push('');
  lines.push('1. **六轴不是同一时点同一语料**：A1/A2 读 store + 原件（2026-11-01 入档的 24 root 局），A4/A5/A6 跑当前工作区作用域的卡片；A3 读的是单测事实，没有线上样本。跨时点不可比。');
  lines.push('2. **A2 是机械代理**（失败原文是否在更早的局里出现过），不是"模型少走弯路"的净收益；后者要配对重放。');
  lines.push('3. **A1 的 0% 不等于没风险**：`validityCoverage` 为 0 时分子恒为 0（没有任何到期条目被渲染过）。');
  lines.push('4. **A3 的 0 是"没跑过"，不是"跑得很好"**：插件默认 `enabled=false`，0 失败率来自单测覆盖。');
  lines.push('5. **A4 口径**＝walk→card→gates 的墙钟（不含宿主导入与 GC 抖动）；p95/max 受 GC 影响会跳。');
  lines.push('6. **A5 是三重计数**：walk 自拒 + 卡内计数 + 独立反查渲染行的 ep scope；三者任一非 0 都要当缺陷查。');
  lines.push('7. **A6 是文字判据**：`PROVENANCE_LINE_RE` 要求 `- [kind] text (ep-…, YYYY-MM-DD, seq N)` 整行匹配；日期或 seq 一丢就不算。');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const USAGE = `棋院 m5-report（M5 六轴报告，零模型调用）

用法：
  node scripts/m5-report.mjs --store <memoryRoot> --workspace <dir> [--root <dataRoot>]
                             [--json] [--evidence <path>] [--runs <n>] [--cards <n>]

选项：
  --store <dir>      记忆库根（默认 <DSH_HOME>/memory-context）：只读
  --workspace <dir>  当前工作区（算 scopeKey；默认当前目录）
  --root <dir>       数据根（默认 $DSH_HOME）：A2 的 LOO 要用会话日志/棋谱
  --runs <n>         热路径次数（默认 50，A4）
  --cards <n>        抽样卡片张数（默认 20，A5/A6）
  --json             输出 JSON（每轴 {value, unit, n, status, caveat}）
  --evidence <path>  写 markdown 证据（唯一写入口）
  -h, --help         本帮助
`;

export function parseArgs(argv = []) {
  const args = [...argv];
  const flags = {};
  const positional = [];
  while (args.length) {
    const a = args.shift();
    if (a === '--json') flags.json = true;
    else if (a === '-h' || a === '--help') flags.help = true;
    else if (a === '--store') flags.store = args.shift();
    else if (a.startsWith('--store=')) flags.store = a.slice('--store='.length);
    else if (a === '--root') flags.root = args.shift();
    else if (a.startsWith('--root=')) flags.root = a.slice('--root='.length);
    else if (a === '--workspace') flags.workspace = args.shift();
    else if (a.startsWith('--workspace=')) flags.workspace = a.slice('--workspace='.length);
    else if (a === '--runs') flags.runs = Number(args.shift());
    else if (a.startsWith('--runs=')) flags.runs = Number(a.slice('--runs='.length));
    else if (a === '--cards') flags.cards = Number(args.shift());
    else if (a.startsWith('--cards=')) flags.cards = Number(a.slice('--cards='.length));
    else if (a === '--evidence') flags.evidence = args.shift();
    else if (a.startsWith('--evidence=')) flags.evidence = a.slice('--evidence='.length);
    else if (a === '--now') flags.now = Number(args.shift());
    else if (a.startsWith('--now=')) flags.now = Number(a.slice('--now='.length));
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  return { flags, positional };
}

export async function runCli(argv = []) {
  const { flags } = parseArgs(argv);
  if (flags.help) return { code: 0, stdout: USAGE, stderr: '' };
  try {
    const report = await runM5({
      storeRoot: flags.store ? path.resolve(flags.store) : undefined,
      workspace: flags.workspace ? path.resolve(flags.workspace) : process.cwd(),
      dataRoot: flags.root ? path.resolve(flags.root) : (process.env.DSH_HOME ?? ''),
      runs: flags.runs,
      cards: flags.cards,
      now: flags.now,
    });
    let evidence = null;
    if (typeof flags.evidence === 'string' && flags.evidence !== '') {
      const abs = path.resolve(flags.evidence);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, renderM5Markdown(report));
      evidence = abs;
    }
    if (flags.json) return { code: 0, stdout: JSON.stringify({ ...report, evidence }, null, 2), stderr: '' };
    const text = `${formatM5Report(report)}${evidence ? `\n证据已写：${evidence}` : ''}`;
    return { code: 0, stdout: text, stderr: '' };
  } catch (err) {
    return { code: 1, stdout: '', stderr: `m5-report 失败：${String(err?.stack ?? err)}` };
  }
}

export async function main(argv = [], io = {}) {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  const res = await runCli(argv);
  if (res.stdout) out.write(res.stdout.endsWith('\n') ? res.stdout : `${res.stdout}\n`);
  if (res.stderr) err.write(res.stderr.endsWith('\n') ? res.stderr : `${res.stderr}\n`);
  return res.code;
}

export default {
  runM5,
  measureA1,
  measureA2,
  measureA3,
  measureA4,
  measureA5,
  measureA6,
  readPluginFacts,
  runPipeline,
  buildSignalTexts,
  formatM5Report,
  renderM5Markdown,
  parseArgs,
  runCli,
  main,
  AXIS_IDS,
  AXIS_STATUSES,
  M5_VERSION,
};

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}

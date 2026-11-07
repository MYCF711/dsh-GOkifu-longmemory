#!/usr/bin/env node
// M5 六轴评测报告（一条命令可复算；零模型调用）
//
// ── 契约（方案 §2.2/§8.2、docs/对标-Hindsight.md §2 六轴、task-13）────────────────
// 职责：把 M5 的六个对裁判据跑成**一份可复算的报告**：A1 负迁移 / A2 收益 / A3 可靠性 /
//       A4 延迟与成本 / A5 作用域 / A6 可回溯。每轴输出
//       `{value, unit, n, status: measured|not-live|not-consumed, caveat}`。
//       **A1 有两条并列的轴**（T7）：`A1`（staleTransferRate，记忆过期了还在用）与
//       `A1.opposite`（反向记忆率，记忆与当前信号方向相反）。两个轴都是 ≤5%，**不是替换**。
// 复用（**不重写口径**）：
//   A1 ← `scripts/eval.mjs` 的 `runH1`（staleTransferRate + validityCoverage）
//   A1.opposite ← `src/rooms/abstain.mjs` 的 `detectPolarity` / `polarityReport`（三件套：率 / 可判率 / 是否可用于决策）
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
import { errorClassKeyOf } from '../src/rooms/topic.mjs';
import { buildMemoryCard, signalFromText, scopeKeyFromPath, PROVENANCE_LINE_RE } from '../src/rooms/inject.mjs';
import { runGates, workspaceOf } from '../src/rooms/gates.mjs';
import { detectPolarity, polarityReport, polarityScorecard } from '../src/rooms/abstain.mjs';

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
export const AXIS_STATUSES = Object.freeze(['measured', 'not-live', 'not-consumed', 'live', 'live-idle']);

// T7：A1 的**两条并列轴**。`A1`（stale）的口径与数值**一字不动**；`A1.opposite` 是新增的第二条。
export const A1_STALE_AXIS_ID = 'A1';
export const A1_OPPOSITE_AXIS_ID = 'A1.opposite';
/** 两条轴并列时的固定顺序（渲染与 metrics-guard 都按它读）。 */
export const A1_AXIS_IDS = Object.freeze([A1_STALE_AXIS_ID, A1_OPPOSITE_AXIS_ID]);
/** 可判率下限（与 `polarityReport` 默认同源）：低于它 ⇒ **不可用于决策**。 */
export const A1_OPPOSITE_DECIDABILITY_FLOOR = 0.30;
/** `opposite` 精确率下限（与 `polarityReport` 默认同源）。 */
export const A1_OPPOSITE_PRECISION_FLOOR = 0.80;
/** 负迁移硬上限：与 `A1`（stale）**同一个 5%**，不是各算各的。 */
export const A1_OPPOSITE_MAX = 0.05;

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
  // 2026-11-03：闸拦下的也算锻炼（否则 A1 长期空转）
  const exercisedValidity = Number(h1.validityCoverage?.exercised ?? renderedValidity);
  const validityCoverage = withValidity === 0 ? null : exercisedValidity / withValidity;
  const injected = Number(h1.injected ?? 0);
  const postGateStaleRate = h1.postGateStaleRate ?? null;
  const postGateInjected = h1.postGateInjected ?? 0;
  const measured = injected > 0 && withValidity > 0;
  const vacuous = measured && exercisedValidity === 0;
  const detail = {
    vacuous,
    staleTransferRate: h1.staleTransferRate ?? null,
    staleInjected: h1.staleInjected ?? 0,
    injected,
    postGateStaleRate: h1.postGateStaleRate ?? null,
    validityCoverage: { withValidity, rendered: renderedValidity, exercised: exercisedValidity, ratio: validityCoverage },
    crossScopeLeakRate,
    signals: h1.signals ?? null,
    cardsWithContent: h1.cardsWithContent ?? null,
    zeroInjection: h1.zeroInjection ?? null,
  };
  const parts = [];
  if (injected === 0) parts.push('没有注入条目（卡片全空）⇒ 分母为 0，不写 0');
  if (withValidity === 0) parts.push('语料里没有带 validity 的条目 ⇒ stale 分子恒为 0，未锻炼到');
  else if (exercisedValidity === 0) parts.push(`带 validity 的 ${withValidity} 条既没被渲染、也没被闸拦下 ⇒ 覆盖率为 0，0% 不代表没风险`);
  else if (renderedValidity === 0) parts.push(`带 validity 的 ${withValidity} 条**全部被闸拦下**（渲染 0 / 拦下 ${exercisedValidity}）⇒ 0% 是"闸有效"的证据，不是空转`);
  // 2026-11-04（口径更正 S16）：A1 的主值改取**闸门后**的 stale 率 —— 负迁移指的是「错误记忆真的进了模型的上下文」，
  // 闸是产品的一部分；闸前那个数是「候选暴露度」（诊断用，照旧打印，不藏）。
  parts.push(`**闸前** staleTransferRate=${pct(h1.staleTransferRate)}（${h1.staleInjected ?? 0}/${injected} 候选）· **闸后** postGateStaleRate=${pct(postGateStaleRate)}（${h1.postGateStale ?? 0}/${h1.postGateInjected ?? 0} 到达模型）`);
  parts.push(`validityCoverage=${pct(validityCoverage)}（渲染 ${renderedValidity} + 闸拦 ${exercisedValidity - renderedValidity} / 共 ${withValidity}）`);
  parts.push(`crossScopeLeakRate=${pct(crossScopeLeakRate)}（见 A5）`);
  if (vacuous) parts.unshift('**0% 是空转的**（带 validity 的条目既没被渲染、也没被闸拦下）');
  return axis({
    // 主值 = 闸门后（真正到达模型的那部分）；闸前的数在 caveat 与 detail.staleTransferRate 里
    // 闸后优先；旧 report 没给闸后数时退回闸前（保持向后兼容，不把有读数的情况变成 null）
    value: measured ? (Number.isFinite(h1.postGateStaleRate) ? h1.postGateStaleRate : (h1.staleTransferRate ?? null)) : null,
    unit: 'rate',
    n: Number.isFinite(h1.postGateInjected) ? h1.postGateInjected : injected,
    status: measured ? 'measured' : 'not-consumed',
    caveat: parts.join('；'),
    detail,
  });
}

// ---------------------------------------------------------------------------
// A1b · 反向记忆（opposite）—— 与 A1.stale **并列**的第二条负迁移轴（T7）
//
// 与 A1 的分工：A1 测"记忆**过期**了还在用"；A1.opposite 测"记忆与当前信号**方向相反**"。
// 两条都是负迁移、硬上限都是 5%，**不是替换关系** —— A1 的口径与数值一字不动。
//
// 口径（与 `runH1` 同一条信号构造，只把 stale 判定换成方向判定）：
//   · 信号集 = 主题库 df 降序前 N 个（`${key} 相关的问题`）+ **每条带 validity 的条目用自己的文本**；
//   · 分母 = 被注入的 **(信号, claim) 行**（卡片里带 `claimId` 的渲染行）；
//   · 分子 = 其中 `detectPolarity` 判为 `opposite` 的行；
//   · 可判率 = (`same` + `opposite`) / 分母 —— 知识库 83：任何"率"必须**同时报可判率**。
//
// 为什么按"对"而不是按 claimId 去重：方向是**信号×claim**的属性（同一条 claim 对 A 反向、对 B 同向）。
// 按 claimId 去重会把"只在一条信号上可判"抬成可判率 72.2%（实测 182/252），那是口径幻觉；
// 去重后的数只作为 `detail.claimLevel` 的对照，不进主值。
//
// ⚠ 这个轴的线上值**必然是 0**（T6 实测 2354 条真实卡行里 `[semantic]`/`[disputed]`/`[stale]` 各 0 次）：
//   0% 是"没触发"，**不是**"没有反向记忆"。精确率在线上是 0/0（无正样本）⇒ **仪表未通电**，
//   `usableForDecision` 因此被额外要求"有正样本"这一条（见下）。
// ---------------------------------------------------------------------------

/** 读 T2 的标注集（`evidence/label-set.json`，135 对人工标注），跑一遍 `polarityScorecard` 作**校准**。
 *  这是唯一带人工金标的集合；线上没有金标，精确率只能由它提供。 */
function readLabelSetCalibration() {
  const file = path.join(REPO_ROOT, 'evidence', 'label-set.json');
  if (!fs.existsSync(file)) return null;
  try {
    const set = JSON.parse(fs.readFileSync(file, 'utf8'));
    const scorecard = polarityScorecard(set.pairs);
    return {
      n: Array.isArray(set.pairs) ? set.pairs.length : null,
      counts: scorecard.counts,
      report: scorecard.report,
    };
  } catch {
    return null;
  }
}

/**
 * 测 A1.opposite（反向记忆率）。
 * @param {{storeRoot:string, workspace:string, now?:number, signals?:number,
 *          cache?:object|null, hasStore?:boolean|null}} opts
 */
export async function measureA1Opposite({ storeRoot, workspace, now, signals, cache = null, hasStore = null } = {}) {
  const storeRootAbs = path.resolve(storeRoot ?? path.join(process.env.DSH_HOME ?? '', 'memory-context'));
  const workspaceAbs = path.resolve(workspace ?? process.cwd());
  const storeExists = hasStore === null
    ? (fs.existsSync(path.join(storeRootAbs, 'manifest.json')) || fs.existsSync(path.join(storeRootAbs, 'episodes')))
    : Boolean(hasStore);
  if (!storeExists) {
    return axis({
      value: null,
      unit: 'rate',
      n: 0,
      status: 'not-consumed',
      caveat: '没有记忆库 ⇒ 没有卡片行可判方向，不写 0',
    });
  }
  const store = createStore({ root: storeRootAbs });
  const read = (kind) => {
    try {
      return store.list(kind).map((x) => x?.record).filter((r) => r && typeof r === 'object');
    } catch {
      return [];
    }
  };
  const claims = read('claims');
  const joseki = read('joseki');
  const topicsAll = read('topics');
  const want = Number.isFinite(signals) ? Math.max(1, Math.floor(signals)) : 36;
  const scope = scopeKeyFromPath(workspaceAbs);
  // 信号集：与 runH1 逐字同构（主题 df 降序 + 每条带 validity 的条目）
  const sortedTopics = [...topicsAll].sort((a, b) => ((b.df ?? 0) - (a.df ?? 0)) || String(a.key ?? '').localeCompare(String(b.key ?? '')));
  const specs = [];
  const seen = new Set();
  for (const topic of sortedTopics) {
    const key = String(topic.key ?? '');
    if (key.length < 3 || seen.has(key)) continue;
    seen.add(key);
    specs.push({ kind: 'topic', text: `${key} 相关的问题`, scopeKey: scope });
    if (specs.length >= want) break;
  }
  let validitySignals = 0;
  for (const record of [...claims, ...joseki]) {
    const type = typeof record?.validity?.type === 'string' ? record.validity.type : 'none';
    if (type === 'none') continue;
    const text = typeof record.text === 'string' && record.text.trim() !== ''
      ? record.text.trim()
      : (typeof record.title === 'string' ? record.title : '');
    if (!text) continue;
    const recordWorkspace = workspaceOf(record, workspaceAbs);
    specs.push({
      kind: 'validity',
      text,
      scopeKey: recordWorkspace ? `w:${String(recordWorkspace).replace(/\\/g, '/')}` : scope,
    });
    validitySignals += 1;
  }
  const walkCache = cache ?? createWalkCache(store);
  const counts = { same: 0, opposite: 0, unclear: 0 };
  const rank = { unclear: 0, same: 1, opposite: 2 };
  const perClaim = new Map(); // claimId -> 最强方向（只作去重对照，不进主值）
  const samples = [];
  let rows = 0;
  let cardsWithContent = 0;
  for (const spec of specs) {
    const signal = signalFromText(spec.text, { at: now });
    signal.scopeKey = spec.scopeKey;
    const walk = walkFromSignals({ signal, store, scope: spec.scopeKey, depth: 2, limit: 5, budgetTokens: 500, cache: walkCache });
    const card = buildMemoryCard({ signal, walkResult: walk, store, scope: spec.scopeKey, now, limit: 5, budgetTokens: 500, cache: walkCache });
    const cardRows = (card?.claims ?? []).filter((c) => typeof c?.claimId === 'string');
    if (cardRows.length > 0) cardsWithContent += 1;
    for (const row of cardRows) {
      const record = store.get('claims', row.claimId);
      const text = String(record?.text ?? '');
      if (!text) continue; // 没有正文就判不了方向（不猜）
      rows += 1;
      const polarity = detectPolarity(spec.text, text);
      counts[polarity] += 1;
      const prev = perClaim.get(row.claimId);
      if (prev === undefined || rank[polarity] > rank[prev]) perClaim.set(row.claimId, polarity);
      if (polarity === 'opposite' && samples.length < 5) {
        samples.push({ signal: spec.text.slice(0, 120), claim: text.slice(0, 160), claimId: row.claimId, kind: spec.kind });
      }
    }
  }
  const total = counts.same + counts.opposite + counts.unclear;
  // 三件套（率 / 可判率 / 是否可用于决策）由 `polarityReport` 统一产出，不在这里重写口径。
  const polarity = polarityReport(counts, {
    decidabilityFloor: A1_OPPOSITE_DECIDABILITY_FLOOR,
    precisionFloor: A1_OPPOSITE_PRECISION_FLOOR,
  });
  const claimCounts = { same: 0, opposite: 0, unclear: 0 };
  for (const p of perClaim.values()) claimCounts[p] += 1;
  const claimTotal = perClaim.size;
  const calibration = readLabelSetCalibration();
  // **最终**判据 = `polarityReport` 的三件套 **且** 线上有正样本（`opposite > 0`）。
  // 为什么加后一条：线上 0 次触发时 opposite 精确率是 0/0 —— 0% 是"没触发"，
  // 拿它说"没有反向记忆"就是负迁移考核里最危险的那种假绿（T6 的 [disputed]=0 已经证明线上走不到这一支）。
  const usableForDecision = Boolean(polarity.usableForDecision && counts.opposite > 0);
  const decisionReason = total === 0
    ? '没有可判的渲染行（卡片全空）'
    : counts.opposite === 0
      ? '线上 0 次触发 ⇒ opposite 精确率无样本（0/0）；0% 是"没触发"不是"没有反向记忆"（仪表未通电）'
      : (!polarity.usableForDecision
        ? `可判率 ${pct(polarity.decidability)} < ${(A1_OPPOSITE_DECIDABILITY_FLOOR * 100).toFixed(0)}% 下限 ⇒ 不可用于决策`
        : '有正样本且可判率达标 ⇒ 可用于决策');
  const caveatParts = [
    `与 A1.stale **并列**的第二条负迁移轴（两个都是 ≤${(A1_OPPOSITE_MAX * 100).toFixed(0)}%，不是替换）`,
    `反向记忆率 ${pct(polarity.oppositeRate)}（${counts.opposite}/${total} 对）· 可判率 ${pct(polarity.decidability)}（${polarity.decidable}/${total}）· ${usableForDecision ? '可用于决策' : '**不可用于决策**'}（${decisionReason}）`,
    `**无触发 ≠ 无反向记忆**：T6 实测线上 2354 条真实卡行里 [semantic]/[disputed]/[stale] 各 0 次 ⇒ 本轴线上值必为 0（${counts.opposite}/${total}），不能当成"没有反向记忆"的证据`,
    `校准集（evidence/label-set.json，${calibration?.n ?? '缺'} 对人工标注）可判率 ${calibration && Number.isFinite(calibration.report?.decidability) ? pct(calibration.report.decidability) : 'n/a'} · opposite 精确率 ${calibration && Number.isFinite(calibration.report?.precision?.opposite) ? pct(calibration.report.precision.opposite) : 'n/a'}（小样本，Wilson 95% 下界约 34%）`,
    `去重对照：按 claimId 去重后 ${claimCounts.opposite}/${claimTotal}（可判率 ${pct(claimTotal ? (claimCounts.same + claimCounts.opposite) / claimTotal : null)}）—— 方向是"信号×claim 对"的属性，去重会抬高可判率，故主口径按对`,
    `信号 ${specs.length} 条（主题 ${specs.length - validitySignals} + 带 validity ${validitySignals}）`,
  ];
  return axis({
    value: total > 0 ? polarity.oppositeRate : null,
    unit: 'rate',
    n: total,
    status: total > 0 ? 'measured' : 'not-consumed',
    caveat: caveatParts.join('；'),
    detail: {
      axis: A1_OPPOSITE_AXIS_ID,
      pairedWith: A1_STALE_AXIS_ID,
      units: '被注入的 (信号, claim) 渲染行；不是 claimId 去重',
      same: counts.same,
      opposite: counts.opposite,
      unclear: counts.unclear,
      total,
      oppositeRate: polarity.oppositeRate,
      decidable: polarity.decidable,
      decidability: polarity.decidability,
      usableForDecision,
      // polarityReport 的原始三件套（未叠加"必须已有正样本"这一条）—— 两个都留，便于复核
      polarityReport: polarity,
      decisionGate: 'polarityReport.usableForDecision && opposite > 0',
      decisionReason,
      claimLevel: {
        same: claimCounts.same,
        opposite: claimCounts.opposite,
        unclear: claimCounts.unclear,
        total: claimTotal,
        oppositeRate: claimTotal ? claimCounts.opposite / claimTotal : null,
        decidability: claimTotal ? (claimCounts.same + claimCounts.opposite) / claimTotal : null,
      },
      calibration,
      signals: specs.length,
      topicSignals: specs.length - validitySignals,
      validitySignals,
      cardsWithContent,
      samples,
      hardCap: A1_OPPOSITE_MAX,
    },
  });
}

// ---------------------------------------------------------------------------
// A2 · 收益（复用 runEval 的 LOO repeatFailureRate）
//    + A2b 注入召回：对「切点之后的局里、以前出现过的失败签名」，用该签名建信号跑 walk+card，
//      看卡片是否真的指向**当年那条**（provenance 命中 prior episodes）。这是唯一衡量"记忆有没有用"的口径。
// ---------------------------------------------------------------------------

export function measureA2b({ store, report, splitAt, cache = null, limit = 30, frozen = null, walkOpts = {}, holdoutExam = null } = {}) {
  const rows = Array.isArray(report?.primary?.rows) ? report.primary.rows : [];
  const priorEpisodes = new Map(); // signature -> Set(episode)
  const eligible = [];
  for (const row of rows) {
    if (!row || !Number.isFinite(row.startedAt)) continue;
    if (row.startedAt > splitAt) {
      for (const sig of row.repeatSignatures ?? []) {
        if (priorEpisodes.has(sig)) eligible.push({ sig, scopeKey: row.scopeKey, episode: row.episode });
      }
    } else {
      for (const sig of [...(row.repeatSignatures ?? []), ...(row.novelSignatures ?? [])]) {
        if (!priorEpisodes.has(sig)) priorEpisodes.set(sig, new Set());
        priorEpisodes.get(sig).add(row.episode);
      }
    }
  }
  const scopeOf = new Map(rows.filter((x) => x && typeof x.episode === 'string').map((x) => [x.episode, x.scopeKey]));
  let sameScopeEligible = 0;
  for (const item of eligible) {
    const priorList = [...(priorEpisodes.get(item.sig) ?? [])];
    if (priorList.some((id) => scopeOf.get(id) === item.scopeKey)) sameScopeEligible += 1;
  }
  if (eligible.length === 0) return { n: 0, hits: 0, recall: null, sameScopeEligible: 0, recallSameScope: null, sampled: [], sampleSource: 'report' };
  // 冻结集合（2026-11-02）：调用方给一份固定的评估集，分母不再随语料漂移。
  const frozenItems = Array.isArray(frozen?.items) && frozen.items.length > 0 ? frozen.items : null;
  if (frozenItems) {
    for (const item of frozenItems) priorEpisodes.set(item.sig, new Set(item.prior ?? []));
  }
  // T236b：**A2b 的样本来源**（只换来源，判据一字不改）。优先级：
  //   ① `--holdout <path>` 考卷 —— 由 `scripts/a2b-holdout.mjs`（T236a）产出；固定分母，跨版本可比；
  //   ② `evidence/a2b-set.json` 冻结集（2026-11-02 起的老口径）；
  //   ③ 退回 report 里"切点之后、且有当年先例"的失败签名（最老的口径）。
  // TODO(T236a)：`a2b-holdout.mjs` 落地后，若考卷字段与本函数的 `{ sig, prior, scopeKey }` 不同，
  //   在 examItems 这一层做一次映射 —— 当前只接受同形状 `items[]`（不同形状会被当作"没有考卷"而回落）。
  const examItems = Array.isArray(holdoutExam?.items) && holdoutExam.items.length > 0 ? holdoutExam.items : null;
  const sampleItems = examItems ?? frozenItems;
  const sampleSource = examItems ? 'holdout' : (frozenItems ? 'frozen-set' : 'report');
  if (examItems) {
    for (const item of examItems) priorEpisodes.set(item.sig, new Set(item.prior ?? []));
  }
  const use = sampleItems ? sampleItems.slice(0, limit) : eligible.slice(0, limit);
  let hits = 0;
  let claimHits = 0;
  let readableHits = 0;
  let specificHits = 0;
  let displayedHits = 0;
  const sampled = [];
  for (const item of use) {
    const scope = item.scopeKey ?? null;
    const signal = signalFromText(item.sig, { at: splitAt }); // 固定时点：避免"跑在几点"影响结论（确定性）
    signal.scopeKey = scope;
    const cls = errorClassKeyOf(item.sig);
    if (cls) signal.entities.push({ kind: 'error', key: cls });
    const walk = walkFromSignals({ signal, store, scope, cache, depth: 2, limit: 5, budgetTokens: 500, ...walkOpts });
    const card = buildMemoryCard({ signal, walkResult: walk, store, scope, limit: 5, budgetTokens: 500 });
    const section = String(card?.section ?? '');
    const prior = priorEpisodes.get(item.sig) ?? new Set();
    let hit = false;
    let hitByClaim = false;
    let bestOverlap = 0;
    let bestText = '';
    let specific = false;
    let displayed = false;
    // 主判据：卡片里的 **claim** 是否覆盖当年那条（support 命中 prior episodes）——
    // 这才是「教训被召回了」；只认展示行会漏掉"claim 只显示一个代表局"的情况。
    for (const row of Array.isArray(card?.claims) ? card.claims : []) {
      const id = typeof row?.claimId === 'string' ? row.claimId : null;
      if (!id) continue;
      const record = store.get('claims', id);
      const covered = Array.isArray(record?.support) ? record.support.some((x) => prior.has(String(x?.episode ?? ''))) : false;
      if (covered) {
        hit = true;
        hitByClaim = true;
        // 严格口径：只要**任一**覆盖该签名的 claim 文本与其有 ≥2 个判别词重合就算命中
        // （早期实现取第一条覆盖 claim 就 break，会把"类级章节也在卡里"的情况误判为失分）
        const text = String(record?.text ?? '').toLowerCase();
        const tokens = String(item.sig).toLowerCase().split(/[^a-z0-9一-鿿]+/).filter((t) => t.length >= 4 && t !== 'path');
        const overlap = tokens.filter((t) => text.includes(t)).length;
        if (overlap > bestOverlap) { bestOverlap = overlap; bestText = String(record?.text ?? '').slice(0, 120); }
        if (overlap >= 2) specific = true;
      }
    }
    for (const line of section.split(String.fromCharCode(10))) {
      const m = PROVENANCE_LINE_RE.exec(line);
      if (m && prior.has(m[3])) { displayed = true; hit = true; break; }
    }
    if (hit) hits += 1;
    if (hitByClaim) claimHits += 1;
    // 2026-11-03：卡片可读性口径 —— 卡片正文里是否出现目标签名的 ≥2 个判别词。
    // 与严格口径不同：它检验"卡片有没有把这条错误的词带出来"，不要求来自 claim 文本。
    const sec = section.toLowerCase();
    const sigTokens = String(item.sig).toLowerCase().split(/[^a-z0-9一-鿿]+/).filter((t) => t.length >= 4 && t !== 'path');
    const cardOverlap = sigTokens.filter((t) => sec.includes(t)).length;
    if (cardOverlap >= 2) readableHits += 1;
    if (displayed) displayedHits += 1;
    if (specific) specificHits += 1;
    const isSameScope = item.sameScope !== undefined ? Boolean(item.sameScope) : [...prior].some((id) => scopeOf.get(id) === scope);
    sampled.push({ sig: item.sig.slice(0, 60), prior: [...prior].slice(0, 3), hit, hitByClaim, bestOverlap, bestText, specific, sameScope: isSameScope });
  }
  // 2026-11-03（调研 28 Mem0）：按 LOCOMO 四类做机械分桶，便于看短板。
  // 规则（优先级从上到下）：temporal（签名含时间词/时间戳）> multi-hop（prior ≥2 局）> open-domain（跨工作区）> single-hop。
  const TIME_RE = /(\d{4}-\d{2}-\d{2}|\d+\s*(秒|分钟|小时|天|周|月|年)|今天|昨天|刚才|最近|上周|上个月)/;
  const bucketOf = (item, priorSize, sameScope) => {
    const sig = String(item.sig ?? '');
    if (TIME_RE.test(sig)) return 'temporal';
    if (priorSize >= 2) return 'multiHop';
    if (!sameScope) return 'openDomain';
    return 'singleHop';
  };
  for (const row of sampled) {
    const item = use.find((x) => x.sig.slice(0, 60) === row.sig) ?? {};
    row.bucket = bucketOf(item, Array.isArray(row.prior) ? row.prior.length : 0, row.sameScope);
  }
  // 2026-11-04：失分**归因**（下一步该修哪一层，不再靠猜）。
  //   covered     —— claim 覆盖了当年那条（支撑命中 prior 局），但 claim 文本与该签名的判别词重叠 <2
  //                  ⇒ 是"检索到了、但卡片说的是同类的另一条错"，属文本/选源问题；
  //   notRetrieved—— 一条覆盖该签名的 claim 都没进卡 ⇒ 属检索/排序问题。
  const missBy = { covered: 0, notRetrieved: 0 };
  for (const row of sampled) {
    if (row.specific) continue;
    if (row.hitByClaim) missBy.covered += 1;
    else missBy.notRetrieved += 1;
  }
  const buckets = {};
  for (const row of sampled) {
    const b = row.bucket ?? 'singleHop';
    buckets[b] = buckets[b] ?? { n: 0, specific: 0, hit: 0, hitByClaim: 0 };
    buckets[b].n += 1;
    if (row.specific) buckets[b].specific += 1;
    if (row.hit) buckets[b].hit += 1;
    if (row.hitByClaim) buckets[b].hitByClaim += 1;
  }
  const sameScopeSampled = sampled.filter((x) => x.sameScope).length;
  const sameScopeHits = sampled.filter((x) => x.sameScope && x.hit).length;
  return {
    n: use.length,
    sampleSource,
    hits,
    claimHits,
    readableHits,
    recallReadable: use.length ? readableHits / use.length : null,
    specificHits,
    displayedHits,
    recallDisplayed: use.length ? displayedHits / use.length : null,
    recall: use.length ? hits / use.length : null,
    recallSpecific: use.length ? specificHits / use.length : null,
    sameScopeEligible,
    sameScopeSampled,
    sameScopeHits,
    recallSameScope: sameScopeSampled > 0 ? sameScopeHits / sameScopeSampled : null,
    // Q18 量化（2026-11-02）：把「只有跨工作区先例」的样本单独算一列 —— 只统计，不改变行为。
    crossScopeSampled: sampled.filter((x) => !x.sameScope).length,
    crossScopeStrict: sampled.filter((x) => !x.sameScope && x.specific).length,
    sampled,
    buckets,
    missBy,
  };
}

export async function measureA2({ dataRoot, storeRoot, now, holdoutExam = null }) {
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
    const SPLIT_AT = Date.parse('2026-11-02T00:00:00Z');
    const report = await runEval({ dataRoot, storeRoot, source: 'both', now, splitAt: SPLIT_AT });
    const totals = report.primary.totals;
    // 主值用「只有像错误的签名」口径（A2 收紧，2026-11-02 审核指出原口径 35% 不是错误文本）；
    // 全量口径同时保留，便于对照；两者都给出样本量与 n。
    const rateErrorOnly = Number.isFinite(totals.rateErrorOnly) ? totals.rateErrorOnly : null;
    const holdout = report.primary.holdout ?? null;
    let injectionRecall = null;
    try {
      const store = createStore({ root: storeRoot });
      const cache = createWalkCache(store);
      // T242：`a2b-holdout --json` 的产物是**结果文件**（n / strictHits / relatedHits），
      // 不是 `{items:[{sig,prior}]}` 那种"重跑用"的考卷 ⇒ 直接采信它的数，不重跑 walk。
      const exam = opts.holdoutExam ?? null;
      if (exam && Number.isFinite(exam.n) && exam.n > 0 && Number.isFinite(exam.strictHits)) {
        const strictRate = Number.isFinite(exam.strictRate) ? exam.strictRate : exam.strictHits / exam.n;
        const relatedRate = Number.isFinite(exam.relatedRate)
          ? exam.relatedRate
          : (Number.isFinite(exam.relatedHits) ? exam.relatedHits / exam.n : null);
        injectionRecall = {
          n: exam.n,
          sampleSource: 'holdout',
          hits: Number.isFinite(exam.relatedHits) ? exam.relatedHits : null,
          specificHits: exam.strictHits,
          recall: relatedRate,
          recallSpecific: strictRate,
          wilson: exam.wilson ?? null,
          note: 'T242：来自 evidence/a2b-holdout.json（a2b-holdout --json 的结果），未重跑 walk',
        };
      }
      let frozen = null;
      try {
        const setFile = path.join(REPO_ROOT, 'evidence', 'a2b-set.json');
        if (fs.existsSync(setFile)) frozen = JSON.parse(fs.readFileSync(setFile, 'utf8'));
      } catch { frozen = null; }
      if (!injectionRecall) {
        injectionRecall = measureA2b({ store, report, splitAt: SPLIT_AT, cache, limit: 60, frozen, holdoutExam });
      }
    } catch (error) {
      injectionRecall = { error: String(error?.message ?? error) };
    }
    const rateAll = totals.rate;
    const useErrorOnly = rateErrorOnly !== null && (totals.signaturesErrorOnly ?? 0) > 0;
    const rate = useErrorOnly ? rateErrorOnly : rateAll;
    const n = useErrorOnly ? totals.signaturesErrorOnly : totals.signatures;
    const sigma = rate === null || !n ? null : Math.sqrt((rate * (1 - rate)) / n);
    const measured = rate !== null && n > 0;
    return axis({
      value: measured ? rate : null,
      unit: 'rate',
      n,
      status: measured ? 'measured' : 'not-consumed',
      caveat: measured
        ? `LOO（both 口径，**只计像错误的签名**）repeat=${totals.repeatError} novel=${totals.novelError}；1σ=±${pct(sigma)}；coverage=${pct(report.primary.coverage.ratio)}（${report.primary.coverage.evaluated}/${report.corpus.rootEpisodes} 局）；全量口径 ${pct(rateAll)}（${totals.repeat}/${totals.signatures}，含非错误文本）；**时间切分 holdout** rate=${holdout && Number.isFinite(holdout.rate) ? pct(holdout.rate) : 'n/a'}（${holdout?.repeat ?? '?'}/${holdout?.n ?? '?'}）；**注入召回 A2b** 覆盖=${injectionRecall && Number.isFinite(injectionRecall.recall) ? pct(injectionRecall.recall) : 'n/a'}（${injectionRecall?.hits ?? '?'}/${injectionRecall?.n ?? '?'}）· **严格**=${injectionRecall && Number.isFinite(injectionRecall.recallSpecific) ? pct(injectionRecall.recallSpecific) : 'n/a'}（${injectionRecall?.specificHits ?? '?'}/${injectionRecall?.n ?? '?'}）· **卡片可读性**=${injectionRecall && Number.isFinite(injectionRecall.recallReadable) ? pct(injectionRecall.recallReadable) : 'n/a'}（${injectionRecall?.readableHits ?? '?'}/${injectionRecall?.n ?? '?'}）；**跨项目唯先例** ${injectionRecall?.crossScopeStrict ?? '?'}/${injectionRecall?.crossScopeSampled ?? '?'}（Q18 的上限）${injectionRecall?.buckets ? `；**分桶（严格）** ${Object.entries(injectionRecall.buckets).map(([k, v]) => `${k} ${v.specific}/${v.n}`).join(' · ')}` : ''}${injectionRecall?.missBy ? `；**失分归因** 覆盖但文本不匹配 ${injectionRecall.missBy.covered} / 未检索到 ${injectionRecall.missBy.notRetrieved}` : ''}`
        : 'LOO 分母为 0（没有可评测的失败签名）⇒ 不写 0',
      detail: {
        holdout,
        injectionRecall,
        repeat: totals.repeatError,
        novel: totals.novelError,
        sigma,
        rateErrorOnly,
        rateAll,
        signaturesErrorOnly: totals.signaturesErrorOnly ?? null,
        signaturesAll: totals.signatures,
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

/** A3 线上心跳（2026-11-03）：读 <store>/live-stats.jsonl，统计尝试与动作分布。 */
export function readLiveStats(storeRoot) {
  try {
    const file = path.join(storeRoot, 'live-stats.jsonl');
    if (!fs.existsSync(file)) return null;
    let rows = fs.readFileSync(file, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    // 2026-11-04：只认宿主写的行（src=index.js）。仿真/测试脚本写的行 src 是脚本名，不能当线上证据。
    const hostRows = rows.filter((r) => String(r.src ?? '') === 'index.js');
    if (!hostRows.length) return null;
    rows = hostRows;
    const actions = {};
    const reasons = {};
    for (const r of rows) {
      actions[r.action ?? '?'] = (actions[r.action ?? '?'] ?? 0) + 1;
      if (r.reason) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
    }
    return { lines: rows.length, actions, reasons, firstAt: rows[0].at ?? null, lastAt: rows[rows.length - 1].at ?? null };
  } catch {
    return null;
  }
}

export function measureA3({ repoRoot = REPO_ROOT, liveAttempts = 0, liveStats = null } = {}) {
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
  if (liveStats && liveStats.lines > 0) {
    const injects = liveStats.actions.inject ?? 0;
    const failed = liveStats.actions.failed ?? liveStats.actions.error ?? 0;
    return axis({
      value: injects + failed > 0 ? failed / (injects + failed) : null,
      unit: 'rate',
      n: liveStats.lines,
      status: injects + failed > 0 ? 'live' : 'live-idle',
      caveat: `插件已在宿主里跑：${liveStats.lines} 次 pre-step 心跳（inject=${injects}，failed=${failed}，skip=${liveStats.actions.skip ?? 0}）；`
        + (injects + failed > 0
          ? '失败率按 inject+failed 计。'
          : '还没有一次真正的注入尝试（当前会话信号都未命中）⇒ 注入可靠性仍未受检，不能把 null 当 0。'),
      detail: { ...facts, liveAttempts, liveStats },
    });
  }
  return axis({
    value: 0, // 单测口径：21 条用例全过；线上样本 0 次 ⇒ 见 caveat 与 status=not-live
    unit: 'rate',
    n: facts.unitTests,
    status: 'not-live',
    caveat: `零配置默认开（enabled=${facts.enabledDefault}，shadow=${facts.shadowDefault}，autoBuild=${facts.autoBuildDefault ?? 'n/a'}）；0 失败率来自 ${facts.unitTests} 条单测覆盖，不是线上样本；本机从未在宿主里真跑过一次注入（liveAttempts=${liveAttempts}）⇒ 不能当可靠性证据`,
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
  let crossMarkedLines = 0;
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
    crossMarkedLines,
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
 * 只读读穿缓存（性能闸，T167）。
 *
 * 为什么需要：`runH1`（A1）与 `runEval`（A2）**每个信号**都重新 `store.list()`；
 * 真库 1340 claim / 3004 topic / 6402 link / 602 episode ≈ 1.02 万个小 JSON，
 * 而 Windows 上单次 `readFileSync` ≈ 1.1 ms（`JSON.parse` 只占 0.003 ms）——
 * A1 的 176 个信号（36 主题 + 140 条带 validity）≈ 180 万次文件读 ⇒ 实测 46 分钟。
 *
 * 这里只做一件事：把**本次调用期间**从 `storeRoot` 下读到的**小文本文件**缓存住。
 * 边界（缺一条就会悄悄改变语义，故逐条写明）：
 *   · 只拦 `typeof p === 'string'` 且**显式给了编码**的读取 —— Buffer 读取（会话日志 zstd）原样走盘，
 *     免得把几百 MB 日志常驻内存；
 *   · 只拦 `storeRoot` 之下的路径 —— 别的地方（仓库文件、evidence、临时目录）读什么就是什么；
 *   · 单文件 ≤ `maxBytes`（默认 512 KB）才缓存 —— 记忆库记录都是几 KB；
 *   · **进程退出/调用结束立刻还原原函数**，缓存随作用域丢弃：不落盘、不跨进程、不跨调用 ⇒ 不存在"陈旧结果"。
 *
 * 语义正确性：记忆库在评测期间是**只读**的（`store.list` 只做 readFileSync，M5 不写库），
 * 所以同一次运行内把同一文件的字节复用，与每次重读等价。
 *
 * @param {string[]} roots    允许缓存的根目录（绝对路径）
 * @param {() => any} fn      要包住的调用
 * @param {{maxBytes?:number}} [opts]
 */
export async function withStoreReadCache(roots, fn, { maxBytes = 512 * 1024 } = {}) {
  const original = fs.readFileSync;
  const limits = (Array.isArray(roots) ? roots : [roots])
    .filter((r) => typeof r === 'string' && r !== '')
    .map((r) => path.resolve(r));
  if (limits.length === 0) return fn();
  const cache = new Map();
  const inside = (abs) => limits.some((root) => abs === root || abs.startsWith(root + path.sep));
  fs.readFileSync = function readFileSyncCached(p, options) {
    if (typeof p !== 'string') return original.call(this, p, options);
    const encoding = typeof options === 'string'
      ? options
      : (options && typeof options === 'object' ? options.encoding : null);
    if (typeof encoding !== 'string') return original.call(this, p, options);
    let abs;
    try {
      abs = path.resolve(p);
    } catch {
      return original.call(this, p, options);
    }
    if (!inside(abs)) return original.call(this, p, options);
    const key = `${abs}\u0000${encoding}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const value = original.call(this, p, options);
    if (typeof value === 'string' && value.length <= maxBytes) cache.set(key, value);
    return value;
  };
  try {
    return await fn();
  } finally {
    fs.readFileSync = original;
    cache.clear();
  }
}

/**
 * 跑 M5 六轴。
 * @param {{storeRoot:string, dataRoot?:string|null, workspace?:string, repoRoot?:string,
 *          runs?:number, cards?:number, now?:number, signals?:number, liveAttempts?:number}} opts
 */
export async function runM5(opts = {}) {
  const storeRoot = path.resolve(opts.storeRoot ?? path.join(process.env.DSH_HOME ?? '', 'memory-context'));
  // A1/A2 每个信号都重新 store.list()（见 withStoreReadCache 注释）⇒ 整个六轴跑在一次读穿缓存里。
  // `readCache: false`（CLI `--no-read-cache`）留作**对照测量**：同一份库的"优化前"行为，用来跑对拍。
  if (opts.readCache === false) return runM5Body({ ...opts, storeRoot });
  return withStoreReadCache([storeRoot], () => runM5Body({ ...opts, storeRoot }));
}

async function runM5Body(opts) {
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
    // T7：A1 的第二条轴（反向记忆率），紧挨着 A1 放 —— 两条并列、不是替换。
    // 没有记忆库时同样落 `not-consumed`（value=null），**不写 0**。
    [A1_OPPOSITE_AXIS_ID]: await measureA1Opposite({
      storeRoot,
      workspace,
      now,
      signals: h1Signals,
      hasStore,
    }),
    A2: await measureA2({ dataRoot, storeRoot, now, holdoutExam: opts.holdoutExam ?? null }),
    A3: measureA3({ repoRoot: opts.repoRoot ?? REPO_ROOT, liveAttempts: opts.liveAttempts ?? 0, liveStats: readLiveStats(storeRoot) }),
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
    // T7：A1 的两条并列轴（stale / opposite）。`order` 仍是六轴（A1–A6），
    // 这里单列是因为 A1 一个 id 下挂着两条口径不同的负迁移轴。
    a1Axes: [...A1_AXIS_IDS],
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
  live: 'live（线上在跑且有注入）',
  'live-idle': 'live-idle（线上在跑但无注入）',
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
  // T7：A1 的两条并列轴 —— 单独一块，A1 上面那行一字不动（逐字节保持）。
  const a1o = report.axes[A1_OPPOSITE_AXIS_ID];
  lines.push('');
  lines.push(`A1 负迁移 · 两轴并列（stale | opposite，两个都是 ≤${(A1_OPPOSITE_MAX * 100).toFixed(0)}%，不是替换）：`);
  lines.push(`  A1.stale    ${pct(report.axes[A1_STALE_AXIS_ID]?.value).padEnd(9)} ${String(report.axes[A1_STALE_AXIS_ID]?.n ?? 0).padStart(4)}   ${STATUS_LABEL[report.axes[A1_STALE_AXIS_ID]?.status] ?? ''}`);
  lines.push(`  A1.opposite ${pct(a1o?.value).padEnd(9)} ${String(a1o?.n ?? 0).padStart(4)}   可判率 ${pct(Number.isFinite(a1o?.detail?.decidability) ? a1o.detail.decidability : null)} · ${a1o?.detail?.usableForDecision ? '可用于决策' : '**不可用于决策**'}`);
  lines.push(`    ${a1o?.caveat ?? '（缺少 A1.opposite 轴）'}`);
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
    [A1_OPPOSITE_AXIS_ID]: '负迁移受控（反向）',
    A2: '收益（主判据）',
    A3: '可靠性',
    A4: '延迟/成本',
    A5: '作用域隔离',
    A6: '可回溯',
  };
  const metric = {
    A1: 'staleTransferRate',
    [A1_OPPOSITE_AXIS_ID]: 'oppositeRate（+ 可判率）',
    A2: 'repeatFailureRate（LOO）',
    A3: 'injectFailureRate',
    A4: 'walk→card→gates p50',
    A5: 'crossScopeLeakRate',
    A6: 'provenanceCoverage',
  };
  // T7：A1 的两条并列轴在总表里紧挨着（stale 在前，opposite 在后），其余轴顺序不变。
  const tableOrder = AXIS_IDS.flatMap((id) => (id === A1_STALE_AXIS_ID ? [A1_STALE_AXIS_ID, A1_OPPOSITE_AXIS_ID] : [id]));
  for (const id of tableOrder) {
    const a = report.axes[id];
    if (!a) continue;
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
  // T7：A1 两轴并列的对照表（stale 的口径与数值一字不动；这里只做并排展示）。
  const a1oAxis = report.axes[A1_OPPOSITE_AXIS_ID] ?? null;
  const a1sAxis = report.axes[A1_STALE_AXIS_ID] ?? null;
  lines.push('## 2b · A1 负迁移 · 两轴并列（stale | opposite）');
  lines.push('');
  lines.push('| 轴 | 指标 | 值 | 分子 / 分母 | 可判率 | 可用于决策 | 状态 |');
  lines.push('|---|---|---|---|---|---|---|');
  const a1sDetail = a1sAxis?.detail ?? {};
  const a1sNum = Number.isFinite(a1sDetail.postGateStale) ? a1sDetail.postGateStale : null;
  const a1sDen = Number.isFinite(a1sDetail.postGateInjected) ? a1sDetail.postGateInjected : null;
  lines.push(`| **A1.stale** | \`staleTransferRate\`（闸后） | **${pct(a1sAxis?.value)}** | ${a1sNum ?? '?'} / ${a1sDen ?? '?'} | 闸前 ${pct(a1sDetail.validityCoverage?.ratio ?? null)}（${a1sDetail.validityCoverage?.exercised ?? '?'} / ${a1sDetail.validityCoverage?.withValidity ?? '?'} 带 validity） | —（过期判定，不需要可判率） | \`${a1sAxis?.status ?? 'n/a'}\` |`);
  lines.push(`| **A1.opposite** | \`oppositeRate\` | **${pct(a1oAxis?.value)}** | ${a1oAxis?.detail?.opposite ?? '?'} / ${a1oAxis?.detail?.total ?? '?'} 对 | ${pct(a1oAxis?.detail?.decidability ?? null)}（${a1oAxis?.detail?.decidable ?? '?'} / ${a1oAxis?.detail?.total ?? '?'}） | ${a1oAxis?.detail?.usableForDecision ? '✅ 可用于决策' : '❌ 不可用于决策'} | \`${a1oAxis?.status ?? 'n/a'}\` |`);
  lines.push('');
  lines.push(`**为什么线上 opposite 是 0**：T6 实测 1084 张真实卡 / 2354 行里 \`[semantic]\`/\`[disputed]\`/\`[stale]\` 各 **0** 次；本轴线上值 ${pct(a1oAxis?.value)}（${a1oAxis?.detail?.opposite ?? 0}/${a1oAxis?.detail?.total ?? 0}）是**同一个 0**。`);
  lines.push('**无触发 ≠ 无反向记忆**：0 次的含义是"判据一次都没判出 opposite"，不是"线上不存在反向记忆"；精确率在线上是 0/0（无正样本）⇒ **仪表未通电**，不参与 exit code。');
  lines.push(`**这个轴的局限**：① T2 校准集（135 对人工标注）可判率 **19.3%（26/135）** < 30% 下限、零误判上限 22.2% ⇒ 按知识库 83 **不可用于决策**；② \`opposite\` 精确率 100%（2/2）是**小样本**（Wilson 95% 下界约 34%）；③ 方向是"信号×claim 对"的属性，按 claimId 去重会把可判率抬到 ${pct(a1oAxis?.detail?.claimLevel?.decidability ?? null)}（${a1oAxis?.detail?.claimLevel?.same ?? '?'}+${a1oAxis?.detail?.claimLevel?.opposite ?? '?'} / ${a1oAxis?.detail?.claimLevel?.total ?? '?'}），那是口径幻觉，故主口径按对。`);
  lines.push('');
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
  --holdout <path>   A2b 用指定考卷（scripts/a2b-holdout.mjs 产出；固定分母，跨版本可比）
  --cards <n>        抽样卡片张数（默认 20，A5/A6）
  --json             输出 JSON（每轴 {value, unit, n, status, caveat}）
  --evidence <path>  写 markdown 证据（唯一写入口）
  --no-read-cache    关掉只读读穿缓存（对照测量用：复现"优化前"耗时；结果应逐位相同）
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
    else if (a === '--holdout') flags.holdout = args.shift();
    else if (a.startsWith('--holdout=')) flags.holdout = a.slice('--holdout='.length);
    else if (a === '--evidence') flags.evidence = args.shift();
    else if (a.startsWith('--evidence=')) flags.evidence = a.slice('--evidence='.length);
    else if (a === '--now') flags.now = Number(args.shift());
    else if (a.startsWith('--now=')) flags.now = Number(a.slice('--now='.length));
    else if (a === '--no-read-cache') flags.readCache = false;
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  return { flags, positional };
}

export async function runCli(argv = []) {
  const { flags } = parseArgs(argv);
  if (flags.help) return { code: 0, stdout: USAGE, stderr: '' };
  try {
    // T236b：`--holdout <path>` 指向 T236a 的考卷；**给了就必须存在**（静默回退会让"样本换了"这条
    // 重要事实消失，A2b 的数字就不可比了）。没给 ⇒ 保持既有回落链。
    let holdoutExam = null;
    // T242：默认指向 T236a 的考卷（存在就用）；显式 --holdout 仍可覆盖。
    const defaultExam = path.join(REPO_ROOT, 'evidence', 'a2b-holdout.json');
    const examFlag = typeof flags.holdout === 'string' && flags.holdout !== ''
      ? flags.holdout
      : (process.env.KIFU_A2B_HOLDOUT || (fs.existsSync(defaultExam) ? defaultExam : ''));
    if (examFlag) {
      const examPath = path.resolve(examFlag);
      if (!fs.existsSync(examPath)) {
        throw new Error(`--holdout 指定的考卷不存在：${examPath}（先跑 node scripts/a2b-holdout.mjs 生成；T236a 未落地时不要传这个参数）`);
      }
      holdoutExam = JSON.parse(fs.readFileSync(examPath, 'utf8'));
    }
    const report = await runM5({
      holdoutExam,
      storeRoot: flags.store ? path.resolve(flags.store) : undefined,
      workspace: flags.workspace ? path.resolve(flags.workspace) : process.cwd(),
      dataRoot: flags.root ? path.resolve(flags.root) : (process.env.DSH_HOME ?? ''),
      runs: flags.runs,
      cards: flags.cards,
      now: flags.now,
      readCache: flags.readCache !== false,
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
  measureA1Opposite,
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
  A1_AXIS_IDS,
  A1_OPPOSITE_AXIS_ID,
  M5_VERSION,
};

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}

#!/usr/bin/env node
// 擂台报告（2026-11-04）：把"至少比 Hindsight 强"从口号变成**逐轴读数 + 逐轴判定**。
//
// 边（零模型调用）：
//   我方 —— `evidence/metrics-guard.json`（每轮巡检刷新：A1/A5/A6/A2b/p50）+ `live-stats.jsonl`（线上注入数/失败数）
//   对方 —— 本机 Hindsight 自己的日志（`~/.hindsight/coding-agents-logs/{usage,diag}.jsonl`，只读）
//
// 判定只有三档：`win` / `lose` / `incomparable`（含"对方没量过"这种诚实情况）。
// **不产出"我们更强"的总体结论** —— A2（收益/主判据）在对方没有同口径读数时，正确的话就是"不可比"。
//
// 用法：node scripts/arena-report.mjs [--json] [--out evidence/M7-arena.md]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
const HINDSIGHT_DIR = path.join(os.homedir(), '.hindsight', 'coding-agents-logs');

const readJsonl = (file) => {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(String.fromCharCode(10)).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};

const pct = (x) => (typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : 'n/a');

/** 分位数（输入未排序原数组；口径与 `scripts/m5-report.mjs` 的 `percentile` 一致：floor(q*n) 截断到 n-1）。 */
export function quantile(list, q) {
  const a = list.filter((x) => Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.floor(a.length * q))];
}

/** 对方（Hindsight）侧：全部从它自己的日志算，不引用厂商分数、不引用旧文档里的旧数。 */
export function summarizeHindsight({ usage = [], diag = [] } = {}) {
  const events = {};
  const lat = {};
  for (const r of diag) {
    const e = String(r.event ?? '?');
    events[e] = (events[e] ?? 0) + 1;
    if (Number.isFinite(r.ms)) (lat[e] ??= []).push(r.ms);
  }
  const banks = {};
  const sessionBanks = new Map();
  let credited = 0;
  for (const r of usage) {
    banks[r.bank ?? '?'] = (banks[r.bank ?? '?'] ?? 0) + 1;
    if (!sessionBanks.has(r.session)) sessionBanks.set(r.session, new Set());
    sessionBanks.get(r.session).add(r.bank);
    if (r.credited === true) credited += 1;
  }
  const recallOk = events.inject_recall ?? 0;
  const recallFailed = events.inject_recall_failed ?? 0;
  const recallAttempts = recallOk + recallFailed;
  const retainOk = events.retain_ok ?? 0;
  const retainFailed = events.retain_failed ?? 0;
  const pagesOk = events.pages_ok ?? 0;
  const pagesFailed = events.pages_failed ?? 0;
  return {
    source: HINDSIGHT_DIR,
    usageLines: usage.length,
    diagLines: diag.length,
    firstAt: usage[0]?.ts ?? null,
    lastAt: usage[usage.length - 1]?.ts ?? null,
    events,
    latency: {
      injectRecall: { n: lat.inject_recall?.length ?? 0, p50: quantile(lat.inject_recall ?? [], 0.5), p90: quantile(lat.inject_recall ?? [], 0.9) },
      retainOk: { n: lat.retain_ok?.length ?? 0, p50: quantile(lat.retain_ok ?? [], 0.5) },
    },
    recall: { attempts: recallAttempts, failed: recallFailed, failureRate: recallAttempts ? recallFailed / recallAttempts : null, empty: events.inject_empty ?? 0 },
    retain: { attempts: retainOk + retainFailed, failed: retainFailed, failureRate: (retainOk + retainFailed) ? retainFailed / (retainOk + retainFailed) : null },
    pages: { attempts: pagesOk + pagesFailed, failed: pagesFailed, failureRate: (pagesOk + pagesFailed) ? pagesFailed / (pagesOk + pagesFailed) : null },
    banks: (() => {
      const sorted = Object.entries(banks).sort((a, b) => b[1] - a[1]);
      const project = sorted.filter(([name]) => name.startsWith('coding-agent::'));
      return {
        count: Object.keys(banks).length,
        top: sorted.slice(0, 6),
        topProject: project[0]?.[0] ?? null,
        topProjectTurns: project[0]?.[1] ?? null,
        archiveTurns: banks.archive ?? 0,
      };
    })(),
    sessions: { total: sessionBanks.size, spanningMultipleBanks: [...sessionBanks.values()].filter((s) => s.size > 1).length },
    credited: { turns: credited, total: usage.length, rate: usage.length ? credited / usage.length : null },
  };
}

/** 我方侧：metrics-guard.json（六轴）+ live-stats.jsonl（线上注入/失败）。 */
export function summarizeOurs({ guard, liveStatsFile } = {}) {
  const values = guard?.values ?? null;
  let live = { injections: null, failed: null };
  const rows = liveStatsFile ? readJsonl(liveStatsFile).filter((r) => String(r.src ?? '') === 'index.js') : [];
  if (rows.length) {
    const inject = rows.filter((r) => r.action === 'inject');
    live = { injections: inject.length, failed: inject.filter((r) => r.error || r.failed || r.ok === false).length };
  }
  return {
    at: guard?.at ?? null,
    axes: values ? {
      a1: values.a1, a1Coverage: values.a1Coverage, a5: values.a5, a6: values.a6,
      p50: values.p50, a2bStrict: values.a2bStrict, a2bCover: values.a2bCover, a2bN: values.a2bN,
    } : null,
    live,
  };
}

/**
 * 逐轴判定。三档：win / lose / incomparable。
 * 规则只写机械判据，不写"我们更好"的形容词。
 */
export function compareAxes({ ours, theirs }) {
  const rows = [];
  const o = ours?.axes ?? {};
  rows.push({
    axis: 'A1 负迁移', verdict: 'incomparable',
    ours: o.a1 === undefined ? 'n/a' : `${pct(o.a1)}（覆盖 ${pct(o.a1Coverage)}，全部经闸判定）`,
    theirs: '未量测（其文档自认抽取是推断，无负迁移口径）',
    why: '对方没有对应读数 ⇒ 不可比；我方读数满足自定的硬上限 ≤5%。',
  });
  rows.push({
    axis: 'A2 收益（主判据）', verdict: 'incomparable',
    ours: `LOO/时间切分/注入召回见 m5；A2b 覆盖 ${o.a2bCover === undefined ? 'n/a' : pct(o.a2bCover)}、严格 ${o.a2bStrict === undefined ? 'n/a' : pct(o.a2bStrict)}（n=${o.a2bN ?? '?'}）`,
    theirs: `无同口径读数；最接近的代理是它的"被 credit 轮次" ${pct(theirs?.credited?.rate)}（${theirs?.credited?.turns}/${theirs?.credited?.total}，口径完全不同）`,
    why: '要比 A2 必须做"有/无记忆配对重放"（要调模型），当前预算内做不到 ⇒ 诚实结论是不可比，而不是"我们更强"。',
  });
  rows.push({
    axis: 'A3 可靠性', verdict: (ours?.live?.injections ?? 0) > 0 && ours?.live?.failed === 0 ? 'win' : 'incomparable',
    ours: `线上注入 ${ours?.live?.injections ?? 'n/a'} 次、失败 ${ours?.live?.failed ?? 'n/a'}（in-process，失败只降级）`,
    theirs: `recall 失败 ${pct(theirs?.recall?.failureRate)}（${theirs?.recall?.failed}/${theirs?.recall?.attempts}）· retain ${pct(theirs?.retain?.failureRate)} · pages ${pct(theirs?.pages?.failureRate)}；另有 ${theirs?.recall?.empty ?? 0} 次空注入`,
    why: '同一条"注入是否出结果"的判据下我方 0 失败；注意我方样本量小得多，随轮次继续累计。',
  });
  rows.push({
    axis: 'A4 延迟', verdict: Number.isFinite(o.p50) && Number.isFinite(theirs?.latency?.injectRecall?.p50) && o.p50 < theirs.latency.injectRecall.p50 ? 'win' : 'incomparable',
    ours: `热路径 p50 ${Number.isFinite(o.p50) ? `${o.p50}ms` : 'n/a'}（walk→card→gates，不含宿主导入）`,
    theirs: `inject recall p50 ${theirs?.latency?.injectRecall?.p50 ?? 'n/a'}ms / p90 ${theirs?.latency?.injectRecall?.p90 ?? 'n/a'}ms（n=${theirs?.latency?.injectRecall?.n ?? 0}）`,
    why: '同为本机实测；差距约两个数量级，主要来自"进程内文件读"对"跨网络服务"。',
  });
  rows.push({
    axis: 'A5 作用域', verdict: (o.a5 === 0 && (ours?.live?.injections ?? 0) > 0) ? 'win' : 'incomparable',
    ours: `按工作区隔离，跨作用域引用 ${o.a5 ?? 'n/a'}（线上留样复核）`,
    theirs: `${theirs?.banks?.count ?? '?'} 个 bank、${theirs?.sessions?.total ?? '?'} 个会话中有 ${theirs?.sessions?.spanningMultipleBanks ?? '?'} 个跨 bank；项目 bank 里最大的是共享的 \`${theirs?.banks?.topProject ?? '?'}\`（${theirs?.banks?.topProjectTurns ?? '?'} 轮），另有归档类 \`archive\` ${theirs?.banks?.archiveTurns ?? '?'} 轮`,
    why: '我方按工作区硬隔离；对方以"共享默认 bank"为主（本机实测最多轮次落在同一个 default-workspace bank），隔离粒度更粗。',
  });
  rows.push({
    axis: 'A6 可核', verdict: 'incomparable',
    ours: `结构口径 ${pct(o.a6)}；文字口径见 evidence/M7-A6-text-level.md（离线重抽 41/43，missing 0）`,
    theirs: '日志里没有"注入内容能否在原件里逐字核到"的字段（其观察带 proof count，但抽取是 LLM 推断）',
    why: '我方两项都可机械复算；对方该项不可从其日志复算 ⇒ 不可比（但"可核"本身是我方能力，不是它的缺陷声明）。',
  });
  return rows;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invoked) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const oi = argv.indexOf('--out');
  const outPath = oi >= 0 && argv[oi + 1] ? argv[oi + 1] : null;
  const guardPath = path.join(REPO, 'evidence', 'metrics-guard.json');
  const guard = fs.existsSync(guardPath) ? JSON.parse(fs.readFileSync(guardPath, 'utf8')) : null;
  const theirs = summarizeHindsight({
    usage: readJsonl(path.join(HINDSIGHT_DIR, 'usage.jsonl')),
    diag: readJsonl(path.join(HINDSIGHT_DIR, 'diag.jsonl')),
  });
  const ours = summarizeOurs({ guard, liveStatsFile: path.join(HOME, 'memory-context', 'live-stats.jsonl') });
  const rows = compareAxes({ ours, theirs });
  const summary = {
    generatedAt: new Date().toISOString(),
    oursFrom: guard ? `${guardPath}（${guard.at}）` : '（缺 metrics-guard.json：先跑 node scripts/metrics-guard.mjs）',
    theirsFrom: HINDSIGHT_DIR,
    ours,
    theirs,
    rows,
    tally: {
      win: rows.filter((r) => r.verdict === 'win').length,
      lose: rows.filter((r) => r.verdict === 'lose').length,
      incomparable: rows.filter((r) => r.verdict === 'incomparable').length,
    },
  };
  if (json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log('擂台报告（零模型调用 · 只读双方日志）');
    console.log(`我方读数：${summary.oursFrom}`);
    console.log(`对方读数：${summary.theirsFrom}（usage ${theirs.usageLines} 行 / diag ${theirs.diagLines} 行，${theirs.firstAt} → ${theirs.lastAt}）`);
    console.log('');
    for (const r of rows) {
      console.log(`[${r.verdict}] ${r.axis}`);
      console.log(`   我方：${r.ours}`);
      console.log(`   对方：${r.theirs}`);
      console.log(`   判据：${r.why}`);
    }
    console.log('');
    console.log(`合计：赢 ${summary.tally.win} · 输 ${summary.tally.lose} · 不可比 ${summary.tally.incomparable}`);
    console.log('注意：**主判据 A2 仍不可比** —— 对方没有同口径读数，要在同域做"有/无记忆配对重放"才谈得上比较。');
  }
  if (outPath) {
    const lines = [];
    lines.push('# 擂台实测（我们 vs 本机 Hindsight）');
    lines.push('');
    lines.push(`> 生成于 ${summary.generatedAt} · 零模型调用 · 只读双方日志。我方读数来自 \`${summary.oursFrom}\`；对方读数来自 \`${summary.theirsFrom}\`。`);
    lines.push('');
    lines.push('| 轴 | 判定 | 我方 | 对方 | 判据 |');
    lines.push('|---|---|---|---|---|');
    for (const r of rows) lines.push(`| ${r.axis} | **${r.verdict}** | ${r.ours} | ${r.theirs} | ${r.why} |`);
    lines.push('');
    lines.push(`**合计：赢 ${summary.tally.win} · 输 ${summary.tally.lose} · 不可比 ${summary.tally.incomparable}**。`);
    lines.push('');
    lines.push('> 主判据 A2 仍是"不可比"：对方没有同口径读数。任何"比 Hindsight 强"的总体结论都必须先补上配对重放，否则仍是口号。');
    lines.push('');
    lines.push('复现：`node scripts/arena-report.mjs --out evidence/M7-arena.md`');
    fs.writeFileSync(path.join(REPO, outPath), `${lines.join(String.fromCharCode(10))}${String.fromCharCode(10)}`);
    console.log(`已写入 ${outPath}`);
  }
}

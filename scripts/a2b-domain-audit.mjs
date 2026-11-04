#!/usr/bin/env node
// T182 · A2b 严格口径的**域分析**（只读）
//
// 回答一个具体问题：A2b 严格口径下那些**失分**，是
//   · 记忆系统该召回、但没召回（`in-domain-miss`）？
//   · 还是 ground truth 本来就要跨工作区的知识、严格口径不该算（`cross-domain`）？
//   · 还是库里根本没有对应 claim（`absent`，未入库，不是召回问题）？
//
// 纪律（硬要求）：
//   · 只读 store / 语料；不写记忆库、不改 metrics-guard / m5-report / src。
//   · **命中判定完全复用 `scripts/m5-report.mjs` 的 `measureA2b`**（同一份 frozen 评估集、
//     同一套 overlap ≥2 的严格判据），本脚本只做"域归属"的机械分类，不重写命中口径。
//   · 机械判据：域 = `scopeKey` 严格相等（与 A2b 的 `sameScope` 同口径）；不做模型打分。
//   · 域校正只**展示**，不改 metrics-guard 的口径（改分母归 lead 裁）。
//
// 用法：
//   node scripts/a2b-domain-audit.mjs [--store <dir>] [--root <DSH_HOME>] [--json] [--limit N]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runEval } from './eval.mjs';
import { measureA2b } from './m5-report.mjs';
import { createStore } from '../src/rooms/persist.mjs';
import { createWalkCache } from '../src/rooms/walk.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');
/** 与 `scripts/m5-report.mjs` 的 A2b 完全相同的切点（2026-11-02 00:00Z）。 */
export const SPLIT_AT = Date.parse('2026-11-02T00:00:00Z');
/** 冻结评估集（`scripts/m5-report.mjs` 也从这里读；19 条固定样本，分母不随语料漂移）。 */
export const FROZEN_SET = path.join(REPO, 'evidence', 'a2b-set.json');

/** episodeId → scopeKey（只读投影，取不到记 null）。 */
export function scopeIndex(episodes = []) {
  const map = new Map();
  for (const ep of episodes) {
    if (ep && typeof ep.id === 'string' && typeof ep.scopeKey === 'string') map.set(ep.id, ep.scopeKey);
  }
  return map;
}

/** 库里有哪条 claim 的 support 覆盖了 ground truth 的任一条 prior 局（"入没入库"的机械判据）。 */
export function claimsCoveringPrior(claims = [], prior = []) {
  const want = new Set((Array.isArray(prior) ? prior : []).map((x) => String(x)));
  if (want.size === 0) return [];
  return (Array.isArray(claims) ? claims : []).filter((c) => Array.isArray(c?.support)
    && c.support.some((s) => want.has(String(s?.episode ?? ''))));
}

/**
 * 未命中的机械三分类（**不看模型、不打分**）：
 *   · `absent`         —— 库里没有任何 claim 覆盖 ground truth 的 prior 局 ⇒ 未入库；
 *   · `cross-domain`   —— 有覆盖 claim，但没有任何一条落在当前 scope ⇒ ground truth 要跨域；
 *   · `in-domain-miss` —— 有覆盖 claim 且落在当前 scope ⇒ 真失分（该召回没召回）。
 * 域一律按 `scopeKey` 严格相等（与 A2b 的 `sameScope` 同口径）。
 */
export function classifyMiss({ currentScope = null, coveringScopes = [] } = {}) {
  const scopes = Array.isArray(coveringScopes) ? coveringScopes.filter((s) => typeof s === 'string') : [];
  if (scopes.length === 0) return 'absent';
  if (scopes.some((s) => s === currentScope)) return 'in-domain-miss';
  return 'cross-domain';
}

/**
 * 把 A2b 的逐样本结果 + 库侧事实拼成审计行（纯函数，便于测试）。
 *
 * @param {object} p
 * @param {Array}  p.sampled         `measureA2b(...).sampled`（命中判定的唯一来源）
 * @param {Array}  p.frozenItems     `evidence/a2b-set.json` 的 items（给全量 prior 与 scopeKey）
 * @param {Array}  p.claims          store 里的全部 claim 记录
 * @param {Map}    p.scopeByEpisode  episodeId → scopeKey
 */
export function buildSamples({ sampled = [], frozenItems = [], claims = [], scopeByEpisode = new Map() } = {}) {
  const frozenBySig = new Map();
  for (const item of Array.isArray(frozenItems) ? frozenItems : []) {
    if (item && typeof item.sig === 'string') frozenBySig.set(item.sig.slice(0, 60), item);
  }
  const byText = new Map();
  for (const c of Array.isArray(claims) ? claims : []) {
    if (typeof c?.text !== 'string') continue;
    const key = c.text.slice(0, 120);
    if (!byText.has(key)) byText.set(key, c);
  }
  const rows = [];
  (Array.isArray(sampled) ? sampled : []).forEach((row, index) => {
    const frozen = frozenBySig.get(String(row?.sig ?? '').slice(0, 60)) ?? null;
    const prior = Array.isArray(frozen?.prior) && frozen.prior.length
      ? frozen.prior.map(String)
      : (Array.isArray(row?.prior) ? row.prior.map(String) : []);
    const currentScope = frozen?.scopeKey ?? null;
    const priorScopes = [...new Set(prior.map((id) => scopeByEpisode.get(id)).filter((s) => typeof s === 'string'))];
    const covering = claimsCoveringPrior(claims, prior);
    const coveringScopes = [...new Set(covering.map((c) => c.scopeKey).filter((s) => typeof s === 'string'))];
    const matched = row?.bestText ? (byText.get(String(row.bestText)) ?? null) : null;
    const strictHit = row?.specific === true;
    rows.push({
      index,
      sig: String(row?.sig ?? ''),
      episode: frozen?.episode ?? null,
      scope: currentScope,
      bucket: row?.bucket ?? null,
      looseHit: row?.hit === true,
      strictHit,
      bestOverlap: Number.isFinite(row?.bestOverlap) ? row.bestOverlap : 0,
      matchedClaimId: matched?.id ?? null,
      matchedScope: typeof matched?.scopeKey === 'string' ? matched.scopeKey : null,
      prior: prior.slice(0, 5),
      priorScopes,
      coveringClaims: covering.length,
      coveringScopes,
      verdict: strictHit ? 'hit' : classifyMiss({ currentScope, coveringScopes }),
    });
  });
  return rows;
}

/** 汇总（含"按域校正后"的口径：把 cross-domain 从分母里去掉，只展示不改口径）。 */
export function summarize(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const n = list.length;
  const looseHits = list.filter((r) => r.looseHit).length;
  const strictHits = list.filter((r) => r.strictHit).length;
  const inDomainMiss = list.filter((r) => r.verdict === 'in-domain-miss').length;
  const crossDomain = list.filter((r) => r.verdict === 'cross-domain').length;
  const absent = list.filter((r) => r.verdict === 'absent').length;
  const denominator = n - crossDomain;
  return {
    n,
    looseHits,
    strictHits,
    strict: n > 0 ? strictHits / n : null,
    inDomainMiss,
    crossDomain,
    absent,
    correctedDenominator: denominator,
    correctedStrict: denominator > 0 ? strictHits / denominator : null,
  };
}

/** 人读的一行汇总（CLI 与证据文件共用同一串）。 */
export function formatSummary(summary) {
  const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : 'n/a');
  const s = summary;
  return `A2b 严格 = ${s.strictHits}/${s.n}（${pct(s.strict)}）· in-domain-miss ${s.inDomainMiss} · cross-domain ${s.crossDomain} · absent ${s.absent} · 域校正后 = ${s.strictHits}/${s.correctedDenominator}（${pct(s.correctedStrict)}）`;
}

/** 跑到出审计行：与 m5-report 的 A2b 完全同一条链（runEval → measureA2b(frozen)）。 */
export async function auditA2b({ storeRoot, dataRoot, limit = 60 } = {}) {
  const store = createStore({ root: storeRoot });
  const cache = createWalkCache(store);
  const report = await runEval({ dataRoot, storeRoot, source: 'both', now: Date.now(), splitAt: SPLIT_AT });
  let frozen = null;
  try {
    if (fs.existsSync(FROZEN_SET)) frozen = JSON.parse(fs.readFileSync(FROZEN_SET, 'utf8'));
  } catch { frozen = null; }
  const injectionRecall = measureA2b({ store, report, splitAt: SPLIT_AT, cache, limit, frozen });
  const claims = store.list('claims').map((x) => x.record);
  const scopeByEpisode = scopeIndex(store.list('episodes').map((x) => x.record));
  const rows = buildSamples({
    sampled: injectionRecall?.sampled ?? [],
    frozenItems: Array.isArray(frozen?.items) ? frozen.items : (Array.isArray(frozen) ? frozen : []),
    claims,
    scopeByEpisode,
  });
  return { rows, summary: summarize(rows), injectionRecall, frozen: Boolean(frozen) };
}

async function main(argv = process.argv.slice(2)) {
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const storeRoot = path.resolve(opt('store', path.join(HOME, 'memory-context')));
  const dataRoot = path.resolve(opt('root', HOME));
  if (!fs.existsSync(storeRoot)) { console.error(`没有 store：${storeRoot}`); return 2; }
  const limit = Number(opt('limit', '60'));
  const { rows, summary, injectionRecall } = await auditA2b({ storeRoot, dataRoot, limit });

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ at: new Date().toISOString(), storeRoot, dataRoot, summary, recall: {
      n: injectionRecall?.n ?? null,
      hits: injectionRecall?.hits ?? null,
      specificHits: injectionRecall?.specificHits ?? null,
      recallSpecific: injectionRecall?.recallSpecific ?? null,
      missBy: injectionRecall?.missBy ?? null,
      buckets: injectionRecall?.buckets ?? null,
    }, rows }, null, 2));
    return summary.inDomainMiss > 0 ? 1 : 0;
  }

  const short = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : String(s ?? ''));
  console.log('A2b 域分析（只读；命中判定复用 measureA2b，域按 scopeKey 严格相等）');
  console.log('');
  console.log('| # | 严格命中 | bestOverlap | 桶 | 当前 scope | 命中 claim | claim scope | 分类 |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.index + 1} | ${r.strictHit ? '命中' : '**失分**'} | ${r.bestOverlap} | ${r.bucket ?? '-'} | ${short(r.scope, 34)} | ${r.matchedClaimId ?? '-'} | ${r.matchedScope ? short(r.matchedScope, 30) : '-'} | ${r.verdict} |`);
  }
  console.log('');
  console.log(formatSummary(summary));
  const misses = rows.filter((r) => !r.strictHit);
  if (misses.length) {
    console.log('');
    console.log('未命中明细（机械三分类）：');
    for (const r of misses) {
      console.log(`- #${r.index + 1} ${short(r.sig, 70)}`);
      console.log(`    scope=${short(r.scope, 60)} · prior=${JSON.stringify(r.prior)} · priorScopes=${JSON.stringify(r.priorScopes)}`);
      console.log(`    覆盖 claim 数=${r.coveringClaims} · 覆盖域=${JSON.stringify(r.coveringScopes)} · 分类=${r.verdict}`);
    }
  }
  return summary.inDomainMiss > 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => { console.error(`A2b 域分析失败：${String(error?.message ?? error)}`); process.exit(2); });
}

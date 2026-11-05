#!/usr/bin/env node
// T253 · Q18 复评：跨项目召回（crossScopeClass）在 overlap 排序 + 实体桥之后还有没有收益。
//
// 为什么重测：Q18 裁定（2026-11-04）之后改了三件事 ——
//   ① T240 overlap 提为第一排序键；② T248 硬实体桥进判定；③ T249 shortRoot 换硬实体信号。
// 旧结论的前提变了，必须用**同一批题**做**配对**复测。
//
// 设计（只读 · 零模型 · 只在内存里开关，不改任何默认配置）：
//   · 考卷 = scripts/a2b-holdout.mjs 的 buildExam（同一批题，A/B 完全一致）
//   · A 臂 = walkFromSignals({ ... }) 默认（allowCrossScopeClass: false）
//   · B 臂 = walkFromSignals({ allowCrossScopeClass: true })
//   · 判分 = a2b-holdout 的 judgeCard（T248 判据：related && (≥2 判别词 || ≥1 硬实体)）
//   · 配对 = McNemar（只数 discordant：A 中 B 不中 / B 中 A 不中），给精确二项 p
//   · A5   = 渲染行里 scopeKey ≠ 考卷 scope 的条数（必须 0，否则 B 直接否决）
//
// 判据（写死，防止事后调参）：
//   建议改默认 ⇔ A5 = 0 **且** B 的严格命中率 Wilson **下界 > A 的 Wilson 上界**（严格更高）
//   否则维持 A（默认关）。
//
// 用法：node scripts/q18-reeval.mjs [--json] [--limit 5] [--min-signal 12]

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';
import { createWalkCache, walkFromSignals } from '../src/rooms/walk.mjs';
import { buildMemoryCard, signalFromText } from '../src/rooms/inject.mjs';
import { buildExam, judgeCard, wilsonInterval } from './a2b-holdout.mjs';

export const Q18_VERSION = 1;
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 精确二项检验（双侧）——用于 McNemar 的 discordant 对。 */
export function exactBinomialTwoSided(k, n, p = 0.5) {
  if (!Number.isFinite(n) || n <= 0) return 1;
  const choose = (a, b) => {
    let r = 1;
    for (let i = 1; i <= b; i += 1) r = (r * (a - b + i)) / i;
    return r;
  };
  const pmf = (i) => choose(n, i) * p ** i * (1 - p) ** (n - i);
  const observed = pmf(k);
  let total = 0;
  for (let i = 0; i <= n; i += 1) if (pmf(i) <= observed + 1e-12) total += pmf(i);
  return Math.min(1, total);
}

/**
 * 跑一臂（A 或 B）。
 * @returns {{items: Array, strictHits: number, n: number, a5Leaks: number, leakExamples: Array}}
 */
export function runArm({ store, exam, allowCrossScopeClass = false, limit = 5, budgetTokens = 500, cache = null } = {}) {
  const walkCache = cache ?? createWalkCache(store);
  const items = [];
  let strictHits = 0;
  let a5Leaks = 0;
  const leakExamples = [];
  for (const item of exam?.items ?? []) {
    const at = Number.isFinite(item.at) ? item.at : Date.now();
    const signal = signalFromText(item.signal, { at });
    if (item.scopeKey) signal.scopeKey = item.scopeKey;
    let card = null;
    let error = null;
    try {
      const walk = walkFromSignals({ signal, store, scope: item.scopeKey, depth: 2, limit, budgetTokens, allowCrossScopeClass, cache: walkCache });
      card = buildMemoryCard({ cache: walkCache, signal, walkResult: walk, store, scope: item.scopeKey, now: at, limit, budgetTokens });
    } catch (e) {
      error = String(e?.message ?? e);
    }
    if (error) {
      items.push({ id: item.id, kind: item.kind, signalSource: item.signalSource, episode: item.episode, strict: false, related: false, rendered: 0, error });
      continue;
    }
    const judged = judgeCard({ card, store, item });
    // A5：渲染行的 claim scopeKey 与考卷 scope 不一致 ⇒ 跨作用域泄漏
    const leaks = [];
    for (const row of Array.isArray(card?.claims) ? card.claims : []) {
      const id = typeof row?.claimId === 'string' ? row.claimId : null;
      if (!id) continue;
      const rec = store.get('claims', id);
      const claimScope = typeof rec?.scopeKey === 'string' ? rec.scopeKey : null;
      // A5 只算**工作区级**越界：`w:` 前缀且与考卷 scope 不同。
      // `u:` 前缀是用户级全局记忆（本来就跨工作区可用），不算泄漏 —— 2026-11-05 实测踩过这个口径坑。
      const isWorkspaceScoped = typeof claimScope === 'string' && claimScope.startsWith('w:');
      if (isWorkspaceScoped && item.scopeKey && claimScope !== item.scopeKey) leaks.push({ claimId: id, claimScope });
    }
    a5Leaks += leaks.length;
    if (leaks.length && leakExamples.length < 3) leakExamples.push({ item: item.id, leaks: leaks.slice(0, 2) });
    if (judged.hitStrict) strictHits += 1;
    items.push({
      id: item.id,
      kind: item.kind,
      signalSource: item.signalSource,
      episode: item.episode,
      strict: judged.hitStrict,
      related: judged.hitRelated,
      rendered: judged.rendered,
      crossScopeRendered: leaks.length,
    });
  }
  return { items, strictHits, n: items.length, a5Leaks, leakExamples, allowCrossScopeClass };
}

/** 配对比较（同一题 A vs B）。 */
export function pairedCompare(a, b) {
  const byId = new Map((b?.items ?? []).map((x) => [x.id, x]));
  let both = 0;
  let onlyA = 0;
  let onlyB = 0;
  let neither = 0;
  const flips = [];
  for (const x of a?.items ?? []) {
    const y = byId.get(x.id);
    if (!y) continue;
    if (x.strict && y.strict) both += 1;
    else if (x.strict && !y.strict) { onlyA += 1; flips.push({ id: x.id, from: 'A', to: 'B' }); }
    else if (!x.strict && y.strict) { onlyB += 1; flips.push({ id: x.id, from: 'B', to: 'A' }); }
    else neither += 1;
  }
  const discordant = onlyA + onlyB;
  return {
    n: both + onlyA + onlyB + neither,
    both,
    onlyA,
    onlyB,
    neither,
    discordant,
    delta: onlyB - onlyA,
    pExact: exactBinomialTwoSided(Math.min(onlyA, onlyB), discordant),
    flips,
  };
}

/** 判据：B 必须显著更高且 A5 = 0，才建议改默认。 */
export function decide({ a, b, paired }) {
  const wa = wilsonInterval(a.strictHits, a.n);
  const wb = wilsonInterval(b.strictHits, b.n);
  const a5ok = (a.a5Leaks ?? 0) === 0 && (b.a5Leaks ?? 0) === 0;
  const significantlyHigher = Number.isFinite(wb.lower) && Number.isFinite(wa.upper) && wb.lower > wa.upper;
  const recommend = a5ok && significantlyHigher;
  return {
    a5ok,
    significantlyHigher,
    recommend: recommend ? 'B' : 'A',
    reason: !a5ok
      ? `A5 跨作用域泄漏 ${a.a5Leaks}/${b.a5Leaks} ≠ 0 ⇒ 直接否决 B`
      : significantlyHigher
        ? `B 的 Wilson 下界 ${(wb.lower * 100).toFixed(2)}% > A 的上界 ${(wa.upper * 100).toFixed(2)}%`
        : `B 的 Wilson 下界 ${(wb.lower * 100).toFixed(2)}% 未超过 A 的上界 ${(wa.upper * 100).toFixed(2)}%（差值 ${paired.delta}，p=${paired.pExact.toFixed(3)}）`,
    wilson: { a: wa, b: wb },
  };
}

/** 分桶汇总（按 signalSource + kind）。 */
export function bucketOf(item) {
  if (item?.kind === 'repeat') return 'repeat';
  if (item?.signalSource === 'shortRootEntities') return 'shortRoot';
  if (item?.signalSource === 'firstUser') return 'firstUser';
  if (item?.signalSource === 'root') return 'self/root';
  return item?.signalSource ?? 'other';
}

export function bucketTable(a, b) {
  const byId = new Map((b?.items ?? []).map((x) => [x.id, x]));
  const out = {};
  for (const x of a?.items ?? []) {
    const y = byId.get(x.id);
    if (!y) continue;
    const k = bucketOf(x);
    out[k] = out[k] ?? { n: 0, a: 0, b: 0, onlyB: 0, onlyA: 0 };
    out[k].n += 1;
    if (x.strict) out[k].a += 1;
    if (y.strict) out[k].b += 1;
    if (!x.strict && y.strict) out[k].onlyB += 1;
    if (x.strict && !y.strict) out[k].onlyA += 1;
  }
  return out;
}

export function reeval({ store, exam, limit = 5, cache = null } = {}) {
  const walkCache = cache ?? createWalkCache(store);
  const a = runArm({ store, exam, allowCrossScopeClass: false, limit, cache: walkCache });
  const b = runArm({ store, exam, allowCrossScopeClass: true, limit, cache: walkCache });
  const paired = pairedCompare(a, b);
  const buckets = bucketTable(a, b);
  const d = decide({ a, b, paired });
  return { version: Q18_VERSION, generatedAt: Date.now(), n: a.n, a, b, paired, buckets, decision: d };
}

const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : 'n/a');

export function formatReport(r) {
  const L = [];
  L.push(`Q18 复评（T253）· 同一批题 n=${r.n} · 配对`);
  L.push(`A（默认关）严格 ${r.a.strictHits}/${r.n} = ${pct(r.a.strictHits / r.n)} · Wilson [${pct(r.decision.wilson.a.lower)}, ${pct(r.decision.wilson.a.upper)}] · A5 泄漏 ${r.a.a5Leaks}`);
  L.push(`B（开跨项目）严格 ${r.b.strictHits}/${r.n} = ${pct(r.b.strictHits / r.n)} · Wilson [${pct(r.decision.wilson.b.lower)}, ${pct(r.decision.wilson.b.upper)}] · A5 泄漏 ${r.b.a5Leaks}`);
  L.push(`配对：both ${r.paired.both} · onlyA ${r.paired.onlyA} · onlyB ${r.paired.onlyB} · neither ${r.paired.neither} · Δ=${r.paired.delta} · McNemar 精确 p=${r.paired.pExact.toFixed(4)}`);
  L.push('分桶：');
  for (const [k, v] of Object.entries(r.buckets)) L.push(`  ${k}: n=${v.n} A=${v.a} B=${v.b}（onlyB ${v.onlyB} / onlyA ${v.onlyA}）`);
  L.push(`判定：维持 ${r.decision.recommend} —— ${r.decision.reason}`);
  return L.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');
  const store = createStore({ root: path.resolve(opt('store', path.join(home, 'memory-context'))) });
  const exam = buildExam({ store, home, minSignalChars: Number(opt('min-signal', '12')) });
  const r = reeval({ store, exam, limit: Number(opt('limit', '5')) });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
  console.log(formatReport(r));
  return 0;
}

if (process.argv[1] && String(process.argv[1]).split(String.fromCharCode(92)).join('/').endsWith('scripts/q18-reeval.mjs')) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(`Q18 复评失败：${String(error?.message ?? error)}`); process.exitCode = 2; });
}

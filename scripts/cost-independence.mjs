#!/usr/bin/env node
// T335 · cost 与"文本相关"的独立性（I1 乘法检验，只读）
// 耦合强度 = P(cost>0 ∧ related) / (P(cost>0) × P(related))；=1 独立，≠1 耦合。
import fs from 'node:fs';
import { createStore } from '../src/rooms/persist.mjs';
import { createWalkCache, walkFromSignals } from '../src/rooms/walk.mjs';
import { buildMemoryCard, signalFromText } from '../src/rooms/inject.mjs';

export function coupling({ pBoth, pCost, pRel }) {
  if (!(pCost > 0) || !(pRel > 0)) return null;
  return pBoth / (pCost * pRel);
}

export function run({ store, examPath = 'evidence/a2b-holdout.json', limit = 5 } = {}) {
  const exam = JSON.parse(fs.readFileSync(examPath, 'utf8'));
  const items = Array.isArray(exam.results) ? exam.results : [];
  const cache = createWalkCache(store);
  let n = 0, cost = 0, rel = 0, both = 0, costNull = 0;
  const rows = [];
  for (const item of items) {
    const at = Number.isFinite(item.at) ? Number(item.at) : Date.now();
    const sig = signalFromText(item.signal, { at });
    if (item.scopeKey) sig.scopeKey = item.scopeKey;
    const walk = walkFromSignals({ signal: sig, store, scope: item.scopeKey, depth: 2, limit, budgetTokens: 500, cache });
    const card = buildMemoryCard({ cache, signal: sig, walkResult: walk, store, scope: item.scopeKey, now: at, limit, budgetTokens: 500 });
    const eps = Array.isArray(item.expectedEpisodes) && item.expectedEpisodes.length ? item.expectedEpisodes.map(String) : [String(item.episode ?? '')];
    for (const r of Array.isArray(card?.claims) ? card.claims : []) {
      n += 1;
      const c = Number.isFinite(r?.cost) ? Number(r.cost) : null;
      if (c === null) costNull += 1;
      const hasCost = c !== null && c > 0;
      const rec = store.get('claims', String(r?.claimId ?? ''));
      const isRel = (Array.isArray(rec?.support) ? rec.support : []).some((x) => eps.includes(String(x?.episode ?? '')));
      if (hasCost) cost += 1;
      if (isRel) rel += 1;
      if (hasCost && isRel) both += 1;
      rows.push({ claimId: r?.claimId ?? null, cost: c, related: isRel });
    }
  }
  const p = (x) => (n ? x / n : null);
  const pCost = p(cost), pRel = p(rel), pBoth = p(both);
  return { n, cost, rel, both, costNull, pCost, pRel, pBoth, strength: coupling({ pBoth, pCost, pRel }), rows: rows.slice(0, 50) };
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const home = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
  const store = createStore({ root: (await import('node:path')).resolve(opt('store', home + '/memory-context')) });
  const r = run({ store, examPath: opt('exam', 'evidence/a2b-holdout.json') });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
  const f = (x) => (x === null ? 'n/a' : x.toFixed(4));
  console.log(`T335 · cost × related 独立性 · 渲染行 ${r.n}`);
  console.log(`P(cost>0)      = ${r.cost}/${r.n} = ${f(r.pCost)}`);
  console.log(`P(related)     = ${r.rel}/${r.n} = ${f(r.pRel)}`);
  console.log(`P(cost>0 ∧ 相关) = ${r.both}/${r.n} = ${f(r.pBoth)}`);
  console.log(`耦合强度 = ${f(r.strength)}  ${r.strength === null ? '（不可计算：边际为 0）' : (Math.abs(r.strength - 1) < 0.1 ? '≈1 ⇒ 独立' : '≠1 ⇒ 耦合')}`);
  console.log(`cost 缺失（null）行: ${r.costNull}/${r.n}`);
  return 0;
}
if (process.argv[1] && String(process.argv[1]).split(String.fromCharCode(92)).join('/').endsWith('scripts/cost-independence.mjs')) {
  main().then((c) => { process.exitCode = c; }).catch((e) => { console.error(String(e?.message ?? e)); process.exitCode = 2; });
}

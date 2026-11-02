#!/usr/bin/env node
// N3-lite 离线对照（2026-11-03）：按"度数/支撑数"重排 walk 命中，能否提高 A2b 严格召回？
// 与 N6 同一套纪律：必须跑赢**随机重排**这个安慰剂，否则算噪声。
//
// 用法：node scripts/exp-n3.mjs [--set a2b-set.json] [--seeds 5] [--json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { signalFromText, buildMemoryCard, PROVENANCE_LINE_RE } from '../src/rooms/inject.mjs';
import { walkFromSignals, createWalkCache } from '../src/rooms/walk.mjs';
import { errorClassKeyOf } from '../src/rooms/topic.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const setFile = opt('set', 'a2b-set.json');
const seeds = Number(opt('seeds', '5'));
const json = argv.includes('--json');

const store = createStore({ root: path.join(HOME, 'memory-context') });
const cache = createWalkCache(store);
const frozen = JSON.parse(fs.readFileSync(path.join(REPO, 'evidence', setFile), 'utf8'));
const splitAt = Date.parse(frozen.createdAt ?? '2026-11-02T11:21:02.636Z');

// 度数：claim 的支撑局数（机械计数，不是打分）
const supportOf = new Map();
for (const item of store.list('claims')) {
  const c = item.record ?? item;
  if (!c?.id) continue;
  supportOf.set(String(c.id), Array.isArray(c.support) ? c.support.length : 0);
}

function score(item, hits) {
  const cls = errorClassKeyOf(item.sig);
  return hits.slice().sort((a, b) => {
    const ca = a.claimId ? (supportOf.get(String(a.claimId)) ?? 0) : 0;
    const cb = b.claimId ? (supportOf.get(String(b.claimId)) ?? 0) : 0;
    return cb - ca || (b.weight ?? 0) - (a.weight ?? 0);
  });
}

function run(item, mode, rnd = Math.random) {
  const scope = item.scopeKey ?? null;
  const signal = signalFromText(String(item.sig), { at: splitAt });
  signal.scopeKey = scope;
  const cls = errorClassKeyOf(item.sig);
  if (cls) signal.entities.push({ kind: 'error', key: cls });
  const walk = walkFromSignals({ signal, store, scope, cache, depth: 2, limit: 5, budgetTokens: 500 });
  let hits = Array.isArray(walk?.hits) ? walk.hits : [];
  if (mode === 'degree') hits = score(item, hits);
  if (mode === 'shuffle') hits = hits.slice().sort(() => 0.5 - rnd());
  const walk2 = { ...walk, hits };
  const card = buildMemoryCard({ signal, walkResult: walk2, store, scope, limit: 5, budgetTokens: 500 });
  const prior = new Set(item.prior ?? []);
  let hit = false; let specific = false;
  for (const row of Array.isArray(card.claims) ? card.claims : []) {
    const id = typeof row?.claimId === 'string' ? row.claimId : null;
    if (!id) continue;
    const record = store.get('claims', id);
    const covered = Array.isArray(record?.support) ? record.support.some((x) => prior.has(String(x?.episode ?? ''))) : false;
    if (!covered) continue;
    hit = true;
    const text = String(record?.text ?? '').toLowerCase();
    const tokens = String(item.sig).toLowerCase().split(/[^a-z0-9一-鿿]+/).filter((t) => t.length >= 4 && t !== 'path');
    if (tokens.filter((t) => text.includes(t)).length >= 2) specific = true;
  }
  for (const line of String(card?.section ?? '').split(String.fromCharCode(10))) {
    const m = PROVENANCE_LINE_RE.exec(line);
    if (m && prior.has(m[3])) { hit = true; break; }
  }
  return { hit, specific, tokens: card.tokens ?? 0 };
}

const n = frozen.items.length;
const base = frozen.items.map((it) => run(it, 'base'));
const deg = frozen.items.map((it) => run(it, 'degree'));
const placebo = [];
for (let s = 0; s < seeds; s += 1) placebo.push(frozen.items.map((it) => run(it, 'shuffle')));

const rate = (rows, k) => rows.filter((r) => r[k]).length / n;
const tokens = (rows) => rows.reduce((a, r) => a + r.tokens, 0);
const out = {
  set: setFile,
  n,
  base: { recall: rate(base, 'hit'), strict: rate(base, 'specific'), tokens: tokens(base) },
  degree: { recall: rate(deg, 'hit'), strict: rate(deg, 'specific'), tokens: tokens(deg) },
  placebo: {
    seeds,
    strictMax: Math.max(...placebo.map((p) => rate(p, 'specific'))),
    strictMean: placebo.reduce((a, p) => a + rate(p, 'specific'), 0) / seeds,
    recallMean: placebo.reduce((a, p) => a + rate(p, 'hit'), 0) / seeds,
  },
};
// 只有"度数重排严格召回 > 安慰剂最好的一次"才算赢
out.verdict = out.degree.strict > out.placebo.strictMax ? 'keep' : 'reject';
if (json) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`N3-lite（${setFile}，n=${n}）`);
  console.log(`基线  ：覆盖 ${(out.base.recall * 100).toFixed(1)}% · 严格 ${(out.base.strict * 100).toFixed(1)}% · tokens ${out.base.tokens}`);
  console.log(`度数重排：覆盖 ${(out.degree.recall * 100).toFixed(1)}% · 严格 ${(out.degree.strict * 100).toFixed(1)}% · tokens ${out.degree.tokens}`);
  console.log(`安慰剂（${seeds} 次随机重排）：严格最高 ${(out.placebo.strictMax * 100).toFixed(1)}% · 平均 ${(out.placebo.strictMean * 100).toFixed(1)}%`);
  console.log(`判定：${out.verdict}`);
}

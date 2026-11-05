#!/usr/bin/env node
// T268 · 只读复算：T267「最近 N 条消息的硬实体」到底带来多少召回
//
// 输入：evidence/T268-messages.jsonl（T268 采集，本机、不进 git）
// 口径（与 scripts/a2b-holdout.mjs 的合法判据一致）：
//   严格命中 = 卡上 claim 文本与"该条消息的判别词" ≥2 重合，**或** ≥1 个硬实体重合；
//   宽松命中 = 判别词 ≥1 重合。
// A 路 = 只用最后一条 user 消息（现状）；B 路 = A + 最近 N 条消息的硬实体（T267）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';
import { buildMemoryCard, signalFromText, signalTokensOf } from '../src/rooms/inject.mjs';
import { walkFromSignals, createWalkCache } from '../src/rooms/walk.mjs';
import { lastUserText, signalFromMessages, messageText } from '../src/plugin.mjs';
import { hardEntities } from './a2b-holdout.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
export const CORPUS = path.join(REPO, 'evidence', 'T268-messages.jsonl');

export function wilson(hits, n, z = 1.96) {
  if (!n) return { phat: null, lower: null, upper: null, n: 0 };
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { phat: p, lower: Math.max(0, (c - s) / d), upper: Math.min(1, (c + s) / d), n };
}

/** 单条语料 → A/B 两路的命中判定。 */
export function judgeRow({ store, cache, row, lastN = 12, limit = 5, budgetTokens = 500, now = null }) {
  const at = Number.isFinite(now) ? now : (Number.isFinite(row?.at) ? row.at : Date.now());
  const scope = row?.scopeKey ?? null;
  const run = (useMessageEntities) => {
    const sig = signalFromMessages(row?.messages ?? [], { lastN });
    const text = sig.text || lastUserText(row?.messages ?? []);
    const signal = signalFromText(text, { at });
    signal.scopeKey = scope;
    if (useMessageEntities) {
      const seen = new Set((signal.entities ?? []).map((e) => String(e?.key ?? e)));
      for (const key of sig.entities) if (!seen.has(key)) { seen.add(key); signal.entities.push({ kind: 'entity', key }); }
    }
    const walk = walkFromSignals({ signal, store, scope, cache, depth: 2, limit, budgetTokens });
    const card = buildMemoryCard({ signal, walkResult: walk, store, scope, now: at, limit, budgetTokens });
    const cardText = (card?.claims ?? []).map((c) => String(c.text ?? '')).join('\n').toLowerCase();
    const tokens = signalTokensOf(signal).filter((t) => t !== 'path');
    const overlap = tokens.filter((t) => cardText.includes(t)).length;
    const ents = Array.from(hardEntities((row?.messages ?? []).map((m) => messageText(m)).join(String.fromCharCode(10))));
    const entityHit = ents.filter((e) => cardText.includes(e)).length;
    return { strict: overlap >= 2 || entityHit >= 1, related: overlap >= 1 || entityHit >= 1, overlap, entityHit };
  };
  const a = run(false);
  const b = run(true);
  return { A: a, B: b };
}

export function replay({ store, rows, lastN = 12 } = {}) {
  const cache = createWalkCache(store);
  const out = { n: 0, A: { strict: 0, related: 0 }, B: { strict: 0, related: 0 }, delta: { strict: 0, related: 0 }, rows: [] };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !Array.isArray(row.messages) || !row.messages.length) continue;
    const r = judgeRow({ store, cache, row, lastN });
    out.n += 1;
    if (r.A.strict) out.A.strict += 1;
    if (r.A.related) out.A.related += 1;
    if (r.B.strict) out.B.strict += 1;
    if (r.B.related) out.B.related += 1;
    if (r.B.strict && !r.A.strict) out.delta.strict += 1;
    if (r.B.related && !r.A.related) out.delta.related += 1;
    out.rows.push({ episode: row.episode ?? null, A: r.A, B: r.B });
  }
  out.wilson = { A: wilson(out.A.strict, out.n), B: wilson(out.B.strict, out.n) };
  // negativeControl（代理口径）：A 路完全不重合的样本里，B 路判 related 的比例 —— 理想应为 0（新信号只该补召回，不该造命中）
  const clean = out.rows.filter((r) => r.A.overlap === 0 && r.A.entityHit === 0);
  const falsePos = clean.filter((r) => r.B.related).length;
  out.negativeControl = { n: clean.length, falsePositives: falsePos, rate: clean.length ? falsePos / clean.length : null, note: '代理口径：A 无任何重合的样本上 B 判 related 的比例' };
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const corpus = argv.includes('--corpus') ? argv[argv.indexOf('--corpus') + 1] : CORPUS;
  if (!fs.existsSync(corpus)) {
    console.log(JSON.stringify({ ok: false, reason: `语料不存在：${corpus}（T268 采集需插件重启后开始写入）`, corpus }, null, 2));
    return 0;
  }
  const rows = fs.readFileSync(corpus, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const home = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
  const store = createStore({ root: path.join(home, 'memory-context') });
  const out = replay({ store, rows });
  console.log(JSON.stringify({ ok: true, corpus, ...out, rows: undefined, sample: out.rows.slice(0, 3) }, null, 2));
  return 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) process.exitCode = main();

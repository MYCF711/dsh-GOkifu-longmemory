#!/usr/bin/env node
// T268/T278 · 只读复算：T267「最近 N 条消息的硬实体」到底带来多少召回
//
// 输入：evidence/T268-messages.jsonl（T268 采集，本机、不进 git）
// 口径（与 scripts/a2b-holdout.mjs 的合法判据**完全一致**）：
//   严格命中 = 卡上 claim 文本与"该条消息的判别词" ≥2 重合，**或** ≥1 个硬实体重合；
//   宽松命中 = 判别词 ≥1 重合。
// A 路 = 只用最后一条 user 消息（现状）；B 路 = A + 最近 N 条消息的硬实体（T267）。
//
// T278 性能：瓶颈是**每行都重跑 walk + buildMemoryCard（大量 store 文件读）**，不是 zstd 解压。
//   · 记忆化：同一 `scopeKey|最后一条user文本|实体集` 只算一次（语料里大量重复）；
//   · `--sample N` 只取前 N 条（输出里写明"抽了多少"与"是否有偏"）；
//   · 单行超过 `--row-timeout`(默认 5000ms) 记 `unverified`（跳过，不卡死，也不进分子分母）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';
import { buildMemoryCard, signalFromText, signalTokensOf } from '../src/rooms/inject.mjs';
import { walkFromSignals, createWalkCache } from '../src/rooms/walk.mjs';
import { lastUserText, signalFromMessages, messageText } from '../src/plugin.mjs';
import { hardEntities } from './a2b-holdout.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
// T282：语料写入根已收口到 sidecar（`<storeRoot>/corpus/messages.jsonl`），这里同步默认路径。
// 优先 `<DSH_HOME>/memory-context`，可用 `--corpus` / `KIFU_STORE_ROOT` 覆盖。
export const DEFAULT_STORE_ROOT = path.join(process.env.DSH_HOME || 'D:/DeepSeek Harness/home', 'memory-context');
export const CORPUS = path.join(process.env.KIFU_STORE_ROOT || DEFAULT_STORE_ROOT, 'corpus', 'messages.jsonl');
const NL = String.fromCharCode(10);

export function wilson(hits, n, z = 1.96) {
  if (!n) return { phat: null, lower: null, upper: null, n: 0 };
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { phat: p, lower: Math.max(0, (c - s) / d), upper: Math.min(1, (c + s) / d), n };
}

/** 记忆化的键：同一 scope + 同一文本 + 同一实体集 ⇒ 同一次计算。 */
export function signalKey({ scope, text, entities }) {
  return `${scope ?? ''}\u0000${text ?? ''}\u0000${[...new Set(entities ?? [])].sort().join(',')}`;
}

/** 单条语料 → A/B 两路的命中判定（`memo` 跨行复用）。 */
export function judgeRow({ store, cache, row, lastN = 12, limit = 5, budgetTokens = 500, now = null, memo = null, rowTimeoutMs = 5000 }) {
  const at = Number.isFinite(now) ? now : (Number.isFinite(row?.at) ? row.at : Date.now());
  const scope = row?.scopeKey ?? null;
  const sig = signalFromMessages(row?.messages ?? [], { lastN });
  const allText = (row?.messages ?? []).map((m) => messageText(m)).join(NL);
  const ents = Array.from(hardEntities(allText));
  const key = signalKey({ scope, text: sig.text, entities: [...sig.entities, ...ents] });
  if (memo && memo.has(key)) return memo.get(key);

  const run = (useMessageEntities) => {
    const text = sig.text || lastUserText(row?.messages ?? []);
    const signal = signalFromText(text, { at });
    signal.scopeKey = scope;
    if (useMessageEntities) {
      const seen = new Set((signal.entities ?? []).map((e) => String(e?.key ?? e)));
      for (const k of sig.entities) {
        if (seen.has(k)) continue;
        seen.add(k);
        signal.entities.push({ kind: 'entity', key: k });
      }
    }
    const walk = walkFromSignals({ signal, store, scope, cache, depth: 2, limit, budgetTokens });
    const card = buildMemoryCard({ signal, walkResult: walk, store, scope, now: at, limit, budgetTokens });
    const cardText = (card?.claims ?? []).map((c) => String(c.text ?? '')).join(NL).toLowerCase();
    const tokens = signalTokensOf(signal).filter((t) => t !== 'path');
    const overlap = tokens.filter((t) => cardText.includes(t)).length;
    const entityHit = ents.filter((e) => cardText.includes(e)).length;
    return { strict: overlap >= 2 || entityHit >= 1, related: overlap >= 1 || entityHit >= 1, overlap, entityHit };
  };

  const started = Date.now();
  let out;
  try {
    out = { A: run(false), B: run(true), unverified: false };
  } catch (error) {
    out = { A: { strict: false, related: false, overlap: 0, entityHit: 0 }, B: { strict: false, related: false, overlap: 0, entityHit: 0 }, unverified: true, error: String(error?.message ?? error) };
  }
  if (Date.now() - started > rowTimeoutMs) out = { ...out, unverified: true, slowMs: Date.now() - started };
  if (memo) memo.set(key, out);
  return out;
}

export function replay({ store, rows, lastN = 12, memo = new Map(), rowTimeoutMs = 5000 } = {}) {
  const cache = createWalkCache(store);
  const out = { n: 0, unverified: 0, A: { strict: 0, related: 0 }, B: { strict: 0, related: 0 }, delta: { strict: 0, related: 0 }, rows: [] };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !Array.isArray(row.messages) || !row.messages.length) continue;
    const r = judgeRow({ store, cache, row, lastN, memo, rowTimeoutMs });
    if (r.unverified) { out.unverified += 1; continue; }
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
  const clean = out.rows.filter((r) => r.A.overlap === 0 && r.A.entityHit === 0);
  const falsePos = clean.filter((r) => r.B.related).length;
  out.negativeControl = {
    n: clean.length,
    falsePositives: falsePos,
    rate: clean.length ? falsePos / clean.length : null,
    note: '代理口径：A 路无任何重合的样本上，B 路判 related 的比例（理想 0：新信号只该补召回，不该造命中）',
  };
  return out;
}

export function loadRows(corpus, sample = null) {
  if (!fs.existsSync(corpus)) return null;
  const rows = fs.readFileSync(corpus, 'utf8').split(NL).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  return Number.isFinite(sample) && sample > 0 ? rows.slice(0, sample) : rows;
}

export function main(argv = process.argv.slice(2)) {
  const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const corpus = arg('--corpus', CORPUS);
  const sample = arg('--sample', null);
  const rowTimeoutMs = Number(arg('--row-timeout', 5000));
  const started = Date.now();
  const rows = loadRows(corpus, sample === null ? null : Number(sample));
  if (rows === null) {
    console.log(JSON.stringify({ ok: false, reason: `语料不存在：${corpus}（T268 采集需插件运行后写入）`, corpus }, null, 2));
    return 0;
  }
  const home = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
  const store = createStore({ root: path.join(home, 'memory-context') });
  const out = replay({ store, rows, rowTimeoutMs });
  const elapsedMs = Date.now() - started;
  console.log(JSON.stringify({
    ok: true,
    corpus,
    sampled: rows.length,
    sampleNote: sample === null ? '全量（无抽样）' : `抽样前 ${rows.length} 条（**不保证无偏**：语料按写入时间排列，"前 N 条"= 最早的一批）`,
    n: out.n,
    unverified: out.unverified,
    A: out.A,
    B: out.B,
    delta: out.delta,
    wilson: out.wilson,
    negativeControl: out.negativeControl,
    elapsedMs,
    elapsedSec: Number((elapsedMs / 1000).toFixed(1)),
    sample: out.rows.slice(0, 3),
  }, null, 2));
  return 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) process.exitCode = main();

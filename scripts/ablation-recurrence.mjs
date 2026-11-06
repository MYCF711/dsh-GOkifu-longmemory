#!/usr/bin/env node
// T305 · Ablation：有记忆 vs 无记忆的"同错复发率"（只读，回放口径）
//
// 为什么这样设计（不能真跑模型）：用**局内复发**当代理终点。
//   · 失败签名 S 在 seq s1 首次出现；若在 s1 之后**再次**出现 ⇒ **复发**（没被记住）。
//   · 若库里有 claim 引用了 (episode, s1) 的这段原文 ⇒ 该签名**有记忆可召**（A 组）；
//     否则 ⇒ **无货可召**（B 组）。
//   · 判据：A 组复发率 < B 组复发率 ⇒ 记忆有用；无差别 ⇒ 记忆是摆设。
//
// 纪律：只读；只用 T279 的 20 局语料（不换）；negative control = 库里完全没有 claim 的局（两路应无差别）。
//
// 用法：node scripts/ablation-recurrence.mjs [--json] [--window 5]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { readFrames, parseEvents } from '../src/rooms/logread.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export function defaultHome(env = process.env) {
  return path.resolve(env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || '.', 'DeepSeek Harness', 'home'));
}
export function wilson(hits, n, z = 1.96) {
  if (!n) return { phat: null, lower: null, upper: null, n: 0 };
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { phat: p, lower: Math.max(0, (c - s) / d), upper: Math.min(1, (c + s) / d), n };
}

/** 失败签名：错误行归一化（去路径/数字/空白），取前 60 字。 */
export function failureSignature(text) {
  return String(text ?? '')
    .replace(/\r|\n/g, ' ')
    .replace(/[A-Za-z]:[\/][^\s"']+/g, '<path>')
    .replace(/\/[^\s"']{6,}/g, '<path>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** 从事件流抽 (seq, signature, 原文)。只认 tool/result + 错误特征。 */
export function collectFailures(events, max = 400) {
  const out = [];
  for (const ev of Array.isArray(events) ? events : []) {
    if (String(ev?.type ?? '') !== 'tool/result') continue;
    const raw = JSON.stringify(ev?.data ?? {});
    if (!/(error|failed|exception|ENOENT|EACCES|cannot|not found|exit code: [1-9])/i.test(raw)) continue;
    const i0 = raw.indexOf('"text":"');
    const seg = i0 >= 0 ? raw.slice(i0 + 8, i0 + 200) : raw.slice(0, 200);
    const sig = failureSignature(seg);
    if (sig.length < 12) continue;
    out.push({ seq: Number(ev.seq), sig });
    if (out.length >= max) break;
  }
  return out;
}

/** 复发性：同一签名在该局出现 ≥2 次。 */
export function recurrenceOf(failures) {
  const first = new Map();
  const recur = new Map();
  for (const f of failures) {
    if (!first.has(f.sig)) first.set(f.sig, f.seq);
    else recur.set(f.sig, (recur.get(f.sig) ?? 0) + 1);
  }
  return { first, recur };
}

export function measure({ store, home = defaultHome(), maxEpisodes = 20 } = {}) {
  const episodes = store.list('episodes').map((e) => e.record).filter(Boolean);
  const claims = store.list('claims').map((e) => e.record).filter(Boolean);
  const claimedEpisodes = new Set();
  for (const c of claims) for (const s of Array.isArray(c.support) ? c.support : []) {
    const ep = String(s?.episode ?? ''); if (!ep) continue;
    claimedEpisodes.add(`${ep}\u0000${Number(s?.seq)}`);
  }
  const selfScope = 'w:d:/deepseek harness/default-workspace/长期记忆系统';
  const pool = episodes
    .filter((e) => String(e.scopeKey ?? '').toLowerCase() !== selfScope)
    .filter((e) => Number(e.delegationDepth ?? 0) === 0)
    .sort((a, b) => Number(b?.signals?.failures ?? 0) - Number(a?.signals?.failures ?? 0))
    .slice(0, maxEpisodes);
  const rows = [];
  for (const ep of pool) {
    let events = [];
    try {
      const lp = ep?.closure?.logPath;
      const abs = lp ? (path.isAbsolute(lp) ? lp : path.join(home, lp)) : null;
      if (abs && fs.existsSync(abs)) {
        const fr = readFrames(fs.readFileSync(abs));
        events = parseEvents(Array.isArray(fr) ? fr : fr?.frames ?? [])?.events ?? [];
      }
    } catch { events = []; }
    const failures = collectFailures(events);
    const { first, recur } = recurrenceOf(failures);
    for (const [sig, seq] of first) {
      const hasMemory = claimedEpisodes.has(`${ep.id}\u0000${seq}`);
      rows.push({ episode: ep.id, sig, seq, hasMemory, recurred: (recur.get(sig) ?? 0) > 0, recurCount: recur.get(sig) ?? 0 });
    }
  }
  const A = rows.filter((r) => r.hasMemory);
  const B = rows.filter((r) => !r.hasMemory);
  const rate = (arr) => (arr.length ? arr.filter((r) => r.recurred).length / arr.length : null);
  const aHits = A.filter((r) => r.recurred).length;
  const bHits = B.filter((r) => r.recurred).length;
  // 负向对照：库里完全没有 claim 的局（无记忆可召）
  const noMemoryEpisodes = new Set(pool.filter((e) => ![...claimedEpisodes].some((k) => k.startsWith(`${e.id}\u0000`))).map((e) => e.id));
  const neg = rows.filter((r) => noMemoryEpisodes.has(r.episode));
  return {
    version: 1, generatedAt: Date.now(),
    episodes: pool.length, signatures: rows.length,
    A: { n: A.length, recurred: aHits, rate: rate(A), wilson: wilson(aHits, A.length) },
    B: { n: B.length, recurred: bHits, rate: rate(B), wilson: wilson(bHits, B.length) },
    delta: (rate(A) ?? 0) - (rate(B) ?? 0),
    negativeControl: { episodes: noMemoryEpisodes.size, n: neg.length, recurred: neg.filter((r) => r.recurred).length, rate: rate(neg) },
    rows,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const home = defaultHome();
  const store = createStore({ root: path.resolve(opt('store', path.join(home, 'memory-context'))) });
  const r = measure({ store, home, maxEpisodes: Number(opt('episodes', '20')) });
  if (argv.includes('--json')) { console.log(JSON.stringify({ ...r, rows: r.rows.slice(0, 50) }, null, 2)); return 0; }
  const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(2)}%`);
  console.log(`T305 · Ablation 复发率 · 局 ${r.episodes} · 失败签名 ${r.signatures}`);
  console.log(`A 有记忆（库里有 claim 引用该失败）: ${r.A.recurred}/${r.A.n} = **${pct(r.A.rate)}** · Wilson [${pct(r.A.wilson.lower)}, ${pct(r.A.wilson.upper)}]`);
  console.log(`B 无记忆（库里没货）      : ${r.B.recurred}/${r.B.n} = **${pct(r.B.rate)}** · Wilson [${pct(r.B.wilson.lower)}, ${pct(r.B.wilson.upper)}]`);
  console.log(`配对差 Δ(A−B) = ${(r.delta * 100).toFixed(2)}pp`);
  console.log(`负向对照（无 claim 的局）: ${r.negativeControl.recurred}/${r.negativeControl.n} = ${pct(r.negativeControl.rate)}（${r.negativeControl.episodes} 局）`);
  return 0;
}

if (process.argv[1] && String(process.argv[1]).split(String.fromCharCode(92)).join('/').endsWith('scripts/ablation-recurrence.mjs')) {
  main().then((c) => { process.exitCode = c; }).catch((e) => { console.error(`ablation 失败：${String(e?.message ?? e)}`); process.exitCode = 2; });
}

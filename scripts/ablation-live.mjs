#!/usr/bin/env node
// T307 · 真 ablation 实验的"出题 + 记分"骨架（只读真库；不调用模型）
//
// 为什么需要它：T305/T306 证明"按有没有 claim 分组"的观测设计必然有偏
// （claim 只从被抽取过的失败里来）。唯一能回答"记忆有没有用"的是**干预实验**：
//   同一批任务跑两遍：A=注入记忆卡，B=完全不注入（GOKIFU_INJECT=off）。
//
// 本脚本只做两件事（**不跑模型**）：
//   1) `--list`   ：从库里挑出**适合做实验的失败签名**（有 claim 引用、错误原文可复现）
//   2) `--score`  ：读 evidence/ablation-live.jsonl（宿主跑完后追加），算 A/B 复发率 + 配对检验
//   3) `--record` ：把一次实验结果追加进 jsonl（幂等：同 task+variant 覆盖）
//
// 用法：
//   node scripts/ablation-live.mjs --list [--n 20] [--json]
//   node scripts/ablation-live.mjs --record --task T1 --variant A --recurred 0 --run 2026-11-06T14:00Z
//   node scripts/ablation-live.mjs --score [--json]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const RESULTS = path.join(REPO_ROOT, 'evidence', 'ablation-live.jsonl');

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

/** 精确二项（McNemar 的 discordant 对）。 */
export function mcnemarExact(b, c) {
  const n = b + c;
  if (!n) return 1;
  const choose = (a, k) => { let r = 1; for (let i = 1; i <= k; i += 1) r = (r * (a - k + i)) / i; return r; };
  const pmf = (k) => choose(n, k) * 0.5 ** n;
  const obs = pmf(Math.min(b, c));
  let total = 0;
  for (let k = 0; k <= n; k += 1) if (pmf(k) <= obs + 1e-12) total += pmf(k);
  return Math.min(1, total);
}

/**
 * 出题：从库里挑"有 claim 引用、且错误原文可复现"的失败签名。
 * 每条 = { taskId, episode, seq, claimId, errorText, hint }。
 */
export function listCandidates({ store, n = 20 } = {}) {
  const claims = store.list('claims').map((e) => e.record).filter(Boolean);
  const out = [];
  for (const c of claims) {
    for (const s of Array.isArray(c.support) ? c.support : []) {
      const quote = String(s?.quote ?? '').trim();
      if (quote.length < 20) continue;
      if (!/(error|failed|exception|ENOENT|EACCES|cannot|not found|exit code)/i.test(quote)) continue;
      out.push({
        taskId: `T-${String(s?.episode ?? '').slice(3, 11)}-${Number(s?.seq) || 0}`,
        episode: String(s?.episode ?? ''),
        seq: Number(s?.seq) || 0,
        claimId: String(c.id ?? ''),
        errorText: quote.slice(0, 200),
        hint: String(c.text ?? '').slice(0, 120),
      });
    }
    if (out.length >= n) break;
  }
  // 去重（同 episode+seq 只留一条）
  const seen = new Set();
  return out.filter((x) => { const k = `${x.episode}#${x.seq}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, n);
}

/** 记一次实验（幂等：同 taskId+variant 覆盖）。 */
export function record({ taskId, variant, recurred, run = null, note = '', file = RESULTS } = {}) {
  if (!taskId || !['A', 'B'].includes(variant)) throw new Error('record 需要 taskId + variant(A|B)');
  const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const next = rows.filter((r) => !(r.taskId === taskId && r.variant === variant));
  next.push({ taskId, variant, recurred: Boolean(recurred), run: run ?? new Date().toISOString(), note });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { rows: next.length, file };
}

/** 记分：配对比较 A vs B。 */
export function score({ file = RESULTS } = {}) {
  const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const byTask = new Map();
  for (const r of rows) {
    const o = byTask.get(r.taskId) ?? {};
    o[r.variant] = r.recurred;
    byTask.set(r.taskId, o);
  }
  let both = 0; let onlyA = 0; let onlyB = 0; let neither = 0;
  for (const o of byTask.values()) {
    if (o.A === undefined || o.B === undefined) continue;
    if (o.A && o.B) both += 1; else if (o.A && !o.B) onlyA += 1; else if (!o.A && o.B) onlyB += 1; else neither += 1;
  }
  const paired = both + onlyA + onlyB + neither;
  const aHits = both + onlyA;
  const bHits = both + onlyB;
  return {
    tasks: paired,
    A: { recurred: aHits, n: paired, rate: paired ? aHits / paired : null, wilson: wilson(aHits, paired) },
    B: { recurred: bHits, n: paired, rate: paired ? bHits / paired : null, wilson: wilson(bHits, paired) },
    discordant: { onlyA, onlyB },
    // 判据：B（无记忆）复发更多 ⇒ onlyB > onlyA
    mcnemarP: mcnemarExact(onlyA, onlyB),
    verdict: paired === 0 ? '无数据' : (onlyB > onlyA && mcnemarExact(onlyA, onlyB) < 0.05 ? '**记忆有用**（B 路显著更多复发）' : (onlyA === onlyB ? '无差别 ⇒ 记忆没起作用' : '方向相反（A 路更多复发）')),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const home = defaultHome();
  if (argv.includes('--record')) {
    const r = record({ taskId: opt('task'), variant: opt('variant'), recurred: opt('recurred', '0') === '1', run: opt('run', null), note: opt('note', '') });
    console.log(JSON.stringify(r, null, 2));
    return 0;
  }
  if (argv.includes('--score')) {
    const s = score({ file: opt('file', RESULTS) });
    console.log(JSON.stringify(s, null, 2));
    console.log(`\n判定：${s.verdict}`);
    return 0;
  }
  const store = createStore({ root: path.resolve(opt('store', path.join(home, 'memory-context'))) });
  const list = listCandidates({ store, n: Number(opt('n', '20')) });
  if (argv.includes('--json')) { console.log(JSON.stringify({ n: list.length, tasks: list }, null, 2)); return 0; }
  console.log(`T307 · 真 ablation 出题 · 候选失败签名 ${list.length} 条`);
  console.log('| # | taskId | episode | seq | claimId | 错误原文（前 80） |');
  console.log('|---|---|---|---|---|---|');
  list.forEach((x, i) => console.log(`| ${i + 1} | ${x.taskId} | ${x.episode} | ${x.seq} | ${x.claimId} | ${x.errorText.slice(0, 80).replace(/\|/g, '\|')} |`));
  return 0;
}

if (process.argv[1] && String(process.argv[1]).split(String.fromCharCode(92)).join('/').endsWith('scripts/ablation-live.mjs')) {
  main().then((c) => { process.exitCode = c; }).catch((e) => { console.error(`ablation-live 失败：${String(e?.message ?? e)}`); process.exitCode = 2; });
}

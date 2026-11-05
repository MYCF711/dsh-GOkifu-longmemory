#!/usr/bin/env node
// T259 · 消歧修复的**副作用体检**（只读）。
//
// 背景：T257 在副本上把 865 处 `support[].seq` 重指到"唯一 tool/result 命中"。那证明了
// **指针更准**（P2 36.6% → 70.1%），但没证明**卡片没变糟**。本脚本做逐卡对照：
//
//   ① 行数变化（增/减/同）
//   ② provenance 变化（`(ep, seq)` 变了多少条）
//   ③ A5 跨作用域（必须仍 0）
//   ④ 渲染正文变化（`claim.text` 不变，但出处变了 ⇒ 卡上日期不能跟着错）
//   ⑤ **日期一致性**：重指后 `support[].occurredAt` 必须仍等于新 `seq` 事件的 `time`
//      （"时间戳是一等字段"是红线；`seq` 变了而日期没变 ⇒ 卡上自相矛盾）
//
// 本脚本**全程只读**：任何 `--apply` 一律拒绝（exit 1）。
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../src/rooms/persist.mjs';
import { buildMemoryCard } from '../src/rooms/inject.mjs';
import { readFrames, parseEvents } from '../src/rooms/logread.mjs';
import { normalizeCardText } from './audit-card-samples.mjs';

export const SIDE_EFFECTS_VERSION = 1;

export function defaultHome(env = process.env) {
  return path.resolve(env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || '.', 'DeepSeek Harness', 'home'));
}

/** 从卡片正文里抽 provenance 引用：`(ep-xxxxxxxx, seq 1234)`（也认 `(ep-xxxxxxxx, 2026-01-01, seq 1234)`）。 */
export function extractCardRefs(section) {
  const out = [];
  const re = /\((ep-[0-9a-f]{8})\s*,\s*(?:[^,)]*,\s*)?seq\s+(\d+)\)/g;
  const text = String(section ?? '');
  let m;
  while ((m = re.exec(text)) !== null) out.push({ episode: m[1], seq: Number(m[2]) });
  return out;
}

/** 一行一条卡片行（排除空行与 `omitted:` 行 —— 它不是条目）。 */
export function cardLines(section) {
  return String(section ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('omitted:'));
}

/** 两张卡逐项对照。 */
export function compareCardPair({ before = '', after = '', beforeCross = 0, afterCross = 0 } = {}) {
  const refsA = extractCardRefs(before);
  const refsB = extractCardRefs(after);
  const setA = new Set(refsA.map((r) => `${r.episode}#${r.seq}`));
  const setB = new Set(refsB.map((r) => `${r.episode}#${r.seq}`));
  let removed = 0;
  let added = 0;
  for (const k of setA) if (!setB.has(k)) removed += 1;
  for (const k of setB) if (!setA.has(k)) added += 1;
  const changed = removed + added;
  const linesA = cardLines(before).length;
  const linesB = cardLines(after).length;
  return {
    linesBefore: linesA,
    linesAfter: linesB,
    linesDelta: linesB - linesA,
    refsBefore: refsA.length,
    refsAfter: refsB.length,
    provenanceRemoved: removed,
    provenanceAdded: added,
    provenanceChanged: changed,
    crossScopeBefore: beforeCross,
    crossScopeAfter: afterCross,
    crossScopeOk: beforeCross === 0 && afterCross === 0,
    textIdentical: normalizeCardText(before) === normalizeCardText(after),
  };
}

/** 事件 seq → time 索引（只留 time，省内存）。 */
export function buildTimeIndex(events) {
  const map = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    const seq = Number(ev?.seq);
    const time = Number(ev?.time);
    if (!Number.isFinite(seq) || !Number.isFinite(time)) continue;
    map.set(seq, time);
  }
  return map;
}

/**
 * 日期一致性：对每条带 `provenanceRepair` 的 claim，检查"重指后的 seq 事件时间"与记录里声明的日期
 * 是否仍一致（容差 `toleranceMs`，默认 1000ms —— 事件 time 与 occurredAt 允许同毫秒级差异）。
 * @returns {{checked:number, ok:number, mismatched:Array, unreadable:number}}
 */
export function checkDateConsistency({ claims, loadEvents, toleranceMs = 1000 } = {}) {
  const out = { checked: 0, ok: 0, mismatched: [], unreadable: 0 };
  const cache = new Map();
  for (const claim of Array.isArray(claims) ? claims : []) {
    const repairs = Array.isArray(claim?.provenanceRepair) ? claim.provenanceRepair : [];
    if (!repairs.length) continue;
    const fixes = repairs.flatMap((p) => (Array.isArray(p?.fixes) ? p.fixes : [p]));
    for (const fix of fixes) {
      if (!fix || !Number.isFinite(Number(fix.to))) continue;
      out.checked += 1;
      const ref = (Array.isArray(claim.support) ? claim.support : [])[Number(fix.index) ?? -1];
      const declared = Number(ref?.occurredAt ?? claim?.occurredAt);
      const epId = String(ref?.episode ?? '');
      let times = cache.get(epId);
      if (times === undefined) {
        let events = null;
        try { events = loadEvents(epId) ?? null; } catch { events = null; }
        times = events ? buildTimeIndex(events) : null;
        cache.set(epId, times);
      }
      if (!times) { out.unreadable += 1; continue; }
      const actual = times.get(Number(fix.to));
      if (!Number.isFinite(actual)) { out.unreadable += 1; continue; }
      if (!Number.isFinite(declared)) { out.mismatched.push({ claimId: claim.id, episode: epId, seq: Number(fix.to), declared: null, actual, reason: 'no-declared-date' }); continue; }
      if (Math.abs(actual - declared) > toleranceMs) {
        out.mismatched.push({ claimId: claim.id, episode: epId, seq: Number(fix.to), declared, actual, deltaMs: actual - declared });
      } else out.ok += 1;
    }
  }
  return out;
}

/** 真实日志读取器（只读）。 */
export function makeLogLoader({ home = defaultHome() } = {}) {
  const cache = new Map();
  return (episodeId, ep = null) => {
    if (cache.has(episodeId)) return cache.get(episodeId);
    let out = null;
    try {
      const logPath = ep?.closure?.logPath;
      if (logPath) {
        const abs = path.isAbsolute(logPath) ? logPath : path.join(home, logPath);
        if (fs.existsSync(abs)) {
          const framesRes = readFrames(fs.readFileSync(abs));
          const frames = Array.isArray(framesRes) ? framesRes : framesRes?.frames;
          out = parseEvents(frames ?? [])?.events ?? null;
        }
      }
    } catch { out = null; }
    cache.set(episodeId, out);
    return out;
  };
}

/** 用同一个信号在两库上各生成一张卡。 */
export function buildCard(store, signal, { scope = null, now = null, limit = 8 } = {}) {
  return buildMemoryCard({ store, signal: { text: signal }, scope, now, limit }) ?? { section: '', claims: [], crossScope: 0 };
}

/**
 * 主流程（只读）。
 * @returns {{cards:Array, summary:object, dates:object}}
 */
export function runSideEffects({ realRoot, copyRoot, signals = [], home = defaultHome(), limit = 8, dateSample = 30 } = {}) {
  const real = createStore({ root: realRoot });
  const copy = createStore({ root: copyRoot });
  const cards = [];
  for (const signal of signals) {
    const a = buildCard(real, signal, { limit });
    const b = buildCard(copy, signal, { limit });
    cards.push({ signal, ...compareCardPair({ before: a.section ?? '', after: b.section ?? '', beforeCross: a.crossScope ?? 0, afterCross: b.crossScope ?? 0 }) });
  }
  const summary = cards.reduce((acc, c) => {
    acc.cards += 1;
    acc.linesBefore += c.linesBefore;
    acc.linesAfter += c.linesAfter;
    acc.linesDelta += c.linesDelta;
    acc.provenanceChanged += c.provenanceChanged;
    if (!c.crossScopeOk) acc.crossScopeViolations += 1;
    if (c.textIdentical) acc.textIdentical += 1;
    return acc;
  }, { cards: 0, linesBefore: 0, linesAfter: 0, linesDelta: 0, provenanceChanged: 0, crossScopeViolations: 0, textIdentical: 0 });

  // 日期一致性：只抽样带 provenanceRepair 的 claim（读日志很贵）
  const repaired = copy.list('claims').map((e) => e.record).filter((c) => Array.isArray(c?.provenanceRepair) && c.provenanceRepair.length).slice(0, dateSample);
  const episodes = new Map(copy.list('episodes').map((e) => [e.id, e.record]));
  const loader = makeLogLoader({ home });
  const dates = checkDateConsistency({ claims: repaired, loadEvents: (epId) => loader(epId, episodes.get(epId)) });
  return { cards, summary, dates };
}

export function formatReport(r) {
  const lines = [];
  const s = r.summary;
  lines.push(`逐卡对照（${s.cards} 张卡）：`);
  lines.push(`  行数：${s.linesBefore} → ${s.linesAfter}（Δ ${s.linesDelta >= 0 ? '+' : ''}${s.linesDelta}）`);
  lines.push(`  provenance 变化：${s.provenanceChanged} 条 (ep,seq)`);
  lines.push(`  A5 跨作用域违规卡：${s.crossScopeViolations}（必须 0）`);
  lines.push(`  正文完全一致（归一后）：${s.textIdentical}/${s.cards}`);
  lines.push(`日期一致性（抽样 ${r.dates.checked} 处重指）：ok ${r.dates.ok} · 不一致 ${r.dates.mismatched.length} · 不可读 ${r.dates.unreadable}`);
  for (const m of r.dates.mismatched.slice(0, 5)) lines.push(`  ✗ ${m.claimId} @ ${m.episode} seq ${m.seq}：声明 ${m.declared} vs 事件 ${m.actual}（Δ ${m.deltaMs} ms）`);
  return lines.join('\n');
}

export function parseArgs(argv = []) {
  const flags = { real: null, copy: null, apply: false, json: false, signals: 8, limit: 8, dateSample: 30, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') flags.apply = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--real') flags.real = argv[++i] ?? null;
    else if (a === '--copy') flags.copy = argv[++i] ?? null;
    else if (a === '--signals') flags.signals = Number(argv[++i] ?? 8) || 8;
    else if (a === '--limit') flags.limit = Number(argv[++i] ?? 8) || 8;
    else if (a === '--date-sample') flags.dateSample = Number(argv[++i] ?? 30) || 30;
    else return { error: `未知参数：${a}` };
  }
  return flags;
}

export function runCli(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  if (flags.error) return { code: 2, stdout: flags.error };
  if (flags.help) return { code: 0, stdout: USAGE };
  const home = defaultHome();
  const realRoot = flags.real ? path.resolve(flags.real) : path.join(home, 'memory-context');
  const copyRoot = flags.copy ? path.resolve(flags.copy) : null;
  // ⚠ T259 守卫：本工具**只读**，任何 --apply 一律拒绝；并且拒绝把"真库"当作副本
  if (flags.apply) return { code: 1, stdout: '✗ 拒绝 --apply：repair-side-effects 是只读体检工具（写操作只在 tmp/ 副本，由 repair-support-seq 负责）' };
  if (!copyRoot) return { code: 2, stdout: '缺少 --copy（消歧后的副本目录，例如 tmp/t257-copy）' };
  if (path.resolve(copyRoot) === path.resolve(realRoot)) return { code: 1, stdout: `✗ 拒绝：--copy 与真库是同一个目录（${realRoot}）` };
  if (!fs.existsSync(realRoot) || !fs.existsSync(copyRoot)) return { code: 2, stdout: `库不存在：${!fs.existsSync(realRoot) ? realRoot : copyRoot}` };

  const copy = createStore({ root: copyRoot });
  const repaired = copy.list('claims').map((e) => e.record).filter((c) => Array.isArray(c?.provenanceRepair) && c.provenanceRepair.length);
  const signals = [];
  for (const c of repaired.slice(0, flags.signals)) if (typeof c.text === 'string' && c.text.trim()) signals.push(c.text.slice(0, 160));
  const res = runSideEffects({ realRoot, copyRoot, signals, home, limit: flags.limit, dateSample: flags.dateSample });
  return { code: 0, stdout: flags.json ? JSON.stringify(res, null, 2) : formatReport(res) };
}

export const USAGE = `T259 · 消歧修复副作用体检（只读）

  node scripts/repair-side-effects.mjs --copy tmp/t257-copy [--signals 8] [--limit 8] [--date-sample 30]
  --real <dir>  真库目录（默认 <DSH_HOME>/memory-context）
`;

export function main(argv = process.argv.slice(2)) {
  const res = runCli(argv);
  process.stdout.write(`${res.stdout}\n`);
  return res.code;
}

const invoked = process.argv[1]
  ? import.meta.url === new URL(`file://${path.resolve(process.argv[1]).replace(/\\/g, '/')}`).href
  : false;
if (invoked) process.exitCode = main();

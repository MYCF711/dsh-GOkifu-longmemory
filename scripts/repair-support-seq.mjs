#!/usr/bin/env node
// T238 · 存量修复：把 support[].seq 指错的引用搬到**真的含该 quote 的那一步**。
//
// 背景：T233 修的是 `src/rooms/topic.mjs` 的抽取逻辑（只影响**新抽取**的 claim）；
// 库里已有的旧 claim（2027 条 support 引用）`seq` 还是错的 —— 卡里会出现
// `(ep-226dbf4f, seq 3670)` 而片段其实在 3674。本脚本修存量。
//
// 判定（P2 口径，复用 `scripts/provenance-p2.mjs` 的 `normalizeText` / `indexEvents`）：
//   · `seq` 指向的事件**含** quote ⇒ ok（不动）
//   · 同一 episode 内**唯一**一个事件含 quote ⇒ repair（from → to）
//   · 多个事件都含 ⇒ ambiguous（**不修**，列出来）
//   · 一个都没有 ⇒ unrepaired（**不修**，单列；T232 口径约 273 条）
//
// 只增不改：**只改 `seq`**，并在记录上追加 `provenanceRepair:{at,from,to,reason,evidenceSeq,eventType}`；
// `quote` / `text` / `state` / `support` 其它字段一个字节都不动。
//
// 用法：
//   node scripts/repair-support-seq.mjs                     # dry-run（默认）
//   node scripts/repair-support-seq.mjs --apply --store tmp/copy
//   node scripts/repair-support-seq.mjs --json --limit 5
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../src/rooms/persist.mjs';
import { readFrames, parseEvents } from '../src/rooms/logread.mjs';
import { normalizeText } from './provenance-p2.mjs';
import { singleLine } from '../src/rooms/inject.mjs';
import { normalizeCardText, collectStrings } from './audit-card-samples.mjs';

export const REPAIR_VERSION = 1;

export function defaultHome(env = process.env) {
  return path.resolve(env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || '.', 'DeepSeek Harness', 'home'));
}

/** 把事件建成 `seq → {type, text}`（比 indexEvents 多留 eventType，修复时要写进 provenanceRepair）。 */
export function buildEventIndex(events) {
  const map = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    const seq = Number(ev?.seq);
    if (!Number.isFinite(seq)) continue;
    // T256 口径：每段先 singleLine（多行错误原文归一），段间换行连接；另存空格连接版（stdout+stderr 拼接）
    const parts = collectStrings(ev?.data ?? {}).map((x) => singleLine(x)).filter(Boolean);
    if (!parts.length) continue;
    const prev = map.get(seq);
    const text = parts.join(String.fromCharCode(10));
    const joined = parts.join(' ');
    map.set(seq, { seq, type: String(ev?.type ?? prev?.type ?? 'unknown'), text: prev ? `${prev.text}${String.fromCharCode(10)}${text}` : text, joined: prev ? `${prev.joined} ${joined}` : joined });
  }
  return map;
}

/**
 * 单条 support 引用的判定（纯函数，事件索引进参 ⇒ 可单测）。
 * @returns {{status:'ok'|'repair'|'ambiguous'|'unrepaired'|'skipped', from:number|null, to:number|null,
 *            candidates:number[], eventType:string|null, distance:number|null, reason:string|null}}
 */
export function locateQuoteSeq({ quote, seq, eventIndex }) {
  // 存储层会把超长 quote 截断并补 `…`（U+2026）—— 那是**存储伪影**，不是正文。
  // 直接拿它当子串必然匹配不到（实测 c-39b8ac53 的 quote 以 `…` 结尾 ⇒ 0 命中）。
  const needle = normalizeCardText(quote);
  if (needle === '') return { status: 'skipped', from: Number(seq) || null, to: null, candidates: [], eventType: null, distance: null, reason: 'quote-empty' };
  const from = Number(seq);
  const hit = Number.isFinite(from) ? eventIndex.get(from) : null;
  if (hit && (hit.text.includes(needle) || (hit.joined ?? '').includes(needle))) {
    return { status: 'ok', from, to: from, candidates: [from], eventType: hit.type, distance: 0, reason: null };
  }
  const candidates = [];
  for (const [s, ev] of eventIndex) {
    if (ev.text.includes(needle) || (ev.joined ?? '').includes(needle)) candidates.push(s);
  }
  candidates.sort((a, b) => a - b);
  const hits = candidates.map((sq) => ({ seq: sq, type: String(eventIndex.get(sq)?.type ?? 'unknown') }));
  if (candidates.length === 1) {
    const to = candidates[0];
    return { status: 'repair', from: Number.isFinite(from) ? from : null, to, candidates, hits, eventType: hits[0].type, distance: Number.isFinite(from) ? to - from : null, reason: 'quote-not-at-seq' };
  }
  if (candidates.length > 1) {
    // T257 消歧：原始出处（tool/result）优先于模型回显（assistant/message）
    const tool = hits.filter((h) => /^tool(\/|$)/.test(h.type));
    if (tool.length === 1) {
      const to = tool[0].seq;
      return { status: 'repair', from: Number.isFinite(from) ? from : null, to, candidates: tool.map((h) => h.seq), hits, eventType: tool[0].type, distance: Number.isFinite(from) ? to - from : null, reason: 'disambiguated-tool-result' };
    }
    return { status: 'ambiguous', from: Number.isFinite(from) ? from : null, to: null, candidates, hits, eventType: null, distance: null, reason: tool.length > 1 ? `multiple-tool-results:${tool.length}` : 'echo-only' };
  }
  return { status: 'unrepaired', from: Number.isFinite(from) ? from : null, to: null, candidates: [], eventType: null, distance: null, reason: 'quote-not-found' };
}

/** 真实日志读取器：episode → events（找不到返回 null）。 */
export function makeLogLoader({ home = defaultHome() } = {}) {
  const cache = new Map();
  return (episodeId, ep) => {
    if (cache.has(episodeId)) return cache.get(episodeId);
    let out = null;
    try {
      const logPath = ep?.closure?.logPath;
      if (logPath) {
        const abs = path.isAbsolute(logPath) ? logPath : path.join(home, logPath);
        if (fs.existsSync(abs)) {
          const framesRes = readFrames(fs.readFileSync(abs));
          const frames = Array.isArray(framesRes) ? framesRes : framesRes?.frames;
          const parsed = parseEvents(frames ?? []);
          out = parsed?.events ?? null;
        }
      }
    } catch {
      out = null;
    }
    cache.set(episodeId, out);
    return out;
  };
}

/**
 * 生成修复计划（**不写任何东西**）。
 * @returns {{scanned:number, refs:number, ok:number, repair:Array, ambiguous:Array, unrepaired:Array, skipped:Array, unreadable:number}}
 */
export function planRepairs({ claims, episodes, loadEvents }) {
  const epById = new Map((Array.isArray(episodes) ? episodes : []).map((e) => [String(e?.id ?? ''), e]));
  const indexCache = new Map();
  const out = { scanned: 0, refs: 0, ok: 0, repair: [], ambiguous: [], unrepaired: [], skipped: [], unreadable: 0, buckets: { 'multiple-tool': 0, 'echo-only': 0 } };
  for (const claim of Array.isArray(claims) ? claims : []) {
    out.scanned += 1;
    const support = Array.isArray(claim?.support) ? claim.support : [];
    for (let i = 0; i < support.length; i += 1) {
      const ref = support[i];
      if (!ref || typeof ref !== 'object') continue;
      out.refs += 1;
      const epId = String(ref.episode ?? '');
      const ep = epById.get(epId) ?? null;
      let index = indexCache.get(epId);
      if (index === undefined) {
        const events = loadEvents(epId, ep);
        if (!events) { index = null; out.unreadable += 1; }
        else index = buildEventIndex(events);
        indexCache.set(epId, index);
      }
      if (!index) { out.unreadable += 1; continue; }
      const r = locateQuoteSeq({ quote: ref.quote, seq: ref.seq, eventIndex: index });
      if (r.status === 'ok') { out.ok += 1; continue; }
      const row = { claimId: claim.id, episode: epId, index: i, quote: String(ref.quote ?? '').slice(0, 120), from: r.from, to: r.to, candidates: r.candidates.slice(0, 8), candidateCount: r.candidates.length, eventType: r.eventType, distance: r.distance, reason: r.reason, hitTypes: (r.hits ?? []).map((h) => h.type) };
      if (r.status === 'repair') out.repair.push(row);
      else if (r.status === 'ambiguous') { out.ambiguous.push(row); const b = String(r.reason).startsWith('multiple-tool-results') ? 'multiple-tool' : 'echo-only'; out.buckets[b] += 1; }
      else if (r.status === 'unrepaired') out.unrepaired.push(row);
      else out.skipped.push(row);
    }
  }
  return out;
}

/** 把计划落成新记录：**只改 seq** + 追加 provenanceRepair。 */
export function applyPlan({ store, plan, apply = false, at = Date.now() }) {
  const byClaim = new Map();
  for (const row of plan.repair) {
    if (!byClaim.has(row.claimId)) byClaim.set(row.claimId, []);
    byClaim.get(row.claimId).push(row);
  }
  const changed = [];
  for (const [claimId, rows] of byClaim) {
    const entry = store.list('claims').find((e) => e.id === claimId);
    if (!entry) continue;
    const record = entry.record;
    const support = Array.isArray(record.support) ? record.support.map((s) => ({ ...s })) : [];
    let touched = false;
    for (const row of rows) {
      const ref = support[row.index];
      if (!ref) continue;
      if (Number(ref.seq) !== Number(row.from)) continue; // 已被别人改过 ⇒ 跳过
      ref.seq = row.to;
      touched = true;
    }
    if (!touched) continue;
    const next = {
      ...record,
      support,
      provenanceRepair: [
        ...(Array.isArray(record.provenanceRepair) ? record.provenanceRepair : []),
        { at, version: REPAIR_VERSION, fixes: rows.map((r) => ({ from: r.from, to: r.to, reason: r.reason, eventType: r.eventType, index: r.index })), evidenceSeq: rows[0].to },
      ],
    };
    changed.push({ claimId, fixes: rows.length });
    if (apply) store.put('claims', next, { at });
  }
  return { changed: changed.length, fixes: changed.reduce((n, c) => n + c.fixes, 0), claims: changed };
}

export function formatReport(plan, result = null) {
  const lines = [];
  lines.push(`扫描 claim ${plan.scanned} 条 · support 引用 ${plan.refs} 条`);
  lines.push(`  ok（seq 已正确）      ${plan.ok}`);
  lines.push(`  可修（唯一命中）      ${plan.repair.length}`);
  lines.push(`  ambiguous（多命中）   ${plan.ambiguous.length}`);
  lines.push(`  unrepaired（找不到）  ${plan.unrepaired.length}`);
  lines.push(`  skipped（quote 为空） ${plan.skipped.length}`);
  if (plan.unreadable) lines.push(`  ⚠ 事件不可读（日志缺失/解析失败）的引用 ${plan.unreadable} 条`);
  if (plan.repair.length) {
    lines.push('  —— 头部 5 条 from → to ——');
    for (const r of plan.repair.slice(0, 5)) {
      lines.push(`  ${r.claimId} @ ${r.episode}: ${r.from} → ${r.to}（${r.eventType}，距离 ${r.distance}）`);
    }
  }
  if (result) {
    lines.push(`写入：${result.changed} 条 claim · ${result.fixes} 处引用（${result.claims.slice(0, 5).map((c) => c.claimId).join(', ')}${result.changed > 5 ? ' …' : ''}）`);
  }
  return lines.join('\n');
}

export function parseArgs(argv = []) {
  const flags = { store: null, apply: false, json: false, limit: 0, home: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') flags.apply = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--store') flags.store = argv[++i] ?? null;
    else if (a === '--home') flags.home = argv[++i] ?? null;
    else if (a === '--limit') flags.limit = Number(argv[++i] ?? 0) || 0;
    else return { error: `未知参数：${a}` };
  }
  return flags;
}

export function runCli(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  if (flags.error) return { code: 2, stdout: flags.error };
  if (flags.help) return { code: 0, stdout: USAGE };
  const home = flags.home ? path.resolve(flags.home) : defaultHome();
  const storeRoot = flags.store ? path.resolve(flags.store) : path.join(home, 'memory-context');
  // ⚠ T257 守卫：**不许写真正的库**（而不是"路径里必须含 tmp"）。
  // 旧写法按"路径段含 tmp"判定，在 Linux/macOS 上 `os.tmpdir()` = `/tmp` ⇒ 任何临时目录都含 tmp ⇒ 守卫失效（CI 红）。
  // 正确语义：与**真库根**（--home 或 DSH_HOME 下的 memory-context）比对；相等或位于其内部 ⇒ 拒绝。
  if (flags.apply) {
    const home = flags.home || process.env.DSH_HOME || '';
    const realStore = path.resolve(home, 'memory-context');
    const target = path.resolve(storeRoot);
    const inside = target === realStore || target.startsWith(realStore + path.sep);
    if (inside) {
      return { code: 1, stdout: `✗ 拒绝 --apply：目标是**真库**（${target}）。请先复制到临时目录再跑：cp -r "${realStore}" <临时目录>/memory-context` };
    }
  }
  if (!fs.existsSync(storeRoot)) return { code: 2, stdout: `库不存在：${storeRoot}` };
  const store = createStore({ root: storeRoot });
  const claims = store.list('claims').map((e) => e.record).filter(Boolean);
  const episodes = store.list('episodes').map((e) => e.record).filter(Boolean);
  const plan = planRepairs({ claims, episodes, loadEvents: makeLogLoader({ home }) });
  const result = applyPlan({ store, plan, apply: flags.apply });
  if (flags.limit && plan.repair.length > flags.limit) plan.repair = plan.repair.slice(0, flags.limit);
  const stdout = flags.json ? JSON.stringify({ storeRoot, apply: flags.apply, plan, result }, null, 2) : formatReport(plan, flags.apply ? result : null);
  return { code: 0, stdout };
}

export const USAGE = `T238 · 修复 support[].seq（默认 dry-run）

  node scripts/repair-support-seq.mjs                    # 只读预览
  node scripts/repair-support-seq.mjs --apply --store X  # 真的写（只改 seq + 追加 provenanceRepair）
  --json  机器可读   --limit N 只展示前 N 条   --home <DSH_HOME>
`;

export function main(argv = process.argv.slice(2)) {
  const res = runCli(argv);
  process.stdout.write(`${res.stdout}\n`);
  return res.code;
}

const invoked = process.argv[1] ? import.meta.url === new URL(`file://${path.resolve(process.argv[1]).replace(/\\/g, '/')}`).href : false;
if (invoked) process.exitCode = main();

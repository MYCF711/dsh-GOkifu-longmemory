#!/usr/bin/env node
// T273 · SI-1 时间不一致的**逐条归因**（只读）。
//
// 背景：T272 修完 SI-4 误报后，真库 `--all --tolerance 1` 剩 125 条 fail：
//   · SI-5-missing-toOccurredAt 59（旧版 repair 没记 toOccurredAt，来源明确）
//   · SI-1-time-mismatch 66（**来源不明**，本刀要分清楚）
//
// 三类嫌疑（处置完全不同）：
//   A · 重指漏改：带 `provenanceRepair`（T238 那批 553 处重指），seq 改了但 occurredAt 没跟；
//   B · 本来就有：归档时 occurredAt 就取错了事件（与重指事故无关）；
//   C · 容差边界：|Δ| 很小（几 ms 的舍入噪声）。
//
// 本脚本输出：66 条的明细（claimId/episode/seq/declared/actual/delta）+ 差值分桶 + 与 provenanceRepair 的交叉 + 5 条逐字对照。
//
// 用法：node scripts/si1-attribution.mjs [--store <dir>] [--json] [--verbose]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';
import { readFrames, parseEvents } from '../src/rooms/logread.mjs';

export const SI1_VERSION = 1;
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export function defaultHome(env = process.env) {
  return path.resolve(env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || '.', 'DeepSeek Harness', 'home'));
}

/** 差值分桶（按 |Δ| 毫秒）。 */
export const DELTA_BUCKETS = Object.freeze([
  { key: '1-5ms', max: 5 },
  { key: '5-100ms', max: 100 },
  { key: '100ms-1s', max: 1000 },
  { key: '1s-1min', max: 60000 },
  { key: '>1min', max: Infinity },
]);

export function bucketOfDelta(deltaMs) {
  const d = Math.abs(Number(deltaMs));
  if (!Number.isFinite(d)) return 'unknown';
  for (const b of DELTA_BUCKETS) if (d <= b.max) return b.key;
  return '>1min';
}

/** 事件数组 → Map<seq, {time, type, text}>（text 用于逐字对照）。 */
export function indexEvents(events) {
  const map = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    const seq = Number(ev?.seq);
    const time = Number(ev?.time);
    if (!Number.isFinite(seq)) continue;
    const text = collectText(ev?.data ?? ev ?? {});
    map.set(seq, { time: Number.isFinite(time) ? time : null, type: String(ev?.type ?? ev?.data?.type ?? ''), text });
  }
  return map;
}

/** 递归收集事件里的字符串（不用 JSON.stringify，避免转义干扰逐字对照）。 */
export function collectText(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (Array.isArray(value)) { for (const v of value) collectText(v, out); return out; }
  if (typeof value === 'object') { for (const v of Object.values(value)) collectText(v, out); }
  return out;
}

const singleLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * 逐条跑 SI-1（**不复用** runSemanticChecks，因为它只留 5 条样本；这里要全部 66 条）。
 * 判据与 `scripts/semantic-check.mjs` 的 SI-1 完全一致：|actual - declared| > tolerance ⇒ 失败。
 */
export function collectSi1Mismatches({ claims, timeIndexOf, tolerance = 1 } = {}) {
  const rows = [];
  let checked = 0;
  let unverified = 0;
  for (const claim of Array.isArray(claims) ? claims : []) {
    const support = Array.isArray(claim?.support) ? claim.support : [];
    if (!support.length) continue;
    for (const ref of support) {
      const episode = String(ref?.episode ?? '');
      if (!episode) continue;
      const times = timeIndexOf(episode);
      if (!times) { unverified += 1; continue; }
      const seq = Number(ref?.seq);
      const declared = Number(ref?.occurredAt);
      const hit = times.get(seq);
      const actual = Number.isFinite(hit?.time) ? hit.time : null;
      checked += 1;
      if (!Number.isFinite(actual)) { unverified += 1; continue; }
      if (!Number.isFinite(declared)) continue; // SI-1-missing-occurredAt 另行统计
      const delta = actual - declared;
      if (Math.abs(delta) <= tolerance) continue;
      const repairs = Array.isArray(claim?.provenanceRepair) ? claim.provenanceRepair : [];
      const refRepair = Array.isArray(ref?.provenanceRepair) ? ref.provenanceRepair : [];
      rows.push({
        claimId: String(claim?.id ?? ''),
        episode,
        seq,
        declared,
        actual,
        delta,
        bucket: bucketOfDelta(delta),
        hasClaimRepair: repairs.length > 0,
        hasRefRepair: refRepair.length > 0,
        repairedToSeq: repairs.length ? Number(repairs[repairs.length - 1]?.to ?? NaN) : NaN,
        repairedToOccurredAt: repairs.length ? Number(repairs[repairs.length - 1]?.toOccurredAt ?? NaN) : NaN,
        claimRecordedAt: Number.isFinite(Number(claim?.recordedAt)) ? Number(claim.recordedAt) : null,
        quote: String(ref?.quote ?? '').slice(0, 160),
        eventType: hit?.type ?? null,
        eventText: hit?.text ?? '',
      });
    }
  }
  return { rows, checked, unverified };
}

/** 交叉表：桶 × 是否带 provenanceRepair。 */
export function crossTab(rows) {
  const out = {};
  for (const row of rows) {
    const k = row.bucket;
    out[k] = out[k] ?? { total: 0, withRepair: 0, withoutRepair: 0 };
    out[k].total += 1;
    if (row.hasClaimRepair || row.hasRefRepair) out[k].withRepair += 1;
    else out[k].withoutRepair += 1;
  }
  return out;
}

/** 5 条逐字对照：quote 到底属于哪个事件？occurredAt 取的是不是 assistant 思考消息的时间？ */
export function verbatimCompare({ row, events, limit = 5 }) {
  const needleHead = singleLine(row.quote).slice(0, 60);
  const needleTail = singleLine(row.quote).slice(-40);
  const hits = [];
  for (const [seq, ev] of events) {
    const text = singleLine(ev.text);
    if (!text) continue;
    if (text.includes(needleHead)) hits.push({ seq, type: ev.type, time: ev.time, by: 'head' });
    else if (needleTail && text.includes(needleTail)) hits.push({ seq, type: ev.type, time: ev.time, by: 'tail' });
    if (hits.length >= limit) break;
  }
  return {
    claimId: row.claimId,
    episode: row.episode,
    seq: row.seq,
    delta: row.delta,
    declaredAt: row.declared,
    declaredTimeType: row.eventType,
    quoteHead: singleLine(row.quote).slice(0, 80),
    actualHits: hits.slice(0, limit),
  };
}

export function attribute({ store, home = defaultHome(), tolerance = 1, eventsOf = null } = {}) {
  const claims = store.list('claims').map((e) => e.record).filter(Boolean);
  const episodes = new Map(store.list('episodes').map((e) => [e.id, e.record]));
  const cache = new Map();
  const loadEvents = (episodeId) => {
    if (cache.has(episodeId)) return cache.get(episodeId);
    let out = null;
    try {
      const ep = episodes.get(episodeId);
      const logPath = ep?.closure?.logPath;
      if (logPath) {
        const abs = path.isAbsolute(logPath) ? logPath : path.join(home, logPath);
        if (fs.existsSync(abs)) {
          const framesRes = readFrames(fs.readFileSync(abs));
          const frames = Array.isArray(framesRes) ? framesRes : framesRes?.frames;
          const events = parseEvents(frames ?? [])?.events ?? [];
          out = indexEvents(events);
        }
      }
    } catch { out = null; }
    cache.set(episodeId, out);
    return out;
  };
  const { rows, checked, unverified } = collectSi1Mismatches({ claims, timeIndexOf: (epId) => loadEvents(epId), tolerance });
  const samples = rows.slice(0, 5).map((row) => verbatimCompare({ row, events: loadEvents(row.episode) ?? new Map() }));
  return {
    version: SI1_VERSION,
    claims: claims.length,
    checked,
    unverified,
    tolerance,
    n: rows.length,
    buckets: crossTab(rows),
    rows,
    samples,
  };
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(2)}%` : 'n/a');

export function formatReport(r) {
  const L = [];
  L.push(`T273 · SI-1 时间不一致归因 · 容差 ${r.tolerance}ms`);
  L.push(`claims ${r.claims} · 检查引用 ${r.checked} · unverified ${r.unverified} · **SI-1 失败 ${r.n}**`);
  L.push('');
  L.push('| 差值桶 | 条数 | 带 provenanceRepair | 不带 |');
  L.push('|---|---|---|---|');
  for (const b of DELTA_BUCKETS) {
    const v = r.buckets[b.key];
    if (!v) continue;
    L.push(`| ${b.key} | ${v.total} | ${v.withRepair} | ${v.withoutRepair} |`);
  }
  L.push('');
  L.push('逐条明细（前 20 条）：');
  L.push('| # | claimId | episode | seq | declared | actual | Δms | 桶 | repair |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  r.rows.slice(0, 20).forEach((x, i) => {
    L.push(`| ${i + 1} | ${x.claimId} | ${x.episode} | ${x.seq} | ${new Date(x.declared).toISOString()} | ${new Date(x.actual).toISOString()} | ${x.delta} | ${x.bucket} | ${x.hasClaimRepair || x.hasRefRepair ? '是' : '否'} |`);
  });
  L.push('');
  L.push('5 条逐字对照：');
  for (const s of r.samples) {
    L.push(`- ${s.claimId} @ ${s.episode} seq ${s.seq} · Δ=${s.delta}ms · 声明 seq 的事件类型 = ${s.declaredTimeType}`);
    L.push(`  引文前 80 字：${JSON.stringify(s.quoteHead)}`);
    L.push(`  引文真实所在：${s.actualHits.length ? s.actualHits.map((h) => `seq ${h.seq}(${h.type}, ${h.by})`).join(' · ') : '**该局任何 seq 都找不到**'}`);
  }
  return L.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const home = defaultHome();
  const store = createStore({ root: path.resolve(opt('store', path.join(home, 'memory-context'))) });
  const r = attribute({ store, home, tolerance: Number(opt('tolerance', '1')) });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
  console.log(formatReport(r));
  return 0;
}

if (process.argv[1] && String(process.argv[1]).split(String.fromCharCode(92)).join('/').endsWith('scripts/si1-attribution.mjs')) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(`归因失败：${String(error?.message ?? error)}`); process.exitCode = 2; });
}

#!/usr/bin/env node
// T275 · `occurredAt = edge.ts`（T274 取时 bug）的**全库影响面**（只读）。
//
// 背景：T274 证实 `src/rooms/extract.mjs` 写死 `occurredAt = edge.ts`，而上游棋谱的
// `edge.ts` 是按 **`seq+1`** 写的时间。两个 episode 重放 123/123 命中。
// 本脚本把这条判据推广到**全部 claim 的每条 support**：
//
//   ownTime  = support.seq 对应事件的 time
//   nextTime = (support.seq + 1) 对应事件的 time
//   A · 取对     occurredAt === ownTime（容差 1ms）
//   B · 取成下一格 occurredAt === nextTime 且 !== ownTime（容差 1ms）
//   C · 其它     两者都不是（需要单独看）
//
// 另标出**跨日**：occurredAt 与 ownTime 不在同一个**本地日期**（Asia/Shanghai）——
// 那些卡上渲染的日期是错的（日期是一等字段，AGENTS §2.3）。
//
// 用法：node scripts/occurredAt-impact.mjs [--store <dir>] [--json] [--tolerance 1] [--top 10]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';
import { readFrames, parseEvents } from '../src/rooms/logread.mjs';

export const IMPACT_VERSION = 1;
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export function defaultHome(env = process.env) {
  return path.resolve(env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || '.', 'DeepSeek Harness', 'home'));
}

/** 本地日期（Asia/Shanghai）；用 Intl 保证与渲染侧一致，不手算偏移。 */
export function localDay(ms) {
  if (!Number.isFinite(Number(ms))) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Number(ms)));
}

/** B 类差值分桶（|occurredAt − ownTime|）。 */
export const DELTA_BUCKETS = Object.freeze([
  { key: '<=1ms', max: 1 },
  { key: '1-100ms', max: 100 },
  { key: '100ms-1s', max: 1000 },
  { key: '1s-1min', max: 60000 },
  { key: '1min-1h', max: 3600000 },
  { key: '>1h', max: Infinity },
]);

export function bucketOfDelta(deltaMs) {
  const d = Math.abs(Number(deltaMs));
  if (!Number.isFinite(d)) return 'unknown';
  for (const b of DELTA_BUCKETS) if (d <= b.max) return b.key;
  return '>1h';
}

/** 事件数组 → Map<seq, time>。 */
export function buildTimeMap(events) {
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
 * 全库分类（纯函数，`timeOf(episode)` 注入 ⇒ 可单测）。
 * @returns {{A:number,B:number,C:number,total:number,rows:Array,byBucket:object,byEpisode:Array,crossDay:Array}}
 */
export function classifyAll({ claims, timeOf, tolerance = 1, eventTypeOf = null } = {}) {
  const rows = [];
  const byBucket = {};
  const episodeCount = new Map();
  const crossDay = [];
  let A = 0;
  let B = 0;
  let C = 0;
  let unverified = 0;
  for (const claim of Array.isArray(claims) ? claims : []) {
    for (const ref of Array.isArray(claim?.support) ? claim.support : []) {
      const episode = String(ref?.episode ?? '');
      const seq = Number(ref?.seq);
      const occurredAt = Number(ref?.occurredAt);
      if (!episode || !Number.isFinite(seq)) continue;
      const times = timeOf(episode);
      if (!times) { unverified += 1; continue; }
      const ownTime = times.get(seq);
      const nextTime = times.get(seq + 1);
      if (!Number.isFinite(ownTime) || !Number.isFinite(occurredAt)) { unverified += 1; continue; }
      const eqOwn = Math.abs(occurredAt - ownTime) <= tolerance;
      const eqNext = Number.isFinite(nextTime) && Math.abs(occurredAt - nextTime) <= tolerance && !eqOwn;
      const cls = eqOwn ? 'A' : (eqNext ? 'B' : 'C');
      if (cls === 'A') A += 1; else if (cls === 'B') B += 1; else C += 1;
      const delta = occurredAt - ownTime;
      if (cls === 'B') {
        const b = bucketOfDelta(delta);
        byBucket[b] = (byBucket[b] ?? 0) + 1;
      }
      if (cls !== 'A') {
        episodeCount.set(episode, (episodeCount.get(episode) ?? 0) + 1);
        const dOwn = localDay(ownTime);
        const dAt = localDay(occurredAt);
        const isCrossDay = dOwn !== dAt;
        if (isCrossDay) crossDay.push({ claimId: String(claim?.id ?? ''), episode, seq, occurredAt, ownTime, delta, cls, ownDay: dOwn, atDay: dAt });
        if (rows.length < 2000) {
          rows.push({
            claimId: String(claim?.id ?? ''),
            episode,
            seq,
            cls,
            occurredAt,
            ownTime,
            nextTime: Number.isFinite(nextTime) ? nextTime : null,
            delta,
            bucket: bucketOfDelta(delta),
            ownDay: dOwn,
            atDay: dAt,
            crossDay: isCrossDay,
          });
        }
      }
    }
  }
  const byEpisode = [...episodeCount.entries()].sort((a, b) => b[1] - a[1]).map(([episode, n]) => ({ episode, n }));
  return { total: A + B + C, A, B, C, unverified, rows, byBucket, byEpisode, crossDay };
}

export function impact({ store, home = defaultHome(), tolerance = 1, top = 10 } = {}) {
  const claims = store.list('claims').map((e) => e.record).filter(Boolean);
  const episodes = new Map(store.list('episodes').map((e) => [e.id, e.record]));
  const cache = new Map();
  const timeOf = (episodeId) => {
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
          out = buildTimeMap(parseEvents(frames ?? [])?.events ?? []);
        }
      }
    } catch { out = null; }
    cache.set(episodeId, out);
    return out;
  };
  const r = classifyAll({ claims, timeOf, tolerance });
  return {
    version: IMPACT_VERSION,
    generatedAt: Date.now(),
    claims: claims.length,
    tolerance,
    ...r,
    topEpisodes: r.byEpisode.slice(0, top),
    crossDayCount: r.crossDay.length,
    crossDaySamples: r.crossDay.slice(0, 10),
  };
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(2)}%` : 'n/a');

export function formatReport(r) {
  const L = [];
  L.push(`T275 · occurredAt 取时 bug 全库影响面（容差 ${r.tolerance}ms）`);
  L.push(`claims ${r.claims} · 可判定引用 ${r.total} · unverified ${r.unverified}`);
  L.push('');
  L.push('| 类 | 含义 | 条数 | 占比 |');
  L.push('|---|---|---|---|');
  L.push(`| **A** | 取对（occurredAt === ownTime） | ${r.A} | ${pct(r.A, r.total)} |`);
  L.push(`| **B** | 取成下一格（=== nextTime 且 !== ownTime） | ${r.B} | ${pct(r.B, r.total)} |`);
  L.push(`| **C** | 其它 | ${r.C} | ${pct(r.C, r.total)} |`);
  L.push('');
  L.push('B 类差值分布（|occurredAt − ownTime|）：');
  for (const b of DELTA_BUCKETS) {
    const n = r.byBucket[b.key];
    if (!n) continue;
    L.push(`  ${b.key}: ${n}（${pct(n, r.B)}）`);
  }
  L.push('');
  L.push(`跨日（occurredAt 与 ownTime 不在同一本地日期）：**${r.crossDayCount} 条**`);
  for (const x of r.crossDaySamples) L.push(`  · ${x.claimId} @ ${x.episode} seq ${x.seq} · ${x.ownDay} → ${x.atDay}（Δ=${x.delta}ms, ${x.cls}）`);
  L.push('');
  L.push(`Top ${r.topEpisodes.length} episode（B+C）：`);
  for (const x of r.topEpisodes) L.push(`  ${x.episode}: ${x.n}`);
  return L.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const home = defaultHome();
  const store = createStore({ root: path.resolve(opt('store', path.join(home, 'memory-context'))) });
  const r = impact({ store, home, tolerance: Number(opt('tolerance', '1')), top: Number(opt('top', '10')) });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
  console.log(formatReport(r));
  return 0;
}

if (process.argv[1] && String(process.argv[1]).split(String.fromCharCode(92)).join('/').endsWith('scripts/occurredAt-impact.mjs')) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(`影响面测量失败：${String(error?.message ?? error)}`); process.exitCode = 2; });
}

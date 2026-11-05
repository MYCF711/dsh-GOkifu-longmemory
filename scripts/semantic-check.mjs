#!/usr/bin/env node
// T262 · 语义不变量校验（SI）—— **只读**，永不写库、不改 manifest。
//
// 为什么需要它：`verify` 只保证"文件没坏"（checksum），不保证"字段之间还对得上"。
// 2026-11-05 事故：553 处 seq 重指后 occurredAt 没同步（651/1418 不一致、17 条跨日），
// `verify` 全程没报 —— 这就是 PostgreSQL amcheck 说的 "logical corruption cannot be detected with checksums"。
//
// 不变量：
//   SI-1 时间对齐：support[].occurredAt == events[support.seq].time（容差 --tolerance，默认 0）
//   SI-2 序号在窗：support.seq ∈ [episode.firstSeq, episode.lastSeq]
//   SI-4 时间在窗：claim.occurredAt ∈ [episode.firstEventAt, episode.lastEventAt]
//   SI-5 重指留痕：provenanceRepair.fixes[].toOccurredAt == support[].occurredAt
//
// 三态：pass / fail / unverified（读不到日志 ⇒ 单列，不判绿也不判红，但退出码非 0 fail-closed）
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../src/rooms/persist.mjs';
import { readFrames, parseEvents } from '../src/rooms/logread.mjs';

export const CHECK_VERSION = 1;

export function defaultHome(env = process.env) {
  return path.resolve(env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || '.', 'DeepSeek Harness', 'home'));
}

/** 事件 seq → time。 */
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

/** 局的事件窗（seq 与时间两条）。 */
export function episodeWindow(times) {
  let minSeq = Infinity;
  let maxSeq = -Infinity;
  let minTime = Infinity;
  let maxTime = -Infinity;
  for (const [seq, time] of times) {
    if (seq < minSeq) minSeq = seq;
    if (seq > maxSeq) maxSeq = seq;
    if (time < minTime) minTime = time;
    if (time > maxTime) maxTime = time;
  }
  return Number.isFinite(minSeq) ? { minSeq, maxSeq, minTime, maxTime } : null;
}

/**
 * 对一批 claim 跑 SI 检查（纯函数，日志用 `timeIndexOf(episodeId)` 注入 ⇒ 可单测）。
 * @returns {{pass:number, fail:number, unverified:number, buckets:object, samples:Array}}
 */
export function runSemanticChecks({ claims, timeIndexOf, tolerance = 0, nowWindow = null } = {}) {
  const out = { pass: 0, fail: 0, unverified: 0, buckets: {}, samples: [], checked: 0 };
  // T277 · SI-6 用：全部可判定引用的 delta = support.occurredAt − events[seq].time
  const deltas = [];
  const bump = (kind, row) => {
    out.fail += 1;
    out.buckets[kind] = (out.buckets[kind] ?? 0) + 1;
    if (out.samples.length < 5) out.samples.push({ kind, ...row });
  };
  for (const claim of Array.isArray(claims) ? claims : []) {
    const support = Array.isArray(claim?.support) ? claim.support : [];
    if (!support.length) continue;
    const byEpisode = new Map();
    for (const ref of support) {
      const ep = String(ref?.episode ?? '');
      if (!byEpisode.has(ep)) byEpisode.set(ep, []);
      byEpisode.get(ep).push(ref);
    }
    for (const [episode, refs] of byEpisode) {
      const times = timeIndexOf(episode);
      if (!times) { out.unverified += refs.length; continue; }
      const win = episodeWindow(times);
      for (const ref of refs) {
        out.checked += 1;
        const seq = Number(ref?.seq);
        const declared = Number(ref?.occurredAt);
        const actual = times.get(seq);
        // SI-2 序号在窗
        if (win && (!Number.isFinite(seq) || seq < win.minSeq || seq > win.maxSeq)) {
          bump('SI-2-seq-out-of-window', { claimId: claim.id, episode, seq, minSeq: win.minSeq, maxSeq: win.maxSeq }); continue;
        }
        // SI-1 时间对齐（查不到该 seq 的时间 ⇒ unverified，不判红）
        if (!Number.isFinite(actual)) { out.unverified += 1; continue; }
        if (!Number.isFinite(declared)) { bump('SI-1-missing-occurredAt', { claimId: claim.id, episode, seq }); continue; }
        deltas.push({ delta: declared - actual, claimId: claim.id, episode, seq });
        if (Math.abs(actual - declared) > tolerance) {
          bump('SI-1-time-mismatch', { claimId: claim.id, episode, seq, declared, actual, deltaMs: actual - declared }); continue;
        }
        out.pass += 1;
      }
      // SI-4（T272 改正）· **support 级**：每条 support 的 occurredAt 必须落在**它自己那一局**的窗口内。
      // claim 级的 occurredAt 是"首次发生时间"，跨局 claim 本来就不该落在每一局里（旧判据 284/409 全是误报）。
      if (win) {
        for (const ref of refs) {
          const at = Number(ref?.occurredAt);
          if (!Number.isFinite(at)) continue;
          if (at < win.minTime - tolerance || at > win.maxTime + tolerance) {
            bump('SI-4-support-time-out-of-window', { claimId: claim.id, episode, seq: Number(ref?.seq), occurredAt: at, minTime: win.minTime, maxTime: win.maxTime });
          }
        }
      }
    }
    // SI-4b（T272）· claim 级只剩一条：首次发生不可能**晚于**证据
    const claimAt = Number(claim?.occurredAt);
    const supportMax = support.reduce((m, r) => { const v = Number(r?.occurredAt); return Number.isFinite(v) && v > m ? v : m; }, -Infinity);
    if (Number.isFinite(claimAt) && Number.isFinite(supportMax) && claimAt > supportMax + tolerance) {
      bump('SI-4b-claim-after-support', { claimId: claim.id, occurredAt: claimAt, supportMax });
    }
    // SI-5 重指留痕
    const repairs = Array.isArray(claim?.provenanceRepair) ? claim.provenanceRepair : [];
    for (const p of repairs) {
      const fixes = Array.isArray(p?.fixes) ? p.fixes : [p];
      for (const fix of fixes) {
        if (!fix || !Number.isFinite(Number(fix.to))) continue;
        const ref = support[Number(fix.index) ?? -1];
        if (!ref) continue;
        const toOcc = Number(fix.toOccurredAt);
        const declared = Number(ref.occurredAt);
        if (!Number.isFinite(toOcc)) { bump('SI-5-missing-toOccurredAt', { claimId: claim.id, episode: String(ref.episode), seq: Number(ref.seq) }); continue; }
        if (Number.isFinite(declared) && Math.abs(toOcc - declared) > tolerance) {
          bump('SI-5-repair-date-drift', { claimId: claim.id, episode: String(ref.episode), seq: Number(ref.seq), fixedDate: toOcc, declared });
        }
      }
    }
  }
  // ── SI-6 · 偏移分布的"竖线"检测（T277）────────────────────────────────
  // 系统性错误给一条竖线（delta 全等于同一常数），随机错误给分散残差。
  // 判据：可判定引用数 ≥ MIN_SI6_N 且**同一 delta 的占比 ≥ 0.8** 且 |delta| > 1ms（排除容差噪声）⇒ 系统性偏移。
  // delta ≈ 0 的竖线是"大家都取对了"，不报。
  const MIN_SI6_N = 5;
  const SHARE = 0.8;
  const stats = { n: deltas.length, constant: null, share: 0, top: [] };
  if (deltas.length >= MIN_SI6_N) {
    const freq = new Map();
    for (const d of deltas) {
      const key = Math.round(d.delta); // 1ms 容差桶
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    const [topDelta, topCount] = sorted[0];
    const share = topCount / deltas.length;
    stats.constant = topDelta;
    stats.share = Number(share.toFixed(4));
    stats.top = sorted.slice(0, 3).map(([delta, count]) => ({ delta, count }));
    if (share >= SHARE && Math.abs(topDelta) > 1) {
      out.fail += 1;
      out.buckets['SI-6-systematic-offset'] = 1;
      const sample = deltas.find((d) => Math.round(d.delta) === topDelta);
      if (out.samples.length < 5) out.samples.push({ kind: 'SI-6-systematic-offset', claimId: sample?.claimId, episode: sample?.episode, seq: sample?.seq, delta: topDelta, share: Number(share.toFixed(4)), n: deltas.length });
    }
  }
  out.si6 = stats;
  return out;
}

/** 真实日志读取器（只读）。 */
export function makeTimeIndexLoader({ home = defaultHome() } = {}) {
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
          const events = parseEvents(frames ?? [])?.events ?? null;
          out = events ? buildTimeIndex(events) : null;
        }
      }
    } catch { out = null; }
    cache.set(episodeId, out);
    return out;
  };
}

export function parseArgs(argv = []) {
  const flags = { store: null, all: false, sample: 30, tolerance: 0, json: false, help: false, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') flags.all = true;
    else if (a === '--apply') flags.apply = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--store') flags.store = argv[++i] ?? null;
    else if (a === '--sample') flags.sample = Number(argv[++i] ?? 30) || 30;
    else if (a === '--tolerance') flags.tolerance = Number(argv[++i] ?? 0) || 0;
    else return { error: `未知参数：${a}` };
  }
  return flags;
}

export function runCli(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  if (flags.error) return { code: 2, stdout: flags.error };
  if (flags.help) return { code: 0, stdout: USAGE };
  // 只读闸：本工具永不接受 --apply
  if (flags.apply) return { code: 1, stdout: '✗ semantic-check 是只读校验器，不接受 --apply' };
  const home = defaultHome();
  const storeRoot = flags.store ? path.resolve(flags.store) : path.join(home, 'memory-context');
  if (!fs.existsSync(storeRoot)) return { code: 2, stdout: `库不存在：${storeRoot}` };
  const store = createStore({ root: storeRoot });
  const episodes = new Map(store.list('episodes').map((e) => [e.id, e.record]));
  let claims = store.list('claims').map((e) => e.record).filter(Boolean);
  if (!flags.all) claims = claims.slice(0, flags.sample);
  const loader = makeTimeIndexLoader({ home });
  const res = runSemanticChecks({ claims, timeIndexOf: (epId) => loader(epId, episodes.get(epId)), tolerance: flags.tolerance });
  const verdict = res.fail > 0 || res.unverified > 0 ? 'fail' : 'pass';
  const payload = { storeRoot, sampled: claims.length, total: store.list('claims').length, verdict, ...res };
  if (flags.json) return { code: verdict === 'pass' ? 0 : 1, stdout: JSON.stringify(payload, null, 2) };
  const lines = [];
  lines.push(`语义不变量（SI）· ${storeRoot}`);
  lines.push(`抽样 ${claims.length}/${payload.total} 条 · 检查引用 ${res.checked} 处 · 容差 ${flags.tolerance} ms`);
  lines.push(`  pass ${res.pass} · fail ${res.fail} · unverified ${res.unverified}`);
  for (const [k, v] of Object.entries(res.buckets)) lines.push(`  ✗ ${k}: ${v}`);
  if (res.si6) lines.push(`  SI-6 偏移分布：n=${res.si6.n} · 众数 delta=${res.si6.constant ?? 'n/a'} ms · 占比 ${(res.si6.share * 100).toFixed(1)}% · top ${JSON.stringify(res.si6.top)}`);
  for (const s of res.samples) lines.push(`    · ${s.kind} ${s.claimId} @ ${s.episode} seq ${s.seq}${s.declared !== undefined ? `（声明 ${s.declared} vs 事件 ${s.actual}，Δ ${s.deltaMs} ms）` : ''}`);
  lines.push(`结论：${verdict === 'pass' ? 'pass' : 'fail（含 unverified）'}`);
  return { code: verdict === 'pass' ? 0 : 1, stdout: lines.join('\n') };
}

export const USAGE = `T262 · 语义不变量校验（只读）

  node scripts/semantic-check.mjs [--store <dir>] [--sample 30 | --all] [--tolerance 0] [--json]
  退出码：0=pass · 1=fail/unverified · 2=参数或库缺失
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

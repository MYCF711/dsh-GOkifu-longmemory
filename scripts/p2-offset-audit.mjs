#!/usr/bin/env node
// T66（2026-11-09）· P2 指针偏移诊断：`quote-not-substring` 到底是"指错了"还是"改写"？
//
// 背景：`provenance-p2` 报 4315 条引用里 **3565 条不是原文子串**。这个数字本身不说明问题 ——
// 可能有两种完全不同的原因：① 抽取时把 seq 记到了**动作事件**（tool/call）而不是**结果事件**（tool/result），
// 属机械可修的指针 bug；② 引文确实被改写/截断，属抽取质量问题。
//
// 本脚本对**失败样本**逐条在整局事件里搜引文，输出 `foundSeq - seq` 的分布：
//   · 大量集中在同一个小数（如 +2）⇒ ① 指针系统性偏移，改抽取即可；
//   · 分散或找不到 ⇒ ② 改写/截断，要改引文捕获。
//
// 用法：
//   node scripts/p2-offset-audit.mjs                 # 默认看 200 条失败样本
//   node scripts/p2-offset-audit.mjs --limit 500
//   node scripts/p2-offset-audit.mjs --home <dir> --json
//
// 只读：不写库、不改代码。退出码恒 0（这是诊断，不是闸）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readFrames, parseEvents } from '../src/rooms/logread.mjs';
import { auditP2 } from './provenance-p2.mjs';
// 必须与 P2 审计**完全同一个**取文本口径，否则"找不到"会是我自己造的假象
import { eventText as canonicalEventText } from './self-contamination-audit.mjs';
import { normalizeText } from './provenance-p2.mjs';

const KINDS = ['episodes', 'claims'];

function readJsonDir(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
      .map((n) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

const eventText = (ev) => canonicalEventText(ev);

export function offsetHistogram({ claims, episodes, loadEvents, limit = 200 }) {
  const byEpisode = new Map();
  const rows = [];
  const counts = new Map();
  for (const claim of claims) {
    if (rows.length >= limit) break;
    for (const s of Array.isArray(claim?.support) ? claim.support : []) {
      if (rows.length >= limit) break;
      const quote = String(s?.quote ?? '');
      const seq = Number(s?.seq);
      if (!quote || !Number.isFinite(seq)) continue;
      const ep = episodes.get(s.episode);
      if (!ep) continue;
      let events = byEpisode.get(s.episode);
      if (events === undefined) {
        try { events = loadEvents(s.episode, ep); } catch { events = null; }
        byEpisode.set(s.episode, events);
      }
      if (!Array.isArray(events)) continue;
      const needle = normalizeText(quote);
      if (!needle) continue;
      const atSeq = events.find((ev) => Number(ev?.seq) === seq);
      if (atSeq && eventText(atSeq).includes(needle)) continue; // 本来就是对的（指针指对了）
      let found = null;
      for (const ev of events) {
        if (eventText(ev).includes(needle)) { found = Number(ev.seq); break; }
      }
      if (found === null) { counts.set('not-found', (counts.get('not-found') ?? 0) + 1); rows.push({ claimId: claim.id, seq, delta: null }); continue; }
      const delta = found - seq;
      counts.set(delta, (counts.get(delta) ?? 0) + 1);
      rows.push({ claimId: claim.id, seq, foundSeq: found, delta });
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return { sampled: rows.length, histogram: sorted, rows };
}

function parseArgs(argv) {
  const out = { home: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), limit: 200, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--home') out.home = argv[++i];
    else if (argv[i] === '--limit') out.limit = Number(argv[++i]) || 200;
    else if (argv[i] === '--json') out.json = true;
  }
  return out;
}

export async function run({ home, limit = 200 } = {}) {
  const root = path.join(home, 'memory-context');
  const claims = readJsonDir(path.join(root, 'claims'));
  const episodes = new Map(readJsonDir(path.join(root, 'episodes')).map((e) => [e.id, e]));
  const loadEvents = (episodeId, ep) => {
    const logPath = ep?.closure?.logPath;
    if (!logPath) return null;
    const abs = path.isAbsolute(logPath) ? logPath : path.join(home, logPath);
    if (!fs.existsSync(abs)) return null;
    const res = readFrames(fs.readFileSync(abs));
    const frames = Array.isArray(res) ? res : res?.frames;
    return parseEvents(frames ?? [])?.events ?? null;
  };
  const p2 = await auditP2({ claims, episodes, loadEvents, opts: { limit: claims.length } });
  return offsetHistogram({ claims, episodes, loadEvents, limit });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).endsWith('p2-offset-audit.mjs');
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const r = await run({ home: args.home, limit: args.limit });
  if (args.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log('T66 · P2 指针偏移诊断（失败样本里"引文实际在哪一条"）');
    console.log(`样本 ${r.sampled} 条 · foundSeq - seq 分布：`);
    for (const [delta, n] of r.histogram) console.log(`  ${delta === 'not-found' ? '整局找不到' : `${delta >= 0 ? '+' : ''}${delta}`} : ${n}`);
  }
}

#!/usr/bin/env node
// T68（2026-11-09）· P2 失败按**出处来源**分桶：图来源 vs 信号来源。
//
// 为什么：T66 把 3565 条 `quote-not-substring` 分成了"整局找不到 / 小偏移 / 同文他处"，
// 但没回答"**谁**产出的这些 support"。claim 的 support 有两个来源：
//   · **图来源**：从棋谱节点/边（`nodeId`/`edgeId`，上游 graph.json）抄来的 `seq` + `quote`；
//   · **信号来源**：本仓 R03 抽取的失败/约束（`seq` 直接来自 tool/result 事件）。
// 两者坏法完全不同 —— 分清之后才知道该改哪一侧。
//
// 用法：
//   node scripts/p2-source-audit.mjs              # 前 300 条 claim
//   node scripts/p2-source-audit.mjs --limit 800
//   node scripts/p2-source-audit.mjs --json
//
// 只读；退出码恒 0（诊断，不是闸）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readFrames, parseEvents } from '../src/rooms/logread.mjs';
import { eventText } from './self-contamination-audit.mjs';
import { normalizeText } from './provenance-p2.mjs';

export const DEFAULT_LIMIT = 300;

function readJsonDir(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
      .map((n) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

export function makeEventLoader({ home, episodes }) {
  const cache = new Map();
  return (episodeId) => {
    if (cache.has(episodeId)) return cache.get(episodeId);
    let events = null;
    try {
      const ep = episodes.get(episodeId);
      const logPath = ep?.closure?.logPath;
      if (logPath) {
        const abs = path.isAbsolute(logPath) ? logPath : path.join(home, logPath);
        if (fs.existsSync(abs)) {
          const res = readFrames(fs.readFileSync(abs));
          const frames = Array.isArray(res) ? res : res?.frames;
          events = parseEvents(frames ?? [])?.events ?? null;
        }
      }
    } catch { events = null; }
    cache.set(episodeId, events);
    return events;
  };
}

/**
 * 纯逻辑：按 support 的来源分桶统计"引文是否真的在该 seq 上"。
 * @param {object} p
 * @param {Array} p.claims
 * @param {Function} p.loadEvents (episodeId) => events[]|null
 */
export function auditBySource({ claims = [], loadEvents, limit = DEFAULT_LIMIT } = {}) {
  const buckets = {
    graph: { total: 0, bad: 0 },
    signal: { total: 0, bad: 0 },
    skippedNoEvents: 0,
  };
  let scanned = 0;
  for (const claim of claims.slice(0, limit)) {
    scanned += 1;
    for (const s of Array.isArray(claim?.support) ? claim.support : []) {
      const quote = normalizeText(String(s?.quote ?? ''));
      const seq = Number(s?.seq);
      if (!quote || !Number.isFinite(seq)) continue;
      const events = loadEvents(s.episode);
      if (!Array.isArray(events)) { buckets.skippedNoEvents += 1; continue; }
      const hit = events.find((ev) => Number(ev?.seq) === seq);
      const ok = hit ? eventText(hit).includes(quote) : false;
      const bucket = (s.nodeId || s.edgeId) ? buckets.graph : buckets.signal;
      bucket.total += 1;
      if (!ok) bucket.bad += 1;
    }
  }
  const pct = (b) => (b.total ? +((b.bad / b.total) * 100).toFixed(1) : null);
  return { scanned, graph: { ...buckets.graph, badRate: pct(buckets.graph) }, signal: { ...buckets.signal, badRate: pct(buckets.signal) }, skippedNoEvents: buckets.skippedNoEvents };
}

export function run({ home, limit = DEFAULT_LIMIT } = {}) {
  const root = path.join(home, 'memory-context');
  const claims = readJsonDir(path.join(root, 'claims'));
  const episodes = new Map(readJsonDir(path.join(root, 'episodes')).map((e) => [e.id, e]));
  return auditBySource({ claims, loadEvents: makeEventLoader({ home, episodes }), limit });
}

function parseArgs(argv) {
  const out = { home: process.env.DSH_HOME || 'D:/DeepSeek Harness/home', limit: DEFAULT_LIMIT, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--home') out.home = argv[++i];
    else if (argv[i] === '--limit') out.limit = Number(argv[++i]) || DEFAULT_LIMIT;
    else if (argv[i] === '--json') out.json = true;
  }
  return out;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).endsWith('p2-source-audit.mjs');
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const r = run({ home: args.home, limit: args.limit });
  if (args.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log('T68 · P2 失败按来源分桶');
    console.log(`扫描 claim ${r.scanned} 条 · 跳过的引用 ${r.skippedNoEvents}（日志读不到/缺 closure）`);
    console.log(`  图来源（nodeId/edgeId，抄自上游 graph.json）：${r.graph.total} 条 · 坏 ${r.graph.bad}（${r.graph.badRate}%）`);
    console.log(`  信号来源（本仓 R03 抽取，seq 来自 tool/result）：${r.signal.total} 条 · 坏 ${r.signal.bad}（${r.signal.badRate}%）`);
  }
}

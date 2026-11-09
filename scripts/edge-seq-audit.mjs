#!/usr/bin/env node
// T72（2026-11-09）· 端到端验证 T69：失败边的 `seq` 到底指没指对？
//
// 背景：T69 把 `edgeSeq()` 从「无条件取 evidence.start（动作事件）」改成「按引文来源取 start/end」。
// 单元测试只证明"取哪一头"，证明不了**真实数据上到底对不对**。本脚本直接拿真棋谱 + 真会话日志比对：
//   · 旧口径：`edge.evidence.start`
//   · 新口径：`edgeSeq(edge)`（T69）
// 对每条失败边，看它的引文（`errorSnippet` / `verify.summary`）是否**真的**在该 seq 的事件文本里。
//
// 用法：
//   node scripts/edge-seq-audit.mjs                      # 扫最近的 3 局
//   node scripts/edge-seq-audit.mjs --sessions 10
//   node scripts/edge-seq-audit.mjs --json
//
// 只读；退出码恒 0（诊断，不是闸）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readFrames, parseEvents } from '../src/rooms/logread.mjs';
import { edgeSeq } from '../src/rooms/extract.mjs';
import { eventText } from './self-contamination-audit.mjs';
import { normalizeText } from './provenance-p2.mjs';

/** 纯逻辑：给定失败边与"seq→该事件归一化文本"的查找表，比新旧两种 seq 口径。 */
export function compareEdgeSeq({ edges = [], textAt }) {
  let total = 0;
  let oldOk = 0;
  let newOk = 0;
  for (const edge of edges) {
    if (edge?.result !== 'failure') continue;
    const quote = normalizeText(String(edge?.errorSnippet ?? edge?.verify?.summary ?? '').trim());
    if (!quote) continue;
    total += 1;
    const oldSeq = Number(edge?.evidence?.start);
    const newSeq = Number(edgeSeq(edge));
    if (textAt(oldSeq)?.includes(quote)) oldOk += 1;
    if (textAt(newSeq)?.includes(quote)) newOk += 1;
  }
  const pct = (n) => (total ? +((n / total) * 100).toFixed(1) : null);
  return { total, oldOk, newOk, oldRate: pct(oldOk), newRate: pct(newOk) };
}

function readGraph(sessionsRoot, sessionId) {
  const file = path.join(sessionsRoot, sessionId, 'graph.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * 会话日志的真实位置由 **episode 的 `closure.logPath`** 决定（`<home>/sessions/.../session.v4.jsonl.zstd`），
 * 不在 `chess-context/sessions/<sid>/` 里 —— 早期版本在这里找过，永远找不到（0 条样本的假象）。
 */
function makeLogPathResolver({ home }) {
  const episodesRoot = path.join(home, 'memory-context', 'episodes');
  const bySession = new Map();
  try {
    for (const name of fs.readdirSync(episodesRoot)) {
      if (!name.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(episodesRoot, name), 'utf8'));
        if (rec?.sessionId && rec?.closure?.logPath) bySession.set(String(rec.sessionId), rec.closure.logPath);
      } catch { /* 坏条目跳过 */ }
    }
  } catch { /* 没有 episodes 目录 ⇒ 空表 */ }
  // 还没归档的会话在 episodes 里查不到 ⇒ 回退到直接扫 `<home>/sessions/*/session-<id>*/`
  const scanCache = new Map();
  const scanFor = (sessionId) => {
    if (scanCache.has(sessionId)) return scanCache.get(sessionId);
    let found = null;
    try {
      const root = path.join(home, 'sessions');
      for (const bucket of fs.readdirSync(root)) {
        const dir = path.join(root, bucket, `session-${sessionId}`);
        if (!fs.existsSync(dir)) continue;
        const name = fs.readdirSync(dir).find((n) => n.endsWith('.jsonl.zstd'));
        if (name) { found = path.join(dir, name); break; }
      }
    } catch { found = null; }
    scanCache.set(sessionId, found);
    return found;
  };
  return (sessionId) => {
    const rel = bySession.get(String(sessionId));
    if (rel) {
      const abs = path.isAbsolute(rel) ? rel : path.join(home, rel);
      if (fs.existsSync(abs)) return abs;
    }
    return scanFor(sessionId);
  };
}

export function run({ home = process.env.DSH_HOME || 'D:/DeepSeek Harness/home', sessions = 3, now = Date.now() } = {}) {
  const sessionsRoot = path.join(home, 'chess-context', 'sessions');
  let ids = [];
  try {
    ids = fs.readdirSync(sessionsRoot)
      .map((id) => {
        try { return { id, at: fs.statSync(path.join(sessionsRoot, id, 'graph.json')).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at)
      .slice(0, sessions)
      .map((x) => x.id);
  } catch { ids = []; }
  const resolveLogPath = makeLogPathResolver({ home });
  const totals = { total: 0, oldOk: 0, newOk: 0 };
  const perSession = [];
  for (const sid of ids) {
    const graph = readGraph(sessionsRoot, sid);
    const logPath = resolveLogPath(sid);
    if (!graph || !logPath) continue;
    let events = [];
    try {
      const res = readFrames(fs.readFileSync(logPath));
      events = parseEvents((Array.isArray(res) ? res : res?.frames) ?? [])?.events ?? [];
    } catch { events = []; }
    const map = new Map(events.map((e) => [Number(e?.seq), normalizeText(eventText(e))]));
    const edges = Array.isArray(graph.edges) ? graph.edges : Object.values(graph.edges ?? {});
    const r = compareEdgeSeq({ edges, textAt: (seq) => map.get(seq) ?? '' });
    totals.total += r.total; totals.oldOk += r.oldOk; totals.newOk += r.newOk;
    perSession.push({ session: sid, ...r });
  }
  const pct = (n) => (totals.total ? +((n / totals.total) * 100).toFixed(1) : null);
  return { sessions: perSession, totals: { ...totals, oldRate: pct(totals.oldOk), newRate: pct(totals.newOk) } };
}

function parseArgs(argv) {
  const out = { home: process.env.DSH_HOME || 'D:/DeepSeek Harness/home', sessions: 3, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--home') out.home = argv[++i];
    else if (argv[i] === '--sessions') out.sessions = Number(argv[++i]) || 3;
    else if (argv[i] === '--json') out.json = true;
  }
  return out;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).endsWith('edge-seq-audit.mjs');
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const r = run(args);
  if (args.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log('T72 · 失败边 seq 口径对比（旧 = evidence.start · 新 = edgeSeq）');
    for (const s of r.sessions) {
      console.log(`  ${s.session.slice(0, 20)}… 失败边 ${s.total} · 旧命中 ${s.oldOk}（${s.oldRate}%）· 新命中 ${s.newOk}（${s.newRate}%）`);
    }
    console.log(`  合计：${r.totals.total} 条 · 旧 ${r.totals.oldOk}（${r.totals.oldRate}%）→ 新 ${r.totals.newOk}（${r.totals.newRate}%）`);
  }
}

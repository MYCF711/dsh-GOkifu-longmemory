#!/usr/bin/env node
// 真实会话回放（2026-11-03）：A3 的"准线上"证据。
// 不是合成信号，也不是仿真会话——直接取**最近 N 局真实会话**的首条用户消息，
// 走真实插件入口（apply → agent/pre-step）+ 真实 store，看它会不会注入、注入了什么。
//
// 与 host-sim 的区别：
//   host-sim：合成信号 × N，测可靠性/延迟；
//   replay-live：真实消息 × 真实局，测"在真语料上会不会响、响得对不对"。
//
// 用法：node scripts/replay-live.mjs [--sessions 12] [--max-user 2] [--json] [--evidence <path>]
// 不安装、不重启、不写 <DSH_HOME>（假 session.append 一旦被调就抛错）。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apply } from '../src/plugin.mjs';
import { createStore } from '../src/rooms/persist.mjs';
import { readFrames, parseEvents } from '../src/rooms/logread.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');
const storeRoot = path.resolve(opt('store', path.join(HOME, 'memory-context')));
const sessionsRoot = path.resolve(opt('sessions-root', path.join(HOME, 'sessions')));
const count = Number(opt('sessions', '12'));
const maxUser = Number(opt('max-user', '2'));
const json = argv.includes('--json');
const evidence = opt('evidence', null);

// scopeKey（w:d:/x）→ Windows 路径（D:/x），喂给 session.cwd 让插件按真实工作区判定
export const cwdFromScope = (scopeKey) => {
  const raw = String(scopeKey ?? '');
  if (!raw.startsWith('w:')) return process.cwd();
  const p = raw.slice(2);
  return /^[a-z]:\//i.test(p) ? p[0].toUpperCase() + p.slice(1) : p;
};

export async function main() {
function pct(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// 1) 取最近 N 局（有棋盘记录的）
const store = createStore({ root: storeRoot });
const scopeOfEpisode = new Map();
for (const x of store.list('episodes')) {
  const e = x?.record;
  if (e?.id) scopeOfEpisode.set(String(e.id), String(e.scopeKey ?? ''));
}

const episodes = store.list('episodes')
  .map((x) => x.record)
  .filter((e) => e && typeof e.id === 'string' && Number.isFinite(e.lastEventAt))
  .sort((a, b) => b.lastEventAt - a.lastEventAt)
  .slice(0, count);

// 2) 逐局读日志，抽用户消息
const replays = [];
for (const ep of episodes) {
  const rel = ep?.closure?.logPath;
  if (!rel) continue;
  const abs = path.isAbsolute(rel) ? rel : path.join(rel.startsWith('sessions') ? HOME : sessionsRoot, rel);
  if (!fs.existsSync(abs)) continue;
  let messages = [];
  try {
    const frames = readFrames(fs.readFileSync(abs));
    const parsed = parseEvents(frames.frames);
    messages = parsed.events
      .filter((e) => e?.type === 'user/message')
      .map((e) => (Array.isArray(e?.data?.content) ? e.data.content : [])
        .filter((c) => c?.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text).join('\n'))
      .filter((t) => t && t.trim() !== '')
      .slice(0, maxUser);
  } catch { continue; }
  if (messages.length) replays.push({ id: ep.id, scopeKey: ep.scopeKey, messages });
}

// 3) 真实插件 + 真实 store 回放
const warns = [];
const hooks = {};
const ctx = { on: (name, fn) => { hooks[name] = fn; }, logger: { warn: (m) => warns.push(String(m)), debug: () => {} } };
let seq = 0;
apply(ctx, {
  enabled: true,
  shadow: false,
  storeRoot,
  now: Date.now(),
  workspace: replays[0]?.scopeKey ?? process.cwd(),
  createUserMessage: (input) => ({ id: `m${(seq += 1)}`, role: 'user', ...input }),
});

const handler = hooks['agent/pre-step'];
const rows = [];
const latencies = [];
const injectionLatencies = []; // 只统计"真正走到注入判定"的第一步（不被 oncePerSession 短路）
let leakCount = 0;
let leakTotal = 0;
for (const r of replays) {
  const session = { id: `replay-${r.id}`, cwd: cwdFromScope(r.scopeKey) };
  let injectedAny = false;
  let lastDecision = null;
  for (const [msgIndex, text] of r.messages.entries()) {
    const payload = { agent: { session }, messages: [{ role: 'user', content: [{ type: 'text', text }] }] };
    const started = process.hrtime.bigint();
    const decision = await handler(payload, async () => ({ kind: 'enter', messages: [{ role: 'assistant', content: [] }] }));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    latencies.push(elapsedMs);
    if (msgIndex === 0) injectionLatencies.push(elapsedMs);
    lastDecision = decision;
    const rendered = JSON.stringify(decision?.messages ?? []);
    if (rendered.includes('<memory-ledger>') || rendered.includes('[antipattern]') || rendered.includes('[fact]')) injectedAny = true;
    for (const m of rendered.match(/ep-[0-9a-f]{8}/g) ?? []) {
      const s2 = scopeOfEpisode.get(m);
      leakTotal += 1;
      if (s2 && String(s2) !== String(r.scopeKey)) leakCount += 1;
    }
  }
  rows.push({ episode: r.id, scopeKey: r.scopeKey, userMessages: r.messages.length, injected: injectedAny, lastMessageCount: lastDecision?.messages?.length ?? null });
}

const summary = {
  version: 'replay-live@1',
  generatedAt: Date.now(),
  storeRoot,
  sessions: rows.length,
  injected: rows.filter((r) => r.injected).length,
  empty: rows.filter((r) => !r.injected).length,
  failed: 0,
  warns: warns.length,
  warnSamples: warns.slice(0, 5).map((w) => String(w).slice(0, 160)),
  latencyMs: { p50: pct(latencies, 50), p95: pct(latencies, 95), max: latencies.length ? Math.max(...latencies) : null },
  injectionLatencyMs: { p50: pct(injectionLatencies, 50), p95: pct(injectionLatencies, 95), max: injectionLatencies.length ? Math.max(...injectionLatencies) : null },
  provenanceRefs: leakTotal,
  crossScopeRefs: leakCount,
  crossScopeLeakRate: leakTotal ? leakCount / leakTotal : 0,
  rows: rows.map((r) => ({ ...r, scopeKey: String(r.scopeKey ?? '').split(String.fromCharCode(92)).join('/') })),
};

if (json) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`replay-live：真实会话 ${summary.sessions} 局 · 注入 ${summary.injected} · 沉默 ${summary.empty} · warn ${summary.warns}`);
  console.log(`延迟（含短路）：p50 ${summary.latencyMs.p50?.toFixed?.(2) ?? 'n/a'}ms · p95 ${summary.latencyMs.p95?.toFixed?.(2) ?? 'n/a'}ms`);
  console.log(`注入路径：p50 ${summary.injectionLatencyMs.p50?.toFixed?.(2) ?? 'n/a'}ms · p95 ${summary.injectionLatencyMs.p95?.toFixed?.(2) ?? 'n/a'}ms · max ${summary.injectionLatencyMs.max?.toFixed?.(1) ?? 'n/a'}ms`);
  console.log(`溯源引用 ${summary.provenanceRefs} 条 · 跨作用域 ${summary.crossScopeRefs} 条（${(summary.crossScopeLeakRate * 100).toFixed(2)}%）`);
  for (const r of summary.rows.slice(0, 8)) console.log(`- ${r.episode} · 注入=${r.injected ? 'yes' : 'no'} · 消息 ${r.userMessages} · scope ${String(r.scopeKey).slice(0, 48)}`);
}
if (evidence) {
  const abs = path.resolve(REPO, evidence);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, [
    '# 真实会话回放（replay-live）', '',
    `生成时间：${new Date(summary.generatedAt).toISOString()}`,
    `结论：真实会话 ${summary.sessions} 局中，**注入 ${summary.injected} 局**、沉默 ${summary.empty} 局；warn ${summary.warns}。`,
    `延迟：p50 ${summary.latencyMs.p50?.toFixed?.(2)}ms · p95 ${summary.latencyMs.p95?.toFixed?.(2)}ms`, '',
    '| 局 | 注入 | 用户消息数 | scope |', '|---|---|---|---|',
    ...summary.rows.map((r) => `| ${r.episode} | ${r.injected ? '是' : '否'} | ${r.userMessages} | \`${String(r.scopeKey).slice(0, 60)}\` |`),
  ].join('\n') + '\n');
  console.log(`evidence → ${path.relative(REPO, abs)}`);
}
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
if (invoked) main();


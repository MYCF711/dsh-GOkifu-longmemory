#!/usr/bin/env node
// T279 · 从**历史局**构造 T267 复算语料（只读）。
//
// 为什么：T278 的语料全来自本仓 scope（长期记忆系统自身），而库里的 claim 讲的是别的项目
// ⇒ A 路无货可召，delta 恒为 0。这刀换成"有记忆命中的历史局"。
//
// 规则（T264 硬约束）：每条语料的 messages **只含注入点之前**的事件（availableAtSeq ≤ injectionSeq）。
//
// 用法：
//   node scripts/t267-corpus-from-logs.mjs --out tmp/t279-corpus.jsonl [--episodes 20] [--scopes 3] [--injections 40]
//
// 产出 JSONL，每行 `{ at, scopeKey, episode, injectionSeq, messages:[{role,text}] }`（t267-replay 的输入形状）。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';
import { readFrames, parseEvents } from '../src/rooms/logread.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SELF_SCOPE = 'w:d:/deepseek harness/default-workspace/长期记忆系统';

export function defaultHome(env = process.env) {
  return path.resolve(env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || '.', 'DeepSeek Harness', 'home'));
}

/** 从事件里取"人能读的文本"（user/assistant/tool 三类）。 */
export function eventText(ev) {
  const content = ev?.data?.message?.content ?? ev?.data?.content ?? ev?.data?.message?.message?.content ?? null;
  const out = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') { out.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (typeof v === 'object') {
      if (typeof v.text === 'string') { out.push(v.text); return; }
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(content);
  return out.join('\n').trim();
}

export function roleOf(ev) {
  const t = String(ev?.type ?? '');
  if (t.startsWith('user')) return 'user';
  if (t.startsWith('assistant')) return 'assistant';
  if (t.startsWith('tool')) return 'tool';
  return null;
}

/**
 * 从一局的事件里切出"注入点之前"的语料行。
 * 注入点 = 每个 `tool/result` 事件（那一步结束时记忆会被读）。
 */
export function rowsFromEvents({ events, scopeKey, episodeId, maxInjections = 40, lastN = 12 }) {
  const rows = [];
  const chrono = (Array.isArray(events) ? events : []).filter((e) => Number.isFinite(Number(e?.seq)) && Number.isFinite(Number(e?.time)));
  let buffer = [];
  for (const ev of chrono) {
    const role = roleOf(ev);
    const text = role ? eventText(ev) : '';
    if (role && text) buffer.push({ role, text, seq: Number(ev.seq), time: Number(ev.time) });
    if (String(ev.type) !== 'tool/result') continue;
    if (!buffer.length) continue;
    // 注入点：只取 seq ≤ 当前事件 的消息（**当前这条也算"已经发生"**）
    const msgs = buffer.filter((m) => m.seq <= Number(ev.seq)).slice(-lastN).map((m) => ({ role: m.role, text: m.text }));
    if (!msgs.some((m) => m.role === 'user')) continue;
    rows.push({ at: Number(ev.time), scopeKey, episode: episodeId, injectionSeq: Number(ev.seq), messages: msgs });
    if (rows.length >= maxInjections) break;
  }
  return rows;
}

export function buildCorpus({ store, home = defaultHome(), maxEpisodes = 20, maxScopes = 3, maxInjections = 40 } = {}) {
  const episodes = store.list('episodes').map((e) => e.record).filter(Boolean);
  const byScope = new Map();
  for (const ep of episodes) {
    const scope = typeof ep?.scopeKey === 'string' ? ep.scopeKey : '';
    if (!scope) continue;
    if (scope.toLowerCase() === SELF_SCOPE) continue; // 排除本仓
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push(ep);
  }
  // 每个 scope 按"失败数"降序（有失败签名的局才有该召回的教训）
  const scopeRank = [...byScope.entries()].map(([scope, eps]) => ({
    scope,
    eps: eps.sort((a, b) => (Number(b?.signals?.failures ?? 0) - Number(a?.signals?.failures ?? 0))),
    failures: eps.reduce((s, e) => s + Number(e?.signals?.failures ?? 0), 0),
  })).sort((a, b) => b.failures - a.failures).slice(0, maxScopes);
  const rows = [];
  const picked = [];
  for (const { scope, eps } of scopeRank) {
    let used = 0;
    for (const ep of eps) {
      if (used >= Math.ceil(maxEpisodes / scopeRank.length)) break;
      const logPath = ep?.closure?.logPath;
      if (!logPath) continue;
      const abs = path.isAbsolute(logPath) ? logPath : path.join(home, logPath);
      if (!fs.existsSync(abs)) continue;
      let events;
      try {
        const framesRes = readFrames(fs.readFileSync(abs));
        const frames = Array.isArray(framesRes) ? framesRes : framesRes?.frames;
        events = parseEvents(frames ?? [])?.events ?? [];
      } catch { continue; }
      const rs = rowsFromEvents({ events, scopeKey: scope, episodeId: ep.id, maxInjections });
      if (!rs.length) continue;
      rows.push(...rs);
      picked.push({ episode: ep.id, scope, injections: rs.length, failures: Number(ep?.signals?.failures ?? 0), events: events.length });
      used += 1;
      if (rows.length >= maxEpisodes * maxInjections) break;
    }
    if (rows.length >= maxEpisodes * maxInjections) break;
  }
  return { rows, picked, scopes: scopeRank.map((s) => s.scope) };
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const home = defaultHome();
  const store = createStore({ root: path.resolve(opt('store', path.join(home, 'memory-context'))) });
  const outPath = path.resolve(opt('out', path.join(REPO_ROOT, 'tmp', 't279-corpus.jsonl')));
  const { rows, picked, scopes } = buildCorpus({
    store,
    home,
    maxEpisodes: Number(opt('episodes', '20')),
    maxScopes: Number(opt('scopes', '3')),
    maxInjections: Number(opt('injections', '40')),
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(JSON.stringify({ ok: true, out: outPath, rows: rows.length, episodes: picked.length, scopes, picked }, null, 2));
  return 0;
}

if (process.argv[1] && String(process.argv[1]).split(String.fromCharCode(92)).join('/').endsWith('scripts/t267-corpus-from-logs.mjs')) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(`语料构造失败：${String(error?.message ?? error)}`); process.exitCode = 2; });
}

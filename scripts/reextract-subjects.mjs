#!/usr/bin/env node
// T327 · 重跑抽取：把 E1 主体（目标/文件/测试名）与 E3 命令写进 quote（知识库 75 的唯一真解）
//
// 背景（T325/T326）：过 A1 门的 511 条里只有 279 条（54.60%）有 X3 依赖链；
// 232 条 `observed` **不是"待补"，是"按现有证据补不出"** —— 因为抽取时没把目标/文件写进 quote。
// 知识库 75：**唯一真解是重跑抽取**（原件还在，L1 成立）；**人工补就是编**。
//
// 本脚本（只读）：
//   ① 找出 `observed` 的 antipattern（T325 的 gateClaim 判定）；
//   ② 回到**原始事件**（该 claim 的 support[0].episode + seq）取失败行；
//   ③ 在**失败行 / 该 seq 的事件**里找 E1 主体（路径、目标名）与 E3 命令（`bash(command=…)`）；
//   ④ 原件里有 ⇒ `recoverable`（可修）；原件里也没有 ⇒ `permanent`（永久损失，**不硬补**）。
//
// 用法：node scripts/reextract-subjects.mjs [--json] [--evidence <path>] [--limit N]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { readFrames, parseEvents } from '../src/rooms/logread.mjs';
import { gateClaim } from './mixed-output-gate.mjs';
import { failureLineOf } from './extract-recovery.mjs';

const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';

/** E1 主体：路径 / 目标名（与 T325 同口径，但允许在**整条事件**里找）。 */
export function subjectFromText(text) {
  const s = String(text ?? '');
  const f = /(?:[A-Za-z]:)?[/\\][\w./\\-]{3,}\.(?:m?js|cjs|ts|tsx|json|md|ya?ml|go|py|txt)/.exec(s);
  if (f) return { subject: f[0], kind: 'file', source: 'path' };
  const t = /(?:\u2716|\u2717|\bFAIL(?:ED)?\b|\bnot ok\s+\d+(?:\s*-\s*)?)\s*([^\s:(\u2014-]{3,80})/.exec(s);
  if (t && t[1]) return { subject: t[1], kind: 'target', source: 'fail-target' };
  // 引号里的裸 token（command / Confirm）不算主体 —— 只认真路径（带扩展名或分隔符）
  return null;
}

/** E3 命令：从事件里找 `bash(command=…)` / `write(file_path=…)` 的原文（可重放）。 */
export function commandFromText(text) {
  const m = /([A-Za-z][\w-]{0,20})\((?:command|file_path)=([^\n]{1,300})/.exec(String(text ?? ''));
  return m ? `${m[1]}(${m[2]}` : null;
}

/**
 * 单条 observed 的重抽取判定（纯函数，事件注入）。
 * @returns {{state:'recoverable'|'permanent', subject:object|null, command:string|null, failureLine:string|null}}
 */
export function reextractOne({ claimText, events = [], seq = null } = {}) {
  const g = gateClaim(claimText);
  const idx = Number.isFinite(Number(seq)) ? events.findIndex((e) => Number(e?.seq) === Number(seq)) : -1;
  const candidates = [];
  if (idx >= 0) {
    const evText = collectEventText(events[idx]);
    // 只认**失败行本身**里的主体（整条事件里的偶然字符串不算 —— 否则就是凑覆盖率）
    const line = failureLineOf(evText);
    if (line) candidates.push(line.line);
    // 相邻的 tool/call 里常有 E3 命令
    if (idx > 0) candidates.push(collectEventText(events[idx - 1]));
  }
  candidates.push(String(claimText ?? ''));
  for (const c of candidates) {
    if (!c) continue;
    const subject = subjectFromText(c);
    if (subject) {
      const command = commandFromText(c) ?? commandFromText(candidates.join('\n'));
      return { state: 'recoverable', subject, command: command ?? null, failureLine: failureLineOf(c)?.line ?? null, priorVerdict: g.state };
    }
  }
  return { state: 'permanent', subject: null, command: null, failureLine: null, priorVerdict: g.state };
}

function collectEventText(ev) {
  const out = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') { out.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (typeof v === 'object') { for (const x of Object.values(v)) walk(x); }
  };
  walk(ev?.data ?? ev ?? {});
  return out.join('\n');
}

function opt(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

async function main(argv = process.argv.slice(2)) {
  const storeRoot = path.resolve(opt(argv, 'store', path.join(HOME, 'memory-context')));
  if (!fs.existsSync(storeRoot)) { console.error(`没有 store：${storeRoot}`); return 2; }
  const limitRaw = opt(argv, 'limit', null);
  const limit = limitRaw === null ? Infinity : Number(limitRaw);
  const store = createStore({ root: storeRoot });
  const episodes = new Map(store.list('episodes').map((x) => [x?.record?.id, x?.record]).filter(([id]) => typeof id === 'string'));
  const claims = store.list('claims').map((x) => x?.record).filter(Boolean);
  const anti = claims.filter((c) => String(c?.kind ?? '') === 'antipattern');

  const a1Pass = [];
  const observed = [];
  for (const c of anti) {
    const g = gateClaim(c.text);
    if (g.state === 'rejected') continue;
    a1Pass.push(c);
    if (g.state === 'observed') observed.push(c);
  }

  const eventCache = new Map();
  const rows = [];
  for (const c of observed.slice(0, limit)) {
    const src = Array.isArray(c.support) && c.support[0] ? c.support[0] : {};
    const ep = episodes.get(src.episode) ?? null;
    let events = [];
    if (ep?.closure?.logPath) {
      if (!eventCache.has(src.episode)) {
        const abs = path.isAbsolute(ep.closure.logPath) ? ep.closure.logPath : path.join(HOME, ep.closure.logPath);
        try {
          const fr = readFrames(fs.readFileSync(abs));
          const frames = Array.isArray(fr) ? fr : fr?.frames;
          eventCache.set(src.episode, parseEvents(frames ?? [])?.events ?? []);
        } catch { eventCache.set(src.episode, []); }
      }
      events = eventCache.get(src.episode) ?? [];
    }
    rows.push({ id: c.id, episode: src.episode ?? null, seq: src.seq ?? null, text: String(c.text ?? '').slice(0, 120), ...reextractOne({ claimText: c.text, events, seq: src.seq }) });
  }

  const recoverable = rows.filter((r) => r.state === 'recoverable').length;
  const permanent = rows.filter((r) => r.state === 'permanent').length;
  const before = a1Pass.length ? (a1Pass.length - observed.length) / a1Pass.length : null;
  const after = a1Pass.length ? (a1Pass.length - observed.length + recoverable) / a1Pass.length : null;
  const stats = { antipatterns: anti.length, a1Pass: a1Pass.length, observed: observed.length, recoverable, permanent, x3Before: before, x3After: after };

  if (argv.includes('--json')) console.log(JSON.stringify({ stats, rows }, null, 2));
  else {
    console.log('重跑抽取（E1 主体 / E3 命令）· 只读');
    console.log(`antipattern ${stats.antipatterns} · 过 A1 门 ${stats.a1Pass} · observed ${stats.observed}`);
    console.log(`重跑后：可修（原件有主体）${stats.recoverable} · 永久损失（原件也没有）${stats.permanent}`);
    console.log(`X3 覆盖率 ${(stats.x3Before * 100).toFixed(2)}% → ${(stats.x3After * 100).toFixed(2)}%`);
    for (const r of rows.filter((x) => x.state === 'recoverable').slice(0, 5)) console.log(`+ ${r.id} → ${r.subject.kind}:${r.subject.subject}${r.command ? ` | E3: ${r.command.slice(0, 60)}` : ''}`);
    for (const r of rows.filter((x) => x.state === 'permanent').slice(0, 5)) console.log(`- ${r.id}（永久损失）${JSON.stringify(r.text.slice(0, 60))}`);
  }

  const evidencePath = opt(argv, 'evidence', null);
  if (evidencePath) {
    fs.writeFileSync(path.resolve(evidencePath), renderEvidence({ stats, rows }), 'utf8');
    if (!argv.includes('--json')) console.log(`evidence: ${path.relative(process.cwd(), path.resolve(evidencePath))}`);
  }
  return 0;
}

function renderEvidence({ stats, rows }) {
  const rec = rows.filter((r) => r.state === 'recoverable');
  const per = rows.filter((r) => r.state === 'permanent');
  const lines = [];
  lines.push('# T327 · 重跑抽取：E1 主体 / E3 命令写进 quote（知识库 75）');
  lines.push('');
  lines.push(`> \`[本] ${new Date().toISOString()}\` · **只读**（不写库）· 未跑全量测试、未重启 DSH。`);
  lines.push('> 结论口径：**原件里有就补上；原件里没有的还是 observed（不编）**。');
  lines.push('');
  lines.push('## 0 · 一句话');
  lines.push('');
  lines.push(`**X3 覆盖率 ${(stats.x3Before * 100).toFixed(2)}% → ${(stats.x3After * 100).toFixed(2)}%**：`
    + `232 条 observed 里 **${stats.recoverable} 条原件确实有目标字段（真修复）**，**${stats.permanent} 条原件里也没有（永久损失，不硬补）**。`);
  lines.push('');
  lines.push('## 1 · 汇总');
  lines.push('');
  lines.push('```');
  lines.push(`antipattern ${stats.antipatterns} · 过 A1 门 ${stats.a1Pass} · observed ${stats.observed}`);
  lines.push(`可修（原件有 E1 主体）${stats.recoverable} · 永久损失 ${stats.permanent}`);
  lines.push(`X3 ${(stats.x3Before * 100).toFixed(2)}% → ${(stats.x3After * 100).toFixed(2)}%`);
  lines.push('```');
  lines.push('');
  lines.push('## 2 · 可修样本（前 10，带 E1/E3）');
  lines.push('');
  for (const r of rec.slice(0, 10)) {
    lines.push(`- \`${r.id}\`（${r.episode} seq ${r.seq}）→ **${r.subject.kind}**: \`${r.subject.subject}\`${r.command ? ` · E3: \`${r.command.slice(0, 80)}\`` : ''}`);
  }
  if (!rec.length) lines.push('**0 条**。');
  lines.push('');
  lines.push('## 3 · 永久损失样本（前 10，原件里也没有）');
  lines.push('');
  for (const r of per.slice(0, 10)) lines.push(`- \`${r.id}\`（${r.episode} seq ${r.seq}）${JSON.stringify(r.text.slice(0, 90))}`);
  if (!per.length) lines.push('**0 条**。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invokedDirectly) {
  main().then((c) => { process.exitCode = c; }).catch((err) => { console.error(`reextract-subjects 失败：${String(err?.message ?? err)}`); process.exitCode = 2; });
}

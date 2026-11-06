#!/usr/bin/env node
// T311 · 抽取时机械抓"恢复条件"（F3：这条在什么情况下不再成立）
//
// 背景（T310）：1105 条 antipattern **实质失效条件覆盖 0%** —— R09 抽取层根本不产出 F3 信息，
// 回填字段解决不了（回填 = 拿现在的库编过去）。F3 只能在**抽取那一刻**从原始事件里抓。
//
// 判据（全部机械，无源不入）：
//   对每条失败（`Error:` 起头 / 非零 `[exit code: N]`），在**同一局的后续事件**里找"该错误消失的证据"：
//     ① 同类命令成功（同一工具 + `[exit code: 0]`）
//     ② 测试通过（`ℹ tests N ℹ pass N ℹ fail 0` 等，复用 T251 的 isTestPassSummary）
//     ③ 构建/工作区干净（`Build succeeded` / `compiled successfully` / `nothing to commit, working tree clean`）
//   抓到 ⇒ `falsifiableWhen: { seq, quote, kind }`（**必须带 seq + 逐字引文**）
//   抓不到 ⇒ `state: "unverified"`（**不许为了覆盖率编**）
//
// 只读：不写库；`--apply` 只允许打 `tmp/` 副本（本脚本目前不写盘，`--apply` 仅保留给未来）。
//
// 用法：
//   node scripts/extract-recovery.mjs                 # 真库抽样（默认前 80 局有 claim 的）
//   node scripts/extract-recovery.mjs --json
//   node scripts/extract-recovery.mjs --limit 20 --evidence evidence/T311-extract-recovery.md

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { readFrames, parseEvents } from '../src/rooms/logread.mjs';
import { isTestPassSummary } from '../src/rooms/extract.mjs';
import { classifyFailureText } from './subagent-merge.mjs';

const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
const MAX_QUOTE = 200;

/** 从事件里取全部字符串（不用 JSON.stringify，避免转义假阴）。 */
export function collectStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out); return out; }
  if (typeof value === 'object') { for (const v of Object.values(value)) collectStrings(v, out); }
  return out;
}

/** 事件 → 归一化文本（多段用换行拼接）。 */
export const eventText = (ev) => collectStrings(ev?.data ?? ev ?? {}).join('\n').trim();

/** 工具名：`bash(command=…)` / `write(file_path=…)` 的前缀。 */
export function toolNameOf(text) {
  const m = /^\s*([A-Za-z][\w-]{0,30})\(/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/** 恢复信号的机械判据。 */
export const RECOVERY_KINDS = Object.freeze(['same-subject-exit-0']);

/**
 * 这段文本是不是"错误已消失"的证据。
 * @returns {{kind:string}|null}
 */
export function recoverySignalOf(text) {
  const t = String(text ?? '');
  if (!t.trim()) return null;
  if (isTestPassSummary(t)) return { kind: 'tests-pass' };
  if (/\bBuild succeeded\b|\bcompiled successfully\b|\bbuild: ok\b/i.test(t)) return { kind: 'build-success' };
  if (/nothing to commit,? working tree clean|working tree clean/i.test(t)) return { kind: 'git-clean' };
  return null;
}

/**
 * **行级**失败定位（T311b）：只在"该行本身是失败输出"时才算失败。
 * 认两种情况：
 *   ① 行首错误原文：`Error:` / `error:` / `XxxError:` / `Exception:`（且该行不太长，排除把提示词整段当一行）
 *   ② 独占一行的非零退出码：`[exit code: 1]` / `exit code: 2`
 * **不算**：行中间出现 Error 字样（系统提示词、别人的报错、日志正文）。
 */
export function failureLineOf(text) {
  for (const raw of String(text ?? '').split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    const m = /^\[?exit code:?\s*(-?\d+)\]?$/i.exec(t);
    if (m && Number(m[1]) !== 0) return { line: t, reason: `exit:${m[1]}` };
    if (/^(?:[A-Za-z_]*Error|Exception)\s*:/.test(t) && t.length <= 400) return { line: t, reason: 'error-line' };
  }
  return null;
}

/** 该事件是不是一次失败的失败原文（**只回该行**，不回整段）。 */
export function failureOf(ev) {
  const text = eventText(ev);
  if (!text) return null;
  const hit = failureLineOf(text);
  if (!hit) return null;
  return { seq: Number(ev?.seq), quote: hit.line.slice(0, MAX_QUOTE), reason: hit.reason, tool: toolNameOf(text) };
}

/** 从失败原文里取"主体"（第一个像路径的 token）：恢复事件必须**提到同一个东西**才算数。 */
export function subjectOf(text) {
  const m = /(?:[A-Za-z]:)?[/\\][\w./\\-]{3,}\.\w{1,6}|[\w.-]+\.(?:m?js|cjs|ts|tsx|json|md|ya?ml|go|py)/.exec(String(text ?? ''));
  return m ? m[0] : null;
}

export function findRecovery(events, fromIndex, { subject = null } = {}) {
  // T311b：**没有主体就没有恢复** —— 不许"后续 40 条内任意 exit 0"（那是凑数）
  if (!subject) return null;
  for (let i = fromIndex + 1; i < events.length; i += 1) {
    const text = eventText(events[i]);
    if (!text) continue;
    if (!text.includes(subject)) continue;                       // 必须是**同一个文件/同一条命令**
    if (!/\[?exit code:?\s*0\]?/i.test(text)) continue;          // 且这次**成功了**
    return { seq: Number(events[i]?.seq), quote: text.slice(0, MAX_QUOTE), kind: 'same-subject-exit-0' };
  }
  return null;
}

/**
 * T339 · 命令主体恢复（F3 的第二条腿）。
 *
 * 背景（T338 诊断）：F3 恢复覆盖率仅 4.51%，根因是 **86.73% 的失败没有文件路径主体**，
 * `findRecovery` 的「没主体就没恢复」对它们直接放弃；放宽恢复信号实测新增 0（无用）。
 * 正路：无路径失败大多是「某条命令跑挂了」，主体应是**触发它的那条命令**（不是错误文本里的路径）。
 *
 * 关联：`tool/result.data.message.toolCallId` → `tool/call.data.callId`；
 * 命令主体取自 `tool/call.data.name + arguments`（bash 的 `command`、write/edit 的 `file_path`）。
 * 恢复 = 后续**同一命令主体**的执行**没有失败**。保留主体约束（命令即主体，不凑数）。
 * 实测（20 局 / 1575 失败）：文件级 4.51% → 文件级∪命令级 **11.05%**。
 */

/** tool/call → 命令主体签名（机械、可核）。 */
export function commandSubjectOf(call) {
  const name = call?.data?.name;
  if (!name) return null;
  let args = {};
  try { args = JSON.parse(call?.data?.arguments ?? '{}'); } catch { args = {}; }
  if (name === 'bash') {
    const cmd = String(args.command ?? '').replace(/\s+/g, ' ').trim();
    return cmd ? `bash:${cmd}` : null;
  }
  const fp = args.file_path ?? args.path ?? null;
  if (fp) return `${name}:${fp}`;
  const s = JSON.stringify(args).replace(/\s+/g, ' ');
  return `${name}:${s.slice(0, 80)}`;
}

/** 事件 → 命令执行序列 [{subject, seq, index, failed}]。 */
export function commandRuns(events = []) {
  const calls = new Map();
  for (const e of events) if (e?.type === 'tool/call') calls.set(e?.data?.callId, e);
  const runs = [];
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    if (e?.type !== 'tool/result') continue;
    const call = calls.get(e?.data?.message?.toolCallId);
    if (!call) continue;
    const subject = commandSubjectOf(call);
    if (!subject) continue;
    runs.push({ subject, seq: Number(e?.seq), index: i, failed: !!failureLineOf(eventText(e)) });
  }
  return runs;
}

/** 命令级恢复：同主体命令后续有一次成功执行（无失败行）。 */
export function findCommandRecovery(runs, fromRunIndex) {
  const cur = runs[fromRunIndex];
  if (!cur || !cur.failed) return null;
  for (let j = fromRunIndex + 1; j < runs.length; j += 1) {
    if (runs[j].subject === cur.subject && !runs[j].failed) {
      return { seq: runs[j].seq, quote: `同一命令再次执行成功：${cur.subject.slice(0, MAX_QUOTE)}`, kind: 'same-command-success' };
    }
  }
  return null;
}

/**
 * 单局：列出每条失败 + 它的恢复条件（抓不到 ⇒ unverified）。
 * @returns {Array<{seq:number, quote:string, reason:string, falsifiableWhen:object|null, state:'verified'|'unverified'}>}
 */
export function extractRecovery({ events = [] } = {}) {
  // T339：先建命令执行序列（每局一次），失败事件的恢复 = 文件级优先、命令级兜底（并集）。
  const runs = commandRuns(events);
  const runIndexBySeq = new Map(runs.map((r, idx) => [r.seq, idx]));
  const out = [];
  for (let i = 0; i < events.length; i += 1) {
    const f = failureOf(events[i]);
    if (!f) continue;
    let recovery = findRecovery(events, i, { subject: subjectOf(f.quote) });
    if (!recovery) {
      const ri = runIndexBySeq.get(Number(events[i]?.seq));
      if (ri != null) recovery = findCommandRecovery(runs, ri);
    }
    out.push({
      seq: f.seq,
      quote: f.quote,
      reason: f.reason,
      falsifiableWhen: recovery,
      state: recovery ? 'verified' : 'unverified',
    });
  }
  return out;
}

function opt(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

async function main(argv = process.argv.slice(2)) {
  const storeRoot = path.resolve(opt(argv, 'store', path.join(HOME, 'memory-context')));
  const limit = Number.isFinite(Number(opt(argv, 'limit'))) ? Number(opt(argv, 'limit')) : 80;
  if (!fs.existsSync(storeRoot)) { console.error(`没有 store：${storeRoot}`); return 2; }
  const store = createStore({ root: storeRoot });
  const episodes = store.list('episodes').map((x) => x?.record).filter(Boolean);
  const claims = store.list('claims').map((x) => x?.record).filter(Boolean);
  // 只看"被 claim 引用为支撑"的局（F3 只对能进库的失败有意义）
  const referenced = new Set();
  for (const c of claims) for (const s of Array.isArray(c?.support) ? c.support : []) if (s?.episode) referenced.add(s.episode);
  const targets = episodes.filter((e) => referenced.has(e.id) && e?.closure?.logPath).slice(0, limit);

  const rows = [];
  for (const ep of targets) {
    const abs = path.isAbsolute(ep.closure.logPath) ? ep.closure.logPath : path.join(HOME, ep.closure.logPath);
    if (!fs.existsSync(abs)) continue;
    const fr = readFrames(fs.readFileSync(abs));
    const frames = Array.isArray(fr) ? fr : fr?.frames;
    const events = parseEvents(frames ?? [])?.events ?? [];
    for (const item of extractRecovery({ events })) rows.push({ episode: ep.id, ...item });
  }
  const verified = rows.filter((r) => r.state === 'verified').length;
  const stats = { episodes: targets.length, failures: rows.length, verified, unverified: rows.length - verified, rate: rows.length ? verified / rows.length : null };

  if (argv.includes('--json')) console.log(JSON.stringify({ stats, rows }, null, 2));
  else {
    console.log('F3 恢复条件（抽取时机械抓）· 只读');
    console.log(`扫描 ${stats.episodes} 局 · 失败 ${stats.failures} 条 · 抓到恢复条件 ${stats.verified} · unverified ${stats.unverified} · 覆盖率 ${(stats.rate * 100).toFixed(2)}%`);
    for (const r of rows.filter((x) => x.state === 'verified').slice(0, 5)) {
      console.log(`- ${r.episode} seq ${r.seq} → 恢复 @${r.falsifiableWhen.seq}（${r.falsifiableWhen.kind}）`);
    }
  }
  const evidencePath = opt(argv, 'evidence', null);
  if (evidencePath) {
    fs.writeFileSync(path.resolve(evidencePath), renderEvidence({ stats, rows }), 'utf8');
    if (!argv.includes('--json')) console.log(`evidence: ${path.relative(process.cwd(), path.resolve(evidencePath))}`);
  }
  return 0;
}

function renderEvidence({ stats, rows }) {
  const verified = rows.filter((r) => r.state === 'verified');
  const lines = [];
  lines.push('# T311 · 抽取时机械抓"恢复条件"（F3）');
  lines.push('');
  lines.push(`> \`[本] ${new Date().toISOString()}\` · **只读**（不写库）· 未跑全量测试、未重启 DSH。`);
  lines.push('> 判据：只在**同一局的后续事件**里找"错误消失"的证据；抓不到 ⇒ `unverified`（不编）。');
  lines.push('');
  lines.push('## 0 · 一句话');
  lines.push('');
  lines.push(`**${stats.verified} / ${stats.failures} 条失败能机械地找到恢复条件（${(stats.rate * 100).toFixed(2)}%），其余 ${stats.unverified} 条标 \`unverified\`。**`);
  lines.push('');
  lines.push('## 1 · 汇总');
  lines.push('');
  lines.push('```');
  lines.push(`扫描 ${stats.episodes} 局 · 失败 ${stats.failures} 条 · 抓到 ${stats.verified} · unverified ${stats.unverified}`);
  lines.push('```');
  lines.push('');
  lines.push('## 2 · 逐字对照（3 条）');
  lines.push('');
  for (const [i, r] of verified.slice(0, 3).entries()) {
    lines.push(`### ${i + 1}. \`${r.episode}\` seq ${r.seq} → 恢复 @${r.falsifiableWhen.seq}（${r.falsifiableWhen.kind}）`);
    lines.push('');
    lines.push('失败原文：');
    lines.push('```');
    lines.push(r.quote);
    lines.push('```');
    lines.push('恢复事件：');
    lines.push('```');
    lines.push(r.falsifiableWhen.quote);
    lines.push('```');
    lines.push('');
  }
  lines.push('## 3 · unverified 长什么样');
  lines.push('');
  const un = rows.filter((r) => r.state === 'unverified').slice(0, 3);
  for (const r of un) {
    lines.push(`- \`${r.episode}\` seq ${r.seq}：${JSON.stringify(r.quote.slice(0, 80))}`);
  }
  if (!un.length) lines.push('**0 条**（全部抓到恢复条件）。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(`extract-recovery 失败：${String(err?.message ?? err)}`);
    process.exitCode = 2;
  });
}

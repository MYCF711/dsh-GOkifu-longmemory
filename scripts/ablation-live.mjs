#!/usr/bin/env node
// T307 · 真 ablation 实验的"出题 + 记分"骨架（只读真库；不调用模型）
//
// 为什么需要它：T305/T306 证明"按有没有 claim 分组"的观测设计必然有偏
// （claim 只从被抽取过的失败里来）。唯一能回答"记忆有没有用"的是**干预实验**：
//   同一批任务跑两遍：A=注入记忆卡，B=完全不注入（GOKIFU_INJECT=off）。
//
// 本脚本只做两件事（**不跑模型**）：
//   1) `--list`   ：从库里挑出**适合做实验的失败签名**（有 claim 引用、错误原文可复现）
//   2) `--score`  ：读 evidence/ablation-live.jsonl（宿主跑完后追加），算 A/B 复发率 + 配对检验
//   3) `--record` ：把一次实验结果追加进 jsonl（幂等：同 task+variant 覆盖）
//
// 用法：
//   node scripts/ablation-live.mjs --list [--n 20] [--json]
//   node scripts/ablation-live.mjs --record --task T1 --variant A --recurred 0 --run 2026-11-06T14:00Z
//   node scripts/ablation-live.mjs --score [--json]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { readFrames, parseEvents } from '../src/rooms/logread.mjs';
import { failureLineOf, eventText } from './extract-recovery.mjs';
import { anchorFailureIndex } from './antipattern-cost.mjs';
import { errorKeyOf } from '../src/rooms/claim.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const RESULTS = path.join(REPO_ROOT, 'evidence', 'ablation-live.jsonl');

export function defaultHome(env = process.env) {
  return path.resolve(env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || '.', 'DeepSeek Harness', 'home'));
}

export function wilson(hits, n, z = 1.96) {
  if (!n) return { phat: null, lower: null, upper: null, n: 0 };
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { phat: p, lower: Math.max(0, (c - s) / d), upper: Math.min(1, (c + s) / d), n };
}

/** 精确二项（McNemar 的 discordant 对）。 */
export function mcnemarExact(b, c) {
  const n = b + c;
  if (!n) return 1;
  const choose = (a, k) => { let r = 1; for (let i = 1; i <= k; i += 1) r = (r * (a - k + i)) / i; return r; };
  const pmf = (k) => choose(n, k) * 0.5 ** n;
  const obs = pmf(Math.min(b, c));
  let total = 0;
  for (let k = 0; k <= n; k += 1) if (pmf(k) <= obs + 1e-12) total += pmf(k);
  return Math.min(1, total);
}

/** 复发签名：路径归一后的错误文本（复用 R09 的 `errorKeyOf`），供机械判分。 */
export function signatureOf(text) {
  return errorKeyOf(String(text ?? ''));
}

/**
 * 出题用的工具参数里，哪一个是"这次动作在做什么"。
 * 顺序 = 从最具体到最泛；`job_id` 单独认（`job_output` 这类工具只有它）。
 */
function actionDetailOf(args) {
  const a = args && typeof args === 'object' ? args : {};
  const pick = a.command ?? a.file_path ?? a.path ?? null;
  if (pick != null && String(pick).trim() !== '') return String(pick);
  const job = a.job_id ?? a.jobId ?? null;
  if (job != null && String(job).trim() !== '') return String(job);
  const q = a.query ?? a.pattern ?? a.text ?? null;
  if (q != null && String(q).trim() !== '') return String(q);
  return '';
}

/** 锚点事件附近（±window）出现过的 toolCallId，按离锚点的距离由近到远。 */
function linkedCallIds(events, anchor, window = 3) {
  const ids = [];
  const push = (id) => { if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id); };
  const order = [0];
  for (let d = 1; d <= window; d += 1) { order.push(d); order.push(-d); }
  for (const d of order) {
    const i = anchor + d;
    if (i < 0 || i >= events.length) continue;
    const e = events[i];
    push(e?.data?.message?.toolCallId);
    push(e?.data?.toolCallId);
    const blocks = e?.data?.message?.content;
    if (Array.isArray(blocks)) {
      for (const b of blocks) { push(b?.toolCallId); push(b?.id); }
    }
  }
  return ids;
}

/**
 * 题目提示必须来自**动作**（当时在跑什么），绝不来错误原文。
 *
 * T352：`support.seq` **常指向「提到失败的 assistant 消息」**（T336 实测 96.8%），
 * 直接往上找"最近的前一个 `tool/call`"会取到**与这次失败无关**的那次调用 ——
 * 出出来的题跑下去**不复现**原失败（实测 8 次跑批 A/B 全 0 复发，实验无法判别）。
 * 所以先把 seq **重锚**到真正的失败事件（复用 T336 的 `anchorFailureIndex`，±3），
 * 再按 `toolCallId` 关联到**因果那次** `tool/call`；关联不上才退回"最近的前一个"。
 *
 * 返回 null = 取不到动作 ⇒ 该题不出（**宁缺不泄**）。
 */
export function actionPromptAt(events, seq) {
  const list = Array.isArray(events) ? events : [];
  const idx = list.findIndex((e) => Number(e?.seq) === Number(seq));
  if (idx < 0) return null;
  const anchor = anchorFailureIndex(list, idx, 3);
  let call = null;
  for (const callId of linkedCallIds(list, anchor, 3)) {
    const found = list.find((e) => e?.type === 'tool/call' && e?.data?.callId === callId);
    if (found) { call = found; break; }
  }
  if (!call) {
    for (let i = anchor; i >= 0; i -= 1) {
      if (list[i]?.type !== 'tool/call') continue;
      call = list[i];
      break;
    }
  }
  if (!call) return null;
  const name = call?.data?.name;
  if (!name) return null;
  let args = {};
  try { args = JSON.parse(call?.data?.arguments ?? '{}'); } catch { args = {}; }
  const detail = actionDetailOf(args);
  const text = `${name} ${String(detail).replace(/\s+/g, ' ').trim()}`.trim();
  return text ? text.slice(0, 200) : null;
}

/** 提示里是否泄漏了错误原文（原始子串 30 字 或 归一化签名）。 */
export function leaksAnswer(prompt, errorText) {
  const p = String(prompt ?? '');
  const q = String(errorText ?? '').trim();
  if (!p || !q) return false;
  const head = q.slice(0, 30).toLowerCase();
  if (head && p.toLowerCase().includes(head)) return true;
  const sig = signatureOf(q);
  return Boolean(sig) && signatureOf(p).includes(sig);
}

/**
 * 出题：从库里挑「有 claim 引用、错误原文可复现」的失败签名。
 * **T344 防泄漏**：`taskPrompt` 只取动作；取不到动作或提示里泄漏错误原文 ⇒ `promptSafe:false`，
 * 默认**不出题**（要出必须显式 `allowUnsafe`，且该题不得用于判「记忆有用」）。
 * `signature` 是**判分用**的归一化错误签名，发给模型时必须剥掉。
 */
export function listCandidates({ store, n = 20, allowUnsafe = false, readEvents = null } = {}) {
  const claims = store.list('claims').map((e) => e.record).filter(Boolean);
  const episodes = new Map(store.list('episodes').map((e) => [e?.record?.id, e?.record]).filter(([id]) => typeof id === 'string'));
  const evCache = new Map();
  const loadEvents = (epId) => {
    if (typeof readEvents === 'function') return readEvents(epId);
    if (evCache.has(epId)) return evCache.get(epId);
    let events = [];
    try {
      const logPath = episodes.get(epId)?.closure?.logPath;
      if (logPath) {
        const abs = path.isAbsolute(logPath) ? logPath : path.join(defaultHome(), logPath);
        if (fs.existsSync(abs)) {
          const fr = readFrames(fs.readFileSync(abs));
          const frames = Array.isArray(fr) ? fr : fr?.frames;
          events = parseEvents(frames ?? [])?.events ?? [];
        }
      }
    } catch { events = []; }
    evCache.set(epId, events);
    return events;
  };
  const out = [];
  for (const c of claims) {
    for (const s of Array.isArray(c.support) ? c.support : []) {
      const quote = String(s?.quote ?? '').trim();
      if (quote.length < 20) continue;
      if (!/(error|failed|exception|ENOENT|EACCES|cannot|not found|exit code)/i.test(quote)) continue;
      const episode = String(s?.episode ?? '');
      const taskPrompt = actionPromptAt(loadEvents(episode), s?.seq);
      const promptSafe = Boolean(taskPrompt) && !leaksAnswer(taskPrompt, quote);
      if (!promptSafe && !allowUnsafe) continue;
      out.push({
        taskId: `T-${episode.slice(3, 11)}-${Number(s?.seq) || 0}`,
        episode,
        seq: Number(s?.seq) || 0,
        claimId: String(c.id ?? ''),
        taskPrompt: taskPrompt ?? null,
        promptSafe,
        signature: signatureOf(quote),
        errorText: quote.slice(0, 200),  // 判分用；**不得进提示**
      });
    }
    if (out.length >= n) break;
  }
  // 去重（同 episode+seq 只留一条）
  const seen = new Set();
  return out.filter((x) => { const k = `${x.episode}#${x.seq}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, n);
}

/**
 * T344 · **机械判复发**：给定任务集与一次运行的事件，判每条任务的错误签名是否在该运行里再现。
 * 判据（全机械，零模型）：把运行里所有失败行归一成签名（`errorKeyOf`），与任务 `signature` 求交。
 * 不读 claim 文本、不看提示、不手工填 0/1。
 */
export function judgeRecurrence({ tasks = [], events = [] } = {}) {
  const list = Array.isArray(events) ? events : [];
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const hit = failureLineOf(eventText(list[i]));
    if (!hit) continue;
    const sig = signatureOf(hit.line);
    if (sig) seen.add(sig);
  }
  return (Array.isArray(tasks) ? tasks : []).map((t) => ({
    taskId: String(t?.taskId ?? ''),
    signature: String(t?.signature ?? ''),
    recurred: Boolean(t?.signature) && seen.has(String(t.signature)),
  }));
}

/** 从会话日志读出事件（`--judge --log <path>` 用）。 */
export function eventsFromLog(file) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    const fr = readFrames(fs.readFileSync(file));
    const frames = Array.isArray(fr) ? fr : fr?.frames;
    return parseEvents(frames ?? [])?.events ?? [];
  } catch { return []; }
}

/** 记一次实验（幂等：同 taskId+variant 覆盖）。 */
export function record({ taskId, variant, recurred, run = null, note = '', file = RESULTS } = {}) {
  if (!taskId || !['A', 'B'].includes(variant)) throw new Error('record 需要 taskId + variant(A|B)');
  const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const next = rows.filter((r) => !(r.taskId === taskId && r.variant === variant));
  next.push({ taskId, variant, recurred: Boolean(recurred), run: run ?? new Date().toISOString(), note });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { rows: next.length, file };
}

/** 记分：配对比较 A vs B。 */
export function score({ file = RESULTS } = {}) {
  const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const byTask = new Map();
  for (const r of rows) {
    const o = byTask.get(r.taskId) ?? {};
    o[r.variant] = r.recurred;
    byTask.set(r.taskId, o);
  }
  let both = 0; let onlyA = 0; let onlyB = 0; let neither = 0;
  for (const o of byTask.values()) {
    if (o.A === undefined || o.B === undefined) continue;
    if (o.A && o.B) both += 1; else if (o.A && !o.B) onlyA += 1; else if (!o.A && o.B) onlyB += 1; else neither += 1;
  }
  const paired = both + onlyA + onlyB + neither;
  const aHits = both + onlyA;
  const bHits = both + onlyB;
  const mcnemarP = mcnemarExact(onlyA, onlyB);
  // 判据：B（无记忆）复发更多 ⇒ onlyB > onlyA。
  // T353：方向与显著性是**两件事**，必须分开说 —— 旧版把「方向对但 p ≥ 0.05」写成
  // 「方向相反（A 路更多复发）」，会让样本量不足的正常中间态被误读成"记忆有害"。
  let verdict;
  if (paired === 0) verdict = '无数据';
  else if (onlyA === onlyB) verdict = onlyA === 0 ? '无差别（两臂都没复发）⇒ 记忆没起作用，也可能题不复现失败' : '无差别 ⇒ 记忆没起作用';
  else if (onlyB > onlyA) verdict = mcnemarP < 0.05 ? '**记忆有用**（B 路显著更多复发）' : '方向偏向「记忆有用」，但**未达显著**（样本不足，继续攒）';
  else verdict = mcnemarP < 0.05 ? '**方向相反**（A 路显著更多复发）⇒ 记忆有害，必须先查卡里写了什么' : '方向偏向「记忆有害」，但**未达显著**（样本不足，先别下结论）';
  return {
    tasks: paired,
    A: { recurred: aHits, n: paired, rate: paired ? aHits / paired : null, wilson: wilson(aHits, paired) },
    B: { recurred: bHits, n: paired, rate: paired ? bHits / paired : null, wilson: wilson(bHits, paired) },
    discordant: { onlyA, onlyB },
    mcnemarP,
    verdict,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const home = defaultHome();
  if (argv.includes('--record')) {
    const r = record({ taskId: opt('task'), variant: opt('variant'), recurred: opt('recurred', '0') === '1', run: opt('run', null), note: opt('note', '') });
    console.log(JSON.stringify(r, null, 2));
    return 0;
  }
  if (argv.includes('--score')) {
    const s = score({ file: opt('file', RESULTS) });
    console.log(JSON.stringify(s, null, 2));
    console.log(`\n判定：${s.verdict}`);
    return 0;
  }
  if (argv.includes('--judge')) {
    // T344：机械判复发（取代手工 --recurred），用归一化签名扫一次运行的日志。
    const tasksFile = opt('tasks', null);
    const logFile = opt('log', null);
    if (!tasksFile || !logFile) { console.error('--judge 需要 --tasks <tasks.json> 与 --log <会话日志>'); return 2; }
    const parsed = JSON.parse(fs.readFileSync(path.resolve(tasksFile), 'utf8'));
    const tasks = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.tasks) ? parsed.tasks : []);
    const rows = judgeRecurrence({ tasks, events: eventsFromLog(path.resolve(logFile)) });
    const variant = opt('variant', null);
    if (argv.includes('--record')) {
      if (!['A', 'B'].includes(variant)) { console.error('--record 需要 --variant A|B'); return 2; }
      for (const r of rows) record({ taskId: r.taskId, variant, recurred: r.recurred, note: 'judged:signature' });
    }
    console.log(JSON.stringify({ judged: rows.length, recurred: rows.filter((r) => r.recurred).length, tasks: rows }, null, 2));
    return 0;
  }
  const store = createStore({ root: path.resolve(opt('store', path.join(home, 'memory-context'))) });
  const list = listCandidates({ store, n: Number(opt('n', '20')), allowUnsafe: argv.includes('--allow-unsafe') });
  if (argv.includes('--json')) { console.log(JSON.stringify({ n: list.length, tasks: list }, null, 2)); return 0; }
  const unsafe = list.filter((x) => !x.promptSafe).length;
  console.log(`T344 · 真 ablation 出题 · 可用题 ${list.length} 条${unsafe ? `（其中 ${unsafe} 条 promptSafe=false，不得用于判「记忆有用」）` : ''}`);
  console.log('| # | taskId | 动作提示（发给模型） | 判分签名（不许进提示） |');
  console.log('|---|---|---|---|');
  list.forEach((x, i) => console.log(`| ${i + 1} | ${x.taskId} | ${String(x.taskPrompt ?? '（不可用）').slice(0, 70).replace(/\|/g, '\\|')} | ${x.signature.slice(0, 60).replace(/\|/g, '\\|')} |`));
  return 0;
}

if (process.argv[1] && String(process.argv[1]).split(String.fromCharCode(92)).join('/').endsWith('scripts/ablation-live.mjs')) {
  main().then((c) => { process.exitCode = c; }).catch((e) => { console.error(`ablation-live 失败：${String(e?.message ?? e)}`); process.exitCode = 2; });
}

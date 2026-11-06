#!/usr/bin/env node
// T330 · antipattern 的 `cost` 字段（知识库 77 的 T3「付过代价」）
//
// 知识库 77 的五条门票：T1 事实性 · T2 因果链 · **T3 代价** · T4 可复现 · T5 可反驳。
// T3 是"值得记的失败"的第一条（F1：有可计损失）。最便宜的补法：给 errorSnippet 加 `cost` 字段。
//
// **只认机械痕迹**（不许模型判断）：
//   · retry        同一主体（同命令/同文件）连续失败 ≥2 次
//   · rework       失败后对**同一文件**有 write/edit
//   · interruption 失败后 ≤3 条事件就该局结束（用户打断 / 提前收尾）
//   · steps        失败到"恢复"之间隔了多少步（T311 的 findRecovery）
//
// **判不出 ⇒ `cost: 0`**（不是"没有代价"，是"没测到"）。
//
// 用法：node scripts/antipattern-cost.mjs [--json] [--evidence <path>] [--limit N]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { readFrames, parseEvents } from '../src/rooms/logread.mjs';
import { failureLineOf, findRecovery, subjectOf } from './extract-recovery.mjs';

const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/main'.replace('/main', '/home');

/** 事件 → 文本。 */
function eventText(ev) {
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

/** 写盘类工具调用（返工痕迹）。 */
const WRITE_RE = /\b(?:write|edit|apply_patch|multi_edit|str_replace)\s*\(/;

/**
 * T336 · 重锚定：antipattern 的 `support.seq` 常锚在「提到失败的 assistant 消息」，
 * 而真正的失败原文（行首 `Error:` / 独占非零 exit code）在**紧邻的 tool/result · job/settled** 里。
 * 实测（2026-11-06，`tmp/diag-cost3.mjs`）：200 条里 195 条 support 指向的事件抽不出 Error 行，
 * 其中 **151 条真正失败原文就在 ±3 条内**（`none:0`，每局都有）。不重锚 ⇒ `failureLineOf=null`
 * ⇒ `subject=null` ⇒ retry/rework 全跳过 ⇒ **cost 恒 0**（这就是「只有 0.09% 能判出代价」的根因）。
 *
 * 契约：support 指的那条若本身含失败行 ⇒ 不动；否则在 ±window 内取**距离最近**的失败事件，
 * 并列取**靠后**（Error 原文几乎总在 assistant 调用之后）。找不到 ⇒ 返回原 index（cost 仍 0，**不编**）。
 * 只重锚「哪条是真失败」，不改写任何库数据；纯函数、无源不入。
 */
export function anchorFailureIndex(events, index, window = 3) {
  if (!Array.isArray(events) || index < 0 || index >= events.length) return index;
  if (failureLineOf(eventText(events[index]))) return index;
  let best = -1;
  let bestDist = Infinity;
  const lo = Math.max(0, index - window);
  const hi = Math.min(events.length - 1, index + window);
  for (let i = lo; i <= hi; i += 1) {
    if (i === index) continue;
    if (!failureLineOf(eventText(events[i]))) continue;
    const d = Math.abs(i - index);
    // 距离最近优先；并列取靠后（i 大者）
    if (d < bestDist || (d === bestDist && i > best)) { best = i; bestDist = d; }
  }
  return best >= 0 ? best : index;
}

/**
 * 机械判"付过代价"（纯函数）。
 * @returns {{cost:number, kinds:string[], steps:number|null}}
 *   `cost` = 命中的痕迹**种类数**（0 = 没测到，不是"没代价"）
 */
export function costOf({ events = [], index = -1 } = {}) {
  // T336：先把 support.seq 重锚到「真正的失败事件」（±3 内最近的含 Error 行者），再算痕迹。
  index = anchorFailureIndex(events, index);
  if (index < 0 || index >= events.length) return { cost: 0, kinds: [], steps: null };
  const failText = eventText(events[index]);
  const line = failureLineOf(failText);
  // 主体：优先真路径；没有路径就用**错误行前 40 字**当命令签名（同一命令重试也能认）
  const subject = line ? (subjectOf(line.line) ?? line.line.slice(0, 40)) : null;
  const kinds = [];
  let steps = null;

  // ① 重试：下一个同类失败（同一主体）出现在很近的位置
  for (let i = index + 1; i < Math.min(events.length, index + 8); i += 1) {
    const t = eventText(events[i]);
    const l = failureLineOf(t);
    if (!l) continue;
    const s = subjectOf(l.line) ?? l.line.slice(0, 40);
    // 必须是**同一主体**重试（没有主体就没有重试证据 —— 否则任意 8 条窗口里都能凑出一次失败）
    if (subject && s && s === subject) { kinds.push('retry'); break; }
  }

  // ② 返工：失败后对**同一文件**有 write/edit
  if (subject) {
    for (let i = index + 1; i < Math.min(events.length, index + 60); i += 1) {
      const t = eventText(events[i]);
      if (WRITE_RE.test(t) && t.includes(subject)) { kinds.push('rework'); break; }
    }
  }

  // ③ 中断：失败后 ≤3 条事件就结束
  if (events.length - index <= 4) kinds.push('interruption');

  // ④ 时间：失败 → 恢复隔了多少步
  const rec = findRecovery(events, index, { subject });
  if (rec) {
    const recIdx = events.findIndex((e) => Number(e?.seq) === Number(rec.seq));
    if (recIdx > index) steps = recIdx - index;
  }

  return { cost: kinds.length, kinds, steps };
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

  const cache = new Map();
  const rows = [];
  for (const c of anti.slice(0, limit)) {
    const src = Array.isArray(c.support) && c.support[0] ? c.support[0] : {};
    const ep = episodes.get(src.episode) ?? null;
    let events = [];
    if (ep?.closure?.logPath) {
      if (!cache.has(src.episode)) {
        const abs = path.isAbsolute(ep.closure.logPath) ? ep.closure.logPath : path.join(HOME, ep.closure.logPath);
        try {
          const fr = readFrames(fs.readFileSync(abs));
          const frames = Array.isArray(fr) ? fr : fr?.frames;
          cache.set(src.episode, parseEvents(frames ?? [])?.events ?? []);
        } catch { cache.set(src.episode, []); }
      }
      events = cache.get(src.episode) ?? [];
    }
    const index = Number.isFinite(Number(src.seq)) ? events.findIndex((e) => Number(e?.seq) === Number(src.seq)) : -1;
    const res = costOf({ events, index });
    rows.push({ id: c.id, episode: src.episode ?? null, seq: src.seq ?? null, text: String(c.text ?? '').slice(0, 120), ...res });
  }

  const paid = rows.filter((r) => r.cost > 0).length;
  const kinds = {};
  for (const r of rows) for (const k of r.kinds) kinds[k] = (kinds[k] ?? 0) + 1;
  const withSteps = rows.filter((r) => Number.isFinite(r.steps));
  const avgSteps = withSteps.length ? withSteps.reduce((n, r) => n + r.steps, 0) / withSteps.length : null;
  const stats = { antipatterns: anti.length, measured: rows.length, paid, unmeasured: rows.length - paid, rate: rows.length ? paid / rows.length : null, kinds, avgSteps };

  // T332：**预计算索引**（`<store>/corpus/antipattern-cost.json`），供注入侧 O(1) 查。
  // 守卫：只许写到 `tmp/` 或 store 的 `corpus/` 下（不写仓库、不改 claim）。
  if (argv.includes('--write-index')) {
    const target = path.resolve(opt(argv, 'index', path.join(storeRoot, 'corpus', 'antipattern-cost.json')));
    const okTarget = target.includes(`${path.sep}tmp${path.sep}`) || target.includes(`${path.sep}corpus${path.sep}`);
    if (!okTarget) { console.error(`拒绝写：${target}（只许 tmp/ 或 <store>/corpus/）`); return 2; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const costs = {};
    for (const r of rows) costs[r.id] = r.cost;
    fs.writeFileSync(target, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), source: storeRoot, count: rows.length, costs }, null, 2) + String.fromCharCode(10));
    console.error(`已写索引：${target}（${rows.length} 条）`);
  }
  if (argv.includes('--json')) console.log(JSON.stringify({ stats, rows }, null, 2));
  else {
    console.log('antipattern 的 cost（T3 付过代价）· 只读');
    console.log(`antipattern ${stats.antipatterns} · 测到代价 ${stats.paid} · 未测到（cost:0）${stats.unmeasured} · 比例 ${(stats.rate * 100).toFixed(2)}%`);
    console.log(`痕迹分布：${JSON.stringify(stats.kinds)} · 失败→恢复平均 ${stats.avgSteps === null ? 'n/a' : stats.avgSteps.toFixed(1)} 步`);
    for (const r of rows.filter((x) => x.cost > 0).slice(0, 3)) console.log(`+ ${r.id}（${r.episode} seq ${r.seq}）cost=${r.cost} ${r.kinds.join(',')} steps=${r.steps ?? 'n/a'}`);
  }

  const evidencePath = opt(argv, 'evidence', null);
  if (evidencePath) {
    fs.writeFileSync(path.resolve(evidencePath), renderEvidence({ stats, rows }), 'utf8');
    if (!argv.includes('--json')) console.log(`evidence: ${path.relative(process.cwd(), path.resolve(evidencePath))}`);
  }
  return 0;
}

function renderEvidence({ stats, rows }) {
  const paid = rows.filter((r) => r.cost > 0);
  const zero = rows.filter((r) => r.cost === 0);
  const lines = [];
  lines.push('# T330 · antipattern 的 `cost`（T3 付过代价）');
  lines.push('');
  lines.push(`> \`[本] ${new Date().toISOString()}\` · **只读**（不写库）· 未跑全量测试、未重启 DSH。`);
  lines.push('> 只认机械痕迹：retry / rework / interruption / steps。**判不出 ⇒ `cost: 0`（没测到，不是没代价）**。');
  lines.push('');
  lines.push('## 0 · 一句话');
  lines.push('');
  lines.push(`**${stats.paid} / ${stats.measured} 条能机械判出"付过代价"（${(stats.rate * 100).toFixed(2)}%）**；`
    + `其余 ${stats.unmeasured} 条 \`cost: 0\`（没测到代价）。`);
  lines.push('');
  lines.push('## 1 · 汇总');
  lines.push('');
  lines.push('```');
  lines.push(`antipattern ${stats.antipatterns} · 测到代价 ${stats.paid} · cost:0 ${stats.unmeasured}`);
  lines.push(`痕迹分布：${JSON.stringify(stats.kinds)}`);
  lines.push(`失败→恢复平均 ${stats.avgSteps === null ? 'n/a' : stats.avgSteps.toFixed(1)} 步`);
  lines.push('```');
  lines.push('');
  lines.push('## 2 · 逐字对照（3 条）');
  lines.push('');
  for (const [i, r] of paid.slice(0, 3).entries()) {
    lines.push(`### ${i + 1}. \`${r.id}\`（${r.episode} seq ${r.seq}）cost=${r.cost} · ${r.kinds.join(',')} · steps=${r.steps ?? 'n/a'}`);
    lines.push('');
    lines.push('```');
    lines.push(r.text);
    lines.push('```');
    lines.push('');
  }
  if (!paid.length) lines.push('**0 条**。');
  lines.push('');
  lines.push('## 3 · cost:0 的样本（前 5，没测到代价）');
  lines.push('');
  for (const r of zero.slice(0, 5)) lines.push(`- \`${r.id}\` ${JSON.stringify(r.text.slice(0, 80))}`);
  if (!zero.length) lines.push('**0 条**。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invokedDirectly) {
  main().then((c) => { process.exitCode = c; }).catch((err) => { console.error(`antipattern-cost 失败：${String(err?.message ?? err)}`); process.exitCode = 2; });
}

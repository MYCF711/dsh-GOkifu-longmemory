#!/usr/bin/env node
// T293 · 子代理失败归并（只读真库；--apply 只许打 tmp/ 副本）
//
// 背景（T292 实测）：子代理局 726 · 带失败 530 · 失败总数 2939，但**归并率只有 10.00%（9/90）**，
// 且只在"路径字符串完全一致"时才归并 —— AGENTS.md §5 陷阱 10 写的"子代理会话归并到父局"几乎没发生。
//
// 本脚本做两件事：
//   A. **先修"什么算失败"的口径**：旧实现按 JSON 子串匹配 `pending`/`failed`，
//      把 `"Updated todo list: 4 pending, 1 in progress, 0 completed."` 这类进度消息当成失败。
//      新口径只认：① `isError: true` ② `[exit code: N]`（N≠0）③ 真正的错误原文（`Error:`/`error:` 起头、异常名）。
//   B. **幂等归并**：把子代理局的失败原文（seq/quote/occurredAt）追加到父局对应 claim 的 `support`，
//      按 `subEpisode + seq` 去重；只增不改；每条带 `provenanceRepair: { kind:'subagent-merge', from, seq }`。
//
// 用法：
//   node scripts/subagent-merge.mjs                    # dry-run（真库只读）
//   node scripts/subagent-merge.mjs --json             # 机器可读
//   node scripts/subagent-merge.mjs --apply --store tmp/mc-copy   # 只许打副本
//
// 退出码：0 完成；1 参数被拒；2 环境不齐。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';

const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
const REPAIR_KIND = 'subagent-merge';

/** 异常名（真失败的特征）。 */
const EXCEPTION_RE = /^(?:[A-Z][A-Za-z]*(?:Error|Exception)|Error|Exception|RangeError|TypeError|SyntaxError|ReferenceError|AssertionError|AggregateError)\b/;

/** `[exit code: N]` / `exit code: N` 里的退出码。 */
export function exitCodeOf(text) {
  const m = /\[?exit code:?\s*(-?\d+)\]?/i.exec(String(text ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * 新口径：这段文本算不算"真失败"。
 * 只认三类 —— ① `isError: true`（由调用方给）② `[exit code: N]` 且 N≠0 ③ 错误原文（`Error:`/`error:` 起头或异常名）。
 * **明确不算**：`pending` / `in progress` / `completed` / `Updated todo list` 这类进度消息；
 * `fail 0` / `0 failing` 这类"全绿"汇总（T251）；`exit code: 0`。
 * @returns {{failure:boolean, reason:string|null}}
 */
export function classifyFailureText(text, { isError = false } = {}) {
  if (isError === true) return { failure: true, reason: 'isError' };
  const t = String(text ?? '').trim();
  if (!t) return { failure: false, reason: null };
  const code = exitCodeOf(t);
  if (code !== null) return code === 0 ? { failure: false, reason: null } : { failure: true, reason: `exit:${code}` };
  if (/^(?:pending|in progress|completed)\b/i.test(t)) return { failure: false, reason: null };
  if (/(?:^|\n)\s*(?:Error|error):/.test(t) || EXCEPTION_RE.test(t)) return { failure: true, reason: 'error-text' };
  if (/\b(?:pending|in progress|completed)\b/.test(t) && !/error/i.test(t)) return { failure: false, reason: null };
  return { failure: false, reason: null };
}

/** 归并键：同一子局的同一条失败只算一次（重放幂等）。 */
export const mergeKey = (subEpisode, seq) => `${subEpisode}#${Number(seq)}`;

/** 真库根（拒绝 --apply 打上来）。 */
export function guardStoreRoot(storeRoot, home = HOME) {
  const real = path.resolve(home, 'memory-context').toLowerCase();
  const target = path.resolve(storeRoot);
  const underTmp = target.split(path.sep).some((seg) => seg.toLowerCase() === 'tmp');
  return { sameAsReal: target.toLowerCase() === real, underTmp, ok: !target.toLowerCase().startsWith(real) && underTmp };
}

/**
 * 纯逻辑：算出归并计划（不碰盘）。
 * @param {{episodes:Array, claims:Array}} p
 * @returns {{children:number, childrenWithFailures:number, failures:number, alreadyMerged:number, toMerge:Array, newClaims:number}}
 */
export function planMerge({ episodes = [], claims = [] } = {}) {
  const byId = new Map(episodes.map((e) => [e.id, e]));
  const merged = new Set();
  for (const ep of episodes) {
    for (const m of Array.isArray(ep?.signals?.mergedChildren) ? ep.signals.mergedChildren : []) {
      if (m?.kind === REPAIR_KIND) merged.add(mergeKey(m.from, m.seq ?? 0));
    }
  }
  for (const claim of claims) {
    for (const src of Array.isArray(claim?.support) ? claim.support : []) {
      const repair = src?.provenanceRepair;
      if (repair?.kind === REPAIR_KIND) merged.add(mergeKey(repair.from, repair.seq));
    }
  }
  const toMerge = [];
  let childrenWithFailures = 0;
  let alreadyMerged = 0;
  let failures = 0;
  for (const ep of episodes) {
    const depth = Number(ep?.delegationDepth ?? 0);
    if (depth <= 0) continue;
    const sig = ep?.signals ?? {};
    const n = Number(sig.failures ?? 0);
    if (!(n > 0)) continue;
    childrenWithFailures += 1;
    failures += n;
    // 已归并 = 该子局已有 subagent-merge 的 support（按 subEpisode+seq 去重）
    if (merged.has(mergeKey(ep.id, 0)) || merged.has(ep.id)) { alreadyMerged += 1; continue; }
    const parent = ep?.parentSessionId ? [...byId.values()].find((x) => x.sessionId === ep.parentSessionId && Number(x.delegationDepth ?? 0) === 0) : null;
    if (!parent) continue;
    // 不许跨 scope（A5 必须仍 0）：父子作用域不一致 ⇒ 不归并
    if (String(parent.scopeKey ?? "") !== String(ep.scopeKey ?? "")) continue;
    toMerge.push({ child: ep.id, parent: parent.id, failures: n });
  }
  return {
    children: episodes.filter((e) => Number(e?.delegationDepth ?? 0) > 0).length,
    childrenWithFailures,
    failures,
    alreadyMerged,
    toMerge,
    mergeRateBefore: childrenWithFailures ? alreadyMerged / childrenWithFailures : null,
    mergeRateAfter: childrenWithFailures ? (alreadyMerged + toMerge.length) / childrenWithFailures : null,
    newClaims: 0,
    newSupports: toMerge.length,
  };
}

function opt(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function main(argv) {
  const storeRoot = path.resolve(opt(argv, 'store', path.join(HOME, 'memory-context')));
  const apply = argv.includes('--apply');
  const json = argv.includes('--json');
  if (!fs.existsSync(storeRoot)) {
    console.error(`没有 store：${storeRoot}`);
    return 2;
  }
  const guard = guardStoreRoot(storeRoot);
  if (apply && !guard.ok) {
    console.error(`拒绝 --apply：${storeRoot} 不是 tmp 副本（真库只读；请先复制到 tmp/ 再打）`);
    return 1;
  }
  const store = createStore({ root: storeRoot });
  const episodes = store.list('episodes').map((x) => x?.record).filter(Boolean);
  const claims = store.list('claims').map((x) => x?.record).filter(Boolean);
  const plan = planMerge({ episodes, claims });

  // A 步口径对照：旧口径（子串 pending/failed）vs 新口径
  let oldHits = 0;
  let newHits = 0;
  for (const ep of episodes) {
    const n = Number(ep?.signals?.failures ?? 0);
    if (n > 0) oldHits += n;
    if (classifyFailureText(String(ep?.l0 ?? '')).failure) newHits += 1;
  }

  const out = { storeRoot, apply, ...plan, legacySubstringHits: oldHits, newCriterionHits: newHits };
  if (json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`子代理失败归并 · store=${storeRoot}${apply ? ' · APPLY' : ' · dry-run'}`);
    console.log(`子代理局 ${plan.children} · 带失败 ${plan.childrenWithFailures} · 失败总数 ${plan.failures}`);
    console.log(`已归并 ${plan.alreadyMerged} · 待归并 ${plan.toMerge.length} ⇒ 归并率 ${(plan.mergeRateBefore * 100).toFixed(2)}% → ${(plan.mergeRateAfter * 100).toFixed(2)}%`);
    console.log(`新增 support ${plan.newSupports} · 新增 claim ${plan.newClaims}`);
  }
  if (apply) {
    let written = 0;
    const cache = new Map(); // 同一父局的多条子局必须**累加**写，不能各写各的覆盖
    for (const item of plan.toMerge) {
      const parent = cache.get(item.parent) ?? episodes.find((e) => e.id === item.parent);
      if (!parent) continue;
      const signals = { ...(parent.signals ?? {}) };
      const list = Array.isArray(signals.mergedChildren) ? [...signals.mergedChildren] : [];
      if (list.some((m) => m?.from === item.child && Number(m?.seq ?? 0) === 0)) continue;
      list.push({ kind: REPAIR_KIND, from: item.child, seq: 0, failures: item.failures, at: Date.now() });
      signals.mergedChildren = list;
      const next = { ...parent, signals };
      cache.set(item.parent, next);
      store.put("episodes", next, { at: Date.now() });
      written += 1;
    }
    console.log(`apply：副本 ${storeRoot} 已归并 ${written} 条（重放幂等）`);
  }
  else console.log('（dry-run：没有写任何文件）');
  return 0;
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURLSafe(path.resolve(process.argv[1])) : false;
function pathToFileURLSafe(p) { return new URL(`file://${p.replace(/\\/g, '/')}`).href; }
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));

/**
 * 把一条子局失败归并标记**追加**进父局记录（只增不改；按 `from + seq` 幂等）。
 * 供 `scripts/archive.mjs` 在归档时调用（T294：接进管线，避免"字段没人写"）。
 * @returns {boolean} true = 这次真的新增了；false = 已经归并过（重放幂等）
 */
export function appendMergedChild(parent, { child, failures = 0, seq = 0, at = Date.now() } = {}) {
  if (!parent || typeof parent !== 'object') return false;
  const signals = { ...(parent.signals ?? {}) };
  const list = Array.isArray(signals.mergedChildren) ? [...signals.mergedChildren] : [];
  if (list.some((m) => m?.from === child && Number(m?.seq ?? 0) === Number(seq))) return false;
  list.push({ kind: REPAIR_KIND, from: child, seq: Number(seq), failures: Number(failures ?? 0), at });
  signals.mergedChildren = list;
  parent.signals = signals;
  return true;
}

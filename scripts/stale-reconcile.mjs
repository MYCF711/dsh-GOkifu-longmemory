#!/usr/bin/env node
// T203 · 真 stale 的**对账**（只读）：audit-12 的 29 vs T201 的 0，到底谁对。
//
// 背景（2026-11-05）：
//   · audit-12（reports/audit-12.md）用 `runValidityCheck({records:{claims}, dshHome})` 复算：
//       140 条带 validity ⇒ failed 29（file-appeared 20 + version-mismatch 9）。
//   · T201 的写执行包 `scripts/apply-store-changes.mjs` 的 `findStaleTargets` 报 0。
//   两边不可能都对。本脚本把**两种口径并列实现**，在同一份真库上跑，输出差集与逐条原因。
//
// 三种口径（本脚本全部实现，便于定责）：
//   A  · audit-12 口径：`runValidityCheck`（每条按自己的 scopeKey 推 workspace，逐条 ok/unverified）
//   B0 · T201 **现状**：`findStaleTargets`（写执行包真正在用的那段）
//   B1 · T201 **意图**：`classifyClaim(...).action === 'mark'`（mark-stale 的契约）
//
// 纪律：只读（list/get + stat/读 package.json）；不写库、不改 claim；零模型调用。

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';
import { runValidityCheck, workspaceOf, probeValidity } from '../src/rooms/gates.mjs';
import { classifyClaim, resolveProbe } from './mark-stale.mjs';
import { findStaleTargets } from './apply-store-changes.mjs';

export const RECONCILE_VERSION = 1;
/** 真 stale 的理由（与 mark-stale 的 REAL_STALE_REASONS 同口径：只有这两类算"真失效"）。 */
export const REAL_STALE_REASONS = Object.freeze(['file-appeared', 'version-mismatch']);

const idOf = (x) => (x && typeof x.id === 'string' ? x.id : null);

function defaultHome() {
  return process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');
}

/**
 * 口径 A（audit-12）：`runValidityCheck` 的 failed 且**不是** unverified。
 * 逐条保留 probe 结果，外加 claim 自己的 workspace（`workspaceOf` 推出来的那个）。
 */
export function pickStaleByAudit({ claims = [], now = Date.now(), dshHome = null, probe = null, workspace = null } = {}) {
  const check = runValidityCheck({ records: { claims, joseki: [] }, workspace, now, dshHome, probe });
  const rows = [];
  for (const record of claims) {
    const key = record?.id ? `claims:${record.id}` : '';
    const result = key ? check.results[key] : null;
    if (!result) continue;
    if (result.ok !== false || result.unverified === true) continue;
    rows.push({
      id: record.id,
      reason: result.reason ?? 'unknown',
      type: result.type ?? record?.validity?.type ?? null,
      value: record?.validity?.value ?? null,
      scopeKey: record?.scopeKey ?? null,
      workspace: workspaceOf(record, workspace),
      path: result.path ?? null,
      expected: result.expected ?? null,
      actual: result.actual ?? null,
    });
  }
  return { ids: rows.map((r) => r.id), rows, summary: check.summary };
}

/**
 * 口径 B（T201）：`classifyClaim` 的契约是 `{action:'mark'|'skip', reason, detail, why}`。
 * B1 = 按契约取 `action === 'mark'`（**T201 的意图**）。
 */
export function pickStaleByT201({ claims = [], probe, dshHome = null, workspace = null } = {}) {
  const rows = [];
  const skips = {};
  const skipsById = {};
  for (const record of claims) {
    const verdict = classifyClaim(record, { probe, workspace, dshHome });
    if (verdict?.action === 'mark') {
      rows.push({
        id: record.id,
        reason: verdict.reason ?? null,
        type: record?.validity?.type ?? null,
        value: record?.validity?.value ?? null,
        detail: verdict.detail ?? null,
      });
    } else {
      const key = verdict?.reason ?? 'unknown';
      skips[key] = (skips[key] ?? 0) + 1;
      if (record?.id) skipsById[record.id] = key;
    }
  }
  return { ids: rows.map((r) => r.id), rows, skips, skipsById };
}

/**
 * 口径 B0（T201 **现状**）：直接调写执行包里的 `findStaleTargets`。
 * 它内部用 `verdict.ok !== false` 过滤 —— 而 `classifyClaim` 从不返回 `ok`。
 * 这里不判对错，只如实跑一遍：返回它的 targets（通常 0 条）。
 */
export function pickStaleByShippedScan({ store, now = Date.now(), dshHome = null, workspace = null } = {}) {
  const res = findStaleTargets({ store, now, deps: { dshHome, workspace } });
  return {
    ids: res.targets.map((t) => t.id),
    rows: res.targets.map((t) => ({ id: t.id, reason: t.reason ?? null })),
    scanned: res.scanned,
    already: res.already,
    unjudgeable: res.unjudgeable,
  };
}

/** 三个集合的差集（A 为基准）。 */
export function diffStaleSets(a = [], b = []) {
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    onlyA: [...setA].filter((id) => !setB.has(id)).sort(),
    onlyB: [...setB].filter((id) => !setA.has(id)).sort(),
    both: [...setA].filter((id) => setB.has(id)).sort(),
  };
}

/**
 * 逐条解释"为什么这条在 A 里、不在 B 里"。
 * 机械、不留白：每一类都对应一个可复核的事实。
 */
export function explainDifference({ id, inA, inB0, inB1, b1Detail = null } = {}) {
  if (inA && !inB0 && inB1) {
    return {
      code: 't201-ok-field',
      why: 'T201 现状扫描用 `verdict.ok !== false` 过滤，而 classifyClaim 返回的是 {action,reason,detail}（没有 ok 字段）⇒ 永远 continue；B1（按 action 判）能看到它',
    };
  }
  if (inA && !inB1) {
    const reason = b1Detail?.reason ?? 'unknown';
    return {
      code: `b1-skip:${reason}`,
      why: reason === 'posix-ambiguous'
        ? '路径是 POSIX 方言（/tmp/x）：mark-stale 明确不标（读侧会解析到盘根，可能命中同名无关文件）'
        : reason === 'unverified'
          ? '探针读不到包/文件 ⇒ 核不了 ≠ 失效（不标）'
          : reason === 'already-inactive'
            ? 'state 已是 invalidated/superseded ⇒ 不再主张断言（不标）'
            : `B1 跳过：${reason}`,
    };
  }
  if (!inA && inB1) {
    return { code: 'b1-only', why: 'B1 认为该标，但 runValidityCheck 口径下不算真 stale（探针口径不同）' };
  }
  if (!inA && !inB0 && !inB1) return { code: 'neither', why: '两边都不算 stale' };
  return { code: 'both', why: '两边一致' };
}

/**
 * 回归守卫：`classifyClaim` 的返回值带 `action`、**没有** `ok`。
 * T201 的 `findStaleTargets` 却用 `verdict.ok !== false` 过滤 ⇒ 每条都被跳过（真 stale 恒为 0）。
 * 传一个 classifyClaim 的返回值，认出这种形状就返回 `'t201-ok-field'`。
 */
export function classifyDiffGuard(verdict) {
  if (!verdict || typeof verdict !== 'object') return null;
  if (verdict.ok === undefined && typeof verdict.action === 'string') return 't201-ok-field';
  return null;
}

/** 一次对账：A / B0 / B1 全跑，返回差集与逐条原因。 */
export function reconcile({ store, now = Date.now(), dshHome = null, probe = null, io = null, claims = null } = {}) {
  const list = Array.isArray(claims) ? claims : store.list('claims').map((e) => e.record).filter(Boolean);
  const claimsFromStore = Array.isArray(claims) ? claims : list;
  const chosen = probe ?? resolveProbe({ probeValidity }).probe;
  const probeFn = chosen;
  const workspace = process.cwd();
  const a = pickStaleByAudit({ claims: claimsFromStore, now, dshHome, probe: io });
  const b1 = pickStaleByT201({ claims: claimsFromStore, probe: probeFn, dshHome, workspace });
  const b0 = pickStaleByShippedScan({ store, now, dshHome, workspace });
  const dAB0 = diffStaleSets(a.ids, b0.ids);
  const dAB1 = diffStaleSets(a.ids, b1.ids);
  const b1ById = new Map(b1.rows.map((r) => [r.id, r]));
  const b1Set = new Set(b1.ids);
  const b0Set = new Set(b0.ids);
  const aById = new Map(a.rows.map((r) => [r.id, r]));
  const differences = a.ids.map((id) => ({
    id,
    a: aById.get(id) ?? null,
    b1: b1ById.get(id) ?? null,
    ...explainDifference({ id, inA: true, inB0: b0Set.has(id), inB1: b1Set.has(id), b1Detail: b1ById.get(id) ?? { reason: b1.skipsById?.[id] ?? 'unknown' } }),
  }));
  return {
    at: now,
    claims: claimsFromStore.length,
    a: { n: a.ids.length, ids: a.ids.slice().sort(), byReason: countBy(a.rows, (r) => r.reason) },
    b0: { n: b0.ids.length, ids: b0.ids.slice().sort(), scanned: b0.scanned, already: b0.already, unjudgeable: b0.unjudgeable },
    b1: { n: b1.ids.length, ids: b1.ids.slice().sort(), byReason: countBy(b1.rows, (r) => r.reason), skips: b1.skips, skipsById: b1.skipsById },
    diff: { aVsB0: dAB0, aVsB1: dAB1 },
    differences,
    verdict: a.ids.length === b0.ids.length && dAB0.onlyA.length === 0
      ? 'A 与 B0 一致'
      : (b0.ids.length === 0 && b1.ids.length > 0 ? `A=${a.ids.length} / B0=${b0.ids.length} / B1=${b1.ids.length} ⇒ T201 的扫描有缺陷` : '需人工裁决'),
  };
}

export function countBy(list, keyOf) {
  const out = {};
  for (const item of list) {
    const k = String(keyOf(item));
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

const pct = (x) => `${(x * 100).toFixed(2)}%`;

export function formatReport(r) {
  const lines = [];
  lines.push(`真 stale 对账（只读）· claims ${r.claims} · ${new Date(r.at).toISOString()}`);
  lines.push('');
  lines.push(`A（audit-12 · runValidityCheck 逐条 scopeKey）：${r.a.n} 条 ${JSON.stringify(r.a.byReason)}`);
  lines.push(`B0（T201 现状 · findStaleTargets）：${r.b0.n} 条（扫描 ${r.b0.scanned} · 已标 ${r.b0.already} · 判不了 ${r.b0.unjudgeable}）`);
  lines.push(`B1（T201 意图 · classifyClaim.action==='mark'）：${r.b1.n} 条 ${JSON.stringify(r.b1.byReason)} · 跳过 ${JSON.stringify(r.b1.skips)}`);
  lines.push('');
  lines.push(`差集 A vs B0：只在 A ${r.diff.aVsB0.onlyA.length} · 只在 B0 ${r.diff.aVsB0.onlyB.length} · 都在 ${r.diff.aVsB0.both.length}`);
  lines.push(`差集 A vs B1：只在 A ${r.diff.aVsB1.onlyA.length} · 只在 B1 ${r.diff.aVsB1.onlyB.length} · 都在 ${r.diff.aVsB1.both.length}`);
  if (r.differences.length) {
    lines.push('');
    lines.push('只在 A 的逐条原因：');
    for (const d of r.differences) {
      lines.push(`- ${d.id} · ${d.code} · ${d.a?.type}/${d.a?.reason} · ${String(d.a?.value).slice(0, 48)}`);
      lines.push(`    ${d.why}`);
    }
  }
  lines.push('');
  lines.push(`裁决：${r.verdict}`);
  return lines.join('\n');
}

export function toMarkdown(r) {
  const rows = r.differences.map((d) => `| \`${d.id}\` | ${d.a?.type}/${d.a?.reason} | \`${String(d.a?.value ?? '').slice(0, 44)}\` | ${d.code} |`).join('\n');
  return [
    `| claimId | 口径 A 结论 | validity | 为什么 B0 没有 |`,
    `|---|---|---|---|`,
    rows || '| （无差异） | | | |',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const home = defaultHome();
  const storeRoot = path.resolve(opt('store', path.join(home, 'memory-context')));
  const store = createStore({ root: storeRoot });
  const r = reconcile({ store, now: Date.now(), dshHome: home });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
  if (argv.includes('--markdown')) { console.log(toMarkdown(r)); return 0; }
  console.log(formatReport(r));
  return 0;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invoked) {
  main().then((code) => process.exit(code)).catch((error) => { console.error(`对账失败：${String(error?.message ?? error)}`); process.exit(2); });
}

export { pct };

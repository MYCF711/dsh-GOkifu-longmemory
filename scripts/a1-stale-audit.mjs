#!/usr/bin/env node
// T205 · A1 归因（只读）：把"到达模型的 103 条"逐条列出，并给每条一个**机械**分类。
//
// 背景（自包含）：
//   `metrics-guard` 的 A1 = `postGateStaleRate = 3/103`（2.91%）—— 闸 3 之后仍有 3 条 stale 到达模型。
//   本脚本**复刻** `scripts/eval.mjs` · `runH1` 的主循环（同一套信号集、同一条 walk→card→gate 链），
//   在复刻里把每一条渲染行记下来，然后对"通过闸门的卡片里的行"逐条归因：
//
//   · `probe-gap`        —— 该 claim 没有可核的 validity（type=none/缺失）：探针**根本没检查**
//   · `probe-wrong`      —— 探针查了且判"失效"（ok:false 且**不是** unverified），却仍然到达模型 ⇒ 闸 3 有洞
//   · `probe-unverified` —— 探针读不到（ok:false + unverified）⇒ 被当成"核不了"放行，但 A1 的分子把它算成 stale
//   · `legit`            —— 探针判 ok:true：确实没失效（此时 A1 的分子算错了）
//
// 纪律：只读（store.list/get + stat/读 package.json）；不写库、不改 claim；零模型调用。
// 与 `runH1` 的一致性：脚本会再跑一次真 `runH1`，断言 `postGateInjected / postGateStale` 与复刻结果相同。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';
import { walkFromSignals, createWalkCache } from '../src/rooms/walk.mjs';
import { buildMemoryCard, signalFromText, scopeKeyFromPath } from '../src/rooms/inject.mjs';
import { runGates, runValidityCheck, workspaceOf } from '../src/rooms/gates.mjs';
import { runH1 } from './eval.mjs';

export const AUDIT_VERSION = 1;

/** 分类（机械，不看正文语义）。 */
export function classifyRow({ hasValidity = false, result = null } = {}) {
  if (!hasValidity) return 'probe-gap';
  if (!result || typeof result.ok !== 'boolean') return 'probe-gap';
  if (result.ok === true) return 'legit';
  if (result.unverified === true) return 'probe-unverified';
  return 'probe-wrong';
}

/** 一句话解释"为什么这条漏过了闸 3"。 */
export function whySlipped({ category = null, gate3 = null, result = null } = {}) {
  if (gate3 === 'failed') return '闸 3 判红过 ⇒ 该卡不应进 postGate 集合（若出现说明口径实现不一致）';
  if (category === 'probe-unverified') {
    return `探针读不到（${result?.reason ?? 'unverified'}）⇒ 闸 3 记 unverified、不判红；但 A1 的 staleRows 谓词是 \`ok === false\`，把 unverified 也算进分子`;
  }
  if (category === 'probe-gap') return '该 claim 没有 validity ⇒ 探针不会跑，闸 3 无从判断（无 validity 的断言不进有效期检查）';
  if (category === 'probe-wrong') return `探针判失效（${result?.reason ?? 'ok:false'}）却仍在 gates.ok 的卡里 ⇒ 闸 3 漏判`;
  if (category === 'legit') return '核验通过：这条确实不是 stale（A1 分子算错）';
  return '未分类';
}

/** 把一条渲染行拼成审计记录（纯函数，便于测试）。 */
export function buildAuditRow({ claimId, signalLabel = null, signalKind = null, scope = null, gatesOk = null, gateErrors = [], claim = null, result = null } = {}) {
  const type = typeof claim?.validity?.type === 'string' ? claim.validity.type : 'none';
  const hasValidity = type !== 'none';
  const category = classifyRow({ hasValidity, result });
  const gate3 = !gatesOk ? 'failed' : (result?.unverified === true ? 'unverified' : (result?.ok === false ? 'failed' : 'ok'));
  return {
    claimId,
    signal: signalLabel,
    signalKind,
    scope,
    gatesOk,
    gateErrors: Array.isArray(gateErrors) ? [...new Set(gateErrors)] : [],
    type,
    value: claim?.validity?.value ?? null,
    probeReason: result?.reason ?? null,
    probePath: result?.path ?? null,
    expected: result?.expected ?? null,
    actual: result?.actual ?? null,
    ok: result?.ok ?? null,
    unverified: result?.unverified === true,
    stale: result?.ok === false,
    category,
    gate3,
    why: whySlipped({ category, gate3, result }),
  };
}

export function summarize(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const byCategory = {};
  for (const row of list) byCategory[row.category] = (byCategory[row.category] ?? 0) + 1;
  const stale = list.filter((r) => r.stale);
  const staleByCategory = {};
  for (const row of stale) staleByCategory[row.category] = (staleByCategory[row.category] ?? 0) + 1;
  return {
    injected: list.length,
    stale: stale.length,
    rate: list.length ? stale.length / list.length : null,
    byCategory,
    staleByCategory,
    staleIds: stale.map((r) => r.claimId),
  };
}

/**
 * 复刻 `runH1` 的主循环（只多记逐行明细）。参数默认值与 `runH1` 一致。
 * @returns {{rows:Array, allRows:Array, totals:object, scope:string}}
 */
export function auditA1({ storeRoot, workspace = process.cwd(), now = Date.now(), signals = 36, limit = 5, budgetTokens = 500 } = {}) {
  const store = createStore({ root: storeRoot });
  const read = (kind) => store.list(kind).map((x) => x?.record).filter((r) => r && typeof r === 'object');
  const claims = read('claims');
  const joseki = read('joseki');
  const validity = runValidityCheck({ records: { claims, joseki }, workspace, now });
  const validityByKey = validity.results;

  const topicsAll = read('topics');
  const cache = createWalkCache(store);
  const topics = [...topicsAll].sort((a, b) => ((b.df ?? 0) - (a.df ?? 0)) || String(a.key ?? '').localeCompare(String(b.key ?? '')));
  const topicSignals = [];
  const seen = new Set();
  for (const topic of topics) {
    const key = String(topic.key ?? '');
    if (key.length < 3 || seen.has(key)) continue;
    seen.add(key);
    topicSignals.push(key);
    if (topicSignals.length >= signals) break;
  }
  const scope = scopeKeyFromPath(workspace);
  const signalSpecs = topicSignals.map((key) => ({ kind: 'topic', text: `${key} 相关的问题`, scopeKey: scope, label: key }));
  for (const record of [...claims, ...joseki]) {
    const type = typeof record?.validity?.type === 'string' ? record.validity.type : 'none';
    if (type === 'none') continue;
    const text = typeof record.text === 'string' && record.text.trim() !== '' ? record.text.trim() : (typeof record.title === 'string' ? record.title : '');
    if (!text) continue;
    const recordWorkspace = workspaceOf(record, workspace);
    signalSpecs.push({
      kind: 'validity',
      text,
      scopeKey: recordWorkspace ? `w:${String(recordWorkspace).replace(/\\/g, '/')}` : scope,
      label: record.id ?? '(joseki)',
    });
  }

  const claimById = new Map([...claims, ...joseki].filter((r) => typeof r?.id === 'string').map((r) => [r.id, r]));
  const allRows = [];
  const postGate = new Map();
  for (const spec of signalSpecs) {
    const signal = signalFromText(spec.text, { at: now });
    signal.scopeKey = spec.scopeKey;
    const walk = walkFromSignals({ signal, store, scope: spec.scopeKey, depth: 2, limit, budgetTokens, cache });
    const card = buildMemoryCard({ signal, walkResult: walk, store, scope: spec.scopeKey, now, limit, budgetTokens, cache });
    const gates = runGates({ card, walkResult: walk, store, scope: spec.scopeKey, validityResults: validityByKey, cache });
    const rows = (card.claims ?? []).filter((c) => typeof c.claimId === 'string');
    const errors = (gates.errors ?? []).map((e) => e.code);
    for (const row of rows) {
      const claim = claimById.get(row.claimId) ?? null;
      const result = validityByKey[`claims:${row.claimId}`] ?? validityByKey[row.claimId] ?? null;
      const audit = buildAuditRow({
        claimId: row.claimId,
        signalLabel: spec.label,
        signalKind: spec.kind,
        scope: spec.scopeKey,
        gatesOk: gates.ok,
        gateErrors: errors,
        claim,
        result,
      });
      allRows.push(audit);
      if (gates.ok && !postGate.has(audit.claimId)) postGate.set(audit.claimId, audit);
    }
  }
  const rows = [...postGate.values()];
  return {
    scope,
    totals: {
      signals: signalSpecs.length,
      topicSignals: topicSignals.length,
      validitySignals: signalSpecs.length - topicSignals.length,
      renderedRows: allRows.length,
      postGateInjected: rows.length,
      postGateStale: rows.filter((r) => r.stale).length,
      gateFailures: new Set(allRows.filter((r) => !r.gatesOk).map((r) => r.signal)).size,
    },
    rows,
    allRows,
  };
}

/** 与真 `runH1` 对拍：两边分母/分子必须相同。 */
export async function crossCheck({ storeRoot, workspace = process.cwd(), now = Date.now(), signals = 36 } = {}) {
  const h1 = await runH1({ storeRoot, workspace, now, signals });
  return {
    postGateInjected: h1.postGateInjected,
    postGateStale: h1.postGateStale,
    postGateStaleRate: h1.postGateStaleRate,
    injected: h1.injected,
    staleInjected: h1.staleInjected,
    staleTransferRate: h1.staleTransferRate,
  };
}

export function formatReport(r) {
  const s = summarize(r.rows);
  const lines = [];
  lines.push(`A1 归因（只读）· scope=${r.scope}`);
  lines.push(`信号 ${r.totals.signals}（话题 ${r.totals.topicSignals} + validity 定向 ${r.totals.validitySignals}）· 渲染行 ${r.totals.renderedRows} · 闸后注入 ${r.totals.postGateInjected} 条`);
  lines.push(`A1 = ${s.stale}/${s.injected} = ${(s.rate * 100).toFixed(2)}% · 分类 ${JSON.stringify(s.byCategory)} · 其中 stale ${JSON.stringify(s.staleByCategory)}`);
  lines.push('');
  lines.push('| claimId | 探针 | validity | 探针结论 | 闸3 | 分类 | 为什么漏过 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const row of r.rows) {
    if (!row.stale) continue;
    lines.push(`| \`${row.claimId}\` | ${row.type} | \`${String(row.value ?? '').slice(0, 44)}\` | ${row.probeReason ?? 'ok'} | ${row.gate3} | **${row.category}** | ${row.why} |`);
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');
  const storeRoot = path.resolve(opt('store', path.join(home, 'memory-context')));
  const workspace = path.resolve(opt('workspace', process.cwd()));
  const signals = Number(opt('signals', '36'));
  if (!fs.existsSync(storeRoot)) { console.error(`没有 store：${storeRoot}`); return 2; }
  const r = auditA1({ storeRoot, workspace, signals, now: Number(opt('now', String(Date.now()))) });
  const summary = summarize(r.rows);
  const h1 = await crossCheck({ storeRoot, workspace, signals, now: Date.now() });
  const out = { at: new Date().toISOString(), storeRoot, workspace, totals: r.totals, summary, crossCheck: h1, consistent: h1.postGateInjected === summary.injected && h1.postGateStale === summary.stale, rows: r.rows };
  if (argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return out.consistent ? 0 : 1; }
  console.log(formatReport(r));
  console.log('');
  console.log(`对拍 runH1：postGateInjected=${h1.postGateInjected} · postGateStale=${h1.postGateStale} · 复刻 ${summary.injected}/${summary.stale} ⇒ ${out.consistent ? '一致' : '不一致'}`);
  return out.consistent ? 0 : 1;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invoked) {
  main().then((code) => process.exit(code)).catch((error) => { console.error(`A1 归因失败：${String(error?.message ?? error)}`); process.exit(2); });
}

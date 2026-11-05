#!/usr/bin/env node
// T212 · 合流的**价值主张**测量（只读）
//
// 背景：机制已成立（命中同组 ≥2 成员 ⇒ 100% 折叠省行，见 `evidence/T202-merge-mechanism.md`），
// 但"省行"的量级很小（58 行 / 39 组 × 每卡 5 行）。本脚本回答：
//   **如果它不省行，它到底有什么用？**
//
// 四个价值轴，各自给「假设 → 机械判据 → 真库/影库读数 → 结论」，**不合成一个数**：
//   A · 去重即降 token：折叠后卡片总 token 少多少？重复正文占多少？
//   B · 召回不丢：被折叠的成员，其信息是否仍能从合并行 + 指针逐字追回？（这是"不倒退"判据，不是收益）
//   C · 排序更稳：折叠是否让"同组多成员抢同一个预算位"变成一条，从而给别的组腾位？
//   D · 闸 4 可用性：折叠是否让"同组多行同文"不再被 `gate4/unsuperseded-duplicate` 打回？
//
// 只读：影库/真库都只 `list()/get()`；不写任何库、不改任何文件（`--json` 只打 stdout）。
//
// 用法：
//   node scripts/merge-value-report.mjs --shadow <shadowDir> [--samples 20] [--seed 20261105] [--json]
//
// 退出码：0 报告生成；2 参数/库不存在。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';
import { walkFromSignals, createWalkCache } from '../src/rooms/walk.mjs';
import { buildMemoryCard, estimateTokens, ENTRY_LIMIT, BUDGET_TOKENS } from '../src/rooms/inject.mjs';
import { runGates } from '../src/rooms/gates.mjs';

/** 报告结构版本。 */
export const REPORT_VERSION = 1;
/** 机制臂（观察全部成员）用的大预算；价值轴 A/B 用它，C/D 用线上口径。 */
export const WIDE_LIMIT = 50;
export const WIDE_BUDGET = 100000;
export const DEFAULT_SAMPLES = 20;
export const DEFAULT_SEED = 20261105;

export function parseArgs(argv = []) {
  const flags = { shadow: null, samples: DEFAULT_SAMPLES, seed: DEFAULT_SEED, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--shadow') flags.shadow = argv[++i] ?? null;
    else if (arg === '--samples') flags.samples = Number(argv[++i] ?? DEFAULT_SAMPLES);
    else if (arg === '--seed') flags.seed = Number(argv[++i] ?? DEFAULT_SEED);
    else return { error: `未知参数：${arg}` };
  }
  return flags;
}

/* ── 机械工具（自包含：本文件的依赖面只有 persist/walk/inject/gates）──── */

/** Wilson 95% 区间（与 merge-acceptance 同式；此处独立实现，避免跨脚本耦合）。 */
export function wilsonInterval(successes, n, z = 1.96) {
  const k = Number(successes);
  const total = Number(n);
  if (!Number.isFinite(k) || !Number.isFinite(total) || total <= 0) return { phat: null, lower: null, upper: null, n: 0, z };
  const phat = Math.min(1, Math.max(0, k / total));
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (phat + z2 / (2 * total)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat)) / total + z2 / (4 * total * total))) / denom;
  return { phat, lower: Math.max(0, center - half), upper: Math.min(1, center + half), n: total, z };
}

/** 「折叠前」视图：把带 `merge` 的派生 claim 从 claims 里摘掉，其余 kind 原样透传。 */
export function storeWithoutMergeNodes(store) {
  if (!store || typeof store.list !== 'function') throw new TypeError('storeWithoutMergeNodes: 需要 store');
  const mergeIds = new Set(store.list('claims').filter((r) => r?.record?.merge).map((r) => String(r.id)));
  return {
    ...store,
    list(kind, opts) {
      const rows = store.list(kind, opts);
      if (kind !== 'claims') return rows;
      return rows.filter((r) => !mergeIds.has(String(r.id)));
    },
    ids(kind) {
      const ids = store.ids(kind);
      if (kind !== 'claims') return ids;
      return ids.filter((id) => !mergeIds.has(String(id)));
    },
    get(kind, id) {
      return store.get(kind, id);
    },
  };
}

/** 「同时命中全部成员」的构造信号：每个成员的正文各一条 term。 */
export function buildGroupSignal(members = []) {
  const terms = (Array.isArray(members) ? members : []).map((m) => String(m?.text ?? '').trim()).filter((t) => t !== '');
  return { kind: 'root-message', terms, entities: [] };
}

/** 卡片行的 claim 标识（merge 行 = 合并节点 id）。 */
export function rowIdOf(entry) {
  return String(entry?.claimId ?? entry?.claim ?? '');
}

/** 卡片总 token（按行的正文长度口径，与 R12 的 `estimateTokens` 同源）。 */
export function cardTokens(card) {
  const rows = Array.isArray(card?.claims) ? card.claims : [];
  return rows.reduce((acc, entry) => acc + estimateTokens(String(entry?.text ?? '')), 0);
}

/** 确定性抽样（LCG）。 */
export function sampleDeterministic(pool, n, seed = DEFAULT_SEED) {
  const list = Array.isArray(pool) ? pool : [];
  if (list.length === 0) return [];
  const want = Math.min(Math.max(1, Number.isFinite(n) ? Math.floor(n) : 1), list.length);
  let state = (Number.isFinite(seed) ? Math.floor(seed) : DEFAULT_SEED) >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const picked = [];
  const used = new Set();
  while (picked.length < want) {
    const idx = Math.floor(next() * list.length);
    if (used.has(idx)) continue;
    used.add(idx);
    picked.push(list[idx]);
  }
  return picked;
}

/** 一条合并组：两种口径各两臂的卡片 + 闸结果（四个轴共用同一批观察）。 */
export function collectGroupObservations({ shadow, mergedClaims = [] } = {}) {
  const noFold = storeWithoutMergeNodes(shadow);
  const cacheFold = createWalkCache(shadow);
  const cacheNoFold = createWalkCache(noFold);
  const mergeIds = new Set(mergedClaims.map((m) => String(m.id)));
  const recordsNoFold = { claims: Object.fromEntries(noFold.list('claims').map((r) => [r.id, r.record])) };
  const recordsFold = { claims: Object.fromEntries(shadow.list('claims').map((r) => [r.id, r.record])) };

  const observations = [];
  for (const merged of mergedClaims) {
    const memberIds = Array.isArray(merged?.merge?.members) ? merged.merge.members.map(String) : [];
    const members = memberIds.map((id) => shadow.get('claims', id)).filter(Boolean);
    if (members.length < 2) {
      observations.push({ merged, members, skipped: 'members-unresolved' });
      continue;
    }
    const signal = buildGroupSignal(members);
    const walkResult = walkFromSignals({ signal, store: shadow, scope: merged.scopeKey, depth: 2, limit: WIDE_LIMIT, budgetTokens: WIDE_BUDGET, cache: cacheFold });
    const hits = (Array.isArray(walkResult.hits) ? walkResult.hits : []).filter((h) => !mergeIds.has(String(h?.claim ?? h?.claimId ?? '')));
    const shared = { ...walkResult, hits, hitCount: hits.length };
    const cardOf = (store, cache, limit, budgetTokens) => buildMemoryCard({ cache, signal, walkResult: shared, store, scope: merged.scopeKey, now: 1, limit, budgetTokens });
    const wide = { before: cardOf(noFold, cacheNoFold, WIDE_LIMIT, WIDE_BUDGET), after: cardOf(shadow, cacheFold, WIDE_LIMIT, WIDE_BUDGET) };
    const production = { before: cardOf(noFold, cacheNoFold, ENTRY_LIMIT, BUDGET_TOKENS), after: cardOf(shadow, cacheFold, ENTRY_LIMIT, BUDGET_TOKENS) };
    const gate = (card, records, store) => runGates({ card, records, scope: merged.scopeKey, walkResult: shared });
    observations.push({
      merged,
      members,
      memberIds,
      wide,
      production,
      gates: {
        before: gate(production.before, recordsNoFold, noFold),
        after: gate(production.after, recordsFold, shadow),
      },
    });
  }
  return observations;
}

/* ── 四个轴 ───────────────────────────────────────────────── */

/** A · 去重即降 token：折叠前后卡片 token 差 + 重复正文占比。 */
export function axisTokens(observations = []) {
  let tokensBefore = 0;
  let tokensAfter = 0;
  let charsBefore = 0;
  let charsAfter = 0;
  let memberChars = 0;
  let duplicateChars = 0;
  let groupsSaved = 0;
  const rows = [];
  for (const obs of observations) {
    if (obs.skipped) continue;
    const before = obs.wide.before;
    const after = obs.wide.after;
    const tb = cardTokens(before);
    const ta = cardTokens(after);
    const cb = (before.claims ?? []).reduce((s, e) => s + String(e?.text ?? '').length, 0);
    const ca = (after.claims ?? []).reduce((s, e) => s + String(e?.text ?? '').length, 0);
    const memberSet = new Set(obs.memberIds);
    const memberTexts = (before.claims ?? []).filter((e) => memberSet.has(rowIdOf(e))).map((e) => String(e?.text ?? ''));
    const mChars = memberTexts.reduce((s, t) => s + t.length, 0);
    // 重复正文 = 成员行正文总长 − 最长的那条（其余都是"同一句话的变体"）
    const dup = memberTexts.length > 1 ? mChars - Math.max(...memberTexts.map((t) => t.length)) : 0;
    tokensBefore += tb;
    tokensAfter += ta;
    charsBefore += cb;
    charsAfter += ca;
    memberChars += mChars;
    duplicateChars += dup;
    if (tb - ta > 0) groupsSaved += 1;
    rows.push({ id: obs.merged.id, members: obs.memberIds.length, tokensBefore: tb, tokensAfter: ta, tokensSaved: tb - ta, memberChars: mChars, duplicateChars: dup });
  }
  const tokensSaved = tokensBefore - tokensAfter;
  return {
    id: 'A',
    name: '去重即降 token',
    hypothesis: '折叠把"同一句话的多个变体"压成一条，卡片总 token 变少；省下的就是重复正文。',
    criterion: `Σ(折叠前卡片 tokens) − Σ(折叠后卡片 tokens)；重复正文占比 = (成员行正文总长 − 最长成员行) ÷ 成员行正文总长`,
    readout: {
      groups: rows.length,
      groupsSaved,
      tokensBefore,
      tokensAfter,
      tokensSaved,
      tokensSavedPerGroup: rows.length > 0 ? tokensSaved / rows.length : 0,
      budgetShare: tokensBefore > 0 ? tokensSaved / tokensBefore : 0,
      charsBefore,
      charsAfter,
      memberChars,
      duplicateChars,
      duplicateShare: memberChars > 0 ? duplicateChars / memberChars : 0,
    },
    rows,
    verdict: null,
  };
}

/** B · 召回不丢：被折叠的成员能否从合并行 + 指针追回（逐字）。 */
export function axisTraceability(observations = [], { samples = DEFAULT_SAMPLES, seed = DEFAULT_SEED } = {}) {
  const collapsed = [];
  for (const obs of observations) {
    if (obs.skipped) continue;
    const after = obs.wide.after;
    const mergeRow = (after.claims ?? []).find((e) => rowIdOf(e) === String(obs.merged.id));
    if (!mergeRow) continue;
    const supportKeys = new Set((obs.merged.support ?? []).map((s) => `${s.episode}#${s.seq}`));
    for (const member of obs.members) {
      const memberKeys = (Array.isArray(member.support) ? member.support : []).map((s) => `${s.episode}#${s.seq}`);
      collapsed.push({
        groupId: obs.merged.id,
        memberId: String(member.id),
        resolvable: true,
        covered: memberKeys.every((k) => supportKeys.has(k)),
        textLength: String(member.text ?? '').length,
        mergeRowPresent: true,
      });
    }
  }
  const picked = sampleDeterministic(collapsed, samples, seed);
  const traceable = picked.filter((x) => x.resolvable && x.mergeRowPresent && x.covered).length;
  return {
    id: 'B',
    name: '召回不丢',
    hypothesis: '被折叠成员的信息（正文 + 出处）仍能逐字追回，折叠不制造"看不见的记忆"。',
    criterion: '随机抽 N 个被折叠成员：①记录仍在库里；②卡片里有对应合并行；③成员每条 support 的 (episode,seq) 都被合并节点 support 并集覆盖',
    readout: {
      collapsedTotal: collapsed.length,
      sampled: picked.length,
      traceable,
      traceabilityRate: picked.length > 0 ? traceable / picked.length : null,
      wilson: wilsonInterval(traceable, picked.length),
      coveredTotal: collapsed.filter((x) => x.covered).length,
    },
    samples: picked,
    verdict: null,
  };
}

/** C · 排序更稳：折叠是否给别的组腾出预算位。 */
export function axisSlots(observations = []) {
  const rows = [];
  // 合并节点行不是"别的组"：先把全部合并节点 id 收起来，避免把它们算成"腾出来的位"
  const mergeIds = new Set(observations.map((o) => String(o?.merged?.id ?? '')));
  let rowsBefore = 0;
  let rowsAfter = 0;
  let memberRowsBefore = 0;
  let memberRowsAfter = 0;
  let otherRowsBefore = 0;
  let otherRowsAfter = 0;
  let cardsWithGain = 0;
  for (const obs of observations) {
    if (obs.skipped) continue;
    const memberSet = new Set(obs.memberIds);
    const b = obs.production.before.claims ?? [];
    const a = obs.production.after.claims ?? [];
    const isOther = (entry) => {
      const id = rowIdOf(entry);
      return !memberSet.has(id) && !mergeIds.has(id);
    };
    const mb = b.filter((e) => memberSet.has(rowIdOf(e))).length;
    const ma = a.filter((e) => memberSet.has(rowIdOf(e))).length;
    const ob = b.filter(isOther).length;
    const oa = a.filter(isOther).length;
    rowsBefore += b.length;
    rowsAfter += a.length;
    memberRowsBefore += mb;
    memberRowsAfter += ma;
    otherRowsBefore += ob;
    otherRowsAfter += oa;
    if (oa > ob) cardsWithGain += 1;
    rows.push({ id: obs.merged.id, rowsBefore: b.length, rowsAfter: a.length, memberRowsBefore: mb, memberRowsAfter: ma, otherRowsBefore: ob, otherRowsAfter: oa });
  }
  return {
    id: 'C',
    name: '排序更稳（同组不抢位）',
    hypothesis: '同组多成员各占一个预算位 ⇒ 折叠后同组只占 1 位，别的组/条目有更多机会进卡。',
    criterion: `线上口径（limit=${ENTRY_LIMIT} / budget=${BUDGET_TOKENS}）：统计"非本组行"（otherRows）在折叠前后的变化与"整卡行数"变化`,
    readout: {
      groups: rows.length,
      rowsBefore,
      rowsAfter,
      memberRowsBefore,
      memberRowsAfter,
      otherRowsBefore,
      otherRowsAfter,
      otherRowsDelta: otherRowsAfter - otherRowsBefore,
      cardsWithGain,
    },
    rows,
    verdict: null,
  };
}

/** D · 闸 4 可用性：折叠是否让卡片不再因"同组多行同文"被打回。 */
export function axisGate4(observations = []) {
  let dupBefore = 0;
  let dupAfter = 0;
  let okBefore = 0;
  let okAfter = 0;
  const flips = [];
  for (const obs of observations) {
    if (obs.skipped) continue;
    const eb = Array.isArray(obs.gates?.before?.errors) ? obs.gates.before.errors : [];
    const ea = Array.isArray(obs.gates?.after?.errors) ? obs.gates.after.errors : [];
    const nb = eb.filter((e) => String(e?.code ?? '').startsWith('gate4/')).length;
    const na = ea.filter((e) => String(e?.code ?? '').startsWith('gate4/')).length;
    dupBefore += nb;
    dupAfter += na;
    if (obs.gates?.before?.ok) okBefore += 1;
    if (obs.gates?.after?.ok) okAfter += 1;
    if (nb !== na) flips.push({ id: obs.merged.id, dupBefore: nb, dupAfter: na, okBefore: Boolean(obs.gates?.before?.ok), okAfter: Boolean(obs.gates?.after?.ok) });
  }
  return {
    id: 'D',
    name: '闸 4 可用性',
    hypothesis: '同组多成员行同文会被闸 4 判成"未标 supersedes 的重复"并打回整张卡；折叠后不再打回。',
    criterion: `线上口径跑真实 runGates：数 gate4/* 错误数与"整卡 ok"的张数（before vs after）`,
    readout: {
      groups: observations.filter((o) => !o.skipped).length,
      gate4Before: dupBefore,
      gate4After: dupAfter,
      okBefore,
      okAfter,
      cardsFlipped: flips.length,
    },
    flips,
    verdict: null,
  };
}

/* ── 汇总 ─────────────────────────────────────────────────── */

export function buildValueReport({ shadowRoot, samples = DEFAULT_SAMPLES, seed = DEFAULT_SEED } = {}) {
  const shadow = createStore({ root: shadowRoot });
  const mergedClaims = shadow.list('claims').map((r) => r.record).filter((c) => c && c.merge && Array.isArray(c.merge.members));
  const observations = collectGroupObservations({ shadow, mergedClaims });
  const A = axisTokens(observations);
  const B = axisTraceability(observations, { samples, seed });
  const C = axisSlots(observations);
  const D = axisGate4(observations);
  return { version: REPORT_VERSION, generatedAt: new Date().toISOString(), shadowRoot, mergedCount: mergedClaims.length, axes: { A, B, C, D } };
}

const pct = (x) => `${(Number(x) * 100).toFixed(1)}%`;
const num = (x, d = 2) => Number(x).toFixed(d);

export function renderReport(report) {
  const { A, B, C, D } = report.axes;
  const lines = [];
  lines.push('# T212 · 合流的价值主张（只读测量）');
  lines.push('');
  lines.push(`> 影库：\`${report.shadowRoot}\`（合并节点 ${report.mergedCount} 个）`);
  lines.push(`> 生成于 \`[本] ${report.generatedAt}\`；只读，未写任何库。`);
  lines.push('');
  const block = (axis) => {
    lines.push(`## ${axis.id} · ${axis.name}`);
    lines.push('');
    lines.push(`- **假设**：${axis.hypothesis}`);
    lines.push(`- **机械判据**：${axis.criterion}`);
    lines.push(`- **读数**：\`${JSON.stringify(axis.readout)}\``);
    lines.push(`- **结论**：${axis.verdict ?? '（见下）'}`);
    lines.push('');
  };
  block(A);
  block(B);
  block(C);
  block(D);
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  if (flags.help) {
    process.stdout.write('用法：node scripts/merge-value-report.mjs --shadow <shadowDir> [--samples N] [--seed N] [--json]\n');
    return 0;
  }
  if (flags.error) {
    process.stderr.write(`${flags.error}\n`);
    return 2;
  }
  if (!flags.shadow) {
    process.stderr.write('缺少 --shadow\n');
    return 2;
  }
  const shadowRoot = path.resolve(flags.shadow);
  if (!fs.existsSync(shadowRoot)) {
    process.stderr.write(`影库不存在：${shadowRoot}\n`);
    return 2;
  }
  const report = buildValueReport({ shadowRoot, samples: flags.samples, seed: flags.seed });
  if (flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${renderReport(report)}\n`);
  return 0;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invoked) process.exitCode = main();

export { main };

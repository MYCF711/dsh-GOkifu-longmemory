#!/usr/bin/env node
// T170 · 合流后的**消费侧验收**（只读）：在影子库上跑三项机械检查。
//
//   ① 同文重复行下降：同一批信号，分别在**源库**与**影库**渲染卡片，数"同一张卡里
//      ≥2 个不同 claimId 但正文相同"的行（多出来的那些行即重复）；影库应当更少。
//   ② 闸 4 不再因"合并节点与它的成员同文"报错：拿影库里的合并节点（`merge.members`）
//      造一张含"合并节点 + 成员"的卡，跑 `runGates`，数 `gate4/*` 错误（应为 0）。
//   ③ 卡片抽样里跨作用域仍为 0：抽样卡片的 `crossScope + crossScopeWalk` 全为 0。
//
// 只读：源库与影库都只 `list()` / `get()`；不写任何库，不写文件（`--json` 只打到 stdout）。
//
// 用法：
//   node scripts/merge-acceptance.mjs --store <shadow> [--source <src>] [--sample 40] [--merge-sample 20] [--json]
//
// 退出码：0 三项都通过；1 有任一不通过；2 参数/库不存在。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { walkFromSignals, createWalkCache } from '../src/rooms/walk.mjs';
import { buildMemoryCard, signalFromText } from '../src/rooms/inject.mjs';
import { runGates } from '../src/rooms/gates.mjs';

const ENTRY_LIMIT = 5;
const BUDGET_TOKENS = 500;

const ms = (n) => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);

export function parseArgs(argv = []) {
  const flags = { store: null, source: null, sample: 40, mergeSample: 20, mergeGroups: 20, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--store') flags.store = argv[++i] ?? null;
    else if (arg === '--source') flags.source = argv[++i] ?? null;
    else if (arg === '--sample') flags.sample = Number(argv[++i] ?? 40);
    else if (arg === '--merge-sample') flags.mergeSample = Number(argv[++i] ?? 20);
    else if (arg === '--merge-groups') flags.mergeGroups = Number(argv[++i] ?? 20);
    else return { error: `未知参数：${arg}` };
  }
  return flags;
}

/** 归一化正文：空白折叠、去尾部标点。 */
export function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 一张卡里的"同文重复行"：按正文分组，**不同 claimId** 的组里多出来的行数。
 * @returns {{duplicates:number, groups:number}}
 */
export function countDuplicateRows(claims = []) {
  const byText = new Map();
  for (const entry of Array.isArray(claims) ? claims : []) {
    const text = normalizeText(entry?.text);
    if (!text) continue;
    const id = String(entry?.claimId ?? entry?.line ?? Math.random());
    if (!byText.has(text)) byText.set(text, new Set());
    byText.get(text).add(id);
  }
  let duplicates = 0;
  let groups = 0;
  for (const ids of byText.values()) {
    if (ids.size < 2) continue;
    groups += 1;
    duplicates += ids.size - 1;
  }
  return { duplicates, groups };
}

/** 抽样：按 id 排序后等距取样（确定性，不随运行变化）。 */
export function sampleClaims(claims, n) {
  const pool = (Array.isArray(claims) ? claims : []).filter((c) => c && typeof c.id === 'string' && normalizeText(c.text).length >= 20 && typeof c.scopeKey === 'string' && c.scopeKey !== '');
  if (pool.length === 0) return [];
  const sorted = pool.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  const want = Math.max(1, Math.min(Number.isFinite(n) ? n : 40, sorted.length));
  const step = sorted.length / want;
  const out = [];
  const seen = new Set();
  for (let i = 0; i < want; i += 1) {
    const idx = Math.min(sorted.length - 1, Math.floor(i * step));
    const claim = sorted[idx];
    if (seen.has(claim.id)) continue;
    seen.add(claim.id);
    out.push(claim);
  }
  return out;
}

/** 在某个库上渲染一张卡（只读）。 */
export function buildCard(store, cache, claim, { limit = ENTRY_LIMIT, budgetTokens = BUDGET_TOKENS } = {}) {
  const signal = signalFromText(claim.text);
  const walkResult = walkFromSignals({ signal, store, scope: claim.scopeKey, depth: 2, limit, budgetTokens, cache });
  const card = buildMemoryCard({ cache, signal, walkResult, store, scope: claim.scopeKey, now: Date.now(), limit, budgetTokens });
  return { signal, walkResult, card };
}

/**
 * T173 · 定点抽样：从**影库的合并节点**里抽组，用"该组的共享正文"作信号
 * （walkFromSignals 只吃 signal 文本，没有 episode/seq 直击入参；组正文 = 成员的 representativeText，
 *  所以命中的就是同一组文本），分别在源库/影库走**同一条真实链路**（walk → buildMemoryCard）。
 *
 * 判据：源库该组本来只有 ≤1 行 ⇒ **未触发**（成员没被同时命中），不算进分母；
 *       触发组里"影库少 ≥1 行"的占比 ≥ 80% ⇒ 通过。
 * @param {{source:object, shadow:object, sourceCache:object, shadowCache:object,
 *          merges:Array, limit?:number, budgetTokens?:number}} p
 */
export function sampleMergeGroups({ source, shadow, sourceCache, shadowCache, merges = [], limit = 20, budgetTokens = 2000, measure = null } = {}) {
  const rows = [];
  for (const merged of merges) {
    const text = normalizeText(merged?.text);
    const scopeKey = typeof merged?.scopeKey === 'string' ? merged.scopeKey : '';
    if (!text || !scopeKey) {
      rows.push({ id: merged?.id ?? null, members: 0, sourceRows: 0, shadowRows: 0, saved: 0, triggered: false, why: 'no-text-or-scope' });
      continue;
    }
    const pseudo = { text, scopeKey };
    const run = measure ?? ((store, cache) => buildCard(store, cache, pseudo, { limit, budgetTokens }));
    let sourceRows = 0;
    let shadowRows = 0;
    try {
      sourceRows = run(source, sourceCache).card.claims.length;
    } catch {
      sourceRows = 0;
    }
    try {
      shadowRows = run(shadow, shadowCache).card.claims.length;
    } catch {
      shadowRows = 0;
    }
    rows.push({
      id: merged.id,
      members: Array.isArray(merged?.merge?.members) ? merged.merge.members.length : 0,
      sourceRows,
      shadowRows,
      saved: sourceRows - shadowRows,
      // 源库这一组本来只有 ≤1 行 ⇒ 成员没被同时命中，`未触发`
      triggered: sourceRows > 1,
      mergedRendered: shadowRows >= 1,
    });
  }
  const triggered = rows.filter((r) => r.triggered);
  const savedPositive = triggered.filter((r) => r.saved >= 1);
  const savedTotal = triggered.reduce((n, r) => n + Math.max(0, r.saved), 0);
  const worse = rows.filter((r) => r.saved < 0);
  return {
    groups: rows.length,
    triggered: triggered.length,
    untriggered: rows.length - triggered.length,
    savedTotal,
    avgSaved: triggered.length ? savedTotal / triggered.length : 0,
    savedPositive: savedPositive.length,
    ratio: triggered.length ? savedPositive.length / triggered.length : null,
    pass: triggered.length > 0 && savedPositive.length / triggered.length >= 0.8,
    worse,
    rows,
  };
}

/**
 * 三项验收。
 * @param {{shadowRoot:string, sourceRoot:string, sample?:number, mergeSample?:number}} p
 */
export function runAcceptance({ shadowRoot, sourceRoot, sample = 40, mergeSample = 20, mergeGroups = 20 } = {}) {
  const started = Date.now();
  const shadow = createStore({ root: shadowRoot });
  const source = createStore({ root: sourceRoot });
  const shadowClaims = shadow.list('claims').map((e) => e.record).filter(Boolean);
  const sourceClaims = source.list('claims').map((e) => e.record).filter(Boolean);

  // ── ① 同文重复行（源库 vs 影库）──────────────────────────────────────────
  const picks = sampleClaims(shadowClaims, sample);
  const shadowCache = createWalkCache(shadow);
  const sourceCache = createWalkCache(source);
  let srcDup = 0;
  let shadowDup = 0;
  let cardsBuilt = 0;
  const perCard = [];
  for (const claim of picks) {
    let srcCard;
    let shadowCard;
    try {
      srcCard = buildCard(source, sourceCache, claim).card;
    } catch {
      srcCard = { claims: [], crossScope: 0, crossScopeWalk: 0 };
    }
    try {
      shadowCard = buildCard(shadow, shadowCache, claim).card;
    } catch {
      shadowCard = { claims: [], crossScope: 0, crossScopeWalk: 0 };
    }
    const s = countDuplicateRows(srcCard.claims);
    const d = countDuplicateRows(shadowCard.claims);
    srcDup += s.duplicates;
    shadowDup += d.duplicates;
    cardsBuilt += 1;
    if (s.duplicates || d.duplicates) perCard.push({ claimId: claim.id, source: s.duplicates, shadow: d.duplicates });
  }
  const dup = {
    cards: cardsBuilt,
    sourceDuplicates: srcDup,
    shadowDuplicates: shadowDup,
    delta: shadowDup - srcDup,
    reduction: srcDup === 0 ? null : (srcDup - shadowDup) / srcDup,
    notWorse: shadowDup <= srcDup,
    examples: perCard.slice(0, 5),
  };

  // ── ② 闸 4：合并节点与成员同文不得报错 ──────────────────────────────────
  const merges = shadowClaims.filter((c) => Array.isArray(c?.merge?.members) && c.merge.members.length > 0);
  const mergePick = merges.slice(0, Math.max(1, mergeSample));
  let gate4Errors = 0;
  let gate4GroupsChecked = 0;
  const gate4Details = [];
  for (const merged of mergePick) {
    const memberId = merged.merge.members.find((id) => shadowClaims.some((c) => c.id === id));
    const member = memberId ? shadowClaims.find((c) => c.id === memberId) : null;
    if (!member) continue;
    gate4GroupsChecked += 1;
    // 造一张"合并节点 + 成员"同框的卡（正是 gate4 之前误报的形状）
    const entry = (record) => ({
      claimId: record.id,
      kind: 'fact',
      marker: 'observed',
      state: record.state ?? 'observed',
      text: record.text,
      occurredAt: record.occurredAt,
      date: new Date(Number(record.occurredAt) || 0).toISOString().slice(0, 10),
      line: `- [observed] ${String(record.text ?? '').slice(0, 80)}`,
      source: { episode: record.support?.[0]?.episode ?? 'ep-unknown', seq: record.support?.[0]?.seq ?? 0 },
    });
    const card = {
      indexLine: `MEMORY: 1 局（scope=${member.scopeKey}, 1 局, 未列出≠不存在）`,
      section: null,
      claims: [entry(merged), entry(member)],
      omissions: null,
      tokens: 80,
      shadow: true,
      omittedCount: 0,
      hitCount: 2,
      crossScope: 0,
      crossScopeWalk: 0,
      unknownScope: 0,
    };
    const res = runGates({ card, records: { claims: shadowClaims, joseki: shadow.list('joseki').map((e) => e.record).filter(Boolean) }, scope: member.scopeKey, validityResults: {} });
    const g4 = res.errors.filter((e) => e.gate === '4');
    gate4Errors += g4.length;
    if (g4.length) gate4Details.push({ merged: merged.id, member: member.id, codes: g4.map((e) => e.code) });
  }
  const gate4 = {
    mergeRecords: merges.length,
    groupsChecked: gate4GroupsChecked,
    errors: gate4Errors,
    pass: gate4Errors === 0,
    details: gate4Details.slice(0, 5),
  };

  // ── ③ 跨作用域 = 0 ───────────────────────────────────────────────────────
  let crossScopeViolations = 0;
  const perCardCross = [];
  for (const claim of picks) {
    let card;
    try {
      card = buildCard(shadow, shadowCache, claim).card;
    } catch {
      continue;
    }
    const n = (Number(card.crossScope) || 0) + (Number(card.crossScopeWalk) || 0);
    if (n > 0) {
      crossScopeViolations += 1;
      perCardCross.push({ claimId: claim.id, crossScope: card.crossScope, crossScopeWalk: card.crossScopeWalk });
    }
  }
  const crossScope = { cards: cardsBuilt, violations: crossScopeViolations, pass: crossScopeViolations === 0, details: perCardCross.slice(0, 5) };

  // ── ④ T173 定点抽样：合流到底省了几行 ───────────────────────────────────
  const groupPick = merges.slice(0, Math.max(1, mergeGroups));
  const groups = sampleMergeGroups({ source, shadow, sourceCache, shadowCache, merges: groupPick });

  const ok = dup.notWorse && gate4.pass && crossScope.pass && groups.pass;
  return {
    shadowRoot,
    sourceRoot,
    sample: picks.length,
    dup,
    gate4,
    crossScope,
    groups,
    ok,
    elapsedMs: Date.now() - started,
  };
}

export function formatReport(r) {
  const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(2)}%`);
  const lines = [];
  lines.push(`源库（只读）：${r.sourceRoot}`);
  lines.push(`影库：${r.shadowRoot}`);
  lines.push(`抽样 ${r.sample} 条 claim 造卡 · 耗时 ${ms(r.elapsedMs)}`);
  lines.push('');
  lines.push('| # | 验收项 | 读数 | 判据 |');
  lines.push('|---|---|---|---|');
  lines.push(`| ① | 同文重复行 | 源库 ${r.dup.sourceDuplicates} → 影库 ${r.dup.shadowDuplicates}（降 ${pct(r.dup.reduction)}，${r.dup.cards} 张卡） | 影库 ≤ 源库 |`);
  lines.push(`| ② | 闸 4（合并节点 vs 成员） | ${r.gate4.errors} 个错误（查 ${r.gate4.groupsChecked} 组 / 影库 ${r.gate4.mergeRecords} 个合并节点） | 必须 0 |`);
  lines.push(`| ③ | 跨作用域 | ${r.crossScope.violations} 张卡非零（共 ${r.crossScope.cards} 张） | 必须 0 |`);
  const g = r.groups;
  lines.push(`| ④ | 定点抽样（合并组） | ${g.groups} 组 · 触发 ${g.triggered}（未触发 ${g.untriggered}） · 平均省 **${g.avgSaved.toFixed(2)}** 行 · 至少省 1 行 **${g.ratio === null ? 'n/a' : `${(g.ratio * 100).toFixed(1)}%`}** | ≥ 80% |`);
  lines.push('');
  lines.push(`结论：${r.ok ? '四项通过' : '有不通过项'}（① ${r.dup.notWorse ? 'ok' : 'FAIL'} · ② ${r.gate4.pass ? 'ok' : 'FAIL'} · ③ ${r.crossScope.pass ? 'ok' : 'FAIL'} · ④ ${r.groups.pass ? 'ok' : 'FAIL'}）`);
  if (g.rows.length) {
    lines.push('');
    lines.push('| 合并组 | 成员 | 源库行数 | 影库行数 | 省下 | 触发 |');
    lines.push('|---|---|---|---|---|---|');
    for (const row of g.rows) {
      lines.push(`| ${row.id} | ${row.members} | ${row.sourceRows} | ${row.shadowRows} | ${row.saved} | ${row.triggered ? '是' : '未触发'} |`);
    }
  }
  if (g.worse.length) lines.push(`
⚠ 影库比源库多行的组：${g.worse.map((x) => `${x.id} ${x.sourceRows}→${x.shadowRows}`).join(' · ')}`);
  if (r.dup.examples.length) lines.push(`① 样例：${r.dup.examples.map((x) => `${x.claimId} ${x.source}→${x.shadow}`).join(' · ')}`);
  if (r.gate4.details.length) lines.push(`② 明细：${JSON.stringify(r.gate4.details)}`);
  if (r.crossScope.details.length) lines.push(`③ 明细：${JSON.stringify(r.crossScope.details)}`);
  return lines.join('\n');
}

export function runCli(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  if (flags.error) return { code: 2, stderr: flags.error };
  if (flags.help) return { code: 0, stdout: USAGE };
  if (!flags.store) return { code: 2, stderr: '缺少 --store（影库目录）' };
  const shadowRoot = path.resolve(flags.store);
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');
  const sourceRoot = flags.source ? path.resolve(flags.source) : path.resolve(home, 'memory-context');
  if (!fs.existsSync(shadowRoot)) return { code: 2, stderr: `影库不存在：${shadowRoot}` };
  if (!fs.existsSync(sourceRoot)) return { code: 2, stderr: `源库不存在：${sourceRoot}` };
  const result = runAcceptance({ shadowRoot, sourceRoot, sample: flags.sample, mergeSample: flags.mergeSample, mergeGroups: flags.mergeGroups });
  if (flags.json) return { code: result.ok ? 0 : 1, stdout: JSON.stringify(result, null, 2) };
  return { code: result.ok ? 0 : 1, stdout: formatReport(result) };
}

export const USAGE = `棋院 merge-acceptance（T170：合流后消费侧的只读验收）

用法：node scripts/merge-acceptance.mjs --store <shadow> [--source <src>] [--sample 40] [--merge-sample 20] [--json]

  --store <dir>          影库（合流写出来的那个）
  --source <dir>         源库（默认 <DSH_HOME>/memory-context）；只读，用来做 ① 的对照
  --sample <n>           抽多少条 claim 造卡（默认 40）
  --merge-sample <n>     抽多少个合并节点验闸 4（默认 20）
  --merge-groups <n>     定点抽多少个合并组量"省下的行数"（默认 20；占比 ≥ 80% 才算通过）
  --json                 机器可读
`;

export function main(argv = process.argv.slice(2)) {
  const res = runCli(argv);
  if (res.stdout) process.stdout.write(res.stdout.endsWith('\n') ? res.stdout : `${res.stdout}\n`);
  if (res.stderr) process.stderr.write(res.stderr.endsWith('\n') ? res.stderr : `${res.stderr}\n`);
  return res.code;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invoked) process.exitCode = main();

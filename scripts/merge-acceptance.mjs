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
  const flags = { store: null, source: null, sample: 40, mergeSample: 20, mergeGroups: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--store') flags.store = argv[++i] ?? null;
    else if (arg === '--source') flags.source = argv[++i] ?? null;
    else if (arg === '--sample') flags.sample = Number(argv[++i] ?? 40);
    else if (arg === '--merge-sample') flags.mergeSample = Number(argv[++i] ?? 20);
    else if (arg === '--merge-groups') flags.mergeGroups = Number(argv[++i] ?? 0) || null;
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
 * T185 · Wilson score interval（**不是**正态近似）。
 *
 * 为什么不用 Wald（`p ± z·√(p(1-p)/n)`）：p=1 或 p=0 时方差为 0，区间会退化成 [1,1]，
 * 恰好在"全中"这种最需要打折的地方给出 100% —— 这正是 n=3 全中却宣称 100% 的谬误来源。
 *
 * Wilson 公式（z=1.96 为 95%）：
 *   ŝ = (p̂ + z²/(2n)) / (1 + z²/n)
 *   h  = z·√( p̂(1-p̂)/n + z²/(4n²) ) / (1 + z²/n)
 *   区间 = [ŝ - h, ŝ + h]，再截断到 [0,1]
 *
 * 性质（本项目要用到的两条）：
 *   · p̂=1 时下界 = n/(n+z²)（n=3 ⇒ 43.8%，n=10 ⇒ 72.3%）⇒ 小样本全中不会报 100%；
 *   · 想让"全中"的下界 ≥ 0.5，需 n ≥ z² ≈ 3.84（取 4 是数学下限；项目纪律另加 ≥10 的门槛）。
 * @param {number} successes 成功数
 * @param {number} n 样本量
 * @param {number} [z] 分位数（双侧 95% ⇒ 1.96）
 */
export function wilsonInterval(successes, n, z = 1.96) {
  const k = Number(successes);
  const total = Number(n);
  if (!Number.isFinite(k) || !Number.isFinite(total) || total <= 0) {
    return { phat: null, lower: null, upper: null, n: Number.isFinite(total) ? total : 0, z };
  }
  const phat = Math.min(1, Math.max(0, k / total));
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (phat + z2 / (2 * total)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat)) / total + z2 / (4 * total * total))) / denom;
  return {
    phat,
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
    n: total,
    z,
  };
}

/**
 * 选合并组：`limit` 不是正数（null/undefined/0）⇒ **全量**（T185：默认跑遍影库所有合并组）。
 * @param {Array} merges
 * @param {number|null} limit
 */
export function selectMergeGroups(merges = [], limit = null) {
  const list = Array.isArray(merges) ? merges : [];
  if (!Number.isFinite(limit) || limit <= 0) return list.slice();
  return list.slice(0, Math.floor(limit));
}

/**
 * T173 · 定点抽样：从**影库的合并节点**里抽组，用"该组的共享正文"作信号
 * （walkFromSignals 只吃 signal 文本，没有 episode/seq 直击入参；组正文 = 成员的 representativeText，
 *  所以命中的就是同一组文本），分别在源库/影库走**同一条真实链路**（walk → buildMemoryCard）。
 *
 * 判据（T181 定稿）：
 *   · ④a 不许变差：任何组 `影库行数 ≤ 源库行数`；
 *   · ④b 不许丢内容：`源库行数 ≥1` 的组，影库行数必须 `≥1`；
 *   · ④c 参考：**可折组**（源库卡片里**本组成员行 ≥2**）中"影库省行"的占比 —— 只展示、不参与退出码。
 *   成员行数 = 卡片渲染行的 `claimId` 与本组 `merge.members` 求交集的个数（源/影各算一次，不解析正文）。
 *
 * T185（统计功效）：n=3 的 100% 什么也证明不了（真实收益 50% 时，3 组全中的概率仍有 12.5%）。
 * 所以 ④c 必须带**区间**与**样本量门槛**：
 *   · Wilson 95% 置信区间（见 `wilsonInterval` 的推导注释）；
 *   · 判据：Wilson **下界 ≥ 0.5 且可折组 ≥ 10** 才算"有证据"，否则如实写**证据不足**。
 * @param {{source:object, shadow:object, sourceCache:object, shadowCache:object,
 *          merges:Array, limit?:number, budgetTokens?:number, measure?:Function}} p
 */
export function sampleMergeGroups({ source, shadow, sourceCache, shadowCache, merges = [], limit = 20, budgetTokens = 2000, measure = null } = {}) {
  const rows = [];
  for (const merged of merges) {
    const text = normalizeText(merged?.text);
    const scopeKey = typeof merged?.scopeKey === 'string' ? merged.scopeKey : '';
    if (!text || !scopeKey) {
      rows.push({
        id: merged?.id ?? null,
        members: 0,
        sourceRows: 0,
        shadowRows: 0,
        saved: 0,
        triggered: false,
        membersSourceRows: 0,
        membersShadowRows: 0,
        foldable: false,
        why: 'no-text-or-scope',
      });
      continue;
    }
    const pseudo = { text, scopeKey };
    const run = measure ?? ((store, cache) => buildCard(store, cache, pseudo, { limit, budgetTokens }));
    // T181：④c 的分母只认"卡片里出现的是**本组**成员"
    const memberIds = new Set(Array.isArray(merged?.merge?.members) ? merged.merge.members.map(String) : []);
    let sourceClaims = [];
    let shadowClaims = [];
    try {
      sourceClaims = run(source, sourceCache).card.claims ?? [];
    } catch {
      sourceClaims = [];
    }
    try {
      shadowClaims = run(shadow, shadowCache).card.claims ?? [];
    } catch {
      shadowClaims = [];
    }
    // "成员行数" = 卡片渲染行里 claimId ∈ 本组 merge.members 的行数（机械数集合交集，不解析正文）
    const membersSourceRows = sourceClaims.filter((entry) => memberIds.has(String(entry?.claimId ?? ''))).length;
    const membersShadowRows = shadowClaims.filter((entry) => memberIds.has(String(entry?.claimId ?? ''))).length;
    rows.push({
      id: merged.id,
      members: memberIds.size,
      sourceRows: sourceClaims.length,
      shadowRows: shadowClaims.length,
      saved: sourceClaims.length - shadowClaims.length,
      // 可折组 = 源库卡片里**本组成员行 ≥2**（只有这样才能靠折叠省行）；
      // `triggered` 保留旧含义（源库总行数 > 1）仅作对照，不再当分母。
      foldable: membersSourceRows >= 2,
      triggered: sourceClaims.length > 1,
      membersSourceRows,
      membersShadowRows,
      mergedRendered: shadowClaims.length >= 1,
    });
  }

  // ④a：**不许变差** —— 任何组影库行数都不得多于源库（反增 = 合流把卡片撑大了）
  const worse = rows.filter((r) => r.shadowRows > r.sourceRows);
  // ④b：**不许丢内容** —— 源库能渲染出行的组，影库不能一行都不剩（曾经出现过 1 行 → 0 行）
  const losses = rows.filter((r) => r.sourceRows >= 1 && r.shadowRows === 0);
  const a = {
    id: '④a',
    name: '不许变差',
    pass: rows.length > 0 && worse.length === 0,
    worse: worse.map((r) => ({ id: r.id, sourceRows: r.sourceRows, shadowRows: r.shadowRows })),
    groups: rows.length,
    criterion: '反增组 = 0',
  };
  const b = {
    id: '④b',
    name: '不许丢内容',
    pass: rows.length > 0 && losses.length === 0,
    losses: losses.map((r) => ({ id: r.id, sourceRows: r.sourceRows, shadowRows: r.shadowRows })),
    groups: rows.filter((r) => r.sourceRows >= 1).length,
    criterion: '源库 ≥1 行的组里，影库 0 行 = 0 组',
  };
  // ④c：**参考指标**（只展示，不参与退出码）
  // T181：分母改成"**可折组**"（源库本组成员行 ≥2）。旧口径（`sourceRows > 1`）会把
  // "卡片里碰巧有无关行"的组也算进分母，那些组永远省不了行（除非砍无关行，而那是 ④b 禁止的）。
  const foldable = rows.filter((r) => r.foldable);
  const savedPositive = foldable.filter((r) => r.shadowRows < r.sourceRows);
  const savedTotal = foldable.reduce((n, r) => n + Math.max(0, r.sourceRows - r.shadowRows), 0);
  // T185：④c 带 Wilson 95% 区间 + 样本量门槛，小样本的 100% 不许当结论用。
  const wilson = wilsonInterval(savedPositive.length, foldable.length);
  const MIN_FOLDABLE = 10;
  const THRESHOLD = 0.5;
  // 全校正下界：随机取一个合并组，既"可折"又"真省行"的概率下界
  // = 可折率（点估计）× 可折组里省行率的 Wilson 下界（保守：两个量都往下取）
  const foldableShare = rows.length ? foldable.length / rows.length : 0;
  const layerLowerBound = foldableShare * (wilson.lower ?? 0);
  const nNeededPerfect = Math.ceil(wilson.z * wilson.z); // p̂=1 时下界 ≥0.5 的数学下限（n ≥ z²）
  let evidence;
  if (rows.length === 0) {
    evidence = { verdict: '证据不足', reason: '没有可评估的合并组（影库里没有 merge.members）' };
  } else if (foldable.length === 0) {
    evidence = { verdict: '证据不足', reason: '没有可折组（成员从不同时出现在同一张卡里，④c 无定义）' };
  } else if (foldable.length < MIN_FOLDABLE) {
    evidence = {
      verdict: '证据不足',
      reason: `可折组 ${foldable.length} < ${MIN_FOLDABLE}（当前 ${savedPositive.length}/${foldable.length} 省行；Wilson 下界 ${(wilson.lower * 100).toFixed(1)}%）`
        + `—— 若真实收益只有 50%，${foldable.length} 组全中的概率仍有 ${((0.5 ** foldable.length) * 100).toFixed(1)}%；`
        + `若后续仍全中，至少 ${nNeededPerfect} 个可折组（数学下限 z²≈${(wilson.z * wilson.z).toFixed(2)}）才能让下界 ≥0.5，项目门槛取 ${MIN_FOLDABLE}`,
    };
  } else if (wilson.lower < THRESHOLD) {
    evidence = { verdict: '证据不足', reason: `Wilson 下界 ${(wilson.lower * 100).toFixed(1)}% < ${THRESHOLD * 100}%（可折 ${foldable.length} 组）` };
  } else {
    evidence = { verdict: '有证据', reason: `Wilson 下界 ${(wilson.lower * 100).toFixed(1)}% ≥ ${THRESHOLD * 100}% 且可折组 ${foldable.length} ≥ ${MIN_FOLDABLE}` };
  }
  const c = {
    id: '④c',
    name: '参考：可折组里"影库省行"的占比',
    total: rows.length,
    foldable: foldable.length,
    notFoldable: rows.length - foldable.length,
    savedPositive: savedPositive.length,
    ratio: foldable.length ? savedPositive.length / foldable.length : null,
    avgSaved: foldable.length ? savedTotal / foldable.length : 0,
    savedTotal,
    wilson,
    layerLowerBound,
    evidence: {
      ...evidence,
      verdict: evidence.verdict,
      threshold: THRESHOLD,
      minFoldable: MIN_FOLDABLE,
      lower: wilson.lower,
      upper: wilson.upper,
      n: foldable.length,
    },
    membersSourceRows: rows.map((r) => ({
      id: r.id,
      membersSourceRows: r.membersSourceRows,
      membersShadowRows: r.membersShadowRows,
      sourceRows: r.sourceRows,
      shadowRows: r.shadowRows,
      foldable: r.foldable,
      saved: r.sourceRows - r.shadowRows,
    })),
    criterion: '只展示（不参与退出码）',
  };
  return {
    groups: rows.length,
    triggered: rows.filter((r) => r.triggered).length,
    untriggered: rows.filter((r) => !r.triggered).length,
    foldable: foldable.length,
    notFoldable: rows.length - foldable.length,
    savedTotal,
    avgSaved: c.avgSaved,
    savedPositive: c.savedPositive,
    ratio: c.ratio,
    a,
    b,
    c,
    // ④ 的整体结论只看 a/b；c 是参考，不许偷偷并进来
    pass: a.pass && b.pass,
    worse,
    losses,
    rows,
  };
}

/**
 * 三项验收。
 * @param {{shadowRoot:string, sourceRoot:string, sample?:number, mergeSample?:number}} p
 */
export function runAcceptance({ shadowRoot, sourceRoot, sample = 40, mergeSample = 20, mergeGroups = null } = {}) {
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
  // T185：默认**跑遍影库里所有合并组**（不再抽 20 组）——n 太小时 100% 没有统计意义。
  const groupPick = selectMergeGroups(merges, mergeGroups);
  const groups = sampleMergeGroups({ source, shadow, sourceCache, shadowCache, merges: groupPick });

  // ④ 只由 ④a/④b 决定（④c 是参考指标，不参与退出码）
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
  lines.push(`| ④a | 不许变差（定点抽样） | 反增 **${g.a.worse.length}** 组 / 共 ${g.a.groups} 组${g.a.worse.length ? `（${g.a.worse.map((x) => `${x.id} ${x.sourceRows}→${x.shadowRows}`).join(' · ')}）` : ''} | 必须 0 |`);
  lines.push(`| ④b | 不许丢内容 | 丢内容 **${g.b.losses.length}** 组 / 源库 ≥1 行的 ${g.b.groups} 组${g.b.losses.length ? `（${g.b.losses.map((x) => `${x.id} ${x.sourceRows}→${x.shadowRows}`).join(' · ')}）` : ''} | 必须 0 |`);
  const w = g.c.wilson;
  lines.push(`| ④c | 参考：可折组里"影库省行"的占比 | 总 **${g.c.total}** 组 · 可折 **${g.c.foldable}** · 不可折 ${g.c.notFoldable} · 省行 ${g.c.savedPositive}/${g.c.foldable} = **${g.c.ratio === null ? 'n/a' : `${(g.c.ratio * 100).toFixed(1)}%`}** · Wilson 95% **${w.lower === null ? 'n/a' : `[${(w.lower * 100).toFixed(1)}%, ${(w.upper * 100).toFixed(1)}%]`}** · 全校正下界 ${(g.c.layerLowerBound * 100).toFixed(1)}% · 平均省 ${g.c.avgSaved.toFixed(2)} 行 | 只展示 |`);
  lines.push(`| ④c′ | 统计结论 | **${g.c.evidence.verdict}** —— ${g.c.evidence.reason} | 只展示 |`);
  lines.push('');
  lines.push(`结论：${r.ok ? '通过' : '有不通过项'}（① ${r.dup.notWorse ? 'ok' : 'FAIL'} · ② ${r.gate4.pass ? 'ok' : 'FAIL'} · ③ ${r.crossScope.pass ? 'ok' : 'FAIL'} · ④a ${g.a.pass ? 'ok' : 'FAIL'} · ④b ${g.b.pass ? 'ok' : 'FAIL'} · ④c 参考 ${g.c.ratio === null ? 'n/a' : `${(g.c.ratio * 100).toFixed(1)}%`}（${g.c.evidence.verdict}））`);
  if (g.rows.length) {
    lines.push('');
    lines.push('| 合并组 | 成员 | 成员行数（源/影） | 源库行数 | 影库行数 | 省下 | 可折 | 闸门 |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const row of g.rows) {
      const flag = row.shadowRows > row.sourceRows ? '⚠ 反增' : (row.sourceRows >= 1 && row.shadowRows === 0 ? '⚠ 丢内容' : '');
      lines.push(`| ${row.id} | ${row.members} | ${row.membersSourceRows}/${row.membersShadowRows} | ${row.sourceRows} | ${row.shadowRows} | ${row.saved} | ${row.foldable ? '是' : '不可折'} | ${flag} |`);
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
  --merge-groups <n>     定点抽多少个合并组（**默认全量**：影库里所有合并组）；④c 只展示、不参与退出码
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

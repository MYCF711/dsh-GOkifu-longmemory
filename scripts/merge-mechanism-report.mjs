#!/usr/bin/env node
// T202 · 合流「机制 vs 频率」分离报告（只读）
//
// 为什么要有它：验收 ④c 报「可折 4 组 / 39 组 · 省行 4/4 = 100% · Wilson 下界 51.0% ⇒ 证据不足」。
// 这个数把两个不同的问题混在一起：
//   · **机制**：合流**能不能**省行？—— 在"确实同时命中 ≥2 个成员"的输入上，行数会不会降？
//   · **频率**：合流**多常**省行？—— 真实分布里这种输入占多少？
// ④c 用真实分布的分母回答机制问题，于是 4 个样本既证明不了机制，也说明不了频率。
//
// 本脚本把两臂拆开，**各报各的数**（不合成一个数）：
//   · 机制臂：**影库**（含合并节点）作源，对每个合并组**构造**"同时命中全部成员"的信号
//     （= 该组每个成员的正文各一条 term），跑真实 `walkFromSignals → buildMemoryCard`，
//     比较**折叠前**（把合并节点从视图里摘掉 ⇒ 成员各自成行）与**折叠后**（真影库）的行数。
//   · 频率臂：**真库**（无合并节点的源分布）上，随机抽 claim 正文当信号，统计
//     "一张卡里同组 ≥2 个成员成行"的概率 + Wilson 95% 区间。
//
// 只读：两个库都只 `list()/get()`；不写任何库、不改任何文件（`--json` 只打 stdout）。
//
// 用法：
//   node scripts/merge-mechanism-report.mjs --shadow <shadowDir> --store <realDir> [--samples 1000] [--seed 20261105] [--json]
//
// 退出码：0 报告生成；2 参数/库不存在。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';
import { walkFromSignals, createWalkCache } from '../src/rooms/walk.mjs';
import { buildMemoryCard, signalFromText, ENTRY_LIMIT, BUDGET_TOKENS } from '../src/rooms/inject.mjs';
import { wilsonInterval } from './merge-acceptance.mjs';

/** 报告版本（结构变更时 +1）。 */
export const REPORT_VERSION = 1;
/** 机制臂默认预算：要能装下"全部成员 + 同卡其它条目"，所以放大。 */
export const MECHANISM_LIMIT = 50;
export const MECHANISM_BUDGET = 100000;
/** 频率臂默认：与线上卡片同口径（ENTRY_LIMIT / BUDGET_TOKENS）。 */
export const DEFAULT_SAMPLES = 1000;

export function parseArgs(argv = []) {
  const flags = { shadow: null, store: null, samples: DEFAULT_SAMPLES, seed: 20261105, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--shadow') flags.shadow = argv[++i] ?? null;
    else if (arg === '--store') flags.store = argv[++i] ?? null;
    else if (arg === '--samples') flags.samples = Number(argv[++i] ?? DEFAULT_SAMPLES);
    else if (arg === '--seed') flags.seed = Number(argv[++i] ?? 20261105);
    else return { error: `未知参数：${arg}` };
  }
  return flags;
}

/* ── 纯函数（测试直接调）──────────────────────────────────── */

/** 合并节点的成员 id 列表（无 merge 字段 ⇒ 空数组）。 */
export function memberIdsOf(mergedClaim) {
  const members = mergedClaim?.merge?.members;
  return Array.isArray(members) ? members.map(String).filter(Boolean) : [];
}

/**
 * 「同时命中全部成员」的构造信号：每个成员的正文各一条 term。
 * 为什么用正文而不是 topic id：walk 的 claim 命中要过 `overlaps(term, claimText)`，
 * 正文逐字放进 term ⇒ 每个成员都**确定**被命中（topic 命中只能保证"该局被命中"，
 * 而一局里往往只有 1 条 claim 能成行）。
 */
export function buildGroupSignal(members = []) {
  const terms = (Array.isArray(members) ? members : [])
    .map((m) => String(m?.text ?? '').trim())
    .filter((t) => t !== '');
  return { kind: 'root-message', terms, entities: [] };
}

/**
 * 「折叠前」的库视图：把带 `merge` 字段的派生 claim 从 claims 里摘掉。
 * 其余 kind 原样透传 ⇒ 同一条 walk 结果在两种视图下的差异**只有折叠**。
 */
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

/** 卡片里属于 `memberIdSet` 的行数。 */
export function countMemberRows(card, memberIdSet) {
  const claims = Array.isArray(card?.claims) ? card.claims : [];
  let n = 0;
  for (const entry of claims) {
    const id = String(entry?.claim ?? entry?.claimId ?? '');
    if (memberIdSet.has(id)) n += 1;
  }
  return n;
}

/** 卡片里是否出现指定 claim（合并节点行）。 */
export function hasRow(card, claimId) {
  const id = String(claimId ?? '');
  if (!id) return false;
  return (Array.isArray(card?.claims) ? card.claims : []).some((entry) => String(entry?.claim ?? entry?.claimId ?? '') === id);
}

/** 确定性抽样（LCG；同 seed 同结果）。 */
export function sampleDeterministic(pool, n, seed = 20261105) {
  const list = Array.isArray(pool) ? pool : [];
  const want = Math.min(Math.max(1, Number.isFinite(n) ? Math.floor(n) : 1), list.length);
  if (list.length === 0) return [];
  let state = (Number.isFinite(seed) ? Math.floor(seed) : 20261105) >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0; // 数值方法：LCG（Numerical Recipes 参数）
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

/* ── 机制臂 ───────────────────────────────────────────────── */

/**
 * 机制臂：对每个合并组构造信号，比较折叠前/后行数。
 * @param {{shadow:object, mergedClaims:object[], limit?:number, budgetTokens?:number}} p
 * @returns {{groups:number, foldable:number, savedGroups:number, totalSaved:number, meanSaved:number,
 *            distinctEpisodeGroups:number, rows:object[]}}
 */
export function mechanismArm({ shadow, mergedClaims = [], limit = MECHANISM_LIMIT, budgetTokens = MECHANISM_BUDGET } = {}) {
  const noFold = storeWithoutMergeNodes(shadow);
  const cacheFold = createWalkCache(shadow);
  const cacheNoFold = createWalkCache(noFold);
  const mergeIds = new Set(mergedClaims.map((m) => String(m.id)));

  const rows = [];
  for (const merged of mergedClaims) {
    const memberIds = memberIdsOf(merged);
    const members = memberIds.map((id) => shadow.get('claims', id)).filter(Boolean);
    if (members.length < 2) {
      rows.push({ id: merged.id, members: memberIds.length, resolved: members.length, skipped: 'members-unresolved' });
      continue;
    }
    const signal = buildGroupSignal(members);
    const walkResult = walkFromSignals({
      signal,
      store: shadow,
      scope: merged.scopeKey,
      depth: 2,
      limit,
      budgetTokens,
      cache: cacheFold,
    });
    // 「折叠前」世界没有合并节点 ⇒ 指向合并节点的 hit 在两臂共用的输入里都要剔除
    const hits = (Array.isArray(walkResult.hits) ? walkResult.hits : [])
      .filter((h) => !mergeIds.has(String(h?.claim ?? h?.claimId ?? '')));
    const shared = { ...walkResult, hits, hitCount: hits.length };

    const before = buildMemoryCard({ cache: cacheNoFold, signal, walkResult: shared, store: noFold, scope: merged.scopeKey, now: 1, limit, budgetTokens });
    const after = buildMemoryCard({ cache: cacheFold, signal, walkResult: shared, store: shadow, scope: merged.scopeKey, now: 1, limit, budgetTokens });

    const memberSet = new Set(memberIds);
    const beforeRows = before.claims.length;
    const afterRows = after.claims.length;
    const memberRowsBefore = countMemberRows(before, memberSet);
    const memberRowsAfter = countMemberRows(after, memberSet);
    const mergeRowRendered = hasRow(after, merged.id);
    // 本组自身的折叠：≥2 个成员行 ⇒ 被 1 行合并节点取代（净省 memberRowsBefore-1）
    const ownSaved = memberRowsBefore - memberRowsAfter - (mergeRowRendered ? 1 : 0);
    const ownExpected = memberRowsBefore >= 2 ? memberRowsBefore - 1 : 0;
    // 整张卡的总省行：**同一张卡里可能还折了别的组**（跨组合并是正常现象，别混进本组判据）
    const cardSaved = beforeRows - afterRows;
    const months = new Set();
    for (const member of members) {
      for (const s of Array.isArray(member.support) ? member.support : []) {
        if (typeof s?.episode === 'string' && s.episode !== '') months.add(s.episode);
      }
    }
    rows.push({
      id: merged.id,
      members: memberIds.length,
      resolved: members.length,
      distinctEpisodes: months.size,
      beforeRows,
      afterRows,
      memberRowsBefore,
      memberRowsAfter,
      mergeRowRendered,
      foldable: memberRowsBefore >= 2,
      ownSaved,
      ownExpected,
      ownMatch: ownSaved === ownExpected,
      cardSaved,
    });
  }

  const valid = rows.filter((r) => !r.skipped);
  const foldable = valid.filter((r) => r.foldable);
  const ownSavedGroups = valid.filter((r) => r.ownSaved > 0);
  const cardSavedGroups = valid.filter((r) => r.cardSaved > 0);
  const ownTotal = valid.reduce((acc, r) => acc + Math.max(0, r.ownSaved), 0);
  const cardTotal = valid.reduce((acc, r) => acc + Math.max(0, r.cardSaved), 0);
  return {
    groups: valid.length,
    skipped: rows.length - valid.length,
    foldable: foldable.length,
    // 机制判据：**输入确实同时命中 ≥2 个成员**时，折叠是否必然省行（ownSaved > 0 且与期望一致）
    foldableSaved: foldable.filter((r) => r.ownSaved > 0 && r.ownMatch).length,
    ownSavedGroups: ownSavedGroups.length,
    ownTotal,
    cardSavedGroups: cardSavedGroups.length,
    cardTotal,
    meanOwnSaved: ownSavedGroups.length > 0 ? ownTotal / ownSavedGroups.length : 0,
    meanCardSaved: cardSavedGroups.length > 0 ? cardTotal / cardSavedGroups.length : 0,
    distinctEpisodeGroups: valid.filter((r) => (r.distinctEpisodes ?? 0) >= 2).length,
    rows,
  };
}

/* ── 频率臂 ───────────────────────────────────────────────── */

/**
 * 频率臂：真库上随机抽 claim 正文当信号，统计"同一张卡里同组 ≥2 个成员成行"的概率。
 * @param {{real:object, groups:object[], samples?:number, seed?:number, limit?:number, budgetTokens?:number}} p
 */
export function frequencyArm({ real, groups = [], samples = DEFAULT_SAMPLES, seed = 20261105, limit = ENTRY_LIMIT, budgetTokens = BUDGET_TOKENS } = {}) {
  const groupMembers = groups
    .map((g) => ({ id: String(g.id), members: new Set(memberIdsOf(g)) }))
    .filter((g) => g.members.size >= 2);
  const pool = real.list('claims')
    .map((r) => r.record)
    .filter((c) => c && typeof c.text === 'string' && c.text.trim().length >= 20 && typeof c.scopeKey === 'string' && c.scopeKey !== '');
  const picked = sampleDeterministic(pool, samples, seed);
  const cache = createWalkCache(real);

  let hitSamples = 0;
  let multiGroupSamples = 0;
  const hitGroups = new Set();
  const examples = [];
  for (const claim of picked) {
    const signal = signalFromText(claim.text);
    const walkResult = walkFromSignals({ signal, store: real, scope: claim.scopeKey, depth: 2, limit, budgetTokens, cache });
    const card = buildMemoryCard({ cache, signal, walkResult, store: real, scope: claim.scopeKey, now: 1, limit, budgetTokens });
    const ids = new Set((card.claims ?? []).map((entry) => String(entry?.claim ?? entry?.claimId ?? '')));
    let hit = 0;
    for (const group of groupMembers) {
      let n = 0;
      for (const id of group.members) if (ids.has(id)) n += 1;
      if (n >= 2) {
        hit += 1;
        hitGroups.add(group.id);
      }
    }
    if (hit >= 1) {
      hitSamples += 1;
      if (hit >= 2) multiGroupSamples += 1;
      if (examples.length < 5) examples.push({ claimId: claim.id, groups: hit, rows: card.claims.length });
    }
  }

  const wilson = wilsonInterval(hitSamples, picked.length);
  return {
    samples: picked.length,
    pool: pool.length,
    seed,
    limit,
    budgetTokens,
    hits: hitSamples,
    multiGroupSamples,
    probability: picked.length > 0 ? hitSamples / picked.length : 0,
    wilson,
    groupsTouched: hitGroups.size,
    examples,
  };
}

/* ── 渲染 ─────────────────────────────────────────────────── */

const pct = (x) => `${(Number(x) * 100).toFixed(1)}%`;
const num = (x, d = 2) => Number(x).toFixed(d);

export function renderReport({ mechanism, frequency, shadowRoot, storeRoot, mergedCount }) {
  const lines = [];
  lines.push('# T202 · 合流「机制 vs 频率」分离报告（只读）');
  lines.push('');
  lines.push(`> 影库：\`${shadowRoot}\`（合并节点 ${mergedCount} 个）· 真库：\`${storeRoot}\``);
  lines.push(`> 生成于 \`[本] ${new Date().toISOString()}\`；只读，未写任何库。`);
  lines.push('');
  lines.push('## 一 · 机制臂（合流**能不能**省行）');
  lines.push('');
  lines.push(`- 合并组：**${mechanism.groups}** 组（跳过 ${mechanism.skipped} 组：成员解析不全）`);
  lines.push(`- 可折组（折叠前卡里本组 ≥2 个成员成行）：**${mechanism.foldable}** / ${mechanism.groups}` +
    `${mechanism.foldable > 0 ? ` · 其中真省行 **${mechanism.foldableSaved}/${mechanism.foldable} = ${pct(mechanism.foldableSaved / mechanism.foldable)}**` : ''}`);
  lines.push(`- **本组自身折叠**：省行的组 **${mechanism.ownSavedGroups}** / ${mechanism.groups} · 合计省 **${mechanism.ownTotal}** 行 · 平均 **${num(mechanism.meanOwnSaved)}** 行/省行组`);
  lines.push(`- **整张卡**（含同卡其它组的折叠）：省行的组 **${mechanism.cardSavedGroups}** / ${mechanism.groups} · 合计省 **${mechanism.cardTotal}** 行 · 平均 **${num(mechanism.meanCardSaved)}** 行/省行组`);
  lines.push(`- 成员分散在 ≥2 个 episode 的组：**${mechanism.distinctEpisodeGroups}** / ${mechanism.groups}` +
    '（同一 episode 只能成 1 行 ⇒ 这类组的成员天然折不动）');
  lines.push('');
  lines.push('| 合并组 | 成员 | 跨局 | 折叠前行 | 折叠后行 | 成员行(前→后) | 合并行 | 本组省行 | 整卡省行 | 判据自洽 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const row of mechanism.rows) {
    if (row.skipped) {
      lines.push(`| ${row.id} | ${row.members} | — | — | — | — | — | — | — | 跳过：${row.skipped} |`);
      continue;
    }
    lines.push(`| ${row.id} | ${row.members} | ${row.distinctEpisodes} | ${row.beforeRows} | ${row.afterRows} | ${row.memberRowsBefore}→${row.memberRowsAfter} | ${row.mergeRowRendered ? '✓' : '—'} | ${row.ownSaved} | ${row.cardSaved} | ${row.ownMatch ? '✓' : '✗'} |`);
  }
  lines.push('');
  lines.push('## 二 · 频率臂（真实分布里**多常**省行）');
  lines.push('');
  lines.push(`- 抽样：真库全部合格 claim **${frequency.pool}** 条中随机（LCG，seed=${frequency.seed}）抽 **${frequency.samples}** 条做信号；卡片口径 = 线上（limit=${frequency.limit} / budget=${frequency.budgetTokens}）`);
  lines.push(`- 命中：**${frequency.hits}** / ${frequency.samples} 张卡出现"同组 ≥2 个成员成行" ⇒ **p = ${pct(frequency.probability)}**`);
  lines.push(`- Wilson 95% 区间：**[${pct(frequency.wilson.lower)}, ${pct(frequency.wilson.upper)}]**（n=${frequency.wilson.n}）`);
  if (frequency.examples.length > 0) {
    lines.push(`- 命中样例：${frequency.examples.map((e) => `${e.claimId}(组=${e.groups},行=${e.rows})`).join(' · ')}`);
  } else {
    lines.push('- 命中样例：无');
  }
  lines.push('');
  return lines.join('\n');
}

export function buildReport({ shadowRoot, storeRoot, samples = DEFAULT_SAMPLES, seed = 20261105 } = {}) {
  const shadow = createStore({ root: shadowRoot });
  const real = createStore({ root: storeRoot });
  const mergedClaims = shadow.list('claims').map((r) => r.record).filter((c) => c && c.merge && Array.isArray(c.merge.members));
  const mechanism = mechanismArm({ shadow, mergedClaims });
  const frequency = frequencyArm({ real, groups: mergedClaims, samples, seed });
  return {
    version: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    shadowRoot,
    storeRoot,
    mergedCount: mergedClaims.length,
    mechanism,
    frequency,
  };
}

function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  if (flags.help) {
    process.stdout.write('用法：node scripts/merge-mechanism-report.mjs --shadow <shadowDir> --store <realDir> [--samples N] [--seed N] [--json]\n');
    return 0;
  }
  if (flags.error) {
    process.stderr.write(`${flags.error}\n`);
    return 2;
  }
  if (!flags.shadow || !flags.store) {
    process.stderr.write('缺少 --shadow / --store\n');
    return 2;
  }
  for (const dir of [flags.shadow, flags.store]) {
    if (!fs.existsSync(path.resolve(dir))) {
      process.stderr.write(`库不存在：${path.resolve(dir)}\n`);
      return 2;
    }
  }
  const report = buildReport({ shadowRoot: path.resolve(flags.shadow), storeRoot: path.resolve(flags.store), samples: flags.samples, seed: flags.seed });
  if (flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${renderReport(report)}\n`);
  return 0;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invoked) process.exitCode = main();

export { main };

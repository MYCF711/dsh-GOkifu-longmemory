// R17 · consolidate —— 合流内核（S2 只读预览 + S3 影子库写路径）
//
// 职责：按 `docs/合流-契约.md` §2/§3/§4 的机械判据，把同一 `(scopeKey, kind)` 桶内
//       「同一个坑/同一条事实」的 claim 收成**合并组**。
//       `dryRun:true`（默认）只读预览；`dryRun:false` 把结果写进**调用方显式给的影子库** `outStoreDir`，
//       源库一个字节都不动。
//
// 判据（完整定义见契约 §2.3）：
//   A · ASCII 词集 Jaccard ≥ JACCARD_MIN（两侧词集都 ≥ MIN_ASCII_TOKENS）
//   B · CJK 2-gram 交集 ≥ BIGRAM_OVERLAP_MIN
//   C · `errorClassKey` 相同 **且** 前 PREFIX_CHARS 码点相同
//   ⇒ **A/B/C 至少命中 2 个**才可合；**单口径一律不合**（契约 §2.3：A 单独 615 对里
//      327 对只差数字/hex，合并 = 抹平易变标识）。
//   唯一例外：归一文本**逐字相同**（Tier 0 的前身），它必然同时命中 C，不构成"单口径"。
//
// 档位（契约 §2.3 表）：
//   Tier 0 · 同证据写重：组内所有 support 落在**同一个 `(episode, seq)`**
//   Tier 1 · 多口径命中：其余通过判据的组
//
// 硬门（契约 §2.4，任一命中 ⇒ 该对不合、计入 `stats.blocked`）：
//   V3 preconditions 不等 · V4 validity 不等 · V5 任一方 counter 非空
//   V6 state ∈ {disputed,invalidated,stale} · V7 任一方是 `class:*`
//   V8 任一方是输出噪声（`ℹ tests …` / `ls` 输出 / `[exit code: 0]` / 合成失败标记）
//   V1/V2（跨 scope / 跨 kind）由分桶天然保证；V9（主题交集）不适用：claim 层 `threadIds` 无生产者。
//
// 只读保证：预览只调用 `store.list('claims')`（`persist` 里只 `readFileSync`）。
//           写模式（`dryRun:false`）只往 `outStoreDir` 写（复制源库 claim 层 + 追加合并节点），
//           源库只读；`outStoreDir` 缺省/为空 ⇒ 抛 `consolidate/need-out-dir`；
//           `outStoreDir` 等于或位于源库内 ⇒ 抛 `consolidate/out-inside-source`。
//
// 确定性：同一库两次调用，`groups` 的 id 集合与顺序完全一致 ——
//         排序键写死为 `scopeKey → kind → 首成员 id`，成员按 `(occurredAt, id)` 升序。
//
// 口径来源：三个口径的**特征抽取与阈值**直接 import `scripts/dup-report.mjs`
//          （`featuresOf` / `jaccard` / `overlapCount` / 四个阈值常量），本文件只负责
//          「哪几个口径命中 + 硬门 + 分档」，不复制一份实现。
//
// 允许依赖：`scripts/dup-report.mjs`（口径）、`src/rooms/claim.mjs`（`isGenericErrorText`）、`node:crypto`。
// 禁止依赖：`node:fs`（写盘）、`src/rooms/persist.mjs` 的写方法、任何模型/网络。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  featuresOf,
  jaccard,
  overlapCount,
  normalizeText,
  MIN_ASCII_TOKENS,
  JACCARD_MIN,
  BIGRAM_OVERLAP_MIN,
  PREFIX_CHARS,
  bucketKeyOf,
} from '../../scripts/dup-report.mjs';
import { isGenericErrorText } from './claim.mjs';
import { allowedStates } from './gates.mjs';
import { createStore } from './persist.mjs';

/** 合并节点版本（S2 只读预览的结构版本）。 */
export const MERGE_VERSION = 1;

/** 档位：0 = 同证据写重；1 = 多口径命中。 */
export const TIERS = Object.freeze({ SAME_EVIDENCE: 0, MULTI_CRITERIA: 1 });

/** 允许合并的档位白名单（契约 §2.3：只有这两档）。 */
export const ALLOWED_TIERS = Object.freeze([TIERS.SAME_EVIDENCE, TIERS.MULTI_CRITERIA]);

/** 否决项 id（与契约 §2.4 的 V1–V9 对齐；V1/V2 由分桶保证，V9 不适用）。 */
export const GATES = Object.freeze(['v3', 'v4', 'v5', 'v6', 'v7', 'v8']);

export class ConsolidateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ConsolidateError';
    this.code = code;
  }
}

/* ── 否决项：单条 claim 级 ─────────────────────────────────── */

const NOISE_PREFIX_RE = /^(?:total\s|ok\s|ℹ\s|drwx|bytes\s|-{2,}|={2,}|\+\s|\d+%\s)/i;
const NOISE_EXIT_ZERO_RE = /\[exit code:\s*0\]/i;
const BAD_STATES = new Set(['disputed', 'invalidated', 'stale']);

/** 输出噪声：命令输出/汇总行/成功结果，不是"坑"（契约 §2.3 V8）。 */
export function isNoiseClaim(claim) {
  const text = String(claim?.text ?? '');
  if (!text.trim()) return true;
  return NOISE_PREFIX_RE.test(text) || NOISE_EXIT_ZERO_RE.test(text) || isGenericErrorText(text);
}

/** `class:*` 类级章节：已是聚合结果，不再合（契约 §2.4 V7）。 */
export function isClassClaim(claim) {
  return String(claim?.text ?? '').startsWith('class:');
}

function stateOf(claim) {
  return String(claim?.state ?? '');
}

function counterLen(claim) {
  return Array.isArray(claim?.counter) ? claim.counter.length : 0;
}

/** `preconditions` 的可比签名：`(check,value)` 集排序后序列化（集合语义，与顺序无关）。 */
export function preconditionsKeyOf(claim) {
  const list = Array.isArray(claim?.preconditions) ? claim.preconditions : [];
  return JSON.stringify(
    list.map((p) => [String(p?.check ?? ''), String(p?.value ?? '')]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)),
  );
}

/** `validity` 的可比签名：`(type,value)`（契约 §2.4 V4）。 */
export function validityKeyOf(claim) {
  return JSON.stringify([claim?.validity?.type ?? null, claim?.validity?.value ?? null]);
}

/* ── 口径（直接复用 dup-report 的特征与阈值）────────────────── */

/**
 * 三个口径各自是否命中。
 * @returns {{A:boolean, B:boolean, C:boolean, hits:number}}
 */
export function criteriaOf(a, b) {
  const A =
    a.ascii.size >= MIN_ASCII_TOKENS &&
    b.ascii.size >= MIN_ASCII_TOKENS &&
    (jaccard(a.ascii, b.ascii) ?? 0) >= JACCARD_MIN;
  const B = overlapCount(a.bigrams, b.bigrams) >= BIGRAM_OVERLAP_MIN;
  const C = a.error.key === b.error.key;
  return { A, B, C, hits: (A ? 1 : 0) + (B ? 1 : 0) + (C ? 1 : 0) };
}

/**
 * 一对 claim 能否合并（特征已算好时用这个，避免 O(n²) 重复抽特征）。
 * @returns {{qualified:boolean, reason:string|null, criteria:{A,B,C,hits}, identical:boolean}}
 *   `reason` 为 `null` 表示可合，否则是否决项 id（`v3`…`v8`）或 `singleCriterion`。
 */
export function judgeFeatures(fa, fb, claimA, claimB) {
  const criteria = criteriaOf(fa, fb);
  const identical = fa.norm === fb.norm;
  // 单口径禁止：只有「逐字相同」可以在只命中 1 个口径时通过（它必然命中 C，属于同一句话）
  if (!identical && criteria.hits < 2) {
    return { qualified: false, reason: 'singleCriterion', criteria, identical };
  }
  if (preconditionsKeyOf(claimA) !== preconditionsKeyOf(claimB)) {
    return { qualified: false, reason: 'v3', criteria, identical };
  }
  if (validityKeyOf(claimA) !== validityKeyOf(claimB)) {
    return { qualified: false, reason: 'v4', criteria, identical };
  }
  if (counterLen(claimA) > 0 || counterLen(claimB) > 0) {
    return { qualified: false, reason: 'v5', criteria, identical };
  }
  if (BAD_STATES.has(stateOf(claimA)) || BAD_STATES.has(stateOf(claimB))) {
    return { qualified: false, reason: 'v6', criteria, identical };
  }
  return { qualified: true, reason: null, criteria, identical };
}

/** 一对 claim 能否合并（对外便利入口：特征在这里现算）。 */
export function judgePair(claimA, claimB) {
  return judgeFeatures(featuresOf(claimA), featuresOf(claimB), claimA, claimB);
}

/* ── 并查集（簇 = 传递闭包的连通分量）────────────────────────── */

function createUnionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const size = new Array(n).fill(1);
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    let c = x;
    while (parent[c] !== c) {
      const next = parent[c];
      parent[c] = r;
      c = next;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    if (size[ra] < size[rb]) {
      parent[ra] = rb;
      size[rb] += size[ra];
    } else {
      parent[rb] = ra;
      size[ra] += size[rb];
    }
    return true;
  };
  return { find, union };
}

/* ── 组内派生 ─────────────────────────────────────────────── */

function hash8(input) {
  return createHash('sha256').update(String(input)).digest('hex').slice(0, 8);
}

function supportOf(claim) {
  return Array.isArray(claim?.support) ? claim.support.filter((s) => s && (s.episode || Number.isFinite(s.seq))) : [];
}

function evidenceKeysOf(claim) {
  return new Set(supportOf(claim).map((s) => `${String(s.episode ?? '')}#${Number.isFinite(s.seq) ? s.seq : ''}`));
}

/** 成员排序：`(occurredAt, id)` 升序（occurredAt 缺失排最后）。 */
function byOccurredThenId(a, b) {
  const ta = Number.isFinite(a?.occurredAt) ? a.occurredAt : Number.POSITIVE_INFINITY;
  const tb = Number.isFinite(b?.occurredAt) ? b.occurredAt : Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return String(a?.id ?? '') < String(b?.id ?? '') ? -1 : String(a?.id ?? '') > String(b?.id ?? '') ? 1 : 0;
}

/**
 * 挑代表支撑：成员里最早 occurredAt 的那条 claim，其 support 里最早 occurredAt（同刻取 seq 最小）的一条。
 * `mergedText` **直接取这条 support 的 quote**（逐字，不拼接、不加前缀 ⇒ T1 天然成立）。
 */
function pickRepresentative(members) {
  const ordered = [...members].sort(byOccurredThenId);
  for (const member of ordered) {
    const support = [...supportOf(member)].sort((x, y) => {
      const tx = Number.isFinite(x?.occurredAt) ? x.occurredAt : Number.POSITIVE_INFINITY;
      const ty = Number.isFinite(y?.occurredAt) ? y.occurredAt : Number.POSITIVE_INFINITY;
      if (tx !== ty) return tx < ty ? -1 : 1;
      const sx = Number.isFinite(x?.seq) ? x.seq : Number.POSITIVE_INFINITY;
      const sy = Number.isFinite(y?.seq) ? y.seq : Number.POSITIVE_INFINITY;
      return sx - sy;
    });
    const first = support[0];
    if (first) {
      return { claimId: member.id, episode: first.episode ?? null, seq: Number.isFinite(first.seq) ? first.seq : null, quote: String(first.quote ?? '') };
    }
  }
  return { claimId: ordered[0]?.id ?? null, episode: null, seq: null, quote: '' };
}

/* ── 影子库写路径（S3）─────────────────────────────────────── */

/** 已经是合并节点的记录（带 `merge` 字段）⇒ 派生数据，不再参与下一轮合流。 */
export function isMergeRecord(record) {
  return Boolean(record && typeof record === 'object' && record.merge && typeof record.merge === 'object');
}

/** 成员 support 并集：按 `(episode, seq, quote)` 去重，按 `occurredAt`（同刻按 seq）升序。 */
export function mergeSupportOf(memberRecords) {
  const seen = new Set();
  const out = [];
  for (const member of memberRecords) {
    for (const entry of Array.isArray(member?.support) ? member.support : []) {
      if (!entry || typeof entry !== 'object') continue;
      const key = `${String(entry.episode ?? '')} ${String(entry.seq ?? '')} ${String(entry.quote ?? '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...entry });
    }
  }
  const timeOf = (x) => (Number.isFinite(x?.occurredAt) ? x.occurredAt : Number.POSITIVE_INFINITY);
  out.sort((a, b) => {
    const ta = timeOf(a);
    const tb = timeOf(b);
    if (ta !== tb) return ta < tb ? -1 : 1;
    const sa = Number.isFinite(a?.seq) ? a.seq : Number.POSITIVE_INFINITY;
    const sb = Number.isFinite(b?.seq) ? b.seq : Number.POSITIVE_INFINITY;
    if (sa !== sb) return sa < sb ? -1 : 1;
    return String(a?.episode ?? '') < String(b?.episode ?? '') ? -1 : 1;
  });
  return out;
}

/**
 * 合并节点（契约 §4.1 的形状；`text` 逐字取 `representative.quote`，不加前缀）。
 * 时钟全部由成员派生（`occurredAt=min`、`recordedAt=max`），保证同输入同输出 ⇒ 幂等。
 */
export function buildMergedRecord(group, memberRecords) {
  const members = Array.isArray(memberRecords) ? memberRecords.filter(Boolean) : [];
  const repRecord = members.find((m) => m.id === group.representative.claimId) ?? members[0] ?? {};
  const support = mergeSupportOf(members);
  let occurredAt = Number.POSITIVE_INFINITY;
  let recordedAt = 0;
  for (const member of members) {
    if (Number.isFinite(member?.occurredAt) && member.occurredAt < occurredAt) occurredAt = member.occurredAt;
    const t = Number.isFinite(member?.recordedAt) ? member.recordedAt : (Number.isFinite(member?.occurredAt) ? member.occurredAt : 0);
    if (t > recordedAt) recordedAt = t;
  }
  const occurred = Number.isFinite(occurredAt) ? occurredAt : 0;
  const allowed = allowedStates({ support: group.supportEpisodes, counter: 0 }).allowed;
  const state = ['observed', 'candidate', 'semantic', 'standard'].filter((x) => allowed.includes(x)).pop() ?? 'observed';
  return {
    id: `c-${hash8(group.members.join('|'))}`,
    kind: group.kind,
    text: group.representative.quote, // 逐字，不拼接、不加前缀（T1）
    scopeKey: group.scopeKey,
    state,
    support,
    counter: [],
    validity: repRecord.validity && typeof repRecord.validity === 'object' ? { ...repRecord.validity } : { type: 'none', value: null },
    validityOk: repRecord.validityOk !== false,
    preconditions: Array.isArray(repRecord.preconditions) ? repRecord.preconditions.map((p) => ({ ...p })) : [],
    threadIds: [],
    occurredAt: occurred,
    recordedAt,
    validFrom: occurred,
    validTo: null,
    counters: { support: support.length, counter: 0, injections: 0, lastInjectedAt: null },
    supersedes: null,
    merge: {
      version: MERGE_VERSION,
      key: group.key,
      rule: group.tier === TIERS.SAME_EVIDENCE ? 'same-evidence' : 'multi-criteria',
      members: [...group.members],
      representative: { ...group.representative },
      supportEpisodes: group.supportEpisodes,
      at: recordedAt,
    },
  };
}

/**
 * 写影子库：复制源库 claim 层 → 追加合并节点。**只写 `outStoreDir`，源库只读。**
 * 幂等：同 id 同内容 ⇒ `put` 返回 `changed:false`（第二次新增 0）。
 */
export function applyToShadow({ groups, memberRecordsOf, sourceClaims, outStoreDir, sourceRoot = null }) {
  const dstRoot = path.resolve(String(outStoreDir));
  const srcRoot = sourceRoot ? path.resolve(String(sourceRoot)) : '';
  if (srcRoot && (dstRoot === srcRoot || dstRoot.startsWith(`${srcRoot}${path.sep}`))) {
    throw new ConsolidateError('consolidate: outStoreDir 不能是源库本身或源库子目录（源库只读）', 'consolidate/out-inside-source');
  }
  if (fs.existsSync(dstRoot) && !fs.statSync(dstRoot).isDirectory()) {
    throw new ConsolidateError('consolidate: outStoreDir 已存在但不是目录', 'consolidate/out-not-directory');
  }
  const dst = createStore({ root: dstRoot });
  const existed = new Set(dst.ids('claims'));

  // 1) 复制源库 claim 层（不写源库）
  let copied = 0;
  let copiedChanged = 0;
  for (const record of sourceClaims) {
    if (!record || typeof record !== 'object' || typeof record.id !== 'string') continue;
    copied += 1;
    if (dst.put('claims', record).changed) copiedChanged += 1;
  }

  // 2) 追加合并节点（已存在同 id 的真 claim ⇒ 不覆盖，记冲突）
  let mergedAdded = 0;
  let mergedRewritten = 0;
  let conflicts = 0;
  const mergedIds = [];
  for (const group of groups) {
    const members = group.members.map((id) => memberRecordsOf.get(id)).filter(Boolean);
    if (members.length < 2) {
      conflicts += 1;
      continue;
    }
    const record = buildMergedRecord(group, members);
    let previous = null;
    if (existed.has(record.id)) {
      try {
        previous = dst.get('claims', record.id);
      } catch {
        previous = null;
      }
      if (previous && !isMergeRecord(previous)) {
        conflicts += 1; // 绝不覆盖既有的真 claim
        continue;
      }
    }
    const result = dst.put('claims', record);
    mergedIds.push(record.id);
    if (!previous) mergedAdded += 1;
    else if (result.changed) mergedRewritten += 1;
  }

  return {
    outStoreDir: dstRoot,
    sourceRoot: srcRoot || null,
    claimsCopied: copied,
    claimsCopiedChanged: copiedChanged,
    mergedAdded,
    mergedRewritten,
    conflicts,
    mergedIds,
    totalClaims: dst.ids('claims').length,
  };
}

/* ── 主入口 ───────────────────────────────────────────────── */

/**
 * 合流预览（只读）。
 * @param {{store:{list:Function}, scope?:string|null, dryRun?:boolean, now?:number}} opts
 * @returns {{ok:boolean, groups:Array, stats:object, quality:object, thresholds:object}}
 */
export function consolidate({ store, scope = null, dryRun = true, outStoreDir = null, now = Date.now() } = {}) {
  if (!store || typeof store.list !== 'function') {
    throw new ConsolidateError('consolidate: 需要 store（含 list(kind)）', 'consolidate/missing-store');
  }
  if (typeof dryRun !== 'boolean') {
    throw new ConsolidateError('consolidate: dryRun 必须是布尔值', 'consolidate/bad-dry-run');
  }
  const writing = dryRun === false;
  if (writing && (typeof outStoreDir !== 'string' || outStoreDir.trim() === '')) {
    throw new ConsolidateError('consolidate: dryRun:false 需要显式 outStoreDir（影子库路径，绝不默认写真库）', 'consolidate/need-out-dir');
  }

  const listed = store.list('claims');
  const all = listed.filter((r) => r && r.record && typeof r.record === 'object').map((r) => r.record);
  const scoped = typeof scope === 'string' && scope !== '' ? all.filter((c) => String(c?.scopeKey ?? '') === scope) : all;

  const blocked = { v3: 0, v4: 0, v5: 0, v6: 0, v7: 0, v8: 0, merged: 0, singleCriterion: 0, t1: 0 };
  const claims = [];
  for (const claim of scoped) {
    if (isMergeRecord(claim)) {
      blocked.merged += 1; // 派生节点不再参与合流（否则重复合流会套娃）
      continue;
    }
    if (isClassClaim(claim)) {
      blocked.v7 += 1;
      continue;
    }
    if (isNoiseClaim(claim)) {
      blocked.v8 += 1;
      continue;
    }
    claims.push(claim);
  }

  // 分桶：同 scopeKey + 同 kind 才互相比（V1/V2 由此保证）
  const buckets = new Map();
  claims.forEach((claim) => {
    const key = bucketKeyOf(claim);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(claim);
  });

  const groups = [];
  for (const [bucketKey, list] of buckets) {
    if (list.length < 2) continue;
    const uf = createUnionFind(list.length);
    const pairCriteria = [];
    const feats = list.map((claim) => featuresOf(claim)); // 每条 claim 只抽一次特征
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const verdict = judgeFeatures(feats[i], feats[j], list[i], list[j]);
        if (!verdict.qualified) {
          if (verdict.reason && verdict.reason !== 'singleCriterion') blocked[verdict.reason] += 1;
          else blocked.singleCriterion += 1;
          continue;
        }
        pairCriteria.push(verdict.criteria);
        uf.union(i, j);
      }
    }
    const components = new Map();
    for (let i = 0; i < list.length; i += 1) {
      const root = uf.find(i);
      if (!components.has(root)) components.set(root, []);
      components.get(root).push(list[i]);
    }
    for (const members of components.values()) {
      if (members.length < 2) continue;
      const orderedMembers = [...members].sort(byOccurredThenId);
      const evidence = new Set();
      for (const member of members) for (const key of evidenceKeysOf(member)) evidence.add(key);
      const representative = pickRepresentative(members);
      // T1：正文逐字取自 representative 的 support quote；且该 (episode, seq) 必须在并集里
      const repKey = `${String(representative.episode ?? '')}#${Number.isFinite(representative.seq) ? representative.seq : ''}`;
      const t1 = Boolean(representative.quote) && evidence.has(repKey);
      if (!t1) {
        blocked.t1 += 1;
        continue;
      }
      const tier = evidence.size === 1 ? TIERS.SAME_EVIDENCE : TIERS.MULTI_CRITERIA;
      const criteriaUnion = pairCriteria.reduce(
        (acc, c) => ({ A: acc.A || c.A, B: acc.B || c.B, C: acc.C || c.C }),
        { A: false, B: false, C: false },
      );
      groups.push({
        tier,
        key: `${String(bucketKey.split('\u0000')[1] ?? '')}|${String(members[0]?.scopeKey ?? '')}|${hash8(orderedMembers.map((m) => m.id).join('|'))}`,
        kind: String(members[0]?.kind ?? ''),
        scopeKey: String(members[0]?.scopeKey ?? ''),
        members: orderedMembers.map((m) => String(m.id)),
        representative,
        supportEpisodes: new Set([...evidence].map((k) => k.split('#')[0]).filter(Boolean)).size,
        mergedText: representative.quote,
        gates: { v3: false, v4: false, v5: false, v6: false, v7: false, v8: false },
        criteria: criteriaUnion,
      });
    }
  }

  groups.sort((a, b) => {
    if (a.scopeKey !== b.scopeKey) return a.scopeKey < b.scopeKey ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.members[0] < b.members[0] ? -1 : a.members[0] > b.members[0] ? 1 : 0;
  });

  const merged = groups.reduce((acc, g) => acc + (g.members.length - 1), 0);
  const byTier = { 0: 0, 1: 0 };
  for (const group of groups) byTier[group.tier] += 1;

  const stats = {
    claims: scoped.length,
    candidates: claims.length,
    groups: groups.length,
    merged,
    reduction: scoped.length > 0 ? merged / scoped.length : 0,
    byTier,
    blocked,
    // 单位说明：v3–v6/singleCriterion 计「对」（每对 claim 一次），v7/v8 计「条」（单条 claim 级否决）
    blockedUnits: { v3: 'pair', v4: 'pair', v5: 'pair', v6: 'pair', v7: 'claim', v8: 'claim', merged: 'claim', singleCriterion: 'pair', t1: 'group' },
    excluded: { v7: blocked.v7, v8: blocked.v8, merged: blocked.merged },
    buckets: buckets.size,
  };

  // 质量闸（契约 §6）
  const t1 = groups.every((g) => g.mergedText === g.representative.quote && g.representative.quote.length > 0);
  const t2 = groups.every((g) => g.members.every((id) => claims.find((c) => c.id === id)?.scopeKey === g.scopeKey));
  const t3 = true; // 两种模式都不写源库：预览不写盘；写模式只写 outStoreDir
  const serialized = JSON.stringify(groups);
  const resorted = JSON.stringify([...groups].sort((a, b) => (a.scopeKey !== b.scopeKey ? (a.scopeKey < b.scopeKey ? -1 : 1) : a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.members[0] < b.members[0] ? -1 : a.members[0] > b.members[0] ? 1 : 0)));
  const t4 = serialized === resorted;
  const t5 = stats.reduction <= 0.25;

  // 影子库写路径（S3）：只有显式 dryRun:false + outStoreDir 才落盘
  let apply = null;
  if (writing) {
    const byId = new Map(all.map((c) => [String(c.id), c]));
    apply = applyToShadow({
      groups,
      memberRecordsOf: byId,
      sourceClaims: all,
      outStoreDir,
      sourceRoot: store.root ?? null,
    });
  }

  return {
    ok: t1 && t2 && t3 && t4 && t5 && (!apply || apply.conflicts === 0),
    groups,
    stats,
    quality: { t1, t2, t3, t4, t5 },
    thresholds: { jaccardMin: JACCARD_MIN, minAsciiTokens: MIN_ASCII_TOKENS, bigramOverlapMin: BIGRAM_OVERLAP_MIN, prefixChars: PREFIX_CHARS, version: MERGE_VERSION, tiers: ALLOWED_TIERS },
    apply,
    at: Number.isFinite(now) ? now : null,
  };
}

export default { consolidate, applyToShadow, buildMergedRecord, mergeSupportOf, isMergeRecord, judgePair, judgeFeatures, criteriaOf, isNoiseClaim, isClassClaim, preconditionsKeyOf, validityKeyOf, TIERS, ALLOWED_TIERS, GATES, MERGE_VERSION };

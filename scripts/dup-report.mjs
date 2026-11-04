#!/usr/bin/env node
/**
 * T145 重复度体检（只读）：先量清 claim 库「到底有多重复」，再为 `方案.md` §14 合流定阈值。
 *
 * 为什么要有它：合流（consolidation）的阈值不能拍脑袋。这个脚本只做一件事 —— 用**三种机械口径**
 * 把同一 `scopeKey` + 同一 `kind` 桶内两两比较一遍，给出「疑似重复对数 / 涉及 claim 数 / 可合并降幅」。
 * 全部口径可复算、无模型判断、无写入。
 *
 * 三种口径（分子 / 分母写进报告）：
 *   A · ASCII 词集 Jaccard ≥ 0.6
 *       特征：小写文本按非 `[a-z0-9_]` 切词、长度 ≥2、丢弃 `EN_STOPWORDS`（虚词与代码关键字）
 *       分子：Jaccard ≥ 0.6 的对     分母：两侧词集都 ≥2 个词、可比较的对
 *   B · 判别词（CJK 2-gram）交集 ≥ 4
 *       特征：CJK 连串切 2-gram，丢掉「含 CJK_STOP_CHARS 虚字」与「本身在 CJK_STOPWORDS」的 gram
 *       分子：交集 ≥ 4 的对          分母：两侧 2-gram 集都非空、可比较的对
 *   C · 错误类键相同 + 文本前 40 字相同
 *       特征：`errorClassKeyOf(text)`（R04 的已知协议类）+ 空白归一后的前 40 个码点
 *       分子：key 相同（类相同且前缀相同，或两边都无类且前缀相同）的对
 *       分母：桶内全部可比较的对（C 不需要特征集非空）
 *
 * 分桶：**只比同 `scopeKey` + 同 `kind`**。跨作用域不合并（方案 §4.10：w: 层不自动上升），
 * 跨 kind 不合并（一条 antipattern 与一条 fact 说的是不同层次的结论）。
 *
 * 降幅粗估：把命中关系取传递闭包（并查集）得到「重复簇」，簇内 N 条合 1 条 ⇒ 少 N-1 条；
 * 合计 = Σ(簇内条数-1)。这是**上界式的粗估**（同一对可能同时被 A/B/C 命中，并集去重后再算一遍）。
 *
 * 只读保证：只用 `createStore({root}).list('claims')`（该路径只 `readFileSync`，不 `mkdir`/`write`），
 * 不调用 `put/replaceDerived/rebuild/writeManifest/cleanupTmp`。
 *
 * 用法：
 *   node scripts/dup-report.mjs                     # Markdown 报表到 stdout
 *   node scripts/dup-report.mjs --json              # 结构化结果
 *   node scripts/dup-report.mjs --scope <scopeKey>  # 只看一个作用域
 *   node scripts/dup-report.mjs --root <dir>        # 指向别的 memory-context（测试/多库）
 * 退出码：0 有结果（哪怕是 0 重复）；2 库不存在（不伪造 0）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { errorClassKeyOf, CJK_STOPWORDS, CJK_STOP_CHARS, EN_STOPWORDS } from '../src/rooms/topic.mjs';

const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');

/** 口径 A 阈值：ASCII 词集 Jaccard。 */
export const JACCARD_MIN = 0.6;
/** 口径 A：词集少于这个数就不参与比较（单词集合的 Jaccard 无意义）。 */
export const MIN_ASCII_TOKENS = 2;
/** 口径 B 阈值：CJK 2-gram 交集个数。 */
export const BIGRAM_OVERLAP_MIN = 4;
/** 口径 C：前缀取多少个码点。 */
export const PREFIX_CHARS = 40;
/** 每个口径展示的簇数。 */
export const TOP_CLUSTERS = 5;
/** 每个簇展示的成员数。 */
export const CLUSTER_MEMBERS = 3;
/** 成员摘要取前多少个码点。 */
export const SNIPPET_CHARS = 60;

/* ── 特征抽取（每条 claim 只算一次）───────────────────────── */

const ASCII_TOKEN_RE = /[a-z0-9_]{2,}/g;
const CJK_RUN_RE = /[\u4e00-\u9fff]+/g;

/** 让文本可比：折叠空白、去首尾。**只在特征/前缀上用，不用于输出**。 */
export function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 前 N 个码点（按字，不按字节）。 */
export function prefixOf(text, n = PREFIX_CHARS) {
  const s = normalizeText(text);
  return [...s].slice(0, n).join('');
}

/** 口径 A 特征：ASCII 词集（小写、去 EN_STOPWORDS、去纯数字串）。 */
export function asciiTokensOf(text) {
  const out = new Set();
  for (const tok of normalizeText(text).toLowerCase().match(ASCII_TOKEN_RE) ?? []) {
    if (EN_STOPWORDS.has(tok)) continue;
    if (/^\d+$/.test(tok)) continue;
    out.add(tok);
  }
  return out;
}

/** 口径 B 特征：CJK 2-gram 集（丢虚字 gram 与停用 gram）。 */
export function cjkBigramsOf(text) {
  const out = new Set();
  for (const run of normalizeText(text).match(CJK_RUN_RE) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const gram = run.slice(i, i + 2);
      if (CJK_STOP_CHARS.has(gram[0]) || CJK_STOP_CHARS.has(gram[1])) continue;
      if (CJK_STOPWORDS.has(gram)) continue;
      out.add(gram);
    }
  }
  return out;
}

/** 口径 C 特征：`错误类|前40字`。类可能为 null —— 那就退化成"纯前缀相同"。 */
export function errorPrefixKeyOf(text) {
  const cls = errorClassKeyOf(text);
  return { cls, key: `${cls ?? '-'}|${prefixOf(text)}` };
}

/**
 * 把"数字 / 长十六进制 id"抹平：用来区分「同一句话」与「只差一个版本号/行号/job id」。
 * 这不是第四个口径，只是给命中对做**差异形态归类**，让人看清阈值到底抓到了什么。
 */
export function literalMask(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, '<hex>')
    .replace(/\d+/g, '<n>');
}

/** 一条 claim 的全部特征。 */
export function featuresOf(claim) {
  const text = String(claim?.text ?? '');
  const norm = normalizeText(text).toLowerCase();
  return {
    ascii: asciiTokensOf(text),
    bigrams: cjkBigramsOf(text),
    error: errorPrefixKeyOf(text),
    norm,
    lit: literalMask(text),
  };
}

/** 命中对的文本差异形态：`identical` 完全相同 · `digits-differ` 只差数字/十六进制 id · `other` 其余。 */
export function diffKindOf(a, b) {
  if (a.norm === b.norm) return 'identical';
  if (a.lit === b.lit) return 'digits-differ';
  return 'other';
}

/* ── 相似度 ───────────────────────────────────────────────── */

/** Jaccard：|A∩B| / |A∪B|；任一侧为空返回 null（n/a，不进分母）。 */
export function jaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return null;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** 交集个数。 */
export function overlapCount(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (large.has(x)) inter += 1;
  return inter;
}

/* ── 分桶与两两比较 ───────────────────────────────────────── */

/** 桶键：`<scopeKey>\u0000<kind>`。同一 scope+kind 才互相比。 */
export function bucketKeyOf(claim) {
  return `${String(claim?.scopeKey ?? '')}\u0000${String(claim?.kind ?? '')}`;
}

/** 并查集（簇 = 传递闭包的连通分量）。 */
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

/** 把命中的 (i,j) 边聚成簇。 */
function clustersOf(n, pairs) {
  const uf = createUnionFind(n);
  for (const [i, j] of pairs) uf.union(i, j);
  const groups = new Map();
  for (let i = 0; i < n; i += 1) {
    const r = uf.find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .sort((a, b) => b.length - a.length || a[0] - b[0]);
}

/**
 * 核心：读 claim → 分桶 → 三口径两两比较 → 聚簇。
 * @param {{root: string, scope?: string|null, now?: number}} opts
 * @returns {object} 报表结构（不含渲染）
 */
export function buildDupReport({ root, scope = null, now = Date.now() } = {}) {
  const started = Date.now();
  const store = createStore({ root });
  const listed = store.list('claims'); // 只读：文件不存在返回 []，损坏条目带 error 字段不抛
  const corrupt = listed.filter((r) => !r.record);
  let claims = listed.filter((r) => r.record).map((r) => r.record);
  if (typeof scope === 'string' && scope !== '') claims = claims.filter((c) => String(c.scopeKey ?? '') === scope);

  // 分桶（同 scope + 同 kind）：桶内保存**全库下标**，避免比较时再查一遍（O(n²) 会拖死 70 万对）
  const buckets = new Map();
  claims.forEach((claim, index) => {
    const key = bucketKeyOf(claim);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(index);
  });

  const metrics = {
    A: { id: 'A', pairs: [], comparable: 0, hits: 0, diff: { identical: 0, 'digits-differ': 0, other: 0 } },
    B: { id: 'B', pairs: [], comparable: 0, hits: 0, diff: { identical: 0, 'digits-differ': 0, other: 0 } },
    C: { id: 'C', pairs: [], comparable: 0, hits: 0, diff: { identical: 0, 'digits-differ': 0, other: 0 } },
  };
  const unionPairs = [];
  let cByClass = 0;
  let cByPrefixOnly = 0;

  for (const [bucketKey, list] of buckets) {
    if (list.length < 2) continue;
    // 特征按桶预取：一条 claim 只属于一个桶，所以每条只算一次
    const feats = list.map((idx) => featuresOf(claims[idx]));
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = feats[i];
        const b = feats[j];
        const hi = list[i];
        const hj = list[j];

        // 口径 A
        if (a.ascii.size >= MIN_ASCII_TOKENS && b.ascii.size >= MIN_ASCII_TOKENS) {
          metrics.A.comparable += 1;
          const sim = jaccard(a.ascii, b.ascii);
          if (sim !== null && sim >= JACCARD_MIN) {
            metrics.A.hits += 1;
            const dk = diffKindOf(a, b);
            metrics.A.diff[dk] += 1;
            metrics.A.pairs.push({ bucketKey, i: hi, j: hj, score: sim, diffKind: dk });
            unionPairs.push({ i: hi, j: hj, metric: 'A', score: sim, diffKind: dk });
          }
        }

        // 口径 B
        if (a.bigrams.size > 0 && b.bigrams.size > 0) {
          metrics.B.comparable += 1;
          const overlap = overlapCount(a.bigrams, b.bigrams);
          if (overlap >= BIGRAM_OVERLAP_MIN) {
            metrics.B.hits += 1;
            const dk = diffKindOf(a, b);
            metrics.B.diff[dk] += 1;
            metrics.B.pairs.push({ bucketKey, i: hi, j: hj, score: overlap, diffKind: dk });
            unionPairs.push({ i: hi, j: hj, metric: 'B', score: overlap, diffKind: dk });
          }
        }

        // 口径 C
        metrics.C.comparable += 1;
        if (a.error.key === b.error.key) {
          metrics.C.hits += 1;
          if (a.error.cls !== null && a.error.cls === b.error.cls) cByClass += 1;
          else cByPrefixOnly += 1;
          const dk = diffKindOf(a, b);
          metrics.C.diff[dk] += 1;
          metrics.C.pairs.push({ bucketKey, i: hi, j: hj, score: 1, cls: a.error.cls ?? null, diffKind: dk });
          unionPairs.push({ i: hi, j: hj, metric: 'C', score: 1, diffKind: dk });
        }
      }
    }
  }

  const summarize = (key, pairs, comparable) => {
    const involved = new Set();
    for (const p of pairs) {
      involved.add(p.i);
      involved.add(p.j);
    }
    const clusters = clustersOf(claims.length, pairs.map((p) => [p.i, p.j]));
    const reduction = clusters.reduce((acc, g) => acc + (g.length - 1), 0);
    return {
      metric: key,
      pairs: pairs.length,
      pairs_raw: pairs,
      comparablePairs: comparable,
      hitRate: comparable > 0 ? pairs.length / comparable : 0,
      involvedClaims: involved.size,
      involvedShare: claims.length > 0 ? involved.size / claims.length : 0,
      clusters: clusters.length,
      largestCluster: clusters.length > 0 ? clusters[0].length : 0,
      reduction,
      reductionShare: claims.length > 0 ? reduction / claims.length : 0,
      diff: { ...metrics[key].diff },
      clusters_raw: clusters,
    };
  };

  const out = {
    generatedAt: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
    storeLabel: 'memory-context',
    scope: typeof scope === 'string' && scope !== '' ? scope : null,
    thresholds: { jaccardMin: JACCARD_MIN, bigramOverlapMin: BIGRAM_OVERLAP_MIN, prefixChars: PREFIX_CHARS },
    totals: {
      claims: claims.length,
      corruptFiles: corrupt.length,
      buckets: buckets.size,
      largestBucket: buckets.size > 0 ? Math.max(...[...buckets.values()].map((b) => b.length)) : 0,
      byKind: countBy(claims, (c) => String(c.kind ?? '(none)')),
      byScope: countBy(claims, (c) => String(c.scopeKey ?? '(none)')),
    },
    metrics: {
      A: summarize('A', metrics.A.pairs, metrics.A.comparable),
      B: summarize('B', metrics.B.pairs, metrics.B.comparable),
      C: summarize('C', metrics.C.pairs, metrics.C.comparable),
    },
    cBreakdown: { byErrorClass: cByClass, byPrefixOnly: cByPrefixOnly },
    union: null,
    flags: { claims, found: claims.length, pairs: unionPairs },
    claimsIndex: claims,
    elapsedMs: Date.now() - started,
  };

  // 三口径并集（去重同一对，多口径命中的对记下来供人看）
  const pairKey = new Map();
  for (const p of unionPairs) {
    const k = `${Math.min(p.i, p.j)}:${Math.max(p.i, p.j)}`;
    if (!pairKey.has(k)) pairKey.set(k, { i: Math.min(p.i, p.j), j: Math.max(p.i, p.j), metrics: new Set(), score: 0, diffKind: p.diffKind });
    const rec = pairKey.get(k);
    rec.metrics.add(p.metric);
    rec.score = Math.max(rec.score, Number(p.score) || 0);
  }
  const unionList = [...pairKey.values()].map((p) => ({ ...p, metrics: [...p.metrics].sort() }));
  const unionClusters = clustersOf(claims.length, unionList.map((p) => [p.i, p.j]));
  const unionInvolved = new Set();
  for (const p of unionList) {
    unionInvolved.add(p.i);
    unionInvolved.add(p.j);
  }
  const unionReduction = unionClusters.reduce((acc, g) => acc + (g.length - 1), 0);
  const unionDiff = { identical: 0, 'digits-differ': 0, other: 0 };
  for (const p of unionList) unionDiff[p.diffKind ?? 'other'] += 1;
  out.union = {
    pairs: unionList.length,
    multiMetricPairs: unionList.filter((p) => p.metrics.length > 1).length,
    involvedClaims: unionInvolved.size,
    involvedShare: claims.length > 0 ? unionInvolved.size / claims.length : 0,
    clusters: unionClusters.length,
    largestCluster: unionClusters.length > 0 ? unionClusters[0].length : 0,
    reduction: unionReduction,
    reductionShare: claims.length > 0 ? unionReduction / claims.length : 0,
    diff: unionDiff,
    clusters_raw: unionClusters,
    pairs_raw: unionList,
  };
  out.dontMerge = analyzeMergeSafety(claims, unionClusters, unionList);
  return out;
}

function countBy(list, keyOf) {
  const out = {};
  for (const item of list) {
    const k = keyOf(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

/**
 * 「不该合」的机械识别（对应 方案 §14.3：合并不许吞掉冲突、不许改可用条件）。
 * 只做能机械判定的四类，不做语义判断：
 *   1. 冲突证据：簇内任一条 `counter` 非空，或 `state === 'disputed'`
 *   2. 适用条件不同：`preconditions` 的 (check,value) 集不同
 *   3. 版本/有效性不同：`validity` 的 (type,value) 不同（合了会丢版本约束）
 *   4. 同题不同 kind：不会发生（已按 kind 分桶）——这里只报"跨作用域近重复"，供人决定是否破例
 */
function analyzeMergeSafety(claims, clusters, pairs) {
  const sig = (c) => ({
    counter: Array.isArray(c?.counter) ? c.counter.length : 0,
    state: String(c?.state ?? ''),
    pre: JSON.stringify((Array.isArray(c?.preconditions) ? c.preconditions : []).map((p) => [p?.check, p?.value]).sort()),
    validity: JSON.stringify([c?.validity?.type ?? null, c?.validity?.value ?? null]),
    episodes: new Set((Array.isArray(c?.support) ? c.support : []).map((s) => String(s?.episode ?? ''))),
    seqs: new Set((Array.isArray(c?.support) ? c.support : []).map((s) => `${s?.episode ?? ''}#${s?.seq ?? ''}`)),
  });
  const out = {
    clusters: 0,
    hasCounterEvidence: 0,
    disputed: 0,
    preconditionDiffers: 0,
    validityDiffers: 0,
    blockedClusters: 0,
    sameSingleSource: 0,
    multiEpisode: 0,
    examples: [],
  };
  for (const group of clusters) {
    out.clusters += 1;
    const members = group.map((i) => claims[i]);
    const sigs = members.map(sig);
    const anyCounter = sigs.some((s) => s.counter > 0);
    const anyDisputed = sigs.some((s) => s.state === 'disputed');
    const preDiffers = new Set(sigs.map((s) => s.pre)).size > 1;
    const valDiffers = new Set(sigs.map((s) => s.validity)).size > 1;
    const seqUnion = new Set();
    const epUnion = new Set();
    for (const s of sigs) {
      for (const x of s.seqs) seqUnion.add(x);
      for (const e of s.episodes) epUnion.add(e);
    }
    const sameSingleSource = members.length >= 2 && seqUnion.size === 1;
    const multiEpisode = epUnion.size >= 2;
    const blocked = anyCounter || anyDisputed || preDiffers || valDiffers;
    if (anyCounter) out.hasCounterEvidence += 1;
    if (anyDisputed) out.disputed += 1;
    if (preDiffers) out.preconditionDiffers += 1;
    if (valDiffers) out.validityDiffers += 1;
    if (blocked) out.blockedClusters += 1;
    if (sameSingleSource) out.sameSingleSource += 1;
    if (multiEpisode) out.multiEpisode += 1;
    if (blocked && out.examples.length < 5) {
      out.examples.push({
        ids: members.slice(0, CLUSTER_MEMBERS).map((m) => String(m?.id ?? '')),
        size: members.length,
        reasons: [
          anyCounter ? 'counter-evidence' : null,
          anyDisputed ? 'disputed' : null,
          preDiffers ? 'precondition-differs' : null,
          valDiffers ? 'validity-differs' : null,
        ].filter(Boolean),
        texts: members.slice(0, CLUSTER_MEMBERS).map((m) => prefixOf(m?.text, SNIPPET_CHARS)),
      });
    }
  }
  // 可以直接合的簇：没有被上面四类阻断的
  out.safeToMergeClusters = out.clusters - out.blockedClusters;
  return out;
}

/* ── 脱敏（报告里不出现本机用户名 / 绝对路径）─────────────── */

const HOME_PLACEHOLDER = '<user-home>';
const USER_PLACEHOLDER = '<user>';

/** 本机用户名（尽量全：USERNAME / USER / os.userInfo().username）。 */
function localUserNames() {
  const names = new Set();
  for (const key of ['USERNAME', 'USER', 'LOGNAME']) {
    const v = process.env[key];
    if (typeof v === 'string' && v.length >= 2) names.add(v);
  }
  try {
    const u = process.env.USERPROFILE || process.env.HOME || '';
    const base = u.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    if (base) names.add(base);
  } catch {
    /* 拿不到就算了 */
  }
  return [...names].sort((a, b) => b.length - a.length);
}

const USER_NAMES = localUserNames();

/** 只抹身份（home 目录 / 用户名），不碰路径形状 —— `maskScopeKey` 要先看路径形状再压段。 */
export function maskIdentity(text) {
  let s = String(text ?? '');
  const home = (process.env.USERPROFILE || process.env.HOME || '').replace(/[\\/]+$/, '');
  if (home) {
    const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')]);
    if (/^[A-Za-z]:/.test(home)) {
      const drive = home.slice(0, 1);
      variants.add(`/${drive}${home.slice(2).replace(/\\/g, '/')}`);
      variants.add(`/${drive.toLowerCase()}${home.slice(2).replace(/\\/g, '/')}`);
    }
    for (const v of [...variants].sort((a, b) => b.length - a.length)) {
      if (v.length >= 3) s = s.split(v).join(HOME_PLACEHOLDER);
      // 大小写不敏感再兜一次（Windows 路径大小写不敏感）
      if (v.length >= 3 && /[A-Za-z]/.test(v)) {
        const re = new RegExp(escapeRe(v), 'gi');
        s = s.replace(re, HOME_PLACEHOLDER);
      }
    }
  }
  for (const name of USER_NAMES) {
    if (name.length < 2) continue;
    s = s.replace(new RegExp(escapeRe(name), 'gi'), USER_PLACEHOLDER);
  }
  return s;
}

/** 脱敏：home 目录 → `<user-home>`，用户名 → `<user>`，绝对路径 → `<path>`。 */
export function desensitize(text) {
  let s = maskIdentity(text);
  // Windows 绝对路径 & UNC
  s = s.replace(/[A-Za-z]:[\\/][^\s"'`;){}\]]*/g, '<path>');
  // POSIX 绝对路径（至少两级，避免误伤 `/` 与命令参数里的单斜杠）
  s = s.replace(/(^|[\s"'`(])\/(?:[\w.@+-]+\/)+[\w.@+-]*/g, '$1<path>');
  return s;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** scopeKey 的展示形态：mask 掉用户名，并把绝对路径压成 `…/最后两段`（不压成 `<path>`，否则桶认不出来）。 */
export function maskScopeKey(scopeKey) {
  const raw = String(scopeKey ?? '');
  const m = /^([A-Za-z]{1,3}):(.*)$/.exec(raw);
  const prefix = m ? `${m[1]}:` : '';
  let rest = maskIdentity(m ? m[2] : raw);
  if (rest.includes(HOME_PLACEHOLDER) || rest.includes(USER_PLACEHOLDER)) return `${prefix}${rest}`;
  if (/^(?:[A-Za-z]:|[\\/])/.test(rest)) {
    const segs = rest.split(/[\\/]+/).filter(Boolean);
    rest = segs.length > 2 ? `…/${segs.slice(-2).join('/')}` : `/${segs.join('/')}`;
  }
  return `${prefix}${rest}`;
}

/* ── 渲染 ─────────────────────────────────────────────────── */

const pct = (x) => `${(x * 100).toFixed(1)}%`;

export function renderMarkdown(report) {
  const r = report;
  const lines = [];
  lines.push('# claim 库重复度体检（只读）');
  lines.push('');
  lines.push(`- 生成时间：${r.generatedAt}`);
  lines.push(`- 库：\`${r.storeLabel}\`${r.scope ? ` · 只看作用域 \`${maskScopeKey(r.scope)}\`` : ''}`);
  lines.push(`- claim 总数：**${r.totals.claims}**（损坏文件 ${r.totals.corruptFiles}）· 分桶 ${r.totals.buckets}（scope+kind）· 最大桶 ${r.totals.largestBucket} 条`);
  const kindBits = Object.entries(r.totals.byKind).map(([k, v]) => `${k} ${v}`).join(' · ');
  if (kindBits) lines.push(`- kind 分布：${kindBits}`);
  lines.push(`- 阈值：A Jaccard ≥ ${r.thresholds.jaccardMin} · B CJK 2-gram 交集 ≥ ${r.thresholds.bigramOverlapMin} · C 错误类 + 前 ${r.thresholds.prefixChars} 字`);
  lines.push(`- 耗时：${r.elapsedMs} ms`);
  lines.push('');
  lines.push('## 1 · 三个口径（分子/分母都写清）');
  lines.push('');
  lines.push('| 口径 | 疑似重复对（分子） | 可比较对（分母） | 命中率 | 涉及 claim | 占全体 | 重复簇 | 最大簇 | 可合并条数（粗估） | 库规模降幅 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const key of ['A', 'B', 'C']) {
    const m = r.metrics[key];
    lines.push(
      `| ${key} | **${m.pairs}** | ${m.comparablePairs} | ${pct(m.hitRate)} | ${m.involvedClaims} | ${pct(m.involvedShare)} | ${m.clusters} | ${m.largestCluster} | ${m.reduction} | ${pct(m.reductionShare)} |`,
    );
  }
  const u = r.union;
  lines.push(
    `| **A∪B∪C** | **${u.pairs}** | — | — | ${u.involvedClaims} | ${pct(u.involvedShare)} | ${u.clusters} | ${u.largestCluster} | ${u.reduction} | ${pct(u.reductionShare)} |`,
  );
  lines.push('');
  lines.push(`> C 的 ${r.metrics.C.pairs} 对里：命中已知错误类 ${r.cBreakdown.byErrorClass} 对、仅靠"前 ${r.thresholds.prefixChars} 字相同"（两边都无已知错误类）${r.cBreakdown.byPrefixOnly} 对。`);
  lines.push(`> A∪B∪C 里被 ≥2 个口径同时命中的对：${u.multiMetricPairs} 对。`);
  lines.push('');
  lines.push('### 命中对的文本差异形态（决定阈值松紧的关键）');
  lines.push('');
  lines.push('| 口径 | 完全相同 | 只差数字/十六进制 id | 其余（词/字面变了） |');
  lines.push('|---|---|---|---|');
  for (const key of ['A', 'B', 'C']) {
    const d = r.metrics[key].diff;
    lines.push(`| ${key} | ${d.identical} | ${d['digits-differ']} | ${d.other} |`);
  }
  lines.push(`| **A∪B∪C** | ${u.diff.identical} | ${u.diff['digits-differ']} | ${u.diff.other} |`);
  lines.push('');
  lines.push('> `digits-differ` = 抹平数字与长十六进制 id 后两句话一模一样（典型：`unknown job bash-<id>`、`main.go:<行>:<列>`、`version = "0.2.1-go.<n>"`）。');
  lines.push('> 这类对「要不要合」取决于被抹平的那段是不是事实本体：job id / 行号是附带信息，版本号往往是正文。');
  lines.push('');
  lines.push('## 2 · 各口径 top 簇（每条只给 id + 前 60 字摘要）');
  for (const key of ['A', 'B', 'C']) {
    lines.push('');
    lines.push(`### 口径 ${key}${key === 'A' ? '（ASCII Jaccard）' : key === 'B' ? '（CJK 2-gram 交集）' : '（错误类 + 前40字）'}`);
    if (r.metrics[key].clusters === 0) {
      lines.push('');
      lines.push('（无重复簇）');
      continue;
    }
    const top = r.metrics[key].clusters_raw.slice(0, TOP_CLUSTERS);
    top.forEach((group, idx) => {
      lines.push('');
      lines.push(`**簇 ${key}${idx + 1} · ${group.length} 条**`);
      for (const i of group.slice(0, CLUSTER_MEMBERS)) {
        const c = r.claimsIndex[i];
        lines.push(`- \`${c?.id ?? '?'}\` · ${desensitize(prefixOf(c?.text, SNIPPET_CHARS))}`);
      }
      if (group.length > CLUSTER_MEMBERS) lines.push(`- …另 ${group.length - CLUSTER_MEMBERS} 条`);
    });
  }
  lines.push('');
  lines.push('## 3 · 并集 top 簇（合流实际要处理的形状）');
  if (u.clusters === 0) {
    lines.push('');
    lines.push('（无）');
  } else {
    u.clusters_raw.slice(0, TOP_CLUSTERS).forEach((group, idx) => {
      const set = new Set(group);
      const metricsFired = new Set(u.pairs_raw.filter((p) => set.has(p.i) && set.has(p.j)).flatMap((p) => p.metrics));
      const scopes = new Set(group.map((i) => maskScopeKey(r.claimsIndex[i]?.scopeKey)));
      const kinds = new Set(group.map((i) => String(r.claimsIndex[i]?.kind ?? '')));
      lines.push('');
      lines.push(`**簇 U${idx + 1} · ${group.length} 条 · 命中口径 ${[...metricsFired].sort().join('+')} · kind ${[...kinds].join('/')} · scope ${[...scopes].join(' , ')}**`);
      for (const i of group.slice(0, CLUSTER_MEMBERS)) {
        const c = r.claimsIndex[i];
        lines.push(`- \`${c?.id ?? '?'}\` · ${desensitize(prefixOf(c?.text, SNIPPET_CHARS))}`);
      }
      if (group.length > CLUSTER_MEMBERS) lines.push(`- …另 ${group.length - CLUSTER_MEMBERS} 条`);
    });
  }
  lines.push('');
  lines.push('## 4 · 不该合的情况（机械判定，对应 方案 §14.3）');
  lines.push('');
  const d = r.dontMerge;
  lines.push(`- 并集簇总数：**${d.clusters}**；被下面四类阻断 **${d.blockedClusters}** 簇，其余 **${d.safeToMergeClusters}** 簇可只按"文本近似"合；其中：`);
  lines.push(`  - 簇内有反例证据（\`counter\` 非空）：**${d.hasCounterEvidence}** ← 不许合，冲突要显式留（\`contradicts\`）`);
  lines.push(`  - 簇内有 \`state:disputed\`：**${d.disputed}**`);
  lines.push(`  - 簇内 \`preconditions\` 不同：**${d.preconditionDiffers}** ← 合了会改适用条件`);
  lines.push(`  - 簇内 \`validity\` 不同：**${d.validityDiffers}** ← 合了会丢版本/文件约束`);
  lines.push(`  - 簇内全是同一条出处（同 episode+seq）：**${d.sameSingleSource}** ← 这种是最安全的合（真重复）`);
  lines.push(`  - 簇内跨 ≥2 局：**${d.multiEpisode}** ← 这不是重复，是"多局印证"：合时应累加 support，不能丢出处`);
  if (d.examples.length > 0) {
    lines.push('');
    lines.push('示例（只给 id + 摘要，不给全文）：');
    for (const ex of d.examples) {
      lines.push(`- ${ex.ids.map((x) => `\`${x}\``).join(' / ')}（${ex.size} 条）· 原因 ${ex.reasons.join(',')} · ${desensitize(ex.texts[0] ?? '')}`);
    }
  }
  lines.push('');
  lines.push('## 5 · 口径说明（可复算）');
  lines.push('');
  lines.push('| 口径 | 特征 | 分子 | 分母 |');
  lines.push('|---|---|---|---|');
  lines.push(`| A | 小写 ASCII 词集（长度 ≥2、去 EN_STOPWORDS、去纯数字） | Jaccard ≥ ${JACCARD_MIN} 的对 | 两侧词集都 ≥ ${MIN_ASCII_TOKENS} 的对 |`);
  lines.push(`| B | CJK 2-gram（去虚字 gram 与停用 gram） | 交集 ≥ ${BIGRAM_OVERLAP_MIN} 的对 | 两侧 2-gram 集都非空的对 |`);
  lines.push(`| C | \`errorClassKeyOf(text)\` + 空白归一后前 ${PREFIX_CHARS} 码点 | key 相同 | 桶内全部对 |`);
  lines.push('');
  lines.push('分桶：只比**同 scopeKey + 同 kind**。跨作用域不合并（方案 §4.10 w: 层不自动上升），跨 kind 不合并。');
  lines.push('降幅口径：命中关系取传递闭包成簇，簇内 N 条合 1 条 ⇒ 少 N-1 条；合计 ÷ 全体 = 降幅。这是**粗估**（合并后还会新增 supersedes/合成节点）。');
  return `${lines.join('\n')}\n`;
}

/** JSON 输出：去掉不可序列化的数组（clusters_raw / pairs_raw 换成纯下标与标签）。 */
export function toJson(report) {
  const strip = (arr) => arr.map((g) => g.map((i) => String(report.claimsIndex[i]?.id ?? i)));
  const m = {};
  for (const key of ['A', 'B', 'C']) {
    const src = report.metrics[key];
    m[key] = {
      pairs: src.pairs,
      comparablePairs: src.comparablePairs,
      hitRate: Number(src.hitRate.toFixed(4)),
      involvedClaims: src.involvedClaims,
      involvedShare: Number(src.involvedShare.toFixed(4)),
      clusters: src.clusters,
      largestCluster: src.largestCluster,
      reduction: src.reduction,
      reductionShare: Number(src.reductionShare.toFixed(4)),
      topClusters: strip(src.clusters_raw.slice(0, TOP_CLUSTERS)),
    };
  }
  const u = report.union;
  return {
    generatedAt: report.generatedAt,
    storeLabel: report.storeLabel,
    scope: report.scope ? maskScopeKey(report.scope) : null,
    thresholds: report.thresholds,
    totals: {
      ...report.totals,
      byScope: Object.fromEntries(Object.entries(report.totals.byScope).map(([k, v]) => [maskScopeKey(k), v])),
    },
    elapsedMs: report.elapsedMs,
    metrics: m,
    cBreakdown: report.cBreakdown,
    union: {
      pairs: u.pairs,
      multiMetricPairs: u.multiMetricPairs,
      involvedClaims: u.involvedClaims,
      involvedShare: Number(u.involvedShare.toFixed(4)),
      clusters: u.clusters,
      largestCluster: u.largestCluster,
      reduction: u.reduction,
      reductionShare: Number(u.reductionShare.toFixed(4)),
      topClusters: strip(u.clusters_raw.slice(0, TOP_CLUSTERS)),
      topClusterMetrics: u.clusters_raw.slice(0, TOP_CLUSTERS).map((g) => {
        const set = new Set(g);
        return [...new Set(u.pairs_raw.filter((p) => set.has(p.i) && set.has(p.j)).flatMap((p) => p.metrics))].sort();
      }),
    },
    dontMerge: {
      clusters: report.dontMerge.clusters,
      hasCounterEvidence: report.dontMerge.hasCounterEvidence,
      disputed: report.dontMerge.disputed,
      preconditionDiffers: report.dontMerge.preconditionDiffers,
      validityDiffers: report.dontMerge.validityDiffers,
      sameSingleSource: report.dontMerge.sameSingleSource,
      multiEpisode: report.dontMerge.multiEpisode,
      examples: report.dontMerge.examples.map((e) => ({ ...e, texts: e.texts.map((t) => desensitize(t)) })),
    },
  };
}

/* ── CLI ──────────────────────────────────────────────────── */

export function resolveStoreRoot(argv = [], env = process.env) {
  const idx = argv.indexOf('--root');
  if (idx >= 0 && argv[idx + 1]) return path.resolve(argv[idx + 1]);
  const home = env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || '.', 'DeepSeek Harness', 'home');
  return path.join(home, 'memory-context');
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invoked) {
  const argv = process.argv.slice(2);
  const root = resolveStoreRoot(argv);
  const scopeIdx = argv.indexOf('--scope');
  const scope = scopeIdx >= 0 ? argv[scopeIdx + 1] : null;
  if (!fs.existsSync(root)) {
    console.error(`没有记忆库：${'<memory-context>'} 不存在（用 --root 指别处；不伪造 0 结果）`);
    process.exit(2);
  }
  const report = buildDupReport({ root, scope });
  if (argv.includes('--json')) console.log(JSON.stringify(toJson(report), null, 2));
  else process.stdout.write(renderMarkdown(report));
}

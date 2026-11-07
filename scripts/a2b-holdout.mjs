#!/usr/bin/env node
// T236a · A2b（召回相关度）考卷扩充 —— 只读，构造 ≥100 条带**机械 ground truth** 的考卷。
//
// 背景（2026-11-05 主人改判）：第一验收面 = **召回相关度**（记忆源头该处理的），
// 而不是"不重复踩坑"（那是下游上下文压缩的本职）。现状 A2b 严格 94.7% 但 **n=19**，1 条 = 5.3pp，
// 撑不起任何结论。本脚本只做一件事：把考卷从 19 条扩到 ≥100 条，每条都能追溯到 (episode, seq)。
//
// ── 考卷单元 ───────────────────────────────────────────────────────────────
//   { id, kind:'self'|'repeat', episode, scopeKey, signal, expected:{episodes, claimIds}, judge }
//
//   · self   —— 该局自己的任务信号（棋谱根用户消息 n1 的原文）为 query，
//               expected = support 里含**该局**的 claim（"这局的教训应当能被这局的任务召回"）。
//   · repeat —— 冻结集 `evidence/a2b-set.json` 的 19 条：后缀局复发了前序局的签名，
//               expected = support 里含**前序局**的 claim（原来的 A2b 口径）。
//
// ── 机械判据（不看模型判断）──────────────────────────────────────────────────
//   渲染行 claim c：
//     related   ⇔ c.support 里出现 expected.episodes 之一        （ground truth 命中）
//     strict    ⇔ related 且 c.text 与信号有 **≥2 个判别词**重合  （不是"碰巧召回"）
//     pending   ⇔ 不 related 但与信号有 ≥2 个判别词重合            （像相关、但不是该局的 ⇒ 单列，不进分子也不进分母）
//     unrelated ⇔ 其余
//   判别词 = 小写 → 按 `[^a-z0-9一-鿿]+` 切 → 长度 ≥4 → 去掉 'path'（与 m5-report 的 A2b 严格口径同一套）。
//
// 纪律：只读（store.list/get + 读棋谱 JSON）；不写库、不改任何 claim；零模型调用。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';
import { walkFromSignals, createWalkCache } from '../src/rooms/walk.mjs';
import { buildMemoryCard, signalFromText } from '../src/rooms/inject.mjs';
import { readFrames, parseEvents } from '../src/rooms/logread.mjs';

export const HOLDOUT_VERSION = 1;
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export function defaultHome(env = process.env) {
  return path.resolve(env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || '.', 'DeepSeek Harness', 'home'));
}

/** 判别词（与 m5-report 的 A2b 严格口径同一套）。 */
export function discriminativeTokens(text) {
  return String(text ?? '').toLowerCase().split(/[^a-z0-9一-鿿]+/).filter((t) => t.length >= 4 && t !== 'path');
}

/**
 * T284：中文二元组。中文连续段按 **2 字滑窗**切 bigram；英文/数字/路径保持原样。
 * 为什么：中文整段被当一个 token 时，`includes` 几乎不可能命中（T281：B 类 overlap 分布 {0:24,1:4,3:1}），
 * 尺子把"明明相关"的卡判成不相关。bigram 是语言中立的机械切法，不含模型判断。
 */
export function chineseBigrams(text) {
  const out = new Set();
  const src = String(text ?? '');
  // 中文连续段：2 字滑窗
  for (const run of src.match(/[一-鿿]+/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2));
  }
  // 英文/数字/路径：保持原样（按非词字符切，长度 ≥3）
  for (const tok of src.toLowerCase().split(/[^a-z0-9_./-]+/)) {
    if (tok.length >= 3) out.add(tok);
  }
  return out;
}

/**
 * T286：bigram 的**判别性过滤**（IDF 的离散版）。
 * 泛词 bigram（「你看」「看看」「文件」）出现在大量 claim 里，撞上就判中 ⇒ 伪命中。
 * 判据：`df / N > maxRatio` ⇒ **不算判别性**，不计入门槛。
 * 只读：df 从**全库 claim** 统计，不改任何记录。
 */
export function buildBigramDf(claims = []) {
  const df = new Map();
  let n = 0;
  for (const claim of Array.isArray(claims) ? claims : []) {
    const text = String(claim?.text ?? '');
    if (!text) continue;
    n += 1;
    for (const bg of chineseBigrams(text)) df.set(bg, (df.get(bg) ?? 0) + 1);
  }
  return { df, total: n };
}

/** 该 bigram 是否**判别性**（df/N ≤ maxRatio）。缺省不过滤。 */
export function isDiscriminative(bigram, filter, maxRatio = 0.02) {
  if (!filter || !Number.isFinite(filter.total) || filter.total <= 0) return true;
  const d = filter.df.get(bigram) ?? 0;
  return d / filter.total <= maxRatio;
}

/** 判别性 bigram 重合数：信号的 bigram 在 claim 文本里出现了几个。 */
export function bigramOverlapCount(signalText, claimText, { filter = null, maxRatio = 0.02 } = {}) {
  const hay = String(claimText ?? '').toLowerCase();
  let n = 0;
  for (const bg of chineseBigrams(signalText)) {
    if (!hay.includes(bg)) continue;
    if (!isDiscriminative(bg, filter, maxRatio)) continue; // T286：泛词 bigram 不计
    n += 1;
  }
  return n;
}

/** 词重合数（同一套判别词口径）。 */
export function overlapCount(signalText, claimText) {
  const tokens = discriminativeTokens(signalText);
  const hay = String(claimText ?? '').toLowerCase();
  return tokens.filter((t) => hay.includes(t)).length;
}

// ── T248：硬实体桥 ───────────────────────────────────────────────────────────
// 为什么需要它：任务原话是**中文**、claim 是**英文报错**时，"≥2 判别词重合"天然拿不到分
// （中文句切出来的 token 与英文报错没有词面交集），即使两者共享同一个文件/错误码/包名。
// **实体是语言中立的标识符** —— 中文任务与英文报错可以指向同一个 `dsh-ui/internal/uiplugins`
// 或同一个 `ENOENT`。所以判据改成 **并集**：`≥2 判别词重合 || ≥1 硬实体重合`。
// 原门槛（≥2 判别词）**一字不动**；硬实体只是补一条"语言错位"的通道。
export const HARD_ENTITY_PATTERNS = Object.freeze([
  // 文件路径：Windows 盘符 / POSIX 绝对路径
  /[A-Za-z]:[\\/][\w./\\-]{3,}/g,
  /(?:^|[\s"'(=])\/(?:[\w.-]+\/)*[\w.-]{3,}/g,
  // 错误码 / 错误类
  /\bclass:[a-z0-9-]+\b/gi,
  /\b(?:ENOENT|EACCES|EPERM|EEXIST|ECONNREFUSED|ETIMEDOUT|MODULE_NOT_FOUND|ERR_[A-Z_]+)\b/g,
  // 包名（scoped 或无 scope）
  /(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]+\/[a-z0-9][a-z0-9._-]+/gi,
  // 命令（git/node/npm/go/python/bash… + 少量参数）
  /\b(?:git|node|npm|pnpm|yarn|go|python|bash|pwsh|powershell|curl|gh)\b(?:\s+[-\w./=:]{1,40}){0,4}/gi,
]);

/** 从一段文本里抽硬实体（小写归一；路径同时保留 basename，便于不同根下的同一文件对齐）。 */
export function hardEntities(text) {
  const raw = String(text ?? '');
  const out = new Set();
  for (const re of HARD_ENTITY_PATTERNS) {
    re.lastIndex = 0;
    for (const m of raw.matchAll(re)) {
      const value = String(m[0] ?? '').trim().replace(/^[\s"'(=]+|[\s"'),.]+$/g, '');
      if (value.length < 3) continue;
      out.add(value.toLowerCase());
      const base = value.split(/[\\/]/).pop();
      if (base && base.length >= 6 && /[._-]/.test(base)) out.add(base.toLowerCase());
    }
  }
  return out;
}

/** 任务与 claim 共享的硬实体（用于"语言错位"桥）。 */
export function sharedHardEntities(signalText, claimText) {
  const a = hardEntities(signalText);
  if (!a.size) return [];
  const b = hardEntities(claimText);
  if (!b.size) return [];
  return [...a].filter((x) => b.has(x));
}

/**
 * T248 判据（并集，不降低原门槛）：
 *   strict ⇔ related **且**（≥minOverlap 个判别词重合 **或** ≥1 个硬实体重合）
 * `related` 的定义（support.episode === 该局）**一字不动** —— 那是 ground truth。
 */
export function judgeStrict({ related, overlap, shared, bigram = 0, minOverlap = 2 }) {
  if (!related) return false;
  // T284：并集 —— 英文/路径照旧走判别词；中文走 bigram；硬实体桥不变。
  return overlap >= minOverlap || bigram >= minOverlap || (Array.isArray(shared) && shared.length >= 1);
}

/** Wilson 95% 区间（与 merge-acceptance 同公式，避免口径漂移）。 */
export function wilsonInterval(successes, n, z = 1.96) {
  const s = Number(successes) || 0;
  const total = Number(n) || 0;
  if (!total) return { phat: null, lower: null, upper: null, n: 0, z };
  const phat = s / total;
  const denom = 1 + (z * z) / total;
  const centre = phat + (z * z) / (2 * total);
  const spread = z * Math.sqrt((phat * (1 - phat)) / total + (z * z) / (4 * total * total));
  return { phat, lower: (centre - spread) / denom, upper: (centre + spread) / denom, n: total, z };
}

/** claims → Map<episodeId, claimId[]>（support 里出现即算）。 */
export function claimsByEpisode(claims = []) {
  const out = new Map();
  for (const claim of claims) {
    if (!claim || typeof claim.id !== 'string') continue;
    const eps = new Set();
    for (const s of Array.isArray(claim.support) ? claim.support : []) {
      const ep = typeof s?.episode === 'string' ? s.episode : '';
      if (ep) eps.add(ep);
    }
    for (const ep of eps) {
      if (!out.has(ep)) out.set(ep, []);
      out.get(ep).push(claim.id);
    }
  }
  return out;
}

/** 从棋谱根用户节点取该局的任务原文（n1）。 */
export function rootTaskText(episode, { home = defaultHome() } = {}) {
  const gp = episode?.closure?.graphPath;
  if (!gp) return '';
  const abs = path.isAbsolute(gp) ? gp : path.join(home, gp);
  try {
    const g = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const root = g?.nodes?.n1 ?? Object.values(g?.nodes ?? {}).find((n) => n && n.kind === 'user');
    return String(root?.text ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * 该局的硬实体信号（T249/T263 共用口径）：棋谱主题里的 **file×2 + error×1**。
 * 只用 file+error：通用工具名（bash/cat/cd/awk）会让"判别词 ≥2"这条被高频词灌水
 * （T249 实测：带 tool 时多命中 1 条，但对照组判别词误判 6.06% → 16.67%）。
 */
export function episodeEntitySignal(episode) {
  const topics = Array.isArray(episode?.topics) ? episode.topics : [];
  const pickKeys = (kind, n) => topics.filter((t) => t && t.kind === kind && typeof t.key === 'string').map((t) => t.key).slice(0, n);
  return [...pickKeys('file', 2), ...pickKeys('error', 1)].join(' ').trim();
}

/** 该局第一条用户消息的原文（日志里第一条 user/message；比 l1 更接近"任务原话"）。 */
export function firstUserText(episode, { home = defaultHome() } = {}) {
  const lp = episode?.closure?.logPath;
  if (!lp) return '';
  const abs = path.isAbsolute(lp) ? lp : path.join(home, lp);
  try {
    const raw = parseEvents(readFrames(fs.readFileSync(abs)));
    const events = Array.isArray(raw) ? raw : (raw?.events ?? []);
    for (const ev of events) {
      if (ev?.type !== 'user/message') continue;
      const text = collectText(ev?.data?.content ?? ev?.data?.message?.content ?? '');
      if (text.trim()) return text.trim();
    }
  } catch { /* 读不到就回退 */ }
  return '';
}

/** 从 content（字符串 / [{type:'text',text}] / 嵌套）里收集文本。 */
export function collectText(value, out = []) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => collectText(v)).filter(Boolean).join('');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (value.content !== undefined) return collectText(value.content);
  }
  return '';
}

/**
 * 构造考卷（纯函数 + 只读 IO）。
 * @returns {{items:Array, skipped:Array, stats:object}}
 */
export function buildExam({ store, home = defaultHome(), minSignalChars = 12, includeRepeat = true, frozenPath = null } = {}) {
  const claims = store.list('claims').map((e) => e.record).filter(Boolean);
  const episodes = store.list('episodes').map((e) => e.record).filter(Boolean);
  const byEpisode = claimsByEpisode(claims);
  const items = [];
  const skipped = [];
  for (const [episodeId, claimIds] of byEpisode) {
    const episode = episodes.find((e) => e?.id === episodeId) ?? store.get('episodes', episodeId);
    if (!episode) { skipped.push({ episode: episodeId, why: 'episode-missing' }); continue; }
    const rootText = rootTaskText(episode, { home });
    const fallback = String(episode?.l1 ?? episode?.l0 ?? '').trim();
    const firstUser = rootText.length >= minSignalChars ? '' : firstUserText(episode, { home });
    const signal = rootText.length >= minSignalChars ? rootText
      : (firstUser.length >= minSignalChars ? firstUser : (fallback.length >= minSignalChars ? fallback : ''));
    let signalSource = rootText.length >= minSignalChars ? 'root'
      : (firstUser.length >= minSignalChars ? 'firstUser' : (signal ? 'l1' : null));
    // 短信号（< minSignalChars）不算废卷：它是该局**真实的任务原话**，只是信息量低。
    // 单列成 shortRoot，主口径仍按 minSignalChars 筛（T236a：为了凑到 n≥100，短信号单独报桶）。
    let finalSignal = signal;
    if (!signal) {
      const raw = (rootText || firstUser || fallback || '').trim();
      if (raw) { finalSignal = raw; signalSource = 'shortRoot'; }
    }
    // ── T249：短信号换成"该局的硬实体信号" ──────────────────────────────────
    // 为什么：任务原话 <12 字（「处理一下」「继续」）时，任何检索都不可能命中 —— 这是
    // **信号源不够**，不是检索差（T249 实测：11 条里 9 条换成实体信号后能严格命中）。
    // 做法：取该局棋谱主题里的 file×2 + tool×2 + error×1 作为信号（机械、可复现、不带模型判断）；
    // 仍保留 taskText 供追溯，signalSource 改记为 shortRootEntities，便于分桶统计。
    // ── T264：**注入时刻可得** 的信号（考卷作弊修正）──────────────────────────
    // 真实注入发生在 `agent/pre-step`：那时只知道**用户说了什么**，不知道这局接下来会碰哪些文件。
    // 所以合法信号只有两路：
    //   A · task          = 用户原话（根用户 / firstUser）
    //   B · taskPlusEntity = 原话 + **原话里出现的**硬实体（路径/错误码/包名/命令）
    // 而 T249/T263 用的 `episodeEntitySignal`（该局棋谱主题）是**事后信息**——
    // 拿"这局实际碰过的文件"当线索去检索"这局该召回什么"，等于用答案当题面。
    // 它保留为 C 路（postHoc），只作对照，标 injectionTime: false，**不进主判据**。
    const taskText = finalSignal;
    const postHocSignal = episodeEntitySignal(episode);          // C：事后（作弊）
    const taskEntities = [...hardEntities(taskText)];            // 原话里出现的实体
    const taskEntitySignal = taskEntities.join(' ').trim();
    // 合法默认信号 = B（原话 + 原话内实体）
    finalSignal = [taskText, taskEntitySignal].filter(Boolean).join(' ').trim();
    const signals = {
      task: taskText || null,                                    // A
      taskPlusEntity: finalSignal || null,                       // B（主判据）
      postHoc: postHocSignal ? [taskText, postHocSignal].filter(Boolean).join(' ') : null, // C（对照）
    };
    const signalMeta = {
      task: { injectionTime: true, desc: '用户原话' },
      taskPlusEntity: { injectionTime: true, desc: '用户原话 + 原话内硬实体' },
      postHoc: { injectionTime: false, desc: '用户原话 + 该局棋谱主题（**事后信息，作弊对照**）' },
    };
    if (!finalSignal) { skipped.push({ episode: episodeId, why: `no-signal(root=${rootText.length},firstUser=${firstUser.length},fallback=${fallback.length})` }); continue; }
    items.push({
      id: `self:${episodeId}`,
      kind: 'self',
      episode: episodeId,
      scopeKey: typeof episode.scopeKey === 'string' ? episode.scopeKey : null,
      signal: finalSignal,
      taskText,
      signals,
      signalMeta,
      taskEntities,
      at: Number.isFinite(episode.endedAt) ? episode.endedAt : (Number.isFinite(episode.lastEventAt) ? episode.lastEventAt : null),
      expected: { episodes: [episodeId], claimIds: claimIds.slice() },
      signalSource,
      judge: 'claim.support 含该局 ⇒ related；与信号 ≥2 判别词重合 ⇒ strict',
    });
  }
  // repeat 考卷：冻结集（原 A2b 的 19 条）
  let frozen = null;
  const fp = frozenPath ?? path.join(REPO_ROOT, 'evidence', 'a2b-set.json');
  if (includeRepeat && fs.existsSync(fp)) {
    try { frozen = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { frozen = null; }
  }
  const seen = new Set(items.map((x) => x.episode));
  for (const row of Array.isArray(frozen?.items) ? frozen.items : []) {
    const prior = Array.isArray(row.prior) ? row.prior.filter((x) => typeof x === 'string') : [];
    if (!prior.length || typeof row.sig !== 'string' || !row.sig.trim()) continue;
    const expectedIds = prior.flatMap((ep) => byEpisode.get(ep) ?? []);
    if (!expectedIds.length) continue;
    items.push({
      id: `repeat:${row.episode}:${expectedIds.length}`,
      kind: 'repeat',
      episode: row.episode,
      scopeKey: typeof row.scopeKey === 'string' ? row.scopeKey : null,
      signal: row.sig,
      at: Number.isFinite(frozen?.splitAt) ? frozen.splitAt : null,
      expected: { episodes: prior.slice(), claimIds: [...new Set(expectedIds)] },
      signalSource: 'signature',
      // repeat 题只有"签名"这一路信号（没有该局主题）⇒ task/composite 都是签名本身，entity 为 null
      signals: { task: row.sig, entity: null, composite: row.sig },
      judge: 'claim.support 含 prior 局 ⇒ related；与签名 ≥2 判别词重合 ⇒ strict',
    });
    seen.add(row.episode);
  }
  return {
    items,
    skipped,
    stats: {
      claims: claims.length,
      episodesWithClaims: byEpisode.size,
      self: items.filter((x) => x.kind === 'self').length,
      repeat: items.filter((x) => x.kind === 'repeat').length,
      skipped: skipped.length,
      frozen: Boolean(frozen),
    },
  };
}

/**
 * 单条考卷的机械判分：把卡片渲染行分成 related / strict / pending / unrelated。
 */
export function judgeCard({ card, store, item, minOverlap = 2, bigramFilter = null, maxDfRatio = 0.02 } = {}) {
  const expectedEpisodes = new Set(item?.expected?.episodes ?? []);
  const expectedIds = new Set(item?.expected?.claimIds ?? []);
  const rows = [];
  let related = 0;
  let strict = 0;
  let strictTokensOnly = 0;
  let bigramOnly = 0;
  let pending = 0;
  let unrelated = 0;
  for (const row of Array.isArray(card?.claims) ? card.claims : []) {
    const claimId = typeof row?.claimId === 'string' ? row.claimId : null;
    if (!claimId) continue;
    const record = store.get('claims', claimId);
    const supportEps = (Array.isArray(record?.support) ? record.support : []).map((s) => String(s?.episode ?? ''));
    const isRelated = supportEps.some((ep) => expectedEpisodes.has(ep)) || expectedIds.has(claimId);
    const overlap = overlapCount(item?.signal ?? '', record?.text ?? '');
    const bigram = bigramOverlapCount(item?.signal ?? '', record?.text ?? '', { filter: bigramFilter, maxRatio: maxDfRatio });
    const bigramRaw = bigramOverlapCount(item?.signal ?? '', record?.text ?? '');
    const shared = sharedHardEntities(item?.signal ?? '', record?.text ?? '');
    // T284：并集 —— 判别词 ≥2（英文/路径）或 **bigram ≥2（中文）** 或 硬实体 ≥1
    const isStrict = isRelated && (overlap >= minOverlap || bigram >= minOverlap || shared.length >= 1);
    const isStrictTokens = isRelated && overlap >= minOverlap;                   // 旧判据（对照）
    const isStrictBigram = isRelated && bigram >= minOverlap && overlap < minOverlap; // 仅靠 bigram 才成立
    const isPending = !isRelated && (overlap >= minOverlap || bigram >= minOverlap);
    if (isRelated) related += 1;
    if (isStrict) strict += 1;
    if (isStrictTokens) strictTokensOnly += 1;
    if (isStrictBigram) bigramOnly += 1;
    if (isPending) pending += 1;
    if (!isRelated && !isPending) unrelated += 1;
    rows.push({ claimId, related: isRelated, strict: isStrict, strictTokens: isStrictTokens, strictByBigramOnly: isStrictBigram, pending: isPending, overlap, bigram, bigramRaw, shared, episode: supportEps[0] ?? null });
  }
  return {
    itemId: item?.id ?? null,
    at: Number.isFinite(item?.at) ? item.at : null,
    kind: item?.kind ?? null,
    signalSource: item?.signalSource ?? null,
    episode: item?.episode ?? null,
    scopeKey: item?.scopeKey ?? null,
    signal: String(item?.signal ?? '').slice(0, 120),
    expectedClaimIds: expectedIds.size,
    rendered: rows.length,
    related,
    strict,
    strictTokens: strictTokensOnly,
    strictByBigramOnly: bigramOnly,
    pending,
    unrelated,
    hitStrict: strict > 0,
    hitRelated: related > 0,
    // T362：**内容相关（不限来源局）** —— 与 hitRelated（= 同局）**并列**，不替换。
    // 依据：旧口径把"跨局但内容相关"判为不相关（假阴性 29 条），把"同局但无关"判为相关（假阳性 18 条）。
    // 判据：卡上存在与信号共享 **≥2 判别词组（bigramRaw）或 ≥1 硬实体（overlap）** 的行，**不管它来自哪局**。
    contentRelated: rows.some((r) => (r?.bigramRaw || 0) >= 2 || (r?.overlap || 0) >= 1),
    rows,
  };
}

/**
 * T248 反向证据：**不相关对照组**。
 * 每个考卷随机（按 id 排序的等距抽样，确定性）取 perItem 条 **support 不含该局** 的 claim，
 * 用同一判据（判别词 / 硬实体）判"是否相关"。误判率 = 被判相关的比例。
 * 放水的判据会在这里暴露：如果硬实体桥把无关 claim 也判相关，误判率会显著上升。
 */
export function negativeControl({ store, exam, perItem = 3, signalMode = null } = {}) {
  const claims = store.list('claims').map((e) => e.record).filter(Boolean).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const byId = new Map(claims.map((c) => [String(c.id), c]));
  let n = 0;
  let bridged = 0;
  let tokenHit = 0;
  const examples = [];
  for (const item of exam?.items ?? []) {
    const expectedEps = new Set(item?.expected?.episodes ?? []);
    const expectedIds = new Set(item?.expected?.claimIds ?? []);
    const pool = claims.filter((c) => {
      const eps = (Array.isArray(c.support) ? c.support : []).map((s) => String(s?.episode ?? ''));
      return !eps.some((ep) => expectedEps.has(ep)) && !expectedIds.has(String(c.id));
    });
    if (!pool.length) continue;
    const step = Math.max(1, Math.floor(pool.length / perItem));
    for (let i = 0; i < perItem && i * step < pool.length; i += 1) {
      const c = byId.get(String(pool[i * step].id));
      if (!c) continue;
      n += 1;
      const sig = signalMode ? (item?.signals?.[signalMode] ?? '') : item.signal;
      if (!String(sig ?? '').trim()) continue;
      const shared = sharedHardEntities(sig, c.text ?? '');
      const overlap = overlapCount(sig, c.text ?? '');
      if (shared.length >= 1) {
        bridged += 1;
        if (examples.length < 3) examples.push({ item: item.id, claimId: c.id, shared: shared.slice(0, 3), text: String(c.text).slice(0, 60) });
      }
      if (overlap >= 2) tokenHit += 1;
    }
  }
  return { n, bridged, tokenHit, bridgeRate: n ? bridged / n : null, tokenRate: n ? tokenHit / n : null, examples };
}

/**
 * T318 · 信号哈希（把信号钉进考卷）。
 * 为什么：T317 定位到"重归档后 37 条 episode 的根任务文本变了"，主判据现场重建 ⇒ 与冻结考卷拿不同信号。
 * 修法：考卷存 `signalHash`；重放时**只读冻结信号**，并校验哈希——不符就拒绝出数。
 */
export function signalHash(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/**
 * 重放**冻结考卷**（只读 exam.results[].signal，不重建 exam）。
 * 与 `runHoldout` 的区别：信号、expected、at 全部来自考卷，库只用来建卡。
 * @returns {{n, strictHits, strictRate, wilson, byKind, control, hashMismatch, controlCurrent}}
 */
export function replayFrozen({ store, exam, limit = 5, budgetTokens = 500, cache = null, costIndex = null, f3OnCard = true } = {}) {
  const walkCache = cache ?? createWalkCache(store);
  const items = Array.isArray(exam?.results) ? exam.results : [];
  const rows = [];
  const hashMismatch = [];
  for (const item of items) {
    const expect = typeof item.signalHash === 'string' ? item.signalHash : null;
    const actual = signalHash(item.signal);
    if (expect && expect !== actual) { hashMismatch.push({ itemId: item.itemId, expect: expect.slice(0, 12), actual: actual.slice(0, 12) }); continue; }
    const at = Number.isFinite(item.at) ? Number(item.at) : Date.now();
    const signal = signalFromText(item.signal, { at });
    if (item.scopeKey) signal.scopeKey = item.scopeKey;
    let card = null;
    try {
      const walk = walkFromSignals({ signal, store, scope: item.scopeKey, depth: 2, limit, budgetTokens, cache: walkCache });
      card = buildMemoryCard({ cache: walkCache, signal, walkResult: walk, store, scope: item.scopeKey, now: at, limit, budgetTokens, costIndex, f3OnCard });
    } catch { card = null; }
    // 冻结考卷只存 expectedClaimIds（没有 expected.episodes）⇒ 必须补齐，否则 related 永远为假（T318 踩过）
    // 冻结考卷只存 expectedClaimIds ⇒ 两条通道都补上（support 含该局 或 claim id 命中）
    // T320：优先用考卷里钉死的 expectedEpisodes（repeat 题的 prior 局），否则回退到该局自身
    const episodes = Array.isArray(item.expectedEpisodes) && item.expectedEpisodes.length
      ? item.expectedEpisodes.map(String)
      : [String(item.episode ?? '')];
    const expected = item.expected ?? {
      episodes,
      claimIds: Array.isArray(item.expectedClaimIds) ? item.expectedClaimIds.map(String) : [],
    };
    const judged = judgeCard({ card, store, item: { ...item, signal: item.signal, at, expected } });
    rows.push({ itemId: item.itemId, kind: item.kind, episode: item.episode, hitStrict: judged.hitStrict, rendered: judged.rendered, rows: judged.rows });
  }
  const strictHits = rows.filter((r) => r.hitStrict).length;
  const n = rows.length;
  const byKind = {};
  for (const r of rows) {
    const k = r.kind === 'repeat' ? 'repeat/signature' : `${r.kind}`;
    byKind[k] = byKind[k] ?? { n: 0, strict: 0 };
    byKind[k].n += 1;
    if (r.hitStrict) byKind[k].strict += 1;
  }
  return { n, strictHits, strictRate: n ? strictHits / n : null, wilson: wilsonInterval(strictHits, n), byKind, hashMismatch, rows };
}

/** 跑全套考卷（只读）。 */
export function runHoldout({ store, exam, limit = 5, budgetTokens = 500, now = null, cache = null, signalMode = null, costIndex = null, f3OnCard = true } = {}) {
  const walkCache = cache ?? createWalkCache(store);
  // T286：**IDF 过滤器必须真的接上** —— `buildBigramDf` 之前定义了却从没被调用，
  // 于是 `bigramFilter` 恒为 null ⇒ 过滤不生效，读数停在"不过滤"的 50.88%（含泛词水分）。
  // 用**全库 claim** 统计 bigram 的 df；`maxDfRatio` 默认 0.02（三档对照见 evidence/T286-bigram-idf.md）。
  const bigramFilter = (() => {
    try {
      const claims = (store.list('claims') ?? []).map((e) => e.record ?? e);
      return buildBigramDf(claims);
    } catch { return null; }
  })();
  const results = [];
  for (const item of exam?.items ?? []) {
    const at = Number.isFinite(item.at) ? item.at : (Number.isFinite(now) ? now : Date.now());
    const text = signalMode ? (item?.signals?.[signalMode] ?? null) : item.signal;
    if (text == null || String(text).trim() === '') continue; // 该模式没有信号 ⇒ 不进分母
    const signal = signalFromText(text, { at });
    if (item.scopeKey) signal.scopeKey = item.scopeKey;
    let card = null;
    try {
      const walk = walkFromSignals({ signal, store, scope: item.scopeKey, depth: 2, limit, budgetTokens, cache: walkCache });
      card = buildMemoryCard({ cache: walkCache, signal, walkResult: walk, store, scope: item.scopeKey, now: at, limit, budgetTokens, costIndex, f3OnCard });
    } catch (error) {
      results.push({ itemId: item.id, kind: item.kind, signalSource: item.signalSource, episode: item.episode, error: String(error?.message ?? error), hitStrict: false, hitRelated: false, rendered: 0 });
      continue;
    }
    // 判分必须用**该路自己的信号**（否则 task 臂会拿 B 的信号判分，口径就串了）
    const judged = judgeCard({ card, store, item: { ...item, signal: text }, bigramFilter });
    judged.signal = text;
    judged.signalHash = signalHash(text);
    judged.expectedEpisodes = Array.isArray(item?.expected?.episodes) ? item.expected.episodes.map(String) : [];
    results.push(judged);
  }
  const evaluated = results.filter((r) => !r.error);
  const strictHits = evaluated.filter((r) => r.hitStrict).length;
  const relatedHits = evaluated.filter((r) => r.hitRelated).length;
  // T362：并列口径（内容相关，不限局）与**重合分析**（谁在两个方向上被误判）。
  const contentHits = evaluated.filter((r) => r.contentRelated).length;
  const onlyOld = evaluated.filter((r) => r.hitRelated && !r.contentRelated).length;
  const onlyNew = evaluated.filter((r) => !r.hitRelated && r.contentRelated).length;
  const neither = evaluated.filter((r) => !r.hitRelated && !r.contentRelated).length;
  const n = evaluated.length;
  const pendingRows = evaluated.reduce((acc, r) => acc + (r.pending ?? 0), 0);
  const unrelatedRows = evaluated.reduce((acc, r) => acc + (r.unrelated ?? 0), 0);
  const relatedRows = evaluated.reduce((acc, r) => acc + (r.related ?? 0), 0);
  const byKind = {};
  for (const r of evaluated) {
    const k = `${r.kind ?? 'unknown'}/${r.signalSource ?? '?'}`;
    byKind[k] = byKind[k] ?? { n: 0, strict: 0, related: 0 };
    byKind[k].n += 1;
    if (r.hitStrict) byKind[k].strict += 1;
    if (r.hitRelated) byKind[k].related += 1;
  }
  const control = negativeControl({ store, exam, signalMode });
  return {
    version: HOLDOUT_VERSION,
    control,
    generatedAt: Number.isFinite(now) ? now : Date.now(),
    claimsCount: store.list('claims').length,   // T315：钉住"当时的库规模"，重跑时比对
    n,
    errors: results.filter((r) => r.error).length,
    strictHits,
    relatedHits,
    contentHits,
    contentRate: n ? contentHits / n : 0,
    overlap: { onlyOld, onlyNew, neither },

    strictRate: n ? strictHits / n : null,
    relatedRate: n ? relatedHits / n : null,
    wilson: {
      strict: wilsonInterval(strictHits, n),
      related: wilsonInterval(relatedHits, n),
    },
    rows: { related: relatedRows, pending: pendingRows, unrelated: unrelatedRows },
    byKind,
    results,
  };
}

/**
 * T263 · 三路信号对照（同一批题）：task（只用任务原话）/ entity（只用硬实体）/ composite（原话+实体）。
 * 每条考卷的 `signals` 里三种信号都存着；没有该路信号的题**不进该路的分母**（如实标注 n）。
 */
export function compareSignalModes({ store, exam, limit = 5, budgetTokens = 500, cache = null, modes = ['task', 'taskPlusEntity', 'postHoc'] } = {}) {
  const walkCache = cache ?? createWalkCache(store);
  const out = {};
  for (const mode of modes) {
    const r = runHoldout({ store, exam, limit, budgetTokens, cache: walkCache, signalMode: mode });
    out[mode] = {
      n: r.n,
      strictHits: r.strictHits,
      strictRate: r.strictRate,
      wilson: r.wilson.strict,
      control: r.control,
      byKind: r.byKind,
      // 信号可得性：true = 注入时刻（pre-step）就能拿到；false = 事后信息（作弊对照，不进主判据）
      injectionTime: exam?.items?.find((x) => x?.signalMeta?.[mode])?.signalMeta?.[mode]?.injectionTime ?? null,
      desc: exam?.items?.find((x) => x?.signalMeta?.[mode])?.signalMeta?.[mode]?.desc ?? null,
    };
  }
  return out;
}

const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : 'n/a');

export function formatReport(r) {
  const lines = [];
  lines.push(`A2b 考卷（T236a）· n=${r.n}${r.errors ? ` · 构建失败 ${r.errors}` : ''}`);
  lines.push(`严格命中 ${r.strictHits}/${r.n} = ${pct(r.strictRate)} · Wilson 95% [${pct(r.wilson.strict.lower)}, ${pct(r.wilson.strict.upper)}]`);
  lines.push(`宽松命中 ${r.relatedHits}/${r.n} = ${pct(r.relatedRate)} · Wilson 95% [${pct(r.wilson.related.lower)}, ${pct(r.wilson.related.upper)}]`);
  // T362：**并列口径**（内容相关，不限来源局）—— 不改旧口径，两个都报。
  if (r.contentHits !== undefined) {
    lines.push(`内容相关（不限局） ${r.contentHits}/${r.n} = ${pct(r.contentRate)} · 仅旧口径 ${r.overlap.onlyOld}（同局但内容重合低）· **仅新口径 ${r.overlap.onlyNew}（跨局但内容相关）** · 都未命中 ${r.overlap.neither}`);
  }
  lines.push(`渲染行：related ${r.rows.related} · pending ${r.rows.pending} · unrelated ${r.rows.unrelated}`);
  lines.push(`分类型：${Object.entries(r.byKind).map(([k, v]) => `${k} n=${v.n} 严格 ${v.strict} 宽松 ${v.related}`).join(' · ')}`);
  if (r.control) {
    const c = r.control;
    lines.push(`不相关对照组：n=${c.n} · 硬实体桥误判 ${c.bridged}（${pct(c.bridgeRate)}）· 仅判别词误判 ${c.tokenHit}（${pct(c.tokenRate)}）`);
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const home = defaultHome();
  const store = createStore({ root: path.resolve(opt('store', path.join(home, 'memory-context'))) });
  const minSignalChars = Number(opt('min-signal', '12'));
  const limit = Number(opt('limit', '5'));
  const exam = buildExam({ store, home, minSignalChars, includeRepeat: !argv.includes('--no-repeat') });
  // T337：镜像线上 plugin.mjs —— 从 sidecar 读 costIndex（缺失 ⇒ null ⇒ 不过滤，行为不变）。
  // 实测（对照实验，冻结考卷 114 题）：传 vs 不传 Δ=0.00pp、逐题翻转 0 ⇒ 对主判据零影响。
  const storeRoot = path.resolve(opt('store', path.join(home, 'memory-context')));
  let costIndex = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(storeRoot, 'corpus', 'antipattern-cost.json'), 'utf8'));
    if (raw && raw.costs && typeof raw.costs === 'object') costIndex = new Map(Object.entries(raw.costs));
  } catch { costIndex = null; }
  const result = runHoldout({ store, exam, limit, now: Date.now(), costIndex });
  const compare = argv.includes('--compare') ? compareSignalModes({ store, exam, limit }) : null;
  const out = { stats: exam.stats, skipped: exam.skipped.slice(0, 20), ...result, results: argv.includes('--json') ? result.results : undefined };
  if (argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return 0; }
  console.log(formatReport(result));
  if (compare) {
    console.log('');
    console.log('三路信号对照（同一批题 · 严格命中 / Wilson / 对照误判）：');
    for (const mode of Object.keys(compare)) {
      const c = compare[mode];
      const ctrl = c.control ?? {};
      const avail = c.injectionTime === true ? 'injectionTime=✅可达' : (c.injectionTime === false ? 'injectionTime=❌事后(作弊)' : 'injectionTime=?');
      console.log(`  ${mode.padEnd(15)} n=${c.n} · 严格 ${c.strictHits}/${c.n} = ${pct(c.strictRate)} · Wilson [${pct(c.wilson.lower)}, ${pct(c.wilson.upper)}] · ${avail} · 对照 n=${ctrl.n ?? 0} 硬实体误判 ${ctrl.bridged ?? 0}（${pct(ctrl.bridgeRate)}）· 判别词误判 ${ctrl.tokenHit ?? 0}（${pct(ctrl.tokenRate)}）`);
    }
  }
  console.log(`构造：claims ${exam.stats.claims} · 有 claim 的局 ${exam.stats.episodesWithClaims} · self ${exam.stats.self} · repeat ${exam.stats.repeat} · 跳过 ${exam.stats.skipped}`);
  return 0;
}

if (process.argv[1] && String(process.argv[1]).split(String.fromCharCode(92)).join('/').endsWith('scripts/a2b-holdout.mjs')) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(`考卷构造失败：${String(error?.message ?? error)}`); process.exitCode = 2; });
}

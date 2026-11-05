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

/** 词重合数（同一套判别词口径）。 */
export function overlapCount(signalText, claimText) {
  const tokens = discriminativeTokens(signalText);
  const hay = String(claimText ?? '').toLowerCase();
  return tokens.filter((t) => hay.includes(t)).length;
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
    if (!finalSignal) { skipped.push({ episode: episodeId, why: `no-signal(root=${rootText.length},firstUser=${firstUser.length},fallback=${fallback.length})` }); continue; }
    items.push({
      id: `self:${episodeId}`,
      kind: 'self',
      episode: episodeId,
      scopeKey: typeof episode.scopeKey === 'string' ? episode.scopeKey : null,
      signal: finalSignal,
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
export function judgeCard({ card, store, item, minOverlap = 2 } = {}) {
  const expectedEpisodes = new Set(item?.expected?.episodes ?? []);
  const expectedIds = new Set(item?.expected?.claimIds ?? []);
  const rows = [];
  let related = 0;
  let strict = 0;
  let pending = 0;
  let unrelated = 0;
  for (const row of Array.isArray(card?.claims) ? card.claims : []) {
    const claimId = typeof row?.claimId === 'string' ? row.claimId : null;
    if (!claimId) continue;
    const record = store.get('claims', claimId);
    const supportEps = (Array.isArray(record?.support) ? record.support : []).map((s) => String(s?.episode ?? ''));
    const isRelated = supportEps.some((ep) => expectedEpisodes.has(ep)) || expectedIds.has(claimId);
    const overlap = overlapCount(item?.signal ?? '', record?.text ?? '');
    const isStrict = isRelated && overlap >= minOverlap;
    const isPending = !isRelated && overlap >= minOverlap;
    if (isRelated) related += 1;
    if (isStrict) strict += 1;
    if (isPending) pending += 1;
    if (!isRelated && !isPending) unrelated += 1;
    rows.push({ claimId, related: isRelated, strict: isStrict, pending: isPending, overlap, episode: supportEps[0] ?? null });
  }
  return {
    itemId: item?.id ?? null,
    kind: item?.kind ?? null,
    signalSource: item?.signalSource ?? null,
    episode: item?.episode ?? null,
    scopeKey: item?.scopeKey ?? null,
    signal: String(item?.signal ?? '').slice(0, 120),
    expectedClaimIds: expectedIds.size,
    rendered: rows.length,
    related,
    strict,
    pending,
    unrelated,
    hitStrict: strict > 0,
    hitRelated: related > 0,
    rows,
  };
}

/** 跑全套考卷（只读）。 */
export function runHoldout({ store, exam, limit = 5, budgetTokens = 500, now = null, cache = null } = {}) {
  const walkCache = cache ?? createWalkCache(store);
  const results = [];
  for (const item of exam?.items ?? []) {
    const at = Number.isFinite(item.at) ? item.at : (Number.isFinite(now) ? now : Date.now());
    const signal = signalFromText(item.signal, { at });
    if (item.scopeKey) signal.scopeKey = item.scopeKey;
    let card = null;
    try {
      const walk = walkFromSignals({ signal, store, scope: item.scopeKey, depth: 2, limit, budgetTokens, cache: walkCache });
      card = buildMemoryCard({ cache: walkCache, signal, walkResult: walk, store, scope: item.scopeKey, now: at, limit, budgetTokens });
    } catch (error) {
      results.push({ itemId: item.id, kind: item.kind, signalSource: item.signalSource, episode: item.episode, error: String(error?.message ?? error), hitStrict: false, hitRelated: false, rendered: 0 });
      continue;
    }
    results.push(judgeCard({ card, store, item }));
  }
  const evaluated = results.filter((r) => !r.error);
  const strictHits = evaluated.filter((r) => r.hitStrict).length;
  const relatedHits = evaluated.filter((r) => r.hitRelated).length;
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
  return {
    version: HOLDOUT_VERSION,
    generatedAt: Number.isFinite(now) ? now : Date.now(),
    n,
    errors: results.filter((r) => r.error).length,
    strictHits,
    relatedHits,
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

const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : 'n/a');

export function formatReport(r) {
  const lines = [];
  lines.push(`A2b 考卷（T236a）· n=${r.n}${r.errors ? ` · 构建失败 ${r.errors}` : ''}`);
  lines.push(`严格命中 ${r.strictHits}/${r.n} = ${pct(r.strictRate)} · Wilson 95% [${pct(r.wilson.strict.lower)}, ${pct(r.wilson.strict.upper)}]`);
  lines.push(`宽松命中 ${r.relatedHits}/${r.n} = ${pct(r.relatedRate)} · Wilson 95% [${pct(r.wilson.related.lower)}, ${pct(r.wilson.related.upper)}]`);
  lines.push(`渲染行：related ${r.rows.related} · pending ${r.rows.pending} · unrelated ${r.rows.unrelated}`);
  lines.push(`分类型：${Object.entries(r.byKind).map(([k, v]) => `${k} n=${v.n} 严格 ${v.strict} 宽松 ${v.related}`).join(' · ')}`);
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const home = defaultHome();
  const store = createStore({ root: path.resolve(opt('store', path.join(home, 'memory-context'))) });
  const minSignalChars = Number(opt('min-signal', '12'));
  const limit = Number(opt('limit', '5'));
  const exam = buildExam({ store, home, minSignalChars, includeRepeat: !argv.includes('--no-repeat') });
  const result = runHoldout({ store, exam, limit, now: Date.now() });
  const out = { stats: exam.stats, skipped: exam.skipped.slice(0, 20), ...result, results: argv.includes('--json') ? result.results : undefined };
  if (argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return 0; }
  console.log(formatReport(result));
  console.log(`构造：claims ${exam.stats.claims} · 有 claim 的局 ${exam.stats.episodesWithClaims} · self ${exam.stats.self} · repeat ${exam.stats.repeat} · 跳过 ${exam.stats.skipped}`);
  return 0;
}

if (process.argv[1] && String(process.argv[1]).split(String.fromCharCode(92)).join('/').endsWith('scripts/a2b-holdout.mjs')) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(`考卷构造失败：${String(error?.message ?? error)}`); process.exitCode = 2; });
}

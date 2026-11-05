#!/usr/bin/env node
// T285 · "主题入口"诊断（只读）：T281 拆出的 B2 —— 27 条"该局从未被 walk 命中"到底是哪一类。
//
// 三问（对每一条）：
//   1. 该局**有哪些 topic**（`topics/` 里 `episodes` 含该局的记录）？
//   2. 这些 topic 的 **df** 分布 —— 是不是 df=1（只有这一局用这个词，天生连不出去）？
//   3. **任务原话**里有没有任何能撞上这些 topic 的词（判别词 / 中文二元组两套口径）？
//   另：该局的 claim **有没有** `topicRoot` 边（T192）？
//
// 归因（互斥、按优先级 E1 > E2 > E3）：
//   E1 · 该局**没抽到 topic**         —— `topics/` 里没有任何以该局为证据的记录（R04 抽取漏了）
//   E2 · 有 topic 但**全是 df=1**     —— 每个词都只出现在这一局，**天生连不出去**
//   E3 · 有 df>1 的 topic，但**任务原话与它们词面不重合** —— 表达差异（中文整段 vs 英文路径/标识符）
//
// 原型（只读、不接生产）：**中文二元组**主题匹配 —— 若允许"任务原话的 2-gram 出现在 topic key 里"即算命中，
//   看 27 条里有多少能**因此获得入口**；并给出误判率（触发到的 topic 里，有多少**不含**该局 ⇒ 假入口）。
//
// 纪律：只读真库；不改任何 claim；不改 `src/**`；零模型调用。
// 用法：node scripts/topic-entry-diagnose.mjs [--json] [--store <dir>]

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';
import { createWalkCache, walkFromSignals, matchTopics } from '../src/rooms/walk.mjs';
import { buildMemoryCard, signalFromText } from '../src/rooms/inject.mjs';
import { buildExam, claimsByEpisode, discriminativeTokens, overlapCount, sharedHardEntities } from './a2b-holdout.mjs';
import { classifyRecall, signalHasCue } from './recall-coverage.mjs';

export const TOPIC_ENTRY_VERSION = 1;
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 中文二元组（与 walk 的 term 抽取、T284 的中文口径同源）。 */
export function cjkBigrams(text) {
  const out = new Set();
  const raw = String(text ?? '');
  for (const run of raw.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2));
  }
  return [...out];
}

/** walk 的 `overlaps()` 同口径（子串包含，最短可比长度见下）。 */
function overlaps(needle, key) {
  const x = String(needle ?? '').toLowerCase();
  const y = String(key ?? '').toLowerCase();
  if (x === '' || y === '') return false;
  const min = (s) => (/[\u3400-\u9fff]/.test(s) ? 2 : 3);
  if (x.length < min(x) || y.length < min(y)) return false;
  return x.includes(y) || y.includes(x);
}

/** 词面重合：判别词（judge 口径）+ 中文二元组（T284 口径）。 */
export function signalOverlapsTopic(signal, topicKey) {
  const judge = discriminativeTokens(signal).some((tok) => String(topicKey ?? '').toLowerCase().includes(tok));
  const bigram = cjkBigrams(signal).some((bg) => String(topicKey ?? '').toLowerCase().includes(bg));
  return { judge, bigram, any: judge || bigram };
}

/**
 * 对一个 episode 做主题入口诊断。
 * @param {{episode:string, signal:string, topics:object[], claimCount:number, topicRootEdges:number}} p
 */
export function classifyEntry({ episode = '', signal = '', topics = [], claimCount = 0, topicRootEdges = 0 } = {}) {
  const withDf = topics.map((t) => ({ id: String(t.id ?? ''), key: String(t.key ?? ''), kind: String(t.kind ?? ''), df: Number(t.df) || 0 }));
  const maxDf = withDf.reduce((best, t) => Math.max(best, t.df), 0);
  const matched = withDf.filter((t) => signalOverlapsTopic(signal, t.key).any);
  if (!withDf.length) {
    return { code: 'E1', why: '该局在 topics/ 里没有任何记录（R04 抽取漏了）', topics: withDf, maxDf: 0, matched: [], topicRootEdges };
  }
  if (maxDf <= 1) {
    return { code: 'E2', why: `有 ${withDf.length} 个 topic，但**全部 df=1**（只有这一局用这个词 ⇒ 天生连不出去）`, topics: withDf, maxDf, matched, topicRootEdges };
  }
  // E3 再分两层：自家 topic 与任务原话**有没有**词面重合（用两套口径分别看）
  const judgeMatched = withDf.filter((t) => signalOverlapsTopic(signal, t.key).judge).length;
  const bigramMatched = withDf.filter((t) => signalOverlapsTopic(signal, t.key).bigram).length;
  // E3 子标签：a=完全无词面重合（纯表达差异）· b=只有中文 bigram 重合（判别词口径缺中文）· c=判别词就重合（入口本来就通）
  const sub = judgeMatched > 0 ? 'E3c' : (bigramMatched > 0 ? 'E3b' : 'E3a');
  return {
    code: 'E3',
    sub,
    why: judgeMatched + bigramMatched === 0
      ? `有 ${withDf.length} 个 topic（最大 df=${maxDf}），但任务原话与它们**零词面重合**（判别词 0 / 中文 bigram 0）⇒ 纯表达差异`
      : `有 ${withDf.length} 个 topic（最大 df=${maxDf}），词面重合：判别词 ${judgeMatched} 个 / 中文 bigram ${bigramMatched} 个`,
    topics: withDf,
    maxDf,
    matched,
    judgeMatched,
    bigramMatched,
    topicRootEdges,
  };
}

/** 主测量：T281 的 B2（related === 0 的 B 类）逐条诊断。 */
/**
 * T281 口径的判据（HEAD 版 `judgeStrict`：`overlap>=2 || 硬实体>=1`，**不含 T284 的中文 bigram 并集**）。
 * 为什么不用 `judgeCard`：`scripts/a2b-holdout.mjs` 正被 T284 改，跟着漂会让 B2 集不稳定。
 */
export function judgeCardHead({ card, store, item, minOverlap = 2 } = {}) {
  const expectedEpisodes = new Set(item?.expected?.episodes ?? []);
  const expectedIds = new Set(item?.expected?.claimIds ?? []);
  let related = 0;
  let strict = 0;
  for (const row of Array.isArray(card?.claims) ? card.claims : []) {
    const claimId = typeof row?.claimId === 'string' ? row.claimId : null;
    if (!claimId) continue;
    const record = store.get('claims', claimId);
    const supportEps = (Array.isArray(record?.support) ? record.support : []).map((x) => String(x?.episode ?? ''));
    const isRelated = supportEps.some((ep) => expectedEpisodes.has(ep)) || expectedIds.has(claimId);
    if (!isRelated) continue;
    related += 1;
    const overlap = overlapCount(item?.signal ?? '', record?.text ?? '');
    const shared = sharedHardEntities(item?.signal ?? '', record?.text ?? '');
    if (overlap >= minOverlap || (Array.isArray(shared) && shared.length >= 1)) strict += 1;
  }
  return { related, hitStrict: strict > 0 };
}

/** 用 T281 口径重算考卷四类，只留下 B2（related === 0 的 B 类）。 */
export function deriveB2({ store, home, limit = 5 } = {}) {
  const exam = buildExam({ store, home });
  const claims = store.list('claims').map((e) => e.record).filter(Boolean);
  const byEpisode = claimsByEpisode(claims);
  const cache = createWalkCache(store);
  const rows = [];
  for (const item of exam?.items ?? []) {
    const at = Number.isFinite(item.at) ? item.at : Date.now();
    const signal = signalFromText(item.signal, { at });
    if (item.scopeKey) signal.scopeKey = item.scopeKey;
    let strict = false;
    let related = 0;
    try {
      const walk = walkFromSignals({ signal, store, scope: item.scopeKey, depth: 2, limit, budgetTokens: 500, cache });
      const card = buildMemoryCard({ cache, signal, walkResult: walk, store, scope: item.scopeKey, now: at, limit, budgetTokens: 500 });
      const judged = judgeCardHead({ card, store, item });
      strict = judged.hitStrict;
      related = judged.related;
    } catch { /* 单条失败按未命中 */ }
    const expectedEpisodes = (item.expected?.episodes ?? []).map(String);
    const hasGoods = expectedEpisodes.some((ep) => (byEpisode.get(ep) ?? []).length > 0);
    const cls = classifyRecall({ strict, hasGoods, hasSignal: signalHasCue(item.signal) });
    rows.push({
      episode: expectedEpisodes[0] ?? item.episode,
      signal: String(item.signal ?? ''),
      cls,
      related,
    });
  }
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const row of rows) counts[row.cls] = (counts[row.cls] ?? 0) + 1;
  return { n: rows.length, counts, b2: rows.filter((row) => row.cls === 'B' && row.related === 0) };
}

export function diagnoseTopicEntry({ store, home = process.env.DSH_HOME || 'D:/DeepSeek Harness/home' } = {}) {
  const base = deriveB2({ store, home });
  const b2 = base.b2;
  const topics = store.list('topics').map((entry) => entry.record).filter(Boolean);
  const claims = store.list('claims').map((entry) => entry.record).filter(Boolean);
  const byEpisode = new Map();
  for (const topic of topics) {
    for (const ep of Array.isArray(topic.episodes) ? topic.episodes : []) {
      if (!byEpisode.has(ep)) byEpisode.set(ep, []);
      byEpisode.get(ep).push(topic);
    }
  }

  const rows = [];
  for (const row of b2) {
    const episode = String(row.episode ?? '');
    const episodeTopics = byEpisode.get(episode) ?? [];
    const episodeClaims = claims.filter((claim) => (Array.isArray(claim.support) ? claim.support : []).some((s) => String(s?.episode ?? '') === episode));
    // T192 的 topicRoot 边：仓库里是否存在这个符号（grep 0 命中 ⇒ 0 条）
    const topicRootEdges = episodeClaims.reduce((n, claim) => n + (Array.isArray(claim.topicRoot) ? claim.topicRoot.length : 0), 0);
    const signal = String(row.signal ?? '');
    const verdict = classifyEntry({ episode, signal, topics: episodeTopics, claimCount: episodeClaims.length, topicRootEdges });
    // T285 修正：T281 的 `episodeHitByWalk` 是 **top-5 hits** 口径，不等于"没有入口"。
    // 这里用 walk 的主题匹配（`matchTopics`，含 picked 的 kind 过滤）判断"该局是否**可达**"。
    const sigObj = signalFromText(signal, { at: 1 });
    const matchedTopics = matchTopics({ signal: sigObj, topics }).filter((m) => m.topic.kind !== 'tool' || m.matchedBy === 'entity');
    const reachable = matchedTopics.some((m) => (Array.isArray(m.topic.episodes) ? m.topic.episodes : []).includes(episode));
    const dfList = [...new Set(verdict.topics.map((t) => t.df))].sort((a, b) => a - b);
    rows.push({
      episode,
      signal,
      code: verdict.code,
      sub: verdict.sub ?? verdict.code,
      why: verdict.why,
      topicCount: verdict.topics.length,
      maxDf: verdict.maxDf,
      dfList,
      topicSample: verdict.topics.slice(0, 6),
      matched: verdict.matched,
      claimCount: episodeClaims.length,
      topicRootEdges,
      entryReachable: reachable,
      matchedTopicCount: matchedTopics.length,
      judgeOverlapMax: episodeClaims.reduce((best, claim) => Math.max(best, overlapCount(signal, claim.text ?? '')), 0),
      judgeMatched: verdict.judgeMatched ?? 0,
      bigramMatched: verdict.bigramMatched ?? 0,
      bigramMatchedTopics: verdict.topics.filter((t) => signalOverlapsTopic(signal, t.key).bigram).length,
    });
  }

  const counts = {};
  for (const row of rows) counts[row.code] = (counts[row.code] ?? 0) + 1;
  const subCounts = {};
  for (const row of rows) subCounts[row.sub] = (subCounts[row.sub] ?? 0) + 1;
  const entry = {
    reachable: rows.filter((row) => row.entryReachable).length,
    unreachable: rows.filter((row) => !row.entryReachable).length,
  };
  const e3Split = {
    zeroOverlapBoth: rows.filter((row) => row.judgeMatched === 0 && row.bigramMatched === 0).length,
    bigramOnly: rows.filter((row) => row.judgeMatched === 0 && row.bigramMatched > 0).length,
    judgeMatch: rows.filter((row) => row.judgeMatched > 0).length,
  };
  const byDf = rows.reduce((acc, row) => {
    const key = row.maxDf === 0 ? 'df=0' : row.maxDf === 1 ? 'df=1' : row.maxDf <= 4 ? 'df=2..4' : 'df>=5';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  // 原型：中文二元组入口 + 误判率（触发到的 topic 里不含该局的占比）
  let triggered = 0;
  let falseEntry = 0;
  const protoGain = [];
  for (const row of rows) {
    const signal = row.signal;
    const hits = topics.filter((topic) => signalOverlapsTopic(signal, topic.key).bigram);
    const leadsToEpisode = hits.filter((topic) => (Array.isArray(topic.episodes) ? topic.episodes : []).includes(row.episode));
    triggered += hits.length;
    falseEntry += hits.length - leadsToEpisode.length;
    if (leadsToEpisode.length) protoGain.push({ episode: row.episode, topics: leadsToEpisode.map((t) => t.key).slice(0, 3) });
  }

  return {
    version: TOPIC_ENTRY_VERSION,
    baseline: { n: base.n, counts: base.counts },
    n: rows.length,
    counts,
    subCounts,
    entry,
    e3Split,
    byDf,
    topicRoot: { symbolInRepo: false, edges: rows.reduce((n, r) => n + r.topicRootEdges, 0) },
    prototype: {
      method: '中文二元组：任务原话的 2-gram 出现在 topic.key 里即算命中（只读、不接生产）',
      gainedEntry: protoGain.length,
      triggeredTopics: triggered,
      falseEntry,
      falseEntryRate: triggered ? falseEntry / triggered : 0,
      samples: protoGain.slice(0, 5),
    },
    rows,
  };
}

const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a');

export function formatReport(r) {
  const L = [];
  L.push(`T285 · 主题入口诊断 · 考卷 n=${r.baseline.n} · 基线 ${JSON.stringify(r.baseline.counts)} · B2 n=${r.n}`);
  L.push('');
  L.push('| 类 | 含义 | 条数 | 占比 |');
  L.push('|---|---|---|---|');
  const meaning = {
    E1: '该局没抽到 topic（R04 抽取漏了）',
    E2: '有 topic 但全部 df=1（天生连不出去）',
    E3: '有 df>1 的 topic，但任务原话与它们词面不重合（表达差异）',
  };
  for (const code of ['E1', 'E2', 'E3']) {
    L.push(`| **${code}** | ${meaning[code]} | ${r.counts[code] ?? 0} | ${pct((r.counts[code] ?? 0) / (r.n || 1))} |`);
  }
  L.push('');
  L.push(`E3 子标签：**E3a 完全无词面重合** ${r.subCounts.E3a ?? 0} · **E3b 只有中文 bigram** ${r.subCounts.E3b ?? 0} · **E3c 判别词就重合** ${r.subCounts.E3c ?? 0}`);
  L.push(`**入口可达性（修正 T281 的 top-5 口径）**：该局能被 walk 的主题匹配连到 **${r.entry.reachable} 条** · 真无入口 ${r.entry.unreachable} 条`);
  L.push(`E3 细分：**判别词与 bigram 都 0** ${r.e3Split.zeroOverlapBoth} 条 · 只有 bigram 命中 ${r.e3Split.bigramOnly} 条 · 判别词命中 ${r.e3Split.judgeMatch} 条`);
  L.push(`该局 topic 的最大 df 分布：${JSON.stringify(r.byDf)}`);
  L.push(`topicRoot 边（T192）：仓库里**没有这个符号**（grep 0 命中）⇒ 本批 ${r.topicRoot.edges} 条`);
  L.push('');
  L.push(`原型（中文二元组）：**${r.prototype.gainedEntry} / ${r.n} 条获得入口** · 触发 topic ${r.prototype.triggeredTopics} 个 · 假入口 ${r.prototype.falseEntry} 个（误判率 ${pct(r.prototype.falseEntryRate)}）`);
  for (const s of r.prototype.samples) L.push(`  ${s.episode} → ${s.topics.join(' / ')}`);
  L.push('');
  for (const code of ['E1', 'E2', 'E3']) {
    const list = r.rows.filter((row) => row.code === code).slice(0, 3);
    if (!list.length) continue;
    L.push(`### ${code}（${r.counts[code] ?? 0} 条中前 ${list.length} 条）`);
    for (const row of list) {
      L.push(`- \`${row.episode}\` · 任务「${row.signal.slice(0, 40)}」`);
      L.push(`  - topic ${row.topicCount} 个（df：${row.dfList.join('/') || '—'}）· 该局 claim ${row.claimCount} 条 · judge 重合最大 ${row.judgeOverlapMax}`);
      L.push(`  - topic 样例：${row.topicSample.map((t) => `${t.kind}:${t.key}(df=${t.df})`).join(' · ') || '（无）'}`);
      L.push(`  - ${row.why}`);
    }
    L.push('');
  }
  return L.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');
  const store = createStore({ root: path.resolve(opt('store', path.join(home, 'memory-context'))) });
  const r = diagnoseTopicEntry({ store, home });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
  console.log(formatReport(r));
  return 0;
}

if (process.argv[1] && String(process.argv[1]).split(String.fromCharCode(92)).join('/').endsWith('scripts/topic-entry-diagnose.mjs')) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(`诊断失败：${String(error?.message ?? error)}`); process.exitCode = 2; });
}

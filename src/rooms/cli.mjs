// R14 cli —— dump / stats / walk（只读；不写 <DSH_HOME>；不新增依赖）
//
// 契约：AGENTS.md §11 R14、docs/数据契约.md。
// 命令：
//   node scripts/cli.mjs stats [--root <dir>] [--json]   扫真实 DSH_HOME：日志数、棋谱数、解析成功率、时间范围
//   node scripts/cli.mjs dump <sid> [--root <dir>]       输出该局的 episode JSON（契约 §2）
//   node scripts/cli.mjs walk <term> [--root <dir>] [--limit <n>] [--json]
//                                                        命中主题 + 相关棋谱指针（深度 1 跳，M1 近似）
//
// 依赖策略：R00/R01/R02 尚未落地时**显式降级**（不假装成功）：
//   - logread 缺失 ⇒ 只解首帧 header（zstdDecompressSync 对多帧拼接只出首帧），标 degraded。
//   - episode 缺失 ⇒ 用内置最小 episode（字段与契约 §2 对齐），标 degraded。
// 这两个降级在 T1 合并后自动失效（代码无需改动），并在输出里如实标注。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { extractTopics, computeDf, deriveScaffoldTopics } from './topic.mjs';
import { buildLinks } from './link.mjs';
import { renderIndex, formatDay } from './index.mjs';

export const USAGE = `棋院 CLI（R14）

用法：
  node scripts/cli.mjs stats [--root <dir>] [--json]
  node scripts/cli.mjs dump <sid> [--root <dir>]
  node scripts/cli.mjs walk <term> [--root <dir>] [--limit <n>] [--json]
  node scripts/cli.mjs index [--root <dir>] [--json]     渲染 index.md（写到 stdout，不落盘）
  node scripts/cli.mjs verify [--store <dir>] [--json]   校验记忆库 manifest/checksums
  node scripts/cli.mjs rebuild [--store <dir>] [--json] 从权威条目重算派生索引

选项：
  --root <dir>   数据根（默认 $DSH_HOME）。只读，不写。
  --json         输出 JSON（stats/walk/index）
  --limit <n>    walk 每个主题最多列几局（默认 5）
  --store <dir> 记忆库根（默认 <root>/memory-context；verify/rebuild 用）
`;

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

export function parseArgs(argv = []) {
  const args = [...argv];
  const cmd = args.shift() ?? '';
  const positional = [];
  const flags = {};
  while (args.length) {
    const a = args.shift();
    if (a === '--json') flags.json = true;
    else if (a === '--root') flags.root = args.shift();
    else if (a.startsWith('--root=')) flags.root = a.slice('--root='.length);
    else if (a === '--store') flags.store = args.shift();
    else if (a.startsWith('--store=')) flags.store = a.slice('--store='.length);
    else if (a === '--limit') flags.limit = Number(args.shift());
    else if (a.startsWith('--limit=')) flags.limit = Number(a.slice('--limit='.length));
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  return { cmd, positional, flags };
}

// ---------------------------------------------------------------------------
// 可选房间（R00 / R01）——缺失时降级，不假装成功
// ---------------------------------------------------------------------------

async function loadOptional(relPath) {
  try {
    return await import(new URL(relPath, import.meta.url));
  } catch {
    return null;
  }
}

let roomCache = null;
async function rooms() {
  if (!roomCache) {
    const [logread, episode, graphread, extract] = await Promise.all([
      loadOptional('./logread.mjs'),
      loadOptional('./episode.mjs'),
      loadOptional('./graphread.mjs'),
      loadOptional('./extract.mjs'),
    ]);
    roomCache = { logread, episode, graphread, extract };
  }
  return roomCache;
}

// ---------------------------------------------------------------------------
// 语料扫描（只读）
// ---------------------------------------------------------------------------

function walkDir(dir, filter, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(full, filter, out);
    else if (e.isFile() && filter(full, e.name)) out.push(full);
  }
  return out;
}

export function listSessionLogs(root) {
  const base = path.join(root, 'sessions');
  const files = walkDir(base, (_full, name) => name.endsWith('.zstd'));
  return files.map((p) => {
    const sessionDir = path.basename(path.dirname(p));
    return {
      path: p,
      sessionId: sessionDir,
      scope: path.basename(path.dirname(path.dirname(p))),
      bytes: safeSize(p),
    };
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function listGraphs(root) {
  const base = path.join(root, 'chess-context', 'sessions');
  const out = [];
  for (const sid of safeReadDir(base)) {
    const dir = path.join(base, sid);
    const graphPath = path.join(dir, 'graph.json');
    if (!fs.existsSync(graphPath)) continue;
    out.push({
      sessionId: sid,
      graphPath,
      deltaPath: path.join(dir, 'graph.json.delta.jsonl'),
      bytes: safeSize(graphPath),
    });
  }
  return out.sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
}

function safeSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function safeReadDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function episodeIdOf(sessionId) {
  const raw = String(sessionId ?? '').replace(/^session-/, '');
  return `ep-${raw.slice(0, 8)}`;
}

function scopeKeyOf(cwd) {
  const c = String(cwd ?? '').trim();
  if (!c) return 'w:<unknown>';
  return `w:${c.replace(/\\/g, '/').replace(/([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`).replace(/\/+$/, '')}`;
}

// ---------------------------------------------------------------------------
// 读取一局会话（优先 R01；缺失时首帧降级）
// ---------------------------------------------------------------------------

/** 首帧 header 降级读法：多帧 zstd 拼接时 zstdDecompressSync 只出首帧。 */
export function readHeaderOnly(logPath) {
  const buf = fs.readFileSync(logPath);
  try {
    const text = zlib.zstdDecompressSync(buf).toString('utf8');
    const line = text.split('\n').find((l) => l.trim());
    return { header: JSON.parse(line), events: [], truncated: false, source: 'header-only' };
  } catch (err) {
    return { header: null, events: [], truncated: true, source: 'header-only', error: String(err?.message ?? err) };
  }
}

export async function readSession(logPath) {
  const { logread } = await rooms();
  if (logread?.parseEvents && logread?.readFrames) {
    const buf = fs.readFileSync(logPath);
    const framesRes = logread.readFrames(buf);
    const frames = Array.isArray(framesRes) ? framesRes : framesRes?.frames;
    const truncated = Array.isArray(framesRes) ? false : Boolean(framesRes?.truncated);
    const parsed = logread.parseEvents(frames ?? []);
    return {
      header: parsed?.header ?? null,
      events: parsed?.events ?? [],
      truncated: truncated || Boolean(parsed?.truncated),
      badLines: parsed?.badLines ?? 0,
      source: 'R01 logread',
    };
  }
  return readHeaderOnly(logPath);
}

/** 最小 episode（契约 §2 字段齐全；R00 缺失时使用）。 */
export function fallbackEpisode({ header, events, logPath, graphPath }) {
  const times = events.map((e) => e?.time).filter((t) => Number.isFinite(t));
  const startedAt = Number.isFinite(header?.createdAt) ? header.createdAt : (times[0] ?? null);
  const lastEventAt = times.length ? Math.max(...times) : startedAt;
  const sessions = String(header?.id ?? path.basename(path.dirname(logPath ?? '')));
  return {
    id: episodeIdOf(sessions),
    sessionId: sessions,
    scopeKey: scopeKeyOf(header?.cwd),
    startedAt,
    endedAt: lastEventAt,
    firstEventAt: times.length ? Math.min(...times) : startedAt,
    lastEventAt,
    timeSource: times.length ? 'event' : 'inferred',
    recordedAt: null,
    agentPreset: header?.agentPreset ?? null,
    delegationDepth: Number.isFinite(header?.delegationDepth) ? header.delegationDepth : 0,
    closure: {
      logPath: logPath ?? null,
      graphPath: graphPath ?? null,
      seqFrom: events.length ? Math.min(...events.map((e) => e?.seq).filter(Number.isFinite)) : null,
      seqTo: events.length ? Math.max(...events.map((e) => e?.seq).filter(Number.isFinite)) : null,
      nodeIds: [],
      edgeIds: [],
    },
    l0: '',
    l1: '',
    signals: { failures: 0, successes: 0, unsettled: 0, constraints: 0, tools: [] },
    threadIds: [],
    state: 'archived',
    degraded: ['episode(R00) 缺失：cli 内置最小 episode'],
  };
}

async function buildEpisodeFor({ header, events, logPath, graphPath }) {
  const { episode } = await rooms();
  const base = fallbackEpisode({ header, events, logPath, graphPath });
  if (episode?.buildEpisode && header && Number.isFinite(header.createdAt)) {
    try {
      const built = episode.buildEpisode({ header, events, graphPath, logPath, now: null });
      return { ...built, degraded: [] };
    } catch (err) {
      return { ...base, degraded: [`episode(R00) 抛错：${String(err?.message ?? err)}`] };
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// 语料 → 主题 / 边
// ---------------------------------------------------------------------------

async function loadGraphSummary({ graphPath, deltaPath }) {
  const { graphread } = await rooms();
  // 正确读法：基线 + delta 逐帧回放（AGENTS 陷阱 2）。R02 缺失才退化成直接 JSON.parse。
  if (graphread?.loadGraphAt) {
    try {
      const res = graphread.loadGraphAt({ basePath: graphPath, deltaPath });
      if (res?.graph) {
        return {
          graph: res.graph,
          deltaFrames: res.frames ?? 0,
          truncated: Boolean(res.truncated),
          ok: true,
          source: 'R02 graphread（基线 + delta 回放）',
        };
      }
      if (res?.missing) return { graph: null, deltaFrames: 0, ok: false, error: 'missing-base' };
      return { graph: null, deltaFrames: 0, ok: false, error: res?.error ?? res?.reason ?? 'graphread 失败' };
    } catch (err) {
      return { graph: null, deltaFrames: 0, ok: false, error: String(err?.message ?? err) };
    }
  }
  try {
    const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
    let deltaFrames = 0;
    let deltaTruncated = false;
    if (deltaPath && fs.existsSync(deltaPath)) {
      const raw = fs.readFileSync(deltaPath, 'utf8');
      deltaFrames = raw.split('\n').filter((l) => l.trim()).length;
      deltaTruncated = Boolean(raw) && !raw.endsWith('\n');
    }
    return { graph, deltaFrames, truncated: deltaTruncated, ok: true, source: 'json-only（R02 缺失：未回放 delta）' };
  } catch (err) {
    return { graph: null, deltaFrames: 0, ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * 建语料：会话日志 + 棋谱配对，返回每局的 episode/主题。
 * @param {{root:string, deep?:boolean}} p deep=true 时解析完整事件（需要 R01；否则只用 header + 棋谱）
 */
export async function buildCorpus({ root, deep = false, limits = {}, includeSubagents = false } = {}) {
  const logs = listSessionLogs(root);
  const graphs = listGraphs(root);
  const bySession = new Map();

  for (const g of graphs) {
    bySession.set(g.sessionId, { sessionId: g.sessionId, graphPath: g.graphPath, deltaPath: g.deltaPath });
  }
  for (const l of logs) {
    const key = l.sessionId;
    const prev = bySession.get(key) ?? { sessionId: key };
    bySession.set(key, { ...prev, logPath: l.path, scopeDir: l.scope, bytes: l.bytes });
  }

  const entries = [];
  const warnings = [];
  const graphStats = { total: graphs.length, ok: 0, nodes: 0, edges: 0, deltaFrames: 0 };
  let headersOk = 0;
  let eventsParsed = 0;
  let fullOk = 0;
  const starts = [];
  const ends = [];

  const ids = [...bySession.keys()].sort((a, b) => (a < b ? -1 : 1));
  for (const sid of ids) {
    const item = bySession.get(sid);
    let header = null;
    let events = [];
    let source = 'none';
    if (item.logPath) {
      try {
        const read = await readSession(item.logPath);
        header = read.header;
        events = read.events ?? [];
        source = read.source;
        if (header) headersOk += 1;
        if (read.source === 'R01 logread' && header) fullOk += 1;
        if (events.length) eventsParsed += events.length;
      } catch (err) {
        warnings.push(`${sid}: 日志读取失败 ${String(err?.message ?? err)}`);
      }
    }
    let graph = null;
    if (item.graphPath) {
      const g = await loadGraphSummary({ graphPath: item.graphPath, deltaPath: item.deltaPath });
      if (g.ok) {
        graph = g.graph;
        graphStats.ok += 1;
        graphStats.nodes += Object.keys(graph.nodes ?? {}).length;
        graphStats.edges += Object.keys(graph.edges ?? {}).length;
        graphStats.deltaFrames += g.deltaFrames;
      } else {
        warnings.push(`${sid}: graph.json 解析失败 ${g.error}`);
      }
    }

    const episode = await buildEpisodeFor({
      header,
      events,
      logPath: item.logPath ?? null,
      graphPath: item.graphPath ?? null,
    });
    if (!header && graph) {
      // 没日志时用棋谱时间兜底（契约允许 occurredAt 来自棋谱 ts）
      const nodeTimes = Object.values(graph.nodes ?? {}).map((n) => n?.ts).filter(Number.isFinite);
      if (!episode.startedAt && nodeTimes.length) episode.startedAt = Math.min(...nodeTimes);
      if (!episode.lastEventAt && nodeTimes.length) episode.lastEventAt = Math.max(...nodeTimes);
    }

    if (Number.isFinite(episode.startedAt)) starts.push(episode.startedAt);
    if (Number.isFinite(episode.lastEventAt)) ends.push(episode.lastEventAt);

    const topics = extractTopics({
      episode: { ...episode, workspace: String(episode.scopeKey ?? '').replace(/^w:/, '') || episode.cwd },
      events,
      graph,
      limits,
    });
    entries.push({ episode, topics, hasLog: Boolean(item.logPath), hasGraph: Boolean(graph), source, graph, events });
  }

  // R03 extract：R00 的 signals 是占位（M1 不读棋谱），失败/成功/约束计数以 R03 的机械抽取为准。
  const { extract } = await rooms();
  if (extract?.extractSignals) {
    for (const entry of entries) {
      try {
        const sig = extract.extractSignals({ graph: entry.graph ?? null, events: entry.events ?? [] });
        const counts = sig?.counts ?? {};
        entry.episode = {
          ...entry.episode,
          signals: {
            failures: counts.failures ?? 0,
            successes: counts.successes ?? 0,
            unsettled: counts.unsettled ?? 0,
            constraints: counts.constraints ?? 0,
            tools: (sig?.tools ?? [])
              .map((t) => (typeof t === 'string' ? t : (t?.key ?? t?.name ?? '')))
              .filter(Boolean)
              .slice(0, 40),
          },
          signalsSource: 'R03 extract',
        };
      } catch (err) {
        warnings.push(`${entry.episode.sessionId}: signals 抽取失败 ${String(err?.message ?? err)}`);
      }
    }
  }

  // 子代理会话归并到父局（AGENTS §4.1「只收 depth=0」+ 陷阱 10）：
  // 建网默认只收根局，除非显式 --include-subagents。父局缺席的子代理局保留（不丢数据）。
  const sessionIds = new Set(entries.map((e) => e.episode.sessionId));
  const isSubagent = (e) => (e.episode.delegationDepth ?? 0) > 0
    && sessionIds.has(e.episode.parentSessionId ?? '');
  const networkEntries = includeSubagents ? entries : entries.filter((e) => !isSubagent(e));

  const perEpisode = deriveScaffoldTopics(networkEntries.map((e) => ({ episodeId: e.episode.id, topics: e.topics })));
  const table = computeDf(perEpisode);
  const withDf = networkEntries.map((e, i) => ({ ...e, topics: perEpisode[i].topics ?? perEpisode[i] }));
  const { mentions, links, stats } = buildLinks({ episodes: withDf.map((e) => ({ ...e.episode, topics: e.topics })), topics: table });

  const logStats = {
    total: logs.length,
    headerOk: headersOk,
    headerParseRate: logs.length ? headersOk / logs.length : null,
    fullParseRate: logs.length ? fullOk / logs.length : null,
    events: eventsParsed,
    bytes: logs.reduce((s, l) => s + l.bytes, 0),
  };

  return {
    root,
    logs: logStats,
    graphs: graphStats,
    episodes: withDf,
    allEpisodes: entries,
    subagentSessions: entries.length - withDf.length,
    includeSubagents,
    topics: table,
    mentions,
    links,
    linkStats: stats,
    timeRange: {
      from: starts.length ? Math.min(...starts) : null,
      to: ends.length ? Math.max(...ends) : null,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 命令：stats
// ---------------------------------------------------------------------------

export function summarizeStats(corpus) {
  const { timeRange } = corpus;
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const topicDf2 = corpus.topics.topics.filter((t) => t.df >= 2).length;
  return {
    root: corpus.root,
    logs: {
      ...corpus.logs,
      timeRange: { from: iso(timeRange.from), to: iso(timeRange.to) },
    },
    graphs: corpus.graphs,
    sessions: {
      total: corpus.allEpisodes.length,
      built: corpus.episodes.length,
      subagentsMerged: corpus.subagentSessions,
      includeSubagents: corpus.includeSubagents,
    },
    topics: {
      total: corpus.topics.topics.length,
      df2: topicDf2,
      byKind: corpus.topics.topics.reduce((acc, t) => { acc[t.kind] = (acc[t.kind] ?? 0) + 1; return acc; }, {}),
    },
    links: corpus.linkStats,
    episodes: corpus.episodes.length,
    warnings: corpus.warnings,
  };
}

function formatStatsText(s) {
  const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  const lines = [];
  lines.push(`棋院 stats（只读）`);
  lines.push(`根：${s.root}`);
  lines.push(`日志：${s.logs.total} 个 · ${(s.logs.bytes / 1048576).toFixed(1)} MiB · header 解析 ${s.logs.headerOk}/${s.logs.total}（${pct(s.logs.headerParseRate)}）· 完整事件解析 ${pct(s.logs.fullParseRate)}`);
  lines.push(`会话：建网 ${s.sessions.built} 局 · 子代理归并 ${s.sessions.subagentsMerged} 局${s.sessions.includeSubagents ? '（本次已含子代理）' : ''}`);
  lines.push(`棋谱：${s.graphs.total} 个 · graph.json 解析 ${s.graphs.ok}/${s.graphs.total}（${s.graphs.total ? pct(s.graphs.ok / s.graphs.total) : 'n/a'}）· 节点 ${s.graphs.nodes} · 边 ${s.graphs.edges} · delta 帧 ${s.graphs.deltaFrames}`);
  lines.push(`主题：${s.topics.total}（df≥2：${s.topics.df2}）`);
  lines.push(`相关边：${s.links.links}（shared-topic ${s.links.byKind['shared-topic']} · same-error ${s.links.byKind['same-error']} · same-file ${s.links.byKind['same-file']}）· mention ${s.links.mentions}`);
  lines.push(`时间范围（UTC）：${s.logs.timeRange.from ?? '?'} → ${s.logs.timeRange.to ?? '?'}`);
  lines.push(`口径：header 解析率 = 首帧 header 可解/日志总数；完整事件解析率需 R01 logread（未落地时为 n/a）；时间范围取各局 startedAt/lastEventAt 的 min/max。`);
  lines.push(`写入：0 字节（CLI 全程只读）。`);
  for (const w of s.warnings.slice(0, 10)) lines.push(`! ${w}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 命令：dump
// ---------------------------------------------------------------------------

function findSession(corpusMap, sid) {
  if (!sid) return null;
  const exact = corpusMap.get(sid);
  if (exact) return exact;
  const hits = [...corpusMap.keys()].filter((k) => k.includes(sid) || k.replace(/^session-/, '').startsWith(sid));
  return hits.length ? corpusMap.get(hits[0]) : null;
}

async function buildOne(root, sid) {
  const corpus = await buildCorpus({ root, includeSubagents: true });
  const map = new Map(corpus.allEpisodes.map((e) => [e.episode.sessionId, e]));
  const hit = findSession(map, sid);
  if (!hit) return { error: `未找到会话：${sid}` };
  return {
    episode: hit.episode,
    summary: {
      sessionId: hit.episode.sessionId,
      episodeId: hit.episode.id,
      scopeKey: hit.episode.scopeKey,
      startedAt: hit.episode.startedAt,
      endedAt: hit.episode.lastEventAt,
      agentPreset: hit.episode.agentPreset,
      delegationDepth: hit.episode.delegationDepth,
      hasLog: hit.hasLog,
      hasGraph: hit.hasGraph,
      readSource: hit.source,
      topics: hit.topics.length,
      logPath: hit.episode.closure?.logPath ?? null,
      graphPath: hit.episode.closure?.graphPath ?? null,
    },
    topics: hit.topics,
  };
}

// ---------------------------------------------------------------------------
// 命令：walk（M1 近似：词面匹配 → 主题 → 棋谱 → 一跳相关）
// ---------------------------------------------------------------------------

export function walkCorpus(corpus, term, { limit = 5 } = {}) {
  const needle = String(term ?? '').toLowerCase();
  if (!needle) return { term, topics: [], matches: [] };
  const byId = corpus.topics.byId;
  const matched = corpus.topics.topics
    .filter((t) => t.key.toLowerCase().includes(needle))
    .sort((a, b) => (a.df - b.df) || (b.idfNorm - a.idfNorm) || (a.key < b.key ? -1 : 1));

  const episodeById = new Map(corpus.episodes.map((e) => [e.episode.id, e]));
  const matches = [];
  for (const t of matched) {
    const holders = corpus.episodes
      .filter((e) => e.topics.some((x) => x.id === t.id))
      .sort((a, b) => ((b.episode.startedAt ?? 0) - (a.episode.startedAt ?? 0)) || (a.episode.id < b.episode.id ? -1 : 1));
    const pointers = holders.slice(0, limit).map((e) => {
      const related = corpus.links
        .filter((l) => l.a.episode === e.episode.id || l.b.episode === e.episode.id)
        .map((l) => ({
          other: l.a.episode === e.episode.id ? l.b.episode : l.a.episode,
          kind: l.kind,
          weight: l.weight,
          why: l.why,
        }))
        .sort((x, y) => (y.weight - x.weight) || (x.other < y.other ? -1 : 1));
      return {
        episode: e.episode.id,
        sessionId: e.episode.sessionId,
        scopeKey: e.episode.scopeKey,
        date: formatDay(e.episode.startedAt),
        failures: e.episode.signals?.failures ?? 0,
        related: related.slice(0, limit),
      };
    });
    matches.push({
      topic: { id: t.id, kind: t.kind, key: t.key, df: t.df, idfNorm: t.idfNorm },
      count: holders.length,
      pointers,
    });
  }

  // 术语也匹配 mention.quote（词面证据），避免 2-gram 切词漏命中
  const quoteHits = corpus.mentions
    .filter((m) => String(m.quote ?? '').toLowerCase().includes(needle))
    .slice(0, limit)
    .map((m) => ({ episode: m.from.episode, topic: m.topic, seq: m.seq, quote: m.quote }));

  void byId;
  void episodeById;
  return { term, topics: matched.slice(0, 10).map((t) => ({ id: t.id, kind: t.kind, key: t.key, df: t.df })), matches, quoteHits };
}

function formatWalkText(result) {
  const lines = [];
  lines.push(`棋院 walk（词面匹配 → 主题 → 棋谱 → 一跳相关）`);
  lines.push(`词：${result.term} · 命中主题 ${result.topics.length} · 命中棋谱组 ${result.matches.length}`);
  if (!result.topics.length) {
    lines.push('（无命中；M1 的 walk 是词面匹配，未命中 ≠ 不存在）');
  }
  for (const m of result.matches) {
    lines.push('');
    lines.push(`# ${m.topic.kind} ${m.topic.key}  (df=${m.topic.df}, idfNorm=${m.topic.idfNorm.toFixed(3)})`);
    for (const p of m.pointers) {
      lines.push(`- ${p.date} ${p.episode} · ${p.scopeKey} · fail=${p.failures}`);
      for (const r of p.related) lines.push(`    → ${r.other} [${r.kind} w=${r.weight}] ${r.why}`);
    }
  }
  if (result.quoteHits.length) {
    lines.push('');
    lines.push('证据片段：');
    for (const q of result.quoteHits) lines.push(`- ${q.episode} #${q.seq ?? '?'} "${String(q.quote).slice(0, 80)}"`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export async function runCli(argv = [], io = {}) {
  const { cmd, positional, flags } = parseArgs(argv);
  const root = path.resolve(flags.root ?? process.env.DSH_HOME ?? '');
  let stdout = '';
  const write = (s) => { stdout += `${s}\n`; };
  const json = (obj) => write(JSON.stringify(obj, null, 2));

  if (!cmd || cmd === 'help' || flags.help) {
    return { code: 0, stdout: USAGE, stderr: '' };
  }

  if (!root || !fs.existsSync(root)) {
    return { code: 2, stdout: '', stderr: `root 不存在：${root || '(空)'}（用 --root 指定，或设置 $DSH_HOME）` };
  }

  const t0 = Date.now();
  try {
    if (cmd === 'stats') {
      const corpus = await buildCorpus({ root, includeSubagents: Boolean(flags['include-subagents']) });
      const summary = summarizeStats(corpus);
      summary.elapsedMs = Date.now() - t0;
      if (flags.json) json(summary);
      else write(formatStatsText(summary));
      return { code: 0, stdout, stderr: '' };
    }

    if (cmd === 'dump') {
      const sid = positional[0];
      if (!sid) return { code: 2, stdout: '', stderr: '用法：dump <sid>' };
      const one = await buildOne(root, sid);
      if (one.error) return { code: 1, stdout: '', stderr: one.error };
      json(one);
      return { code: 0, stdout, stderr: '' };
    }

    if (cmd === 'walk') {
      const term = positional[0];
      if (!term) return { code: 2, stdout: '', stderr: '用法：walk <term>' };
      const corpus = await buildCorpus({ root, includeSubagents: Boolean(flags['include-subagents']) });
      const result = walkCorpus(corpus, term, { limit: Number.isFinite(flags.limit) ? flags.limit : 5 });
      if (flags.json) json(result);
      else write(formatWalkText(result));
      return { code: 0, stdout, stderr: '' };
    }

    if (cmd === 'verify' || cmd === 'rebuild') {
      const storeRoot = path.resolve(flags.store ?? path.join(root, 'memory-context'));
      if (!fs.existsSync(storeRoot)) {
        return { code: 2, stdout: '', stderr: `记忆库不存在：${storeRoot}（先跑 node scripts/archive.mjs --store <dir>）` };
      }
      const { createStore } = await import('./persist.mjs');
      const store = createStore({ root: storeRoot });
      if (cmd === 'verify') {
        const res = store.verify();
        if (flags.json) json(res);
        else {
          const errs = (res.errors ?? []).slice(0, 10).map((e) => `- ${e.code}: ${e.detail ?? e.path ?? ''}`).join(' | ');
          write(`verify: ${res.ok ? 'OK' : 'FAIL'} · 文件 ${res.checked?.files ?? '?'} · 字节 ${res.checked?.bytes ?? '?'} · 错误 ${res.errors?.length ?? 0} · 告警 ${res.warnings?.length ?? 0}${errs ? ' | ' + errs : ''}`);
        }
        return { code: res.ok ? 0 : 1, stdout, stderr: '' };
      }
      const res = await store.rebuild();
      if (flags.json) json(res);
      else write(`rebuild: ${res.refused ? 'REFUSED' : 'OK'} · 派生变更 ${res.changed ?? 0} · 未变 ${res.unchanged ?? 0} · skipped ${res.skipped?.length ?? 0}`);
      return { code: res.refused ? 1 : 0, stdout, stderr: '' };
    }

    if (cmd === 'index') {
      const corpus = await buildCorpus({ root, includeSubagents: Boolean(flags['include-subagents']) });
      const md = renderIndex({
        episodes: corpus.episodes.map((e) => ({ ...e.episode, topics: e.topics })),
        links: corpus.links,
        topics: corpus.topics,
        mentions: corpus.mentions,
        generatedAt: null,
        tz: 'local',
      });
      if (flags.json) json({ markdown: md, episodes: corpus.episodes.length, links: corpus.links.length });
      else write(md);
      return { code: 0, stdout, stderr: '' };
    }

    return { code: 2, stdout: '', stderr: `未知命令：${cmd}\n\n${USAGE}` };
  } catch (err) {
    return { code: 1, stdout, stderr: `失败：${String(err?.stack ?? err)}` };
  }
}

/** 可注入 io 的 main（脚本直接用 process.stdout/stderr）。 */
export async function main(argv = [], io = {}) {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  const res = await runCli(argv, io);
  if (res.stdout) out.write(res.stdout.endsWith('\n') ? res.stdout : `${res.stdout}\n`);
  if (res.stderr) err.write(res.stderr.endsWith('\n') ? res.stderr : `${res.stderr}\n`);
  return res.code;
}

export default { main, runCli, buildCorpus, walkCorpus, parseArgs, summarizeStats };

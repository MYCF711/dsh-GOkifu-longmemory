#!/usr/bin/env node
// 入档管线（R15 persist 的调用方）：会话日志 + 棋谱 → 记忆库（sidecar）
//
// ── 契约（方案.md §4.11 可搬迁内核、AGENTS.md §11 R15、docs/数据契约.md §2/§6）──
// 职责：**只读**上游（`<dataRoot>/sessions`、`<dataRoot>/chess-context/sessions`），
//       把每局会话走一遍 R00/R01/R02/R03/R04 → 写进 store；派生（topics/links/threads/index.md）
//       由 R04/R05/R07/R06 重算。**绝不写上游**；只有 `--store` 指向的目录会被写。
// 命令：
//   node scripts/archive.mjs [--root <dataRoot>] [--store <memoryRoot>] [--dry-run] [--json]
//                            [--include-subagents] [--session <sid-prefix>]
//   --root   数据根（默认 $DSH_HOME）：读 sessions/ 与 chess-context/sessions/
//   --store  记忆库根（默认 <root>/memory-context）：写 entries + manifest + index.md
//   --dry-run 只统计不写（不 mkdir、不写文件、不碰 manifest）
// 幂等：连跑两次，第二次 0 新增 / 0 变更 / manifest checksums 完全相同（updatedAt 也不变）。
//       做法：条目内容比对忽略存储簿记 `_store` 与生成时刻 `updatedAt`；无变更就不重写。
// 可搬迁（§4.11）：
//   - 条目里的来源路径**相对 dataRoot**（如 `sessions/<scope>/<sid>/session.v4.jsonl.zstd`），
//     另存 `sourceRoot:"DSH_HOME"`；绝不写入绝对路径。
//   - 原件不在本机 ⇒ `sourceStatus:"missing"`（不失效、不改 state、不删条目）。
//   - index.md 用 UTC 渲染（跨机器 checksums 不漂）。
// 子代理会话（delegationDepth>0 且父局在语料里）默认 `state:"folded-into:ep-<父局>"`，
//   不参与建网（AGENTS §4.1「只收 depth=0」、陷阱 10）；`--include-subagents` 时才独立成谱。
// 缺失房间显式降级（不假装成功）：R06/R08/R09 未落地时对应目录保持原样，summary.skipped 里明说。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

import {
  createStore,
  deriveStore,
  asRecordList,
  relativizeSource,
  sourceStatusOf,
  validateRelPath,
  sameMemoryContent,
  PersistError,
  AUTHORITATIVE_KINDS,
} from '../src/rooms/persist.mjs';
import { listSessionLogs, listGraphs, readSession } from '../src/rooms/cli.mjs';

export const USAGE = `棋院 archive（R15 入档管线）

用法：
  node scripts/archive.mjs [--root <dataRoot>] [--store <memoryRoot>] [--dry-run] [--json]

选项：
  --root <dir>        数据根（默认 $DSH_HOME）：只读 sessions/ 与 chess-context/sessions/
  --store <dir>       记忆库根（默认 <root>/memory-context）：写 episodes/topics/... + manifest.json
  --dry-run           只统计不写盘（不创建目录、不写文件、不改 manifest）
  --json              输出 JSON 摘要
  --include-subagents 子代理会话独立成谱（默认归并进父局，标 folded-into）
  --session <prefix>  只入档 sessionId 以该前缀开头的会话（调试用）
  -h, --help          本帮助

示例：
  node scripts/archive.mjs --dry-run
  node scripts/archive.mjs --store tmp/memory-context
`;

// 单个 (棋谱, 主题) 入档时保留的证据条数上限（再多也是重复证据，白占空间）
export const MAX_STORED_OCCURRENCES = 6;

export function parseArgs(argv = []) {
  const args = [...argv];
  const flags = {};
  const positional = [];
  while (args.length) {
    const a = args.shift();
    if (a === '--dry-run' || a === '--dryRun') flags.dryRun = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--include-subagents') flags.includeSubagents = true;
    else if (a === '-h' || a === '--help') flags.help = true;
    else if (a === '--root') flags.root = args.shift();
    else if (a.startsWith('--root=')) flags.root = a.slice('--root='.length);
    else if (a === '--store') flags.store = args.shift();
    else if (a.startsWith('--store=')) flags.store = a.slice('--store='.length);
    else if (a === '--session') flags.session = args.shift();
    else if (a.startsWith('--session=')) flags.session = a.slice('--session='.length);
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  return { flags, positional };
}

async function loadOptional(relPath) {
  try {
    return await import(new URL(relPath, import.meta.url));
  } catch {
    return null;
  }
}

async function loadRooms() {
  const [logread, episode, graphread, extract, topic, link, thread, joseki, claim, gates] = await Promise.all([
    loadOptional('../src/rooms/logread.mjs'),
    loadOptional('../src/rooms/episode.mjs'),
    loadOptional('../src/rooms/graphread.mjs'),
    loadOptional('../src/rooms/extract.mjs'),
    loadOptional('../src/rooms/topic.mjs'),
    loadOptional('../src/rooms/link.mjs'),
    loadOptional('../src/rooms/thread.mjs'),
    loadOptional('../src/rooms/joseki.mjs'),
    loadOptional('../src/rooms/claim.mjs'),
    loadOptional('../src/rooms/gates.mjs'),
  ]);
  return { logread, episode, graphread, extract, topic, link, thread, joseki, claim, gates };
}

/** 会话日志的绝对路径 → 相对 dataRoot 的路径（非法/跨盘 ⇒ null，绝不落绝对路径）。 */
export function portableSourcePath(absPath, dataRoot) {
  const rel = relativizeSource(absPath, dataRoot);
  if (rel === null) return null;
  if (!validateRelPath(rel).ok) return null;
  return rel;
}

function clipOccurrences(topics) {
  return (Array.isArray(topics) ? topics : []).map((t) => {
    const occurrences = (Array.isArray(t.occurrences) ? t.occurrences : []).slice(0, MAX_STORED_OCCURRENCES).map((o) => ({
      seq: Number.isFinite(o?.seq) ? o.seq : null,
      quote: String(o?.quote ?? ''),
      occurredAt: Number.isFinite(o?.occurredAt) ? o.occurredAt : null,
      ...(o?.nodeId ? { nodeId: o.nodeId } : {}),
      ...(o?.edgeId ? { edgeId: o.edgeId } : {}),
      ...(o?.source ? { source: o.source } : {}),
    }));
    return {
      id: t.id,
      kind: t.kind,
      key: t.key,
      count: Number.isFinite(t.count) ? t.count : occurrences.length,
      occurrences,
    };
  });
}

function toolNames(signals) {
  const tools = Array.isArray(signals?.tools) ? signals.tools : [];
  return tools
    .map((t) => (typeof t === 'string' ? t : (t?.key ?? t?.name ?? '')))
    .filter((s) => typeof s === 'string' && s !== '')
    .slice(0, 40);
}

/** 一处 dry-run 预估：读现有条目（只读）→ 新增/变更/未变条数。 */
function plannedDiff(store, kind, records) {
  const existing = new Map();
  for (const entry of store.list(kind)) if (entry.record) existing.set(entry.id, entry.record);
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  for (const record of records) {
    const prev = existing.get(record.id);
    if (!prev) added += 1;
    else if (sameMemoryContent(record, prev)) unchanged += 1;
    else changed += 1;
  }
  return { kind, total: records.length, added, changed, unchanged, existing: existing.size };
}

/**
 * 派生/权威条目里由生产者打的"首次出现"时钟，重放时取旧值：
 * 否则 R06/R08/R09 每次用 Date.now() 生成的 createdAt 会让幂等失效（假的"变更"）。
 */
const PRESERVED_CLOCKS = Object.freeze(['createdAt', 'recordedAt', 'generatedAt']);

function stabilizeExisting(store, kind, records) {
  const existing = new Map();
  for (const entry of store.list(kind)) if (entry.record) existing.set(entry.id, entry.record);
  if (existing.size === 0) return records;
  return records.map((record) => {
    const prev = existing.get(record?.id);
    if (!prev) return record;
    const out = { ...record };
    for (const field of PRESERVED_CLOCKS) {
      if (prev[field] !== undefined) out[field] = prev[field];
    }
    return out;
  });
}

/**
 * 来源状态巡检：本机原件还在不在（§4.11 规则 6）。
 * 只对"本轮没重新入档的旧条目"做——本轮写了的就是按本轮读到的原件算的。
 * 原件搬回来 ⇒ 自动回 `present`；原件没了 ⇒ `missing`（不失效、不删条目）。
 */
function refreshSourceStatus(store, dataRoot, writtenIds) {
  const out = [];
  for (const entry of store.list('episodes')) {
    const rec = entry.record;
    if (!rec || writtenIds.has(rec.id)) continue;
    const present = typeof rec.closure?.logPath === 'string'
      && rec.closure.logPath !== ''
      && sourceStatusOf(rec.closure.logPath, dataRoot) === 'present';
    const next = present ? 'present' : 'missing';
    if (rec.sourceStatus !== next) out.push({ ...rec, sourceStatus: next });
  }
  return out;
}

/**
 * 跑一次入档。
 * @param {{dataRoot:string, storeRoot:string, dryRun?:boolean, now?:number,
 *          includeSubagents?:boolean, sessionPrefix?:string|null, limits?:object}} opts
 * @returns {Promise<object>} summary（含真实计数、耗时、verify 结果、skipped 房间）
 */
export async function runArchive(opts = {}) {
  const t0 = Date.now();
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const dataRoot = path.resolve(opts.dataRoot ?? process.env.DSH_HOME ?? '');
  const storeRoot = path.resolve(opts.storeRoot ?? path.join(dataRoot, 'memory-context'));
  const dryRun = Boolean(opts.dryRun);
  const includeSubagents = Boolean(opts.includeSubagents);
  const sessionPrefix = typeof opts.sessionPrefix === 'string' && opts.sessionPrefix !== '' ? opts.sessionPrefix : null;

  if (!opts.dataRoot && !process.env.DSH_HOME) {
    throw new PersistError('archive: 需要 --root 或 $DSH_HOME', 'archive/missing-root');
  }
  if (!fs.existsSync(dataRoot)) {
    throw new PersistError(`archive: 数据根不存在：${dataRoot}`, 'archive/missing-data-root');
  }

  const rooms = opts.rooms ?? (await loadRooms());
  const skipped = [];
  const warnings = [];

  // ---- 1. 语料清单（只读） ----
  const logs = listSessionLogs(dataRoot);
  const graphs = listGraphs(dataRoot);
  const graphBySession = new Map(graphs.map((g) => [g.sessionId, g]));

  const pairs = [];
  const seen = new Set();
  for (const log of logs) {
    if (sessionPrefix && !log.sessionId.includes(sessionPrefix)) continue;
    seen.add(log.sessionId);
    pairs.push({ sessionId: log.sessionId, logPath: log.path, graph: graphBySession.get(log.sessionId) ?? null });
  }
  for (const g of graphs) {
    if (seen.has(g.sessionId)) continue;
    if (sessionPrefix && !g.sessionId.includes(sessionPrefix)) continue;
    pairs.push({ sessionId: g.sessionId, logPath: null, graph: g });
  }
  pairs.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));

  // ---- 2. 逐局：读 → 棋谱 → 主题 → 信号（只读上游） ----
  const built = [];
  const readStats = { total: pairs.length, headers: 0, eventsParsed: 0, truncated: 0, badLines: 0, noLog: 0, unreadable: 0 };
  const graphStats = { total: graphs.length, loaded: 0, failed: 0, nodes: 0, edges: 0, deltaFrames: 0, truncated: 0 };

  for (const pair of pairs) {
    let header = null;
    let events = [];
    let truncated = false;
    if (pair.logPath) {
      try {
        const read = await readSession(pair.logPath);
        header = read.header;
        events = Array.isArray(read.events) ? read.events : [];
        truncated = Boolean(read.truncated);
        if (header) readStats.headers += 1;
        readStats.eventsParsed += events.length;
        if (truncated) readStats.truncated += 1;
        readStats.badLines += Number(read.badLines ?? 0);
      } catch (err) {
        readStats.unreadable += 1;
        warnings.push(`${pair.sessionId}: 日志读取失败 ${String(err?.message ?? err)}`);
      }
    } else {
      readStats.noLog += 1;
    }

    let graph = null;
    let deltaFrames = 0;
    if (pair.graph) {
      const mod = rooms.graphread;
      if (mod?.loadGraphAt) {
        try {
          const res = mod.loadGraphAt({ basePath: pair.graph.graphPath, deltaPath: pair.graph.deltaPath });
          if (res?.graph) {
            graph = res.graph;
            deltaFrames = Number(res.frames ?? 0);
            graphStats.loaded += 1;
            graphStats.nodes += Object.keys(graph.nodes ?? {}).length;
            graphStats.edges += Object.keys(graph.edges ?? {}).length;
            graphStats.deltaFrames += deltaFrames;
            if (res.truncated) graphStats.truncated += 1;
          } else {
            graphStats.failed += 1;
          }
        } catch (err) {
          graphStats.failed += 1;
          warnings.push(`${pair.sessionId}: 棋谱读取失败 ${String(err?.message ?? err)}`);
        }
      } else {
        graphStats.failed += 1;
        skipped.push('graph: R02 graphread 缺失（棋谱未读入，episode 只有日志一侧的闭包）');
      }
    }

    if (!header || typeof header.id !== 'string') {
      warnings.push(`${pair.sessionId}: 没有可用 header（无 id/无时间 ⇒ 不入馆：无源不入）`);
      continue;
    }

    let episode;
    try {
      if (rooms.episode?.buildEpisode) {
        episode = rooms.episode.buildEpisode({ header, events, graphPath: null, logPath: null, now });
      } else {
        throw new PersistError('R00 episode 缺失', 'archive/missing-room');
      }
    } catch (err) {
      warnings.push(`${pair.sessionId}: 棋谱构建失败 ${String(err?.message ?? err)}`);
      continue;
    }

    let signals = null;
    let failures = 0;
    let successes = 0;
    let unsettled = 0;
    let constraints = 0;
    let tools = [];
    if (rooms.extract?.extractSignals) {
      try {
        signals = rooms.extract.extractSignals({ graph, events });
        failures = signals.counts?.failures ?? 0;
        successes = signals.counts?.successes ?? 0;
        unsettled = signals.counts?.unsettled ?? 0;
        constraints = signals.counts?.constraints ?? 0;
        tools = toolNames(signals);
      } catch (err) {
        warnings.push(`${pair.sessionId}: 信号抽取失败 ${String(err?.message ?? err)}`);
      }
    } else {
      skipped.push('signals: R03 extract 缺失（signals 全 0）');
    }

    let topics = [];
    if (rooms.topic?.extractTopics) {
      const workspace = String(episode.scopeKey ?? '').replace(/^w:/, '');
      try {
        topics = rooms.topic.extractTopics({ episode: { ...episode, workspace }, events, graph, limits: opts.limits ?? {} });
      } catch (err) {
        warnings.push(`${pair.sessionId}: 主题抽取失败 ${String(err?.message ?? err)}`);
      }
    } else {
      skipped.push('topics: R04 topic 缺失（无主题）');
    }

    const nodeIds = graph ? Object.keys(graph.nodes ?? {}) : [];
    const edgeIds = graph ? Object.keys(graph.edges ?? {}) : [];
    const logRel = pair.logPath ? portableSourcePath(pair.logPath, dataRoot) : null;
    const graphRel = pair.graph ? portableSourcePath(pair.graph.graphPath, dataRoot) : null;
    if (pair.logPath && logRel === null) warnings.push(`${pair.sessionId}: 日志路径无法相对化（跨盘？）⇒ 不落路径，只留 hash`);
    if (pair.graph && graphRel === null) warnings.push(`${pair.sessionId}: 棋谱路径无法相对化（跨盘？）⇒ 不落路径`);

    const record = {
      ...episode,
      closure: {
        logPath: logRel,
        graphPath: graphRel,
        logSha256: null,
        seqFrom: episode.closure?.seqFrom ?? null,
        seqTo: episode.closure?.seqTo ?? null,
        eventCount: events.length,
        nodeIds,
        edgeIds,
        deltaFrames,
      },
      sourceRoot: 'DSH_HOME',
      sourceStatus: logRel === null || sourceStatusOf(logRel, dataRoot) === 'missing' ? 'missing' : 'present',
      topics: clipOccurrences(topics),
      signals: { failures, successes, unsettled, constraints, tools },
      signalsSource: 'R03 extract',
    };
    built.push({ record, signals, graph, sessionId: pair.sessionId, hadLog: Boolean(pair.logPath) });
  }

  // ---- 3. 子代理归并：depth>0 且父局在语料里 ⇒ folded-into:<父局 id> ----
  const idBySession = new Map(built.map((b) => [b.record.sessionId, b.record.id]));
  let folded = 0;
  for (const item of built) {
    const rec = item.record;
    if (includeSubagents) continue;
    const depth = Number.isFinite(rec.delegationDepth) ? rec.delegationDepth : 0;
    const parentId = typeof rec.parentSessionId === 'string' ? idBySession.get(rec.parentSessionId) : null;
    if (depth > 0 && parentId) {
      rec.state = `folded-into:${parentId}`;
      rec.foldedInto = parentId;
      rec.topics = [];
      folded += 1;
    } else if (depth > 0) {
      warnings.push(`${rec.sessionId}: 子代理会话但父局不在语料里 ⇒ 保留 archived（不丢数据）`);
    }
  }

  const episodes = built
    .map((b) => b.record)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const archived = episodes.filter((e) => (e.state ?? 'archived') === 'archived');

  // ---- 4. 定式 / claim（R08/R09；缺失或抛错 ⇒ 显式 skipped） ----
  const signalsByEpisode = new Map(built.map((b) => [b.record.id, b.signals]));
  const signalList = built.map((b) => ({ episode: b.record.id, sessionId: b.record.sessionId, signals: b.signals }));
  const archivedViews = archived.map((e) => ({ ...e }));

  let joseki = [];
  let josekiReference = [];
  if (typeof rooms.joseki?.promoteReferenceJoseki === 'function') {
    try {
      josekiReference = asRecordList(
        await rooms.joseki.promoteReferenceJoseki({ episodes: archivedViews, signals: Object.fromEntries(signalsByEpisode), now }),
        ['joseki', 'josekis'],
      );
    } catch (err) {
      skipped.push(`joseki-reference: 抛错（${String(err?.message ?? err)}）`);
      josekiReference = [];
    }
  }
  if (rooms.joseki?.promoteJoseki) {
    try {
      joseki = asRecordList(
        await rooms.joseki.promoteJoseki({ episodes: archivedViews, signals: signalsByEpisode, signalList, now }),
        ['joseki', 'josekis'],
      );
    } catch (err) {
      skipped.push(`joseki: R08 抛错（${String(err?.message ?? err)}）`);
      joseki = [];
    }
  } else {
    skipped.push('joseki: R08 joseki 缺失（未产出定式候选）');
  }

  let claims = [];
  if (rooms.claim?.promoteClaim) {
    try {
      claims = asRecordList(
        await rooms.claim.promoteClaim({ episodes: archivedViews, signals: signalsByEpisode, signalList, now }),
        ['claims'],
      );
    } catch (err) {
      skipped.push(`claims: R09 抛错（${String(err?.message ?? err)}）`);
      claims = [];
    }
  } else {
    skipped.push('claims: R09 claim 缺失（未产出 claim）');
  }

  // 入馆时核一次 validity，结果写进 claim（walk 据此跳过过期条目，AGENTS §2.3 时间戳纪律）。
  if (rooms.gates?.runValidityCheck && claims.length > 0) {
    try {
      const check = rooms.gates.runValidityCheck({ records: { claims }, workspace: opts.workspace ?? null, now });
      for (const claim of claims) {
        const res = check.results?.[`claims:${claim.id}`] ?? check.results?.[claim.id];
        if (res) {
          claim.validityOk = Boolean(res.ok);
          // N1：核验失败 ⇒ 记忆有效期止于本次核验（不改原文、不删条目）
          if (res.ok === false && !Number.isFinite(claim.validTo)) claim.validTo = now;
        }
      }
      if (check.summary.failed > 0) skipped.push(`validity: ${check.summary.failed} 条核验未通过（已标记 validityOk=false）`);
    } catch (err) {
      skipped.push(`validity: 核验失败（${String(err?.message ?? err)}）`);
    }
  }

  const authoritative = {
    episodes,
    joseki: [...joseki, ...josekiReference].filter((r) => r && typeof r.id === 'string'),
    claims: claims.filter((r) => r && typeof r.id === 'string'),
  };

  // 类级章节自愈（2026-11-02）：有 ≥2 局支撑、却缺类级 claim 的错误类，补一条（只增不改、幂等）。
  try {
    const healed = rooms.claim.ensureClassClaims({ claims: authoritative.claims });
    if (healed.added.length > 0) {
      authoritative.claims.push(...healed.added);
      skipped.push(`classMerge: 补 ${healed.added.length} 条类级章节`);
    }
  } catch (err) {
    skipped.push(`classMerge: 失败（${String(err?.message ?? err)}）`);
  }

  // N10（2026-11-02）：人纠错（L4）回填 —— 只加 counter + 标 disputed，不改原文。
  try {
    const adjudicationDir = path.join(storeRoot, 'adjudications');
    const adjudications = fs.existsSync(adjudicationDir)
      ? fs.readdirSync(adjudicationDir).filter((f) => f.endsWith('.json')).map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(adjudicationDir, f), 'utf8')); } catch { return null; }
      }).filter(Boolean)
      : [];
    if (adjudications.length > 0) {
      const applied = rooms.claim.applyAdjudications({ claims: authoritative.claims, adjudications, now });
      if (applied.applied.length > 0) skipped.push(`adjudications: ${applied.applied.length} 条 claim 收到人纠错（state=disputed）`);
    }
  } catch (err) {
    skipped.push(`adjudications: 回填失败（${String(err?.message ?? err)}）`);
  }

  // ---- 5. 派生（R04/R05/R07/R06 重算；与 rebuild 共用同一函数 ⇒ 产物一致） ----
  const derived = await deriveStore({ episodes, derive: opts.derive ?? null, at: now });
  for (const note of derived.skipped) skipped.push(note);

  const store = createStore({ root: storeRoot, user: opts.user ?? 'owner' });
  const summary = {
    dryRun,
    dataRoot,
    storeRoot,
    elapsedMs: 0,
    logs: {
      total: logs.length,
      sessions: pairs.length,
      headers: readStats.headers,
      events: readStats.eventsParsed,
      truncated: readStats.truncated,
      badLines: readStats.badLines,
      noLog: readStats.noLog,
      unreadable: readStats.unreadable,
    },
    graphs: graphStats,
    episodes: {
      total: episodes.length,
      archived: archived.length,
      folded,
      skipped: pairs.length - built.length,
    },
    derived: {
      topics: derived.topics.length,
      links: derived.links.length,
      threads: Array.isArray(derived.threads) ? derived.threads.length : null,
      mentions: derived.mentions.length,
      indexBytes: derived.stats?.indexBytes ?? 0,
    },
    joseki: authoritative.joseki.length,
    claims: authoritative.claims.length,
    skipped,
    warnings,
  };

  // ---- 6. dry-run：只做只读预估，不建目录、不写文件 ----
  if (dryRun) {
    const plan = {};
    for (const kind of AUTHORITATIVE_KINDS) {
      const records = kind === 'episodes' ? episodes : authoritative[kind];
      plan[kind] = plannedDiff(store, kind, stabilizeExisting(store, kind, records ?? []));
    }
    plan.topics = plannedDiff(store, 'topics', derived.topics);
    plan.links = plannedDiff(store, 'links', derived.links);
    plan.threads = plannedDiff(store, 'threads', Array.isArray(derived.threads) ? stabilizeExisting(store, 'threads', derived.threads) : []);
    // 来源状态巡检也要算进预估（原件搬走/搬回 ⇒ 一次变更）
    const staleSources = refreshSourceStatus(store, dataRoot, new Set(episodes.map((e) => e.id)));
    if (staleSources.length) {
      plan.episodes.changed += staleSources.length;
      plan.episodes.total += staleSources.length;
    }
    summary.plan = plan;
    summary.wouldWrite = Object.values(plan).reduce((n, p) => n + p.added + p.changed, 0);
    summary.elapsedMs = Date.now() - t0;
    return summary;
  }

  // ---- 7. 写库（权威 → 派生 → manifest） ----
  store.ensureDirs();
  store.cleanupTmp();
  const writes = {};
  for (const kind of AUTHORITATIVE_KINDS) {
    const records = kind === 'episodes' ? episodes : authoritative[kind];
    writes[kind] = store.putMany(kind, stabilizeExisting(store, kind, records ?? []), { at: now });
  }

  // 旧条目的来源状态（原件搬走/搬回 ⇒ sourceStatus 是事实变化，不是"新记忆"）
  const staleSources = refreshSourceStatus(store, dataRoot, new Set(episodes.map((e) => e.id)));
  if (staleSources.length) writes.sourceStatus = store.putMany('episodes', staleSources, { at: now });

  // 回读 episodes 再算派生：保证"入档产物 == rebuild 产物"（同一份数据、同一函数）
  const storedEpisodes = store
    .list('episodes')
    .filter((e) => e.record)
    .map((e) => e.record);
  const derivedFromStore = await deriveStore({ episodes: storedEpisodes, derive: opts.derive ?? null, at: now });
  writes.topics = store.replaceDerived('topics', derivedFromStore.topics, { at: now });
  writes.links = store.replaceDerived('links', derivedFromStore.links, { at: now });
  writes.threads = Array.isArray(derivedFromStore.threads)
    ? store.replaceDerived('threads', stabilizeExisting(store, 'threads', derivedFromStore.threads), { at: now })
    : { kind: 'threads', skipped: true, total: 0, written: 0, unchanged: 0, removed: [] };
  writes.index = typeof derivedFromStore.indexMd === 'string'
    ? store.writeIndex(derivedFromStore.indexMd, { at: now })
    : { changed: false, skipped: true };
  writes.manifest = store.writeManifest(now);

  const verify = store.verify();
  summary.writes = Object.fromEntries(
    Object.entries(writes).map(([kind, w]) => [kind, {
      total: w.total ?? 0,
      written: w.written ?? (w.changed ? 1 : 0),
      unchanged: w.unchanged ?? 0,
      removed: Array.isArray(w.removed) ? w.removed.length : 0,
      skipped: Boolean(w.skipped),
    }]),
  );
  summary.added = Object.values(summary.writes).reduce((n, w) => n + w.written, 0);
  summary.manifest = {
    changed: writes.manifest.changed,
    updatedAt: writes.manifest.manifest?.updatedAt ?? null,
    files: writes.manifest.manifest?.files ?? 0,
    bytes: writes.manifest.manifest?.bytes ?? 0,
    counts: writes.manifest.manifest?.counts ?? null,
    path: path.join(storeRoot, 'manifest.json'),
  };
  summary.verify = { ok: verify.ok, errors: verify.errors, warnings: verify.warnings.length, checked: verify.checked };
  summary.counts = verify.counts;
  summary.journal = store.readJournal().parsed;
  summary.elapsedMs = Date.now() - t0;
  return summary;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '?';
}

export function formatSummary(summary) {
  const out = [];
  out.push(`棋院 archive（${summary.dryRun ? 'dry-run：只统计不写盘' : '入档'}）`);
  out.push(`数据根（只读）：${summary.dataRoot}`);
  out.push(`记忆库：${summary.storeRoot}`);
  out.push('');
  out.push(`会话日志：${summary.logs.total} 个 · 参与入档 ${summary.logs.sessions} 局 · header ${summary.logs.headers} · 事件 ${summary.logs.events} 条 · 坏尾 ${summary.logs.truncated} · 坏行 ${summary.logs.badLines} · 无日志 ${summary.logs.noLog}`);
  out.push(`棋谱：${summary.graphs.total} 个 · 读入 ${summary.graphs.loaded} · 失败 ${summary.graphs.failed} · 节点 ${summary.graphs.nodes} · 边 ${summary.graphs.edges} · delta 帧 ${summary.graphs.deltaFrames}`);
  out.push(`棋谱（episodes）：${summary.episodes.total} 条 = 独立成谱 ${summary.episodes.archived} + 子代理归并 ${summary.episodes.folded} · 未入馆 ${summary.episodes.skipped}`);
  out.push(`派生：主题 ${summary.derived.topics} · 相关边 ${summary.derived.links} · 线索 ${summary.derived.threads ?? '—'} · mention ${summary.derived.mentions} · index.md ${summary.derived.indexBytes} B`);
  out.push(`权威：定式 ${summary.joseki} · claim ${summary.claims}`);
  if (summary.dryRun) {
    const p = summary.plan;
    const line = (k) => `${k} 新增 ${p[k].added} / 变更 ${p[k].changed} / 未变 ${p[k].unchanged}`;
    out.push('');
    out.push(`预估写入：${summary.wouldWrite} 条`);
    for (const kind of Object.keys(p)) out.push(`  - ${line(kind)}`);
  } else {
    const w = summary.writes;
    out.push('');
    out.push(`写入：新增/更新 ${summary.added} 条（${Object.entries(w).map(([k, v]) => `${k} ${v.written}/${v.total}${v.removed ? ` -${v.removed}` : ''}${v.skipped ? '（跳过）' : ''}`).join(' · ')}）`);
    out.push(`manifest：${summary.manifest.changed ? '已更新' : '无变更（未重写）'} · ${summary.manifest.files} 个文件 · ${(summary.manifest.bytes / 1048576).toFixed(2)} MiB · updatedAt ${iso(summary.manifest.updatedAt)}`);
    out.push(`journal：${summary.journal} 条`);
    out.push(`verify：${summary.verify.ok ? 'OK' : '失败'} · 校验 ${summary.verify.checked.files} 文件 / ${(summary.verify.checked.bytes / 1048576).toFixed(2)} MiB · 告警 ${summary.verify.warnings}`);
    for (const err of summary.verify.errors.slice(0, 8)) out.push(`  ! [${err.code}] ${err.path ?? ''} ${err.message ?? ''}`);
  }
  if (summary.skipped.length) {
    out.push('');
    out.push('显式跳过（缺失房间 / 降级）：');
    for (const s of [...new Set(summary.skipped)]) out.push(`  - ${s}`);
  }
  if (summary.warnings.length) {
    out.push('');
    out.push(`告警 ${summary.warnings.length} 条（前 10）：`);
    for (const w of summary.warnings.slice(0, 10)) out.push(`  - ${w}`);
  }
  out.push('');
  out.push(`耗时 ${summary.elapsedMs} ms`);
  return out.join('\n');
}

export async function runCli(argv = []) {
  const { flags } = parseArgs(argv);
  if (flags.help) return { code: 0, stdout: USAGE, stderr: '' };
  const dataRoot = path.resolve(flags.root ?? process.env.DSH_HOME ?? '');
  if (!dataRoot) return { code: 2, stdout: '', stderr: `需要 --root <dataRoot> 或 $DSH_HOME\n\n${USAGE}` };
  try {
    const summary = await runArchive({
      dataRoot,
      storeRoot: flags.store ? path.resolve(flags.store) : path.join(dataRoot, 'memory-context'),
      dryRun: Boolean(flags.dryRun),
      includeSubagents: Boolean(flags.includeSubagents),
      sessionPrefix: flags.session ?? null,
    });
    const stdout = flags.json ? JSON.stringify(summary, null, 2) : formatSummary(summary);
    if (!summary.dryRun && !summary.verify.ok) return { code: 1, stdout, stderr: 'archive: 入库后 verify 失败（见输出）' };
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const code = err instanceof PersistError ? 1 : 1;
    return { code, stdout: '', stderr: `archive 失败：${String(err?.stack ?? err)}` };
  }
}

export async function main(argv = [], io = {}) {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  const res = await runCli(argv);
  if (res.stdout) out.write(res.stdout.endsWith('\n') ? res.stdout : `${res.stdout}\n`);
  if (res.stderr) err.write(res.stderr.endsWith('\n') ? res.stderr : `${res.stderr}\n`);
  return res.code;
}

export default { runArchive, runCli, main, parseArgs, formatSummary };

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}

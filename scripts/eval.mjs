#!/usr/bin/env node
// M5 机械评测（零模型调用）：LOO（留一局）`repeatFailureRate` —— "不重复踩坑"的机械代理指标
//
// ── 契约（方案 §2.2 V1 / §8.2、docs/对标-Hindsight.md §2 A2、AGENTS §2.4 工程纪律）──
// 职责：只读 store（`episodes/`）+ 只读原件（会话日志/棋谱），机械算出"新一局里有多少失败是馆里
//       早就结算过的坑"。**零模型调用、零写入**（唯一写入口是显式 `--evidence <path>`）。
// 入口：`runEval({dataRoot, storeRoot, source}) -> report`；纯函数 `evaluateLoo(records)` 可单独测。
//
// 口径（分子/分母/时点，写死在 §定义里，见下）：
//   signature(E) = { normalizeErrorSignature(失败原文) }  —— 去路径/行号/时间戳/十六进制
//   memory(E)    = ∪ signature(F)，其中 F 是**其它 root 局**且 `F.startedAt < E.startedAt`
//                  （严格更早 ⇒ 不用"未来信息"；同一时刻的不同局互不可见）
//   repeat(E)    = |{s ∈ signature(E) : s ∈ memory(E)}|
//   novel(E)     = |signature(E)| − repeat(E)
//   repeatFailureRate = Σrepeat ÷ (Σrepeat + Σnovel)      ← 分母为 0 时返回 null（不是 0，不编造）
//   无记忆基线       = 0（定义如此：没有 memory 时每条签名都是 novel）
// 失败来源（三种，报告里全列，默认 both）：
//   edge  —— R03 `extractSignals({graph})` 的 failures（`edge.result==='failure'`，带 errorSnippet）：
//            **这是方案 §8.2 定义的原始口径**；真实语料只有 7/24 局有棋谱。
//   event —— 事件侧兜底：`tool/result` 文本**以 `[exit code: N]`（N≠0）结尾**（DSH 自己的标记），
//            取错误行做签名；用于没有棋谱的局（否则 17 局无法评测）。
//   both  —— 默认：每局**优先 edge**；该局没有失败边时回退 event（不重复计入）。
// 只读纪律：store 与原件都不写；`--evidence` 是唯一写入口。
// 允许依赖：R00/R01/R02/R03/R15（读 store 只走 `createStore().list('episodes')`）。零第三方依赖。
//
// 用法：
//   node scripts/eval.mjs [--root <dataRoot>] [--store <memoryRoot>] [--source both|edge|event]
//                         [--json] [--evidence evidence/M5-eval.md]
//   node scripts/eval.mjs --root "$DSH_HOME" --store tmp/memory-context --evidence evidence/M5-eval.md

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const EVAL_VERSION = 1;

/** DSH 的退出码标记：工具结果文本以它结尾（`[exit code: 0]` 表示成功）。 */
export const EXIT_CODE_RE = /(?:^|\n)\s*\[exit code:\s*(\d+)\]\s*$/;

/** 失败来源的允许取值。 */
export const SOURCE_MODES = Object.freeze(['both', 'edge', 'event']);

/** 退化签名（信息量为 0 的"失败原文"，算进去只会让 repeat 虚高）。 */
const DEGENERATE_SIGNATURES = Object.freeze(new Set([
  '',
  '(no output)',
  'no output',
  '[exit code: 1]',
  'traceback (most recent call last):',
  'command failed',
  'failed',
  'error',
  'exit code <n>',
  '<path>',
  'at <path>:<line>',
]));

/** 错误行识别（大小写不敏感）：事件侧兜底时用来挑"最像错误"的那一行。 */
const ERROR_LINE_RE = /(error|错误|失败|failed|failure|cannot|can't|not found|no such|denied|refused|invalid|unexpected|exception|traceback|timeout|timed out|already exists|missing)/i;

/** 规范化上限（签名太长既难比对也不好读）。 */
const MAX_SIGNATURE_CHARS = 240;

// ---------------------------------------------------------------------------
// 规范化（签名）
// ---------------------------------------------------------------------------

/**
 * 失败原文 → 稳定签名：去绝对路径 / 行号列号 / 时间戳 / 十六进制 / 引号差异，压空白、转小写。
 * 纯字符串函数（零 IO），同输入同输出。
 * @param {string} text
 * @returns {string}
 */
export function normalizeErrorSignature(text) {
  let s = String(text ?? '');
  s = s.replace(/\r\n?/g, '\n');

  // 1) 绝对路径（Windows `C:\a\b` / `C:/a/b`；UNC `\\host\share`；POSIX `/a/b`）
  s = s.replace(/\b[A-Za-z]:[\\/][^\s"'`,;:)\]}]*/g, '<path>');
  s = s.replace(/\\\\[^\s"'`,;:)\]}]+/g, '<path>');
  s = s.replace(/(^|[\s"'(=])\/(?:[^\s"'`,;:)\]}]*\/)+[^\s"'`,;:)\]}]*/g, (m, lead) => `${lead}<path>`);

  // 2) 时间戳（ISO 日期时间、epoch 秒/毫秒、时钟时间）—— 必须早于"行号"规则，
  //    否则 `03:10:00` 里的 `:10` 会先被当成行号吃掉
  s = s.replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, '<ts>');
  s = s.replace(/\b\d{10,13}\b/g, '<ts>');
  s = s.replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<ts>');

  // 3) 行号/列号（`file.mjs:12:5`、`line 42`、`#42`）
  s = s.replace(/(?<=<path>)(?::\d+){1,2}\b/g, ':<line>');
  s = s.replace(/(:\d+){1,2}(?=[\s:)\],]|$)/g, ':<line>');
  s = s.replace(/\bline\s+\d+\b/gi, 'line <line>');
  s = s.replace(/#\d+\b/g, '#<n>');

  // 4) 十六进制（0x… / 长 hash）。先抹"含数字"的 8+ 位，再抹"纯 a-f 字母"的 12+ 位
  //    （纯字母的 8 位可能是英文单词，12 位几乎只能是 hash，如 `deadbeefcafe`）
  s = s.replace(/\b0x[0-9a-fA-F]+\b/g, '<hex>');
  s = s.replace(/\b(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{8,}\b/g, '<hex>');
  s = s.replace(/\b[0-9a-fA-F]{12,}\b/g, '<hex>');

  // 5) 退出码标记本身不是"错误内容"（事件侧的失败已由 tool/result + 退出码承载）
  s = s.replace(/\[?\s*exit code:\s*\d+\s*\]?/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.toLowerCase();
  if (s.length > MAX_SIGNATURE_CHARS) s = s.slice(0, MAX_SIGNATURE_CHARS);
  return s;
}

/** 退化签名判定（信息量为 0 ⇒ 不参与 repeat/novel，只计数）。 */
export function isDegenerateSignature(signature) {
  const s = String(signature ?? '').trim();
  if (s === '') return true;
  if (DEGENERATE_SIGNATURES.has(s)) return true;
  const meaningful = s.replace(/<path>|<line>|<ts>|<hex>|<n>/g, '').replace(/[^0-9a-z\u4e00-\u9fff]+/g, '');
  return meaningful.length < 6;
}

/**
 * 从工具结果正文里挑"最像错误"的一行（事件侧兜底用）。
 * 规则（机械）：先找第一个匹配错误词的行；没有就用最后一行非空行。
 * @param {string} body
 * @returns {string}
 */
export function pickErrorLine(body) {
  const lines = String(body ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return '';
  for (const line of lines) {
    if (ERROR_LINE_RE.test(line)) return line;
  }
  return lines[lines.length - 1];
}

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

async function loadOptional(url) {
  try {
    return await import(url);
  } catch {
    return null;
  }
}

async function loadRooms() {
  const [logread, graphread, extract] = await Promise.all([
    loadOptional(new URL('../src/rooms/logread.mjs', import.meta.url)),
    loadOptional(new URL('../src/rooms/graphread.mjs', import.meta.url)),
    loadOptional(new URL('../src/rooms/extract.mjs', import.meta.url)),
  ]);
  return { logread, graphread, extract };
}

// ---------------------------------------------------------------------------
// 失败信号（两种来源）
// ---------------------------------------------------------------------------

/** R03 的 failures → 签名条目。 */
export function edgeFailureSignals(failures) {
  return (Array.isArray(failures) ? failures : [])
    .filter((f) => f && typeof f.quote === 'string' && f.quote.trim() !== '')
    .map((f) => ({
      signature: normalizeErrorSignature(f.quote),
      quote: String(f.quote).slice(0, 200),
      seq: Number.isFinite(f.seq) ? f.seq : null,
      occurredAt: Number.isFinite(f.occurredAt) ? f.occurredAt : null,
      edgeId: f.edgeId ?? null,
      nodeId: f.nodeId ?? null,
      source: 'edge',
    }));
}

/**
 * 事件侧兜底：`tool/result` 文本以 `[exit code: N]`（N≠0）结尾 ⇒ 一次失败。
 * 只认 DSH 自己的退出码标记（不看"像不像错误"，避免模型式判断）。
 * @param {object[]} events
 * @param {{messageText?:(v:any)=>string}} [helpers] 可注入 R03 的 messageText（缺失时用内置）
 */
export function eventFailureSignals(events, helpers = {}) {
  const messageText = typeof helpers.messageText === 'function'
    ? helpers.messageText
    : (value) => {
      const message = value?.message ?? value;
      const content = message?.content;
      if (Array.isArray(content)) return content.map((part) => part?.text ?? '').join(' ');
      return String(content ?? message?.text ?? '');
    };
  const out = [];
  let droppedNoExit = 0;
  let droppedDegenerate = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.type !== 'tool/result') continue;
    const text = messageText(event.data?.message ?? event.data);
    if (!text) continue;
    const match = EXIT_CODE_RE.exec(text);
    if (!match) {
      droppedNoExit += 1;
      continue;
    }
    if (match[1] === '0') continue; // 成功
    const body = text.slice(0, match.index).trim();
    const line = pickErrorLine(body);
    const signature = normalizeErrorSignature(line);
    if (isDegenerateSignature(signature)) {
      droppedDegenerate += 1;
      continue;
    }
    out.push({
      signature,
      quote: line.slice(0, 200),
      seq: Number.isFinite(event.seq) ? event.seq : null,
      occurredAt: Number.isFinite(event.time) ? event.time : null,
      edgeId: null,
      nodeId: null,
      source: 'event',
    });
  }
  if (out.length === 0) {
    return { signals: out, dropped: { noExitCode: droppedNoExit, degenerate: droppedDegenerate } };
  }
  return { signals: out, dropped: { noExitCode: droppedNoExit, degenerate: droppedDegenerate } };
}

/** 同签名去重（保留第一条样本 + 次数），签名排序保证可复算。 */
export function dedupeBySignature(entries) {
  const map = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.signature !== 'string' || isDegenerateSignature(entry.signature)) continue;
    const hit = map.get(entry.signature);
    if (hit) {
      hit.count += 1;
      if (hit.samples.length < 3) hit.samples.push(entry);
    } else {
      map.set(entry.signature, { signature: entry.signature, count: 1, samples: [entry] });
    }
  }
  return [...map.values()].sort((a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0));
}

// ---------------------------------------------------------------------------
// LOO 主算（纯函数：可脱离文件系统单测）
// ---------------------------------------------------------------------------

/**
 * 留一局：memory 只用**严格更早**的局（`startedAt` 更小）。
 * @param {Array<{id:string, startedAt:number, scopeKey?:string, signatures:string[]}>} records
 * @param {{sourceLabel?:string}} [opts]
 * @returns {{rows:Array, totals:object, byScope:Array, topSignatures:Array, coverage:object}}
 */
export function evaluateLoo(records, opts = {}) {
  const list = (Array.isArray(records) ? records : [])
    .filter((r) => r && typeof r.id === 'string' && Number.isFinite(r.startedAt))
    .map((r) => ({
      id: r.id,
      startedAt: r.startedAt,
      scopeKey: typeof r.scopeKey === 'string' && r.scopeKey ? r.scopeKey : 'w:<unknown>',
      signatures: [...new Set((Array.isArray(r.signatures) ? r.signatures : []).filter((s) => typeof s === 'string' && s !== ''))].sort(),
      failureSource: r.failureSource ?? null,
    }))
    .sort((a, b) => (a.startedAt - b.startedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const memory = new Set();
  const rows = [];
  const seenIn = new Map(); // signature → 出现过的局（坑榜）
  let repeatTotal = 0;
  let novelTotal = 0;

  // 同一 startedAt 的局归一组：先用**组外**（严格更早）的 memory 判定，再把整组并入 memory
  // —— 保证"同一时刻互不可见"，也保证结果不依赖同刻局之间的排序。
  const groups = [];
  for (const record of list) {
    const last = groups[groups.length - 1];
    if (last && last.startedAt === record.startedAt) last.records.push(record);
    else groups.push({ startedAt: record.startedAt, records: [record] });
  }

  let index = 0;
  for (const group of groups) {
    const memorySize = memory.size;
    const rowsInGroup = group.records.map((record) => {
      index += 1;
      const repeatSignatures = record.signatures.filter((s) => memory.has(s));
      const novelSignatures = record.signatures.filter((s) => !memory.has(s));
      const denominator = record.signatures.length;
      return {
        n: index,
        episode: record.id,
        startedAt: record.startedAt,
        date: isoDate(record.startedAt),
        scopeKey: record.scopeKey,
        failureSource: record.failureSource,
        signatures: denominator,
        repeat: repeatSignatures.length,
        novel: novelSignatures.length,
        rate: denominator === 0 ? null : repeatSignatures.length / denominator,
        memorySize,
        repeatSignatures,
        novelSignatures,
      };
    });
    for (const row of rowsInGroup) {
      rows.push(row);
      repeatTotal += row.repeat;
      novelTotal += row.novel;
    }
    for (const record of group.records) {
      for (const signature of record.signatures) {
        if (!seenIn.has(signature)) seenIn.set(signature, []);
        seenIn.get(signature).push(record.id);
        memory.add(signature);
      }
    }
  }

  const total = repeatTotal + novelTotal;
  const byScope = [];
  const scopeMap = new Map();
  for (const row of rows) {
    if (!scopeMap.has(row.scopeKey)) scopeMap.set(row.scopeKey, { scopeKey: row.scopeKey, episodes: 0, evaluated: 0, repeat: 0, novel: 0, signatures: 0 });
    const bucket = scopeMap.get(row.scopeKey);
    bucket.episodes += 1;
    if (row.signatures > 0) bucket.evaluated += 1;
    bucket.repeat += row.repeat;
    bucket.novel += row.novel;
    bucket.signatures += row.signatures;
  }
  for (const bucket of scopeMap.values()) {
    const denom = bucket.repeat + bucket.novel;
    bucket.rate = denom === 0 ? null : bucket.repeat / denom;
    byScope.push(bucket);
  }
  byScope.sort((a, b) => (b.repeat + b.novel) - (a.repeat + a.novel) || (a.scopeKey < b.scopeKey ? -1 : 1));

  const topSignatures = [...seenIn.entries()]
    .map(([signature, episodes]) => ({ signature, episodes: episodes.length, episodeIds: [...episodes].sort() }))
    .filter((x) => x.episodes >= 2)
    .sort((a, b) => (b.episodes - a.episodes) || (a.signature < b.signature ? -1 : 1));

  const evaluated = rows.filter((r) => r.signatures > 0).length;
  return {
    source: opts.sourceLabel ?? null,
    rows,
    totals: {
      episodes: rows.length,
      evaluated,
      signatures: total,
      repeat: repeatTotal,
      novel: novelTotal,
      rate: total === 0 ? null : repeatTotal / total,
      distinctSignatures: memory.size,
      episodesWithRepeat: rows.filter((r) => r.repeat > 0).length,
    },
    coverage: {
      rootEpisodes: rows.length,
      evaluated,
      ratio: rows.length === 0 ? null : evaluated / rows.length,
    },
    byScope,
    topSignatures,
  };
}

function isoDate(ms) {
  if (!Number.isFinite(ms)) return '????-??-??';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function isoTime(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// ---------------------------------------------------------------------------
// 读 store + 原件（只读）
// ---------------------------------------------------------------------------

/**
 * 读一局的失败签名（边优先、事件兜底）。
 * @returns {{edge:object[], event:object[], dropped:object, sourceStatus:string, reasons:string[]}}
 */
export function extractEpisodeFailures({ episode, events, graph, rooms, source = 'both' }) {
  const reasons = [];
  let graphFailures = [];
  if (graph && rooms?.extract?.extractSignals) {
    try {
      const signals = rooms.extract.extractSignals({ graph, events: events ?? [] });
      graphFailures = signals?.failures ?? [];
    } catch (err) {
      reasons.push(`R03 抛错：${String(err?.message ?? err)}`);
    }
  } else if (!graph) {
    reasons.push('no-graph');
  } else {
    reasons.push('no-R03');
  }

  const edge = edgeFailureSignals(graphFailures);
  const eventResult = eventFailureSignals(events ?? [], { messageText: rooms?.extract?.messageText });
  const event = eventResult.signals;

  let chosen;
  if (source === 'edge') chosen = edge;
  else if (source === 'event') chosen = event;
  else chosen = edge.length > 0 ? edge : event;

  const failureSource = source === 'both'
    ? (chosen === edge && edge.length > 0 ? 'edge' : (event.length > 0 ? 'event' : 'none'))
    : source;

  return {
    edge,
    event,
    chosen,
    failureSource,
    dropped: eventResult.dropped,
    reasons,
    sourceStatus: episode?.sourceStatus ?? null,
  };
}

function resolveSourcePath(relPath, dataRoot) {
  if (typeof relPath !== 'string' || relPath === '') return null;
  if (relPath.includes('\\') || /^[A-Za-z]:/.test(relPath) || relPath.startsWith('/')) return null;
  const segments = relPath.split('/');
  if (segments.some((s) => s === '..')) return null;
  const abs = path.resolve(dataRoot, relPath);
  const back = path.relative(path.resolve(dataRoot), abs);
  if (back === '' || back.startsWith('..') || path.isAbsolute(back)) return null;
  return abs;
}

/**
 * 跑一次评测。
 * @param {{dataRoot:string, storeRoot:string, source?:'both'|'edge'|'event', now?:number}} opts
 * @returns {Promise<object>} report
 */
export async function runEval(opts = {}) {
  const started = Date.now();
  const dataRoot = path.resolve(opts.dataRoot ?? process.env.DSH_HOME ?? '');
  const storeRoot = path.resolve(opts.storeRoot ?? path.join(dataRoot, 'memory-context'));
  const source = SOURCE_MODES.includes(opts.source) ? opts.source : 'both';
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  if (!dataRoot || !fs.existsSync(dataRoot)) {
    throw new Error(`eval: 数据根不存在：${dataRoot || '(空)'}（用 --root 或 $DSH_HOME）`);
  }

  const rooms = opts.rooms ?? (await loadRooms());
  const storeDir = path.join(storeRoot, 'episodes');
  const hasStore = fs.existsSync(path.join(storeRoot, 'manifest.json')) || fs.existsSync(storeDir);

  // 只读 store：直接读 episodes/ 的 JSON（不经 createStore 的写路径；缺失即空集）
  const episodes = [];
  for (const name of readDirSafe(storeDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(storeDir, name), 'utf8'));
      if (record && typeof record.id === 'string') episodes.push(record);
    } catch {
      /* 坏条目跳过（评测不该因为一条坏文件整片失败） */
    }
  }
  const rootEpisodes = episodes
    .filter((e) => (e.state ?? 'archived') === 'archived' && Number.isFinite(e.startedAt))
    .sort((a, b) => (a.startedAt - b.startedAt) || (a.id < b.id ? -1 : 1));

  const skipped = [];
  const records = { both: [], edge: [], event: [] };
  const perEpisode = [];

  for (const episode of rootEpisodes) {
    const logAbs = resolveSourcePath(episode.closure?.logPath, dataRoot);
    const graphAbs = resolveSourcePath(episode.closure?.graphPath, dataRoot);

    let events = [];
    let graph = null;
    const reasons = [];
    if (logAbs && rooms.logread?.readFrames && rooms.logread?.parseEvents) {
      try {
        const framesRes = rooms.logread.readFrames(fs.readFileSync(logAbs));
        const frames = Array.isArray(framesRes) ? framesRes : (framesRes?.frames ?? []);
        const parsed = rooms.logread.parseEvents(frames);
        events = parsed?.events ?? [];
      } catch (err) {
        reasons.push(`logread 失败：${String(err?.message ?? err)}`);
      }
    } else if (!logAbs) {
      reasons.push('no-log-path');
    } else {
      reasons.push('no-R01');
    }

    if (graphAbs && rooms.graphread?.loadGraphAt) {
      try {
        const res = rooms.graphread.loadGraphAt({ basePath: graphAbs, deltaPath: `${graphAbs}.delta.jsonl` });
        if (res?.graph) graph = res.graph;
        else reasons.push(`graphread: ${res?.reason ?? res?.error ?? 'unreadable'}`);
      } catch (err) {
        reasons.push(`graphread 失败：${String(err?.message ?? err)}`);
      }
    } else if (!graphAbs) {
      reasons.push('no-graph-path');
    } else {
      reasons.push('no-R02');
    }

    const failureData = extractEpisodeFailures({ episode, events, graph, rooms, source });
    const merged = [...failureData.edge, ...failureData.event];
    const deduped = dedupeBySignature(failureData.chosen);

    records.edge.push({ id: episode.id, startedAt: episode.startedAt, scopeKey: episode.scopeKey, signatures: dedupeBySignature(failureData.edge).map((x) => x.signature), failureSource: 'edge' });
    records.event.push({ id: episode.id, startedAt: episode.startedAt, scopeKey: episode.scopeKey, signatures: dedupeBySignature(failureData.event).map((x) => x.signature), failureSource: 'event' });
    records.both.push({ id: episode.id, startedAt: episode.startedAt, scopeKey: episode.scopeKey, signatures: deduped.map((x) => x.signature), failureSource: failureData.failureSource });

    perEpisode.push({
      episode: episode.id,
      sessionId: episode.sessionId ?? null,
      startedAt: episode.startedAt,
      endedAt: episode.endedAt ?? null,
      date: isoDate(episode.startedAt),
      scopeKey: episode.scopeKey ?? 'w:<unknown>',
      sourceStatus: episode.sourceStatus ?? null,
      logPresent: Boolean(logAbs),
      graphPresent: Boolean(graphAbs),
      eventCount: events.length,
      edgeFailures: failureData.edge.length,
      eventFailures: failureData.event.length,
      signatures: deduped.length,
      failureSource: failureData.failureSource,
      dropped: failureData.dropped,
      reasons: [...new Set([...reasons, ...failureData.reasons])].filter((r) => r !== 'no-graph' || !graph),
    });

    if (!logAbs && !graphAbs) skipped.push({ episode: episode.id, reason: 'source-missing（日志与棋谱都不在）' });
  }

  const variants = {
    both: evaluateLoo(records.both, { sourceLabel: 'both' }),
    edge: evaluateLoo(records.edge, { sourceLabel: 'edge' }),
    event: evaluateLoo(records.event, { sourceLabel: 'event' }),
  };
  const primary = variants[source];

  const report = {
    version: EVAL_VERSION,
    generatedAt: now,
    generatedAtIso: isoTime(now),
    dataRoot,
    storeRoot,
    storeFound: hasStore,
    source,
    definition: {
      signature: '规范化失败原文（去绝对路径/行号列号/时间戳/十六进制；压空白；小写）',
      memory: '其它 root 局中 startedAt 严格更早者（不用未来信息；同一时刻互不可见）',
      repeat: 'E 的签名 ∈ memory 的条数（按"每局每签名一次"计）',
      novel: 'E 的签名 ∉ memory 的条数',
      repeatFailureRate: 'Σrepeat ÷ (Σrepeat + Σnovel)；分母 0 ⇒ null',
      noMemoryBaseline: 0,
      coverage: '有 ≥1 条失败签名的 root 局数 ÷ 全部 root 局数',
      episodeClock: 'startedAt（会话 header.createdAt，epoch ms）',
      sourceMode: { both: '逐局优先 edge，无失败边则用 event', edge: '只用 R03 边失败', event: '只用事件侧 [exit code≠0]' },
    },
    corpus: {
      rootEpisodes: rootEpisodes.length,
      episodeRecords: episodes.length,
      skipped,
      variants: Object.fromEntries(Object.entries(variants).map(([key, v]) => [key, {
        episodes: v.totals.episodes,
        evaluated: v.totals.evaluated,
        signatures: v.totals.signatures,
        repeat: v.totals.repeat,
        novel: v.totals.novel,
        rate: v.totals.rate,
        coverage: v.coverage.ratio,
      }])),
    },
    primary: {
      source,
      totals: primary.totals,
      coverage: primary.coverage,
      rows: primary.rows,
      byScope: primary.byScope,
      topSignatures: primary.topSignatures.slice(0, 20),
    },
    perEpisode,
    elapsedMs: Date.now() - started,
  };
  return report;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function pct(x) {
  return x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}

export function formatReport(report) {
  const out = [];
  const p = report.primary;
  out.push('棋院 eval · LOO repeatFailureRate（零模型调用）');
  out.push(`数据根（只读）：${report.dataRoot}`);
  out.push(`记忆库（只读）：${report.storeRoot}${report.storeFound ? '' : '（未找到 manifest：按空库评测）'}`);
  out.push(`失败来源：${p.source}（both = 逐局优先 R03 边失败，无失败边才用事件侧 [exit code≠0]）`);
  out.push('');
  out.push(`口径：签名 = 规范化失败原文；memory(E) = 其它局中 startedAt **严格更早**者；` +
    `rate = repeat ÷ (repeat+novel)；无记忆基线 = 0`);
  out.push('');
  out.push(`语料：root 局 ${report.corpus.rootEpisodes} · 有失败签名 ${p.coverage.evaluated}（coverage ${pct(p.coverage.ratio)}）· ` +
    `签名总数 ${p.totals.signatures} · 去重后 ${p.totals.distinctSignatures}`);
  out.push(`总账：repeat ${p.totals.repeat} / novel ${p.totals.novel} ⇒ **repeatFailureRate ${pct(p.totals.rate)}**（无记忆基线 0）；` +
    `出现重复的局 ${p.totals.episodesWithRepeat}/${p.coverage.evaluated}`);
  out.push('');
  out.push('三口径对照（同一批局，来源不同）：');
  for (const [key, v] of Object.entries(report.corpus.variants)) {
    out.push(`  - ${key.padEnd(5)} 局 ${String(v.episodes).padStart(2)} · 有签名 ${String(v.evaluated).padStart(2)}（coverage ${pct(v.coverage)}）· ` +
      `repeat ${v.repeat} / novel ${v.novel} ⇒ ${pct(v.rate)}`);
  }
  out.push('');
  out.push('按 scope 分层：');
  for (const s of p.byScope) {
    out.push(`  - ${s.scopeKey} · 局 ${s.episodes}（有签名 ${s.evaluated}）· repeat ${s.repeat} / novel ${s.novel} ⇒ ${pct(s.rate)}`);
  }
  out.push('');
  out.push('逐局（按 startedAt 升序；memorySize = 该局开始时 memory 里的签名数）：');
  out.push('   #  日期        episode        来源    局内签名  repeat  novel  逐局率  memorySize');
  for (const r of p.rows) {
    out.push(`  ${String(r.n).padStart(2)}  ${r.date}  ${r.episode.padEnd(14)} ${String(r.failureSource ?? '-').padEnd(6)} ` +
      `${String(r.signatures).padStart(6)}  ${String(r.repeat).padStart(6)}  ${String(r.novel).padStart(5)}  ` +
      `${pct(r.rate).padStart(6)}  ${String(r.memorySize).padStart(9)}`);
  }
  if (p.topSignatures.length) {
    out.push('');
    out.push(`坑榜（同一签名出现在 ≥2 局；共 ${p.topSignatures.length} 条，前 10）：`);
    for (const t of p.topSignatures.slice(0, 10)) {
      out.push(`  - ${String(t.episodes).padStart(2)} 局  ${t.signature.slice(0, 110)}`);
    }
  }
  out.push('');
  out.push(`耗时 ${report.elapsedMs} ms · 写入 0（只读；唯一写入口是 --evidence）`);
  return out.join('\n');
}

/** 生成 evidence/M5-eval.md（公式 + 分子分母 + 时点 + 逐局表 + 复现命令）。 */
export function renderEvidenceMarkdown(report) {
  const p = report.primary;
  const lines = [];
  lines.push('# M5 机械评测：LOO repeatFailureRate（2026-11-02）');
  lines.push('');
  lines.push(`> 生成：\`node scripts/eval.mjs --root $DSH_HOME --store tmp/memory-context --evidence evidence/M5-eval.md\``);
  lines.push(`> 运行时刻：${report.generatedAtIso ?? 'n/a'}（UTC；epoch ms ${report.generatedAt}）· 零模型调用 · 只读 · 耗时 ${report.elapsedMs} ms`);
  lines.push('');
  lines.push('## 1 · 口径（分子 / 分母 / 时点 / 树）');
  lines.push('');
  lines.push('| 项 | 定义 |');
  lines.push('|---|---|');
  lines.push(`| 失败签名 | ${report.definition.signature} |`);
  lines.push(`| memory(E) | ${report.definition.memory} |`);
  lines.push(`| repeat(E) | ${report.definition.repeat} |`);
  lines.push(`| novel(E) | ${report.definition.novel} |`);
  lines.push(`| **repeatFailureRate** | **${report.definition.repeatFailureRate}** |`);
  lines.push(`| 无记忆基线 | ${report.definition.noMemoryBaseline}（没有 memory 时每条签名都是 novel） |`);
  lines.push(`| coverage | ${report.definition.coverage} |`);
  lines.push(`| 时点 | ${report.definition.episodeClock} |`);
  lines.push('');
  lines.push('**分子** = Σrepeat（逐局把"签名已在更早的局里出现过"的条数相加，同一局同一签名只算一次）。');
  lines.push('**分母** = Σrepeat + Σnovel = 有失败签名的局里"每局去重后签名"的总条数。分母为 0 时输出 `null`，不写 0。');
  lines.push('**树 / 语料**：工作树 `tmp/memory-context`（入档产物）+ 只读原件 `$DSH_HOME/sessions`、`$DSH_HOME/chess-context`。');
  lines.push('');
  lines.push('## 2 · 三口径对照（同一批 root 局，失败来源不同）');
  lines.push('');
  lines.push('| 口径 | root 局 | 有签名 | coverage | repeat | novel | repeatFailureRate |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const [key, v] of Object.entries(report.corpus.variants)) {
    lines.push(`| \`${key}\` | ${v.episodes} | ${v.evaluated} | ${pct(v.coverage)} | ${v.repeat} | ${v.novel} | **${pct(v.rate)}** |`);
  }
  lines.push('');
  lines.push(`- \`edge\` = R03 \`extractSignals\` 的失败边（方案 §8.2 的原始口径）；真实语料只有部分局有棋谱 ⇒ coverage 低。`);
  lines.push(`- \`event\` = 事件侧兜底（\`tool/result\` 以 \`[exit code: N≠0]\` 结尾，DSH 自己的标记）；覆盖没有棋谱的局。`);
  lines.push(`- \`both\`（本文件主口径）= 逐局**优先 edge**，该局没有失败边时回退 event（不重复计入）。`);
  lines.push('');
  lines.push(`## 3 · 主口径结果（\`${p.source}\`）`);
  lines.push('');
  lines.push(`- root 局 **${report.corpus.rootEpisodes}** · 有失败签名 **${p.coverage.evaluated}**（coverage **${pct(p.coverage.ratio)}**）`);
  lines.push(`- 签名总数 **${p.totals.signatures}** · 去重后 **${p.totals.distinctSignatures}** · 出现重复的局 **${p.totals.episodesWithRepeat}**`);
  lines.push(`- **repeat ${p.totals.repeat} / novel ${p.totals.novel} ⇒ repeatFailureRate = ${pct(p.totals.rate)}**（无记忆基线 0）`);
  lines.push('');
  lines.push('### 3.1 逐局表');
  lines.push('');
  lines.push('| # | 日期(UTC) | episode | 失败来源 | 局内签名 | repeat | novel | 逐局率 | memorySize | scope |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of p.rows) {
    lines.push(`| ${r.n} | ${r.date} | \`${r.episode}\` | ${r.failureSource ?? '-'} | ${r.signatures} | ${r.repeat} | ${r.novel} | ${pct(r.rate)} | ${r.memorySize} | \`${r.scopeKey}\` |`);
  }
  lines.push('');
  lines.push('### 3.2 按 scope 分层');
  lines.push('');
  lines.push('| scope | 局 | 有签名 | repeat | novel | rate |');
  lines.push('|---|---|---|---|---|---|');
  for (const s of p.byScope) {
    lines.push(`| \`${s.scopeKey}\` | ${s.episodes} | ${s.evaluated} | ${s.repeat} | ${s.novel} | ${pct(s.rate)} |`);
  }
  lines.push('');
  lines.push(`### 3.3 坑榜（同一签名出现在 ≥2 局；共 ${p.topSignatures.length} 条）`);
  lines.push('');
  lines.push('| 局数 | 签名（规范化后，截 110 字） |');
  lines.push('|---|---|');
  for (const t of p.topSignatures.slice(0, 15)) {
    lines.push(`| ${t.episodes} | \`${t.signature.slice(0, 110).replace(/\|/g, '\\|')}\` |`);
  }
  lines.push('');
  lines.push('## 4 · 复现命令');
  lines.push('');
  lines.push('```bash');
  lines.push('cd "/d/DeepSeek Harness/default-workspace/长期记忆系统"');
  lines.push('node scripts/eval.mjs --root "$DSH_HOME" --store tmp/memory-context            # 文本表');
  lines.push('node scripts/eval.mjs --root "$DSH_HOME" --store tmp/memory-context --json     # 机器可读');
  lines.push('node scripts/eval.mjs --root "$DSH_HOME" --store tmp/memory-context --source edge  # 只算 R03 边失败');
  lines.push('node scripts/eval.mjs --root "$DSH_HOME" --store tmp/memory-context --evidence evidence/M5-eval.md');
  lines.push('node --test test/eval.test.mjs');
  lines.push('```');
  lines.push('');
  lines.push('## 5 · 口径风险（读数字前先看）');
  lines.push('');
  lines.push('1. **这是"机械代理指标"，不是收益本身**。它只回答"失败原文是否在更早的局里出现过"，');
  lines.push('   不回答"模型是否因此真的少走弯路"——后者要 M5 的配对重放（有模型调用）。');
  lines.push('2. **`both` 混了两个来源**：edge（棋谱失败边）证据质量高但覆盖低；event（退出码）覆盖高但只取错误行。');
  lines.push('   两个分口径的数字都在 §2，引用时必须带口径名。');
  lines.push('3. **签名是文本匹配**：同一错误的不同措辞算 novel（**低估** repeat）；同一模板不同参数算 repeat（可能**高估**）。');
  lines.push('   规范化只去路径/行号/时间戳/十六进制，不做语义合并（禁止模型判断）。');
  lines.push('4. **time 用的是会话 startedAt**：一局内"先犯后犯"同一坑算一次 repeat；跨局严格按开始时间。');
  lines.push('5. **无记忆基线 = 0 是定义**，不是实测：没有 memory 时没有"已结算失败"可比。');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const USAGE = `棋院 eval（M5 机械评测，零模型调用）

用法：
  node scripts/eval.mjs [--root <dataRoot>] [--store <memoryRoot>] [--source both|edge|event]
                        [--json] [--evidence <path>]

选项：
  --root <dir>     数据根（默认 $DSH_HOME）：只读会话日志/棋谱
  --store <dir>    记忆库根（默认 <root>/memory-context）：只读 episodes/
  --source <mode>  失败来源：both（默认，逐局优先 edge，无失败边用 event）| edge | event
  --json           输出 JSON（含逐局明细与三口径对照）
  --evidence <p>   写 markdown 证据文件（唯一写入口）
  -h, --help       本帮助
`;

export function parseArgs(argv = []) {
  const args = [...argv];
  const flags = {};
  const positional = [];
  while (args.length) {
    const a = args.shift();
    if (a === '--json') flags.json = true;
    else if (a === '-h' || a === '--help') flags.help = true;
    else if (a === '--root') flags.root = args.shift();
    else if (a.startsWith('--root=')) flags.root = a.slice('--root='.length);
    else if (a === '--store') flags.store = args.shift();
    else if (a.startsWith('--store=')) flags.store = a.slice('--store='.length);
    else if (a === '--source') flags.source = args.shift();
    else if (a.startsWith('--source=')) flags.source = a.slice('--source='.length);
    else if (a === '--evidence') flags.evidence = args.shift();
    else if (a.startsWith('--evidence=')) flags.evidence = a.slice('--evidence='.length);
    else if (a === '--now') flags.now = Number(args.shift());
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  return { flags, positional };
}

export async function runCli(argv = []) {
  const { flags } = parseArgs(argv);
  if (flags.help) return { code: 0, stdout: USAGE, stderr: '' };
  const dataRoot = path.resolve(flags.root ?? process.env.DSH_HOME ?? '');
  if (!dataRoot) return { code: 2, stdout: '', stderr: `需要 --root <dataRoot> 或 $DSH_HOME\n\n${USAGE}` };
  if (flags.source && !SOURCE_MODES.includes(flags.source)) {
    return { code: 2, stdout: '', stderr: `--source 只能是 ${SOURCE_MODES.join(' / ')}` };
  }
  try {
    const report = await runEval({
      dataRoot,
      storeRoot: flags.store ? path.resolve(flags.store) : path.join(dataRoot, 'memory-context'),
      source: flags.source,
      now: flags.now,
    });
    let evidence = null;
    if (typeof flags.evidence === 'string' && flags.evidence !== '') {
      const abs = path.resolve(flags.evidence);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, renderEvidenceMarkdown(report));
      evidence = abs;
    }
    if (flags.json) return { code: 0, stdout: JSON.stringify({ ...report, evidence }, null, 2), stderr: '' };
    const text = `${formatReport(report)}${evidence ? `\n证据已写：${evidence}` : ''}`;
    return { code: 0, stdout: text, stderr: '' };
  } catch (err) {
    return { code: 1, stdout: '', stderr: `eval 失败：${String(err?.message ?? err)}` };
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

export default {
  runEval,
  evaluateLoo,
  normalizeErrorSignature,
  isDegenerateSignature,
  pickErrorLine,
  edgeFailureSignals,
  eventFailureSignals,
  dedupeBySignature,
  extractEpisodeFailures,
  formatReport,
  renderEvidenceMarkdown,
  parseArgs,
  runCli,
  main,
  EXIT_CODE_RE,
  SOURCE_MODES,
};

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}

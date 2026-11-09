#!/usr/bin/env node
// T244 · 自证污染核查（F5）：注入的 `<memory-ledger>` 有没有被当成**原始语料**再次抽取？
//
// 背景（AGENTS §2.3 红线）：
//   「禁止从摘要再抽取：抽取输入只能是原始事件/棋谱边（`<compacted-summary>` / `<chess-fold>` /
//    任何模型生成摘要一律不可作源）—— 自证污染。」
//   `<memory-ledger>` 是**本系统自己生成的文本**（R12 注入），比摘要更该被排除。
//
// T241 的机械证据：94 条远偏移里 88 条的"命中"落在被注入过的记忆卡上。
// 本脚本回答两个问题：
//   Q1（路径）`<memory-ledger>` 出现在哪些事件类型里？—— `scanLedgerEvents`
//   Q2（污染）有多少条 claim 的 support.quote **唯一来源是注入卡**？—— `auditSelfContamination`
//
// ── 判定 ───────────────────────────────────────────────────────────────────
// 维度 A（P2 三态，复用 scripts/provenance-p2.mjs 的 `checkQuoteAtSeq`）：
//   ok                  quote 是 (ep, seq) 原文的逐字子串
//   quote-not-substring 原文读到了，但 quote 不是它的子串（指针指错）
//   seq-unreadable      原文不可达 —— 不算 ok（fail-closed）
// 维度 B（**本脚本新增**）：
//   把该局每个事件的原文按 `<memory-ledger>` … `</memory-ledger>` 剥离（`stripLedgerBlocks`），
//   · `selfContaminated = 本局原文里找得到 quote，但**去卡文本里找不到**`
//     ⇒ 这句 quote 在本局的**全部出现位置都在注入卡内** ⇒ 唯一来源是卡。
//   · 反向也要排除：若卡的渲染时间**晚于** claim 的 `recordedAt`，说明是**卡引用了 claim**，
//     不是 claim 引用了卡 ⇒ `direction='card-from-claim'`（不算"卡→claim"的 F5 实例，
//     但说明 claim 的 quote 本身是**改写**而非原文 —— 那是 P2 问题）。
//
// 只读：不写库、不改代码；唯一写入口是 `--evidence <path>`。
//
// 用法：
//   node scripts/self-contamination-audit.mjs                     # 人类可读汇总 + N 条证据链
//   node scripts/self-contamination-audit.mjs --json              # 机器可读
//   node scripts/self-contamination-audit.mjs --samples 10        # 证据链条数（默认 5）
//   node scripts/self-contamination-audit.mjs --limit 200         # 只查前 N 条 claim（抽样）
//   node scripts/self-contamination-audit.mjs --scan-logs         # 额外全库扫 <memory-ledger> 事件类型
//   node scripts/self-contamination-audit.mjs --evidence <path>   # 写证据文件（唯一写入口）
//
// 退出码：0 无自证污染；1 存在 self-contaminated；2 读库失败。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readFrames, parseEvents } from '../src/rooms/logread.mjs';
import {
  NORMALIZE_RULES,
  checkQuoteAtSeq,
  collectStrings,
  formatSummary,
  indexEvents,
  normalizeText,
} from './provenance-p2.mjs';

const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
const STORE_ROOT = path.join(HOME, 'memory-context');

/** 注入卡开/闭标记（与 `src/rooms/inject.mjs` 的 `renderLedger` 一致）。 */
export const LEDGER_OPEN = '<memory-ledger>';
export const LEDGER_CLOSE = '</memory-ledger>';

/** 卡片行标记（T241 的口径：命中处含这些标记 = 命中在卡上）。 */
export const CARD_MARKERS = Object.freeze([
  '[semantic]', '[candidate]', '[observed]', '[disputed]', '[stale]',
  '[antipattern]', '[fact]', '[rule]', '[preference]', '[pattern]',
  '# markers:', 'MEMORY: ',
]);

/**
 * 剥掉 `<memory-ledger>…</memory-ledger>` 段（含标记本身）。
 * 未闭合（写盘撕裂/截断）按"从开标记到文本末尾"处理 —— 宁多剥，不让卡尾混进语料。
 * @param {string} text 已归一化（`normalizeText`）的文本
 * @returns {string}
 */
export function stripLedgerBlocks(text) {
  const src = String(text ?? '');
  let out = '';
  let cursor = 0;
  for (;;) {
    const open = src.indexOf(LEDGER_OPEN, cursor);
    if (open < 0) return out + src.slice(cursor);
    out += src.slice(cursor, open);
    const close = src.indexOf(LEDGER_CLOSE, open + LEDGER_OPEN.length);
    if (close < 0) return out; // 未闭合：后面全算卡内
    cursor = close + LEDGER_CLOSE.length;
  }
}

/**
 * 文本里的卡片段区间（证据用：证明"命中落在卡里"）。
 * @param {string} text
 * @returns {{start:number,end:number}[]}
 */
export function ledgerSpans(text) {
  const src = String(text ?? '');
  const spans = [];
  let cursor = 0;
  for (;;) {
    const open = src.indexOf(LEDGER_OPEN, cursor);
    if (open < 0) return spans;
    const close = src.indexOf(LEDGER_CLOSE, open + LEDGER_OPEN.length);
    const end = close < 0 ? src.length : close + LEDGER_CLOSE.length;
    spans.push({ start: open, end });
    if (close < 0) return spans;
    cursor = end;
  }
}

/** 该文本是否携带注入卡。 */
export function hasLedger(text) {
  return String(text ?? '').includes(LEDGER_OPEN);
}

/** 该文本是否"长成卡片样"（T241 的 88 条口径）。 */
export function looksLikeCard(text) {
  const s = String(text ?? '');
  return s.includes(LEDGER_OPEN) || CARD_MARKERS.some((m) => s.includes(m));
}

/** 事件类型 + 角色（分布维度）。 */
export function eventTypeOf(ev) {
  const type = typeof ev?.type === 'string' ? ev.type : '(no-type)';
  const role = typeof ev?.data?.role === 'string' ? ev.data.role : null;
  return role ? `${type}|role=${role}` : type;
}

/** 事件原文（归一化）：与 provenance-p2 的 `indexEvents` 口径一致。 */
export function eventText(ev) {
  return collectStrings(ev?.data ?? ev ?? {}).map(normalizeText).filter((s) => s !== '').join('\n');
}

/** 含 quote 的那一行（证据用；取卡内行）。 */
export function cardLineOf(text, quote) {
  const needle = normalizeText(quote);
  if (!needle) return null;
  for (const line of String(text ?? '').split('\n')) {
    if (line.includes(needle)) return line.trim();
  }
  return null;
}

/** 读 store 的 claims / episodes（只读）。 */
export function loadStore(storeRoot = STORE_ROOT) {
  const claims = [];
  const episodes = new Map();
  const claimsDir = path.join(storeRoot, 'claims');
  const episodesDir = path.join(storeRoot, 'episodes');
  for (const name of fs.existsSync(claimsDir) ? fs.readdirSync(claimsDir) : []) {
    if (!name.endsWith('.json')) continue;
    try { claims.push(JSON.parse(fs.readFileSync(path.join(claimsDir, name), 'utf8'))); } catch { /* 坏条目跳过 */ }
  }
  for (const name of fs.existsSync(episodesDir) ? fs.readdirSync(episodesDir) : []) {
    if (!name.endsWith('.json')) continue;
    try {
      const ep = JSON.parse(fs.readFileSync(path.join(episodesDir, name), 'utf8'));
      if (ep?.id) episodes.set(String(ep.id), ep);
    } catch { /* 同上 */ }
  }
  return { claims, episodes };
}

/** 日志读取器：`episode.closure.logPath` 相对 `home`。 */
export function makeLogLoader({ home = HOME } = {}) {
  return (episodeId, ep) => {
    const logPath = ep?.closure?.logPath;
    if (!logPath) return null;
    const abs = path.isAbsolute(logPath) ? logPath : path.join(home, logPath);
    if (!fs.existsSync(abs)) return null;
    const decoded = readFrames(fs.readFileSync(abs));
    const frames = Array.isArray(decoded) ? decoded : decoded?.frames;
    return parseEvents(frames ?? [])?.events ?? null;
  };
}

/**
 * 主判定（纯逻辑；`loadEvents` 注入便于单测）。
 * @param {{claims:Array, episodes:Map<string,object>, loadEvents:Function, opts?:{limit?:number, detailLimit?:number}}} p
 * @returns {{stats:object, rows:Array, contaminated:Array, details:Array, ledgerEventTypes:Array}}
 */
/**
 * T58：方向判定（纯函数，可单测）。
 *
 * · `claim-from-card`：卡渲染**早于** claim 的 recordedAt ⇒ 这条 claim 有可能就是从卡里抓的（**真 F5**）；
 * · `card-from-claim`：卡渲染**晚于** claim ⇒ 是卡引用了 claim，**不算**红线实例（但如果 quote 不是原文子串，那是 P2 指针问题）；
 * · `unknown`：算不出来（读不到事件 / 缺 recordedAt）⇒ **fail-closed**，按真 F5 计。
 *
 * @param {number|null} earliestCard 该 quote 落在注入卡内的最早时间
 * @param {number|null} claimRecordedAt claim 的入馆时间
 * @returns {'claim-from-card'|'card-from-claim'|'unknown'}
 */
export function classifyDirection(earliestCard, claimRecordedAt) {
  const card = Number.isFinite(earliestCard) ? earliestCard : null;
  const recorded = Number.isFinite(claimRecordedAt) ? claimRecordedAt : null;
  if (card === null || recorded === null) return 'unknown';
  return card < recorded ? 'claim-from-card' : 'card-from-claim';
}

export function auditSelfContamination({ claims, episodes, loadEvents, opts = {} }) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : Infinity;
  const detailLimit = Number.isFinite(opts.detailLimit) ? opts.detailLimit : 10;

  // 1) 按 episode 分组
  const pending = new Map();
  for (const claim of (Array.isArray(claims) ? claims : []).slice(0, limit)) {
    for (const src of Array.isArray(claim?.support) ? claim.support : []) {
      const episode = src?.episode ?? null;
      const key = episode ?? '\u0000none';
      if (!pending.has(key)) pending.set(key, []);
      pending.get(key).push({
        claimId: claim?.id ?? null,
        kind: claim?.kind ?? null,
        claimState: claim?.state ?? null,
        claimRecordedAt: Number.isFinite(claim?.recordedAt) ? claim.recordedAt : null,
        claimOccurredAt: Number.isFinite(claim?.occurredAt) ? claim.occurredAt : null,
        episode,
        seq: Number(src?.seq),
        quote: typeof src?.quote === 'string' ? src.quote : '',
        nodeId: src?.nodeId ?? null,
        edgeId: src?.edgeId ?? null,
      });
    }
  }

  const rows = [];
  const ledgerEventTypes = new Map();
  let eventsScanned = 0;

  for (const [key, group] of pending) {
    const ep = key === '\u0000none' ? null : (episodes?.get?.(key) ?? null);
    let events = null;
    try { events = ep ? loadEvents(key, ep) : null; } catch { events = null; }
    if (!events) {
      for (const item of group) {
        rows.push({ ...item, verdict: 'seq-unreadable', reason: ep ? 'episode-unreadable' : 'no-episode', citedType: null, inLedger: false, elsewhereInEpisode: false, selfContaminated: false });
      }
      continue;
    }

    eventsScanned += events.length;
    const index = indexEvents(events);
    const eventBySeq = new Map();
    for (const ev of events) eventBySeq.set(Number(ev?.seq), ev);

    // 每 seq：去卡文本（只算一次）+ 卡事件类型分布
    const stripped = new Map();
    for (const [seq, hit] of index) {
      stripped.set(seq, stripLedgerBlocks(hit.text));
      if (hasLedger(hit.text)) {
        const t = eventTypeOf(eventBySeq.get(Number(seq)));
        ledgerEventTypes.set(t, (ledgerEventTypes.get(t) ?? 0) + 1);
      }
    }
    const rawCorpus = [...index.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([, h]) => h.text).join('\n');
    const strippedCorpus = [...stripped.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([, t]) => t).join('\n');

    for (const item of group) {
      const verdict = checkQuoteAtSeq({ quote: item.quote, seq: item.seq, eventIndex: index });
      const needle = normalizeText(item.quote);
      const hit = index.get(Number(item.seq)) ?? null;
      const rawText = hit?.text ?? '';
      const strippedText = stripped.get(Number(item.seq)) ?? '';
      const inLedger = needle !== '' && rawText.includes(needle) && !strippedText.includes(needle);
      const anywhereRaw = needle !== '' && rawCorpus.includes(needle);
      const anywhereStripped = needle !== '' && strippedCorpus.includes(needle);
      rows.push({
        ...item,
        verdict: verdict.verdict,
        reason: verdict.reason ?? null,
        citedType: hit ? eventTypeOf(eventBySeq.get(Number(item.seq))) : null,
        inLedger,
        elsewhereInEpisode: verdict.verdict !== 'ok' && anywhereRaw,
        selfContaminated: anywhereRaw && !anywhereStripped,
      });
    }
  }

  const contaminated = rows.filter((r) => r.selfContaminated);
  // 1.5) T58（2026-11-09）：**方向要算全量，不能只算抽样**。
  // 契约（见文件头 §维度 B）：`card-from-claim` = 卡渲染时间**晚于** claim 的 recordedAt ⇒ 是**卡引用了 claim**，
  // 属 P2 改写问题，**不算**「卡→claim」的红线实例；只有 `claim-from-card`（卡早于 claim）才是真 F5。
  // 旧实现把方向只算在 `details`（默认 5 条抽样）上，而汇总/退出码用**未区分方向**的 selfContaminated
  // ⇒ 本机实测 60 条**全部**是 card-from-claim，却被判成红线、退出码 1。
  const eventsCache = new Map();
  const loadEventsCached = (episode) => {
    if (eventsCache.has(episode)) return eventsCache.get(episode);
    let events = null;
    try {
      const ep = episodes?.get?.(episode) ?? null;
      events = ep ? loadEvents(episode, ep) : null;
    } catch { events = null; }
    eventsCache.set(episode, events);
    return events;
  };
  /** 该 quote 在**本局**里最早一次"落在注入卡内"的时间（没有 ⇒ null）。 */
  const earliestCardOf = (events, quote) => {
    const needle = normalizeText(quote);
    if (!needle || !events) return null;
    let earliest = null;
    for (const ev of events) {
      const text = eventText(ev);
      if (!text.includes(needle)) continue;
      const at = text.indexOf(needle);
      if (!ledgerSpans(text).some((sp) => at >= sp.start && at < sp.end)) continue;
      const t = Number.isFinite(ev?.time) ? ev.time : null;
      if (t !== null && (earliest === null || t < earliest)) earliest = t;
    }
    return earliest;
  };
  const directionByRow = new Map();
  for (const row of contaminated) {
    directionByRow.set(row, classifyDirection(earliestCardOf(loadEventsCached(row.episode), row.quote), row.claimRecordedAt));
  }

  const byVerdict = rows.reduce((acc, r) => { acc[r.verdict] = (acc[r.verdict] ?? 0) + 1; return acc; }, {});
  const claimsTotal = Math.min(Array.isArray(claims) ? claims.length : 0, limit);
  const stats = {
    claims: claimsTotal,
    claimsWithRefs: new Set(rows.map((r) => r.claimId)).size,
    refs: rows.length,
    ok: byVerdict.ok ?? 0,
    notSubstring: byVerdict['quote-not-substring'] ?? 0,
    unreadable: byVerdict['seq-unreadable'] ?? 0,
    elsewhereInEpisode: rows.filter((r) => r.elsewhereInEpisode).length,
    inLedger: rows.filter((r) => r.inLedger).length,
    selfContaminated: contaminated.length,
    // T58：把「真 F5」与「反向（卡引用了 claim）」分开计数 —— 只有前者是红线。
    claimFromCard: contaminated.filter((r) => directionByRow.get(r) === 'claim-from-card').length,
    cardFromClaim: contaminated.filter((r) => directionByRow.get(r) === 'card-from-claim').length,
    directionUnknown: contaminated.filter((r) => directionByRow.get(r) === 'unknown').length,
    contaminatedClaims: new Set(contaminated.map((r) => r.claimId)).size,
    contaminatedRate: rows.length ? +((contaminated.length / rows.length) * 100).toFixed(2) : 0,
    contaminatedClaimRate: claimsTotal ? +((new Set(contaminated.map((r) => r.claimId)).size / claimsTotal) * 100).toFixed(2) : 0,
    eventsScanned,
    normalizeRules: [...NORMALIZE_RULES],
  };

  // 2) 证据链（只对 self-contaminated 的 ref 做定位；数量小，成本可接受）
  const details = [];
  for (const row of contaminated.slice(0, detailLimit)) {
    const ep = episodes?.get?.(row.episode) ?? null;
    let events = null;
    try { events = ep ? loadEvents(row.episode, ep) : null; } catch { events = null; }
    if (!events) { details.push({ ...row, occurrences: [], earliestCard: null, direction: 'unknown' }); continue; }
    const needle = normalizeText(row.quote);
    const occurrences = [];
    for (const ev of events) {
      const text = eventText(ev);
      if (!text.includes(needle)) continue;
      const at = text.indexOf(needle);
      occurrences.push({
        seq: Number(ev?.seq),
        type: eventTypeOf(ev),
        time: Number.isFinite(ev?.time) ? ev.time : null,
        inLedger: ledgerSpans(text).some((s) => at >= s.start && at < s.end),
        cardLine: cardLineOf(text, needle),
      });
    }
    const cardTimes = occurrences.filter((o) => o.inLedger && o.time).map((o) => o.time);
    const earliestCard = cardTimes.length ? Math.min(...cardTimes) : null;
    const direction = directionByRow.get(row) ?? classifyDirection(earliestCard, row.claimRecordedAt);
    details.push({ ...row, occurrences, earliestCard, direction });
  }

  // 红线实例 = 卡早于 claim（有嫌疑）+ 方向算不出来（fail-closed，不许当没事）
  stats.realF5 = stats.claimFromCard + stats.directionUnknown;
  return { stats, rows, contaminated, details, ledgerEventTypes: [...ledgerEventTypes].sort((a, b) => b[1] - a[1]) };
}

/** 全库扫：`<memory-ledger>` 出现在哪些事件类型里（污染路径）。 */
export function scanLedgerEvents({ home = HOME, limit = Infinity } = {}) {
  const root = path.join(home, 'sessions');
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl.zstd')) files.push(p);
    }
  };
  walk(root);
  files.sort();
  const types = new Map();
  let scanned = 0;
  let withCard = 0;
  let cardEvents = 0;
  let totalEvents = 0;
  const samples = [];
  for (const file of files.slice(0, limit)) {
    scanned += 1;
    let parsed;
    try {
      const decoded = readFrames(fs.readFileSync(file));
      parsed = parseEvents(Array.isArray(decoded) ? decoded : decoded?.frames ?? []);
    } catch { continue; }
    totalEvents += parsed.events.length;
    let hitThisFile = 0;
    for (const ev of parsed.events) {
      const text = eventText(ev);
      if (!hasLedger(text)) continue;
      hitThisFile += 1;
      cardEvents += 1;
      const key = eventTypeOf(ev);
      types.set(key, (types.get(key) ?? 0) + 1);
      if (samples.length < 3) {
        samples.push({ file: path.relative(root, file), seq: ev?.seq ?? null, type: eventTypeOf(ev), source: ev?.data?.source ?? null, textHead: text.slice(0, 200) });
      }
    }
    if (hitThisFile > 0) withCard += 1;
  }
  return { scanned, withCard, cardEvents, totalEvents, types: [...types].sort((a, b) => b[1] - a[1]), samples };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { json: false, evidence: null, limit: null, samples: 5, scanLogs: false, storeRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--evidence') out.evidence = argv[++i] ?? null;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--samples') out.samples = Number(argv[++i]);
    else if (a === '--scan-logs') out.scanLogs = true;
    else if (a === '--store') out.storeRoot = argv[++i] ?? null;
  }
  return out;
}

const fmtTime = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : 'null');

function renderEvidence({ stats, details, scan }) {
  const L = [];
  L.push('# T244 · 自证污染核查（注入的 `<memory-ledger>` 有没有被当成语料）');
  L.push('');
  L.push('> 脚本 `scripts/self-contamination-audit.mjs`（只读）· 判据复用 `scripts/provenance-p2.mjs` 的 P2 三态');
  L.push(`> \`[本] ${new Date().toISOString()}\` · 未写库、未改代码、未跑全量测试、未重启 DSH`);
  L.push('');
  L.push('## 0 · 一句话');
  L.push('');
  // T58：方向计数取自**全量** stats（旧实现取 details 抽样，60 条只看到 5 条）
  const fromCard = stats.claimFromCard ?? 0;
  const cardFromClaim = stats.cardFromClaim ?? 0;
  L.push(stats.selfContaminated > 0
    ? `**红线实例：${stats.selfContaminated} / ${stats.refs} 条引用（${stats.contaminatedRate}%）的引文在本局**唯一来源是注入卡**；`
      + `其中"卡早于 claim"（卡→claim，真 F5）${fromCard} 条、"claim 早于卡"（claim→卡，属 P2 改写）${cardFromClaim} 条。**`
    : `**虚惊：0 / ${stats.refs} 条引用的唯一来源是注入卡。**`);
  L.push('');
  L.push('## 1 · 汇总');
  L.push('');
  L.push('```');
  L.push(formatSummary(stats));
  L.push(`in-ledger=${stats.inLedger} · 远偏移命中=${stats.elsewhereInEpisode} · self-contaminated=${stats.selfContaminated}`
    + `（refs ${stats.contaminatedRate}% / claims ${stats.contaminatedClaimRate}%，${stats.contaminatedClaims} 条 claim）`);
  L.push(`events-scanned=${stats.eventsScanned}`);
  L.push('```');
  L.push('');
  if (scan) {
    L.push('## 2 · 污染路径：`<memory-ledger>` 出现在哪些事件类型里');
    L.push('');
    L.push('```');
    L.push(`scanned-logs=${scan.scanned} · 含卡日志=${scan.withCard} · 卡事件=${scan.cardEvents} · 总事件=${scan.totalEvents}`);
    for (const [k, v] of scan.types) L.push(`  ${k} : ${v}`);
    L.push('```');
    L.push('');
  }
  L.push('## 3 · 证据链');
  L.push('');
  for (const d of details) {
    L.push(`### ${d.claimId} · kind=${d.kind} · state=${d.claimState}`);
    L.push('');
    L.push(`- 引用：\`(${d.episode}, seq ${d.seq})\` · 该 seq 类型 = \`${d.citedType ?? 'n/a'}\``);
    L.push(`- 判定：\`${d.verdict}\` · **self-contaminated = ${d.selfContaminated}** · 方向 = \`${d.direction}\``);
    L.push(`- claim.recordedAt = ${fmtTime(d.claimRecordedAt)} · 卡最早渲染 = ${fmtTime(d.earliestCard)}`);
    L.push('- 引文在本局的出现位置：');
    for (const o of d.occurrences) {
      L.push(`  - seq ${o.seq} · \`${o.type}\` · ${fmtTime(o.time)} · in-ledger=${o.inLedger}`);
    }
    L.push('');
    L.push('卡上那一行（逐字）：');
    L.push('');
    L.push('```');
    L.push(String(d.occurrences[0]?.cardLine ?? d.quote));
    L.push('```');
    L.push('');
  }
  return L.join('\n');
}

async function main(argv) {
  const args = parseArgs(argv);
  const storeRoot = args.storeRoot ? path.resolve(args.storeRoot) : STORE_ROOT;
  const { claims, episodes } = loadStore(storeRoot);
  const result = auditSelfContamination({
    claims,
    episodes,
    loadEvents: makeLogLoader({ home: HOME }),
    opts: { limit: Number.isFinite(args.limit) ? args.limit : undefined, detailLimit: args.samples },
  });
  const scan = args.scanLogs ? scanLedgerEvents({ home: HOME }) : null;

  if (args.json) {
    console.log(JSON.stringify({ storeRoot, stats: result.stats, details: result.details, ledgerEventTypes: result.ledgerEventTypes, scan }, null, 2));
  } else {
    console.log('T244 · 自证污染核查（注入卡是否被当成原始语料）');
    console.log(`store: ${storeRoot}`);
    console.log(formatSummary(result.stats));
    console.log(`in-ledger=${result.stats.inLedger} · 远偏移命中=${result.stats.elsewhereInEpisode} · self-contaminated=${result.stats.selfContaminated}`
      + `（refs ${result.stats.contaminatedRate}% / claims ${result.stats.contaminatedClaimRate}%，${result.stats.contaminatedClaims} 条 claim）`);
    console.log(`方向拆分（T58）：真 F5（卡早于 claim + 方向不明）= **${result.stats.realF5}**`
      + ` · 卡早于 claim=${result.stats.claimFromCard} · 卡引用 claim=${result.stats.cardFromClaim} · 方向不明=${result.stats.directionUnknown}`
      + `（全部方向已在**全量** contaminated 上算过，不是抽样）`);
    if (scan) {
      console.log(`\n卡事件类型分布（scanned-logs=${scan.scanned} · 含卡日志=${scan.withCard} · 卡事件=${scan.cardEvents} · 总事件=${scan.totalEvents}）:`);
      for (const [k, v] of scan.types) console.log(`  ${k} : ${v}`);
    }
    console.log('\n证据链：');
    for (const d of result.details) {
      console.log(`- ${d.claimId} (${d.episode}, seq ${d.seq}) verdict=${d.verdict} self-contaminated=${d.selfContaminated} direction=${d.direction}`);
      for (const o of d.occurrences) console.log(`    seq ${o.seq} · ${o.type} · ${fmtTime(o.time)} · in-ledger=${o.inLedger}`);
      console.log(`    card-line: ${JSON.stringify(String(d.occurrences[0]?.cardLine ?? d.quote).slice(0, 200))}`);
    }
  }

  if (args.evidence) {
    const out = path.resolve(args.evidence);
    fs.writeFileSync(out, renderEvidence({ ...result, scan }), 'utf8');
    if (!args.json) console.log(`\nevidence: ${path.relative(process.cwd(), out)}`);
  }
  // T58：红线只看**真 F5**（卡早于 claim / 方向算不出来）。反向（卡引用 claim）属 P2 改写问题，不在这里判。
  return (result.stats.realF5 ?? result.stats.selfContaminated) > 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(`self-contamination-audit 失败：${String(err?.message ?? err)}`);
    process.exitCode = 2;
  });
}

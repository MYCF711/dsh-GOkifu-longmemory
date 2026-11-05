#!/usr/bin/env node
// 注入卡片抽查（M4，2026-11-04；2026-11-04 二次升级：文字级判据）
//
// 读 <store>/card-samples.jsonl，逐条核对卡片里每个 (ep, seq)：
//   1) 引用层（旧判据，保留）：ep 存在 + seq 落在该局 closure 内 + ep 属于卡片 scope；
//   2) 文字层（新默认）：卡上那一段正文是否**真的出现在该局的事件文本里**，**四态**
//      （T239，docs/调研/46 三值逻辑：**未知 ≠ 已失效**）：
//        ok        —— 在该 seq ±window（默认 3）个事件内出现（旧键 textAtSeq / verdict 'at-seq'）；
//        offset    —— 原文在**同一局其它 seq** 命中（附 distance；旧键 textElsewhere / verdict 'elsewhere'）。
//                     distance ≤ 20 记 offsetNear（"指针偏了几个 seq"，T232/T238 实测占 not-substring 的 85%），
//                     > 20 记 offsetFar。**两类都不判红**，但单列 + 给占比 —— 它们是"待修项"，不是"坏引用"。
//        unreadable—— episode / 日志 / seq 读不到（旧实现混进 missing）。**单列：不进 A6 分子也不进分母**；
//                     退出码仍 fail-closed（没验过的不能当绿）。
//        notFound  —— 本局**任何 seq** 都找不到 ⇒ **真正的坏引用**（旧键 missing，保留兼容；文案改"真找不到"）。
//   3) 日期层：卡片日期必须等于所引 seq 附近那条事件的 occurredAt 格式化后的日期（UTC，口径同
//      `src/rooms/inject.mjs` 的 `formatCardDate`）。
//
// 退出码：文字层 missing > 0 或 日期不一致 > 0 ⇒ 1（旧的"可回溯 100% 就 exit 0"是假绿）。
// `--no-text` 退回弱判据（只查引用层），退出码也退回旧口径，留给对照/离线快跑。
//
// 只读，不写库，不写 <DSH_HOME> 之外的东西。
// 用法：node scripts/audit-card-samples.mjs [--store <dir>] [--json] [--no-text] [--window N]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { readFrames, parseEvents } from '../src/rooms/logread.mjs';
import { formatCardDate, singleLine } from '../src/rooms/inject.mjs';

/** 文字层默认窗口：实测「调用步 → 工具结果」的 seq 间隔直方为 0×9,2×9,3×2,4×30,5×11,6×6,8/9/10 各 1，
 *  取 ±3 会把一大批真引用判成 elsewhere（2026-11-04 audit-11 复核后定）。*/
export const DEFAULT_WINDOW = 10;

/** 卡片行的 provenance 尾巴：`(ep-xxxxxxxx, YYYY-MM-DD, seq N)`（日期字段也可能带时分）。 */
const PROV_SOURCE = /\((ep-[0-9a-f]{8}),\s*([^,]+),\s*seq\s*(\d+)\)/g;
/** 卡片行整体：`- [marker] 正文 (ep-…, 日期, seq N)`。 */
const LINE_SOURCE = /^- \[([^\]]+)\] (.+) \((ep-[0-9a-f]{8}),\s*([^,]+),\s*seq\s*(\d+)\)\s*$/;

/** 取一个全新的 provenance 正则（避免 /g 的 lastIndex 串味）。 */
export function provRegex() {
  return new RegExp(PROV_SOURCE.source, PROV_SOURCE.flags);
}

/**
 * 把卡片里的正文归一成"可与事件原文 includes 比对"的形式：
 * 单行化（多空格/换行折成一个空格）→ 去掉卡片模板加的前缀（`[跨项目] `、`class:xxx · `）
 * → 去掉截断尾 `…` → 再单行化一次。CJK 与路径反斜杠都不做额外转义。
 */
export function normalizeCardText(text) {
  let s = singleLine(text);
  s = s.replace(/^\[跨项目\]\s*/, '');
  s = s.replace(/^class:[A-Za-z0-9._-]+\s*·\s*/, '');
  s = s.replace(/[…]+$/, '');
  return singleLine(s);
}

/** 从 section 里解析出每条渲染行的 { marker, text, episode, date, seq }。 */
export function parseCardLines(section) {
  const out = [];
  for (const line of String(section ?? '').split('\n')) {
    const m = line.match(LINE_SOURCE);
    if (!m) continue;
    out.push({ marker: m[1], text: m[2], episode: m[3], date: m[4].trim(), seq: Number(m[5]) });
  }
  return out;
}

/** 只要 provenance（兼容旧口径：不要求行首 marker 形态也能抽到 (ep, date, seq)）。 */
export function parseCardRefs(section) {
  return [...String(section ?? '').matchAll(provRegex())]
    .map((m) => ({ episode: m[1], date: m[2].trim(), seq: Number(m[3]) }));
}

/** 递归收集对象里的全部字符串（事件原文；不用 JSON.stringify，避免把 `"` 转义成 `\"`）。 */
export function collectStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out); return out; }
  if (typeof value === 'object') { for (const v of Object.values(value)) collectStrings(v, out); }
  return out;
}

/** 事件数组 → `[{ seq, time, blob }]`（blob 用换行拼接，正文不会跨两个字符串，故不会假阳）。 */
/** T239：`offset` 里"近偏移"的门槛（seq 距离）。≤ 这个值的算"指针偏了几个事件"，> 的算"远偏移"。 */
export const OFFSET_NEAR_MAX = 20;

export function eventsToBlobs(events) {
  return (Array.isArray(events) ? events : [])
    .map((ev) => ({
      seq: Number(ev?.seq),
      time: Number.isFinite(ev?.time) ? Number(ev.time) : null,
      // 每个字符串先 singleLine：多行错误原文（含换行/缩进）不归一的话，卡片正文（已单行化）会假阳成 missing。
      // 不同字符串之间用换行分隔 —— 一条正文不会跨两个字符串，所以拼接不会制造假阳。
      blob: collectStrings(ev?.data ?? ev ?? {}).map((s) => singleLine(s)).filter(Boolean).join('\n'),
      // 2026-11-04（0.132.0）：抽取会把同一事件里的**多段字符串**拼成一行（如 stdout+stderr），
      // 单行化后段间只剩一个空格，而 blob 用换行连接 ⇒ 会假阳成 missing。这里并存一份空格连接的版本，
      // 只用来把这类拼接单独记成 joined（**不冒充 at-seq**，汇总里单独报数）。
      blobJoined: collectStrings(ev?.data ?? ev ?? {}).map((s) => singleLine(s)).filter(Boolean).join(' '),
    }))
    .filter((ev) => Number.isFinite(ev.seq));
}

/** 文字层三档判定。events 需为 `eventsToBlobs()` 的形状。 */
export function classifyTextByEvents({ text, seq, events, window = DEFAULT_WINDOW }) {
  const needle = normalizeCardText(text);
  if (!needle) return { verdict: 'missing', nearestSeq: null, distance: null };
  let best = null;
  for (const ev of events) {
    if (!ev.blob.includes(needle)) continue;
    const distance = Math.abs(Number(ev.seq) - Number(seq));
    if (!best || distance < best.distance) best = { nearestSeq: ev.seq, distance };
  }
  if (!best) {
    // 严格版没命中 ⇒ 看空格拼接版：命中的话记 joined（同一局里的片段被拼成一行），不冒充 at-seq
    for (const ev of events) {
      const joined = ev.blobJoined ?? '';
      if (!joined || !joined.includes(needle)) continue;
      const distance = Math.abs(Number(ev.seq) - Number(seq));
      if (!best || distance < best.distance) best = { nearestSeq: ev.seq, distance, joined: true };
    }
    if (!best) return { verdict: 'missing', nearestSeq: null, distance: null };
    return { verdict: 'joined', nearestSeq: best.nearestSeq, distance: best.distance };
  }
  return {
    verdict: best.distance <= Math.max(0, Number(window) || 0) ? 'at-seq' : 'elsewhere',
    nearestSeq: best.nearestSeq,
    distance: best.distance,
  };
}

/** 找 seq 处的事件；没有就退到最近的一条（日期层用）。 */
export function eventNearSeq(events, seq) {
  let exact = null;
  let best = null;
  for (const ev of events) {
    const d = Math.abs(Number(ev.seq) - Number(seq));
    if (d === 0) { exact = ev; break; }
    if (!best || d < best.d) best = { d, ev };
  }
  return exact ?? best?.ev ?? null;
}

/** 日期层：卡片日期（取前 10 位）与事件的 UTC 日期比较。 */
export function checkDate({ refDate, event }) {
  const day = String(refDate ?? '').trim().slice(0, 10);
  if (!event || !Number.isFinite(event.time)) return { verdict: 'no-event', eventDate: null };
  const eventDate = formatCardDate(event.time);
  return { verdict: eventDate === day ? 'ok' : 'mismatch', eventDate };
}

/**
 * 主判定（纯逻辑，事件读取用 `loadEvents` 注入，便于测试）。
 *
 * @param {object}   p
 * @param {Array}    p.rows          card-samples.jsonl 的行
 * @param {Map}      p.episodes      id → episode 记录
 * @param {Function} [p.loadEvents]  `async (episodeId, episodeRecord) => events[]`（原始事件数组）
 * @param {number}   [p.window]      文字层 at-seq 的窗口（事件条数），默认 3
 * @param {boolean}  [p.textCheck]   默认 true；false ⇒ 只跑引用层（`--no-text`）
 */
export async function auditRows({ rows, episodes, loadEvents = null, window = DEFAULT_WINDOW, textCheck = true } = {}) {
  const cache = new Map();
  const eventsOf = async (id) => {
    if (!textCheck || typeof loadEvents !== 'function') return null;
    if (!cache.has(id)) {
      let raw = [];
      try { raw = (await loadEvents(id, episodes.get(id) ?? null)) ?? []; } catch { raw = null; }
      cache.set(id, raw === null ? null : eventsToBlobs(raw));
    }
    return cache.get(id);
  };

  const details = [];
  for (const row of rows) {
    const lines = parseCardLines(row?.section);
    const refs = lines.length ? lines : parseCardRefs(row?.section).map((r) => ({ ...r, text: '', marker: '' }));
    const verdicts = [];
    for (const ref of refs) {
      const ep = episodes.get(ref.episode);
      const inRange = ep ? ref.seq >= (ep.closure?.seqFrom ?? 0) && ref.seq <= (ep.closure?.seqTo ?? 0) : false;
      const sameScope = ep ? ep.scopeKey === row.scope : false;
      const base = { episode: ref.episode, seq: ref.seq, date: ref.date, exists: Boolean(ep), inRange, sameScope };
      if (!textCheck || !ref.text) {
        verdicts.push({ ...base, verdict: 'skipped', nearestSeq: null, distance: null, dateVerdict: 'skipped', eventDate: null });
        continue;
      }
      const events = await eventsOf(ref.episode);
      if (events === null) {
        // T239：读不到原件（日志缺失/解析失败）⇒ **单列成 unreadable**，不再冒充 missing。
        // 为什么：missing 的语义是"该局任何 seq 都没有这段文字"（内容对不上），而这里是"根本没读到"——
        // 两者是完全不同的两类问题（docs/调研/46：未知 ≠ 已失效）。unreadable 不进 A6 分子/分母，
        // 但退出码仍 fail-closed（一次全 unreadable 的审计必须非 0，否则就是"没验过也报绿"）。
        verdicts.push({ ...base, verdict: 'unreadable', nearestSeq: null, distance: null, dateVerdict: 'unreadable', eventDate: null });
        continue;
      }
      const textVerdict = classifyTextByEvents({ text: ref.text, seq: ref.seq, events, window });
      const dateVerdict = checkDate({ refDate: ref.date, event: eventNearSeq(events, ref.seq) });
      verdicts.push({ ...base, ...textVerdict, dateVerdict: dateVerdict.verdict, eventDate: dateVerdict.eventDate });
    }
    const count = (pred) => verdicts.filter(pred).length;
    details.push({
      at: row.at,
      digest: row.digest,
      tokens: row.tokens,
      scope: row.scope,
      refs: verdicts.length,
      ok: count((v) => v.exists && v.inRange),
      sameScope: count((v) => v.sameScope),
      bad: verdicts.filter((v) => !v.exists || !v.inRange).slice(0, 3),
      // T239 四态（旧键全部保留，兼容下游读法）
      textOk: count((v) => v.verdict === 'at-seq'),
      textAtSeq: count((v) => v.verdict === 'at-seq'),
      textOffset: count((v) => v.verdict === 'elsewhere'),
      textElsewhere: count((v) => v.verdict === 'elsewhere'),
      textOffsetNear: count((v) => v.verdict === 'elsewhere' && Number.isFinite(v.distance) && v.distance <= OFFSET_NEAR_MAX),
      textOffsetFar: count((v) => v.verdict === 'elsewhere' && Number.isFinite(v.distance) && v.distance > OFFSET_NEAR_MAX),
      textNotFound: count((v) => v.verdict === 'missing'),
      textMissing: count((v) => v.verdict === 'missing'), // 旧键 = notFound（true 坏引用）
      textUnreadable: count((v) => v.verdict === 'unreadable'),
      textJoined: count((v) => v.verdict === 'joined'),
      dateOk: count((v) => v.dateVerdict === 'ok'),
      dateBad: count((v) => v.dateVerdict === 'mismatch' || v.dateVerdict === 'no-event'),
      verdicts,
    });
  }

  const sum = (key) => details.reduce((n, d) => n + d[key], 0);
  const totalRefs = sum('refs');
  const okRefs = sum('ok');
  const sameScopeRefs = sum('sameScope');
  const textCheckFailed = textCheck;
  // T239：A6 的分母 = 引用数 − 读不到的（unreadable 不进分子也不进分母）。
  const textUnreadable = sum('textUnreadable');
  const a6Denominator = totalRefs - textUnreadable;
  // 中位距离：只统计"偏移命中"（offset）的那批；偶数个取中间两个的均值。
  const offsetDistances = details
    .flatMap((d) => d.verdicts)
    .filter((v) => v.verdict === 'elsewhere' && Number.isFinite(v.distance))
    .map((v) => Number(v.distance))
    .sort((a, b) => a - b);
  const medianOf = (arr) => {
    if (!arr.length) return null;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  };
  return {
    samples: details.length,
    refs: totalRefs,
    okRefs,
    traceableRate: totalRefs ? okRefs / totalRefs : null,
    sameScopeRefs,
    crossScopeRefs: totalRefs - sameScopeRefs,
    // 四态（旧键保留）
    textOk: sum('textOk'),
    textAtSeq: sum('textAtSeq'),
    textOffset: sum('textOffset'),
    textElsewhere: sum('textElsewhere'),
    textOffsetNear: sum('textOffsetNear'),
    textOffsetFar: sum('textOffsetFar'),
    textNotFound: sum('textNotFound'),
    textMissing: sum('textMissing'), // = textNotFound（真找不到）
    textUnreadable,
    textJoined: sum('textJoined'),
    a6Denominator,
    textOffsetRatio: a6Denominator ? sum('textOffset') / a6Denominator : null,
    textNotFoundRatio: a6Denominator ? sum('textNotFound') / a6Denominator : null,
    offsetDistanceMedian: medianOf(offsetDistances),
    dateOk: sum('dateOk'),
    dateBad: sum('dateBad'),
    textCheck,
    window,
    details,
    // 退出码判据（语义不变 + T239 明确）：
    //   · notFound（真坏引用）> 0 ⇒ 红；
    //   · unreadable（核不了）> 0 ⇒ 红 —— fail-closed：一次"全读不到"的审计必须是红的，否则就是没验过也报绿；
    //   · offset（指针偏了）**不红**，只在汇总里单列 + 给占比（待修项）；
    //   · 日期不一致 ⇒ 红；--no-text 退回旧口径。
    exitCode: textCheckFailed
      ? ((sum('textNotFound') > 0 || textUnreadable > 0 || sum('dateBad') > 0) ? 1 : 0)
      : (okRefs === totalRefs ? 0 : 1),
  };
}

/** 读某个 episode 的原始事件（逐帧解，口径同 `src/rooms/cli.mjs` 的 `readSession`）。 */
export function makeLogLoader({ home = process.env.DSH_HOME || 'D:/DeepSeek Harness/home' } = {}) {
  return async (episodeId, ep) => {
    const logPath = ep?.closure?.logPath;
    if (!logPath) return [];
    const abs = path.isAbsolute(logPath) ? logPath : path.join(home, logPath);
    if (!fs.existsSync(abs)) return [];
    const buf = fs.readFileSync(abs);
    const framesRes = readFrames(buf);
    const frames = Array.isArray(framesRes) ? framesRes : framesRes?.frames;
    const parsed = parseEvents(frames ?? []);
    return parsed?.events ?? [];
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * 从 `live-stats.jsonl` 的行里挑出**当前宿主**（最后一条心跳所在的那个 pid）。
 * 2026-11-04：重启前后新旧进程混写 `card-samples.jsonl`，全量统计会把旧代码的账算成"回归"
 * （A5 那 2 条跨作用域、A6 那 17 条 missing 都是 0.117.0 产出的）。`--current` 用这个函数自动切。
 * 纯函数：不读盘，单测直接喂行。
 */
export function pickCurrentPid(liveRows, { nowMs = null } = {}) {
  const rows = (Array.isArray(liveRows) ? liveRows : []).filter((r) => r && Number.isFinite(Number(r.pid)) && Number.isFinite(Number(r.at)));
  if (!rows.length) return null;
  let latest = rows[0];
  for (const r of rows) if (Number(r.at) > Number(latest.at)) latest = r;
  const pid = Number(latest.pid);
  const at = Number(latest.at);
  const ageMs = Number.isFinite(nowMs) ? Math.max(0, nowMs - at) : null;
  const stale = Number.isFinite(ageMs) ? ageMs > 30 * 60 * 1000 : false;
  const count = rows.filter((r) => Number(r.pid) === pid).length;
  return { pid, at, ageMs, stale, count };
}

async function main(argv = process.argv.slice(2)) {
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
  const storeRoot = path.resolve(opt('store', path.join(HOME, 'memory-context')));
  const file = path.join(storeRoot, 'card-samples.jsonl');
  if (!fs.existsSync(file)) { console.error(`没有抽样文件：${file}`); return 2; }

  const textCheck = !argv.includes('--no-text');
  const window = Number(opt('window', String(DEFAULT_WINDOW)));
  const store = createStore({ root: storeRoot });
  const episodes = new Map(store.list('episodes').map((x) => [x.record.id, x.record]));
  let rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  // 2026-11-04：按宿主进程切样本（重启前后新旧代码混写同一文件，混在一起会把旧账读成回归）。
  //   --pid <n>   显式指定；
  //   --current   自动挑"最后一条心跳所在的 pid"（巡检用这个，省得每次手抄 pid）。
  let pidWant = Number(opt('pid', '0'));
  let pidNote = '';
  if (!(Number.isFinite(pidWant) && pidWant > 0) && argv.includes('--current')) {
    const liveFile = path.join(storeRoot, 'live-stats.jsonl');
    const live = fs.existsSync(liveFile)
      ? fs.readFileSync(liveFile, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      : [];
    const cur = pickCurrentPid(live, { nowMs: Date.now() });
    if (cur) {
      pidWant = cur.pid;
      const mins = cur.ageMs == null ? '?' : Math.round(cur.ageMs / 60000);
      pidNote = `（--current ⇒ 宿主 pid=${cur.pid}，最后心跳 ${mins} 分钟前${cur.stale ? '，**看起来没在跑**' : ''}；该进程心跳 ${cur.count} 条）`;
    } else {
      pidNote = '（--current 没找到心跳记录 ⇒ 退回全量样本）';
    }
  }
  if (Number.isFinite(pidWant) && pidWant > 0) rows = rows.filter((r) => Number(r.pid) === pidWant);
  if (argv.includes('--current') && rows.length === 0 && pidNote !== '') {
    pidNote += ' · 该进程还没有带 pid 的样本（重启后新写的样本才会带）';
  }

  const out = await auditRows({ rows, episodes, loadEvents: makeLogLoader({ home: HOME }), window, textCheck });

  if (argv.includes('--json')) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    const pct = (n) => (out.refs ? `${((n / out.refs) * 100).toFixed(1)}%` : '-');
    if (textCheck) {
      // T239：四态分列（ok / offset / unreadable / notFound）+ 中位距离 + 占比
      const ratio = (n) => (out.a6Denominator ? `${((n / out.a6Denominator) * 100).toFixed(1)}%` : '-');
      console.log(`样本 ${out.samples} 张 · 引用 ${out.refs} 条 · A6 分母 ${out.a6Denominator}（= 引用 − unreadable ${out.textUnreadable}）`);
      console.log(`  ok ${out.textOk} · offset ${out.textOffset}（近 ${out.textOffsetNear} / 远 ${out.textOffsetFar}，占比 ${ratio(out.textOffset)}，中位距离 ${out.offsetDistanceMedian ?? 'n/a'}）· unreadable ${out.textUnreadable} · notFound ${out.textNotFound}（真找不到，占比 ${ratio(out.textNotFound)}）· joined ${out.textJoined ?? 0} · 日期一致 ${out.dateOk}/${out.refs}${pidNote ? ' ' + pidNote : ''}`);
      console.log(`（引用层：可回溯 ${out.okRefs}/${out.refs}（${pct(out.okRefs)}，弱判据）· 同作用域 ${out.sameScopeRefs} · 跨作用域 ${out.crossScopeRefs} · window=±${out.window}）`);
      const gap = out.details.flatMap((d) => d.verdicts)
        .filter((v) => v.distance != null && v.distance > out.window && v.distance <= 10).length;
      if (gap > 0) {
        console.log(`（提示：另有 ${gap} 条落在 ±${out.window + 1}~±10 —— 这是"调用步 → 工具结果"的自然间隔，不是错位；可用 --window 10 复核）`);
      }
    } else {
      console.log(`样本 ${out.samples} 张 · 引用 ${out.refs} 条 · 可回溯 ${out.okRefs}（${pct(out.okRefs)}）· 同作用域 ${out.sameScopeRefs} · 跨作用域 ${out.crossScopeRefs} · 文字层已跳过（--no-text）${pidNote ? ' ' + pidNote : ''}`);
    }
    for (const d of out.details) {
      const extra = textCheck
        ? ` ok=${d.textOk} offset=${d.textOffset} unreadable=${d.textUnreadable} notFound=${d.textNotFound} joined=${d.textJoined ?? 0} 日期ok=${d.dateOk}/${d.refs}`
        : '';
      console.log(`- ${new Date(d.at).toLocaleString()} ${String(d.scope).slice(-24)} tokens=${d.tokens} refs=${d.refs} ok=${d.ok}${extra}`);
    }
  }
  return out.exitCode;
}

const invokedDirectly = (() => {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => { console.error(`审计失败：${String(error?.message ?? error)}`); process.exit(2); });
}

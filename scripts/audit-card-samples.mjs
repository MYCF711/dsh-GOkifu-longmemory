#!/usr/bin/env node
// 注入卡片抽查（M4，2026-11-04；2026-11-04 二次升级：文字级判据）
//
// 读 <store>/card-samples.jsonl，逐条核对卡片里每个 (ep, seq)：
//   1) 引用层（旧判据，保留）：ep 存在 + seq 落在该局 closure 内 + ep 属于卡片 scope；
//   2) 文字层（新默认）：卡上那一段正文是否**真的出现在该局的事件文本里**，三档
//        at-seq   —— 在该 seq ±window（默认 3）个事件内出现；
//        elsewhere —— 只在该局别处出现（给出最近 seq 与距离）；
//        missing  —— 该局完全没有这段文字；
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
export function eventsToBlobs(events) {
  return (Array.isArray(events) ? events : [])
    .map((ev) => ({
      seq: Number(ev?.seq),
      time: Number.isFinite(ev?.time) ? Number(ev.time) : null,
      // 每个字符串先 singleLine：多行错误原文（含换行/缩进）不归一的话，卡片正文（已单行化）会假阳成 missing。
      // 不同字符串之间用换行分隔 —— 一条正文不会跨两个字符串，所以拼接不会制造假阳。
      blob: collectStrings(ev?.data ?? ev ?? {}).map((s) => singleLine(s)).filter(Boolean).join('\n'),
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
  if (!best) return { verdict: 'missing', nearestSeq: null, distance: null };
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
        // 读不到原件（日志缺失/解析失败）⇒ fail-closed：记 missing，不假装合规。
        verdicts.push({ ...base, verdict: 'missing', nearestSeq: null, distance: null, dateVerdict: 'no-event', eventDate: null });
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
      textAtSeq: count((v) => v.verdict === 'at-seq'),
      textElsewhere: count((v) => v.verdict === 'elsewhere'),
      textMissing: count((v) => v.verdict === 'missing'),
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
  return {
    samples: details.length,
    refs: totalRefs,
    okRefs,
    traceableRate: totalRefs ? okRefs / totalRefs : null,
    sameScopeRefs,
    crossScopeRefs: totalRefs - sameScopeRefs,
    textAtSeq: sum('textAtSeq'),
    textElsewhere: sum('textElsewhere'),
    textMissing: sum('textMissing'),
    dateOk: sum('dateOk'),
    dateBad: sum('dateBad'),
    textCheck,
    window,
    details,
    // 退出码判据：文字层 missing 或 日期不一致 ⇒ 1；--no-text 退回旧口径。
    exitCode: textCheckFailed
      ? ((sum('textMissing') > 0 || sum('dateBad') > 0) ? 1 : 0)
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
  const pidWant = Number(opt('pid', '0'));
  if (Number.isFinite(pidWant) && pidWant > 0) rows = rows.filter((r) => Number(r.pid) === pidWant);

  const out = await auditRows({ rows, episodes, loadEvents: makeLogLoader({ home: HOME }), window, textCheck });

  if (argv.includes('--json')) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    const pct = (n) => (out.refs ? `${((n / out.refs) * 100).toFixed(1)}%` : '-');
    if (textCheck) {
      console.log(`样本 ${out.samples} 张 · 引用 ${out.refs} 条 · at-seq ${out.textAtSeq} · elsewhere ${out.textElsewhere} · missing ${out.textMissing} · 日期一致 ${out.dateOk}/${out.refs}`);
      console.log(`（引用层：可回溯 ${out.okRefs}/${out.refs}（${pct(out.okRefs)}，弱判据）· 同作用域 ${out.sameScopeRefs} · 跨作用域 ${out.crossScopeRefs} · window=±${out.window}）`);
      const gap = out.details.flatMap((d) => d.verdicts)
        .filter((v) => v.distance != null && v.distance > out.window && v.distance <= 10).length;
      if (gap > 0) {
        console.log(`（提示：另有 ${gap} 条落在 ±${out.window + 1}~±10 —— 这是"调用步 → 工具结果"的自然间隔，不是错位；可用 --window 10 复核）`);
      }
    } else {
      console.log(`样本 ${out.samples} 张 · 引用 ${out.refs} 条 · 可回溯 ${out.okRefs}（${pct(out.okRefs)}）· 同作用域 ${out.sameScopeRefs} · 跨作用域 ${out.crossScopeRefs} · 文字层已跳过（--no-text）`);
    }
    for (const d of out.details) {
      const extra = textCheck
        ? ` at-seq=${d.textAtSeq} elsewhere=${d.textElsewhere} missing=${d.textMissing} 日期ok=${d.dateOk}/${d.refs}`
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

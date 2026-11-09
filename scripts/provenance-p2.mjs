#!/usr/bin/env node
// P2「可重算」体检（T232）：**claim.support[].quote 必须是该 (episode, seq) 原文的逐字子串**。
//
// 为什么需要它（`docs/调研/52` 的 P1/P2/P3）：
//   · P1 可解析 —— episode 存在、seq 在区间内、quote 非空          ← 已有（audit-card-samples）
//   · P2 可重算 —— quote 是该 (ep, seq) 原文的**逐字子串**          ← **本脚本**
//   · P3 可复核 —— 只吃 sidecar + 日志就能独立算回来
// 缺 P2 的后果：指针格式正确、却指向错的位置时，审计看不见 ——
// 2026-11-05 的 `(ep-62bcb7d2, seq 5736)` 就是写库四小时后才被随机抽样撞见的。
//
// 三态（fail-closed，未知 ≠ 没问题）：
//   ok                    quote 是原文的子串
//   quote-not-substring   P2 失败：原文读到了，但 quote 不是它的子串（指针还在，指错了）
//   seq-unreadable        原文不可达（episode 不在库/日志缺失/该 seq 不存在）—— **单列，不算 ok**
//
// 只读：不写库、不写 <DSH_HOME>；唯一写入口是 `--evidence`。
//
// 用法：
//   node scripts/provenance-p2.mjs                     # 全库体检（人类可读汇总）
//   node scripts/provenance-p2.mjs --json              # 机器可读（含逐条 not-substring）
//   node scripts/provenance-p2.mjs --ep ep-62bcb7d2 --seq 5736   # 只看某一条（打逐字对照）
//   node scripts/provenance-p2.mjs --limit 200         # 只查前 N 条 claim（抽样）
//   node scripts/provenance-p2.mjs --evidence evidence/T232-p2.md
//
// 退出码：0 全部 ok；1 存在 not-substring 或 unreadable（fail-closed）。

import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../src/rooms/persist.mjs';
import { readFrames, parseEvents } from '../src/rooms/logread.mjs';
import { pathToFileURL } from 'node:url';

const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';

/**
 * **诊断专用**（不参与判定）：把连续空白折成单空格。
 * 抽取时会把多行输出单行化，所以"原文在、只是换行没了"要用这个变体才看得出来。
 */
export function collapseWhitespace(value) {
  return normalizeText(value)
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/** 归一化规则（写进输出，可复核）：只做"渲染等价"的替换，不做内容改写。 */

export const NORMALIZE_RULES = Object.freeze([
  'CRLF(U+000D U+000A) / 裸 CR(U+000D) → LF',
  'NBSP(U+00A0) → 空格(U+0020)',
  'ZWSP(U+200B) 删除',
  // T70（2026-11-09）：**连续空白折叠成单个空格**。
  // 依据：`support.quote` 是**单行视图** —— 生成侧 `clipQuote()` 明确把空白折叠成 ' '（卡片只能单行）。
  // 拿它跟多行日志做"逐字节子串"比较等于两套口径互判：实测 3565 条失败里 **1223 条（34%）** 只差空白。
  '连续空白折叠为单空格（引文是单行视图，生成侧 clipQuote 会折叠）',
]);

/** 归一化：NBSP/CRLF/ZWSP 三类"渲染看不见却让子串判定失败"的差异。 */
export function normalizeText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')   // T70：引文是单行视图，比对必须同口径（见 NORMALIZE_RULES）
    .trim();
}

/** 递归收集对象里的全部字符串（不用 JSON.stringify：避免把 `"` 转义成 `\"` 造成假阴）。 */
export function collectStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out); return out; }
  if (typeof value === 'object') { for (const v of Object.values(value)) collectStrings(v, out); }
  return out;
}

/**
 * 事件数组 → `Map<seq, { text, segments }>`（都**已归一化**）。
 * `text` = 该事件全部字符串按 `\n` 连接（= 该 seq 的"原文"）；
 * `segments` = 单段原文（用于区分"跨段拼接"的命中）。
 */
export function indexEvents(events) {
  const map = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    const seq = Number(ev?.seq);
    if (!Number.isFinite(seq)) continue;
    const segments = collectStrings(ev?.data ?? ev ?? {}).map(normalizeText).filter((s) => s !== '');
    if (!segments.length) continue;
    const prev = map.get(seq);
    const merged = prev ? [...prev.segments, ...segments] : segments;
    // T70：跨段拼接也用**单空格**（与归一化后的引文同口径）。
    // 原来用 `\n` 拼 ⇒ 跨两段的引文（如 "bar\nbaz"）归一化后是 "bar baz"，永远对不上。
    map.set(seq, { text: normalizeText(merged.join(' ')), segments: merged });
  }
  return map;
}

/**
 * 第一个不同处：把 quote 对齐到 blob 上，返回 `{ index, expected, actual }`（供证据里逐字对照）。
 * 对不齐（quote 的开头就不在 blob 里）⇒ 返回 `{ index: 0, expected: blob[0], actual: quote[0], unaligned: true }`。
 */
export function firstDifference(quote, blob, { anchor = 16 } = {}) {
  const q = normalizeText(quote);
  const b = normalizeText(blob);
  if (q === '' || b === '') return null;
  const head = q.slice(0, Math.min(anchor, q.length));
  let at = b.indexOf(head);
  if (at < 0) {
    // 退一步：用最长公共前缀定位（前 8 字符）
    const short = q.slice(0, Math.min(8, q.length));
    at = short.length ? b.indexOf(short) : -1;
    if (at < 0) return { index: 0, expected: b[0] ?? null, actual: q[0] ?? null, unaligned: true };
  }
  for (let k = 0; k < q.length; k += 1) {
    if (b[at + k] !== q[k]) {
      return { index: at + k, expected: b[at + k] ?? null, actual: q[k] ?? null, offset: at };
    }
  }
  return null; // 其实是子串
}

/**
 * 单条引用的 P2 判定（纯函数，事件用 `eventIndex` 注入 ⇒ 可测）。
 *
 * @param {{quote:string, seq:number, eventIndex:Map<number,{text:string,segments:string[]}>}} p
 * @returns {{verdict:'ok'|'quote-not-substring'|'seq-unreadable', matchedBy:'event'|'segment'|null,
 *            diff:{index:number,expected:string|null,actual:string|null}|null, reason:string|null}}
 */
export function checkQuoteAtSeq({ quote, seq, eventIndex }) {
  const needle = normalizeText(quote);
  if (needle === '') {
    return { verdict: 'seq-unreadable', matchedBy: null, diff: null, reason: 'quote-empty' };
  }
  const key = Number(seq);
  const hit = eventIndex?.get?.(key);
  if (!hit) return { verdict: 'seq-unreadable', matchedBy: null, diff: null, reason: `seq-not-found:${seq}` };
  if (hit.text.includes(needle)) return { verdict: 'ok', matchedBy: 'event', diff: null, reason: null };
  for (const seg of hit.segments) {
    if (seg.includes(needle)) return { verdict: 'ok', matchedBy: 'segment', diff: null, reason: null };
  }
  return { verdict: 'quote-not-substring', matchedBy: null, diff: firstDifference(needle, hit.text), reason: 'not-substring' };
}

/** 真实日志读取器：episode → events（找不到就返回 null ⇒ 调用方判 seq-unreadable）。 */
export function makeLogLoader({ home = HOME } = {}) {
  return async (episodeId, ep) => {
    const logPath = ep?.closure?.logPath;
    if (!logPath) return null;
    const abs = path.isAbsolute(logPath) ? logPath : path.join(home, logPath);
    if (!fs.existsSync(abs)) return null;
    const buf = fs.readFileSync(abs);
    const framesRes = readFrames(buf);
    const frames = Array.isArray(framesRes) ? framesRes : framesRes?.frames;
    const parsed = parseEvents(frames ?? []);
    return parsed?.events ?? null;
  };
}

/** 汇总一行（格式固定，守卫测试会断言它）。 */
export function formatSummary(stats) {
  // 有 breakdown 时把它带在尾巴上：一个 3565 看不出该改哪一侧（T70）
  if (stats?.breakdown) {
    const base = `claims ${stats.claims} · refs ${stats.refs} · ok ${stats.ok} · not-substring ${stats.notSubstring} · unreadable ${stats.unreadable}`;
    return `${base} · 其中：位置偏 ${stats.breakdown.offset} · 本局没有 ${stats.breakdown.absent}`;
  }
  return `claims ${stats.claims} · refs ${stats.refs} · ok ${stats.ok} · not-substring ${stats.notSubstring} · unreadable ${stats.unreadable}`;
}

/**
 * 主判定（纯逻辑；`loadEvents` 注入，便于测试）。
 *
 * @param {object} p
 * @param {Array} p.claims                   claim 记录数组
 * @param {Map<string,object>} p.episodes    id → episode 记录
 * @param {Function} p.loadEvents            async (episodeId, ep) => events[]|null
 * @param {{limit?:number, only?:{ep?:string, seq?:number}|null}} [p.opts]
 * @returns {Promise<{stats:object, refs:Array, failures:Array, unreadableRefs:Array}>}
 */
export async function auditP2({ claims, episodes, loadEvents, opts = {} } = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : Infinity;
  const only = opts.only ?? null;
  const refs = [];

  // 按 episode **分组**处理：一个 episode 的 index 读完就丢。
  // 之前把 89 局 × 上万条事件的文本全留在内存里 → V8 OOM（2026-11-05 实测崩在第 62 秒）。
  const pending = new Map(); // episodeId → [{claimId, seq, quote}]
  for (const claim of (Array.isArray(claims) ? claims : []).slice(0, limit)) {
    const support = Array.isArray(claim?.support) ? claim.support : [];
    for (const src of support) {
      const episode = src?.episode ?? null;
      const seq = Number(src?.seq);
      const quote = typeof src?.quote === 'string' ? src.quote : '';
      if (only && (only.ep ? String(episode) !== String(only.ep) : false)) continue;
      if (only && Number.isFinite(only.seq) && Number(seq) !== Number(only.seq)) continue;
      const key = episode ?? '\u0000none';
      if (!pending.has(key)) pending.set(key, []);
      pending.get(key).push({ claimId: claim?.id ?? null, episode, seq, quote });
    }
  }

  for (const [key, group] of pending) {
    let index = null;
    if (key !== '\u0000none') {
      const ep = episodes?.get?.(key) ?? null;
      let events = null;
      try {
        events = ep ? (await loadEvents(key, ep)) : null;
      } catch {
        events = null;
      }
      index = events ? indexEvents(events) : null;
    }
    for (const item of group) {
      const { claimId, episode, seq, quote } = item;
      const verdict = index
        ? checkQuoteAtSeq({ quote, seq, eventIndex: index })
        : { verdict: 'seq-unreadable', matchedBy: null, diff: null, reason: episode ? 'episode-unreadable' : 'no-episode' };
      const row = { claimId, episode, seq, quote, ...verdict };
      if (verdict.verdict === 'quote-not-substring' && index) {
        // 诊断（不改判定）：这条引文在本局**别处**能不能找到？差多远？是不是只差换行？
        // 折叠文本按事件缓存（每个事件只算一次），否则 20k 事件 × 2.4k 引用的正则会跑几十分钟。
        const q = normalizeText(quote);
        const qc = collapseWhitespace(quote);
        const collapsedOf = (hit) => {
          if (hit.__collapsed === undefined) hit.__collapsed = collapseWhitespace(hit.text);
          return hit.__collapsed;
        };
        let strictNear = null;
        for (const [s2, hit] of index) {
          if (!hit.text.includes(q)) continue;
          const d = Math.abs(Number(s2) - Number(seq));
          if (!strictNear || d < strictNear.distance) strictNear = { seq: s2, distance: d };
        }
        let collapsedNear = null;
        if (qc) {
          for (const [s2, hit] of index) {
            if (hit.text.includes(q)) continue; // 逐字命中的那些归 strictNear，不重复算
            if (!collapsedOf(hit).includes(qc)) continue;
            const d = Math.abs(Number(s2) - Number(seq));
            if (!collapsedNear || d < collapsedNear.distance) collapsedNear = { seq: s2, distance: d };
          }
        }
        row.diagnosis = { strictNear, collapsedNear };
      }
      refs.push(row);
    }
  }
  const failures = refs.filter((r) => r.verdict === 'quote-not-substring');
  const unreadableRefs = refs.filter((r) => r.verdict === 'seq-unreadable');
  // 诊断（**不改变判定**）：P2 失败的那些，引文在本局别处能不能找到？
  //   这决定了归因方向：是"指针指错了位置"，还是"内容根本不是这一局的"。
  const distanceBuckets = { '0': 0, '1-4': 0, '5-20': 0, '21+': 0 };
  let elsewhereStrict = 0;
  let elsewhereCollapsedOnly = 0;
  let notFoundAnywhere = 0;
  for (const f of failures) {
    const near = f.diagnosis?.strictNear ?? null;
    const cnear = f.diagnosis?.collapsedNear ?? null;
    if (near) elsewhereStrict += 1;
    else if (cnear) elsewhereCollapsedOnly += 1;
    else notFoundAnywhere += 1;
    const d = (near ?? cnear)?.distance;
    if (Number.isFinite(d)) {
      if (d === 0) distanceBuckets['0'] += 1;
      else if (d <= 4) distanceBuckets['1-4'] += 1;
      else if (d <= 20) distanceBuckets['5-20'] += 1;
      else distanceBuckets['21+'] += 1;
    }
  }
  const stats = {
    claims: new Set(refs.map((r) => r.claimId)).size,
    refs: refs.length,
    ok: refs.filter((r) => r.verdict === 'ok').length,
    notSubstring: failures.length,
    unreadable: unreadableRefs.length,
    normalizeRules: [...NORMALIZE_RULES],
    // T70：把 3565 拆成**可解释的两锅**，别让一个数糊住归因方向
    //   · offset：引文在本局别处（多半是 ±2/±4 —— 动作事件 vs 结果事件，T69 已在生成侧修掉）
    //   · absent：本局根本没有这段文字（改写/截断/跨局）
    breakdown: { offset: elsewhereStrict + elsewhereCollapsedOnly, absent: notFoundAnywhere },
    diagnosis: { elsewhereStrict, elsewhereCollapsedOnly, notFoundAnywhere, distanceBuckets },
  };
  return { stats, refs, failures, unreadableRefs };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { json: false, evidence: null, limit: null, ep: null, seq: null, storeRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--evidence') out.evidence = argv[++i] ?? null;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--ep') out.ep = argv[++i] ?? null;
    else if (a === '--seq') out.seq = Number(argv[++i]);
    else if (a === '--store') out.storeRoot = argv[++i] ?? null;
  }
  return out;
}

function renderEvidence({ stats, failures, unreadableRefs, focus }) {
  const lines = [];
  lines.push('# T232 · P2「可重算」体检（quote 必须是 (ep, seq) 原文的逐字子串）');
  lines.push('');
  lines.push(`> \`[本] ${new Date().toISOString()}\` · **只读**：不写库；未跑全量测试、未重启 DSH。`);
  lines.push(`> 脚本 \`scripts/provenance-p2.mjs\` · 单测 \`test/provenance-p2.test.mjs\` · 判据来源 \`docs/调研/52\`（P1/P2/P3）`);
  lines.push('');
  lines.push('## 0 · 一句话');
  lines.push('');
  const rate = stats.refs ? ((stats.ok / stats.refs) * 100).toFixed(2) : 'n/a';
  lines.push(`**真库 P2 通过率 ${rate}%**（${stats.ok} / ${stats.refs} 条引用逐字命中原文）；`
    + `not-substring ${stats.notSubstring} 条、unreadable ${stats.unreadable} 条。`);
  lines.push('');
  lines.push('## 1 · 汇总（原样）');
  lines.push('');
  lines.push('```');
  lines.push(`归一化：${NORMALIZE_RULES.join(' · ')}`);
  lines.push(formatSummary({ ...stats, notSubstring: stats.notSubstring, unreadable: stats.unreadable }));
  lines.push('```');
  lines.push('');
  lines.push('三态口径：`ok` = quote 是原文子串；`quote-not-substring` = 原文读到了但 quote 不是它的子串（**指针指错**）；'
    + '`seq-unreadable` = 原文不可达（episode/日志/该 seq 缺失）—— **单列、不算 ok**（fail-closed）。');
  lines.push('');
  if (stats.diagnosis) {
    const d = stats.diagnosis;
    lines.push('诊断（**不改变判定**，只解释失败长什么样）：');
    lines.push('');
    lines.push(`- 逐字能在本局**别处**找到：**${d.elsewhereStrict}** 条（指针指错了 seq）；`);
    lines.push(`- 只有"空白折叠"后能找到：**${d.elsewhereCollapsedOnly}** 条（原文在，只是抽取时把换行压平了）；`);
    lines.push(`- 本局哪里都找不到：**${d.notFoundAnywhere}** 条（内容与这局对不上，最严重）；`);
    lines.push(`- 距离分布（就近的那条 seq 与本条声明的差）：\`0:${d.distanceBuckets['0']}\` · \`1-4:${d.distanceBuckets['1-4']}\` · \`5-20:${d.distanceBuckets['5-20']}\` · \`21+:${d.distanceBuckets['21+']}\``);
    lines.push('');
    const passRate = stats.refs ? ((stats.ok / stats.refs) * 100).toFixed(2) : 'n/a';
    lines.push('归因（机械推论，不含判断）：');
    lines.push('');
    lines.push(`- **P1 全对**：episode 都在库里、seq 都在闭包区间内、quote 都非空 ⇒ \`unreadable ${stats.unreadable}\`。`
      + '也就是说"指针格式"这一层没有问题。');
    lines.push(`- **P2 只有 ${passRate}%**：\`${stats.notSubstring}\` 条不是该 seq 原文的子串。`
      + `其中 \`${d.elsewhereStrict}\` 条在**本局别的 seq** 能逐字找到、\`${d.elsewhereCollapsedOnly}\` 条只在"空白折叠"后能找到、\`${d.notFoundAnywhere}\` 条本局完全找不到。`);
    lines.push(`- 距离分布里 \`1-4\` 占 \`${d.distanceBuckets['1-4']}\` 条 ⇒ 主因是**偏移几个 seq**（典型：引文取自工具结果事件，seq 却记成了工具调用/助手消息那一格），`
      + '不是"内容不存在"。这正是 T232 要抓的东西：P1 绿而 P2 红，审计此前看不见。');
    lines.push('');
  }
  if (focus) {
    lines.push('## 2 · 逐字对照（今晚那条）');
    lines.push('');
    lines.push(`- claim：\`${focus.claimId ?? '(unknown)'}\` · 引用 \`(${focus.episode}, seq ${focus.seq})\``);
    lines.push(`- 判定：**\`${focus.verdict}\`**${focus.reason ? `（${focus.reason}）` : ''}`);
    if (focus.diagnosis) {
      const sn = focus.diagnosis.strictNear;
      const cn = focus.diagnosis.collapsedNear;
      lines.push(`- 本局**别处**能不能找到这句引文：`
        + `逐字 ${sn ? `\`seq ${sn.seq}\`（差 ${sn.distance}）` : '找不到'}；`
        + `空白折叠后 ${cn ? `\`seq ${cn.seq}\`（差 ${cn.distance}）` : '找不到'}。`);
    }
    if (focus.quote) {
      lines.push('');
      lines.push('卡上引文（claim.support[].quote）：');
      lines.push('');
      lines.push('```');
      lines.push(focus.quote);
      lines.push('```');
    }
    if (focus.original) {
      lines.push('');
      lines.push('该 seq 的原文（会话日志解出，已归一化）：');
      lines.push('');
      lines.push('```');
      lines.push(focus.original.slice(0, 1200) + (focus.original.length > 1200 ? '\n…（截断）' : ''));
      lines.push('```');
    }
    if (focus.diff) {
      lines.push('');
      lines.push(`**第一个不同处**：原文第 ${focus.diff.index} 个字符是 \`${JSON.stringify(focus.diff.expected)}\`，`
        + `引文这里是 \`${JSON.stringify(focus.diff.actual)}\`${focus.diff.unaligned ? '（引文开头在原文里找不到，已按最长前缀对齐）' : ''}。`);
    }
    lines.push('');
  }
  lines.push(`## ${focus ? 3 : 2} · not-substring 逐条清单（${failures.length} 条）`);
  lines.push('');
  if (!failures.length) {
    lines.push('**0 条** —— 本库里读得到的引用，quote 全部是原文的逐字子串。');
  } else {
    for (const f of failures) {
      const d = f.diff ? `；第一个不同处 @${f.diff.index}：原文 \`${JSON.stringify(f.diff.expected)}\` vs 引文 \`${JSON.stringify(f.diff.actual)}\`` : '';
      lines.push(`- \`${f.claimId}\` \`(${f.episode}, seq ${f.seq})\`${d}`);
    }
  }
  lines.push('');
  lines.push(`## ${focus ? 4 : 3} · unreadable 清单（${unreadableRefs.length} 条）`);
  lines.push('');
  if (!unreadableRefs.length) {
    lines.push('**0 条**。');
  } else {
    const byReason = new Map();
    for (const u of unreadableRefs) byReason.set(u.reason, (byReason.get(u.reason) ?? 0) + 1);
    for (const [reason, n] of byReason) lines.push(`- \`${reason}\`：${n} 条`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main(argv) {
  const args = parseArgs(argv);
  const storeRoot = args.storeRoot ? path.resolve(args.storeRoot) : path.join(HOME, 'memory-context');
  const store = createStore({ root: storeRoot });
  const claims = store.list('claims').map((x) => x?.record).filter(Boolean);
  const episodes = new Map(store.list('episodes').map((x) => [x?.record?.id, x?.record]).filter(([id]) => typeof id === 'string'));
  const only = args.ep || Number.isFinite(args.seq) ? { ep: args.ep, seq: args.seq } : null;

  // `--ep/--seq` 只决定"逐字对照"那一段，**不缩小体检范围** —— 否则汇总行会变成 claims 1/refs 1，误导。
  const focusAt = args.ep && Number.isFinite(args.seq) ? { ep: args.ep, seq: args.seq } : null;

  const result = await auditP2({
    claims,
    episodes,
    loadEvents: makeLogLoader({ home: HOME }),
    opts: { limit: args.limit ?? undefined },
  });

  let focus = null;
  if (focusAt) {
    const ref = result.refs.find((r) => String(r.episode) === String(focusAt.ep) && Number(r.seq) === Number(focusAt.seq)) ?? null;
    if (ref) {
      const ep = episodes.get(ref.episode) ?? null;
      const events = await makeLogLoader({ home: HOME })(ref.episode, ep);
      const index = events ? indexEvents(events) : null;
      const hit = index?.get(Number(ref.seq)) ?? null;
      focus = { ...ref, original: hit?.text ?? null };
    } else {
      focus = { claimId: null, episode: focusAt.ep, seq: focusAt.seq, verdict: 'not-in-refs', reason: 'refs 里没有这条引用（可能被 --limit 截断）', original: null };
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ storeRoot, stats: result.stats, failures: result.failures, unreadable: result.unreadableRefs.slice(0, 50), focus }, null, 2));
  } else {
    console.log('P2 · quote 必须是 (ep, seq) 原文的逐字子串');
    console.log(`归一化：${NORMALIZE_RULES.join(' · ')}`);
    console.log(formatSummary(result.stats));
    if (focus) {
      console.log('');
      console.log(`focus: ${focus.claimId} (${focus.episode}, seq ${focus.seq}) ⇒ ${focus.verdict}`);
      if (focus.quote) console.log(`  引文: ${JSON.stringify(focus.quote.slice(0, 200))}`);
      if (focus.original) console.log(`  原文: ${JSON.stringify(focus.original.slice(0, 200))}`);
      if (focus.diff) console.log(`  第一个不同处 @${focus.diff.index}: 原文 ${JSON.stringify(focus.diff.expected)} vs 引文 ${JSON.stringify(focus.diff.actual)}`);
    }
    for (const f of result.failures.slice(0, 20)) {
      console.log(`FAIL ${f.claimId} (${f.episode}, seq ${f.seq})`
        + (f.diff ? ` 不同处@${f.diff.index}: 原文 ${JSON.stringify(f.diff.expected)} vs 引文 ${JSON.stringify(f.diff.actual)}` : ''));
    }
    if (result.failures.length > 20) console.log(`… 还有 ${result.failures.length - 20} 条（--json 看全量）`);
  }

  if (args.evidence) {
    const out = path.resolve(args.evidence);
    fs.writeFileSync(out, renderEvidence({ ...result, focus }), 'utf8');
    if (!args.json) console.log(`evidence: ${path.relative(process.cwd(), out)}`);
  }

  return result.stats.notSubstring > 0 || result.stats.unreadable > 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(`provenance-p2 失败：${String(err?.message ?? err)}`);
    process.exitCode = 2;
  });
}

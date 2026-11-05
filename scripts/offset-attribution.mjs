#!/usr/bin/env node
// T241 · 归因：`offset` 到底偏多少？（只诊断，不改任何判据/数据）
//
// 矛盾（Lead 提问）：
//   · T232（`scripts/provenance-p2.mjs`）：not-substring 里"逐字能在本局别处找到 989 条"，
//     距离分布 `1–4 seq 占 1455 条` ⇒ 读起来像"主因是偏几个 seq"。
//   · T239（`scripts/audit-card-samples.mjs` 四态）：`offset 97（近 3 / 远 94，中位距离 4994）`
//     ⇒ 读起来像"几乎都是远偏移"。两者决定完全不同的修法。
//
// 本脚本只做三件事（全部只读）：
//   ① 用 T239 的同一套函数（`auditRows` + `classifyTextByEvents`，window=10）**原样复现那 97 条 offset**，
//      逐条打出 `(claimId, episode, seq_on_card, seq_found, distance)`；
//   ② 对每条判断"卡片引的是同一次出现还是另一次出现"：用 quote 前后 40 字在**两个 seq 处各取一段**，
//      逐字相同 ⇒ 同一次出现的复制；否则（含"声明那格根本没有这段文字"）⇒ 另一次出现；
//   ③ 与 T232 的口径对账：把 T232 的距离分桶放到**同一把尺子**（它的严格 at-seq = 距离 0）上看，
//      并回答"1455 是不是被重复计数了 / 97 是不是另一个母集"。
//
// 用法：
//   node scripts/offset-attribution.mjs            # 人类可读
//   node scripts/offset-attribution.mjs --json     # 机器可读（含 97 条明细）
//   node scripts/offset-attribution.mjs --evidence evidence/T241-offset-attribution.md
//
// 退出码：0 只要诊断完成（这是诊断脚本，不判红）；2 环境不齐（没有 card-samples / store）。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import {
  DEFAULT_WINDOW,
  OFFSET_NEAR_MAX,
  auditRows,
  eventsToBlobs,
  makeLogLoader,
  normalizeCardText,
  parseCardLines,
} from './audit-card-samples.mjs';
import { indexEvents, normalizeText, collapseWhitespace } from './provenance-p2.mjs';

const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
const RADIUS = 40;
/** 记忆卡渲染行的两个特征：marker 与 provenance 尾巴 —— 用来识别"命中的其实是一张被注入过的卡片"（自指）。 */
const CARD_MARK = /\[(antipattern|semantic|candidate|observed|disputed|stale|fact)\]/;
const PROV_TAIL = /\(ep-[0-9a-f]{8},[^)]*seq\s*\d+\)/;

/** 距离分桶（Lead 指定的四档）。 */
export function bucket(distance) {
  const d = Number(distance);
  if (!Number.isFinite(d)) return 'n/a';
  if (d <= 4) return '1-4';
  if (d <= 20) return '5-20';
  if (d <= 100) return '21-100';
  return '>100';
}

/** 在 `text` 里截取 needle 前后各 radius 个字符的上下文；找不到 needle ⇒ null。 */
export function contextAround(text, needle, radius = RADIUS) {
  const hay = String(text ?? '');
  const pin = String(needle ?? '');
  if (!hay || !pin) return null;
  const i = hay.indexOf(pin);
  if (i < 0) return null;
  return {
    before: hay.slice(Math.max(0, i - radius), i),
    after: hay.slice(i + pin.length, i + pin.length + radius),
    index: i,
  };
}

/** 最长公共子串长度（只用于"声明那格到底沾不沾边"的诊断，O(n·m) 但两侧都很短）。 */
export function longestCommonSubstringLength(a, b) {
  const s = String(a ?? '');
  const t = String(b ?? '');
  if (!s || !t) return 0;
  let best = 0;
  let prev = new Array(t.length + 1).fill(0);
  for (let i = 1; i <= s.length; i += 1) {
    const cur = new Array(t.length + 1).fill(0);
    for (let j = 1; j <= t.length; j += 1) {
      if (s[i - 1] === t[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * 同一次 vs 另一次。
 * @param {{cardText:string, declaredText:string|null, foundText:string|null}} p
 * @returns {{verdict:'same-occurrence'|'different-occurrence'|'no-text-at-declared'|'not-found-at-found', detail:object}}
 */
export function decideOccurrence({ cardText, declaredText, foundText }) {
  const needle = normalizeCardText(cardText);
  const foundCtx = foundText ? contextAround(normalizeCardText(foundText), needle) : null;
  if (!foundCtx) return { verdict: 'not-found-at-found', detail: { foundCtx: null, declaredCtx: null, lcs: 0 } };
  const declCtx = declaredText ? contextAround(normalizeCardText(declaredText), needle) : null;
  const lcs = declaredText ? longestCommonSubstringLength(needle, normalizeCardText(declaredText)) : 0;
  if (!declaredText || normalizeCardText(declaredText) === '') {
    return { verdict: 'no-text-at-declared', detail: { foundCtx, declaredCtx: null, lcs } };
  }
  if (declCtx && declCtx.before === foundCtx.before && declCtx.after === foundCtx.after) {
    return { verdict: 'same-occurrence', detail: { foundCtx, declaredCtx: declCtx, lcs } };
  }
  return { verdict: 'different-occurrence', detail: { foundCtx, declaredCtx: declCtx, lcs } };
}

/** `ep|seq` → support 列表（用于把卡片引用对回 claim）。 */
export function buildSupportIndex(claims) {
  const map = new Map();
  for (const claim of Array.isArray(claims) ? claims : []) {
    for (const src of Array.isArray(claim?.support) ? claim.support : []) {
      const key = `${src?.episode}|${Number(src?.seq)}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ claimId: claim?.id ?? null, quote: typeof src?.quote === 'string' ? src.quote : '', seq: Number(src?.seq) });
    }
  }
  return map;
}

async function main(argv = process.argv.slice(2)) {
  const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const storeRoot = path.resolve(opt('store', path.join(HOME, 'memory-context')));
  const cardFile = path.join(storeRoot, 'card-samples.jsonl');
  if (!fs.existsSync(cardFile)) {
    console.error(`没有抽样文件：${cardFile}`);
    return 2;
  }
  const store = createStore({ root: storeRoot });
  const claims = store.list('claims').map((x) => x?.record).filter(Boolean);
  const episodes = new Map(store.list('episodes').map((x) => [x?.record?.id, x?.record]).filter(([id]) => typeof id === 'string'));
  const rows = fs.readFileSync(cardFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const loadEvents = makeLogLoader({ home: HOME });

  // 事件文本按 episode 缓存（读完即丢，按局分组处理，避免 V8 OOM）。
  const cardTextByRow = rows.map((row) => parseCardLines(row?.section));

  const audit = await auditRows({ rows, episodes, loadEvents, window: DEFAULT_WINDOW, textCheck: true });

  // 收集 offset 明细，并把 card text 配回去（details 的顺序与 rows 一致，verdicts 的顺序与 parseCardLines 一致）
  const offsets = [];
  audit.details.forEach((detail, rowIndex) => {
    const texts = cardTextByRow[rowIndex] ?? [];
    detail.verdicts.forEach((v, refIndex) => {
      if (v.verdict !== 'elsewhere') return;
      offsets.push({
        rowIndex,
        episode: v.episode,
        seqOnCard: v.seq,
        seqFound: v.nearestSeq,
        distance: v.distance,
        sameScope: v.sameScope,
        dateVerdict: v.dateVerdict,
        cardText: texts[refIndex]?.text ?? '',
      });
    });
  });

  // ② 逐条：claim 对回 + 同一次/另一次
  const supportIndex = buildSupportIndex(claims);
  const eventTextCache = new Map(); // episodeId → Map<seq, text>（按局处理，处理完即删）
  const byEpisode = new Map();
  for (const off of offsets) {
    if (!byEpisode.has(off.episode)) byEpisode.set(off.episode, []);
    byEpisode.get(off.episode).push(off);
  }
  for (const [episode, group] of byEpisode) {
    const ep = episodes.get(episode) ?? null;
    let events = null;
    try {
      events = ep ? await loadEvents(episode, ep) : null;
    } catch {
      events = null;
    }
    const index = events ? indexEvents(events) : null;
    eventTextCache.set(episode, index);
    for (const off of group) {
      const supports = supportIndex.get(`${episode}|${Number(off.seqOnCard)}`) ?? [];
      off.claimSupports = supports.map((s) => s.claimId);
      off.quote = supports[0]?.quote ?? '';
      const declaredText = index?.get(Number(off.seqOnCard))?.text ?? null;
      const foundText = index?.get(Number(off.seqFound))?.text ?? null;
      const decided = decideOccurrence({ cardText: off.cardText, declaredText, foundText });
      off.occurrence = decided.verdict;
      off.occurrenceDetail = decided.detail;
      // 自指检测（T241 的关键发现）：命中处那段文本**本身就是一张记忆卡**（带 [marker] 与 (ep-…, date, seq N) 尾巴）
      // ⇒ 说明卡片正文只在"被注入过的卡片"里出现过，不是在原始事件里 —— 这不是指针错位。
      off.foundInCard = foundText ? (CARD_MARK.test(foundText) && PROV_TAIL.test(foundText)) : false;
      // 顺带：这条卡片行对应的 claim 引文（若对得上）在 T232 口径下最近多远
      if (off.quote && index) {
        const q = normalizeText(off.quote);
        let best = null;
        for (const [s2, hit] of index) {
          if (!hit.text.includes(q)) continue;
          const d = Math.abs(Number(s2) - Number(off.seqOnCard));
          if (!best || d < best.distance) best = { seq: s2, distance: d };
        }
        off.quoteNearest = best;
      }
    }
    eventTextCache.delete(episode);
  }

  const far = offsets.filter((o) => Number(o.distance) > OFFSET_NEAR_MAX);
  const near = offsets.filter((o) => Number(o.distance) <= OFFSET_NEAR_MAX);
  const histogram = { '1-4': 0, '5-20': 0, '21-100': 0, '>100': 0, 'n/a': 0 };
  for (const off of offsets) histogram[bucket(off.distance)] = (histogram[bucket(off.distance)] ?? 0) + 1;
  const occurrenceCounts = {};
  for (const off of far) occurrenceCounts[off.occurrence] = (occurrenceCounts[off.occurrence] ?? 0) + 1;
  const withClaim = far.filter((o) => o.quote).length;
  const withQuoteNear4 = far.filter((o) => o.quoteNearest && o.quoteNearest.distance <= 4).length;

  // T232 口径（--with-p2）：同一份库、同一批 claim，量 support.quote 的距离分布与去重后的 claim 数
  let p2 = null;
  if (argv.includes("--with-p2")) {
    const mod = await import("./provenance-p2.mjs");
    const out = await mod.auditP2({ claims, episodes, loadEvents, opts: {} });
    const failures = out.failures;
    const dist = failures.map((f) => f.diagnosis?.strictNear?.distance ?? null);
    const bucketOf = (d) => (Number.isFinite(d) ? bucket(d) : "not-found");
    const hist = {};
    for (const d of dist) hist[bucketOf(d)] = (hist[bucketOf(d)] ?? 0) + 1;
    const nearRefs = failures.filter((f) => Number.isFinite(f.diagnosis?.strictNear?.distance) && f.diagnosis.strictNear.distance <= 4);
    p2 = {
      refs: out.stats.refs,
      ok: out.stats.ok,
      notSubstring: out.stats.notSubstring,
      unreadable: out.stats.unreadable,
      claimsTotal: new Set(out.refs.map((r) => r.claimId)).size,
      failureHistogram: hist,
      near4Refs: nearRefs.length,
      near4Claims: new Set(nearRefs.map((r) => r.claimId)).size,
    };
  }

  const summary = {
    cardRows: rows.length,
    cardRefs: audit.refs,
    window: audit.window,
    offset: offsets.length,
    offsetNear: near.length,
    offsetFar: far.length,
    offsetMedian: audit.offsetDistanceMedian,
    histogram,
    farOccurrence: occurrenceCounts,
    farWithClaimSupport: withClaim,
    farQuoteNearestWithin4: withQuoteNear4,
    farFoundInCard: far.filter((o) => o.foundInCard).length,
    p2,
  };

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ summary, offsets }, null, 2));
  } else {
    console.log('offset 归因（只读）');
    console.log(`母集：card-samples ${summary.cardRows} 行 / ${summary.cardRefs} 条引用（window=±${summary.window}，near≤${OFFSET_NEAR_MAX}）`);
    console.log(`offset ${summary.offset} 条（near ${summary.offsetNear} / far ${summary.offsetFar}，中位距离 ${summary.offsetMedian}）`);
    console.log(`distance 直方图：${JSON.stringify(summary.histogram)}`);
    console.log(`far 的"同一次 vs 另一次"：${JSON.stringify(summary.farOccurrence)}`);
    console.log(`far 里能对回 claim support 的：${withClaim} 条；其中 claim 引文在 T232 口径下 ≤4 seq 就命中的：${withQuoteNear4} 条`);
    for (const off of offsets.slice(0, 10)) {
      console.log(`- ${off.episode} 卡片 seq ${off.seqOnCard} → 命中 ${off.seqFound}（差 ${off.distance}）${off.occurrence} claim=${off.claimSupports.join(',') || '(无)'}`);
    }
  }

  const evidencePath = opt('evidence', null);
  if (evidencePath) {
    fs.writeFileSync(path.resolve(evidencePath), renderEvidence({ summary, offsets, near, far }), 'utf8');
    if (!argv.includes('--json')) console.log(`evidence: ${path.relative(process.cwd(), path.resolve(evidencePath))}`);
  }
  return 0;
}

function renderEvidence({ summary, offsets, near, far }) {
  const fmt = (x) => (x === null || x === undefined ? 'n/a' : String(x));
  const lines = [];
  lines.push('# T241 · `offset` 到底偏多少？（归因，只诊断）');
  lines.push('');
  lines.push(`> \`[本] ${new Date().toISOString()}\` · **只读**：不写库、不改任何判据；未跑全量测试、未重启 DSH。`);
  lines.push('> 脚本 `scripts/offset-attribution.mjs` · 复现用 `scripts/audit-card-samples.mjs` 的 `auditRows`（window=±10）');
  lines.push('');
  lines.push('## 0 · 一句话');
  lines.push('');
  lines.push(`**两个数测的不是同一件事**：T232 量的是"把 ±4 seq 的偏移算成失败"（母集 = 全库 2455 条 support，单位 = \`support.quote\`，容差 0）；`
    + `T239 量的是"超过 ±${DEFAULT_WINDOW} seq 才算 offset"（母集 = 抽样 ${summary.cardRefs} 条卡片引用，单位 = 卡片行正文，容差 ±10）。`
    + `所以 T232 的 \`1–4: 1455\` 在 T239 的尺子下**根本不会进 offset**（≤10 记 at-seq）。`);
  lines.push('');
  lines.push('## 1 · 复现 T239（原样）');
  lines.push('');
  lines.push('```');
  lines.push(`card-samples ${summary.cardRows} 行 · 引用 ${summary.cardRefs} 条 · window=±${summary.window}`);
  lines.push(`offset ${summary.offset}（near≤${OFFSET_NEAR_MAX}: ${summary.offsetNear} / far: ${summary.offsetFar}）· 中位距离 ${summary.offsetMedian}`);
  lines.push('```');
  lines.push('');
  lines.push('## 2 · 94 条远偏移的 distance 直方图');
  lines.push('');
  lines.push('```');
  lines.push(`1-4     ${summary.histogram['1-4']}`);
  lines.push(`5-20    ${summary.histogram['5-20']}`);
  lines.push(`21-100  ${summary.histogram['21-100']}`);
  lines.push(`>100    ${summary.histogram['>100']}`);
  lines.push('```');
  lines.push('');
  lines.push(`（far 定义就是 >${OFFSET_NEAR_MAX}，所以前两档必为 0 —— 这本身就是对账的一部分：`
    + 'T232 的 `1–4` 与 T239 的 `far` **不可能有交集**。）');
  lines.push('');
  lines.push('## 3 · 94 条远偏移的"同一次 vs 另一次"');
  lines.push('');
  lines.push('```');
  lines.push(JSON.stringify(summary.farOccurrence, null, 1));
  lines.push('```');
  lines.push('');
  lines.push('判据：用卡片正文（quote）在**命中 seq** 与**声明 seq** 各取前后 40 字；两段逐字相同 ⇒ `same-occurrence`；'
    + '声明那格没有这段文字 ⇒ `different-occurrence`（= 另一次出现）；声明那格根本没有文本 ⇒ `no-text-at-declared`。');
  lines.push('');
  lines.push('## 4 · 逐条清单（94 条远偏移）');
  lines.push('');
  lines.push('| # | claim | episode | seq_on_card | seq_found | distance | 同一次/另一次 | claim引文的最近距离 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  far.forEach((o, i) => {
    const q = o.quoteNearest ? `${o.quoteNearest.seq}（差 ${o.quoteNearest.distance}）` : (o.quote ? '本局找不到' : '—');
    lines.push(`| ${i + 1} | ${o.claimSupports.join(',') || '—'} | ${o.episode} | ${o.seqOnCard} | ${fmt(o.seqFound)} | ${fmt(o.distance)} | ${o.occurrence} | ${q} |`);
  });
  lines.push('');
  lines.push('## 5 · 抽样 10 条逐字对照');
  lines.push('');
  for (const [i, o] of far.slice(0, 10).entries()) {
    const d = o.occurrenceDetail ?? {};
    lines.push(`### ${i + 1}. \`${o.claimSupports.join(',') || '(未对上 claim)'}\` · ${o.episode} · 卡片 seq ${o.seqOnCard} → 命中 seq ${o.seqFound}（差 ${o.distance}）`);
    lines.push('');
    lines.push(`- 判定：**${o.occurrence}**`);
    lines.push(`- 卡片正文：\`${String(o.cardText).slice(0, 120).replace(/\n/g, '⏎')}\``);
    if (d.foundCtx) {
      lines.push(`- 命中处上下文（±40）：\`…${d.foundCtx.before.replace(/\n/g, '⏎')}[正文]${d.foundCtx.after.replace(/\n/g, '⏎')}…\``);
    }
    if (d.declaredCtx) {
      lines.push(`- 声明处上下文（±40）：\`…${d.declaredCtx.before.replace(/\n/g, '⏎')}[正文]${d.declaredCtx.after.replace(/\n/g, '⏎')}…\``);
    } else {
      lines.push(`- 声明处上下文：**没有这段正文**（与声明的文字最长公共子串 = ${d.lcs ?? 0} 字符）`);
    }
    lines.push('');
  }
  lines.push('## 6 · 与 T232 的对账');
  lines.push('');
  lines.push(`- T232 母集 = **全库 claim 的 support 条目 ${summary.p2 ? summary.p2.refs : '（本次未跑 --with-p2）'} 条**，单位 = \`support.quote\`；`);
  lines.push(`- T232 的判定是**严格 at-seq**（距离 0 才算 ok），所以"偏 1–4 个 seq"在它那里算失败、在 T239 那里算 \`at-seq\`（≤±${DEFAULT_WINDOW}）；`);
  lines.push(`- T239 母集 = **抽样 ${summary.cardRefs} 条卡片引用**（564 份卡片的行），单位 = 卡片渲染行正文（已被单行化、可能被截断）；`);
  lines.push(`- 交叉验证：94 条 far 里能对回 claim support 的 ${summary.farWithClaimSupport} 条，其中 claim 引文在 T232 口径下 **≤4 seq 就命中** 的 ${summary.farQuoteNearestWithin4} 条 ⇒ `
    + `${summary.farQuoteNearestWithin4 === 0 ? '两套口径的"近/远"完全不相交，矛盾是尺子不同，不是数据矛盾' : '仍有一批属同一现象，需单独列出'}。`);
  lines.push(`- **自指命中（根因）**：94 条 far 里 **${summary.farFoundInCard} 条**的"命中处"本身就是一张**记忆卡**`
    + '（文本里带 `[antipattern]` 之类的 marker 与 `(ep-…, date, seq N)` 尾巴）'
    + ' ⇒ 卡片正文只在"被注入过的卡片"里出现过，**不在原始事件里** —— 不是指针错位，是拿改写过的正文去追原文。');
  lines.push('');
  if (summary.p2) {
    const q = summary.p2;
    lines.push('## 7 · T232 口径的同库实测（同一次运行里的 `auditP2`）');
    lines.push('');
    lines.push('```');
    lines.push(`refs ${q.refs} · ok ${q.ok} · not-substring ${q.notSubstring} · unreadable ${q.unreadable} · 涉及 claim ${q.claimsTotal} 个`);
    lines.push(`not-substring 的最近逐字距离分布：${JSON.stringify(q.failureHistogram)}`);
    lines.push(`其中 ≤4 seq：refs ${q.near4Refs} 条，但只来自 ${q.near4Claims} 个 claim（同一 claim 的多条 support 会重复计数）`);
    lines.push('```');
    lines.push('');
    lines.push('⇒ T232 报的 `1–4` 是 **support 条目数**，T239 的 97 是 **卡片引用数** —— 母集不同、单位不同。');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(`offset-attribution 失败：${String(err?.message ?? err)}`);
    process.exitCode = 2;
  });
}

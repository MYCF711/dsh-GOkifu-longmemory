// R13 gates —— 十道闸的起步（M3：闸 0 时间戳 / 闸 6 预算与省略 / 闸 6b 相关闸 / 边界扫描）
//
// 契约：方案.md §6.3、docs/记忆的职责边界.md §5、docs/数据契约.md §7.2/§7.3、MAINTENANCE.md §三.4。
// 职责：**只判**，不改写、不修复、不重排 —— 输入一张记忆卡，输出 `{ok, errors[]}`。
// 任一失败 ⇒ `ok:false`，errors 逐条列明（gate / code / detail）。
//
// 本轮落地的四道（其余 1/2/2b/3/4/5/7 属 M4，见方案 §6.3；这里只做能**机械判**的那几道）：
//
//   闸 0    时间戳前置：每行有 occurredAt、渲染日期 = occurredAt 的绝对日期（UTC）、
//                        provenance（episode + seq）齐备且与渲染行一致。缺 ⇒ 拒（无源不入、无时不入）。
//   闸 6    预算与省略：indexLine + section ≤ 500 tokens；条数 ≤ 5；provenance 覆盖率 = 1；
//                       省略必须显式（计数 + 去哪取）。
//   闸 6b   相关闸：不命中零注入；每个 hit 必带 `why`（非空）；跳转深度 ≤ 2。
//   边界闸  指令式扫描：`你应该|请|下一步|建议|务必|记得|不要忘记|可以试试` 命中即 error
//                       （方案 §7.2 纪律 1：只陈述事实）；另扫工具治理痕迹（边界 §5 表）。
//
// 纯函数：不读时钟、不读盘、不写盘、不调模型。正则与行格式从 R12 inject 单源引入，避免两处漂移。

import {
  BUDGET_TOKENS,
  ENTRY_LIMIT,
  GOVERNANCE_PATTERNS,
  IMPERATIVE_PATTERNS,
  INDEX_LINE_RE,
  PROVENANCE_LINE_RE,
  estimateTokens,
  formatCardDate,
} from './inject.mjs';

/** 本轮启用的闸（顺序 = 报告顺序）。 */
export const ACTIVE_GATES = Object.freeze(['0', '6', '6b', 'boundary']);

/** 未启用但已在方案里编号的闸（显式列出，避免「静默以为已覆盖」）。 */
export const PENDING_GATES = Object.freeze(['1', '2', '2b', '3', '4', '5', '7']);

export const GATE_DOCS = Object.freeze({
  0: '闸 0 时间戳前置：occurredAt + 绝对日期 + provenance(episode,seq) 齐备（方案 §6.3）',
  6: '闸 6 预算与省略：≤500 tokens、≤5 条、provenance 覆盖率=1、省略显式（方案 §6.3）',
  '6b': '闸 6b 相关闸：不命中零注入、每个 hit 带 why、深度 ≤2（方案 §6.3）',
  boundary: '边界闸：注入文本里不得出现指令式/许可/建议片段（边界 §2/§5）',
});

/**
 * 扫描一段模型可见文本里的指令式片段。
 * @returns {Array<{pattern:string, at:number, excerpt:string}>}
 */
export function auditImperatives(text) {
  const s = String(text ?? '');
  const out = [];
  if (!s) return out;
  for (const pattern of IMPERATIVE_PATTERNS) {
    let from = 0;
    for (;;) {
      const at = s.indexOf(pattern, from);
      if (at < 0) break;
      const start = Math.max(0, at - 12);
      const end = Math.min(s.length, at + pattern.length + 12);
      out.push({ pattern, at, excerpt: s.slice(start, end).replace(/\s+/g, ' ').trim() });
      from = at + pattern.length;
    }
  }
  return out.sort((a, b) => (a.at - b.at) || String(a.pattern).localeCompare(String(b.pattern)));
}

/** 扫描工具治理痕迹（`permission: allow` 之类本不该出现在记忆卡里）。 */
export function auditGovernance(text) {
  const s = String(text ?? '');
  const out = [];
  for (const re of GOVERNANCE_PATTERNS) {
    const m = re.exec(s);
    if (m) out.push({ pattern: String(re), match: m[0] });
  }
  return out;
}

function sectionLines(section) {
  return String(section ?? '').split('\n');
}

/**
 * 跑闸。**只读卡片 + walk 结果**，不做修复。
 *
 * @param {object}  p
 * @param {object}  p.card          R12 `buildMemoryCard()` 的输出
 * @param {object}  [p.walkResult]  R11 walk 结果（缺省则跳过闸 6b 的「命中/深度」检查，只查卡片自身）
 * @param {number}  [p.limit]       条数上限（默认 5）
 * @param {number}  [p.budgetTokens] token 预算（默认 500）
 * @returns {{ok:boolean, errors:Array<{gate:string, code:string, detail:any}>, checks:object}}
 */
export function runGates({ card = null, walkResult = null, limit = ENTRY_LIMIT, budgetTokens = BUDGET_TOKENS } = {}) {
  const errors = [];
  const push = (gate, code, detail = null) => errors.push({ gate, code, detail });
  const checks = { claims: 0, lines: 0, tokens: 0, hits: 0, scannedStrings: 0, omitted: 0 };

  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    push('0', 'card/missing', 'runGates 需要 R12 buildMemoryCard() 的 card 对象');
    return { ok: false, errors, checks };
  }

  const claims = Array.isArray(card.claims) ? card.claims : [];
  const section = typeof card.section === 'string' ? card.section : null;
  checks.claims = claims.length;

  // ---------------------------------------------------------------- 闸 0
  const indexLine = typeof card.indexLine === 'string' ? card.indexLine.trim() : '';
  if (!indexLine) push('0', 'gate0/missing-index-line', '首轮那行 INDEX 指针缺失');
  else if (!INDEX_LINE_RE.test(indexLine)) push('0', 'gate0/index-line-shape', { indexLine });

  claims.forEach((c, i) => {
    const claim = c && typeof c === 'object' ? c : {};
    if (!Number.isFinite(claim.occurredAt)) {
      push('0', 'gate0/missing-occurred-at', { index: i, claimId: claim.claimId ?? null, text: typeof claim.text === 'string' ? claim.text.slice(0, 80) : null });
    }
    const src = claim.source && typeof claim.source === 'object' ? claim.source : null;
    if (!src) {
      push('0', 'gate0/missing-provenance', { index: i, text: typeof claim.text === 'string' ? claim.text.slice(0, 80) : null });
    } else {
      if (typeof src.episode !== 'string' || !src.episode) push('0', 'gate0/missing-episode', { index: i });
      if (!Number.isFinite(src.seq)) push('0', 'gate0/missing-seq', { index: i, episode: src.episode ?? null });
    }

    const line = typeof claim.line === 'string' ? claim.line : '';
    const m = PROVENANCE_LINE_RE.exec(line);
    if (!m) {
      push('0', 'gate0/line-not-provenanced', { index: i, line: line || null });
      return;
    }
    const [, , , epId, date, seq] = m;
    if (!Number.isFinite(claim.occurredAt)) return; // 已记 missing-occurred-at
    const expectedDate = formatCardDate(claim.occurredAt);
    if (date !== expectedDate) push('0', 'gate0/date-mismatch', { index: i, rendered: date, expected: expectedDate });
    if (src && typeof src.episode === 'string' && epId !== src.episode) {
      push('0', 'gate0/episode-mismatch', { index: i, rendered: epId, expected: src.episode });
    }
    if (src && Number.isFinite(src.seq) && Number(seq) !== Number(src.seq)) {
      push('0', 'gate0/seq-mismatch', { index: i, rendered: Number(seq), expected: Number(src.seq) });
    }
  });

  if (section !== null) {
    const trimmed = section.trim();
    if (!trimmed.startsWith('<memory-ledger>') || !trimmed.endsWith('</memory-ledger>')) {
      push('0', 'gate0/section-shape', '展开段必须是 <memory-ledger>…</memory-ledger>');
    }
    const lines = sectionLines(section);
    const entryLines = lines.filter((l) => l.startsWith('- '));
    checks.lines = entryLines.length;
    if (entryLines.length !== claims.length) {
      push('0', 'gate0/section-line-count', { lines: entryLines.length, claims: claims.length });
    }
    entryLines.forEach((line, i) => {
      if (!PROVENANCE_LINE_RE.test(line)) push('0', 'gate0/section-line-not-provenanced', { index: i, line });
    });
    const stray = lines.filter((l) => l.trim() !== '' && !l.startsWith('<') && !l.startsWith('- ') && !l.startsWith('#') && !l.startsWith('omitted:'));
    if (stray.length) push('0', 'gate0/stray-section-line', { lines: stray.slice(0, 3) });
  } else if (claims.length > 0) {
    push('0', 'gate0/claims-without-section', { claims: claims.length });
  }

  // ---------------------------------------------------------------- 闸 6（预算与省略）
  if (!Number.isFinite(card.tokens)) {
    push('6', 'gate6/missing-tokens', 'card.tokens 必须是数字（预算要有可核的数）');
  } else {
    checks.tokens = card.tokens;
    const recomputed = estimateTokens(stringOf(card.indexLine)) + estimateTokens(section ?? '');
    if (card.tokens !== recomputed) push('6', 'gate6/token-mismatch', { declared: card.tokens, recomputed });
    if (card.tokens > budgetTokens) push('6', 'gate6/budget-exceeded', { tokens: card.tokens, budget: budgetTokens });
  }
  if (claims.length > limit) push('6', 'gate6/over-limit', { claims: claims.length, limit });

  const covered = claims.filter((c) => c?.source
    && typeof c.source.episode === 'string' && c.source.episode
    && Number.isFinite(c.source.seq)
    && Number.isFinite(c?.occurredAt)).length;
  if (claims.length > 0 && covered !== claims.length) {
    push('6', 'gate6/provenance-coverage', { covered, total: claims.length, rate: covered / claims.length });
  }

  const omittedCount = Number.isFinite(card.omittedCount) ? card.omittedCount : null;
  if (omittedCount !== null) checks.omitted = omittedCount;
  if (omittedCount !== null && omittedCount > 0) {
    const omissions = card.omissions;
    if (typeof omissions !== 'string' || !/omitted:\s*\d+/i.test(omissions)) {
      push('6', 'gate6/omission-hidden', { omittedCount, omissions: typeof omissions === 'string' ? omissions : null });
    } else if (!/index\.md/i.test(omissions)) {
      push('6', 'gate6/omission-no-pointer', { omissions });
    }
  }
  if (typeof card.omissions === 'string' && card.omissions !== '' && !/index\.md/i.test(card.omissions)) {
    push('6', 'gate6/omission-no-pointer', { omissions: card.omissions });
  }

  // ---------------------------------------------------------------- 闸 6b（相关闸）
  let hits = null;
  if (walkResult && typeof walkResult === 'object') {
    hits = Array.isArray(walkResult.hits) ? walkResult.hits : [];
    checks.hits = hits.length;
    const depth = Number.isFinite(walkResult.depth) ? walkResult.depth : (Number.isFinite(walkResult.maxDepth) ? walkResult.maxDepth : 2);
    if (depth > 2) push('6b', 'gate6b/depth-exceeded', { depth, max: 2 });
    if (hits.length === 0 && section !== null) {
      push('6b', 'gate6b/zero-hit-injection', { hits: 0, sectionTokens: estimateTokens(section) });
    }
    if (hits.length === 0 && claims.length > 0) {
      push('6b', 'gate6b/claims-without-hits', { claims: claims.length });
    }
    hits.forEach((h, i) => {
      const why = h?.why;
      const hasWhy = Array.isArray(why)
        ? why.filter((x) => typeof x === 'string' && x.trim() !== '').length > 0
        : (typeof why === 'string' && why.trim() !== '');
      if (!hasWhy) push('6b', 'gate6b/missing-why', { index: i, episode: h?.episode ?? null });
      if (Number.isFinite(h?.depth) && h.depth > 2) push('6b', 'gate6b/hit-depth-exceeded', { index: i, depth: h.depth });
      if (typeof h?.episode !== 'string' || !h.episode) push('6b', 'gate6b/hit-without-episode', { index: i });
    });
  }

  // ---------------------------------------------------------------- 边界闸
  // 只扫**模型可见**的字符串：indexLine + section；claims[].text 若已渲染进 section 就不重复扫
  // （同一段违规只报一次），手工拼的卡（text 未进 section）仍然扫得到。
  const scanned = [];
  if (typeof card.indexLine === 'string') scanned.push(card.indexLine);
  if (section !== null) scanned.push(section);
  for (const c of claims) {
    const text = typeof c?.text === 'string' ? c.text : null;
    if (!text) continue;
    if (section !== null && section.includes(text)) continue;
    scanned.push(text);
  }
  checks.scannedStrings = scanned.length;
  const seen = new Set();
  for (const text of scanned) {
    const key = String(text);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const hit of auditImperatives(text)) {
      push('boundary', 'boundary/imperative', hit);
    }
    for (const hit of auditGovernance(text)) {
      push('boundary', 'boundary/tool-governance', hit);
    }
  }

  return { ok: errors.length === 0, errors, checks };
}

function stringOf(v) {
  return typeof v === 'string' ? v : '';
}

export default {
  ACTIVE_GATES,
  PENDING_GATES,
  GATE_DOCS,
  auditImperatives,
  auditGovernance,
  runGates,
};

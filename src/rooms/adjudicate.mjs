// R10 adjudicate —— 多成员独立解析 + 机械共识（L2）/ 人纠错（L4）
//
// 契约：docs/数据契约.md §4.7（adjudication 记录）、方案.md §5.4（裁决分层与硬要求）、
//       §5.1（「独立」的机械定义）、§6.3 闸 2b（裁决独立性）、边界 §2（人只纠错、不做审批）。
//
// 三条纪律（本文件逐条对应）：
//   1) **机械聚合**：agreement = 多数票 ÷ 有效票；一致度 < threshold ⇒ hold-disputed，
//      **不找"裁判模型"拍板**（方案 §5.4 第 3 条）。本文件不调用任何模型。
//   2) **成员必须独立**（闸 2b）：共享 contextId / sessionId 的票只算一票，其余标
//      `vote/shared-context` 排除 —— 否则就是"同一个人说三遍"（方案 §5.4 第 1 条）。
//   3) **可回放**：同输入同输出（`id` 由输入哈希得到，`at` 由调用方给），
//      `replayAdjudication(record)` 从留档的票重算并比对，篡改一票就能看出来。
//
// 成员**不得直接写记忆**：本房间只产出裁决记录，落账由聚合器（R09/R08 的晋升路径）执行。

import { createHash } from 'node:crypto';

export const ADJUDICATION_VERSION = 1;
export const ADJUDICATION_SCHEMA = 'dsh-gokifu-longmemory/adjudication@1';

/** 成员只能交这三种票（方案 §5.4 第 2 条：结构化输出，不许自由长文）。 */
export const VERDICTS = Object.freeze(['support', 'oppose', 'insufficient']);
/** 裁决结果（契约 §4.7）。 */
export const DECISIONS = Object.freeze(['promote', 'hold-disputed', 'invalidate', 'correct']);
/** 裁决层：L2 多成员独立解析 / L4 人纠错（最高优先级证据）。 */
export const LEVELS = Object.freeze(['L2-multi-member', 'L4-human-correction']);
/** 一致度阈值（方案 §5.4：一致度 < 阈值 ⇒ 转 disputed）。 */
export const DEFAULT_THRESHOLD = 0.6;
/** 成员 reason 的上限（方案 §5.4：reason ≤ 200 字）。 */
export const MAX_REASON = 200;
/** L2 至少几张有效票才算"多成员"（1 票不构成共识）。 */
export const MIN_MEMBERS = 2;

export class AdjudicateError extends Error {
  constructor(message, code = 'adjudicate/error', detail = null) {
    super(message);
    this.name = 'AdjudicateError';
    this.code = code;
    this.detail = detail;
  }
}

function hash8(input) {
  return createHash('sha256').update(String(input)).digest('hex').slice(0, 8);
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

function singleLine(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 成员 reason：单行化 + 截到 200 字（码点），越界记一条 warning（不静默丢）。 */
function clipReason(text, warnings, member, originalIndex) {
  const s = singleLine(text);
  const chars = [...s];
  if (chars.length <= MAX_REASON) return s;
  warnings.push({
    code: 'vote/reason-truncated',
    severity: 'warning',
    member,
    originalIndex,
    detail: { chars: chars.length, max: MAX_REASON },
  });
  return `${chars.slice(0, MAX_REASON - 1).join('')}…`;
}

/**
 * 票的"上下文键"：`contextId` 优先，其次 `sessionId`，最后退回 member。
 * 同一 contextKey 的两张票 = 同一上下文里说了两遍（闸 2b：只算一票）。
 */
export function contextKeyOf(vote) {
  const c = vote?.contextId ?? vote?.sessionId ?? vote?.member ?? null;
  return typeof c === 'string' && c.trim() !== '' ? c.trim() : null;
}

/** 票里证据的结构检查：`{episode, seq, quote}` 三条都要有，缺一条就只算 warning。 */
export function normalizeEvidence(evidence) {
  const valid = [];
  const problems = [];
  const list = Array.isArray(evidence) ? evidence : [];
  list.forEach((raw, index) => {
    const e = raw && typeof raw === 'object' ? raw : null;
    const episode = typeof e?.episode === 'string' && e.episode.trim() !== '' ? e.episode.trim() : null;
    const seq = Number.isFinite(e?.seq) ? Number(e.seq) : null;
    const quote = singleLine(e?.quote);
    const missing = [];
    if (!episode) missing.push('episode');
    if (seq === null) missing.push('seq');
    if (quote === '') missing.push('quote');
    if (missing.length) {
      problems.push({ index, missing });
      return;
    }
    valid.push({ episode, seq, quote, ...(Number.isFinite(e.occurredAt) ? { occurredAt: Number(e.occurredAt) } : {}) });
  });
  return { valid, problems, dropped: list.length - valid.length };
}

/**
 * 独立性检查（闸 2b 的共用判据，R13 直接调用）。
 * @returns {{ok:boolean, shared:Array<{contextKey:string, members:string[], indexes:number[]}>}}
 */
export function independenceCheck(votes = []) {
  const list = Array.isArray(votes) ? votes : [];
  const byKey = new Map();
  list.forEach((vote, index) => {
    const key = contextKeyOf(vote ?? {});
    const member = typeof vote?.member === 'string' ? vote.member : null;
    if (!key) return;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ member, index });
  });
  const shared = [];
  for (const [contextKey, entries] of byKey) {
    const members = [...new Set(entries.map((e) => e.member).filter(Boolean))];
    if (entries.length > 1) shared.push({ contextKey, members, indexes: entries.map((e) => e.index) });
  }
  shared.sort((a, b) => (a.contextKey < b.contextKey ? -1 : 1));
  return { ok: shared.length === 0, shared };
}

/**
 * 机械聚合：把一组票聚成 `{counts, agreement, decision, counted, excluded, errors}`。
 * 纯函数：不读时钟、不读盘、不调模型。
 */
export function aggregateVotes({ votes = [], threshold = DEFAULT_THRESHOLD, level = LEVELS[0] } = {}) {
  if (!Array.isArray(votes)) {
    throw new AdjudicateError('adjudicate: votes 必须是数组', 'adjudicate/invalid-votes');
  }
  if (!LEVELS.includes(level)) {
    throw new AdjudicateError(`adjudicate: 未知 level "${level}"（允许：${LEVELS.join(' / ')}）`, 'adjudicate/invalid-level');
  }
  const thr = Number.isFinite(threshold) ? Number(threshold) : DEFAULT_THRESHOLD;
  if (thr <= 0 || thr > 1) {
    throw new AdjudicateError(`adjudicate: threshold 必须在 (0,1] 内（收到 ${threshold}）`, 'adjudicate/invalid-threshold');
  }

  const counted = [];
  const excluded = [];
  const errors = [];
  const seenMembers = new Set();
  const seenContexts = new Map(); // contextKey → member

  votes.forEach((raw, originalIndex) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      excluded.push({ member: null, verdict: null, contextId: null, evidence: [], reason: '', human: false, originalIndex, excludedReason: 'vote/not-object' });
      errors.push({ code: 'vote/not-object', severity: 'excluded', member: null, originalIndex, detail: null });
      return;
    }
    const member = singleLine(raw.member);
    const verdict = typeof raw.verdict === 'string' ? raw.verdict : null;
    const contextKey = contextKeyOf(raw);
    const contextId = typeof raw.contextId === 'string' && raw.contextId.trim() !== '' ? raw.contextId.trim() : null;
    const sessionId = typeof raw.sessionId === 'string' && raw.sessionId.trim() !== '' ? raw.sessionId.trim() : null;
    const human = raw.human === true;
    const ev = normalizeEvidence(raw.evidence);
    const base = {
      member: member || null,
      verdict,
      contextId,
      contextKey,
      ...(sessionId ? { sessionId } : {}),
      evidence: ev.valid,
      reason: clipReason(raw.reason, errors, member || null, originalIndex),
      human,
      originalIndex,
    };

    if (!member) {
      excluded.push({ ...base, excludedReason: 'vote/missing-member' });
      errors.push({ code: 'vote/missing-member', severity: 'excluded', member: null, originalIndex, detail: null });
      return;
    }
    if (!VERDICTS.includes(verdict)) {
      excluded.push({ ...base, excludedReason: 'vote/invalid-verdict' });
      errors.push({ code: 'vote/invalid-verdict', severity: 'excluded', member, originalIndex, detail: { verdict } });
      return;
    }
    if (seenMembers.has(member)) {
      excluded.push({ ...base, excludedReason: 'vote/duplicate-member' });
      errors.push({ code: 'vote/duplicate-member', severity: 'excluded', member, originalIndex, detail: null });
      return;
    }
    // 闸 2b：共享上下文的票不计（只保留先到的一票）
    if (contextKey && seenContexts.has(contextKey)) {
      excluded.push({ ...base, excludedReason: 'vote/shared-context' });
      errors.push({
        code: 'vote/shared-context',
        severity: 'excluded',
        member,
        originalIndex,
        detail: { contextKey, sharedWith: seenContexts.get(contextKey) },
      });
      return;
    }
    if (verdict !== 'insufficient' && ev.valid.length === 0) {
      excluded.push({ ...base, excludedReason: 'vote/no-evidence' });
      errors.push({ code: 'vote/no-evidence', severity: 'excluded', member, originalIndex, detail: { verdict, dropped: ev.dropped } });
      return;
    }
    if (ev.problems.length > 0) {
      errors.push({
        code: 'vote/evidence-weak',
        severity: 'warning',
        member,
        originalIndex,
        detail: { problems: ev.problems, kept: ev.valid.length },
      });
    }

    counted.push({ ...base, reason: base.reason });
    seenMembers.add(member);
    if (contextKey) seenContexts.set(contextKey, member);
  });

  const counts = {
    support: counted.filter((v) => v.verdict === 'support').length,
    oppose: counted.filter((v) => v.verdict === 'oppose').length,
    insufficient: counted.filter((v) => v.verdict === 'insufficient').length,
    valid: counted.length,
    decisive: 0,
  };
  counts.decisive = counts.support + counts.oppose;

  let agreement = counts.valid > 0 ? round3(Math.max(counts.support, counts.oppose) / counts.valid) : 0;
  let decision = 'hold-disputed';

  if (level === 'L4-human-correction') {
    // 人纠错 = 最高优先级证据（方案 §5.4 L4）：有人的票就是 correct，不看票数。
    const human = counted.filter((v) => v.human);
    if (human.length === 0) {
      errors.push({ code: 'level/no-human-vote', severity: 'degraded', member: null, originalIndex: null, detail: { level } });
      decision = 'hold-disputed';
    } else {
      decision = 'correct';
      agreement = 1;
    }
  } else if (counts.valid === 0) {
    errors.push({ code: 'adjudication/no-valid-votes', severity: 'degraded', member: null, originalIndex: null, detail: { threshold: thr } });
  } else if (counts.decisive === 0) {
    // 全是 insufficient：没有任何一方主张，等于判不了
    decision = 'hold-disputed';
  } else if (counts.support === counts.oppose) {
    decision = 'hold-disputed'; // 平票：两边都列，不硬判（方案 §5.2）
  } else if (agreement + 1e-9 < thr) {
    decision = 'hold-disputed'; // 一致度不足
  } else if (counts.support > counts.oppose) {
    decision = 'promote';
  } else {
    decision = 'invalidate';
  }

  // 异见：promote 收反对票；invalidate 收支持票；disputed 两边都列（"沉默即断言"，方案 §5.2）
  let dissent;
  if (decision === 'promote') dissent = counted.filter((v) => v.verdict === 'oppose');
  else if (decision === 'invalidate') dissent = counted.filter((v) => v.verdict === 'support');
  else if (decision === 'correct') dissent = counted.filter((v) => !v.human && v.verdict !== 'insufficient');
  else dissent = counted.slice();

  return {
    level,
    threshold: thr,
    counts,
    agreement,
    decision,
    counted,
    excluded,
    dissent,
    errors,
  };
}

/**
 * 产出一条裁决记录（契约 §4.7）。**不落账、不写盘**；落账由调用方（聚合器）执行。
 *
 * @param {object} p
 * @param {string} p.target    被裁对象：`c-…` | `j-…`
 * @param {Array}  p.votes     `{member, verdict, evidence:[{episode,seq,quote}], contextId?, human?, reason?}`
 * @param {number} [p.threshold=0.6]
 * @param {string} [p.level="L2-multi-member"] `L2-multi-member` | `L4-human-correction`
 * @param {number} [p.now=null] 入档时刻（**不进 id/decision，只进记录**；同输入同输出靠它）
 * @returns {object} adjudication 记录
 */
export function adjudicate({ target = null, votes = [], threshold = DEFAULT_THRESHOLD, level = LEVELS[0], now = null } = {}) {
  const t = singleLine(target);
  if (!t) throw new AdjudicateError('adjudicate: 需要 target（c-… / j-…）', 'adjudicate/missing-target');

  const agg = aggregateVotes({ votes, threshold, level });
  const id = `ad-${hash8(`${t}\u0000${agg.level}\u0000${agg.counted.map((v) => `${v.member}:${v.verdict}:${v.contextKey ?? ''}`).sort().join(',')}`)}`;

  return {
    id,
    version: ADJUDICATION_VERSION,
    schema: ADJUDICATION_SCHEMA,
    target: t,
    level: agg.level,
    n: agg.counted.length,
    votes: agg.counted,
    excluded: agg.excluded,
    counts: agg.counts,
    agreement: agg.agreement,
    threshold: agg.threshold,
    decision: agg.decision,
    dissent: agg.dissent,
    errors: agg.errors,
    at: Number.isFinite(now) ? Number(now) : null,
  };
}

/**
 * 回放：从留档的票重算，逐字段比对（可复核 = 方案 §5.4 第 5 条）。
 * 篡改任何一票（改 verdict / 改 contextId / 塞一张共享上下文的票）都会露出 diff。
 */
export function replayAdjudication(record, { threshold = null } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, diffs: ['record/missing'], recomputed: null };
  }
  if (typeof record.target !== 'string' || record.target.trim() === '') {
    return { ok: false, diffs: ['record/missing-target'], recomputed: null };
  }
  const counted = Array.isArray(record.votes) ? record.votes : [];
  const excluded = Array.isArray(record.excluded) ? record.excluded : [];
  const raw = [...counted, ...excluded]
    .slice()
    .sort((a, b) => (Number.isFinite(a?.originalIndex) ? a.originalIndex : 0) - (Number.isFinite(b?.originalIndex) ? b.originalIndex : 0))
    .map((v) => ({
      member: v?.member ?? null,
      verdict: v?.verdict ?? null,
      evidence: Array.isArray(v?.evidence) ? v.evidence : [],
      contextId: v?.contextId ?? null,
      sessionId: v?.sessionId ?? null,
      reason: v?.reason ?? '',
      human: v?.human === true,
    }));

  const recomputed = adjudicate({
    target: record.target,
    votes: raw,
    threshold: Number.isFinite(threshold) ? threshold : (Number.isFinite(record.threshold) ? record.threshold : DEFAULT_THRESHOLD),
    level: LEVELS.includes(record.level) ? record.level : LEVELS[0],
    now: record.at,
  });

  const diffs = [];
  for (const field of ['id', 'decision', 'agreement', 'n', 'target', 'level']) {
    if (recomputed[field] !== record[field]) diffs.push(`${field}: ${JSON.stringify(record[field])} → ${JSON.stringify(recomputed[field])}`);
  }
  if (JSON.stringify(recomputed.counts) !== JSON.stringify(record.counts)) {
    diffs.push(`counts: ${JSON.stringify(record.counts)} → ${JSON.stringify(recomputed.counts)}`);
  }
  return { ok: diffs.length === 0, diffs, recomputed };
}

/** 裁决记录的结构校验（给 R13 闸 2b 用；不重算一致度，只查形态与独立性）。 */
export function validateAdjudication(record) {
  const errors = [];
  const push = (code, detail = null) => errors.push({ code, detail });
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    push('adjudication/missing');
    return { ok: false, errors };
  }
  if (typeof record.target !== 'string' || record.target.trim() === '') push('adjudication/missing-target');
  if (!LEVELS.includes(record.level)) push('adjudication/invalid-level', { level: record.level ?? null });
  if (!DECISIONS.includes(record.decision)) push('adjudication/invalid-decision', { decision: record.decision ?? null });
  if (!Number.isFinite(record.agreement) || record.agreement < 0 || record.agreement > 1) {
    push('adjudication/invalid-agreement', { agreement: record.agreement ?? null });
  }
  if (!Number.isFinite(record.n) || record.n < 0) push('adjudication/invalid-n', { n: record.n ?? null });
  const votes = Array.isArray(record.votes) ? record.votes : null;
  if (!votes) {
    push('adjudication/missing-votes');
    return { ok: false, errors };
  }
  if (Number.isFinite(record.n) && record.n !== votes.length) {
    push('adjudication/n-mismatch', { n: record.n, votes: votes.length });
  }
  votes.forEach((v, i) => {
    if (!VERDICTS.includes(v?.verdict)) push('adjudication/bad-verdict', { index: i, verdict: v?.verdict ?? null });
    if (typeof v?.member !== 'string' || v.member.trim() === '') push('adjudication/bad-member', { index: i });
  });
  const ind = independenceCheck(votes);
  if (!ind.ok) push('adjudication/shared-context', { shared: ind.shared });
  return { ok: errors.length === 0, errors };
}

export default {
  ADJUDICATION_VERSION,
  ADJUDICATION_SCHEMA,
  VERDICTS,
  DECISIONS,
  LEVELS,
  DEFAULT_THRESHOLD,
  MAX_REASON,
  MIN_MEMBERS,
  AdjudicateError,
  contextKeyOf,
  normalizeEvidence,
  independenceCheck,
  aggregateVotes,
  adjudicate,
  replayAdjudication,
  validateAdjudication,
};

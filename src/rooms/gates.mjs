// R13 gates —— 十道闸 + 边界审计（M4 补齐：0/1/2/2b/3/4/5/6/6b/7 + boundary）
//
// 契约：方案.md §6.3（十道闸）、§5.1–§5.4（晋升/反例/失效/裁决）、docs/记忆的职责边界.md §5、
//       docs/数据契约.md §4.7/§7.2/§7.3、AGENTS §11 R13。
// 职责：**只判**，不改写、不修复、不重排 —— 输入一张记忆卡（+ 可选记录/裁决/本局证据），输出 `{ok, errors[]}`。
// 任一失败 ⇒ `ok:false`，errors 逐条列明（gate / code / detail）；判不了的进 `checks.unverified`（不假装合规）。
//
// 十道闸（编号取方案 §6.3，边界审计单列 `boundary`）：
//   0  时间戳前置   每条有 occurredAt、渲染日期 = occurredAt 的绝对日期（UTC）、provenance(episode+seq) 与行一致
//   1  作用域       条目 scopeKey == 当前 scope 或其显式祖先（`u:` 用户层 / `w:` 路径前缀）
//   2  支撑门槛     state 与 support/counter 计数匹配（support<2 不得 candidate；counter≥1 不得 promoted…）
//   2b 裁决独立性   裁决记录里不得有共享 contextId 的计入票；阈值与一致度一致；可回放
//   3  有效+适用条件 validity 必须核过；核不过/前置条件不满足 ⇒ 只能给指针（不许展开正文）
//   4  只增不改     被覆盖必须带 supersedes + supersededAtSeq；不许悬挂覆盖；同文重复必须有覆盖链
//   5  来源纪律     每条断言有 quote 且能对上 support(episode,seq)；quote 不得被篡改、不得来自摘要
//   6  预算与省略   ≤500 tokens、≤5 条、provenance 覆盖率=1、省略显式（计数 + 去哪取）
//   6b 相关闸       不命中零注入；每个 hit 带 `why`；深度 ≤2
//   7  事后降级     本局否定证据出现 ⇒ standard/semantic→disputed、candidate→observed、≥2 次→invalidated；
//                   已降级的条目不得再按高状态渲染正文
//   边界  指令式/许可/工具治理片段一律拒（方案 §7.2 纪律 1、边界 §2/§5）
//
// 纯函数：不读时钟、不写盘、不调模型。只有显式传入 `store` 时才读它（只读 get）。
// 正则与行格式从 R12 inject 单源引入；裁决口径从 R10 adjudicate 单源引入 —— 两处都不复制规则。

import {
  BUDGET_TOKENS,
  ENTRY_LIMIT,
  GOVERNANCE_PATTERNS,
  IMPERATIVE_PATTERNS,
  INDEX_LINE_RE,
  PROVENANCE_LINE_RE,
  estimateTokens,
  formatCardDate,
  isScopeVisible,
  normalizeScopeKey,
} from './inject.mjs';
import {
  DEFAULT_THRESHOLD,
  MIN_MEMBERS,
  independenceCheck,
  replayAdjudication,
  validateAdjudication,
} from './adjudicate.mjs';

/** 本仓库启用的闸（顺序 = 报告顺序）。M4 起十道全开。 */
export const ACTIVE_GATES = Object.freeze(['0', '1', '2', '2b', '3', '4', '5', '6', '6b', '7', 'boundary']);

/** 尚未启用的闸：**空**（十道全在位）。保留导出，避免调用方按旧接口 panic。 */
export const PENDING_GATES = Object.freeze([]);

export const GATE_DOCS = Object.freeze({
  0: '闸 0 时间戳前置：occurredAt + 绝对日期 + provenance(episode,seq) 齐备且与渲染行一致（方案 §6.3）',
  1: '闸 1 作用域：条目 scopeKey = 当前 scope 或其显式祖先（u: / w: 路径前缀），其余不可见（方案 §4.10/§6.3）',
  2: '闸 2 支撑门槛：state 与 support/counter 匹配（support≥2 才 candidate、≥3 才 semantic/standard、counter≥1 ⇒ disputed、≥2 ⇒ invalidated）',
  '2b': '闸 2b 裁决独立性：计入票不得共享 contextId；promote 必须过阈值且 ≥2 名成员；记录可回放',
  3: '闸 3 有效性与适用条件：validity/preconditions 必须核过；核不过只给指针（方案 §5.3/§6.3 F7）',
  4: '闸 4 只增不改：被覆盖必须 supersedes + supersededAtSeq；不许悬挂覆盖；同文重复必须有覆盖链（方案 §5.2）',
  5: '闸 5 来源纪律：每条断言有 quote 且对得上 support(episode,seq)；quote 不得篡改、不得来自摘要（方案 §6.3 F5）',
  6: '闸 6 预算与省略：≤500 tokens、≤5 条、provenance 覆盖率=1、省略显式（方案 §6.3 F6）',
  '6b': '闸 6b 相关闸：不命中零注入、每个 hit 带 why、深度 ≤2（方案 §6.3 F8）',
  7: '闸 7 事后降级：本局否定证据 ⇒ standard/semantic→disputed、candidate→observed、≥2 次→invalidated（方案 §6.3）',
  boundary: '边界闸：注入文本里不得出现指令式/许可/建议片段，也不得出现工具治理痕迹（边界 §2/§5）',
});

// ---------------------------------------------------------------------------
// 闸 1 作用域：显式祖先可见，默认不可见（判据在 R12，与"注入前过滤"同一份实现）
// ---------------------------------------------------------------------------

/** `D:\Work\Demo` / `w:D:/Work` → `w:d:/Work`；`u:Owner` → `u:owner`（与 R00 episode.scopeKey 同口径）。 */
export const normalizeScope = normalizeScopeKey;

export { isScopeVisible };

// ---------------------------------------------------------------------------
// 闸 2 支撑门槛 / 闸 7 事后降级：状态机（与 R09/R08 的口径一致，方案 §5.1）
// ---------------------------------------------------------------------------

export const SUPPORT_CANDIDATE = 2; // ≥2 局独立支撑 ⇒ candidate
export const SUPPORT_STANDARD = 3; // ≥3 局 ⇒ semantic/standard（或 2 局 + 一次复用）
export const COUNTER_DISPUTED = 1; // counter ≥1 ⇒ disputed（不得 promoted）
export const COUNTER_INVALIDATE = 2; // counter ≥2 ⇒ invalidated

export const CLAIM_STATES = Object.freeze(['observed', 'candidate', 'semantic', 'standard', 'disputed', 'invalidated', 'stale']);
export const JOSEKI_STATES = Object.freeze(['candidate', 'standard', 'deprecated', 'superseded']);

/**
 * 支撑/反例计数 → 允许的状态集合。纯机械（方案 §5.1 晋升阶梯 / §5.2 反例优先）。
 * @param {{support?:number, counter?:number, reused?:boolean, strongCounter?:boolean, kind?:string}} p
 * @returns {{allowed:string[], reasons:string[]}}
 */
export function allowedStates({ support = 0, counter = 0, reused = false, strongCounter = false, kind = 'claim' } = {}) {
  const s = Number.isFinite(support) ? support : 0;
  const c = Number.isFinite(counter) ? counter : 0;
  const reasons = [];

  // 反例优先（方案 §5.2）：有反例就不得是断言态
  if (c >= COUNTER_INVALIDATE || strongCounter) {
    reasons.push(`counter=${c}${strongCounter ? ' + 强反例' : ''} ⇒ invalidated`);
    return { allowed: kind === 'joseki' ? ['superseded', 'deprecated'] : ['invalidated'], reasons };
  }
  if (c >= COUNTER_DISPUTED) {
    reasons.push(`counter=${c} ⇒ disputed`);
    return { allowed: kind === 'joseki' ? ['deprecated'] : ['disputed'], reasons };
  }
  if (kind === 'joseki') {
    if (s >= SUPPORT_STANDARD || (s >= SUPPORT_CANDIDATE && reused)) {
      return { allowed: ['candidate', 'standard', 'deprecated', 'superseded'], reasons };
    }
    if (s >= SUPPORT_CANDIDATE) return { allowed: ['candidate', 'superseded'], reasons: [`support=${s} ⇒ 至多 candidate`] };
    return { allowed: ['superseded'], reasons: [`support=${s} < ${SUPPORT_CANDIDATE} ⇒ 不许 candidate`] };
  }
  if (s >= SUPPORT_STANDARD || (s >= SUPPORT_CANDIDATE && reused)) {
    return { allowed: ['observed', 'candidate', 'semantic', 'standard', 'invalidated', 'stale'], reasons };
  }
  if (s >= SUPPORT_CANDIDATE) {
    return { allowed: ['observed', 'candidate', 'invalidated', 'stale'], reasons: [`support=${s} ⇒ 至多 candidate`] };
  }
  return { allowed: ['observed', 'invalidated', 'stale'], reasons: [`support=${s} < ${SUPPORT_CANDIDATE} ⇒ 至多 observed`] };
}

/** 检查一条 claim/定式记录的 state 与计数是否匹配；匹配返回 null。 */
export function supportStateViolation(record) {
  if (!record || typeof record !== 'object') return { code: 'gate2/record-invalid', detail: null };
  const kind = String(record.id ?? '').startsWith('j-') ? 'joseki' : 'claim';
  const states = kind === 'joseki' ? JOSEKI_STATES : CLAIM_STATES;
  const state = record.state;
  if (!states.includes(state)) return { code: 'gate2/unknown-state', detail: { state: state ?? null, kind, allowed: [...states] } };
  const { allowed, reasons } = allowedStates({
    support: Array.isArray(record.support) ? record.support.length : 0,
    counter: Array.isArray(record.counter) ? record.counter.length : 0,
    reused: record.reused === true || Number(record.reuseCount) > 0,
    strongCounter: record.strongCounter === true,
    kind,
  });
  if (!allowed.includes(state)) {
    return {
      code: 'gate2/state-over-claim',
      detail: {
        id: record.id ?? null,
        state,
        support: Array.isArray(record.support) ? record.support.length : 0,
        counter: Array.isArray(record.counter) ? record.counter.length : 0,
        allowed,
        reasons,
      },
    };
  }
  return null;
}

/**
 * 闸 7 的降级函数（机械，方案 §6.3 闸 7）：本局否定一次 ⇒ 降一档；连续 ≥2 次 ⇒ invalidated。
 * 只算"该降到的状态"，不改写记录（改写是落账方的事）。
 */
export function downgradeState(state, negations = 1) {
  const n = Number(negations);
  if (!Number.isFinite(n) || n <= 0) return state;
  if (n >= 2) return 'invalidated';
  switch (state) {
    case 'standard':
    case 'semantic':
      return 'disputed';
    case 'candidate':
      return 'observed';
    case 'disputed':
      return 'invalidated';
    default:
      return state; // observed / invalidated / stale 保持
  }
}

/** 降级后还能出现在注入里的标记（正文 = 断言；指针 = 只给事实）。 */
export function allowedMarkersAfterDowngrade(expected) {
  switch (expected) {
    case 'observed':
      return ['observed', 'disputed', 'invalidated', 'stale'];
    case 'disputed':
      return ['disputed', 'invalidated', 'stale'];
    case 'invalidated':
      return ['invalidated', 'stale'];
    case 'stale':
      return ['stale'];
    default:
      return [expected];
  }
}

// ---------------------------------------------------------------------------
// 闸 5 来源纪律：摘要标记（自证污染的机械特征，陷阱 11 / 方案 F5）
// ---------------------------------------------------------------------------

/** 会主张内容的 claim 类型（闸 5 只对这类行要 quote）。 */
export const CLAIM_KINDS = Object.freeze(['fact', 'rule', 'antipattern', 'preference', 'pattern']);

export const SUMMARY_MARKERS = Object.freeze(['<compacted-summary>', '<chess-fold>', '<kifu-summary>', '<fold-summary>']);

export function looksLikeSummary(text) {
  const s = String(text ?? '').toLowerCase();
  return SUMMARY_MARKERS.some((m) => s.includes(m));
}

// ---------------------------------------------------------------------------
// 记录解析（可选：把 claims/joseki/episodes 记录喂进来才能做 1/2/3/4/5/7）
// ---------------------------------------------------------------------------

export function buildResolver({ records = null, store = null } = {}) {
  const buckets = { claims: new Map(), joseki: new Map(), episodes: new Map() };
  const put = (kind, record, fallbackId = null) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return;
    const id = typeof record.id === 'string' && record.id ? record.id : fallbackId;
    if (typeof id === 'string' && id) buckets[kind].set(id, record);
  };
  const addAll = (kind, src) => {
    if (!src) return;
    if (src instanceof Map) {
      for (const [k, v] of src) put(kind, v, k);
      return;
    }
    if (Array.isArray(src)) {
      for (const r of src) put(kind, r);
      return;
    }
    if (typeof src === 'object') {
      for (const [k, v] of Object.entries(src)) put(kind, v, k);
    }
  };
  const typed = records
    && typeof records === 'object'
    && !Array.isArray(records)
    && !(records instanceof Map)
    && ['claims', 'joseki', 'episodes'].some((k) => k in records);
  if (typed) {
    addAll('claims', records.claims);
    addAll('joseki', records.joseki);
    addAll('episodes', records.episodes);
  } else {
    addAll('claims', records);
  }
  const storeOk = Boolean(store && typeof store.get === 'function');
  return {
    size: () => buckets.claims.size + buckets.joseki.size + buckets.episodes.size,
    available: () => storeOk || (buckets.claims.size + buckets.joseki.size + buckets.episodes.size) > 0,
    claims: () => [...buckets.claims.values()],
    get(kind, id) {
      if (typeof id !== 'string' || !id) return null;
      if (buckets[kind]?.has(id)) return buckets[kind].get(id);
      if (storeOk) {
        try {
          return store.get(kind, id) ?? null;
        } catch {
          return null;
        }
      }
      return null;
    },
  };
}

const recordKindOf = (id) => (String(id ?? '').startsWith('j-') ? 'joseki' : (String(id ?? '').startsWith('ep-') ? 'episodes' : 'claims'));

/** 卡片条目的语义状态（R12 的 entry.state 是 claim 状态；手工卡可能只有 marker）。 */
const stateOf = (entry) => {
  if (typeof entry?.state === 'string' && entry.state) return entry.state;
  if (typeof entry?.marker === 'string' && entry.marker) return entry.marker;
  return null;
};

// ---------------------------------------------------------------------------
// 边界扫描
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function stringOf(v) {
  return typeof v === 'string' ? v : '';
}

function sectionLines(section) {
  return String(section ?? '').split('\n');
}

/**
 * 跑闸。**只读**输入，不做修复。
 *
 * @param {object} p
 * @param {object} p.card            R12 `buildMemoryCard()` 的输出
 * @param {object} [p.walkResult]    R11 walk 结果（缺省跳过闸 6b 的命中/深度检查）
 * @param {any}    [p.records]       claims/joseki/episodes 记录（Map | 数组 | {id:record} | {claims,joseki,episodes}）
 * @param {object} [p.store]         R15 createStore()（只读；给了 records 可以不传）
 * @param {string} [p.scope]         当前 scopeKey（闸 1）
 * @param {Array}  [p.adjudications] R10 裁决记录（闸 2b）
 * @param {Array}  [p.evidence]      本局否定证据 `[{claimId, episode, seq, quote}]`（闸 7）
 * @param {object} [p.validityChecks]     `{[claimId]: {ok:boolean, reason?:string}}`（闸 3）
 * @param {object} [p.preconditionChecks] `{[claimId]: {ok:boolean, results?:Array}}`（闸 3）
 * @param {number} [p.limit]         条数上限（默认 5）
 * @param {number} [p.budgetTokens]  token 预算（默认 500）
 * @param {boolean}[p.strict]        true ⇒「判不了」也算失败（默认 false：记 checks.unverified，不假装合规）
 * @returns {{ok:boolean, errors:Array<{gate:string, code:string, detail:any}>, checks:object}}
 */
export function runGates({
  card = null,
  walkResult = null,
  records = null,
  store = null,
  scope = null,
  adjudications = [],
  evidence = [],
  validityChecks = null,
  preconditionChecks = null,
  limit = ENTRY_LIMIT,
  budgetTokens = BUDGET_TOKENS,
  strict = false,
} = {}) {
  const errors = [];
  const push = (gate, code, detail = null) => errors.push({ gate, code, detail });
  const checks = {
    claims: 0,
    lines: 0,
    tokens: 0,
    hits: 0,
    scannedStrings: 0,
    omitted: 0,
    adjudications: 0,
    evidence: 0,
    scopeChecked: 0,
    supportChecked: 0,
    validityChecked: 0,
    immutabilityChecked: 0,
    provenanceChecked: 0,
    downgradeChecked: 0,
    unverified: [],
    byGate: { 0: 0, 1: 0, 2: 0, '2b': 0, 3: 0, 4: 0, 5: 0, 6: 0, '6b': 0, 7: 0, boundary: 0 },
  };
  /** 判不了的：非 strict 记 unverified（不假装合规），strict 直接失败。 */
  const unverified = (gate, code, count, reason) => {
    if (!count) return;
    if (strict) push(gate, code, { count, reason, unverified: true });
    else checks.unverified.push({ gate, code, count, reason });
  };

  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    push('0', 'card/missing', 'runGates 需要 R12 buildMemoryCard() 的 card 对象');
    return { ok: false, errors, checks };
  }

  const claims = Array.isArray(card.claims) ? card.claims : [];
  const section = typeof card.section === 'string' ? card.section : null;
  checks.claims = claims.length;
  const resolver = buildResolver({ records, store });

  // ---------------------------------------------------------------- 闸 0（时间戳前置）
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

  // ---------------------------------------------------------------- 闸 1（作用域）
  const currentScope = normalizeScope(scope);
  let scopeUnresolved = 0;
  for (let i = 0; i < claims.length; i += 1) {
    const c = claims[i] ?? {};
    const claimId = typeof c.claimId === 'string' ? c.claimId : null;
    const episodeId = typeof c.source?.episode === 'string' ? c.source.episode : null;
    const record = claimId ? resolver.get(recordKindOf(claimId), claimId) : null;
    const episode = !record && episodeId ? resolver.get('episodes', episodeId) : null;
    const holder = record ?? episode;
    if (!holder) {
      scopeUnresolved += 1;
      continue;
    }
    const entryScope = holder.scopeKey;
    if (typeof entryScope !== 'string' || entryScope.trim() === '') {
      push('1', 'gate1/entry-scope-missing', { index: i, claimId, episode: episodeId });
      continue;
    }
    if (!currentScope) {
      scopeUnresolved += 1;
      continue;
    }
    if (!isScopeVisible(entryScope, currentScope)) {
      push('1', 'gate1/scope-mismatch', { index: i, claimId, entryScope: normalizeScope(entryScope), scope: currentScope });
    } else {
      checks.scopeChecked += 1;
    }
  }
  if (!currentScope) unverified('1', 'gate1/scope-unknown', claims.length, '未提供当前 scopeKey');
  else unverified('1', 'gate1/record-unresolved', scopeUnresolved, '条目记录不可解析（未给 records/store）');

  // ---------------------------------------------------------------- 闸 2（支撑门槛）
  let supportUnresolved = 0;
  for (let i = 0; i < claims.length; i += 1) {
    const claimId = typeof claims[i]?.claimId === 'string' ? claims[i].claimId : null;
    const record = claimId ? resolver.get(recordKindOf(claimId), claimId) : null;
    if (!record) {
      if (claimId) supportUnresolved += 1;
      continue;
    }
    checks.supportChecked += 1;
    const violation = supportStateViolation(record);
    if (violation) push('2', violation.code, { index: i, ...violation.detail });
  }
  unverified('2', 'gate2/record-unresolved', supportUnresolved, '条目记录不可解析（未给 records/store）');

  // ---------------------------------------------------------------- 闸 2b（裁决独立性）
  const adjudicationList = Array.isArray(adjudications) ? adjudications : (adjudications ? [adjudications] : []);
  checks.adjudications = adjudicationList.length;
  for (const record of adjudicationList) {
    const shape = validateAdjudication(record);
    for (const e of shape.errors) {
      const code = e.code === 'adjudication/shared-context'
        ? 'gate2b/shared-context'
        : (e.code === 'adjudication/missing' ? 'gate2b/record-missing' : 'gate2b/invalid-record');
      push('2b', code, { adjudicationId: record?.id ?? null, ...e });
    }
    if (shape.errors.length === 0) {
      const replay = replayAdjudication(record);
      if (!replay.ok) push('2b', 'gate2b/not-replayable', { adjudicationId: record.id, diffs: replay.diffs });
    }
    const thr = Number.isFinite(record?.threshold) ? record.threshold : DEFAULT_THRESHOLD;
    if (record?.decision === 'promote') {
      if (!(Number.isFinite(record.agreement) && record.agreement >= thr)) {
        push('2b', 'gate2b/threshold-violation', { adjudicationId: record?.id ?? null, agreement: record?.agreement ?? null, threshold: thr });
      }
      if (!(Number.isFinite(record.n) && record.n >= MIN_MEMBERS)) {
        push('2b', 'gate2b/single-member-promote', { adjudicationId: record?.id ?? null, n: record?.n ?? null });
      }
    }
    if (Array.isArray(record?.votes)) {
      const ind = independenceCheck(record.votes);
      if (!ind.ok) push('2b', 'gate2b/shared-context', { adjudicationId: record?.id ?? null, shared: ind.shared });
    }
  }

  // ---------------------------------------------------------------- 闸 3（有效性 + 适用条件）
  let validityUnresolved = 0;
  for (let i = 0; i < claims.length; i += 1) {
    const c = claims[i] ?? {};
    const claimId = typeof c.claimId === 'string' ? c.claimId : null;
    const record = claimId ? resolver.get(recordKindOf(claimId), claimId) : null;
    if (!record) continue;
    const validity = record.validity && typeof record.validity === 'object' ? record.validity : null;
    const validityType = validity?.type ?? 'none';
    const preconditions = Array.isArray(record.preconditions) ? record.preconditions : [];
    const state = stateOf(c);
    const isPointer = typeof c.kind === 'string' && c.kind === 'pointer';

    if (validityType !== 'none') {
      const check = validityChecks && typeof validityChecks === 'object' ? validityChecks[claimId] : null;
      if (!check || typeof check.ok !== 'boolean') {
        validityUnresolved += 1;
      } else {
        checks.validityChecked += 1;
        if (check.ok === false) {
          if (state !== 'stale') push('3', 'gate3/stale-not-marked', { index: i, claimId, validity: validityType, state: state ?? null, reason: check.reason ?? null });
          else if (!isPointer) push('3', 'gate3/stale-rendered', { index: i, claimId, validity: validityType, kind: c.kind ?? null });
        }
      }
    }
    if (preconditions.length > 0) {
      const check = preconditionChecks && typeof preconditionChecks === 'object' ? preconditionChecks[claimId] : null;
      if (!check || typeof check.ok !== 'boolean') {
        validityUnresolved += 1;
      } else {
        checks.validityChecked += 1;
        if (check.ok === false) {
          if (state !== 'stale') {
            push('3', 'gate3/precondition-failed', {
              index: i,
              claimId,
              state: state ?? null,
              failed: Array.isArray(check.failed) ? check.failed : null,
              results: Array.isArray(check.results) ? check.results.filter((r) => r && r.ok === false) : null,
            });
          } else if (!isPointer) {
            push('3', 'gate3/precondition-failed', { index: i, claimId, state, kind: c.kind ?? null, onlyPointerAllowed: true });
          }
        }
      }
    }
  }
  unverified('3', 'gate3/validity-unchecked', validityUnresolved, '带 validity/preconditions 的条目没有核验结果（未给 validityChecks/preconditionChecks）');

  // ---------------------------------------------------------------- 闸 4（只增不改）
  const renderedRecords = [];
  let immutabilityUnresolved = 0;
  for (let i = 0; i < claims.length; i += 1) {
    const c = claims[i] ?? {};
    const claimId = typeof c.claimId === 'string' ? c.claimId : null;
    if (!claimId) continue;
    const record = resolver.get(recordKindOf(claimId), claimId);
    if (!record) {
      immutabilityUnresolved += 1;
      continue;
    }
    renderedRecords.push({ index: i, record });
    const supersededBy = record.supersededBy ?? (record.state === 'superseded' ? (record.supersedes ?? true) : null);
    if (supersededBy && !Number.isFinite(record.supersededAtSeq)) {
      push('4', 'gate4/missing-superseded-at', { index: i, claimId, supersededBy });
    }
    if (record.supersedes) {
      const target = resolver.get(recordKindOf(record.supersedes), record.supersedes);
      if (!target) push('4', 'gate4/dangling-supersedes', { index: i, claimId, supersedes: record.supersedes });
    }
    if (supersededBy) {
      const state = stateOf(c);
      const kind = typeof c.kind === 'string' ? c.kind : null;
      if (kind !== 'pointer' && !['stale', 'invalidated', 'disputed', 'superseded'].includes(state)) {
        push('4', 'gate4/superseded-rendered', { index: i, claimId, state: state ?? null, supersededBy });
      }
    }
  }
  // 同文重复（同 kind + 同 scope + 同规范化文本）却没有覆盖链 ⇒ 冲突必须显式（只增不改）
  const byBody = new Map();
  for (const { index, record } of renderedRecords) {
    if (typeof record.text !== 'string') continue;
    const key = `${record.kind ?? ''}\u0000${normalizeScope(record.scopeKey)}\u0000${record.text.replace(/\s+/g, ' ').trim()}`;
    if (!byBody.has(key)) byBody.set(key, []);
    byBody.get(key).push({ index, record });
  }
  for (const group of byBody.values()) {
    if (group.length < 2) continue;
    const ids = new Set(group.map((g) => g.record.id));
    const linked = group.some((g) => g.record.supersedes && ids.has(g.record.supersedes))
      || group.some((g) => g.record.supersededBy && ids.has(g.record.supersededBy));
    if (!linked) {
      push('4', 'gate4/unsuperseded-duplicate', { ids: group.map((g) => g.record.id), indexes: group.map((g) => g.index) });
    }
  }
  unverified('4', 'gate4/record-unresolved', immutabilityUnresolved, '条目记录不可解析（未给 records/store）');
  checks.immutabilityChecked = renderedRecords.length;

  // ---------------------------------------------------------------- 闸 5（来源纪律）
  let provenanceUnresolved = 0;
  for (let i = 0; i < claims.length; i += 1) {
    const c = claims[i] ?? {};
    const claimId = typeof c.claimId === 'string' ? c.claimId : null;
    const kind = typeof c.kind === 'string' ? c.kind : null;
    // 只有"主张断言"的行才要 quote：R12 的 claim 行带 claimId 或 claim 系 kind（fact/rule/…），
    // 其余是棋谱指针行（failure/constraint/pointer，只给这一局命中过什么），不主张内容。
    const asserting = Boolean(claimId) || CLAIM_KINDS.includes(kind);
    if (!asserting) continue;

    const record = claimId ? resolver.get(recordKindOf(claimId), claimId) : null;
    const cardQuote = typeof c.source?.quote === 'string' ? c.source.quote : null;
    const episode = typeof c.source?.episode === 'string' ? c.source.episode : null;
    const seq = Number.isFinite(c.source?.seq) ? Number(c.source.seq) : null;

    if (!record) {
      // 没有记录可核：至少要求卡片自带 quote（结构检查），否则就是"无源"
      if (!cardQuote || cardQuote.trim() === '') {
        if (claimId) provenanceUnresolved += 1;
        else push('5', 'gate5/missing-quote', { index: i, claimId, episode, seq });
      } else {
        checks.provenanceChecked += 1;
        if (looksLikeSummary(cardQuote)) push('5', 'gate5/summary-source', { index: i, claimId, episode, seq });
      }
      continue;
    }

    checks.provenanceChecked += 1;
    const support = Array.isArray(record.support) ? record.support : [];
    const entry = support.find((s) => s && String(s.episode) === String(episode) && Number(s.seq) === Number(seq)) ?? null;
    if (!entry) {
      push('5', 'gate5/provenance-not-in-support', {
        index: i,
        claimId,
        episode,
        seq,
        support: support.map((s) => ({ episode: s?.episode ?? null, seq: s?.seq ?? null })),
      });
      continue;
    }
    const recordQuote = stringOf(entry.quote);
    if (recordQuote.trim() === '') {
      push('5', 'gate5/missing-quote', { index: i, claimId, episode, seq });
      continue;
    }
    if (looksLikeSummary(recordQuote)) push('5', 'gate5/summary-source', { index: i, claimId, episode, seq });
    if (cardQuote && cardQuote.trim() !== '' && !recordQuote.includes(cardQuote.trim())) {
      push('5', 'gate5/quote-tampered', { index: i, claimId, episode, seq });
    }
  }
  unverified('5', 'gate5/record-unresolved', provenanceUnresolved, '条目记录不可解析（未给 records/store）');

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
  if (walkResult && typeof walkResult === 'object') {
    const hits = Array.isArray(walkResult.hits) ? walkResult.hits : [];
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

  // ---------------------------------------------------------------- 闸 7（事后降级）
  const evidenceList = Array.isArray(evidence) ? evidence : (evidence ? [evidence] : []);
  checks.evidence = evidenceList.length;
  const negations = new Map();
  for (const item of evidenceList) {
    const claimId = typeof item?.claimId === 'string' ? item.claimId : null;
    if (!claimId) continue;
    if (!negations.has(claimId)) negations.set(claimId, []);
    negations.get(claimId).push(item);
  }
  let downgradeUnresolved = 0;
  for (let i = 0; i < claims.length; i += 1) {
    const c = claims[i] ?? {};
    const claimId = typeof c.claimId === 'string' ? c.claimId : null;
    if (!claimId) continue;
    const record = resolver.get(recordKindOf(claimId), claimId);
    const list = negations.get(claimId) ?? [];
    // 只按**本局新证据**降级：记录里已有的 counter 已经体现在它的 state 上（那由闸 2 核），
    // 再拿来做闸 7 就是同一件事数两遍。
    const total = list.length;
    if (total === 0) continue;
    if (!record) {
      downgradeUnresolved += 1;
      continue;
    }
    checks.downgradeChecked += 1;
    const expected = downgradeState(record.state, total);
    const allowed = allowedMarkersAfterDowngrade(expected);
    const state = stateOf(c);
    const kind = typeof c.kind === 'string' ? c.kind : null;
    if (kind === 'pointer' || state === 'stale') continue; // 指针 / 条件已变：不主张断言，合规
    if (!allowed.includes(state)) {
      push('7', 'gate7/not-downgraded', {
        index: i,
        claimId,
        state: record.state ?? null,
        negations: total,
        expected,
        renderedState: state ?? null,
        allowedStates: allowed,
      });
    }
  }
  unverified('7', 'gate7/record-unresolved', downgradeUnresolved, '有否定证据但条目记录不可解析（未给 records/store）');

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
    for (const hit of auditImperatives(text)) push('boundary', 'boundary/imperative', hit);
    for (const hit of auditGovernance(text)) push('boundary', 'boundary/tool-governance', hit);
  }

  // ---------------------------------------------------------------- 汇总
  for (const e of errors) {
    if (checks.byGate[e.gate] !== undefined) checks.byGate[e.gate] += 1;
  }

  return { ok: errors.length === 0, errors, checks };
}

export default {
  ACTIVE_GATES,
  PENDING_GATES,
  GATE_DOCS,
  CLAIM_STATES,
  JOSEKI_STATES,
  SUMMARY_MARKERS,
  SUPPORT_CANDIDATE,
  SUPPORT_STANDARD,
  COUNTER_DISPUTED,
  COUNTER_INVALIDATE,
  normalizeScope,
  isScopeVisible,
  allowedStates,
  supportStateViolation,
  downgradeState,
  allowedMarkersAfterDowngrade,
  looksLikeSummary,
  buildResolver,
  auditImperatives,
  auditGovernance,
  runGates,
};

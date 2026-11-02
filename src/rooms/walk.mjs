// R11 walk —— 顺藤摸瓜（只读 store；深度 ≤2；每跳必须带 why；条数/预算截断）
//
// ── 契约（docs/数据契约.md §7.1/§7.2、方案.md §4.4、AGENTS.md §11 R11）──
// 职责：把一个「当前信号」（根 user 消息的判别性词 / 当前活动 / 用户显式提起）翻译成
//       store 里的**指针 + 证据路径**：命中主题 → 该主题上的棋谱与 claim →
//       必要时沿 store 的相关边走一跳 → 排序、截断、估 token。
//       **不做向量检索、不做模型判断「像不像」、不灌全文**（只给指针与 why）。
// 入口：walkFromSignals({ signal, store, scope=null, depth=2, limit=5, budgetTokens=500 }) -> result
//       另导出 estimateTokens / normalizeSignal / matchTopics / WalkError /
//       normalizeScopeKey / isScopeVisible / resolveScope 与常量。
// 输入：
//   signal = { kind:"root-message"|"activity"|"user-explicit", terms:[string],
//              entities:[{kind?,key}], at?:epochms }                        （契约 §7.1）
//            entities[].key 可以是主题 key（`MYCF711/dsh-gokifu-longmemory`）或主题 id（`t:repo:xxxxxxxx`）。
//   store  = R15 createStore 的产物；本房间**只用 list()**（只读）。
//            topics / links / episodes / claims 缺哪个就当空数组（不抛、不建目录、不写盘）。
// 输出：
//   { hits:[{episode, nodeId?, claim?, claimKind?, claimState?, link, why:[topicKey], weight,
//            occurredAt, seq?, kind, depth, tokens, text?, scopeKey?}],
//     path:[{from, to, why:[topicKey], kind, link?, new?}],
//     omitted:{count, reason:"limit"|"budget"|null, byLimit, byBudget},
//     tokens:number, maxDepth, depth, matched:{topics:[…], truncated}, dropped:{…}, signal:{…} }
//   hit.seq        = 回放行：claim 取 support.seq，棋谱取该主题的首个 mention seq（缺则省略）。
//   hit.claim      = claim id（拿它去 claims/<id>.json 取原文）；claimKind/claimState 是它的
//                    kind/state（antipattern/preference/fact… 与 observed/candidate/stale…）。
//   result.depth   = maxDepth 的别名（R13 闸 6b 直接读 result.depth 判「≤2」）。
// 深度语义（契约「深度 ≤2」的落地）：
//   depth=1 = 信号 → 主题 → 棋谱/claim（直接命中；why = 命中的主题 key）
//   depth=2 = 直接命中的棋谱 → 相关棋谱（沿 store 的 links 走一跳）
//   参数 depth 被 clamp 到 [1,2]：>2 一律按 2 走（不越界）；≤0 抬到 1（直接命中总是做）。
//   **绝不产出 depth>2 的命中**；result.maxDepth 回显实际生效值。
//   坑：depth=2 的棋谱**不再展开**（否则就是第 3 跳）。
// 排序（契约 §7.2「失败教训优先，其次约束/偏好，最后定式候选」）：
//   档位 failure(0) → constraint(1) → claim(2)；同档内 depth 升序 → weight 降序 →
//   occurredAt 降序（新的先给）→ 标识升序。分类只看机械信号：
//     棋谱 signals.failures>0 ⇒ failure；否则 signals.constraints>0 ⇒ constraint；
//     否则 ⇒ claim（参考面 = 定式候选）。
//     claim 条目：antipattern ⇒ failure；preference ⇒ constraint；其余 ⇒ claim。
//   权重只由机械量决定：直接命中 = 主题 idfNorm（缺失回落 0.5）；一跳命中 = link.weight；
//     多路命中取 max。**没有模型评分参与**。
// 预算：每 hit 的 tokens = estimateTokens(episode + claim + kind + why + text)；
//   CJK 1.5 字/token、ASCII 4 字/token（契约 §7.2「≤500 tokens」的估法）。
//   截断是**前缀式**的：按排序结果依次收，碰到 limit 或 budget 就停，后面的全部计入 omitted。
//   ⇒ 同输入 + 同预算永远得到同一个前缀（可复现、可单测）。
// 无命中：hits=[]、path=[]、tokens=0、omitted.count=0（沉默是默认，不"猜相关"）。
// 作用域（T8b 修复：闸 1 抓到的 F2 越界）：
//   每个条目（episode / claim）都带 scopeKey，**候选入 hits 之前**先过作用域闸：
//     - 完全相同 ⇒ 可见；
//     - `u:` 用户层 ⇒ 任何 `w:` 作用域都可见（跨项目的"你"；不同 `u:` 之间不可见）；
//     - `w:` **只认完全相同**：不跨工作区（R13 闸 1 比这里宽，它还允许「子看父」的路径前缀，
//       所以 walk 只会少给，不会让闸 1 变红）；缺 scopeKey / 未知哨兵（`w:unknown`）⇒ 不可见。
//   当前作用域取 opts.scope > signal.scope > signal.scopeKey > store.scope|scopeKey|currentScope；
//   全都拿不到 ⇒ **降级**为「只放用户层」（result.scope.mode = "user-layer-only"），默认拒绝跨域。
//   被作用域拒掉的条目不进 hits，计入 `omitted.crossScope`（可审计），
//   明细另见 `dropped.crossScope`（跨工作区）与 `dropped.scopeMissing`（无法证明同域）。
// 错误语义：signal 不是对象 / kind 不在枚举内 ⇒ WalkError('walk/invalid-signal')；
//   store 没有 list() ⇒ WalkError('walk/invalid-store')。其余情况**不抛**：
//   缺时间戳的棋谱（"无时不入"）、folded-into 的子代理局、invalidated claim 只计数
//   （result.dropped），不抛、不入 hits。
// 只读保证：本房间**不 import 任何模块**（连 node: 内置都不用）——没有 fs 句柄、没有写方法，
//   结构上不可能写盘，也就不可能写 <DSH_HOME>。疑似写盘的行为在测试里用 store 快照对比验证。
// 允许依赖：无（R05 的 links / R04 的主题表 / R07 的索引都由 store 提供成品；本房间不 import）。

/** 默认参数（契约 §7.2 的 5 条 / 500 tokens）。 */
export const WALK_DEFAULTS = Object.freeze({
  depth: 2,
  limit: 5,
  budgetTokens: 500,
  maxTopics: 8, // 一次信号最多匹配几个主题（多了说明信号太宽，宁可少跳）
  maxHops: 40,   // path 的最大跳数（保护注入侧上下文）
});

/** 深度硬上限（契约 §7.2「深度 ≤2」）。 */
export const MAX_DEPTH = 2;

/** 信号来源枚举（契约 §7.1）。 */
export const SIGNAL_KINDS = Object.freeze(['root-message', 'activity', 'user-explicit']);

/** 命中档位（契约 §7.2 的排序三档）。 */
export const HIT_KINDS = Object.freeze(['failure', 'constraint', 'claim']);

/** token 估法：CJK 1.5 字/token，ASCII 4 字/token（契约 §7.2 预算口径）。 */
export const TOKEN_RULE = Object.freeze({ cjkCharsPerToken: 1.5, asciiCharsPerToken: 4 });

/** 档位 → 排序序号（失败教训最先）。 */
export const CLASS_RANK = Object.freeze({ failure: 0, constraint: 1, claim: 2 });

// 主题 kind 的机械优先序（与 R04 topic 的 KIND_ORDER 同序；这里只做去通用性排序，
// 不复制 R04 的抽取逻辑，也不 import 它——本房间零依赖）。
const TOPIC_KIND_RANK = Object.freeze({
  repo: 0, scaffold: 1, dependency: 2, tool: 3, file: 4, domain: 5, error: 6, term: 7, goal: 8,
});

const HOP_DEDUPE_SEP = '\u0000';

/** walk 的错误类型（只在调用契约被破坏时抛）。 */
export class WalkError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'WalkError';
    this.code = code;
    if (details) this.details = details;
  }
}

// ---------------------------------------------------------------------------
// 基础工具（纯函数）
// ---------------------------------------------------------------------------

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampNumber(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

function clampInt(value, fallback, lo, hi) {
  const n = finiteNumber(value) ? Math.floor(value) : fallback;
  return clampNumber(n, lo, hi);
}

/** 深度 clamp：[1, MAX_DEPTH]（>2 按 2；≤0 抬到 1，直接命中总是做）。 */
export function clampDepth(depth) {
  const n = finiteNumber(depth) ? Math.floor(depth) : MAX_DEPTH;
  return clampNumber(n, 1, MAX_DEPTH);
}

// ---------------------------------------------------------------------------
// 作用域（方案 §4.10；与 R00 episode.scopeKey / R12 scopeKeyFromPath / R13 闸 1 同口径）
// ---------------------------------------------------------------------------

/** 路径体归一（= R00 normalizeWorkspace：反斜杠→正斜杠、盘符小写、去尾斜杠，不补根斜杠）。 */
function normalizeScopePath(value) {
  let s = String(value ?? '').trim().replace(/\\/g, '/');
  if (s === '') return '';
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(s);
  if (drive) s = `${drive[1].toLowerCase()}:${drive[2] ?? ''}`;
  if (s.length > 1 && s.endsWith('/')) s = s.replace(/\/+$/, '');
  return s;
}

/**
 * scopeKey 归一（与 R00 `normalizeWorkspace`、R13 `normalizeScope` 同口径）：
 *   `D:\Work\Demo` / `w:D:/Work/Demo/` → `w:d:/work/demo`；`u:Owner` → `u:owner`。
 * 空 ⇒ 返回 ''（= 未知，见 resolveScope）。
 */
export function normalizeScopeKey(scope) {
  const raw = String(scope ?? '').trim();
  if (raw === '') return '';
  if (raw.startsWith('u:')) return `u:${raw.slice(2)}`.toLowerCase();
  const body = raw.startsWith('w:') ? raw.slice(2) : raw;
  return `w:${normalizeScopePath(body)}`;
}

/** 未知哨兵：R00 的 `w:unknown`、R12 的 `w:<unknown>`、空体，都算"拿不到当前工作区"。 */
export function isUnknownScope(scope) {
  const normalized = normalizeScopeKey(scope);
  return normalized === '' || normalized === 'w:unknown' || normalized === 'w:<unknown>' || normalized === 'w:';
}

/**
 * 条目作用域在当前作用域下是否可见（方案 §4.10「显式祖先可见，默认不可见」）：
 *   - 完全相同 ⇒ 可见；
 *   - `u:` 用户层 ⇒ 任何 `w:` 作用域都可见；不同的 `u:` 之间不可见；
 *   - `w:` **只认完全相同**（不跨工作区）。注意 R13 闸 1 比本函数宽：它还允许「子看父」的
 *     路径前缀（`w:d:/work/repo/plugin` 看 `w:d:/work/repo`）。walk 更严格 ⇒ 只可能少给，
 *     不可能产出闸 1 判红的东西（测试里用一致性断言锁住这个方向）。
 *   - 缺 scopeKey / 未知哨兵 ⇒ 不可见（默认拒绝）。
 * @returns {boolean}
 */
export function isScopeVisible(entryScope, currentScope) {
  const entry = normalizeScopeKey(entryScope);
  const current = normalizeScopeKey(currentScope);
  if (entry === '' || current === '') return false;
  if (isUnknownScope(entry) || isUnknownScope(current)) return false;
  if (entry === current) return true;
  if (entry.startsWith('u:')) return current.startsWith('w:'); // 用户层对任意工作区可见
  return false;
}

/**
 * 解析当前作用域，优先级：`scope`(opts) > `signal.scope` > `signal.scopeKey` >
 * `store.scope` / `store.scopeKey` / `store.currentScope`。
 * 全都没有（或只有未知哨兵）⇒ 返回 null：walk 进降级模式（只放用户层，默认拒绝跨域）。
 * @returns {string|null} 归一后的 scopeKey
 */
export function resolveScope({ scope = null, signal = null, store = null } = {}) {
  const fromStore = store
    ? ['scope', 'scopeKey', 'currentScope']
      .map((key) => (typeof store[key] === 'string' ? store[key] : null))
      .find((value) => typeof value === 'string' && value.trim() !== '')
    : null;
  const candidates = [scope, signal?.scope, signal?.scopeKey, fromStore];
  for (const candidate of candidates) {
    const normalized = normalizeScopeKey(candidate);
    if (normalized !== '' && !isUnknownScope(normalized)) return normalized;
  }
  return null;
}

function isNonAscii(char) {
  return char.codePointAt(0) > 0x7f;
}

/**
 * token 估算（契约 §7.2 的预算口径）：CJK 1.5 字/token、ASCII 4 字/token。
 * 非 ASCII 一律按 CJK 口径（CJK 标点、全角符号也在其中，估高不估低）。
 * @param {string} text
 * @returns {number} 整数 token 估计
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0;
  let ascii = 0;
  for (const char of s) {
    if (isNonAscii(char)) cjk += 1;
    else ascii += 1;
  }
  return Math.ceil(cjk / TOKEN_RULE.cjkCharsPerToken + ascii / TOKEN_RULE.asciiCharsPerToken);
}

/** 单侧最小可比较长度：CJK 2 字（"记忆"算词），ASCII 3 字（避免 `ls`/`sh` 这种噪声）。 */
function minComparableLength(text) {
  return /[^\x00-\x7f]/.test(text) ? 2 : 3;
}

/** 词面重叠（机械包含匹配，两侧都过最小长度闸，防通用短词满图乱连）。 */
function overlaps(needle, key) {
  const x = String(needle ?? '').toLowerCase();
  const y = String(key ?? '').toLowerCase();
  if (x === '' || y === '') return false;
  if (x.length < minComparableLength(x) || y.length < minComparableLength(y)) return false;
  return x.includes(y) || y.includes(x);
}

function uniqueStrings(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    if (s === '') continue;
    const lower = s.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 信号归一
// ---------------------------------------------------------------------------

/**
 * 归一化信号（契约 §7.1）。宽容：terms / entities 不是数组时当空数组（不抛）。
 * 严格：signal 不是对象、或 kind 不在枚举里 ⇒ WalkError('walk/invalid-signal')。
 * @param {{kind?:string, terms?:string[], entities?:Array<{kind?:string,key:string}>, at?:number}} signal
 * @returns {{kind:string, terms:string[], entities:Array<{kind:string|null,key:string}>, at:number|null}}
 */
export function normalizeSignal(signal) {
  if (signal === null || typeof signal !== 'object' || Array.isArray(signal)) {
    throw new WalkError('walk: signal 必须是对象 {kind, terms, entities}', 'walk/invalid-signal');
  }
  const kind = typeof signal.kind === 'string' && signal.kind !== '' ? signal.kind : 'root-message';
  if (!SIGNAL_KINDS.includes(kind)) {
    throw new WalkError(
      `walk: 未知信号 kind "${kind}"（允许：${SIGNAL_KINDS.join(' / ')}）`,
      'walk/invalid-signal',
      { kind },
    );
  }
  const terms = uniqueStrings(signal.terms).slice(0, 64);
  const entities = [];
  for (const raw of Array.isArray(signal.entities) ? signal.entities.slice(0, 32) : []) {
    if (!raw || typeof raw !== 'object') continue;
    if (typeof raw.key !== 'string' || raw.key.trim() === '') continue;
    entities.push({
      kind: typeof raw.kind === 'string' && raw.kind !== '' ? raw.kind : null,
      key: raw.key.trim(),
    });
  }
  return { kind, terms, entities, at: finiteNumber(signal.at) ? signal.at : null };
}

// ---------------------------------------------------------------------------
// 主题匹配（signal → topics）
// ---------------------------------------------------------------------------

function betterMatch(candidate, previous) {
  if (candidate.score !== previous.score) return candidate.score > previous.score;
  if (candidate.matchedBy !== previous.matchedBy) return candidate.matchedBy === 'entity';
  return false;
}

function compareMatches(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.matchedBy !== b.matchedBy) return a.matchedBy === 'entity' ? -1 : 1;
  const dfA = finiteNumber(a.topic.df) ? a.topic.df : Number.MAX_SAFE_INTEGER;
  const dfB = finiteNumber(b.topic.df) ? b.topic.df : Number.MAX_SAFE_INTEGER;
  if (dfA !== dfB) return dfA - dfB; // 越稀有（df 小）越优先：判别性高的先跳
  const kindA = TOPIC_KIND_RANK[a.topic.kind] ?? 99;
  const kindB = TOPIC_KIND_RANK[b.topic.kind] ?? 99;
  if (kindA !== kindB) return kindA - kindB;
  if (a.topic.key !== b.topic.key) return a.topic.key < b.topic.key ? -1 : 1;
  return a.topic.id < b.topic.id ? -1 : 1;
}

/**
 * 信号 → 命中的主题（按判别性排序；同 id 只留最佳匹配）。
 * 匹配方式（全部机械）：
 *   - entity.key === topic.id            ⇒ 精确（score 1，`entity`）
 *   - entity.key === topic.key（且 kind 相同或未给 kind）⇒ 精确（score 1，`entity`）
 *   - entity.key 与 topic.key 词面包含    ⇒ 包含（score 0.6，`entity`）
 *   - term === topic.key                 ⇒ 精确（score 1，`term`）
 *   - term 与 topic.key 词面包含          ⇒ 包含（score 0.6，`term`）
 * 最小长度闸：CJK 2 字、ASCII 3 字（`ls` / `sh` 这类不参与）。
 * @param {{signal:object, topics:Array}} p
 * @returns {Array<{topic:object, score:number, matchedBy:'entity'|'term', input:string}>}
 */
export function matchTopics({ signal, topics = [], index = null } = {}) {
  const sig = normalizeSignal(signal);
  const list = (Array.isArray(topics) ? topics : [])
    .filter((t) => t && typeof t.id === 'string' && t.id !== '' && typeof t.key === 'string');
  const best = new Map();

  const consider = (topic, score, matchedBy, input) => {
    const candidate = { topic, score, matchedBy, input };
    const previous = best.get(topic.id);
    if (!previous || betterMatch(candidate, previous)) best.set(topic.id, candidate);
  };

  const exact = index ?? null;
  const seenExact = new Set();
  if (exact instanceof Map) {
    for (const entity of sig.entities) {
      const hit = exact.get(String(entity.key ?? '').toLowerCase());
      if (!hit) continue;
      for (const topic of hit) { consider(topic, 1, 'entity', entity.key); seenExact.add(topic.id); }
    }
    for (const term of sig.terms) {
      const hit = exact.get(String(term ?? '').toLowerCase());
      if (!hit) continue;
      for (const topic of hit) { consider(topic, 1, 'term', term); seenExact.add(topic.id); }
    }
  }
  for (const topic of list) {
    if (seenExact.has(topic.id)) continue;
    const topicKey = topic.key.toLowerCase();
    for (const entity of sig.entities) {
      if (entity.key === topic.id) {
        consider(topic, 1, 'entity', entity.key);
        continue;
      }
      if (entity.kind && entity.kind !== topic.kind) continue;
      if (entity.key.toLowerCase() === topicKey) consider(topic, 1, 'entity', entity.key);
      else if (overlaps(entity.key, topic.key)) consider(topic, 0.6, 'entity', entity.key);
    }
    for (const term of sig.terms) {
      if (term.toLowerCase() === topicKey) consider(topic, 1, 'term', term);
      else if (overlaps(term, topic.key)) consider(topic, 0.6, 'term', term);
    }
  }

  return [...best.values()].sort(compareMatches);
}

// ---------------------------------------------------------------------------
// 局部小工具（hit / 主题 / 时间）
// ---------------------------------------------------------------------------

/** 主题权重：idfNorm（0..1）；缺失时机械缺省 0.5。 */
function topicWeight(topic) {
  if (finiteNumber(topic?.idfNorm)) return clampNumber(topic.idfNorm, 0, 1);
  return 0.5;
}

/** 棋谱的命中档位（只看 signals 计数，无模型判断）。 */
function episodeHitClass(episode) {
  const failures = finiteNumber(episode?.signals?.failures) ? episode.signals.failures : 0;
  if (failures > 0) return 'failure';
  const constraints = finiteNumber(episode?.signals?.constraints) ? episode.signals.constraints : 0;
  if (constraints > 0) return 'constraint';
  return 'claim'; // 参考面（定式候选）
}

/** claim 的命中档位。 */
function claimHitClass(claim) {
  if (claim?.kind === 'antipattern') return 'failure';
  if (claim?.kind === 'preference') return 'constraint';
  return 'claim';
}

/**
 * 棋谱的 occurredAt（契约 §4.9：事件时间窗）：取窗右端 lastEventAt（最近发生的证据），
 * 缺失时依次回落 endedAt → startedAt → firstEventAt；全缺返回 null（"无时不入"）。
 */
function episodeTime(episode) {
  for (const value of [episode?.lastEventAt, episode?.endedAt, episode?.startedAt, episode?.firstEventAt]) {
    if (finiteNumber(value)) return value;
  }
  return null;
}

/** claim 的 occurredAt：自身 → 首条 support → 依附棋谱；全缺返回 null。 */
function claimTime(claim, attachedHit) {
  const candidates = [
    claim?.occurredAt,
    Array.isArray(claim?.support) ? claim.support.find((s) => s && finiteNumber(s.occurredAt))?.occurredAt : null,
    attachedHit?.occurredAt,
  ];
  for (const value of candidates) if (finiteNumber(value)) return value;
  return null;
}

/** 折叠进父局的子代理局不独立成记忆节点（AGENTS §4.1；陷阱 10）。 */
function isFolded(episode) {
  return typeof episode?.state === 'string' && episode.state.startsWith('folded-into');
}

/** 入馆后被判作废的 claim 不再作为指针（不改写、不删除，只是不注入）。 */
function isInvalidated(claim) {
  return claim?.state === 'invalidated';
}

/** 单条命中的 token 文本（估的就是将来要注入的那点内容：指针 + why + 一句话）。 */
function hitTokenText(hit) {
  return [hit.episode ?? '', hit.claim ?? '', hit.kind, hit.why.join(' '), hit.text ?? '']
    .filter((part) => part !== '' && part !== null && part !== undefined)
    .join(' ');
}

function hitTokens(hit) {
  return estimateTokens(hitTokenText(hit));
}

/** 错误原文归一（只做路径/空白替换，用于失败与 claim 的机械匹配；不参与渲染）。 */
function squashErrorText(text) {
  return String(text ?? '')
    .replace(/"[A-Za-z]:[\/][^"]*"/g, '"<path>"')
    .replace(/(?:[A-Za-z]:[\/])[^\s"',;)]*/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 跨局重复次数：claim.support 里不同 episode 的数量（D3，2026-11-02）。 */
function supportEpisodeCount(claim) {
  const support = Array.isArray(claim?.support) ? claim.support : [];
  const ids = new Set();
  for (const item of support) {
    const id = String(item?.episode ?? '');
    if (id) ids.add(id);
  }
  return ids.size || 1;
}

function hopKeyOf(hop) {
  return [hop.kind, hop.from, hop.to, Array.isArray(hop.why) ? hop.why.join(',') : ''].join(HOP_DEDUPE_SEP);
}

/** 排序：档位 → depth 升序 → **跨局重复次数降序** → weight 降序 → occurredAt 降序 → 标识升序。 */
export function compareHits(a, b) {
  const classA = CLASS_RANK[a.kind] ?? 9;
  const classB = CLASS_RANK[b.kind] ?? 9;
  if (classA !== classB) return classA - classB;
  if (a.depth !== b.depth) return a.depth - b.depth;
  const repeatA = finiteNumber(a.repeat) ? a.repeat : 1;
  const repeatB = finiteNumber(b.repeat) ? b.repeat : 1;
  if (repeatB !== repeatA) return repeatB - repeatA;
  if (b.weight !== a.weight) return b.weight - a.weight;
  const timeA = finiteNumber(a.occurredAt) ? a.occurredAt : Number.NEGATIVE_INFINITY;
  const timeB = finiteNumber(b.occurredAt) ? b.occurredAt : Number.NEGATIVE_INFINITY;
  if (timeA !== timeB) return timeB - timeA;
  if (a.episode !== b.episode) return String(a.episode ?? '') < String(b.episode ?? '') ? -1 : 1;
  const claimA = String(a.claim ?? '');
  const claimB = String(b.claim ?? '');
  if (claimA !== claimB) return claimA < claimB ? -1 : 1;
  return 0;
}

/** 一跳（link）的排序：优先「换了话题」的边（t2 ≠ 起始主题），其次权重、目标 id。 */
function compareHops(a, b) {
  if (a.fresh !== b.fresh) return a.fresh ? -1 : 1;
  if (b.weight !== a.weight) return b.weight - a.weight;
  if (a.to !== b.to) return a.to < b.to ? -1 : 1;
  return String(a.link ?? '') < String(b.link ?? '') ? -1 : 1;
}

/**
 * hit 上回显的 scopeKey：**归一后**的写法（与 R00/R13 同口径；store 里可能是 `w:D:\work\demo`
 * 这种别名写法，回显原文会让消费方误判成"另一个作用域"）。
 */
function recordScopeKey(record) {
  const normalized = normalizeScopeKey(typeof record?.scopeKey === 'string' ? record.scopeKey : '');
  return normalized === '' ? null : normalized;
}

/** 对外暴露的 hit（内部用的 via / followedLinks / direct 不外泄）。 */
function publicHit(hit) {
  const out = {
    episode: hit.episode ?? null,
    link: hit.link ?? null,
    why: [...hit.why],
    weight: hit.weight,
    occurredAt: hit.occurredAt,
    kind: hit.kind,
    depth: hit.depth,
    tokens: hit.tokens,
  };
  if (hit.nodeId) out.nodeId = hit.nodeId;
  if (finiteNumber(hit.seq)) out.seq = hit.seq; // 回放行（claim 的 support.seq / 棋谱首次 mention 的 seq）
  if (hit.claim) {
    out.claim = hit.claim; // claim id（调用方拿它去 claims/<id>.json 取原文）
    if (hit.claimKind) out.claimKind = hit.claimKind; // fact / rule / antipattern / preference / pattern
    if (hit.claimState) out.claimState = hit.claimState; // observed / candidate / semantic / disputed / stale
  }
  if (hit.text) out.text = hit.text;
  if (hit.scopeKey) out.scopeKey = hit.scopeKey;
  if (finiteNumber(hit.repeat)) out.repeat = hit.repeat;
  if (hit.fix && typeof hit.fix === 'object' && typeof hit.fix.quote === 'string') out.fix = hit.fix; // D3：跨局重复次数（>1 表示反复踩过的坑）
  return out;
}

function readRecords(store, kind) {
  const rows = store.list(kind);
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => (row && typeof row === 'object' ? row.record : null))
    .filter((record) => record && typeof record === 'object' && typeof record.id === 'string' && record.id !== '');
}

/**
 * 预热缓存：一次读出 walk 需要的四类记录，后续 walk 直接吃内存（M5 延迟修复）。
 * 不改变 walk 的语义；store 变化后需重建缓存（调用方负责失效）。
 */
export function createWalkCache(store) {
  if (!store || typeof store.list !== 'function') return null;
  const topics = readRecords(store, 'topics');
  const topicsByKey = new Map();
  for (const t of topics) {
    if (!t || typeof t.key !== 'string') continue;
    const k = t.key.toLowerCase();
    if (!topicsByKey.has(k)) topicsByKey.set(k, []);
    topicsByKey.get(k).push(t);
  }
  const episodes = readRecords(store, 'episodes');
  const links = readRecords(store, 'links');
  const claims = readRecords(store, 'claims');
  const byId = new Map();
  for (const [kind, arr] of [['episodes', episodes], ['topics', topics], ['links', links], ['claims', claims]]) {
    for (const rec of arr) {
      if (rec && typeof rec.id === 'string') byId.set(`${kind}:${rec.id}`, rec);
    }
  }
  return Object.freeze({
    episodes,
    topics,
    topicsByKey,
    links,
    claims,
    get(kind, id) {
      return byId.get(`${kind}:${id}`) ?? null;
    },
  });
}

// ---------------------------------------------------------------------------
// walkFromSignals
// ---------------------------------------------------------------------------

/**
 * 顺藤摸瓜（只读）。
 * @param {object} opts
 * @param {object} opts.signal   信号（契约 §7.1）
 * @param {object} opts.store    R15 store（只用 list()）
 * @param {string} [opts.scope]  当前作用域（scopeKey）；缺省依次取 signal.scope / signal.scopeKey /
 *                               store.scope|scopeKey|currentScope；全缺 ⇒ 只放 `u:` 用户层（默认拒绝跨域）
 * @param {number} [opts.depth=2]        最大跳数（clamp 到 1..2）
 * @param {number} [opts.limit=5]        最多几条命中
 * @param {number} [opts.budgetTokens=500] 命中总 token 上限
 * @param {number} [opts.maxTopics=8]    一次信号最多匹配几个主题
 * @param {number} [opts.maxHops=40]     path 最多几跳
 * @returns {object} {hits, path, omitted, tokens, maxDepth, depth, scope, matched, dropped, signal}
 */
export function walkFromSignals(opts = {}) {
  const { signal, store, cache = null } = opts ?? {};
  if (!store || typeof store.list !== 'function') {
    throw new WalkError('walk: 需要只读 store（R15 createStore 的 list/get）', 'walk/invalid-store');
  }
  const sig = normalizeSignal(signal);
  const currentScope = resolveScope({ scope: opts.scope ?? null, signal, store });
  const scopeMode = currentScope ? 'same-scope+user-layer' : 'user-layer-only';
  const maxDepth = clampDepth(opts.depth);
  const hitLimit = clampInt(opts.limit, WALK_DEFAULTS.limit, 0, 1000);
  const budgetTokens = clampInt(opts.budgetTokens, WALK_DEFAULTS.budgetTokens, 0, 1000000);
  const maxTopics = clampInt(opts.maxTopics, WALK_DEFAULTS.maxTopics, 1, 500);
  const maxHops = clampInt(opts.maxHops, WALK_DEFAULTS.maxHops, 1, 5000);

  const dropped = {
    noTopic: 0, // 匹配到的主题没挂任何可用棋谱
    topicsOverCap: 0, // 主题数被 maxTopics 砍掉
    folded: 0, // folded-into 的子代理局（不独立成谱）
    crossScope: 0, // 跨工作区（scopeKey 不匹配且不是 u: 层）⇒ 不进 hits
    scopeMissing: 0, // 缺 scopeKey / 未知哨兵（无法证明同域）⇒ 不进 hits
    noTime: 0, // 缺 occurredAt（"无时不入"）
    invalidated: 0, // 已作废的 claim
    unconnected: 0, // claim 既没依附命中棋谱、也不命中主题 key
    hopNoWhy: 0, // 没有 why 的边（不跳：每跳必须有 why）
    hopCap: 0, // path 超过 maxHops 被砍
  };

  // 作用域闸：**候选入 hits 之前**判定（同一条目只计一次，避免多路到达重复计数）
  const deniedScope = new Map(); // id → 'crossScope' | 'scopeMissing'
  const allowRecord = (record, id) => {
    const entryScope = typeof record?.scopeKey === 'string' ? record.scopeKey : '';
    const normalized = normalizeScopeKey(entryScope);
    let reason = null;
    if (normalized === '' || isUnknownScope(normalized)) reason = 'scopeMissing';
    else if (currentScope === null) reason = normalized.startsWith('u:') ? null : 'crossScope';
    else if (!isScopeVisible(normalized, currentScope)) reason = 'crossScope';
    if (reason === null) return true;
    if (!deniedScope.has(id)) deniedScope.set(id, reason);
    return false;
  };

  const topics = cache?.topics ?? readRecords(store, 'topics');
  // S9（2026-11-02 自裁，依据 evidence/M4-precision.md）：泛工具主题不做"起跳种子"。
  // 30 个 df 最高 key 里 19 个是 kind=tool（echo/grep/bash/ls/git），tool 种子命中行仅 17.65% 有用；
  // 过滤后 hopPrecision 50.38% → 87.38%（零注入 14.29% → 34.29%）。显式实体（用户点名某工具）仍可起跳。
  const matches = matchTopics({ signal: sig, topics })
    .filter((m) => m.topic.kind !== 'tool' || m.matchedBy === 'entity');
  dropped.topicsOverCap = Math.max(0, matches.length - maxTopics);
  const picked = matches.slice(0, maxTopics);

  const emptyResult = () => ({
    hits: [],
    path: [],
    omitted: { count: 0, reason: null, byLimit: 0, byBudget: 0, crossScope: 0 },
    tokens: 0,
    maxDepth,
    depth: maxDepth,
    scope: { current: currentScope, mode: scopeMode },
    matched: {
      topics: picked.map((m) => ({
        id: m.topic.id,
        kind: m.topic.kind,
        key: m.topic.key,
        df: finiteNumber(m.topic.df) ? m.topic.df : null,
        matchedBy: m.matchedBy,
        score: m.score,
        input: m.input,
      })),
      truncated: dropped.topicsOverCap,
    },
    dropped,
    signal: { kind: sig.kind, terms: [...sig.terms], entities: sig.entities.map((e) => ({ ...e })), at: sig.at },
  });

  if (picked.length === 0) {
    dropped.noTopic += 1;
    return emptyResult();
  }

  const matchedKeys = new Set(picked.map((m) => m.topic.key));
  const episodes = cache?.episodes ?? readRecords(store, 'episodes');
  const topicById = new Map(topics.map((t) => [t.id, t]));
  const episodeById = new Map(episodes.map((e) => [e.id, e]));

  const episodeHits = new Map();
  const claimHits = new Map();
  const foldedSeen = new Set();

  const mergeWhy = (target, extra) => {
    for (const key of Array.isArray(extra) ? extra : []) {
      if (typeof key === 'string' && key !== '' && !target.includes(key)) target.push(key);
    }
  };

  const addVia = (hit, hop) => {
    if (!hop || typeof hop.from !== 'string' || typeof hop.to !== 'string') return;
    const why = Array.isArray(hop.why) ? hop.why.filter((k) => typeof k === 'string' && k !== '') : [];
    if (why.length === 0) return; // 每跳必须有 why：无 why 的跳不成立
    const key = hopKeyOf({ ...hop, why });
    if (hit._viaKeys.has(key)) return;
    hit._viaKeys.add(key);
    const clean = { kind: hop.kind, from: hop.from, to: hop.to, why };
    if (hop.link) clean.link = hop.link;
    if (hop.new !== undefined) clean.new = hop.new;
    hit.via.push(clean);
  };

  const makeHit = (fields) => ({
    episode: fields.episode ?? null,
    nodeId: fields.nodeId ?? null,
    claim: fields.claim ?? null,
    claimKind: fields.claimKind ?? null,
    claimState: fields.claimState ?? null,
    link: fields.link ?? null,
    why: Array.isArray(fields.why) ? [...fields.why] : [],
    weight: finiteNumber(fields.weight) ? fields.weight : 0,
    occurredAt: finiteNumber(fields.occurredAt) ? fields.occurredAt : null,
    seq: finiteNumber(fields.seq) ? fields.seq : null,
    kind: fields.kind,
    depth: fields.depth,
    repeat: finiteNumber(fields.repeat) ? fields.repeat : null,
    text: typeof fields.text === 'string' ? fields.text : '',
    scopeKey: fields.scopeKey ?? null,
    tokens: 0,
    _direct: Boolean(fields.direct),
    _viaKeys: new Set(),
    via: [],
    followedLinks: [],
  });

  const upsertEpisodeHit = (episode, incoming) => {
    const prev = episodeHits.get(episode.id);
    if (!prev) {
      const hit = makeHit({
        episode: episode.id,
        link: incoming.direct ? null : (incoming.link ?? null),
        why: incoming.why,
        weight: incoming.weight,
        occurredAt: episodeTime(episode),
        seq: incoming.seq,
        kind: episodeHitClass(episode),
        depth: incoming.depth,
        text: typeof episode.l0 === 'string' ? episode.l0.trim() : '',
        scopeKey: recordScopeKey(episode),
        direct: incoming.direct,
      });
      for (const hop of Array.isArray(incoming.via) ? incoming.via : []) addVia(hit, hop);
      hit.tokens = hitTokens(hit);
      episodeHits.set(episode.id, hit);
      return hit;
    }
    mergeWhy(prev.why, incoming.why);
    prev.weight = Math.max(prev.weight, finiteNumber(incoming.weight) ? incoming.weight : 0);
    prev.depth = Math.min(prev.depth, incoming.depth);
    if (incoming.direct) {
      prev._direct = true;
      prev.link = null;
    } else if (!prev._direct && incoming.link) {
      prev.link = prev.link ?? incoming.link;
    }
    if (!finiteNumber(prev.seq) && finiteNumber(incoming.seq)) prev.seq = incoming.seq;
    for (const hop of Array.isArray(incoming.via) ? incoming.via : []) addVia(prev, hop);
    prev.tokens = hitTokens(prev);
    return prev;
  };

  /** 棋谱记录里该主题的首个 mention seq（回放行用；store 里没有 occurrences 时返回 null）。 */
  const firstMentionSeq = (episode, topicId) => {
    for (const entry of Array.isArray(episode?.topics) ? episode.topics : []) {
      if (!entry || entry.id !== topicId) continue;
      for (const occurrence of Array.isArray(entry.occurrences) ? entry.occurrences : []) {
        if (finiteNumber(occurrence?.seq)) return occurrence.seq;
      }
    }
    return null;
  };

  // ---- 第 1 跳：主题 → 棋谱（直接命中）----
  const topicEpisodes = new Map();
  for (const topic of topics) {
    if (Array.isArray(topic.episodes)) {
      topicEpisodes.set(topic.id, topic.episodes.filter((id) => typeof id === 'string' && id !== ''));
    }
  }
  for (const match of picked) {
    const holders = new Set(topicEpisodes.get(match.topic.id) ?? []);
    for (const episode of episodes) {
      if (!Array.isArray(episode.topics)) continue;
      if (episode.topics.some((t) => t && t.id === match.topic.id)) holders.add(episode.id);
    }
    const weight = topicWeight(match.topic);
    for (const episodeId of [...holders].sort()) {
      const episode = episodeById.get(episodeId);
      if (!episode) continue;
      if (!allowRecord(episode, `episodes:${episodeId}`)) continue; // 作用域闸：跨域/无域不入 hits
      if (isFolded(episode)) {
        if (!foldedSeen.has(episodeId)) {
          foldedSeen.add(episodeId);
          dropped.folded += 1;
        }
        continue;
      }
      const occurredAt = episodeTime(episode);
      if (!finiteNumber(occurredAt)) {
        dropped.noTime += 1;
        continue;
      }
      upsertEpisodeHit(episode, {
        depth: 1,
        why: [match.topic.key],
        weight,
        link: null,
        direct: true,
        seq: firstMentionSeq(episode, match.topic.id),
        via: [
          { kind: 'match', from: 'signal', to: match.topic.id, why: [match.topic.key] },
          { kind: 'mention', from: match.topic.id, to: episodeId, why: [match.topic.key] },
        ],
      });
    }
  }

  // ---- 第 2 跳：棋谱 → 相关棋谱（store links；每跳必须有 why）----
  if (maxDepth >= 2) {
    const links = cache?.links ?? readRecords(store, 'links');
    const adjacency = new Map();
    const linkWhyKeys = (link) => {
      const keys = [];
      for (const topicId of Array.isArray(link.topics) ? link.topics : []) {
        if (typeof topicId !== 'string' || topicId === '') continue;
        const key = topicById.get(topicId)?.key ?? null;
        if (key && !keys.includes(key)) keys.push(key);
      }
      if (keys.length === 0 && typeof link.why === 'string') {
        for (const part of link.why.split(',')) {
          const key = part.trim();
          if (key !== '' && !keys.includes(key)) keys.push(key);
        }
      }
      return keys;
    };

    for (const link of links) {
      const a = link?.a?.episode;
      const b = link?.b?.episode;
      if (typeof a !== 'string' || typeof b !== 'string' || a === b) continue;
      const why = linkWhyKeys(link);
      if (why.length === 0) {
        dropped.hopNoWhy += 1; // 没有 why 的边不跳（契约：每跳必须有 why）
        continue;
      }
      const weight = finiteNumber(link.weight) ? link.weight : 0;
      const fresh = why.some((key) => !matchedKeys.has(key));
      for (const [from, to] of [[a, b], [b, a]]) {
        if (!adjacency.has(from)) adjacency.set(from, []);
        adjacency.get(from).push({ from, to, why, weight, fresh, link: typeof link.id === 'string' ? link.id : null });
      }
    }
    for (const list of adjacency.values()) list.sort(compareHops);

    const frontier = [...episodeHits.values()]
      .filter((hit) => !hit.claim && hit.depth === 1)
      .sort((x, y) => (x.episode < y.episode ? -1 : x.episode > y.episode ? 1 : 0));

    for (const parent of frontier) {
      for (const hop of adjacency.get(parent.episode) ?? []) {
        const target = episodeById.get(hop.to);
        if (!target || isFolded(target)) continue;
        // 作用域闸放在 followedLinks 之前：跨域棋谱连"相关边"都不留（path 里也不出现）
        if (!allowRecord(target, `episodes:${hop.to}`)) continue;
        parent.followedLinks.push({ to: hop.to, why: [...hop.why], link: hop.link });
        const occurredAt = episodeTime(target);
        if (!finiteNumber(occurredAt)) {
          dropped.noTime += 1;
          continue;
        }
        const existed = episodeHits.has(hop.to);
        upsertEpisodeHit(target, {
          depth: 2,
          why: hop.why,
          weight: hop.weight,
          link: hop.link,
          direct: false,
          // 已直接命中过的棋谱不再加跳（它的 why 已合并），只留 followedLinks 供 path 用
          via: existed ? null : [
            ...parent.via,
            { kind: 'link', from: parent.episode, to: hop.to, why: hop.why, link: hop.link, new: true },
          ],
        });
      }
    }
  }

  // ---- claim：依附命中棋谱（机械：support.episode 已在命中里）或文本命中主题 key ----
  const claims = cache?.claims ?? readRecords(store, 'claims');
  for (const claim of claims) {
    if (isInvalidated(claim)) {
      dropped.invalidated += 1;
      continue;
    }
    // 入馆时 validity 核验失败（validityOk=false）⇒ 不进卡片：过期条目要么改写、要么只留指针，
    // 不能当当前事实注入（A1 负迁移 8.33% 的样本就是这类，2026-11-02）。
    if (claim.validityOk === false) {
      dropped.stale = (dropped.stale ?? 0) + 1;
      continue;
    }
    const text = typeof claim.text === 'string' ? claim.text.trim() : '';
    // D3（2026-11-02）：失败命中若与某条 claim 的错误原文互相包含，就把 claim 挂上去，
    // 并把「跨局重复次数」带到失败命中上——排序据此把反复出现的坑排到最前。
    if (text.length >= 12) {
      const claimText = squashErrorText(text);
      for (const [, hit] of episodeHits) {
        if (hit.kind !== 'failure' || !hit.text || hit.text.length < 12) continue;
        const hitText = squashErrorText(hit.text);
        if (!(claimText.includes(hitText) || hitText.includes(claimText))) continue;
        if (!hit.repeat || hit.repeat < supportEpisodeCount(claim)) hit.repeat = supportEpisodeCount(claim);
      }
    }
    const kind = claimHitClass(claim);
    const support = Array.isArray(claim.support)
      ? claim.support.filter((entry) => entry && typeof entry.episode === 'string')
      : [];

    // 2026-11-02（A2b 修复）：同一条 claim 常有多局支撑；优先用**与当前作用域相同**的那局做
    // 证据载体——否则卡片显示的总是"别的工作区那条"，用户看到的日期/棋谱对不上自己的项目。
    const orderedSupport = currentScope === null
      ? support
      : [...support].sort((x, y) => {
        const sx = normalizeScopeKey(episodeById.get(x.episode)?.scopeKey ?? '') === currentScope ? 0 : 1;
        const sy = normalizeScopeKey(episodeById.get(y.episode)?.scopeKey ?? '') === currentScope ? 0 : 1;
        return sx - sy;
      });
    let attached = null;
    let attachedDepth = Number.POSITIVE_INFINITY;
    let attachedNodeId = null;
    let attachedSeq = null;
    for (const entry of orderedSupport) {
      const hit = episodeHits.get(entry.episode);
      if (!hit || hit.depth >= attachedDepth) continue;
      // 作用域闸也看**承载证据的棋谱**：u: 层 claim 可能由别的工作区支撑，
      // 直接挂在跨域棋谱上会让卡片出现越界行（A5 独立复核 = 9 行，2026-11-02）。
      const evidenceEpisode = episodeById.get(entry.episode);
      // 当前无作用域（只放用户层）时不做这条检查：u: 层本来就是全局可见。
      if (currentScope !== null && evidenceEpisode && !allowRecord(evidenceEpisode, `episodes:${entry.episode}`)) continue;
      attached = hit;
      attachedDepth = hit.depth;
      attachedNodeId = typeof entry.nodeId === 'string' && entry.nodeId !== '' ? entry.nodeId : null;
      attachedSeq = finiteNumber(entry.seq) ? entry.seq : null;
    }

    const occurredAt = claimTime(claim, attached);
    if (!finiteNumber(occurredAt)) {
      dropped.noTime += 1;
      continue;
    }

    if (attached) {
      // 作用域闸放在"已确认相关"之后：omitted.crossScope 只数本来会进 hits 的相关条目
      if (!allowRecord(claim, `claims:${claim.id}`)) continue;
      const hit = makeHit({
        episode: attached.episode,
        nodeId: attachedNodeId,
        claim: claim.id,
        claimKind: typeof claim.kind === 'string' ? claim.kind : null,
        claimState: typeof claim.state === 'string' ? claim.state : null,
        link: null,
        why: [...attached.why],
        weight: attached.weight,
        occurredAt,
        seq: attachedSeq,
        kind,
        depth: attached.depth,
        text,
        scopeKey: recordScopeKey(claim),
        repeat: supportEpisodeCount(claim),
        direct: false,
      });
      for (const hop of attached.via) addVia(hit, hop);
      addVia(hit, {
        kind: 'claim',
        from: attached.episode,
        to: claim.id,
        why: [...attached.why],
      });
      hit.tokens = hitTokens(hit);
      claimHits.set(claim.id, hit);
      continue;
    }

    // 依附不到已命中的棋谱 ⇒ 只剩一条机械通路：claim 文本里出现命中的主题 key
    let textMatch = null;
    for (const match of picked) {
      if (overlaps(match.topic.key, text)) {
        textMatch = match;
        break;
      }
    }
    if (!textMatch) {
      // 第二条机械通路：claim 文本直接含信号里的判别性词（S10，2026-11-02）。
      // 没有这条，带 validity 的 claim 只能经 support 的棋谱到达；跨站时永远走不到 ⇒ H1 无消费者。
      for (const term of sig.terms) {
        if (overlaps(term, text)) {
          textMatch = { topic: { id: `signal:${term}`, key: term, kind: 'term', df: null }, score: 0.5 };
          break;
        }
      }
      for (const entity of sig.entities) {
        if (overlaps(entity.key, text)) {
          textMatch = { topic: { id: `signal:${entity.key}`, key: entity.key, kind: entity.kind ?? 'term', df: null }, score: 0.5 };
          break;
        }
      }
    }
    // N2（2026-11-02）实测：单条词的兜底（S10）已经在上面生效，多词分支是死代码，
    // 已回退；A2 的 +0.36pp 复查为语料刷新噪声，不归因于本次改动（见 evidence/M7-N2-rejected.md）。
    if (!textMatch) {
      dropped.unconnected += 1;
      continue;
    }
    if (!allowRecord(claim, `claims:${claim.id}`)) continue;
    // 同一条规则：文本命中的 claim 也必须用**同作用域**的证据棋谱承载。
    const visibleSupport = support.find((entry) => {
      const ep = episodeById.get(entry.episode);
      if (ep === undefined) return false;
      return currentScope === null || allowRecord(ep, `episodes:${entry.episode}`);
    });
    if (!visibleSupport) {
      dropped.crossScope += 1;
      continue;
    }
    const hit = makeHit({
      episode: visibleSupport.episode,
      nodeId: typeof visibleSupport.nodeId === 'string' && visibleSupport.nodeId !== '' ? visibleSupport.nodeId : null,
      claim: claim.id,
      claimKind: typeof claim.kind === 'string' ? claim.kind : null,
      claimState: typeof claim.state === 'string' ? claim.state : null,
      link: null,
      why: [textMatch.topic.key],
      weight: topicWeight(textMatch.topic),
      occurredAt,
      seq: finiteNumber(visibleSupport.seq) ? visibleSupport.seq : null,
      kind,
      depth: 1,
      text,
      scopeKey: recordScopeKey(claim),
      repeat: supportEpisodeCount(claim),
      direct: true,
    });
    addVia(hit, { kind: 'match', from: 'signal', to: textMatch.topic.id, why: [textMatch.topic.key] });
    addVia(hit, { kind: 'claim', from: textMatch.topic.id, to: claim.id, why: [textMatch.topic.key] });
    hit.tokens = hitTokens(hit);
    claimHits.set(claim.id, hit);
  }

  // ---- 排序 + 前缀式截断（limit / budget）----
  const candidates = [...episodeHits.values(), ...claimHits.values()].sort(compareHits);
  const selected = [];
  let tokens = 0;
  let byLimit = 0;
  let byBudget = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    const hit = candidates[i];
    if (selected.length >= hitLimit) {
      byLimit = candidates.length - i;
      break;
    }
    if (tokens + hit.tokens > budgetTokens) {
      byBudget = candidates.length - i;
      break;
    }
    selected.push(hit);
    tokens += hit.tokens;
  }
  const reason = byLimit > 0 && byBudget > 0 ? 'limit+budget' : byLimit > 0 ? 'limit' : byBudget > 0 ? 'budget' : null;

  // 作用域闸的计数落账（同一条目只计一次；跨域与缺域分开，便于审计是谁被挡下的）
  for (const [, deniedBy] of deniedScope) {
    if (deniedBy === 'crossScope') dropped.crossScope += 1;
    else dropped.scopeMissing += 1;
  }
  const crossScope = dropped.crossScope + dropped.scopeMissing;

  // ---- 证据路径（每跳必须有 why；无 why 的跳不入 path）----
  const path = [];
  const seenHops = new Set();
  const pushHop = (hop) => {
    if (!hop || typeof hop.from !== 'string' || typeof hop.to !== 'string') return;
    const why = Array.isArray(hop.why) ? hop.why.filter((k) => typeof k === 'string' && k !== '') : [];
    if (why.length === 0) return;
    const key = hopKeyOf({ ...hop, why });
    if (seenHops.has(key)) return;
    if (path.length >= maxHops) {
      dropped.hopCap += 1;
      return;
    }
    seenHops.add(key);
    const entry = { from: hop.from, to: hop.to, why, kind: hop.kind };
    if (hop.link) entry.link = hop.link;
    if (hop.new !== undefined) entry.new = hop.new;
    path.push(entry);
  };
  for (const hit of selected) for (const hop of hit.via) pushHop(hop);

  // 两端都入选的棋谱，即使"已经命中"也把那条相关边记进 path：
  // 「为什么相关」必须可查（契约：每一跳必须有 why）。
  const selectedEpisodes = new Set(selected.filter((hit) => !hit.claim).map((hit) => hit.episode));
  for (const hit of selected) {
    if (hit.claim) continue;
    for (const followed of hit.followedLinks) {
      if (!selectedEpisodes.has(followed.to)) continue;
      if (!(hit.episode < followed.to)) continue; // 只记一个方向，避免 path 里出现互为镜像的两跳
      pushHop({ kind: 'link', from: hit.episode, to: followed.to, why: followed.why, link: followed.link, new: false });
    }
  }

  return {
    hits: selected.map(publicHit),
    path,
    omitted: { count: byLimit + byBudget, reason, byLimit, byBudget, crossScope },
    tokens,
    maxDepth,
    depth: maxDepth, // 别名：R13 闸 6b 直接读 result.depth（≤2）
    scope: { current: currentScope, mode: scopeMode },
    matched: {
      topics: picked.map((m) => ({
        id: m.topic.id,
        kind: m.topic.kind,
        key: m.topic.key,
        df: finiteNumber(m.topic.df) ? m.topic.df : null,
        matchedBy: m.matchedBy,
        score: m.score,
        input: m.input,
      })),
      truncated: dropped.topicsOverCap,
    },
    dropped,
    signal: { kind: sig.kind, terms: [...sig.terms], entities: sig.entities.map((e) => ({ ...e })), at: sig.at },
  };
}

export default {
  walkFromSignals,
  createWalkCache,
  matchTopics,
  normalizeSignal,
  estimateTokens,
  clampDepth,
  normalizeScopeKey,
  isScopeVisible,
  resolveScope,
  WalkError,
  WALK_DEFAULTS,
  MAX_DEPTH,
  SIGNAL_KINDS,
  HIT_KINDS,
  TOKEN_RULE,
  CLASS_RANK,
};

// 仅供调试：把一条 hit 压成一行（不参与 walk 逻辑，不写盘）
export function describeHit(hit) {
  return `${hit.episode ?? '(无棋谱)'}${hit.claim ? ` ${hit.claim}` : ''} [${hit.kind} d${hit.depth} w=${hit.weight}] ${hit.why.join(', ')}`;
}


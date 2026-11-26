// R12 卡片产物 —— 渲染 + token 预算裁剪（task-11 / 重构 B 期拆出；task-14 / G 期再切一刀，判据一个都没改）
//
// 四房分工（`inject.mjs` 仍是转发垫片，导出面一字不变）：
//   `inject-gate.mjs`     —— 十道闸的**判据**（作用域/预算/来源/指令式的单源实现）
//   `inject-card.mjs`     —— **本文件**：hit → 记忆行 → 记忆卡（渲染 + 预算裁剪）
//   `inject-recovery.mjs` —— 取数与记录：信号 / store 视图 / 降级 walk / 恢复事实 / trial / 影子 / CLI
//   `inject-slot.mjs`     —— 槽位幂等（`{slotId, contentHash, seq}` 持久账本）
//
// 本房只剩两块（task-14，判据一字未改，只搬家）：
//   ① 卡片渲染 + token 预算：`renderIndexLine` / `displayPath` / `renderEntryLine` / `renderSection` /
//      `CLIP_STEPS` / `buildMemoryCard`，以及三级交付的指针档（`isPointerCandidate` / `pointerBodyOf` /
//      `tierOf` / `POINTER_BODY_RE` / `POINTER_TIER_DEFAULT`）。
//   ② entry 构造（hit → 一条记忆行）：`buildEntry` / `entryFromClaim` / `entryFromEpisode` / `pickClaim` /
//      `collectEntries` / `compareEntries` + 合并节点折叠（`collapseMergeNodes` 一族）。
//   ③④⑤（恢复事实 / trial / 影子记录 + `inject` CLI）搬进了 `inject-recovery.mjs`；本文件把它们
//   **按固定名单原样转出**（见 import 段末尾的 `export { … } from`），所以本房与垫片的导出面搬前搬后逐键逐值相同。
//
// 房间契约（docs/数据契约.md §7.3、方案.md §7.2/§7.3、docs/记忆的职责边界.md §1/§2/§4/§5）：
//   职责  把 walk 命中渲染成**模型可见**的两段：恒一行的 `indexLine` + 命中的 `section`；
//         并在 **token 预算**内收敛（放不下就丢弃并如实计数）。
//   输入  walk 结果（`{hits, path, omitted, tokens, depth}`）+ store（只读 list/get/counts）+ 信号。
//   错误  `buildMemoryCard` 不抛（坏条目跳过、缺源不入）；`writeShadow` 抛 `InjectError`（住在取数房）。
//   依赖  node:path + `inject-gate.mjs` + `inject-recovery.mjs` + topic/sigindex/extract/abstain。
//
// 预算裁剪的判据（上游 LlamaIndex `Memory.token_limit` 的做法，见 docs/优化方案-对标市场记忆系统.md）：
//   · 预算按 **token** 算（`estimateTokens`，CJK 1.5 字/token），闸值取自 `limits.mjs` 的 `BUDGET_TOKENS`（500）；
//   · 放不下时 **整条丢弃**（`renderSection` 逐条累加，超了就停，剩余全部进 `omitted` 并写明"少几条 + 去哪取"），
//     **不把一条记忆截成半句**后仍当成一条事实 —— 半句会破坏 provenance 的逐字核对（闸 0 / 闸 5）。
//   · `clipLine`（160 → 60 两级 CLIP_STEPS）是**降表示**这一步的字符收敛，先于预算判定，两条路径分开：
//     降表示 = 同一条事实换个说法（日期、出处、坐标一概不丢）；预算不足 = 整条不进卡。
//
// 三条铁律：只陈述事实（无祈使句）/ 每条带 provenance 与 occurredAt 绝对日期 / shadow 只写证据目录。
// 墓碑测试：`test/inject.test.mjs`（删掉本文件 ⇒ 整片红；删掉 `inject-recovery.mjs` ⇒ 两房一起红）。

import path from 'node:path';
import { extractErrorKey } from './topic.mjs';
import { loadSignatureIndex, lookupSignature } from './sigindex.mjs';
import { deriveFalsifiableWhen, RECOVERY_FACT_KINDS } from './extract.mjs';
import { markerWithPolarity, detectPolarity, isCold, decayWeight } from './abstain.mjs';
import { ENTRY_LIMIT, BUDGET_TOKENS, INDEX_LINE_BUDGET, TEXT_CLIP, TIGHT_CLIP, POINTER_SUPPORT_LIMIT } from './limits.mjs';
// task-11：闸判据全部从 `inject-gate.mjs` 读（单源；本文件不再持有第二份实现）。
import {
  MARKERS_LINE,
  estimateTokens,
  formatCardDate,
  auditImperatives,
  fileExistsPreconditionOk,
} from './inject-gate.mjs';
// task-14：取数/记录侧在 `inject-recovery.mjs`。本文件只用 6 个（卡片版本号 + store 视图 + 次序 + 恢复事实三件套）。
import { CARD_VERSION, storeView, rankOf, recoveryFactOf, recoveryInsightClass, recoverySuffix } from './inject-recovery.mjs';

// task-14：③④⑤ 的导出**在这里按固定名单转出**（不写 `export *`）—— 名单与搬前本房的 27 个导出逐键相同；
// 多出来的内部符号（`storeView` / `rankOf` / `RANK`）**不外泄**，防止拆分把导出面悄悄撑大。
export {
  CARD_VERSION,
  SHADOW_DIR_REL,
  SHADOW_FILE,
  InjectError,
  TRIAL_OUTCOMES,
  trialOutcomeOf,
  recordInjectionTrials,
  recoveryInsightClass,
  signalFromText,
  degradedWalk,
  defaultShadowDir,
  assertSafeShadowDir,
  writeShadow,
  readShadow,
  runInject,
} from './inject-recovery.mjs';

// task-9 / P0-4：ENTRY_LIMIT / BUDGET_TOKENS / INDEX_LINE_BUDGET / TEXT_CLIP / TIGHT_CLIP /
// POINTER_SUPPORT_LIMIT 的注释与上游对应值都写在 `src/rooms/limits.mjs`（唯一权威表），本文件不写第二份；
// task-11：这 6 个名字的**对外导出**由垫片 `inject.mjs` 直接 `export … from './limits.mjs'`（导出面一字不变）。

/**
 * T345 · F3 尾注的字符上限（**派生内容**，不占正文预算）。
 * 目的：让模型知道「什么情况算我错」，又不让卡片被条件句撑爆。
 * 口径：单条 ≤ F3_MAX_CHARS 字符；超了截断并保留规则 id 可追溯。
 */
export const F3_MAX_CHARS = 60;

// ---------------------------------------------------------------------------
// T3 · 三级交付的第二级：「拿不准给指针」
//
// 此前只有两级：有把握给全文（`content`）/ 无关不给（`abstain`）。中间缺一级 ——
// **只有 1 局支撑、没有第二种证据**的记忆，给全文会**冒充断言**（模型会当它已经被反复验证），
// 不给又会丢掉线索。这一级只给 `episode + seq + occurredAt`：模型可以自己去查，
// **比全文省 token，也不误导**（卡上没有一句我们不敢担保的话）。
//
// 判据**必须机械**（AGENTS §2.3「计数不是打分」）—— 两条同时成立才降级：
//   ① `state === 'observed'`：本仓 marker 语义里 `observed` 就是「1 局」；
//   ② `support.length <= POINTER_SUPPORT_LIMIT`（=1）：计数也必须是 1。
// 只有 ①（标了 observed 但支撑 ≥2）⇒ **计数是硬事实，按计数走，照常给全文**；
// 只有 ②（支撑 1 却标了 candidate/semantic）⇒ 状态自相矛盾，**按最保守的"不降级"走**
// （宁可多给，不许把有把握的条目降成指针）。
// ---------------------------------------------------------------------------

/**
 * 三级交付的**生产默认值**（单一来源）。
 *
 * `buildMemoryCard` / `collectEntries` 的默认参数、`src/plugin.mjs` 的 `DEFAULT_CONFIG`
 * 全读这一个常量 —— 免得出现「函数默认关、插件默认开」两套默认值各写一份
 * （D5 的 `!== false` 陷阱就是同一个坑：**未设置**被当成**开启**）。
 *
 * 默认值本身是**行为开关**：`true` = 生产链路给指针行（与 `evidence/T3-pointer-tier.md` 的
 * 前后对照口径一致）；`false` = 与 0.8.46 逐字节一致（只作 A/B 对照与紧急回退）。
 *
 * 0.8.49 起**默认开**：A6 文字层已补机械豁免（指针行不进 A6 分子分母），
 * 且"有把握"（`support >= 2` / 非 `observed`）的场景逐字节不变（T3 ③ 钉住）。
 */
export const POINTER_TIER_DEFAULT = true;

/**
 * 指针行正文的**固定尾段**（单一来源：`pointerBodyOf` 渲染它，`POINTER_BODY_RE` 用它判定）。
 * 「原文未给」是这张卡的事实（该坐标有原文、卡上没有给），不是对模型的安排。
 */
const POINTER_BODY_TAIL = '原文未给';

/**
 * 指针行正文的**唯一形态**：`<N> 局支撑 · 原文未给`。
 *
 * 消费方是 A6 文字层的机械豁免（`scripts/audit-card-samples.mjs` 的 `isPointerBody`）：
 * 指针行**故意**没有逐字正文（正文位置只有计数），所以它既不进 A6 分子、也不进分母
 * —— 与 `unreadable` / `unresolved` 同类（「没得核」，不是「核不过」）。
 * 判据是归一化后**逐字等于**这个形态，不是「包含」：少一个字符都不豁免。
 */
export const POINTER_BODY_RE = new RegExp(`^\\d+ 局支撑 · ${POINTER_BODY_TAIL}$`);

/**
 * 这一条 claim 是否「没把握 ⇒ 只给指针」。
 * 纯函数、只看计数与状态标记；不看模型评分、不看信号、不看时间。
 * @param {object} claim
 * @returns {boolean}
 */
export function isPointerCandidate(claim) {
  if (!claim || typeof claim !== 'object') return false;
  const state = typeof claim.state === 'string' && claim.state ? claim.state : 'observed';
  if (state !== 'observed') return false;
  const support = Array.isArray(claim.support) ? claim.support : [];
  return support.length > 0 && support.length <= POINTER_SUPPORT_LIMIT;
}

/**
 * 指针行的正文（**只写计数，不写断言**）。
 * `原文未给` 是这张卡的事实（该坐标有原文、卡上没有给），不是对模型的安排。
 * @param {object} claim
 * @returns {string}
 */
export function pointerBodyOf(claim) {
  const n = Array.isArray(claim?.support) ? claim.support.length : 0;
  // 尾段与 `POINTER_BODY_RE` 共用同一个常量（单一来源；测试钉住两者一致）。
  return `${n > 0 ? n : 1} 局支撑 · ${POINTER_BODY_TAIL}`;
}

/**
 * 三级交付的卡片级判定（**纯函数**，只读 `section` 与 `claims[].delivery`）。
 * @param {object} card
 * @returns {'content'|'pointers'|'abstain'}
 *   - `content`  —— 展开段里至少有一行给了全文；
 *   - `pointers` —— 有展开段，但**每一行都是指针**（只给坐标）；
 *   - `abstain`  —— 没有展开段（零注入：无关 / 无源 / 预算放不下）。
 */
export function tierOf(card) {
  const claims = Array.isArray(card?.claims) ? card.claims : [];
  if (!card || !card.section || claims.length === 0) return 'abstain';
  return claims.every((c) => c && c.delivery === 'pointer') ? 'pointers' : 'content';
}

/** 单行化：记忆行必须一行一条（多行会破坏 provenance 行格式）。 */
export function singleLine(text) {
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 单行化 + 截断（降表示的第一级：先截文本，不丢日期与出处）。 */
export function clipLine(text, max = TEXT_CLIP) {
  const s = singleLine(text);
  if (s.length <= max) return s;
  const cut = Math.max(0, max - 1);
  const head = s.slice(0, cut);
  // 2026-11-04（0.133.0）：截断尽量落在**空白边界**上。原来的硬截会把词切一半（线上实测切出 `….ou…`），
  // 卡上文字就不再是"原文的连续前缀"，A6 的文字层核对只能靠宽容匹配。保留 ≥60% 内容才回退到边界，否则硬截。
  const ws = Math.max(head.lastIndexOf(' '), head.lastIndexOf(String.fromCharCode(9)));
  const base = ws > 0 && ws >= Math.floor(cut * 0.6) ? head.slice(0, ws) : head;
  return `${base}…`;
}

// ---------------------------------------------------------------------------
// hit → 一条记忆行（优先 claim 原文；退化时只给指针）
// ---------------------------------------------------------------------------
// 次序表（`RANK` / `rankOf`）住在 `inject-recovery.mjs`：条目排序与降级 walk 共用同一份次序。

function compareClaims(a, b) {
  return (rankOf(a.kind) - rankOf(b.kind))
    || ((a.occurredAt ?? 0) - (b.occurredAt ?? 0))
    || String(a.id ?? '').localeCompare(String(b.id ?? ''));
}

/**
 * 一个 hit 该用哪条 claim 来陈述（按可靠性降序）：
 *   1. hit 自带 claim 对象（含 text）——调用方已经把原文给了；
 *   2. hit.claim = claims/<id>.json 的 id（R11 walk 的形态）→ 回到 store 取原文与 support（能拿到精确 seq/edgeId）；
 *   3. hit.claimId（兼容别名）；
 *   4. hit.claimKind + hit.text（walk 已经带了 claim 摘要字段，但 store 里查不到时用它，不丢内容）；
 *   5. 该局里**锚定同一个 seq** 的 claim（同一事件）。
 * 第 5 条故意收紧：没有 claim 指向命中事件时**不随手抓一条该局别的 claim**（那正是 F8「顺藤摸错枝」），
 * 而是退回指针行。全部按 (episode, seq, occurredAt) 校验，缺源的一律不入卡。
 */
/** 合并节点（带 merge.members 的 claim）**不参与 claim 选取** —— 它只作为成员的替代行出现（T187）。 */
function isMergeNodeClaim(claim) {
  return Boolean(claim && typeof claim === 'object' && claim.merge && typeof claim.merge === 'object' && Array.isArray(claim.merge.members));
}

function pickClaimBase(hit, view) {
  if (hit?.claim && typeof hit.claim === 'object' && typeof hit.claim.text === 'string') {
    const c = hit.claim;
    return {
      id: typeof c.id === 'string' ? c.id : null,
      kind: typeof c.kind === 'string' ? c.kind : 'fact',
      state: typeof c.state === 'string' ? c.state : 'observed',
      text: c.text,
      occurredAt: Number.isFinite(c.occurredAt) ? c.occurredAt : null,
      support: Array.isArray(c.support) ? c.support.filter((s) => s && typeof s === 'object') : [],
      // T35：**适用条件必须跟着 claim 走** —— 投影里漏掉 `preconditions`，file-exists 核验（以及 T298
      // 的 `preconditionOk` 回调）在"hit 自带 claim 对象"这条旁路上会静默失效（等于永不失效）。
      preconditions: Array.isArray(c.preconditions) ? c.preconditions.filter((p) => p && typeof p === 'object') : [],
      // T35：`validity.expect` 决定 file 类适用条件的方向（T158）—— 投影里同样不能丢。
      validity: c.validity && typeof c.validity === 'object' ? { ...c.validity } : null,
    };
  }
  const claimId = typeof hit?.claim === 'string' ? hit.claim : (typeof hit?.claimId === 'string' ? hit.claimId : null);
  if (claimId && view.claimsById.has(claimId)) return view.claimsById.get(claimId);
  if (claimId && typeof hit?.text === 'string' && hit.text.trim() !== '') {
    // store 里没有这条 claim（可能已被裁掉）：用 walk 带回来的摘要字段，出处仍取 hit 的 (episode, seq)。
    return {
      id: claimId,
      kind: typeof hit?.claimKind === 'string' && hit.claimKind ? hit.claimKind : 'fact',
      state: typeof hit?.claimState === 'string' && hit.claimState ? hit.claimState : 'observed',
      text: hit.text,
      occurredAt: Number.isFinite(hit?.occurredAt) ? hit.occurredAt : null,
      support: [],
    };
  }
  const list = view.claimsByEpisode.get(String(hit?.episode ?? '')) ?? [];
  if (!list.length || !Number.isFinite(hit?.seq)) return null;
  const anchored = list.filter((c) => !isMergeNodeClaim(c) && c.support.some((s) => Number(s.seq) === Number(hit.seq)));
  if (!anchored.length) return null;
  return [...anchored].sort(compareClaims)[0];
}

function stateTokenOf(claim) {
  if (claim.kind === 'antipattern') return 'antipattern';
  const state = typeof claim.state === 'string' && claim.state ? claim.state : 'observed';
  return state;
}

function buildEntry({ prefix = '', episode, seq, occurredAt, marker, state, text, kind, claimId = null, edgeId = null, cost = null, falsifiableWhen = null, recovery = null, recoveryClass = null, decay = 1,
  // T3：`delivery === 'pointer'` ⇒ 这一行只给指针（正文是计数，不是断言）。
  // `claimText` 只在这时出现：它是**那条记忆的正文**，留在结构化字段里（相关性判定要用），
  // **不进 `rawText`** —— 渲染只认 `rawText`，所以卡上不会出现没把握的断言。
  delivery = 'content',
  claimText = null }) {
  // 2026-11-04（0.134.0，线上实测）：seq 是 **1 基**的；`seq: 0` 等于「不知道在哪」，不是合法出处。
  // 当前宿主 60 条引用里就有 2 条落在 seq 0，卡上文字在该局里找不到 ⇒ A6 文字层报 missing。
  // 回到根本规矩：无源不入 —— seq < 1 的条目不进卡（计入 omitted，而不是渲染一条查无实据的行）。
  if (!episode || !Number.isFinite(seq) || seq < 1 || !Number.isFinite(occurredAt)) return null;
  const rawText = singleLine(`${prefix}${text}`);
  if (!rawText) return null;
  const date = formatCardDate(occurredAt);
  return {
    rawText,
    // T48：**未裁剪**的原文（V2「claim + 来源块」用；V1 不读它 ⇒ 逐字节不变）。
    fullQuote: singleLine(text),
    kind,
    marker,
    // T333：cost 只作**同分次序**（tokOverlap/rank 等主键都相同才比），不参与硬过滤。
    cost: Number.isFinite(cost) ? cost : null,
    // 知识库 91：**衰减权重**（0..1，最近被调用 ⇒ 1；很久没被调用 ⇒ 接近 0）。
    // 用作 `compareEntries` 的**次排序因子**（在 rank 之后，权重高的排前面）。
    // **被调用时重置**（`lastInjectedAt` 更新 ⇒ 权重回到 1）；没有时间 ⇒ 1（保守，当作"新"）。
    decay: Number.isFinite(decay) ? decay : 1,
    // T345：F3 失效条件是**派生内容**（非逐字），只作坐标后的尾注，绝不混进 rawText（否则 A6 文字层报 missing）。
    f3: falsifiableWhen && falsifiableWhen.when
      ? { rule: String(falsifiableWhen.rule ?? ''), when: String(falsifiableWhen.when).slice(0, F3_MAX_CHARS) }
      : null,
    // T28：恢复事实（**同一主体后来成功**）。只存机械字段；渲染在 `renderEntryLine`（尾注）。
    // 没有恢复证据 ⇒ null ⇒ 该行输出与旧版逐字节一致。
    recovery: recovery && RECOVERY_FACT_KINDS.includes(recovery.kind) && Number.isFinite(recovery.seq) && Number.isFinite(recovery.at)
      ? { kind: recovery.kind, seq: recovery.seq, at: recovery.at }
      : null,
    // T37：洞见层（坑类）。只有**已有恢复事实**时才加注；没有恢复事实 ⇒ 该字段不参与渲染。
    recoveryClass: recovery && typeof recoveryClass === 'string' && /^class:[a-z0-9][a-z0-9-]*$/.test(recoveryClass) ? recoveryClass : null,
    state: state ?? marker,
    occurredAt,
    date,
    claimId,
    source: { episode, seq, ...(edgeId ? { edgeId } : {}) },
    rank: rankOf(kind),
    // T3：**只给指针**的行多两个字段（content 行的结构一字不改，旧消费方拿到的还是老形状）。
    ...(delivery === 'pointer' ? { delivery: 'pointer', claimText: claimText ?? rawText } : {}),
  };
}

/** 信号侧的判别词（口径与 m5 A2b 同源：小写、按非字母数字切、≥4 字符、去掉 path）。 */
export function signalTokensOf(signal) {
  const parts = [];
  for (const t of Array.isArray(signal?.terms) ? signal.terms : []) parts.push(String(t));
  for (const e of Array.isArray(signal?.entities) ? signal.entities : []) parts.push(String(e?.key ?? ''));
  const out = [];
  for (const part of parts) {
    for (const tok of String(part).toLowerCase().split(/[^a-z0-9一-鿿]+/)) {
      if (tok.length >= 4 && tok !== 'path') out.push(tok);
    }
  }
  return [...new Set(out)];
}

/**
 * 挑「展示用的那条 support」：类级 claim 把同类多条错误收在一条上、只存一个代表原文，
 * 所以固定取 hit.seq 那条时，卡片会把「工具箱坏了」的泛教训端上来、却不点名这次是哪条错（2026-11-04 实测 2 条）。
 * 规则：在同域 support 里挑与本次信号判别词重叠最多的那条；只有明显更好（≥2 且优于原选）才替换，
 * 否则保持原行为（不为了换而换，避免把卡片变成"随机挑一条"）。
 */
function pickSourceBySignal(support, { signalTokens = [], currentSeq = null, fallback = null } = {}) {
  if (!Array.isArray(support) || support.length < 2 || !Array.isArray(signalTokens) || signalTokens.length === 0) return fallback;
  const scoreOf = (sup) => {
    const q = String(sup?.quote ?? '').toLowerCase();
    if (!q) return -1;
    return signalTokens.filter((t) => q.includes(t)).length;
  };
  let best = fallback;
  let bestScore = fallback ? scoreOf(fallback) : -1;
  for (const sup of support) {
    const score = scoreOf(sup);
    if (score > bestScore) { best = sup; bestScore = score; }
    else if (score === bestScore && Number.isFinite(currentSeq) && Number(sup?.seq) === Number(currentSeq)) { best = sup; }
  }
  return bestScore >= 2 ? best : fallback;
}

function entryFromClaim(hit, claim, options = {}) {
  // T252（2026-11-05）：`invalidated` 的 claim 一律不渲染。
  // walk 的候选集早已剔除它（`dropped.invalidated`），但 hit 自带 claim 对象、
  // 或 hit 直接点名 claimId 的**旁路**会绕过那道过滤 —— 这里在渲染入口再堵一次。
  // stale / disputed **不在此列**：它们仍进卡并带各自 marker（有信息量）。
  if (claim && claim.state === 'invalidated') return null;
  // T35：`file-exists` 适用条件失效 ⇒ **不注入**（文件都没了，这条记忆就是错的；宁可不给，
  // 也不降级成指针行——指针行仍在说"这里有信息量"）。
  if (claim && !fileExistsPreconditionOk(claim, options)) return null;
  // T298（知识库 64）：stale / `validUntil` 过期 **不占位**；preconditions 重跑通过 ⇒ 可复活。
  if (claim) {
    const revived = typeof options.preconditionOk === 'function' ? options.preconditionOk(claim) === true : false;
    if (!revived) {
      if (claim.state === 'stale') return null;
      const vu = Number(claim.validUntil);
      const nowTs = Number.isFinite(options.now) ? Number(options.now) : Date.now();
      if (Number.isFinite(vu) && vu < nowTs) return null;
    }
  }
  // 2026-11-04（M4 线上抽查发现）：u:owner 类级 claim 的 support 跨多个工作区，
  // 直接取 support[0] 会把"别项目的失败原文 + ep"渲染进本项目的卡（A5 的实质越界）。
  // 这里只选**同作用域**的 support；同作用域一条都没有 ⇒ 不渲染（返回 null）。
  const all = Array.isArray(claim.support) ? claim.support : [];
  const scope = typeof options.scope === 'string' && options.scope ? options.scope : null;
  const byId = options.episodesById instanceof Map ? options.episodesById : null;
  // Q18（默认关）：开关 + 类级章节 + 该 hit 由 walk 标了 class:cross-scope ⇒ 允许跨域证据，并在行首标 [跨项目]。
  // walk 只有在 allowCrossScopeClass 打开时才会给 hit 打 `class:cross-scope`；
  // 所以这里只看这个标记，卡片本身不需要再传开关（Q18 由 walk 一处控制）。
  const crossAllowed = String(claim.text ?? '').startsWith('class:')
    && Array.isArray(hit?.why) && hit.why.includes('class:cross-scope');
  const support = scope && byId && !crossAllowed
    ? all.filter((sup) => {
      const rec = byId.get(String(sup?.episode ?? ''));
      // 查不到该局（测试夹具/库未加载到）⇒ 无法证明越界，保留；查得到且明确别的作用域 ⇒ 丢掉。
      if (!rec || typeof rec.scopeKey !== 'string') return true;
      return rec.scopeKey === scope;
    })
    : all;
  if (!support.length && all.length) return null; // 有 support 但全属别的作用域 ⇒ 不渲染
  let src = null;
  if (Number.isFinite(hit?.seq)) src = support.find((s) => Number(s.seq) === Number(hit.seq)) ?? null;
  if (!src) src = support.find((s) => String(s.episode) === String(hit?.episode ?? '')) ?? support[0] ?? null;
  // T111（0.122.0）：同域 support 里若有原文更贴近本次信号，就展示那条（否则保持原选）。
  src = pickSourceBySignal(support, { signalTokens: options.signalTokens, currentSeq: Number.isFinite(hit?.seq) ? Number(hit.seq) : null, fallback: src });

  const episode = typeof src?.episode === 'string' && src.episode
    ? src.episode
    : (typeof hit?.episode === 'string' ? hit.episode : '');
  const seq = Number.isFinite(src?.seq) ? Number(src.seq) : (Number.isFinite(hit?.seq) ? Number(hit.seq) : null);
  // 2026-11-04（audit-11 实测）：原先「文字取 claim.text / 坐标取 src / 日期取 claim.occurredAt」三者可脱钩 ——
  // 线上 44 条引用里 15 条的文字只在**本局别处**出现、1 条本局根本没有那段文字，还有 34/44 的日期不是所引那条事件的时间。
  // 注入只能是事实：卡上的每个字都必须落在它自己标注的 (ep, seq) 上，所以
  //   ① 文字取 `src.quote`（该 seq 的原文；claim 的 `class:<token>` 是机械标签，保留成前缀）；
  //   ② 日期取 `src.occurredAt`（所引那条事件的时刻）；
  //   ③ 只有旧夹具/旧数据缺 `quote` 时才退回 `claim.text` —— 那不是"允许脱钩"，而是让
  //      `scripts/audit-card-samples.mjs` 能把它抓成 elsewhere/missing 的可见失败（真实库里 quote 1661/1661 齐全）。
  const label = /^class:[^\s·]+/.exec(String(claim.text ?? ''))?.[0] ?? null;
  const quote = typeof src?.quote === 'string' ? src.quote.trim() : '';
  const body = quote || String(claim.text ?? '').trim();
  const text = body ? (label && !body.startsWith(label) ? `${label} · ${body}` : body) : null;
  if (!text) return null;
  const occurredAt = Number.isFinite(src?.occurredAt)
    ? Number(src.occurredAt)
    : (Number.isFinite(claim.occurredAt) ? claim.occurredAt : (Number.isFinite(hit?.occurredAt) ? hit.occurredAt : null));
  // T3（三级交付的第二级）：**没把握 ⇒ 只给指针**（判据见 `isPointerCandidate`，纯计数）。
  // **默认开**（`options.pointerTier === false` 才回到两级）：开/关的判据只有这一处收口。
  const basePointer = options?.pointerTier === true && isPointerCandidate(claim);

  // T28：恢复事实（同一主体后来成功）。只写事实；没有证据 ⇒ null（该行逐字节不变）。
  // T31：**有恢复事实的 antipattern 豁免指针档** —— 恢复事实只在正文行渲染，降级会把它藏掉；
  //   所以指针候选也要先查一次（索引很便宜；读时派生只给正文行，避免为指针行解日志）。
  const recovery = recoveryFactOf({ claim, src, options, logFallback: !basePointer });
  // T37：洞见层只**加注**已有恢复事实的坑类（不把没有恢复事实的 claim 算成有）。
  const recoveryClass = recovery ? recoveryInsightClass(claim) : null;
  const pointer = basePointer && !recovery;
  return buildEntry({
    episode,
    seq,
    occurredAt,
    recovery,
    recoveryClass,
    // 知识库 84：传了 `options.signalText` 时，**与信号方向相反**的 claim 标 `[disputed]`（不以"建议"出现）。
    // **不传 ⇒ 保持 `stateTokenOf(claim)`（行为不变，向后兼容）**。
    // T3：指针行也保留这个标记 —— 它是**那条记忆的状态事实**，与"给不给正文"是两件事。
    marker: options?.signalText
      ? markerWithPolarity(claim, detectPolarity(options.signalText, text))
      : stateTokenOf(claim),
    cost: Number.isFinite(options?.costIndex?.get?.(String(claim.id ?? ''))) ? options.costIndex.get(String(claim.id ?? '')) : null,
    // 知识库 91：**衰减权重**（最近被调用 ⇒ 1；很久没被调用 ⇒ 接近 0），用作 `compareEntries` 的次排序因子。
    decay: decayWeight(claim, options.now),
    // T345/T347：F3 优先用 claim 上存的；没有（历史 claim）⇒ **读时派生兜底**（纯函数、确定性）。
    // `f3OnCard:false` 只给 A/B 对照与紧急关闭用。
    // T3：**指针行不带 F3** —— F3 是正文的适用条件，指针行没有正文；带上它等于把没把握的断言的一部分塞回来。
    falsifiableWhen: pointer ? null : (options?.f3OnCard === false ? null : (claim.falsifiableWhen ?? deriveFalsifiableWhen(body))),
    ...(crossAllowed ? { prefix: '[跨项目] ' } : {}),
    state: typeof claim.state === 'string' && claim.state ? claim.state : 'observed',
    // T3：指针行的正文只写计数（`1 局支撑 · 原文未给`），**断言正文不进 rawText**；
    // 正文仍留在 `claimText`（结构化字段，相关性判定要用），但**不渲染**。
    text: pointer ? pointerBodyOf(claim) : text,
    delivery: pointer ? 'pointer' : 'content',
    claimText: pointer ? text : null,
    kind: claim.kind,
    claimId: claim.id,
    edgeId: typeof src?.edgeId === 'string' ? src.edgeId : null,
  });
}

/** 没有 claim 可陈述时只给指针（事实：这一局命中过这个主题、失败计数是多少）。 */
function entryFromEpisode(hit, view) {
  const rec = view.episodesById.get(String(hit?.episode ?? '')) ?? null;
  const seq = Number.isFinite(rec?.closure?.seqFrom)
    ? Number(rec.closure.seqFrom)
    : (Number.isFinite(hit?.seq) ? Number(hit.seq) : null);
  const occurredAt = Number.isFinite(rec?.startedAt)
    ? Number(rec.startedAt)
    : (Number.isFinite(hit?.occurredAt) ? hit.occurredAt : null);
  const failures = rec?.signals?.failures;
  const why = Array.isArray(hit?.why) ? hit.why.filter((x) => typeof x === 'string' && x) : [];
  const hitText = typeof hit?.text === 'string' ? hit.text.trim() : '';
  const l0 = typeof rec?.l0 === 'string' ? rec.l0.trim() : '';
  const text = hitText || l0 || `fail=${Number.isFinite(failures) ? failures : '?'} · topics=${why.slice(0, 3).join(', ') || '—'}`;
  return buildEntry({
    episode: String(hit?.episode ?? ''),
    seq,
    occurredAt,
    marker: 'observed',
    state: 'observed',
    text,
    kind: hit?.kind === 'failure' ? 'failure' : (hit?.kind === 'constraint' ? 'constraint' : 'pointer'),
  });
}

/**
 * T115（0.124.0）：**同一局里往往不止一条教训**，而 walk 命中的那个 seq（或它自带的 claim）可能锚定着
 * 与本次失败无关的类级泛教训。实测：`syntaxerror … checkSyntax` 那条考卷，5 个 hit 全落在同一局、
 * 各自只带一条"工具坏了"的泛教训，真正对得上的那条在同一局的另一个 seq 上（`claim.text` 重叠 8 vs 0）。
 * 规则：在**该局**的 claim 里挑与本次信号判别词重叠最高的那条 —— 要求 ≥2 且**严格优于**原选，
 * 否则保持原行为（不为了换而换）。出处仍由 `entryFromClaim` 从所选 claim 的 support 里取，
 * 所以「文字 / 坐标 / 日期」三者一致的不变量不受影响（A5 作用域闸也照旧在 entryFromClaim 里生效）。
 */
function pickClaim(hit, view, options = {}) {
  const base = pickClaimBase(hit, view);
  const tokens = Array.isArray(options.signalTokens) ? options.signalTokens : [];
  const episode = String(hit?.episode ?? '');
  if (!tokens.length || !episode) return base;
  const pool = (view.claimsByEpisode.get(episode) ?? []).filter((c) => !isMergeNodeClaim(c) && Array.isArray(c?.support) && c.support.length);
  if (!pool.length) return base;
  const scoreOf = (c) => {
    const t = String(c?.text ?? '').toLowerCase();
    if (!t) return -1;
    return tokens.filter((x) => t.includes(x)).length;
  };
  const baseScore = base ? scoreOf(base) : -1;
  let best = null;
  let bestScore = -1;
  for (const c of pool) {
    const sc = scoreOf(c);
    if (sc > bestScore) { best = c; bestScore = sc; }
  }
  if (best && bestScore >= 2 && bestScore > baseScore) return best;
  return base;
}

/**
 * hits → 候选条目。缺 (episode, seq, occurredAt) 的条目**直接丢**（无源不入、无时不入），
 * 只计数进省略；这样记忆卡本身不会出现「有行没出处」的形态。
 */
function collectEntries({ hits, view, scope = null, preferenceHardOnly = false, signal = null, sigIndex = null, allowCrossScopeClass = false,
  now = null,
  preconditionOk = null,
  costIndex = null,
  // T347：F3 上卡开关（默认开；关掉只用于 A/B 对照或紧急回退）
  f3OnCard = true,
  // T28/T30：恢复事实上卡开关 + 恢复索引所在库根 + 日志根目录（默认开；关掉 ⇒ 与旧版逐字节一致）。
  recoveryOnCard = true,
  recoveryStoreRoot = null,
  recoveryBaseDir = null,
  // T35：`file-exists` 相对路径的解析根（默认 process.cwd()；测试用临时目录）
  preconditionBaseDir = null,
  // 知识库 90：**冷却**（主人纠正："不被调用就冷却，等于没写"）。
  // **默认关**（`null` ⇒ 不过滤）：因为"冷却"依赖"注入记录"，
  // 而当前宿主只有 CLI 进程、没有真实流量，注入记录不可靠 ⇒ 默认关，不误杀。
  // 开启后，距最后注入超过 `coldAfterDays` 天的 claim **不再出现在卡片上**（**但不删**，可逆）。
  coldAfterDays = null,
  // T3：**三级交付**的第二级开关（默认值 = `POINTER_TIER_DEFAULT`，单一来源）。
  // `true` ⇒ `isPointerCandidate` 成立的条目只给指针（`episode + seq + occurredAt`），正文不渲染。
  // 关掉时卡片与 0.8.46 逐字节一致 —— 这是"旧消费方不会炸"的唯一保证。
  pointerTier = POINTER_TIER_DEFAULT,
}) {
  const entries = [];
  let droppedNoProvenance = 0;
  let droppedNoText = 0;
  let droppedSoftPreference = 0;
  let droppedCold = 0;
  let droppedImperative = 0;
  const seen = new Set();
  const cap = Math.max(ENTRY_LIMIT * 8, 40);

  for (const hit of Array.isArray(hits) ? hits : []) {
    if (!hit || typeof hit !== 'object') continue;
    // T187：**指向合并节点的 hit 不成行** —— 合并节点只作为"≥2 个成员的替代行"出现。
    // 影库里 walk 会额外返回"指向合并节点"的 hit（源库没有它），若在这里退化成 episode 指针行，
    // 同一组的卡就会比源库多一行（④a 反增）；直接跳过则两库行数一致。
    const namedId = typeof hit.claim === 'string' ? hit.claim : (typeof hit.claimId === 'string' ? hit.claimId : null);
    if (namedId && isMergeNodeClaim(view.claimsById.get(namedId))) continue;
    const claim = pickClaim(hit, view, { signalTokens: signalTokensOf(signal) });
    // Q19-B 预置（默认关）：只保留 hard 约束，丢弃 soft（理由句/闲聊/复述）
    if (preferenceHardOnly && claim && claim.kind === 'preference' && claim.level !== 'hard') {
      droppedSoftPreference += 1;
      continue;
    }
    // 知识库 90：**冷却**（主人纠正："不被调用就冷却，等于没写"）。
    // `coldAfterDays` **默认关**（不设 ⇒ 不过滤，因为"冷却"依赖"注入记录"，
    // 而当前宿主只有 CLI 进程、没有真实流量，注入记录不可靠 ⇒ 默认关，不误杀）。
    // **冷却 = 不再出现在卡片上，但不删**（原件永不删，可逆：将来被调用了就"热"回来）。
    if (Number.isFinite(coldAfterDays) && coldAfterDays > 0 && claim && isCold(claim, now, { coldAfterDays })) {
      droppedCold = (droppedCold ?? 0) + 1;
      continue;
    }
    const entry = claim
      ? entryFromClaim(hit, claim, { scope, episodesById: view.episodesById, allowCrossScopeClass: allowCrossScopeClass === true, signalTokens: signalTokensOf(signal), now, preconditionOk, costIndex, f3OnCard, pointerTier, recoveryOnCard, recoveryStoreRoot, recoveryBaseDir, preconditionBaseDir,
        // 知识库 84：把**信号原文**也传下去 —— 与信号**方向相反**的 claim 标 `[disputed]`（不以"建议"出现）。
        // 取不到原文 ⇒ 空串 ⇒ `hasAnySignalHandle` 为 false ⇒ **不拒绝、不改标记**（保守，向后兼容）。
        signalText: signal?.text ?? signal?.quote ?? (Array.isArray(signal?.terms) ? signal.terms.join(' ') : '') })
      : entryFromEpisode(hit, view);
    if (entry && scope) {
      const rec = view.episodesById.get(String(hit?.episode ?? ''));
      const epScope = rec && typeof rec.scopeKey === 'string' ? rec.scopeKey : null;
      if (epScope && epScope !== scope) entry.crossScope = true;
    }
    if (!entry) {
      if (claim && !clipLine(claim.text)) droppedNoText += 1;
      else droppedNoProvenance += 1;
      continue;
    }
    // 2026-11-04（0.138.0）：边界闸对祈使句是**卡级 fail-closed** —— 线上实测有一次整张卡因此没注入。
    // 规则不变（注入内容不许有祈使句），但粒度改成**行**：这一行丢掉、其余照常注入，并在 omitted 里如实记数。
    if (auditImperatives(entry.rawText).length) {
      droppedImperative += 1;
      continue;
    }
    // 去重键（T154）：**有 claim 的条目按 claimId 去重** —— 同一条 claim 常常有多个出处
    // （support[0] / support[1] ……线上 146/1232 条 claim 如此），按 (episode, seq, 原文) 去重
    // 会把同一条断言渲染成两行；闸 4 按"归一化全文"判等，看到同一个 id 出现两次就当成
    // "未标 supersedes 的重复"，整张卡被打回（线上两次 gate4/unsuperseded-duplicate 的根因）。
    // 棋谱指针行（无 claim）保持原键：不同出处是**不同事实**，必须都保留。
    const key = entry.claimId
      ? `claim:${entry.claimId}`
      : `${entry.source.episode}\u0000${entry.source.seq}\u0000${entry.rawText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
    if (entries.length >= cap) break;
  }

  // N9（2026-11-03）：按签名补"这条失败在本局/历史局里真实出现过的原文"。
  // 只**追加**、不替换既有 claim（N8 教训）；每信号最多 2 条；作用域必须一致（A5）。
  let sigAdded = 0;
  const sigKey = signal && typeof signal.text === 'string' ? extractErrorKey(signal.text) : null;
  for (const item of lookupSignature(sigIndex, sigKey, { limit: 2 })) {
    if (!item || !item.episode) continue;
    const rec = view.episodesById.get(String(item.episode));
    if (scope) {
      const epScope = rec && typeof rec.scopeKey === 'string' ? rec.scopeKey : null;
      if (!epScope || epScope !== scope) continue;
    }
    const text = String(item.snippet ?? '').trim();
    if (!text) continue;
    const dedupe = `${item.episode}\u0000${item.seq ?? ''}\u0000${text}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const entry = buildEntry({
      episode: String(item.episode),
      seq: Number.isFinite(item.seq) ? item.seq : null,
      occurredAt: Number.isFinite(item.occurredAt) ? item.occurredAt : null,
      marker: 'observed',
      state: 'observed',
      text,
      kind: 'failure',
    });
    if (!entry) continue;
    entries.push(entry);
    sigAdded += 1;
    if (entries.length >= cap) break;
  }

  return { entries, sigAdded, dropped: { noProvenance: droppedNoProvenance, noText: droppedNoText, softPreference: droppedSoftPreference, imperative: droppedImperative } };
}

function compareEntries(a, b) {
  return (a.rank - b.rank)
    // 知识库 91：**衰减权重**（次排序因子，在 rank 之后）—— 最近被调用的排前面，很久没被调用的沉底。
    // **被调用时重置**（`lastInjectedAt` 更新 ⇒ 权重回到 1）；缺 decay ⇒ 视为 1（保守，当作"新"）。
    || ((b.decay ?? 1) - (a.decay ?? 1))
    || ((b.occurredAt ?? 0) - (a.occurredAt ?? 0))
    || (String(a.source.episode) < String(b.source.episode) ? -1 : String(a.source.episode) > String(b.source.episode) ? 1 : 0)
    // T317：seq 缺失时 `a-b` 会是 NaN（被 sort 当 0 ⇒ 退回插入序）——先挡住
    || ((Number.isFinite(a.source.seq) && Number.isFinite(b.source.seq)) ? a.source.seq - b.source.seq : 0)
    // T333：**同分次序** —— 上面的主键（rank / occurredAt / episode / seq）全部相同，才比 cost：
    // 付过代价（cost > 0）排在没有代价（0 / 缺失）之前。缺 costIndex ⇒ 视为 0（不加分、不惩罚）。
    || ((Number.isFinite(b.cost) ? b.cost : 0) - (Number.isFinite(a.cost) ? a.cost : 0))
    // T317：**最后一级 = claimId 字典序** —— 同局同 seq 的两条 claim 必须可复现，
    // 不许依赖插入顺序 / Map 迭代序 / 文件系统顺序（T316 剩下的 3 条差异就出在这一级）。
    || String(a.claimId ?? '').localeCompare(String(b.claimId ?? ''));
}

// ---------------------------------------------------------------------------
// T162a 合并节点（merge）：同一张卡里「合并节点 + 成员」不许同时成行
// ---------------------------------------------------------------------------

/** 成员 id → 合并节点 claim 的索引（只在 claim 带 `merge.members` 时建）。 */
function mergeIndexByMember(view) {
  const byMember = new Map();
  for (const claim of Array.isArray(view?.claims) ? view.claims : []) {
    const merge = claim?.merge;
    if (!merge || typeof merge !== 'object' || !Array.isArray(merge.members) || !claim.id) continue;
    for (const memberId of merge.members) {
      if (typeof memberId === 'string' && memberId !== '' && memberId !== claim.id) byMember.set(memberId, claim);
    }
  }
  return byMember;
}

/**
 * 用合并节点自己的出处渲染一行（与普通 claim 行同形状：`entry.claimId` = 合并节点 id）。
 * 锚点优先 `merge.representative`，缺就从自己的 support 里挑第一条有 (episode, seq) 的；
 * 两者都没有 ⇒ 无法证明出处，返回 null（无源不入）。
 */
function entryFromMergeNode(mergeClaim, options = {}) {
  const rep = mergeClaim?.merge?.representative;
  const support = Array.isArray(mergeClaim?.support) ? mergeClaim.support : [];
  const anchor = rep && typeof rep.episode === 'string' && Number.isFinite(Number(rep.seq))
    ? { episode: rep.episode, seq: Number(rep.seq), occurredAt: Number.isFinite(rep.occurredAt) ? rep.occurredAt : null }
    : (support.find((s) => s && typeof s.episode === 'string' && Number.isFinite(Number(s.seq))) ?? null);
  if (!anchor) return null;
  const hit = {
    episode: anchor.episode,
    seq: Number(anchor.seq),
    why: [],
    occurredAt: Number.isFinite(anchor.occurredAt) ? Number(anchor.occurredAt) : (Number.isFinite(mergeClaim.occurredAt) ? mergeClaim.occurredAt : null),
    claim: mergeClaim.id,
  };
  return entryFromClaim(hit, mergeClaim, options);
}

/**
 * 卡片选取条目的最后一道：**合并节点只替换、不主动入选**。
 *
 * 规则（T176 语义 + T187 收口）：
 *   1. 合并节点**不因为自己命中而单独成行** —— 它只作为"成员的替代行"出现；
 *   2. **≥2 个成员**被命中 ⇒ 用合并节点替换这些成员行（合并节点插在第一个成员的位置）；
 *   3. 只有 1 个 / 0 个成员被命中 ⇒ 合并节点行撤掉，成员行原样保留（行数 1→1 或 0→0，不增不减）；
 *   4. 没有 `merge` 字段的 claim **一字不改** —— 不建索引、不碰顺序。
 *
 * 为什么是这三条（T187 的两次实测）：
 *   · "合并节点被命中就渲染它"（T162a）会让卡片净 +1（c-3011f83f 1→2、c-41157b78 2→3）；
 *   · "0 成员时补指针行/代表成员行"（T177 方案 C）同样净 +1，且 ④b 仍有丢行；
 *   · 真正的丢行来自 `pickClaim` 把成员命中升级成合并节点 —— 那一刀在 pickClaim 里（成员保留），
 *     这里只要保证"合并节点只在替代 ≥2 个成员时出现"，④a/④b 就同时为 0。
 *
 * 被折叠的成员行不计入 omitted（它们没丢，只是被合并节点代表了）。
 */
/**
 * T207：**冒泡行** —— 只命中 1 个成员时，用合并节点那一行 1 换 1，并在行内标注它代表什么。
 *
 * 为什么不能"多换 1"：只命中 1 条成员时折叠没有收益（行数不变），但行内标注能让模型知道
 * "这条是合并组的代表，详见合并节点"—— 这是触发面实验（P(≥1)）要观察的行为；
 * 不标注的话，冒泡与"直接渲染成员"在卡上无法区分，实验数据就读不出来。
 * 出处仍取合并节点自己的 support 锚点（闸 0 的 (episode, seq, 日期) 与闸 5 的 quote 规则照旧满足）。
 */
function entryFromMergeBubble(mergeClaim, options = {}) {
  const base = entryFromMergeNode(mergeClaim, options);
  if (!base) return null;
  const count = Array.isArray(mergeClaim?.merge?.members)
    ? mergeClaim.merge.members.filter((x) => typeof x === 'string').length
    : 0;
  return { ...base, rawText: singleLine(`代表 ${count} 条 · 详见 ${mergeClaim.id} · ${base.rawText}`) };
}

function collapseMergeNodes({ entries, view, options = {} }) {
  const list = Array.isArray(entries) ? entries : [];
  // T207：运行时计数（触发面实验的数据源；只加字段，不改任何既有语义）
  const stats = { groupsHit: 0, membersHit: 0, collapsed: 0, bubbled: 0 };
  if (!list.length) return { entries: list, stats };
  const byMember = mergeIndexByMember(view);
  if (!byMember.size) return { entries: list, stats }; // 库里没有合并节点：零成本直通

  // 合并节点自身（带 merge.members 的 claim）：它们的行**一律不单独出现**（规则 1）。
  const mergeNodeIds = new Set();
  for (const claim of Array.isArray(view?.claims) ? view.claims : []) {
    if (claim?.id && claim.merge && typeof claim.merge === 'object' && Array.isArray(claim.merge.members)) mergeNodeIds.add(claim.id);
  }

  // 每个合并节点：卡片里出现了它哪几个**成员**（成员 ≠ 合并节点自己）
  const groups = new Map();
  for (const entry of list) {
    const mergeClaim = entry?.claimId ? byMember.get(entry.claimId) : null;
    if (!mergeClaim) continue;
    const group = groups.get(mergeClaim.id) ?? { claim: mergeClaim, members: new Set() };
    group.members.add(entry.claimId);
    groups.set(mergeClaim.id, group);
  }
  // T226：本次命中的**合并组**数（按"组里有 ≥1 个成员成行"去重）——
  // 与 membersHit（行数）一起构成 组/行 两个分母；0 组表示这张卡上没有任何合并组被触发。
  stats.groupsHit = groups.size;

  const dropped = new Set();
  const replacement = new Map(); // 首个成员 id → 合并节点 entry（替换行）

  // 规则 2：**≥2 个成员**被命中 ⇒ 用合并节点替换这些成员行（多换 1，原行为不变）
  // 规则 2'（T207 触发面实验）：**只命中 1 个成员** ⇒ 也冒泡到合并节点（**1 换 1**，行数不变）
  for (const group of groups.values()) {
    const memberCount = group.members.size;
    stats.membersHit += memberCount;
    if (memberCount === 0) continue; // 规则 3：0 个成员 ⇒ 合并节点行不出现
    const entry = memberCount >= 2
      ? entryFromMergeNode(group.claim, options)
      : entryFromMergeBubble(group.claim, options);
    if (!entry) continue; // 造不出替代行 ⇒ 不动（宁可多一行，也不丢信息）
    for (const memberId of group.members) dropped.add(memberId);
    replacement.set([...group.members][0], entry);
    stats.collapsed += memberCount;
    if (memberCount === 1) stats.bubbled += 1;
  }
  // 规则 1：合并节点自己的行一律撤掉（它已由替换行代表，或本来就不该单独成行）
  for (const entry of list) {
    const id = entry?.claimId;
    if (id && mergeNodeIds.has(id)) dropped.add(id);
  }
  if (!dropped.size) return { entries: list, stats };

  const out = [];
  const placed = new Set();
  for (const entry of list) {
    if (entry?.claimId && dropped.has(entry.claimId)) {
      // 把合并节点插在它第一个成员的位置上（保持排序语义）
      const mergeEntry = replacement.get(entry.claimId);
      if (mergeEntry && !placed.has(mergeEntry.claimId)) {
        out.push(mergeEntry);
        placed.add(mergeEntry.claimId);
      }
      continue;
    }
    out.push(entry);
  }
  return { entries: out, stats };
}

// ---------------------------------------------------------------------------
// 记忆卡
// ---------------------------------------------------------------------------

export function renderIndexLine({ indexPath, scope, episodes }) {
  const n = Number.isFinite(episodes) ? episodes : 0;
  return `MEMORY: ${displayPath(indexPath)}（scope=${scope}, ${n} 局, 未列出≠不存在）`;
}

/** 路径渲染用正斜杠（跨机可读、和 scopeKey 的写法一致；不改真实路径）。 */
export function displayPath(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

function renderEntryLine(entry, clip, view = 'claim') {
  const body = clipLine(entry.rawText, clip);
  const flag = entry.crossScope ? ' [跨项目]' : '';
  // T345：F3 尾注放在**坐标之后**（正文仍是逐字原文，A6 文字层只核正文）。
  // 无 F3 的条目输出与旧版逐字节一致。
  const f3 = entry.f3?.when ? ` · ${entry.f3.when}${entry.f3.rule ? ` [${entry.f3.rule}]` : ''}` : '';
  // T28：恢复事实尾注（只写事实，不写「你该这么做」）。无恢复证据 ⇒ 空串 ⇒ 该行逐字节不变。
  const recovery = recoverySuffix(entry.recovery, entry.recoveryClass);
  // T48 · V2「claim + 来源块」：附上**未裁剪**的原文（比正文长才附；带 episode+seq 的坐标本来就在行内）。
  // V1（默认）⇒ 空串 ⇒ 该行逐字节不变（tombstone）。
  const sourceBlock = view === 'claim+source' && entry.fullQuote && entry.fullQuote.length > body.length
    ? ` · 原文：${clipLine(entry.fullQuote, 240)}`
    : '';
  return `- [${entry.marker}] ${body}${flag} (${entry.source.episode}, ${entry.date}, seq ${entry.source.seq})${f3}${recovery}${sourceBlock}`;
}

function renderSection({ entries, beyond, droppedProvenance, limit, budgetTokens, clip, withMarkers = true, droppedCrossScope = 0, droppedUnknownScope = 0, scopeKey = null, view = 'claim' }) {
  // T48 · V3「同源 claim 包」：把**同一 episode 的连续条目**折成一块（头行给 episode + 条数），
  // 减少"同局多 claim 重复占位"（MemCompile 实测同源吃 27% 预算）。V1 走原路径（逐字节不变）。
  const body = view === 'claim-pack'
    ? (() => {
      const out = [];
      for (let i = 0; i < entries.length;) {
        const ep = entries[i].source.episode;
        let j = i + 1;
        while (j < entries.length && entries[j].source.episode === ep) j += 1;
        const group = entries.slice(i, j);
        if (group.length >= 2) {
          // 头行给一次 episode + 日期 + 条数；组内行只留 `seq`（真正省掉重复占位）。
          out.push(`- [同源] ${ep} · ${group[0].date} · ${group.length} 条`);
          for (const e of group) {
            const bodyLine = clipLine(e.rawText, clip);
            const flag = e.crossScope ? ' [跨项目]' : '';
            const f3 = e.f3?.when ? ` · ${e.f3.when}${e.f3.rule ? ` [${e.f3.rule}]` : ''}` : '';
            const recovery = recoverySuffix(e.recovery, e.recoveryClass);
            out.push(`  - [${e.marker}] ${bodyLine}${flag} · seq ${e.source.seq}${f3}${recovery}`);
          }
        } else {
          out.push(renderEntryLine(group[0], clip, 'claim'));
        }
        i = j;
      }
      return out;
    })()
    : entries.map((e) => renderEntryLine(e, clip, view));
  const total = beyond + droppedProvenance + droppedCrossScope + droppedUnknownScope;
  if (total > 0) {
    const parts = [];
    if (beyond > 0) parts.push(`超出 ${limit} 条上限/预算 ${budgetTokens} tokens 的 ${beyond} 条`);
    if (droppedProvenance > 0) parts.push(`无源不入 ${droppedProvenance} 条（缺 occurredAt 或 seq）`);
    if (droppedCrossScope > 0) parts.push(`跨作用域未纳入 ${droppedCrossScope} 条 [scope=${scopeKey}]`);
    if (droppedUnknownScope > 0) parts.push(`作用域未知未纳入 ${droppedUnknownScope} 条`);
    body.push(`omitted: ${total} items（${parts.join(' · ')}）— see index.md（未列出 ≠ 不存在）`);
  }
  const head = withMarkers ? ['<memory-ledger>', MARKERS_LINE] : ['<memory-ledger>'];
  return [...head, ...body, '</memory-ledger>'].join('\n');
}

/** 降表示的阶梯（超预算按这个顺序降，绝不先丢日期与出处）。 */
const CLIP_STEPS = Object.freeze([TEXT_CLIP, TIGHT_CLIP]);

/**
 * 组装记忆卡。
 *
 * @param {object}   p
 * @param {object}   [p.signal]      §7.1 信号（只用于 shadow 记录，不参与渲染）
 * @param {object}   [p.walkResult]  R11 walk 结果：`{hits, path, omitted, tokens, depth?}`
 * @param {object}   [p.store]       R15 createStore() 返回对象（只读：list/counts/indexPath）
 * @param {string}   [p.scope]       scopeKey；缺省由 store/`w:<unknown>` 兜底
 * @param {number}   [p.now]         入卡时刻（只进 shadow 记录；卡片文本不含时钟，保证同输入同输出）
 * @param {number}   [p.limit]       条数上限（默认 5）
 * @param {number}   [p.budgetTokens] token 预算（默认 500；口径 = indexLine + section）
 * @param {string}   [p.indexPath]   覆盖 index 路径
 * @param {number}   [p.episodeCount] 覆盖「N 局」
 * @param {boolean}  [p.pointerTier] T3：三级交付的第二级开关（默认 = `POINTER_TIER_DEFAULT`）。
 *   `true` ⇒ `isPointerCandidate` 成立的条目只给指针（`episode + seq + occurredAt`），正文不渲染；
 *   `false` ⇒ 与 0.8.46 逐字节一致（A/B 对照与紧急回退）。
 * @returns {{indexLine:string, section:string|null, claims:Array, omissions:string|null,
 *            tokens:number, shadow:true, omittedCount:number, hitCount:number,
 *            indexTokens:number, limit:number, budgetTokens:number, cardVersion:number,
 *            tier:'content'|'pointers'|'abstain', pointerCount:number}}
 */
export function buildMemoryCard({
  cache = null,
  signal = null,
  walkResult = null,
  store = null,
  scope = null,
  now = null,
  // T298：preconditions 重跑回调（返回 true ⇒ 该 claim 可复活）。不传 ⇒ 一律不回活。
  preconditionOk = null,
  // T331：预计算的 `cost` 索引（claimId → 代价种类数）。不传 ⇒ 不过滤（fail-open）。
  costIndex = null,
  limit = ENTRY_LIMIT,
  budgetTokens = BUDGET_TOKENS,
  indexPath = null,
  episodeCount = null,
  droppedCrossScope = 0,
  droppedUnknownScope = 0,
  walkCrossScope = 0,
  preferenceHardOnly = false,
  allowCrossScopeClass = false,
  // T347：F3 上卡开关（默认开）。关掉 ⇒ 卡片与 0.6.3 之前的格式逐字节一致（A/B 对照用）。
  f3OnCard = true,
  // T3：**三级交付**的第二级开关（默认 = `POINTER_TIER_DEFAULT`，生产默认开）。
  // `true` ⇒ 没把握的条目只给指针（正文不渲染）；`false` ⇒ 输出与 0.8.46 逐字节一致
  // —— 这是"旧消费方不会炸"的唯一保证（A/B 对照走它）。
  pointerTier = POINTER_TIER_DEFAULT,
  // T28：恢复事实上卡开关（默认开）。关掉 ⇒ 卡片与本次改动前逐字节一致（A/B 对照 / 紧急回退）。
  recoveryOnCard = true,
  // T35：`file-exists` 相对路径解析根（默认 process.cwd()；测试/离线脚本可传）
  preconditionBaseDir = null,
  // T48：读侧视图（`claim` 现状 / `claim+source` 附未裁剪原文 / `claim-pack` 同源折叠）。
  // 默认 `claim` ⇒ 卡片与本改动前**逐字节一致**（tombstone）。
  cardView = 'claim',
} = {}) {
  const crossScope = Number.isFinite(droppedCrossScope) && droppedCrossScope > 0 ? droppedCrossScope : 0;
  const unknownScope = Number.isFinite(droppedUnknownScope) && droppedUnknownScope > 0 ? droppedUnknownScope : 0;
  // walk 在遍历时拒掉的条数（R11 自己按作用域过滤的统计）：只作审计字段，不算"卡里少了几条"。
  const crossScopeWalk = Number.isFinite(walkCrossScope) && walkCrossScope > 0 ? walkCrossScope : 0;
  const view = storeView(store, cache);
  const sigIndex = store && typeof store.root === 'string' ? loadSignatureIndex(store.root) : null;
  const hits = Array.isArray(walkResult?.hits) ? walkResult.hits : [];
  const idxPath = indexPath ?? view.indexPath ?? 'memory-context/index.md';
  const episodes = Number.isFinite(episodeCount) ? episodeCount : view.episodeCount;
  const scopeKey = typeof scope === 'string' && scope
    ? scope
    : (typeof signal?.scopeKey === 'string' && signal.scopeKey ? signal.scopeKey : 'w:<unknown>');

  const indexLine = renderIndexLine({ indexPath: idxPath, scope: scopeKey, episodes });
  const indexTokens = estimateTokens(indexLine);

  // 兜底省略行：命中被作用域挡掉时，即使零展开也要说清"为什么什么都没有"。
  const scopeOmitted = crossScope + unknownScope + crossScopeWalk;
  const scopeOmissionText = scopeOmitted > 0
    ? `omitted: ${scopeOmitted} items（${[
      (crossScope + crossScopeWalk) > 0 ? `跨作用域未纳入 ${crossScope + crossScopeWalk} 条 [scope=${scopeKey}]` : null,
      unknownScope > 0 ? `作用域未知未纳入 ${unknownScope} 条` : null,
    ].filter(Boolean).join(' · ')}）— see index.md（未列出 ≠ 不存在）`
    : null;

  if (!hits.length) {
    // 不命中 ⇒ 零注入（只有首轮那一行事实）。
    return {
      indexLine,
      section: null,
      claims: [],
      omissions: scopeOmissionText,
      tokens: indexTokens,
      shadow: true,
      omittedCount: scopeOmitted,
      hitCount: 0,
      indexTokens,
      limit,
      budgetTokens,
      cardVersion: CARD_VERSION,
      crossScope,
      unknownScope,
      crossScopeWalk,
      signalAt: Number.isFinite(now) ? now : null,
      // T207/T226：不命中 ⇒ 四个计数全 0（字段始终存在）
      mergeStats: { groupsHit: 0, membersHit: 0, collapsed: 0, bubbled: 0 },
      // T3：不命中 = 无关 ⇒ abstain（三级里的第三级）
      tier: 'abstain',
      pointerCount: 0,
    };
  }

  const recoveryBaseDir = store && typeof store.root === 'string' ? path.dirname(path.resolve(store.root)) : null;
  const { entries: collectedEntries, dropped } = collectEntries({ hits, view, scope: scopeKey, preferenceHardOnly, signal, sigIndex, now, preconditionOk, costIndex, f3OnCard, pointerTier, recoveryOnCard, recoveryStoreRoot: store && typeof store.root === 'string' ? store.root : null, recoveryBaseDir, preconditionBaseDir });
  // T162a：认「合并节点」。合流（consolidate）会把多条近似 claim 压成一个带 `merge.members` 的节点；
  // 消费侧不认它，合并节点与它的成员就会在同一张卡里重复出现。规则见 collapseMergeNodes 的注释。
  const { entries, stats: collapseStats } = collapseMergeNodes({
    entries: collectedEntries,
    view,
    options: { scope: scopeKey, episodesById: view.episodesById, signalTokens: signalTokensOf(signal) },
  });
  // T226：`candidatesHit` 已删除 —— T193 之后 walk 不再把合并节点当 hit 返回，
  // 那个计数**结构上永远 0**（AGENTS §2.4「指标先有消费者」）。改用 collapseMergeNodes 里
  // 由"卡片里出现该组的 ≥1 个成员"去重得到的 `groupsHit`（组数），它才会动。
  const mergeStats = { ...collapseStats };
  const sorted = entries.slice().sort(compareEntries);
  const droppedProvenance = dropped.noProvenance + dropped.noText;
  const droppedImperative = Number.isFinite(dropped.imperative) ? dropped.imperative : 0;

  // 取前缀并按「先降表示、后降条数」的阶梯收敛到预算内（方案 §7.2 纪律 3）：
  //   阶梯 1：文本 160 字 —— 完整表示
  //   阶梯 2：文本 60 字 —— 缩表示（日期 + ep + seq 一字不丢）
  //   阶梯 3：去掉 markers 说明行
  //   阶梯 4：从尾部丢条目（失败教训在前 ⇒ 丢的永远是最不重要的），并用 omitted 行显式声明。
  const maxTake = Math.min(limit, sorted.length);
  let chosen = [];
  let section = null;
  let beyond = 0;
  let clipUsed = TEXT_CLIP;

  outer: for (let take = maxTake; take >= 0; take -= 1) {
    const sel = sorted.slice(0, take);
    const rest = sorted.length - take;
    for (const clip of CLIP_STEPS) {
      for (const withMarkers of [true, false]) {
        const candidate = renderSection({
          view: cardView,
          entries: sel,
          beyond: rest,
          droppedProvenance,
          limit,
          budgetTokens,
          clip,
          withMarkers,
          droppedCrossScope: crossScope,
          droppedUnknownScope: unknownScope,
          scopeKey,
        });
        if (indexTokens + estimateTokens(candidate) <= budgetTokens) {
          chosen = sel;
          section = candidate;
          beyond = rest;
          clipUsed = clip;
          break outer;
        }
      }
    }
  }

  // 连空壳都放不进预算（预算小到不合理）⇒ 零展开，但**省略必须如实记数**（不许静默丢）。
  if (section === null) beyond = sorted.length;

  const omittedTotal = beyond + droppedProvenance + crossScope + unknownScope + droppedImperative;
  const omittedParts = [];
  if (beyond > 0) omittedParts.push(`超出 ${limit} 条上限/预算 ${budgetTokens} tokens 的 ${beyond} 条`);
  if (droppedProvenance > 0) omittedParts.push(`无源不入 ${droppedProvenance} 条（缺 occurredAt 或 seq）`);
  if (droppedImperative > 0) omittedParts.push(`含指令式片段未纳入 ${droppedImperative} 条（只丢该行，其余照常）`);
  if (crossScope > 0) omittedParts.push(`跨作用域未纳入 ${crossScope} 条 [scope=${scopeKey}]`);
  if (unknownScope > 0) omittedParts.push(`作用域未知未纳入 ${unknownScope} 条`);
  const omissions = omittedTotal > 0
    ? `omitted: ${omittedTotal} items（${omittedParts.join(' · ')}）— see index.md（未列出 ≠ 不存在）`
    : null;

  // 一条也渲染不出来（命中全是无源条目，或预算连空壳都放不下）⇒ 仍然零展开：
  // 不拿「omitted」空壳烧 token，但省略如实记在卡片的结构化字段里（shadow 记录与 CLI 都看得见）。
  if (!chosen.length) {
    return {
      indexLine,
      section: null,
      claims: [],
      omissions,
      tokens: indexTokens,
      shadow: true,
      omittedCount: omittedTotal,
      hitCount: hits.length,
      indexTokens,
      limit,
      budgetTokens,
      cardVersion: CARD_VERSION,
      crossScope,
      unknownScope,
      crossScopeWalk,
      signalAt: Number.isFinite(now) ? now : null,
      clip: clipUsed,
      // T207：命中过合并节点、但一行都没留下（成员全不可代表）⇒ 计数照实给出
      mergeStats,
      // T3：三级交付 —— 一行都没留下 ⇒ abstain（无关/无源/预算放不下，三者都不给）
      tier: 'abstain',
      pointerCount: 0,
    };
  }

  // T3：指针行的 `text` 是**那条记忆的正文**（相关性判定要用），但 `line` 是指针行 ——
  // 真正进模型上下文的只有 `section`（由 `line` 拼成），所以卡上不会出现没把握的断言。
  // content 行的 `text` 仍是渲染正文（与旧版一字不差）。
  const claims = chosen.map((e) => ({
    text: e.delivery === 'pointer' ? clipLine(e.claimText ?? '', TEXT_CLIP) : clipLine(e.rawText, clipUsed),
    kind: e.kind,
    marker: e.marker,
    state: e.state,
    // T12 修②：**投影补 `decay`** —— `classifyAbstainReason` 的 `stale` 判据读 `card.claims[].decay`，
    // 而此前这张投影不含该字段 ⇒ `Number(c?.decay ?? 1)` 恒取 1 ⇒ `stale` 永远是死码（T11 §六实测 95 行全 null）。
    // 只用 entry 上已有的值（`buildEntry`/`entryFromClaim` 都算过 `decayWeight`），不改渲染、不改排序。
    decay: Number.isFinite(e.decay) ? e.decay : 1,
    occurredAt: e.occurredAt,
    date: e.date,
    source: e.source,
    line: renderEntryLine(e, clipUsed),
    ...(e.claimId ? { claimId: e.claimId } : {}),
    // T3：只在"只给指针"的行上出现（content 行结构一字不改，旧消费方不必判空）
    ...(e.delivery === 'pointer' ? { delivery: 'pointer' } : {}),
  }));
  const pointerCount = claims.filter((c) => c.delivery === 'pointer').length;

  return {
    indexLine,
    section,
    claims,
    omissions,
    tokens: indexTokens + estimateTokens(section ?? ''),
    shadow: true,
    omittedCount: omittedTotal,
    hitCount: hits.length,
    indexTokens,
    limit,
    budgetTokens,
    cardVersion: CARD_VERSION,
    crossScope,
    unknownScope,
    crossScopeWalk,
    signalAt: Number.isFinite(now) ? now : null,
    clip: clipUsed,
    // T207：触发面实验的运行时计数（只加字段，不改语义）
    mergeStats,
    // T3：三级交付的卡片级判定（content / pointers / abstain）与指针行数。
    // `tier` 由 `tierOf` 一处判定 —— 判定口径与消费方不各写一份。
    tier: tierOf({ section, claims }),
    pointerCount,
  };
}

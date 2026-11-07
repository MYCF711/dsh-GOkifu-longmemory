// src/rooms/abstain.mjs —— **不相关时沉默**（abstention，知识库 79）
//
// 依据（Geifman & El-Yaniv《Selective Classification for Deep Neural Networks》）：
// **先定 risk 上限，coverage 让它降** —— 没把握就拒绝，不要用"全覆盖"换"注入噪声"。
//
// 本仓此前只有"卡为空才 skip"（`no-hit`）：**卡不为空但内容不相关**的卡照样注入。
// 本房间给出**可机械判定**的"卡上有没有与信号相关的行"，供 `decidePreStep` 做**显式拒绝（abstain）**。
//
// 独立成文件（不写进 inject.mjs）：判据要能被**单独**测试与替换，不与渲染逻辑耦在一起。

const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'has', 'are', 'was',
  'were', 'error', 'file', 'files', 'node', 'index', 'test', 'tests', 'true', 'false', 'null', 'undefined',
  'then', 'than', 'into', 'your', 'you', 'not', 'but', 'all', 'any', 'can', 'will', 'would', 'should']);

/** 硬实体：文件路径 / 扩展名 / 仓库地址 / 错误码（与考卷 `hardEntities` 同族，保持可复算）。 */
export function abstainEntities(text) {
  const out = new Set();
  const s = String(text ?? '');
  for (const m of s.matchAll(/[A-Za-z]:[\\/][^\s"'`]+/g)) out.add(m[0].toLowerCase());
  for (const m of s.matchAll(/[A-Za-z0-9_.\/-]+\.(?:mjs|js|cjs|md|json|go|exe|ts|tsx|yml|yaml|png|cmd)\b/g)) out.add(m[0].toLowerCase());
  for (const m of s.matchAll(/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g)) out.add(m[0].toLowerCase());
  for (const m of s.matchAll(/\b(?:ENOENT|EPERM|EACCES|ETIMEDOUT|ECONNREFUSED|TypeError|SyntaxError|ReferenceError|RangeError)\b/g)) out.add(m[0]);
  return out;
}

/** 判别词：≥4 字符的小写 token，去停用词。 */
function tokens(text) {
  const out = new Set();
  for (const m of String(text ?? '').toLowerCase().matchAll(/[a-z][a-z0-9_.\/-]{3,}/g)) {
    if (!STOP.has(m[0])) out.add(m[0]);
  }
  return out;
}

/**
 * **中文 bigram**（与 T242 同口径）：纯中文信号里**一个英文 token 都没有**，
 * 只靠英文 token 会让判据**整体退化**（什么都判成"不相关" ⇒ 全被拒，那不是沉默，是误杀）。
 * 这里抽取连续中文段的**二字组**作为补充判别面。
 */
export function chineseBigrams(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(/[一-鿿]{2,}/g)) {
    const seg = m[0];
    for (let i = 0; i + 2 <= seg.length; i += 1) out.add(seg.slice(i, i + 2));
  }
  return out;
}

/**
 * **通用中文短语**（没有判别力）：`处理一下`、`继续`、`看看` 这类短语**也有 bigram**，
 * 但它们**不指向任何事** —— 不剔除的话，`hasAnySignalHandle` 会把它们误判为"有判据可用"，
 * 于是 abstain 会在"处理一下"这种信号上**误拒**（claim 与通用 bigram 不匹配 ⇒ 误判为不相关）。
 * 与 T242 的 IDF 过滤同族：**通用词停用**。
 */
const GENERIC_ZH = new Set(['处理', '一下', '继续', '看看', '这个', '那个', '什么', '怎么', '怎样', '可以',
  '一下', '帮我', '帮忙', '麻烦', '谢谢', '好的', '现在', '开始', '进行', '工作', '任务', '问题', '东西',
  '事情', '地方', '时候', '应该', '需要', '还是', '就是', '不是', '没有', '一个', '我们', '你们', '自己']);

/** 信号里**有没有可判别的内容**（英文 token / 非通用中文 bigram / 硬实体）。没有 ⇒ 判据不可用。 */
export function hasAnySignalHandle(signalText) {
  if (abstainEntities(signalText).size > 0) return true;
  if (tokens(signalText).size > 0) return true;
  // 中文：**短指令没有判别力**（"处理一下" / "继续" / "看看"）。
  // 教训：bigram 停用表**拦不住** —— "处理一下"会切出"理一"这种**跨词 bigram**，不在任何停用表里。
  // 所以**不用 bigram 停用**，改用一条**简单、机械、不会误伤**的判据：
  // **信号 < 10 字符且不含硬实体/英文判别词 ⇒ 判据不可用**（短指令天然无判别力，不该拿去拒）。
  const compact = String(signalText ?? '').replace(/\s+/g, '');
  if (compact.length < 10) return false;
  // 长信号：有非通用中文段（≥2 字且不在通用短语表）才算有内容
  for (const m of String(signalText ?? '').matchAll(/[一-鿿]{2,}/g)) {
    if (!GENERIC_ZH.has(m[0])) return true;
  }
  return false;
}

/**
 * 卡上**有没有与信号相关**的行。
 * 判据（与考卷同口径）：某条 claim 与信号共享 **≥1 硬实体** 或 **≥2 判别词**。
 * **没有卡 / 没有 claim ⇒ 返回 false**（由调用方走既有的 `no-hit`，不走 abstain）。
 */
export function hasRelevantClaim(card, signalText) {
  const claims = Array.isArray(card?.claims) ? card.claims : [];
  if (!claims.length) return false;
  // 判据不可用（信号里**什么可判别的都没有**，如纯短中文句）⇒ **不拒绝**（保守，不误杀）。
  // 没有判据就没有"不相关"可言 —— 宁可保持现状，也不能拿一把失效的尺子去拒。
  if (!hasAnySignalHandle(signalText)) return true;
  const se = abstainEntities(signalText);
  const st = tokens(signalText);
  const sb = chineseBigrams(signalText);
  for (const c of claims) {
    const text = String(c?.text ?? c?.rawText ?? '');
    if (!text) continue;
    // T366d：**跨语言的失败相关性** —— 中文"失败" + 英文"失败" ⇒ **相关**（不需要词重合）。
    // `"安装失败"`（中文）与 `"Error: tool call aborted"`（英文）讲的是同一件事，
    // 但**没有一个共享的词** —— 不映射就会**误杀**（实测 ep-75e7347e）。
    if (isCrossLingualFailureMatch(signalText, text)) return true;
    if (se.size) {
      for (const e of abstainEntities(text)) if (se.has(e)) return true;
    }
    const tt = tokens(text);
    let shared = 0;
    for (const k of st) if (tt.has(k)) shared += 1;
    if (shared >= 2) return true;
    // 中文 bigram：与信号共享 **≥1 个二字组**即算相关（与 T242 的中文判据同族）
    if (sb.size) {
      const cb = chineseBigrams(text);
      for (const b of sb) if (cb.has(b)) return true;
    }
  }
  return false;
}

export default { hasRelevantClaim, abstainEntities, chineseBigrams, hasAnySignalHandle };

// ── T366c：方向（polarity）——"相关但反向"的记忆是负迁移，A1 现在测不到 ──
// 依据：用户要 A、claim 指向非 A ⇒ 给了会误导。
// **机械**判据（AGENTS §2.3：禁止模型评分）：否定意图词表 × 促进意图词表。
// **判不了就 `unclear`**，不许为了出数硬判。

/** 否定/收缩意图：用户想"关掉、减少、避免、别"。 */
const NEGATE = ['关掉', '不要', '别', '避免', '取消', '停止', '关闭', '禁用', '不想', '太多', '刷爆', '烦', '不要再', '别再', '去掉', '删除', '屏蔽', '不再'];
/** 促进/扩张意图：claim 建议"打开、增加、更频繁、应该做"。 */
const PROMOTE = ['更频繁', '增加', '打开', '开启', '启用', '应该', '建议', '最好', '推荐', '多做', '加强', '提升', '扩大', '加快'];
/** 与 NEGATE 对应的"收缩"建议（claim 也在说"关掉/减少"）⇒ 同向。 */
const SUPPRESS = ['关掉', '关闭', '取消', '停止', '禁用', '减少', '降低', '避免', '屏蔽', '去掉', '删除'];

/**
 * 判定 claim 与信号的**方向关系**（不是"相不相关"，是"**同不同向**"）。
 * @returns {'same'|'opposite'|'unclear'}
 *  - 信号有**否定/收缩**意图，而 claim 是**促进/扩张**建议 ⇒ **opposite**；
 *  - 信号有否定意图，claim 也是**收缩**建议 ⇒ **same**；
 *  - 其它（没有方向、或判不了）⇒ **unclear**。
 */
export function detectPolarity(signalText, claimText) {
  const s = String(signalText ?? '');
  const c = String(claimText ?? '');
  // 守卫：**信号与 claim 高度重合（同一句/包含关系）⇒ 必然同向**，直接 `same`。
  // 教训（pair 15）：信号与 claim 逐字相同（"开启superagent模式…不要粉色大象"），
  // 却因为"信号含'不要' + claim 含'开启'"被误判为 opposite —— **同一段话不可能方向相反**。
  const ns = s.replace(/\s+/g, '');
  const nc = c.replace(/\s+/g, '');
  if (nc.length >= 8 && (ns.includes(nc) || nc.includes(ns))) return 'same';
  const sigNegate = NEGATE.some((w) => s.includes(w));
  const claimPromote = PROMOTE.some((w) => c.includes(w));
  const claimSuppress = SUPPRESS.some((w) => c.includes(w));
  if (sigNegate && claimPromote && !claimSuppress) return 'opposite';
  if (sigNegate && claimSuppress) return 'same';
  return 'unclear';
}

// ── 知识库 83：任何"率"都必须**同时报可判率**，可判率太低 ⇒ **不可用于决策** ──
/**
 * 方向统计的报告（**率 + 可判率 + 决策可用性** 三件套）。
 * 只报"反向记忆率 1.1%"而不报"可判率 3.7%"= 误导（知识库 83）。
 *
 * @param {{same?:number,opposite?:number,unclear?:number}} counts
 * @param {{decidabilityFloor?:number}} [opts] 可判率下限（默认 0.30 = 30%），低于 ⇒ **不可用于决策**
 */
export function polarityReport(counts, { decidabilityFloor = 0.30 } = {}) {
  const same = counts.same ?? 0;
  const opposite = counts.opposite ?? 0;
  const unclear = counts.unclear ?? 0;
  const total = same + opposite + unclear;
  const decidable = same + opposite;
  const decidability = total ? decidable / total : 0;
  const oppositeRate = total ? opposite / total : 0;
  const usable = decidability >= decidabilityFloor && decidable > 0;
  return {
    opposite, decidable, total,
    oppositeRate,
    decidability,
    usableForDecision: usable,
    text: `反向记忆率 ${(oppositeRate * 100).toFixed(1)}%（${opposite}/${total}）· 可判率 ${(decidability * 100).toFixed(1)}%（${decidable}/${total}）· ${usable ? '可用于决策' : '**不可用于决策**（可判率不足，只能作局部观察）'}`,
  };
}

// ── 知识库 84：方向相反 ⇒ 以 `[disputed]` 渲染（不以"建议"出现）──
/**
 * 决定一条 claim 在卡片上的**标记**（marker），**考虑与当前信号的方向关系**。
 *
 * - `polarity === 'opposite'`（用户要 A、claim 指向非 A）⇒ **`disputed`**（有争议），
 *   **不得**以 `[semantic]`/`[candidate]`（= "建议/定式"）出现 —— 那会让模型顺着做；
 * - 其它情况 ⇒ 保持原有标记（`kind`/`state` 决定），**行为不变**。
 *
 * 这是**纯函数**（可单测）。**渲染接线**（在 `buildEntry`/`renderSection` 里把 polarity 传进来）
 * 是**单独一步** —— 不在没读清渲染路径时改它。
 */
export function markerWithPolarity(claim, polarity) {
  if (polarity === 'opposite') return 'disputed';
  if (claim?.kind === 'antipattern') return 'antipattern';
  const state = typeof claim?.state === 'string' && claim.state ? claim.state : 'observed';
  return state;
}

// ── 知识库 87：精化适用条件（不是"全关"，是"只在判据可靠的输入上启用"）──
/**
 * 判据在这个信号上**是否可靠**（比 `hasAnySignalHandle` **更严**）。
 *
 * 拉卡托斯：反例该让我们"精化适用条件"，不是"全关"。
 * - 信号里有**硬实体**（文件路径/错误码/包名/仓库）⇒ **可靠**（实体桥是明确的，不会误判）；
 * - 有 **≥2 个英文判别词** ⇒ **可靠**（有足够的重合面可判）；
 * - **短指令（<10 字符）或纯通用中文** ⇒ **不可靠** ⇒ **不启用**（保守，不误杀）。
 *
 * **在"含硬实体的英文信号"上，判据其实是可靠的** —— 那部分**不该被"默认关"一起埋掉**。
 */
export function hasReliableHandle(signalText) {
  // 硬实体是最强的：有实体桥 ⇒ 判据可靠（"这条 claim 与这个文件/错误码有关"是明确的）
  if (abstainEntities(signalText).size > 0) return true;
  // 英文判别词 ≥2 ⇒ 有足够的重合面可判
  const toks = tokens(signalText);
  if (toks.size >= 2) return true;
  // 短指令（<10 字符）⇒ 不可靠（"处理一下"这种没有可判别的东西）
  const compact = String(signalText ?? '').replace(/\s+/g, '');
  if (compact.length < 10) return false;
  // 纯通用中文 ⇒ 不可靠（没有非通用的中文段可判别）
  for (const m of String(signalText ?? '').matchAll(/[一-鿿]{2,}/g)) {
    if (!GENERIC_ZH.has(m[0])) return false; // 有非通用中文段，但**没有硬实体/英文判别词** ⇒ 仍不够"可靠"
  }
  return false;
}

// ── T366d：跨语言的"失败"信号映射（中文"失败" ↔ 英文 `Error:`）──
// 误杀根因：`"安装失败"（中文）` 与 `"tool call aborted"（英文）` 讲的是同一件事，
// 但**没有一个共享的词** ⇒ `bigramRaw < 2` ⇒ 被判为"不相关" ⇒ 误杀。
// **这是 T242 早就记过的老问题**（"中文任务 vs 英文报错"）—— 语义相关，但字面零重合。
// 修法：**失败信号跨语言映射** —— 中文的"失败/报错/装不上"与英文的 `Error:`/`failed`/`FAIL`
// 是**同一类信号**（都在说"这事没成"），**不需要词重合**。

/** 中文的"失败"信号（用户说"这事没成"）。 */
const FAILURE_ZH = ['失败', '报错', '装不上', '不行', '出错', '错误', '崩溃', '挂了', '跑不起来', '不能用', '无法', '不成功', '没成功', '出问题'];

/** 英文的"失败"信号（`Error:` / `failed` / `FAIL` / 异常名）。 */
const FAILURE_EN = /\b(error|failed|failure|fail\b|exception|aborted|enoent|eperm|eacces|etimedout|econnrefused|typeerror|syntaxerror|referenceerror|rangeerror|cannot read|not found|could not|unable to)\b/i;

/** 信号里是否含**中文"失败"**信号。 */
export function hasChineseFailureSignal(text) {
  const s = String(text ?? '');
  return FAILURE_ZH.some((w) => s.includes(w));
}

/** 文本里是否含**英文"失败"**信号（`Error:` / 异常名 / `failed`）。 */
export function hasEnglishFailureSignal(text) {
  return FAILURE_EN.test(String(text ?? ''));
}

/** **跨语言的失败相关性**：信号是中文"失败"，claim 是英文"失败" ⇒ **相关**（不需要词重合）。 */
export function isCrossLingualFailureMatch(signalText, claimText) {
  return hasChineseFailureSignal(signalText) && hasEnglishFailureSignal(claimText);
}

// ── 知识库 90：冷却（主人纠正："不被调用就冷却，等于没写"）──
/**
 * 一条记忆是否**该冷却**（长期未被调用 ⇒ 不再出现在上下文，**但不删**）。
 *
 * **判据**：距**最后一次被注入**（`counters.lastInjectedAt`，无则用 `recordedAt`）**超过 `coldAfterDays` 天**。
 *
 * ⚠ **不要按 `counters.injections === 0` 判** —— 那可能是"**被调用了但没被记录**"
 * （当前宿主只有 CLI 进程、没有真实流量时，所有 claim 的 `injections` 都是 0，
 * 按 `=== 0` 判会把它们**全杀掉**，那是误杀）。
 *
 * **"冷却"是"不再出现"，不是"不存在"**：库仍然完整，只是**不再占用上下文**；
 * 将来被调用了，可以"热"回来（**可逆**）。
 *
 * @param {object} claim
 * @param {number} now epoch ms
 * @param {{coldAfterDays?:number}} [opts] 默认 **30 天**
 */
export function isCold(claim, now, { coldAfterDays = 30 } = {}) {
  const last = Number(claim?.counters?.lastInjectedAt ?? claim?.recordedAt ?? claim?.occurredAt ?? 0);
  if (!Number.isFinite(last) || last <= 0) return false; // 没有时间 ⇒ 判不了 ⇒ 不冷却（保守）
  if (!Number.isFinite(now)) return false;
  return now - last > coldAfterDays * 86400000;
}

// ── 知识库 91：衰减（连续权重，而不是"冷却"的二元开关）──
/**
 * 一条记忆的**衰减权重**（0..1，**随时间指数衰减**）。
 *
 * **"冷却"是二元的**（出现 / 不出现），**"衰减"是连续的**（权重随时间降低）。
 * 记忆的真实行为是**随时间衰减**，而不是"突然出现/消失"。
 *
 * 判据（机械）：
 * - 以**最后一次被注入**（`lastInjectedAt`，无则用 `recordedAt`）为起点；
 * - **权重 = 0.5 ^ (距今天数 / halfLifeDays)**（指数衰减，`halfLifeDays` 是"半衰期"）；
 * - **被调用时重置**（`lastInjectedAt` 更新 ⇒ 权重回到 1）。
 *
 * **冷却可以是"衰减到某个阈值以下 ⇒ 不再出现"**（衰减的特例），
 * 但**衰减本身更有用**：**权重低的排在后面**，而不是"突然消失"。
 *
 * @param {object} claim
 * @param {number} now epoch ms
 * @param {{halfLifeDays?:number}} [opts] 半衰期（默认 **30 天**：30 天后权重降到 0.5）
 * @returns {number} 0..1（1 = 刚被调用，越接近 0 = 越久没被调用）
 */
export function decayWeight(claim, now, { halfLifeDays = 30 } = {}) {
  const last = Number(claim?.counters?.lastInjectedAt ?? claim?.recordedAt ?? claim?.occurredAt ?? 0);
  if (!Number.isFinite(last) || last <= 0) return 1; // 没有时间 ⇒ 不衰减（保守，当作"新"）
  if (!Number.isFinite(now) || !Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 1;
  const days = Math.max(0, (now - last) / 86400000);
  return Math.pow(0.5, days / halfLifeDays);
}

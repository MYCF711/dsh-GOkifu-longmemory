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

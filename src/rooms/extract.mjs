/**
 * R03 extract —— 失败 / 成功 / 未结算 / 约束 / 工具的机械抽取。
 *
 * 契约（AGENTS §11 · R03，数据形状见 AGENTS §4.1 `signals`）
 * - 入口导出：`extractSignals({graph, events})`
 *   → `{failures, successes, unsettled, constraints, tools, counts, dropped, scanned}`
 * - 每条信号都带 `seq` + `quote`（≤200 字，取自事件/棋谱原文）；**无源不入**：取不到 seq 或原文的不收录，
 *   只记进 `dropped` 计数（不静默吞、也不许拿模型补）。
 * - 三类判据全是机械的：
 *   1. **边结果**：`edge.result === "failure"` → failures；`"success"` → successes；
 *      其余（`untested` / `unverified` / `pending` 及任何未识别值）→ unsettled。
 *      `unverified`（工具跑了但没退出码）**不是成功**，归 unsettled，原 `result` 保留在条目里供消费者区分。
 *   2. **约束**：user 原话里命中约束词的句子，逐字保留（不对句子做摘要/改写）。句子切分与约束词集
 *      语义对齐上游 `kifu-model.mjs` 的 `extractConstraints`（按 `。！？!?；;` 与换行切句、每段 ≤40 句）。
 *      源必须是**用户真的说的话**：事件侧只认 `type === "user/message"` 且 `data.source.kind === "user"`；
 *      `agent-instructions` / `runtime-context` / `skill-catalog` / `plugin:*` / `time-context` /
 *      `agent-message` / `subagent-settled` / `compact-checkpoint` / `chess-context` 这些同类型事件是
 *      系统或模型注入的，**一律不作源**（`compact-checkpoint` 是模型摘要 —— 从摘要再抽取 = 自证污染）。
 *      另加**内容闸** `stripMemoryLedger`（T245）：即使来源标记被上游改写/透传，`<memory-ledger>…</memory-ledger>`
 *      段也会先被剥掉再切句 —— 两道闸互不依赖。
 *   3. **工具**：`tool/call` 事件的 `data.name` 集合；没有事件时回退到棋谱边的 `action` 前缀（`bash(...)` → `bash`）。
 * - 源分层：给了 `events`（或 R01 的 `{header, events}` 整体）就用事件；没给才回退到棋谱本身
 *   （`kind:"user"` 节点的 `text` / `constraints`、边的 `action`）。同一批事件派生出的棋谱不重复计入约束。
 *
 * 允许依赖：`node:` 内置模块 / R00。禁止依赖：上游包、模型调用、R04/R05。
 */

/** 单条引文上限（码点计，"字"）。 */
export const MAX_QUOTE = 200;

/** 每段用户消息最多保留的约束句数（与上游 `extractConstraints` 同口径）。 */
export const MAX_CONSTRAINTS_PER_MESSAGE = 40;

/** 句末标点（含换行）——切句用，保留在句子里（原样截取，不改写）。 */
const SENTENCE_END = /(?<=[。！？!?；;\n])/;

/**
 * 硬约束词：出现即"这条要求是必须的/禁止的"。
 * 词集语义对齐上游 `kifu-model.mjs` 的 `CONSTRAINT_RE`（必须|不要|不能|不许|禁止|只能|一定要|务必|
 * 记得|注意|要求|永远|绝不|never|must|do not|don't|only|always|required），再补「别X」系列以覆盖
 * "别忘/别再/别用/别把"，并按"是否可违反"拆硬/软两档（软档只作参考面，见 方案.md §2.2）。
 */
export const CONSTRAINT_HARD_RE =
  /(必须|不要|不能|不许|不准|禁止|只能|一定要|务必|永远|绝不|never|must|do not|don't|only|always|required?|别忘|别再|别用|别把|别删|别动|别改|别碰|别写|别说)/i;

/** 软约束词：偏好/建议/习惯类，不构成"必须"，但仍是用户显式说过的话。 */
export const CONSTRAINT_SOFT_RE = /(记得|注意|要求|以后|下次|默认|应该|最好|避免|remember|avoid|prefer)/i;

/** 约束词全集（判断"这句是不是约束句"用）。 */
const CONSTRAINT_ANY_RE = new RegExp(`${CONSTRAINT_HARD_RE.source}|${CONSTRAINT_SOFT_RE.source}`, 'i');
const CONSTRAINT_ANY_G = new RegExp(`${CONSTRAINT_HARD_RE.source}|${CONSTRAINT_SOFT_RE.source}`, 'gi');

/** 事件 `result` → 信号桶。未列出的结果值不猜，进 `dropped.unknownResult`。 */
const RESULT_BUCKET = Object.freeze({
  failure: 'failures',
  success: 'successes',
  untested: 'unsettled',
  unverified: 'unsettled',
  pending: 'unsettled',
});

/** 用户真的说过话的事件来源（其余同类事件是系统/模型注入，不作源）。 */
const USER_SOURCE_KIND = 'user';

/**
 * 截引文：去首尾空白、连续空白压成单空格、按码点截到 `max` 字（截断时末位补 `…`）。
 * 只做"排版级"归一，不改词、不改标点顺序。
 */
/**
 * T67（2026-11-09）：**引文截断不许加省略号**（与 `claim.clipQuote` 同口径）。
 *
 * `support.quote` 是可机械核验的出处指针（必须是原文的逐字子串），不是展示文本；
 * 旧实现走 `clip()`（截断时追加 `…`）⇒ 任何超长引文都必然"不是子串"。
 */
export function clipQuote(text, max = MAX_QUOTE) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return [...s].slice(0, Math.max(1, max)).join('');
}

export function clip(text, max = MAX_QUOTE) {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  const chars = [...s];
  if (chars.length <= max) return s;
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/**
 * 从消息形状里取纯文本。容忍三种包裹：`data`（`{content}` / `{message:{content}}`）、
 * 消息对象本身、以及 content 数组里的 `{type:"text",text}` 片段。`reasoning` / `tool-call` 片段不算原文。
 */
export function messageText(value) {
  const parts = [];
  const push = (v) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'string') {
      if (v.length > 0) parts.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const p of v) push(p);
      return;
    }
    if (typeof v !== 'object') return;
    const type = v.type;
    if (type === 'reasoning' || type === 'tool-call' || type === 'tool-result') return;
    if (typeof v.text === 'string') {
      parts.push(v.text);
      return;
    }
    if (v.content !== undefined) {
      push(v.content);
      return;
    }
    if (v.message !== undefined) push(v.message);
  };
  push(value);
  return parts.join('\n').trim();
}

/** 注入卡的开/闭标记（与 `src/rooms/inject.mjs` 的 `renderLedger` 同形）。 */
export const MEMORY_LEDGER_OPEN = '<memory-ledger>';
export const MEMORY_LEDGER_CLOSE = '</memory-ledger>';

/**
 * 剥掉 `<memory-ledger>…</memory-ledger>` 段（连标记一起）。
 *
 * 为什么（AGENTS §2.3 自证污染）：注入卡是**本系统自己生成的文本**（R12 渲染），不是用户原话、
 * 也不是原始工具输出。它比模型摘要更该被排除 —— 摘要至少还是"外部产物"，卡是"自己写的"。
 *
 * 当前语料里卡事件的 `data.source.kind` 全是 `dsh-gokifu-longmemory`，已被 `isUserMessage` 挡在门外；
 * 本函数是**第二道闸**：按内容剥，不依赖来源标记（来源标记一旦被上游改写/透传就失效）。
 *
 * 未闭合（写盘撕裂/截断）按"从开标记到文本末尾"处理 —— 宁多剥，不让卡尾混进语料。
 * @param {string} text
 * @returns {string}
 */
export function stripMemoryLedger(text) {
  const src = String(text ?? '');
  let out = '';
  let cursor = 0;
  for (;;) {
    const open = src.indexOf(MEMORY_LEDGER_OPEN, cursor);
    if (open < 0) return out + src.slice(cursor);
    out += src.slice(cursor, open);
    const close = src.indexOf(MEMORY_LEDGER_CLOSE, open + MEMORY_LEDGER_OPEN.length);
    if (close < 0) return out; // 未闭合：后面全算卡内
    cursor = close + MEMORY_LEDGER_CLOSE.length;
  }
}

/** 这句命中了哪些约束词（逐个去重，机械证据，不是评分）。 */
export function matchedConstraintWords(text) {
  const s = String(text ?? '');
  const hits = s.match(CONSTRAINT_ANY_G) ?? [];
  return [...new Set(hits.map((h) => h.toLowerCase()))];
}

/**
 * 从一段用户原话里抽约束句：按句末标点/换行切句 → 保留命中约束词的句子 → 逐字返回（只去首尾空白）。
 * 不做改写、不做摘要、不判语义"像不像"。
 * @returns {string[]}
 */
export function extractConstraints(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return [];
  return raw
    .split(SENTENCE_END)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && CONSTRAINT_ANY_RE.test(s))
    .slice(0, MAX_CONSTRAINTS_PER_MESSAGE);
}

/** 事件数组归一：接受数组、`{events:[...]}`（R01 `parseEvents` 的返回）或 `undefined`。 */
function normalizeEvents(events) {
  if (Array.isArray(events)) return events;
  if (events && typeof events === 'object' && Array.isArray(events.events)) return events.events;
  return [];
}

/** 边的源 seq：`evidence.start`（动作事件）优先，退 `evidence.end`（结果事件）。 */
function edgeSeq(edge) {
  const ev = edge?.evidence ?? {};
  if (Number.isFinite(ev.start)) return ev.start;
  if (Number.isFinite(ev.end)) return ev.end;
  return null;
}

/**
 * 测试**通过**汇总（T251 假阳性）：这类文本是"一切正常"的绿色信号，**不可能是失败原文**。
 *
 * 事故：`node --test … | grep -E "^ℹ (tests|pass|fail)"` 这类命令，真失败在别处（`exit 1` 来自后半段），
 * 但 `errorSnippet` 抓到的是 grep 出来的那一行绿字 ⇒ 建出一条 `[antipattern] ℹ tests 69 ℹ pass 69 ℹ fail 0`，
 * 既占卡位、又误导模型（"全绿"被当成坑）、还拉低主判据。
 *
 * 命中形态（**列全**，且必须没有失败标记才算）：
 *   ① `node --test` 汇总：`ℹ tests 69 ℹ pass 69 ℹ fail 0`（单行与换行版都认）
 *   ② TAP 汇总：`# tests 12` / `# pass 12` / `# fail 0`
 *   ③ mocha/jest：`12 passing` / `0 failing`
 *   ④ TAP 单点：整行只有 `ok 12`
 * 反例（**必须仍判失败**）：`fail 1` `fail 2` `✖ …` `not ok 3` `failing tests:` 任何含 `Error/FAIL` 的行。
 */
const PASS_SUMMARY_RES = Object.freeze([
  // 单行与多行两种形态都要认（真库实测都有：`ℹ tests 69 ℹ pass 69 ℹ fail 0` 与换行版）
  /ℹ\s+tests\s+\d+[\s\S]*?ℹ\s+pass\s+\d+[\s\S]*?ℹ\s+fail\s+0\b/,
  /(?:^|\n)\s*#\s*tests\s+\d+\s*(?:\n|$)/,
  /(?:^|\n)\s*#\s*pass\s+\d+\s*(?:\n|$)/,
  /(?:^|\n)\s*#\s*fail\s+0\s*(?:\n|$)/,
  /(?:^|\n)\s*\d+\s+passing\b/,
  /(?:^|\n)\s*0\s+failing\b/,
  /^\s*ok\s+\d+\s*$/,
]);

/** 失败标记：出现任意一条，就不许当"通过汇总"（防误伤真失败）。 */
const FAILURE_MARK_RES = Object.freeze([
  /(?:^|\n)\s*ℹ\s+fail\s+[1-9]/,
  /(?:^|\n)\s*#\s*fail\s+[1-9]/,
  /(?:^|\n)\s*not ok\s+\d+/,
  /[✖✗]/,
  /\bFAIL(?:ED|URE)?\b/,
  /\bfailing tests?\b/,
  /(?:^|\n)\s*[1-9]\d*\s+failing\b/,
  /\bError\b/,
]);

/**
 * 这段文本是不是"测试通过汇总"（⇒ 不能当失败原文）。
 * 判定 = 命中任一 PASS 形态 **且** 不含任何失败标记。
 */
export function isTestPassSummary(text) {
  const t = String(text ?? '');
  if (!t.trim()) return false;
  if (FAILURE_MARK_RES.some((re) => re.test(t))) return false;
  return PASS_SUMMARY_RES.some((re) => re.test(t));
}

/** 通过汇总的形态清单（供审计/证据引用，避免"正则写在代码里没人看得见"）。 */
export const TEST_PASS_SUMMARY_FORMS = Object.freeze([
  'ℹ tests N ℹ pass N ℹ fail 0（node --test，单行/换行都认）',
  '# tests N / # pass N / # fail 0（TAP）',
  'N passing / 0 failing（mocha、jest）',
  'ok N（TAP 单点）',
]);

/**
 * 边的引文。
 * - 失败边：先取「结果原文」`errorSnippet`（工具输出的原文片段）；没有就取 `verify.summary`
 *   （`exit 1` / host-error 的错误原文 —— 那也是原始的失败事实）；再没有才退到动作原文。
 * - 成功/未结算边：用**动作原文**（"怎么做的"才是可复用的那一手）；`exit 0` 这类摘要不当引文。
 *
 * T251：`errorSnippet` 若是**测试通过汇总**，它就不是失败原文（真失败在别处）⇒ 跳过它，退到 `verify.summary`。
 */
function edgeQuote(edge) {
  const snippet = String(edge?.errorSnippet ?? '').trim();
  if (snippet && !isTestPassSummary(snippet)) return snippet;
  if (edge?.result === 'failure') {
    const kind = edge?.verify?.kind;
    const summary = String(edge?.verify?.summary ?? '').trim();
    if (summary && (kind === 'exit' || kind === 'host-error')) return `${kind}: ${summary}`;
  }
  const action = String(edge?.action ?? '').trim();
  if (action) return action;
  return String(edge?.intent ?? '').trim();
}

/** 边 `action` 形如 `bash(command=...)` / `write(file_path=...)` —— 前缀就是工具名（机械回退）。 */
function toolFromAction(action) {
  const m = /^\s*([A-Za-z][\w-]{0,40})\(/.exec(String(action ?? ''));
  return m ? m[1] : null;
}

/** 事件是不是"用户真的说了话"的那一条。 */
function isUserMessage(ev) {
  if (ev?.type !== 'user/message') return false;
  const kind = ev.data?.source?.kind;
  if (kind === undefined) return ev.data?.role === 'user';
  return kind === USER_SOURCE_KIND;
}

/**
 * T343 · F3「可反驳」的**文本派生**（text-derived，不是观测）。
 *
 * 背景（`evidence/T343-f3-text-derivation.md`）：
 *   · 从**会话恢复证据**推 F3，对 antipattern 只有 **2.61%（4/153）** —— antipattern 恰恰是
 *     「当场没修好」的错误类，恢复证据天然稀缺（T338/T339 已量化）。
 *   · 改从**错误文本本身**机械派生「什么情况算我错」，同一真库实测 **43.35%（561/1294）**。
 *
 * 契约：
 *   · 纯函数、零依赖、规则表可审计（每条有 id）；命中即产出 `when` + 逐字 `quote`。
 *   · `kind: 'text-pattern'` 明确标注「由文本派生」，**不冒充「观测到恢复」**（那是 T339 的 `same-command-success`）。
 *   · 判不出 ⇒ `null`（不编）。
 *   · 顺序敏感：更具体的规则排在更泛的规则之前（如 `http-404` 先于 `generic-not-found`）。
 */
export const FALSIFIABLE_RULES = Object.freeze([
  { id: 'missing-module', re: /Cannot find module ['"`]?([^'"`\n]+)['"`]?/i, when: (m) => `当模块 ${m[1].trim()} 可被加载时不再成立` },
  { id: 'enoent', re: /ENOENT[^\n]*?['"`]([^'"`\n]+)['"`]/i, when: (m) => `当路径 ${m[1].trim()} 存在时不再成立` },
  { id: 'no-such-file', re: /no such file or directory/i, when: () => '当目标文件存在时不再成立' },
  { id: 'cmd-not-found', re: /not recognized as an internal or external command|command not found|Executable not found in \$?PATH/i, when: () => '当该命令在 PATH 中可执行时不再成立' },
  { id: 'permission', re: /permission denied|EACCES|EPERM/i, when: () => '当所需权限可用时不再成立' },
  { id: 'econnrefused', re: /ECONNREFUSED/i, when: () => '当目标服务在监听时不再成立' },
  { id: 'eaddrinuse', re: /EADDRINUSE/i, when: () => '当端口空闲时不再成立' },
  { id: 'timeout', re: /ETIMEDOUT|timed out/i, when: () => '当在时限内完成时不再成立' },
  { id: 'syntax-error', re: /\bSyntaxError\s*:/i, when: () => '当源码语法合法时不再成立' },
  { id: 'type-error', re: /\bTypeError\s*:/i, when: () => '当类型满足预期时不再成立' },
  { id: 'not-a-function', re: /([\w.$]+) is not a function/i, when: (m) => `当 ${m[1]} 是函数时不再成立` },
  { id: 'undefined-prop', re: /Cannot read propert(?:y|ies) of (?:undefined|null)/i, when: () => '当该属性访问的对象非空时不再成立' },
  { id: 'http-404', re: /HTTP[\s/]*404|\b404\s*Not Found|status(?:Code)?\s*[:=]\s*404|E404|No match found for version/i, when: () => '当资源可访问（返回 2xx）时不再成立' },
  { id: 'http-auth', re: /Unauthorized|Forbidden|E40[13]\b/i, when: () => '当授权有效时不再成立' },
  { id: 'json-parse', re: /Unexpected token .* in JSON|Unexpected end of JSON|JSON\.parse|ConvertFrom-Json/i, when: () => '当输入是合法 JSON 时不再成立' },
  { id: 'already-exists', re: /EEXIST|already exists/i, when: () => '当目标不存在时不再成立' },
  { id: 'git-fatal', re: /^fatal:\s*\S/m, when: () => '当 git 前置状态满足该命令时不再成立' },
  { id: 'tests-fail', re: /failing tests?:|ℹ fail [1-9]\d*|[✖✗]\s*\d+\s*(?:test|个)/i, when: () => '当同一测试通过时不再成立' },
  { id: 'exit-nonzero', re: /\[?exit code:?\s*([1-9]\d*)\]?/i, when: (m) => `当同一命令返回 0（而非 ${m[1]}）时不再成立` },
  { id: 'generic-not-found', re: /\bnot found\b|no match found/i, when: () => '当该对象/资源存在时不再成立' },
]);

/**
 * 从失败原文机械派生「什么情况算我错」（F3）。
 * @returns {{kind:'text-pattern', rule:string, when:string, quote:string}|null}
 */
export function deriveFalsifiableWhen(text, { maxQuote = MAX_QUOTE } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  for (const r of FALSIFIABLE_RULES) {
    const m = r.re.exec(raw);
    if (!m) continue;
    return { kind: 'text-pattern', rule: r.id, when: r.when(m), quote: clipQuote(raw, maxQuote) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// T28 · 「恢复事实」——失败之后，**同一个主体后来成功**的事件（只写事实，不写建议）
//
// 背景（T26）：事实型卡只写「哪一局、跑了什么、报了什么错」，方向对但弱于指令式（25% vs 58.3%，p=0.125）。
// 卡形态要补的是「当时怎么修好的」——以**事实**形式，不是祈使句（AGENTS §2.1）。
//
// 判据（沿用 T311/T339 的机械路线，**只认显式成功**，宁缺勿编）：
//   · `same-command-exit-0`：同一条 bash 命令（tool/call 的 `command` 原文）后来**再次执行**，
//     结果里有 `[exit code: 0]`；
//   · `same-command-no-failure`：同一条命令后来再次执行、**没有失败行**（是"重跑没报错"，不是 exit 0）；
//   · `same-file-write-ok`：同一个 `file_path` 后来被 `write`/`edit` **写成功**（成功标记见 `WRITE_OK_RE`）。
// 全部带 `seq` + 事件 `time`；取不到时间/序号的一律不产出（无源不入、无时不入）。
//
// 与 `scripts/extract-recovery.mjs`（T311/T339）的关系：判据同源，但本函数**读时**在卡行上派生，
// 且只认显式成功标记（脚本那边还接受 tests-pass/build-success 等信号，T338 实测它们在同主体约束下新增 0）。
// ---------------------------------------------------------------------------

/** 恢复事实的种类（渲染文案在 `inject.mjs`；这里只给机械判据）。 */
export const RECOVERY_FACT_KINDS = Object.freeze([
  'same-command-exit-0',
  'same-command-no-failure',
  'same-file-write-ok',
  // T34：**同工具族**后来成功（不是同一命令/同一文件；卡上必须标「同工具族」）
  'same-tool',
]);

/**
 * T34 · 恢复事实的分档（**只用于计数与文案，不合并成一个覆盖率**）：
 *   · `exact`     —— 同一命令/同一文件，逐字相同（T28 的三档）
 *   · `same-file` —— 同一个 file_path 后来写成功（T28 第三档）
 *   · `same-tool` —— 同工具族（命令族 / 同目录的 write/edit）后来显式成功（T34 新增，最弱档）
 */
export const RECOVERY_TIER_OF = Object.freeze({
  'same-command-exit-0': 'exact',
  'same-command-no-failure': 'exact',
  'same-file-write-ok': 'same-file',
  'same-tool': 'same-tool',
});

/** 恢复事实的种类 → 档位（未知 kind ⇒ null，不猜）。 */
export function recoveryTierOf(kind) {
  return RECOVERY_TIER_OF[String(kind ?? '')] ?? null;
}

/**
 * T34 · 命令 → **工具族**（机械归一：跳过前置环境变量赋值，取首个非开关词 + 可选的次词）。
 * 例：`git push origin main` ⇒ `git push`；`node scripts/check.mjs --x` ⇒ `node scripts/check.mjs`；
 *     `pnpm run test` ⇒ `pnpm run`；`ls -la` ⇒ `ls`。
 */
export function recoveryCommandFamily(command) {
  const tokens = String(command ?? '').split(' ').filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  if (i >= tokens.length) return null;
  const head = tokens[i].toLowerCase();
  const next = tokens[i + 1];
  if (!next || next.startsWith('-')) return head;
  return `${head} ${next.toLowerCase()}`;
}

/** T34 · file_path → 目录（归一：反斜杠→斜杠、小写、去尾部斜杠）。 */
export function recoveryDirOf(filePath) {
  const p = String(filePath ?? '').replace(/\\/g, '/').toLowerCase();
  const idx = p.lastIndexOf('/');
  if (idx < 0) return null;
  return p.slice(0, idx) || '/';
}

/** write/edit 工具结果的**成功**标记（DSH 实际文案；没有它就不算"写成功"）。 */
const WRITE_OK_RE = /has been (?:updated|created|written)(?: successfully)?|Created file|successfully (?:wrote|written|updated|created|replaced)/i;

/** 事件 → 文本（多段用换行拼接；不用 JSON.stringify，避免转义造成假阴）。 */
function recoveryEventText(ev) {
  const out = [];
  const push = (v) => {
    if (v == null) return;
    if (typeof v === 'string') { out.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) push(x); return; }
    if (typeof v === 'object') { for (const x of Object.values(v)) push(x); }
  };
  push(ev?.data ?? ev ?? {});
  return out.join('\n').trim();
}

/**
 * **行级**失败定位（与 `scripts/extract-recovery.mjs` 的 `failureLineOf` 同判据）：
 * ① 行首错误原文 `Error:` / `XxxError:` / `Exception:`；② 独占一行的非零 `[exit code: N]`。
 * 行中间出现 Error 字样不算（系统提示词/日志正文里到处都有）。
 */
export function failureLineOfText(text) {
  for (const raw of String(text ?? '').split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    const m = /^\[?exit code:?\s*(-?\d+)\]?$/i.exec(t);
    if (m && Number(m[1]) !== 0) return t;
    if (/^(?:[A-Za-z_]*Error|Exception)\s*:/.test(t) && t.length <= 400) return t;
  }
  return null;
}

/** 路径规范化（只做机械归整：反斜杠→正斜杠、小写；不做"补全/猜测"）。 */
function recoveryNormPath(p) {
  return String(p ?? '').replace(/\\/g, '/').toLowerCase();
}

/** tool/call → {name, cmd, fp}；解析不出参数时返回 null（不猜）。 */
function recoveryCallInfo(call) {
  const name = call?.data?.name;
  if (typeof name !== 'string' || !name) return null;
  let args = {};
  try { args = JSON.parse(call?.data?.arguments ?? '{}'); } catch { args = {}; }
  const fp = args.file_path ?? args.path ?? null;
  const cmd = typeof args.command === 'string' ? args.command.replace(/\s+/g, ' ').trim() : null;
  return {
    name,
    cmd,
    fp: fp ? recoveryNormPath(fp) : null,
    // T34：同工具族判据（命令族 / 同目录）
    family: cmd ? recoveryCommandFamily(cmd) : null,
    dir: fp ? recoveryDirOf(recoveryNormPath(fp)) : null,
  };
}

/** 从失败原文里取"像路径"的主体（没有 ⇒ null；不拿前 N 字兜底，T338）。 */
export function recoverySubjectOfText(text) {
  const m = /(?:[A-Za-z]:)?[/\\][\w./\\-]{3,}\.\w{1,6}|[\w.-]+\.(?:m?js|cjs|ts|tsx|json|md|ya?ml|go|py)/.exec(String(text ?? ''));
  return m ? recoveryNormPath(m[0]) : null;
}

/**
 * 一局事件 → 可查询的恢复索引（纯函数；`inject` 读时调用）。
 * @returns {{runs: object[], failures: object[]}}
 *   run = {name, cmd, fp, seq, at, text, failed, exit0, ok}
 *   failure = run 中 `failed` 的子集（带行级失败原文 `line`）
 */
export function buildRecoveryIndex(events = []) {
  const list = normalizeEvents(events);
  const calls = new Map();
  const timeBySeq = new Map();
  for (const ev of list) {
    if (Number.isFinite(ev?.seq) && Number.isFinite(ev?.time)) timeBySeq.set(Number(ev.seq), Number(ev.time));
    if (ev?.type === 'tool/call' && typeof ev?.data?.callId === 'string') calls.set(ev.data.callId, ev);
  }
  const runs = [];
  for (const ev of list) {
    if (ev?.type !== 'tool/result') continue;
    const callId = ev?.data?.message?.toolCallId ?? ev?.data?.toolCallId ?? null;
    const info = recoveryCallInfo(callId ? calls.get(callId) : null);
    if (!info) continue;
    const seq = Number(ev.seq);
    if (!Number.isFinite(seq) || seq < 1) continue;
    const text = recoveryEventText(ev);
    const line = failureLineOfText(text);
    runs.push({
      ...info,
      seq,
      at: timeBySeq.has(seq) ? timeBySeq.get(seq) : null,
      text,
      line,
      failed: line !== null,
      exit0: /\[exit code: 0\]/.test(text),
      ok: line === null && WRITE_OK_RE.test(text),
    });
  }
  return { runs, failures: runs.filter((r) => r.failed) };
}

/** 失败原文 → 匹配前缀（去掉截断省略号、压空白；太短 ⇒ null，避免"Error:"这种到处都有的前缀）。 */
export function recoveryMatchPrefix(quote, { minLength = 8, maxLength = 60 } = {}) {
  const s = String(quote ?? '').replace(/…$/, '').replace(/\s+/g, ' ').trim();
  if (s.length < minLength) return null;
  return s.slice(0, maxLength);
}

/**
 * T30：一局事件 → **所有**可落索引的恢复事实（归档层用；纯函数）。
 * 每条 = `{episode, failureSeq, kind, seq, at, prefix}`；`prefix` 是失败原文的匹配前缀（读时用它对齐卡上的引文）。
 * 同一段错误出现多次时，逐条按自己的 seq 就近匹配（`nearSeq`），不会互相串。
 * @returns {Array<{episode:string|null, failureSeq:number, kind:string, seq:number, at:number, prefix:string}>}
 */
export function collectRecoveryFacts({ events = [], episode = null } = {}) {
  const index = buildRecoveryIndex(events);
  const out = [];
  for (const failure of index.failures) {
    const fact = findRecoveryFact(index, failure.line, { nearSeq: failure.seq });
    if (!fact) continue;
    const prefix = recoveryMatchPrefix(failure.line);
    if (!prefix) continue;
    out.push({
      episode: typeof episode === 'string' && episode ? episode : null,
      failureSeq: failure.seq,
      kind: fact.kind,
      seq: fact.seq,
      at: fact.at,
      prefix,
    });
  }
  return out;
}

/**
 * 在索引里给一条失败原文找「后来同一主体成功」的事实。
 * @param {{runs:object[], failures:object[]}} index `buildRecoveryIndex` 的产出
 * @param {string} quote 失败原文（claim 的 support.quote / 卡行正文）
 * @returns {{kind:string, seq:number, at:number, failureSeq:number, subject:string|null}|null}
 */
export function findRecoveryFact(index, quote, { nearSeq = null, includeSameTool = true } = {}) {
  const prefix = recoveryMatchPrefix(quote);
  if (!prefix) return null;
  const failures = Array.isArray(index?.failures) ? index.failures : [];
  const runs = Array.isArray(index?.runs) ? index.runs : [];
  const candidates = failures.filter((r) => typeof r.text === 'string' && r.text.includes(prefix));
  if (!candidates.length) return null;
  // 同一段错误原文在一局里可能出现多次（别的工具结果里也贴过它）⇒ 取**离卡上出处 seq 最近**的那条；
  // 没有 seq 线索时取最早一条（T311：同主体约束不变，仍不凑数）。
  const cur = Number.isFinite(nearSeq)
    ? candidates.reduce((best, r) => (Math.abs(r.seq - nearSeq) < Math.abs(best.seq - nearSeq) ? r : best), candidates[0])
    : candidates[0];
  const withTime = (fact) => (fact && Number.isFinite(fact.seq) && Number.isFinite(fact.at) ? fact : null);
  // ① 命令级：同一条 bash 命令后来 exit 0；没有 exit 0 再退到"重跑无失败输出"
  if (cur.name === 'bash' && cur.cmd) {
    const later = runs.find((r) => r.seq > cur.seq && r.name === 'bash' && r.cmd === cur.cmd && r.exit0);
    if (later) return withTime({ kind: 'same-command-exit-0', seq: later.seq, at: later.at, failureSeq: cur.seq, subject: cur.cmd });
    const again = runs.find((r) => r.seq > cur.seq && r.name === 'bash' && r.cmd === cur.cmd && !r.failed);
    if (again) return withTime({ kind: 'same-command-no-failure', seq: again.seq, at: again.at, failureSeq: cur.seq, subject: cur.cmd });
  }
  // ② 文件级：同一个 file_path 后来被 write/edit 写成功
  const subjectPath = cur.fp ?? recoverySubjectOfText(prefix);
  if (subjectPath) {
    const later = runs.find((r) => r.seq > cur.seq && (r.name === 'write' || r.name === 'edit') && r.fp === subjectPath && r.ok);
    if (later) return withTime({ kind: 'same-file-write-ok', seq: later.seq, at: later.at, failureSeq: cur.seq, subject: subjectPath });
  }
  // ③ T34：**同工具族**后来显式成功（最弱档；卡上必须写「同工具族」，不许写成"同一命令"）
  if (!includeSameTool) return null;
  if (cur.name === 'bash' && cur.family) {
    const later = runs.find((r) => r.seq > cur.seq && r.name === 'bash' && r.family === cur.family && r.exit0);
    if (later) return withTime({ kind: 'same-tool', seq: later.seq, at: later.at, failureSeq: cur.seq, subject: cur.family });
  }
  if ((cur.name === 'write' || cur.name === 'edit') && cur.dir) {
    const later = runs.find((r) => r.seq > cur.seq && (r.name === 'write' || r.name === 'edit') && r.dir === cur.dir && r.ok);
    if (later) return withTime({ kind: 'same-tool', seq: later.seq, at: later.at, failureSeq: cur.seq, subject: cur.dir });
  }
  return null;
}

/**
 * 机械抽取。
 *
 * @param {{graph?: object|null, events?: object[]|{events:object[]}, maxQuote?: number}} input
 * @returns {{
 *   failures: object[], successes: object[], unsettled: object[], constraints: object[], tools: object[],
 *   counts: {failures:number, successes:number, unsettled:number, constraints:number, tools:number, byResult:object},
 *   dropped: {noSource:number, noQuote:number, unknownResult:number},
 *   scanned: {edges:number, events:number, userMessages:number, toolCalls:number}
 * }}
 */
export function extractSignals({ graph = null, events = null, maxQuote = MAX_QUOTE } = {}) {
  const list = normalizeEvents(events);
  const failures = [];
  const successes = [];
  const commandSuccesses = [];
  const unsettled = [];
  const constraints = [];
  const dropped = { noSource: 0, noQuote: 0, unknownResult: 0, falsePositive: 0 };
  const byResult = {};
  const scanned = { edges: 0, events: list.length, userMessages: 0, toolCalls: 0 };

  const quote = (t) => clip(t, maxQuote);

  // T274：`occurredAt` 必须取**该 support 所指事件自己的 `time`**。
  // 旧实现用 `edge.ts` —— 上游写边时取的是 `seq+1`（tool/call）那一格的时间，
  // 于是 claim 的"出处"（support.seq）与"发生时间"不属于同一个事件
  // （知识库 57 的 L3 不变量：来源与时间是同一条事件的两个面）。
  //   · 该事件有 time  ⇒ 用它（timeSource='event'）
  //   · 没有 time      ⇒ **不许借用下一条事件的时间**；向前找 seq-1，并标 timeSource='previous-event'
  //   · 前后都没有     ⇒ occurredAt=null（缺时间 = 假记忆，交给上游 ep.at 兜底，绝不编）
  const timeBySeq = new Map();
  for (const ev of list) {
    const s = Number(ev?.seq);
    const t = Number(ev?.time);
    if (Number.isFinite(s) && Number.isFinite(t)) timeBySeq.set(s, t);
  }
  const occurredAtOf = (s, edge = null) => {
    const own = timeBySeq.get(Number(s));
    if (own !== undefined) return { occurredAt: own, timeSource: 'event' };
    const prev = timeBySeq.get(Number(s) - 1);
    if (prev !== undefined) return { occurredAt: prev, timeSource: 'previous-event' };
    // 完全离线（没有事件可读，如只给棋谱的考古路径）⇒ 退到边自己的 ts，但**标明来源可疑**：
    // 上游写边时 ts 取的是 seq+1 那一格，不能当"该事件的时间"。有事件时一律不用它。
    if (list.length === 0 && Number.isFinite(edge?.ts)) return { occurredAt: Number(edge.ts), timeSource: 'edge-ts' };
    return { occurredAt: null, timeSource: null };
  };

  // ── 1. 边结果 ────────────────────────────────────────────────
  const edges = Object.values(graph?.edges ?? {});
  edges.sort((a, b) => {
    const d = (edgeSeq(a) ?? Number.MAX_SAFE_INTEGER) - (edgeSeq(b) ?? Number.MAX_SAFE_INTEGER);
    return d !== 0 ? d : String(a?.id ?? '').localeCompare(String(b?.id ?? ''), 'en');
  });
  for (const edge of edges) {
    scanned.edges += 1;
    const bucket = RESULT_BUCKET[edge?.result];
    if (!bucket) {
      dropped.unknownResult += 1;
      continue;
    }
    byResult[edge.result] = (byResult[edge.result] ?? 0) + 1;
    const seq = edgeSeq(edge);
    if (seq === null) {
      dropped.noSource += 1;
      continue;
    }
    const q = quote(edgeQuote(edge));
    if (!q) {
      dropped.noQuote += 1;
      continue;
    }
    // T251：失败边拿到的是**测试通过汇总** ⇒ 不是失败原文（真失败在别处）⇒ 记 falsePositive、不建 claim。
    // 判据看**原始 snippet**（即使 edgeQuote 已退到 `exit: exit 1` 这类合成摘要，绿字仍不算失败原文）。
    if (bucket === 'failures' && isTestPassSummary(String(edge?.errorSnippet ?? '').trim() || q)) {
      dropped.falsePositive += 1;
      continue;
    }
    const entry = {
      seq,
      quote: q,
      nodeId: edge.from ?? edge.to ?? null,
      edgeId: edge.id ?? null,
      from: edge.from ?? null,
      to: edge.to ?? null,
      result: edge.result,
      verifyKind: edge.verify?.kind ?? null,
      transposition: edge.transposition === true,
      // T274：取**该 seq 事件自己的 time**（旧实现用 edge.ts = seq+1 的时间，属跨事件借时）
      ...occurredAtOf(seq, edge),
      source: 'edge',
    };
    if (bucket === 'failures') {
      // T343：失败边顺带派生 F3 失效条件（文本派生；判不出就不挂，不编）
      const f3 = deriveFalsifiableWhen(q, { maxQuote });
      if (f3) entry.falsifiableWhen = f3;
      failures.push(entry);
    }
    else if (bucket === 'successes') successes.push(entry);
    else unsettled.push(entry);
  }

  // ── 1b. 命令成功（S11，2026-11-02）：tool/result 以 `[exit code: 0]` 结尾 ⇒ 可验证成功 ──
  // 依据：R08 真实语料 0 候选，是因为上游成功边全是 write 型；而 `bash/node --test` 这类
  // "命令跑通"在日志里有 DSH 自己的退出码标记，属于可机械判定的成功。只收命令文本作 quote，
  // 不收输出（输出里常含噪声），每条带 seq/time，无源不入。
  if (list.length > 0) {
    const calls = new Map();
    for (const ev of list) {
      if (ev?.type === 'tool/call') {
        const callId = ev.data?.callId ?? ev.data?.message?.toolCallId ?? null;
        if (typeof callId === 'string') {
          calls.set(callId, {
            name: typeof ev.data?.name === 'string' ? ev.data.name : null,
            args: typeof ev.data?.arguments === 'string' ? ev.data.arguments : '',
            seq: Number.isFinite(ev.seq) ? ev.seq : null,
            time: Number.isFinite(ev.time) ? ev.time : null,
          });
        }
        continue;
      }
      if (ev?.type !== 'tool/result') continue;
      const text = messageText(ev.data?.message ?? ev.data);
      const m = /\[exit code: (\d+)\]\s*$/.exec(text ?? '');
      if (!m || m[1] !== '0') continue;
      const callId = ev.data?.toolCallId ?? ev.data?.message?.toolCallId ?? null;
      const call = callId ? calls.get(callId) : null;
      if (!call || call.seq === null) {
        dropped.noSource += 1;
        continue;
      }
      let command = '';
      try {
        const parsed = call.args ? JSON.parse(call.args) : null;
        command = typeof parsed?.command === 'string' ? parsed.command : (call.args ?? '');
      } catch {
        command = call.args ?? '';
      }
      const q = quote(command || `${call.name ?? 'tool'} (exit 0)`);
      if (!q) {
        dropped.noQuote += 1;
        continue;
      }
      if (commandSuccesses.some((e) => e.seq === call.seq)) continue;
      commandSuccesses.push({
        seq: call.seq,
        quote: q,
        nodeId: null,
        edgeId: null,
        result: 'success',
        verifyKind: 'exit-code',
        transposition: false,
        occurredAt: call.time,
        tool: call.name,
        source: 'exit-code',
      });
    }
  }

  // ── 2. 约束（用户原话，逐字）────────────────────────────────
  if (list.length > 0) {
    for (const ev of list) {
      if (!isUserMessage(ev)) continue;
      scanned.userMessages += 1;
      const seq = Number.isFinite(ev.seq) ? ev.seq : null;
      // 第二道闸（T245）：即使 source.kind 被上游改写/透传，注入卡文本也不得进入约束抽取。
      // 第一道闸是上面的 isUserMessage（按来源），这道按**内容** —— 两道都不依赖对方。
      const text = stripMemoryLedger(messageText(ev.data?.message ?? ev.data));
      if (!text) continue;
      if (seq === null) {
        dropped.noSource += 1;
        continue;
      }
      for (const sentence of extractConstraints(text)) {
        const q = quote(sentence);
        if (!q) {
          dropped.noQuote += 1;
          continue;
        }
        constraints.push({
          seq,
          quote: q,
          nodeId: null,
          edgeId: null,
          level: CONSTRAINT_HARD_RE.test(sentence) ? 'hard' : 'soft',
          matched: matchedConstraintWords(sentence),
          occurredAt: Number.isFinite(ev.time) ? ev.time : null,
          source: 'event',
        });
      }
    }
  } else if (graph?.nodes) {
    // 回退：棋谱里的 user 节点（离线只剩棋谱时）。`constraints` 是上游按同一原话切的句；没有就自己切。
    for (const node of Object.values(graph.nodes)) {
      if (!node || node.kind !== 'user') continue;
      const seq = Number.isFinite(node.seq) ? node.seq : null;
      const raw = Array.isArray(node.constraints) && node.constraints.length > 0 ? node.constraints : extractConstraints(node.text);
      for (const sentence of raw) {
        const q = quote(sentence);
        if (!q) {
          dropped.noQuote += 1;
          continue;
        }
        if (seq === null) {
          dropped.noSource += 1;
          continue;
        }
        constraints.push({
          seq,
          quote: q,
          nodeId: node.id ?? null,
          edgeId: null,
          level: CONSTRAINT_HARD_RE.test(sentence) ? 'hard' : 'soft',
          matched: matchedConstraintWords(sentence),
          occurredAt: Number.isFinite(node.ts) ? node.ts : null,
          source: 'graph-node',
        });
      }
    }
  }

  // ── 3. 工具 ──────────────────────────────────────────────────
  const toolAgg = new Map();
  const addTool = (name, seq, quoteText, occurredAt) => {
    if (typeof name !== 'string' || !name) return;
    const cur = toolAgg.get(name);
    if (!cur) {
      toolAgg.set(name, { name, seq, quote: quote(quoteText), count: 1, occurredAt });
      return;
    }
    cur.count += 1;
    if (seq !== null && (cur.seq === null || seq < cur.seq)) {
      cur.seq = seq;
      cur.quote = quote(quoteText);
      cur.occurredAt = occurredAt;
    }
  };
  if (list.length > 0) {
    for (const ev of list) {
      if (ev?.type !== 'tool/call') continue;
      scanned.toolCalls += 1;
      const seq = Number.isFinite(ev.seq) ? ev.seq : null;
      const name = ev.data?.name;
      if (seq === null) {
        dropped.noSource += 1;
        continue;
      }
      const args = typeof ev.data?.arguments === 'string' ? ev.data.arguments : JSON.stringify(ev.data?.arguments ?? '');
      addTool(name, seq, args ? `${name}(${args})` : String(name ?? ''), Number.isFinite(ev.time) ? ev.time : null);
    }
  }
  if (toolAgg.size === 0) {
    // 回退：棋谱边的 action 前缀。
    for (const edge of edges) {
      const name = toolFromAction(edge?.action);
      if (!name) continue;
      addTool(name, edgeSeq(edge), edge.action, Number.isFinite(edge?.ts) ? edge.ts : null);
    }
  }
  const tools = [...toolAgg.values()].sort((a, b) => {
    const d = (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER);
    return d !== 0 ? d : a.name.localeCompare(b.name, 'en');
  });

  const bySeq = (a, b) => a.seq - b.seq || String(a.edgeId ?? a.nodeId ?? '').localeCompare(String(b.edgeId ?? b.nodeId ?? ''), 'en');
  failures.sort(bySeq);
  successes.sort(bySeq);
  unsettled.sort(bySeq);
  constraints.sort(bySeq);

  return {
    failures,
    successes,
    commandSuccesses,
    unsettled,
    constraints,
    tools,
    counts: {
      failures: failures.length,
      successes: successes.length,
      commandSuccesses: commandSuccesses.length,
      unsettled: unsettled.length,
      constraints: constraints.length,
      tools: tools.length,
      byResult,
    },
    dropped,
    scanned,
  };
}

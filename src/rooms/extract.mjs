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
      occurredAt: Number.isFinite(edge.ts) ? edge.ts : null,
      source: 'edge',
    };
    if (bucket === 'failures') failures.push(entry);
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

/**
 * R03 tombstone test —— 删掉 extract（机械抽取）会让这些断言全红：
 * 失败边不再被识别、系统注入文本被当成"用户约束"、模型摘要被当成源、信号失去 seq/quote 溯源。
 *
 * 事件夹具的形状**逐字取自真实会话日志**（`$DSH_HOME/sessions/…/session.v4.jsonl.zstd`，
 * 2026-11-02 实测 1,861 事件 / 983 帧）：
 *   user/message : {type,seq,time,data:{content:[{type:"text",text}],source:{kind},role,id},surfaceOp}
 *   tool/call    : {type,seq,time,data:{turn,step,callId,name,arguments}}
 *   真实日志里 `user/message` 的 `source.kind` 分布：user 10 / agent-instructions 30 / runtime-context 3 /
 *   skill-catalog 2 / plugin:hindsight 2 / time-context 9 / agent-message 3 / subagent-settled 3 /
 *   compact-checkpoint 1 / chess-context 1 —— 只有 `user` 是用户原话，其余是系统或模型注入。
 *
 * 真实棋谱（冻结样本，与 graphread.test.mjs 同一批）：
 *   A = session-1286ce28-… → failure 边 6、success 边 16、约束 1（棋谱 user 节点回退）、工具 12
 *   C = fa84bf69-…        → failure 边 4、success 边 23、约束 4、工具 6
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractSignals,
  collectRecoveryFacts,
  recoveryCommandFamily,
  recoveryDirOf,
  recoveryTierOf,
  buildRecoveryIndex,
  findRecoveryFact,
  extractConstraints,
  matchedConstraintWords,
  messageText,
  stripMemoryLedger,
  MEMORY_LEDGER_OPEN,
  MEMORY_LEDGER_CLOSE,
  clip,
  MAX_QUOTE,
  isTestPassSummary,
  TEST_PASS_SUMMARY_FORMS,
} from '../src/rooms/extract.mjs';
import { loadGraphAt } from '../src/rooms/graphread.mjs';

const HOME = process.env.DSH_HOME ?? '';
const CORPUS = HOME ? join(HOME, 'chess-context', 'sessions') : '';
const SAMPLE_A = 'session-00000003-0000-4000-8000-000000000003';
const SAMPLE_C = 'fa84bf69-0e4b-422c-aed9-85b8c2462359';
const graphPath = (sid) => join(CORPUS, sid, 'graph.json');
const hasSample = (sid) => Boolean(CORPUS) && existsSync(graphPath(sid));
const len = (s) => [...s].length;

/* ── 事件夹具（形状与真日志一致）────────────────────────── */

const at = (seq) => 1793540000000 + seq;
const userMessage = (seq, text, kind = 'user') => ({
  type: 'user/message',
  seq,
  time: at(seq),
  data: { content: [{ type: 'text', text }], source: { kind, rpcId: `rpc-${seq}` }, role: 'user', id: `u-${seq}` },
  surfaceOp: 'append',
});
const toolCall = (seq, name, args = {}) => ({
  type: 'tool/call',
  seq,
  time: at(seq),
  data: { turn: 1, step: 1, callId: `call_${seq}`, name, arguments: JSON.stringify(args) },
});
const assistantMessage = (seq, text) => ({
  type: 'assistant/message',
  seq,
  time: at(seq),
  data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text }, { type: 'text', text }] } },
});

const edgeOf = (id, seq, extra = {}) => ({
  id,
  from: null,
  to: null,
  intent: '',
  action: 'bash(command=echo hi description=probe)',
  result: 'untested',
  verify: { kind: 'none', summary: '' },
  errorSnippet: '',
  evidence: { start: seq, end: seq },
  transposition: false,
  ts: at(seq),
  ...extra,
});
const graphOf = (edges) => ({ version: 1, nodes: {}, edges, order: Object.keys(edges), stateIndex: {} });

/* ── 约束：只认用户原话 ─────────────────────────────────── */

test('约束：只采信 source.kind==="user" 的 user/message，系统/模型注入的同类型事件一律不作源', () => {
  const events = [
    userMessage(8, '这三条是硬规则：不要救市；必须只读。'),
    userMessage(9, 'You are an AI agent powered by DSH. 你必须遵守系统规则。', 'agent-instructions'),
    userMessage(10, '压缩摘要：之前必须完成 R02。', 'compact-checkpoint'),
    userMessage(11, '技能目录：必须加载 skill', 'skill-catalog'),
    assistantMessage(12, '我认为必须重构。'),
  ];
  const r = extractSignals({ graph: null, events });
  assert.equal(r.scanned.userMessages, 1, '只有一条是用户原话');
  assert.equal(r.scanned.events, 5);
  assert.equal(r.counts.constraints, 2, '硬规则那一句里的两句都命中');
  assert.deepEqual(r.constraints.map((c) => c.seq), [8, 8]);
  for (const c of r.constraints) assert.equal(c.source, 'event');
  assert.equal(r.constraints[0].level, 'hard');
  assert.ok(r.constraints.every((c) => c.quote.includes('必须') || c.quote.includes('不要')));
  // 系统注入与模型摘要里的"必须"一个都不许进
  assert.ok(!r.constraints.some((c) => c.quote.includes('DSH') || c.quote.includes('压缩摘要') || c.quote.includes('技能目录')));
});

test('约束：切句（。！？；换行）后逐字保留原句，不做摘要/改写', () => {
  const text = '第一句是废话。必须走只读模式！不要 push main；这条也别删\n最后一句。';
  const events = [userMessage(20, text)];
  const r = extractSignals({ graph: null, events });
  assert.deepEqual(r.constraints.map((c) => c.quote), ['必须走只读模式！', '不要 push main；', '这条也别删']);
  assert.deepEqual(matchedConstraintWords('必须走只读模式！'), ['必须']);
});

test('约束：无源不入 —— 事件缺 seq 时不收录，只记账', () => {
  const bad = { type: 'user/message', data: { content: [{ type: 'text', text: '必须做这件事' }], source: { kind: 'user' } } };
  const r = extractSignals({ graph: null, events: [bad] });
  assert.equal(r.counts.constraints, 0);
  assert.equal(r.dropped.noSource, 1);
});

test('约束：没有事件的用户原话 → 回退棋谱 user 节点（离线考古只有棋谱时）', () => {
  const graph = {
    version: 1,
    nodes: {
      n1: { id: 'n1', kind: 'user', seq: 13, text: '随便聊聊', constraints: [], ts: at(13) },
      n2: { id: 'n2', kind: 'user', seq: 21, text: '整段原话，必须记下来。下一句。', ts: at(21) },
      n3: { id: 'n3', kind: 'agent', seq: 22, text: '必须', constraints: ['必须'], ts: at(22) },
    },
    edges: {},
    order: ['n1', 'n2', 'n3'],
  };
  const r = extractSignals({ graph });
  assert.equal(r.constraints.length, 1);
  assert.equal(r.constraints[0].seq, 21);
  assert.equal(r.constraints[0].nodeId, 'n2');
  assert.equal(r.constraints[0].source, 'graph-node');
  assert.equal(r.constraints[0].level, 'hard');
});

/* ── 工具 ───────────────────────────────────────────────── */

test('工具：tool/call 的 data.name 聚合（次数 + 首次 seq + 原文引文）', () => {
  const events = [
    toolCall(30, 'bash', { command: 'ls -la' }),
    toolCall(31, 'read', { file_path: 'a.mjs' }),
    toolCall(35, 'bash', { command: 'node --test' }),
  ];
  const r = extractSignals({ graph: null, events });
  assert.equal(r.scanned.toolCalls, 3);
  assert.deepEqual(r.tools.map((t) => [t.name, t.count, t.seq]), [
    ['bash', 2, 30],
    ['read', 1, 31],
  ]);
  assert.ok(r.tools[0].quote.startsWith('bash(') && r.tools[0].quote.includes('ls -la'));
  for (const t of r.tools) assert.ok(len(t.quote) <= MAX_QUOTE);
});

test('工具：没有事件时回退到棋谱边的 action 前缀（bash(...) → bash）', () => {
  const graph = graphOf({
    e1: edgeOf('e1', 5, { action: 'bash(command=pwd)', result: 'success' }),
    e2: edgeOf('e2', 6, { action: 'write(file_path=a.mjs content=hello)', result: 'failure', errorSnippet: 'boom' }),
  });
  const r = extractSignals({ graph });
  assert.deepEqual(r.tools.map((t) => t.name), ['bash', 'write']);
  assert.equal(r.tools[1].count, 1);
});

/* ── 边结果分桶 ─────────────────────────────────────────── */

test('边结果：failure→failures；success→successes；untested/unverified/pending→unsettled；未知值只记账不猜', () => {
  const graph = graphOf({
    e1: edgeOf('e1', 10, { result: 'failure', verify: { kind: 'exit', summary: 'exit 1' }, errorSnippet: 'Error: boom' }),
    e2: edgeOf('e2', 11, { result: 'success' }),
    e3: edgeOf('e3', 12, { result: 'untested' }),
    e4: edgeOf('e4', 13, { result: 'unverified', verify: { kind: 'no-exit', summary: '730 chars, no exit code' } }),
    e5: edgeOf('e5', 14, { result: 'pending' }),
    e6: edgeOf('e6', 15, { result: 'mystery' }),
  });
  const r = extractSignals({ graph });
  assert.deepEqual(r.failures.map((x) => x.edgeId), ['e1']);
  assert.deepEqual(r.successes.map((x) => x.edgeId), ['e2']);
  assert.deepEqual(r.unsettled.map((x) => x.edgeId), ['e3', 'e4', 'e5']);
  assert.equal(r.dropped.unknownResult, 1, '未知 result 不许被塞进任何桶');
  assert.equal(r.counts.byResult.failure, 1);
  assert.equal(r.counts.byResult.unverified, 1);
  // unverified 不是成功
  assert.ok(!r.successes.some((x) => x.result === 'unverified'));
});

test('引文优先级：失败边 errorSnippet > verify.summary(exit/host-error) > action；成功边用动作原文；都 ≤200 字', () => {
  const graph = graphOf({
    e1: edgeOf('e1', 20, { result: 'failure', errorSnippet: 'Error: cannot modify', verify: { kind: 'exit', summary: 'exit 1' } }),
    e2: edgeOf('e2', 21, { result: 'failure', errorSnippet: '', verify: { kind: 'host-error', summary: 'Error: file has not been read' } }),
    e3: edgeOf('e3', 22, { result: 'success', errorSnippet: '', verify: { kind: 'exit', summary: 'exit 0' } }),
    e4: edgeOf('e4', 23, { result: 'failure', errorSnippet: '', verify: { kind: 'no-exit', summary: '730 chars, no exit code' } }),
  });
  const r = extractSignals({ graph });
  assert.equal(r.failures[0].quote, 'Error: cannot modify');
  assert.equal(r.failures[1].quote, 'host-error: Error: file has not been read');
  assert.ok(r.failures[2].quote.startsWith('bash('), 'no-exit 摘要不是失败原文 ⇒ 退到动作原文');
  assert.ok(r.successes[0].quote.startsWith('bash('), '成功边用动作原文，不用 "exit 0" 摘要');
  for (const x of [...r.failures, ...r.successes]) assert.ok(len(x.quote) <= MAX_QUOTE);
});

test('无源不入：没有 evidence.seq 的边不进任何桶，只记 noSource', () => {
  const graph = graphOf({
    e1: { id: 'e1', from: null, to: null, action: 'bash(x)', result: 'failure', errorSnippet: 'boom', evidence: {}, ts: 1 },
    e2: edgeOf('e2', 30, { result: 'failure', errorSnippet: 'boom' }),
  });
  const r = extractSignals({ graph });
  assert.deepEqual(r.failures.map((x) => x.edgeId), ['e2']);
  assert.equal(r.dropped.noSource, 1);
});

test('每条信号都带 seq + quote + 出处；空图/空事件不抛', () => {
  assert.deepEqual(extractSignals({}).counts, { failures: 0, successes: 0, commandSuccesses: 0, unsettled: 0, constraints: 0, tools: 0, byResult: {} });
  assert.equal(extractSignals({ graph: null, events: [] }).constraints.length, 0);
  const r = extractSignals({
    graph: graphOf({ e1: edgeOf('e1', 40, { result: 'failure', errorSnippet: 'boom', from: 'n1', to: 'n2' }) }),
  });
  const f = r.failures[0];
  assert.equal(f.seq, 40);
  assert.equal(f.edgeId, 'e1');
  assert.equal(f.nodeId, 'n1', 'nodeId = 作出动作的起点节点，from/to 都留着');
  assert.equal(f.from, 'n1');
  assert.equal(f.to, 'n2');
  assert.equal(f.result, 'failure');
  assert.equal(f.occurredAt, at(40));
  assert.equal(f.source, 'edge');
});

test('接受 R01 parseEvents 的整体返回（{header, events}）', () => {
  const events = [userMessage(50, '必须只读')];
  const r = extractSignals({ graph: null, events: { header: { type: 'session', version: 4 }, events } });
  assert.equal(r.counts.constraints, 1);
  assert.equal(r.constraints[0].seq, 50);
});

/* ── 引文与文本工具 ─────────────────────────────────────── */

test('clip：按码点截到 ≤200 字（CJK 不按字节切），不够长不动', () => {
  const long = '围'.repeat(250);
  assert.equal(len(clip(long)), MAX_QUOTE);
  assert.ok(clip(long).endsWith('…'));
  assert.equal(clip('短句'), '短句');
  const w = `a${'b'.repeat(199)}`;
  assert.equal(len(clip(w)), 200, '刚好 200 不得截断');
  assert.equal(clip('  a \n\n b  '), 'a b', '只做排版归一');
});

test('messageText：只取 text 片段，reasoning / tool-call 不算原文', () => {
  const data = {
    content: [
      { type: 'reasoning', text: '这是推理' },
      { type: 'text', text: '这是正文' },
      { type: 'tool-call', name: 'bash', arguments: '{}' },
    ],
  };
  assert.equal(messageText(data), '这是正文');
  assert.equal(messageText({ message: data }), '这是正文');
  assert.equal(messageText({ content: '纯字符串' }), '纯字符串');
  assert.equal(messageText(undefined), '');
});

test('extractConstraints：无约束词 → 空；每段最多 40 句', () => {
  assert.deepEqual(extractConstraints('今天天气不错。'), []);
  assert.deepEqual(extractConstraints(''), []);
  const many = Array.from({ length: 50 }, (_, i) => `必须第${i}条；`).join('');
  assert.equal(extractConstraints(many).length, 40);
});

/* ── 真实棋谱 ───────────────────────────────────────────── */

test('固定样本 A（未入库则跳过）：failure 边 ≥1，每条信号都带 seq/quote/边号，且 quote ≤200 字', { skip: !hasSample(SAMPLE_A) ? '固定样本未入库（该 session 不在本机语料；样本需脱敏后固化，见 audit P2-5）' : false }, () => {
  const r = loadGraphAt({ basePath: graphPath(SAMPLE_A) });
  assert.equal(r.graph.version, 1);
  const sig = extractSignals({ graph: r.graph });
  const expectedFailures = Object.values(r.graph.edges).filter((e) => e.result === 'failure').length;
  assert.equal(sig.counts.failures, expectedFailures, '数必须与图上 failure 边逐条对齐');
  assert.ok(sig.counts.failures >= 1, '该样本应含 failure 边');
  assert.ok(sig.counts.successes >= 1);
  assert.equal(sig.dropped.noSource, 0, '真实棋谱的边都带 evidence');
  for (const f of sig.failures) {
    assert.ok(Number.isFinite(f.seq) && f.seq > 0);
    assert.ok(f.quote.length > 0 && len(f.quote) <= MAX_QUOTE);
    assert.ok(f.edgeId, '必须能指回具体那一手');
  }
  // 失败边在时间上是递增的（按 seq 排序）
  const seqs = sig.failures.map((f) => f.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  // 工具集合含 bash（该局大量用 bash）
  assert.ok(sig.tools.some((t) => t.name === 'bash'));
  // 真实约束：棋谱 user 节点里的用户原话
  assert.ok(sig.counts.constraints >= 1, '该局有用户约束原话');
  for (const c of sig.constraints) assert.ok(c.quote.length > 0 && len(c.quote) <= MAX_QUOTE);
});

test('固定样本 C（未入库则跳过）：纯基线棋谱也能抽出 failure / success / 约束 / 工具', { skip: !hasSample(SAMPLE_C) ? '固定样本未入库（该 session 不在本机语料；样本需脱敏后固化，见 audit P2-5）' : false }, () => {
  const r = loadGraphAt({ basePath: graphPath(SAMPLE_C) });
  const sig = extractSignals({ graph: r.graph });
  assert.ok(sig.counts.failures >= 1, `实际 ${sig.counts.failures}`);
  assert.ok(sig.counts.successes >= 1, `实际 ${sig.counts.successes}`);
  assert.ok(sig.counts.constraints >= 1, `实际 ${sig.counts.constraints}`);
  assert.ok(sig.counts.tools >= 1, `实际 ${sig.counts.tools}`);
  assert.equal(sig.dropped.unknownResult, 0);
  const edgeCount = Object.keys(r.graph.edges).length;
  assert.equal(sig.counts.failures + sig.counts.successes + sig.counts.unsettled, edgeCount, '每条边必须恰好落进一个桶');
});

test('固定样本自检（未入库则跳过）：三条桶之和 == 边总数（口径闭合）', { skip: !hasSample(SAMPLE_A) || !hasSample(SAMPLE_C) ? '固定样本未入库（同上）' : false }, () => {
  for (const sid of [SAMPLE_A, SAMPLE_C]) {
    const r = loadGraphAt({ basePath: graphPath(sid) });
    const sig = extractSignals({ graph: r.graph });
    const edges = Object.keys(r.graph.edges).length;
    assert.equal(sig.counts.failures + sig.counts.successes + sig.counts.unsettled + sig.dropped.noSource + sig.dropped.noQuote + sig.dropped.unknownResult, edges);
    // byResult 也必须闭合
    const byResultSum = Object.values(sig.counts.byResult).reduce((a, b) => a + b, 0);
    assert.equal(byResultSum, sig.counts.failures + sig.counts.successes + sig.counts.unsettled);
  }
});

test('S11：tool/result 以 [exit code: 0] 结尾 ⇒ commandSuccesses 可验证成功（带命令原文）', () => {
  const events = [
    { type: 'tool/call', seq: 5, time: 1000, data: { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'node --test' }) } },
    { type: 'tool/result', seq: 6, time: 1001, data: { toolCallId: 'c1', message: { content: [{ type: 'text', text: 'ok\n[exit code: 0]' }] } } },
    { type: 'tool/call', seq: 7, time: 1002, data: { callId: 'c2', name: 'bash', arguments: JSON.stringify({ command: 'false' }) } },
    { type: 'tool/result', seq: 8, time: 1003, data: { toolCallId: 'c2', message: { content: [{ type: 'text', text: 'boom\n[exit code: 1]' }] } } },
  ];
  const r = extractSignals({ events });
  assert.equal(r.counts.commandSuccesses, 1);
  assert.equal(r.commandSuccesses[0].quote, 'node --test');
  assert.equal(r.commandSuccesses[0].verifyKind, 'exit-code');
  assert.equal(r.commandSuccesses[0].source, 'exit-code');
});

/* ── 自证污染：卡文本不得进入抽取（T245 · 第二道闸）──────────────
 * 第一道闸是 `isUserMessage`（按 `data.source.kind`）；这道按**内容**剥 —— 两道互不依赖。
 * 为什么需要第二道：卡也是 `user/message`+`role:"user"`，来源标记一旦被上游改写/透传就失效；
 * 而 `extractConstraints(卡原文)` 实测会咬钩（卡里含"目标/一定要/不要/记住"，命中 CONSTRAINT_HARD_RE）。
 */

const CARD = `${MEMORY_LEDGER_OPEN}\n# markers: [observed]=1 局\n- [antipattern] 必须完成 R02。\n${MEMORY_LEDGER_CLOSE}`;

test('R03: stripMemoryLedger 剥完整卡 / 未闭合卡 / 无卡 / 多卡', () => {
  // 完整卡：标记本身也剥掉，卡外文本原样保留
  assert.equal(stripMemoryLedger(`前文\n${CARD}\n后文`), '前文\n\n后文');
  // 未闭合（写盘撕裂）：从开标记剥到末尾 —— 宁多剥，不让卡尾混进语料
  assert.equal(stripMemoryLedger(`前文${MEMORY_LEDGER_OPEN}必须只读`), '前文');
  // 没有卡：逐字返回
  assert.equal(stripMemoryLedger('必须只读'), '必须只读');
  // 多张卡
  assert.equal(stripMemoryLedger(`${CARD}中间${CARD}尾`), '中间尾');
  // 空值/非字符串
  assert.equal(stripMemoryLedger(null), '');
  assert.equal(stripMemoryLedger(undefined), '');
  assert.equal(stripMemoryLedger(''), '');
});

test('R03: 真用户文本（无卡）⇒ 剥卡前后 extractConstraints 结果完全一致（golden）', () => {
  const text = '第一句是废话。必须走只读模式！不要 push main；这条也别删\n最后一句。';
  const before = extractConstraints(text);
  const after = extractConstraints(stripMemoryLedger(text));
  assert.deepEqual(before, ['必须走只读模式！', '不要 push main；', '这条也别删'], 'golden：原结果');
  assert.deepEqual(after, before, '剥卡是恒等变换（无卡时）');
});

test('R03: 卡事件的 source.kind 被改成 "user" 时，卡里的行也不得进约束（内容闸兜底）', () => {
  // 模拟"来源标记失效"：role=user 且 source.kind=user，但内容里带着卡
  const text = `这三条是硬规则：不要救市；必须只读。\n${CARD}`;
  const r = extractSignals({ graph: null, events: [userMessage(30, text)] });
  assert.deepEqual(
    r.constraints.map((c) => c.quote),
    ['这三条是硬规则：不要救市；', '必须只读。'],
    '只留卡外那两句',
  );
  assert.ok(
    !r.constraints.some((c) => c.quote.includes('R02') || c.quote.includes('markers')),
    '卡里的行一句都不许进',
  );
  assert.equal(r.scanned.userMessages, 1, '事件本身仍算用户消息（只是内容被剥）');
});

// ---------------------------------------------------------------------------
// T251 · 假阳性：**测试通过汇总**不是失败原文
//   事故：`node --test … | grep -E "^ℹ (tests|pass|fail)"` 这类命令，真失败在别处（exit 1 来自后半段），
//   但 errorSnippet 抓到的是那行绿字 ⇒ 建出 `[antipattern] ℹ tests 69 ℹ pass 69 ℹ fail 0`，
//   占卡位、误导模型（"全绿"被当成坑）、拉低主判据。
// ---------------------------------------------------------------------------

test('T251 假阳性：`ℹ tests N ℹ pass N ℹ fail 0` 不是失败信号（记 falsePositive，不建 claim）', () => {
  const graph = graphOf({
    e1: edgeOf('e1', 40, { result: 'failure', errorSnippet: 'ℹ tests 69 ℹ pass 69 ℹ fail 0', verify: { kind: 'exit', summary: 'exit 1' } }),
    e2: edgeOf('e2', 41, { result: 'failure', errorSnippet: 'ℹ tests 69\nℹ pass 69\nℹ fail 0', verify: { kind: 'exit', summary: 'exit 1' } }),
  });
  const r = extractSignals({ graph });
  assert.deepEqual(r.failures, [], '通过汇总（单行/换行）都不许进 failures');
  assert.equal(r.dropped.falsePositive, 2, '两条都要记进 falsePositive');
  assert.equal(isTestPassSummary('ℹ tests 69 ℹ pass 69 ℹ fail 0'), true);
  assert.equal(isTestPassSummary('ℹ tests 699\nℹ pass 694\nℹ fail 0'), true);
  assert.equal(TEST_PASS_SUMMARY_FORMS.length, 4, '形态清单要列全（供审计引用）');
});

test('T251 假阳性：等价形态（# pass / # fail 0 / 0 failing / ok N / N passing）都不是失败信号', () => {
  const graph = graphOf({
    e1: edgeOf('e1', 50, { result: 'failure', errorSnippet: '# pass 12\n# fail 0', verify: { kind: 'exit', summary: 'exit 1' } }),
    e2: edgeOf('e2', 51, { result: 'failure', errorSnippet: '0 failing', verify: { kind: 'exit', summary: 'exit 1' } }),
    e3: edgeOf('e3', 52, { result: 'failure', errorSnippet: 'ok 12', verify: { kind: 'exit', summary: 'exit 1' } }),
    e4: edgeOf('e4', 53, { result: 'failure', errorSnippet: '12 passing', verify: { kind: 'exit', summary: 'exit 1' } }),
  });
  const r = extractSignals({ graph });
  assert.deepEqual(r.failures, []);
  assert.equal(r.dropped.falsePositive, 4);
  for (const t of ['# pass 12\n# fail 0', '0 failing', 'ok 12', '12 passing', '# tests 12']) {
    assert.equal(isTestPassSummary(t), true, t);
  }
});

test('T251 反例：真失败必须仍被判失败（fail 1 / ✖ / not ok / failing tests: / Error）', () => {
  const graph = graphOf({
    e1: edgeOf('e1', 60, { result: 'failure', errorSnippet: 'ℹ tests 69\nℹ pass 68\nℹ fail 1', verify: { kind: 'exit', summary: 'exit 1' } }),
    e2: edgeOf('e2', 61, { result: 'failure', errorSnippet: '✖ should keep working (12ms)', verify: { kind: 'exit', summary: 'exit 1' } }),
    e3: edgeOf('e3', 62, { result: 'failure', errorSnippet: 'not ok 3 - name', verify: { kind: 'exit', summary: 'exit 1' } }),
    e4: edgeOf('e4', 63, { result: 'failure', errorSnippet: 'failing tests:', verify: { kind: 'exit', summary: 'exit 1' } }),
    e5: edgeOf('e5', 64, { result: 'failure', errorSnippet: 'Error: boom', verify: { kind: 'exit', summary: 'exit 1' } }),
  });
  const r = extractSignals({ graph });
  assert.deepEqual(r.failures.map((x) => x.edgeId), ['e1', 'e2', 'e3', 'e4', 'e5'], '真失败一条都不许少');
  assert.equal(r.dropped.falsePositive, 0, '真失败不许记成假阳性');
  for (const t of ['ℹ tests 69\nℹ pass 68\nℹ fail 1', '✖ should keep working', 'not ok 3 - x', 'failing tests:', 'Error: boom', 'FAILED']) {
    assert.equal(isTestPassSummary(t), false, t);
  }
});

test('T251 回归：绿汇总与真失败混在一起 ⇒ 仍判失败（不误伤）', () => {
  const mixed = 'ℹ tests 69\nℹ pass 68\nℹ fail 1\n✖ a test failed\nError: boom';
  assert.equal(isTestPassSummary(mixed), false, '含失败标记就不算通过汇总');
  const graph = graphOf({
    e1: edgeOf('e1', 70, { result: 'failure', errorSnippet: mixed, verify: { kind: 'exit', summary: 'exit 1' } }),
  });
  const r = extractSignals({ graph });
  assert.equal(r.failures.length, 1, '混着真失败的边必须保留');
  assert.equal(r.dropped.falsePositive, 0);
});

// ---------------------------------------------------------------------------
// T274 · occurredAt 必须取**该 support 所指事件自己的 time**（不许借 seq+1 的时间）
//   事故：旧实现 `occurredAt: edge.ts`，而上游写边时 ts 取的是 seq+1（tool/call）那一格，
//   于是 claim 的"出处"与"发生时间"不属于同一个事件（知识库 57 的 L3 不变量）。
// ---------------------------------------------------------------------------

test('T274 occurredAt：assistant/message 无 time、下一条 tool/call 有 time ⇒ 不许取下一条的', () => {
  const graph = graphOf({
    e1: edgeOf('e1', 10, { result: 'failure', errorSnippet: 'Error: boom', ts: 999999 }),
  });
  const events = [
    { seq: 10, type: 'assistant/message', data: {} },          // 自己没有 time
    { seq: 11, type: 'tool/call', time: 999999, data: {} },     // 下一条有 time（旧实现会借它）
  ];
  const r = extractSignals({ graph, events });
  assert.equal(r.failures[0].occurredAt, null, '不许借下一条事件的时间');
  assert.equal(r.failures[0].timeSource, null);
});

test('T274 occurredAt：该事件自己有 time ⇒ 取自己的（不是 edge.ts）', () => {
  const graph = graphOf({
    e1: edgeOf('e1', 10, { result: 'failure', errorSnippet: 'Error: boom', ts: 999999 }),
  });
  const events = [
    { seq: 10, time: 111111, data: {} },
    { seq: 11, time: 999999, data: {} },
  ];
  const r = extractSignals({ graph, events });
  assert.equal(r.failures[0].occurredAt, 111111, '取该 seq 自己的 time');
  assert.equal(r.failures[0].timeSource, 'event');
});

test('T274 occurredAt：兜底向前找时必须标 timeSource="previous-event"', () => {
  const graph = graphOf({
    e1: edgeOf('e1', 10, { result: 'failure', errorSnippet: 'Error: boom', ts: 999999 }),
  });
  const events = [
    { seq: 9, time: 555555, data: {} },
    { seq: 10, type: 'assistant/message', data: {} }, // 没有 time，且 11 不存在
  ];
  const r = extractSignals({ graph, events });
  assert.equal(r.failures[0].occurredAt, 555555, '向前找 seq-1');
  assert.equal(r.failures[0].timeSource, 'previous-event', '兜底必须显式标注，不许静默借');
});

test('T274 occurredAt：前后都没有 time ⇒ null（缺时间 = 假记忆，不许编）', () => {
  const graph = graphOf({
    e1: edgeOf('e1', 10, { result: 'failure', errorSnippet: 'Error: boom', ts: 777 }),
  });
  const r = extractSignals({ graph, events: [{ seq: 10, data: {} }] });
  assert.equal(r.failures[0].occurredAt, null);
  assert.equal(r.failures[0].timeSource, null);
});

// ---------------------------------------------------------------------------
// T30 · 归档层恢复事实（`collectRecoveryFacts`）：把「同一主体后来成功」批量产出，
// 供 `scripts/archive.mjs` 落 sidecar 索引。判据与 T28 读时派生同一套（`findRecoveryFact`）。
// ---------------------------------------------------------------------------
const t30Events = () => {
  const ev = (seq, type, data) => ({ type, seq, time: 1_790_000_000_000 + seq * 1000, data });
  // 多段文本在 `recoveryEventText` 里按行拼接 —— 不用源码里的转义换行
  const msg = (a, b) => ({ content: [{ type: 'text', text: a }, ...(b ? [{ type: 'text', text: b }] : [])] });
  return [
    ev(1, 'tool/call', { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'node a.mjs' }) }),
    ev(2, 'tool/result', { toolCallId: 'c1', message: msg('Error: boom', '[exit code: 1]') }),
    ev(3, 'tool/call', { callId: 'c2', name: 'bash', arguments: JSON.stringify({ command: 'node a.mjs' }) }),
    ev(4, 'tool/result', { toolCallId: 'c2', message: msg('ok', '[exit code: 0]') }),
    ev(5, 'tool/result', { toolCallId: 'nope', message: msg('Error: never fixed') }),
  ];
};

test('T30 ①: collectRecoveryFacts 为有恢复的失败产出事实（episode/failureSeq/kind/seq/at/prefix）', () => {
  const facts = collectRecoveryFacts({ events: t30Events(), episode: 'ep-demo' });
  assert.equal(facts.length, 1, '只有 seq 2 的那条失败有恢复');
  const f = facts[0];
  assert.equal(f.episode, 'ep-demo');
  assert.equal(f.failureSeq, 2);
  assert.equal(f.kind, 'same-command-exit-0');
  assert.equal(f.seq, 4);
  assert.ok(Number.isFinite(f.at), '必须带时间（无时不入）');
  assert.ok(f.prefix.startsWith('Error: boom'), 'prefix 是失败原文，读时用它对齐卡上引文');
});

test('T30 ②: 没有恢复 ⇒ 空数组（不编）', () => {
  const facts = collectRecoveryFacts({ events: [
    { type: 'tool/result', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'Error: alone' }] } },
  ] });
  assert.deepEqual(facts, []);
});

test('T30 ③: 纯函数（同输入两次 deepEqual；缺 episode 也能算）', () => {
  const a = collectRecoveryFacts({ events: t30Events(), episode: 'ep-demo' });
  const b = collectRecoveryFacts({ events: t30Events(), episode: 'ep-demo' });
  assert.deepEqual(a, b);
  const c = collectRecoveryFacts({ events: t30Events() });
  assert.equal(c[0].episode, null, '不给 episode 就不编');
});

// ---------------------------------------------------------------------------
// T34 · 恢复事实分档（exact / same-file / same-tool）
// ---------------------------------------------------------------------------
const t34Events = (pairs) => pairs.map(([seq, kind, name, text]) => (
  kind === 'call'
    ? { type: 'tool/call', seq, time: 1_790_000_000_000 + seq * 1000, data: { callId: `c${seq}`, name, arguments: JSON.stringify(text) } }
    : { type: 'tool/result', seq, time: 1_790_000_000_000 + seq * 1000, data: { toolCallId: `c${seq - 1}`, message: { content: [{ type: 'text', text }] } } }
));

test('T34 ①: 工具族归一（命令族 / 目录）+ 档位映射', () => {
  assert.equal(recoveryCommandFamily('git push origin main'), 'git push');
  assert.equal(recoveryCommandFamily('git push --force'), 'git push');
  assert.equal(recoveryCommandFamily('FOO=1 git push origin main'), 'git push', '跳过前置环境变量');
  assert.equal(recoveryCommandFamily('node scripts/check.mjs --x'), 'node scripts/check.mjs');
  assert.equal(recoveryCommandFamily('ls -la'), 'ls');
  assert.equal(recoveryDirOf('D:/a/b/c.mjs'), 'd:/a/b');
  assert.equal(recoveryDirOf('/tmp/x.mjs'), '/tmp');
  assert.equal(recoveryTierOf('same-command-exit-0'), 'exact');
  assert.equal(recoveryTierOf('same-file-write-ok'), 'same-file');
  assert.equal(recoveryTierOf('same-tool'), 'same-tool');
  assert.equal(recoveryTierOf('nope'), null);
});

test('T34 ②: 同工具族后来 exit 0 ⇒ same-tool；关掉（includeSameTool:false）⇒ 与旧行为一致（null）', () => {
  const index = buildRecoveryIndex(t34Events([
    [1, 'call', 'bash', { command: 'git push origin main' }],
    [2, 'result', null, 'error: failed to push some refs\n[exit code: 1]'],
    [3, 'call', 'bash', { command: 'git push --force' }],
    [4, 'result', null, 'ok\n[exit code: 0]'],
  ]));
  const on = findRecoveryFact(index, 'error: failed to push some refs');
  assert.equal(on?.kind, 'same-tool', '不同命令、同工具族 ⇒ same-tool');
  assert.equal(on?.seq, 4);
  assert.equal(on?.subject, 'git push');
  assert.equal(findRecoveryFact(index, 'error: failed to push some refs', { includeSameTool: false }), null, '关掉 ⇒ 旧行为（tombstone）');
});

test('T34 ③: 同一命令仍走 exact（不许被 same-tool 抢）；不同工具族不算', () => {
  const exact = buildRecoveryIndex(t34Events([
    [1, 'call', 'bash', { command: 'git push origin main' }],
    [2, 'result', null, 'error: failed to push some refs\n[exit code: 1]'],
    [3, 'call', 'bash', { command: 'git push origin main' }],
    [4, 'result', null, 'ok\n[exit code: 0]'],
  ]));
  assert.equal(findRecoveryFact(exact, 'error: failed to push some refs')?.kind, 'same-command-exit-0');

  const other = buildRecoveryIndex(t34Events([
    [1, 'call', 'bash', { command: 'git push origin main' }],
    [2, 'result', null, 'error: failed to push some refs\n[exit code: 1]'],
    [3, 'call', 'bash', { command: 'npm publish' }],
    [4, 'result', null, 'ok\n[exit code: 0]'],
  ]));
  assert.equal(findRecoveryFact(other, 'error: failed to push some refs'), null, '不同工具族不算恢复');

  // 文件：同目录另一个文件写成功 ⇒ same-tool；不同目录 ⇒ 不算
  const file = buildRecoveryIndex(t34Events([
    [1, 'call', 'edit', { file_path: 'D:/repo/a/x.mjs' }],
    [2, 'result', null, 'Error: cannot edit "D:/repo/a/x.mjs": binary file'],
    [3, 'call', 'edit', { file_path: 'D:/repo/a/y.mjs' }],
    [4, 'result', null, 'The file D:/repo/a/y.mjs has been updated successfully.'],
  ]));
  assert.equal(findRecoveryFact(file, 'Error: cannot edit "D:/repo/a/x.mjs": binary file')?.kind, 'same-tool');
  const elsewhere = buildRecoveryIndex(t34Events([
    [1, 'call', 'edit', { file_path: 'D:/repo/a/x.mjs' }],
    [2, 'result', null, 'Error: cannot edit "D:/repo/a/x.mjs": binary file'],
    [3, 'call', 'edit', { file_path: 'D:/repo/b/y.mjs' }],
    [4, 'result', null, 'The file D:/repo/b/y.mjs has been updated successfully.'],
  ]));
  assert.equal(findRecoveryFact(elsewhere, 'Error: cannot edit "D:/repo/a/x.mjs": binary file'), null, '不同目录不算');
});

// R12 inject 的 tombstone test：删掉 src/rooms/inject.mjs ⇒ 本文件整片红。
//
// 覆盖（契约 docs/数据契约.md §7.3、方案 §7.2/§7.3、边界 §2/§4/§5）：
//   - 无命中 ⇒ 只有 indexLine 一行（section=null、claims=[]、省略不出现）= 零注入
//   - 命中 ⇒ ≤5 条、≤500 tokens、每行都有绝对日期 + provenance（episode + seq）
//   - 排序：失败教训（antipattern）在前 → 约束/偏好 → 事实 → 定式候选（pattern）最后
//   - 无源不入：缺 occurredAt / 缺 seq 的 claim 不进卡，只进 omitted
//   - 超预算先降条数、省略显式（计数 + 去 index.md 取），不丢日期与出处
//   - shadow：只追加到指定目录（测试用临时目录）；默认目录不在 $DSH_HOME 内；写 $DSH_HOME 直接拒
//   - 只陈述事实：卡片里不出现任何一种指令式片段（R13 边界闸同一份正则）
//   - 纯函数：同输入同输出；卡片文本不含时钟（now 只进 shadow 记录）

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  BUDGET_TOKENS,
  ENTRY_LIMIT,
  IMPERATIVE_PATTERNS,
  INDEX_LINE_RE,
  PROVENANCE_LINE_RE,
  TIGHT_CLIP,
  assertSafeShadowDir,
  auditImperatives,
  buildMemoryCard,
  clipLine,
  defaultShadowDir,
  degradedWalk,
  estimateTokens,
  filterHitsByScope,
  formatCardDate,
  isScopeVisible,
  normalizeScopeKey,
  readShadow,
  runInject,
  scopeKeyFromPath,
  signalFromText,
  singleLine,
  writeShadow,
  InjectError,
} from '../src/rooms/inject.mjs';
import { createStore } from '../src/rooms/persist.mjs';
import { runGates } from '../src/rooms/gates.mjs';

// ---------------------------------------------------------------------------
// 夹具：临时目录里的最小记忆库（episodes + claims）
// ---------------------------------------------------------------------------

const T = (day) => Date.UTC(2026, 9, day, 12, 0, 0); // 2026-10-DD
const SCOPE = 'w:d:/work/demo';

const episode = (id, day, failures = 0) => ({
  id,
  sessionId: `session-${id.slice(3)}`,
  scopeKey: SCOPE,
  startedAt: T(day),
  endedAt: T(day) + 3_600_000,
  firstEventAt: T(day),
  lastEventAt: T(day) + 3_600_000,
  recordedAt: null,
  closure: { logPath: 'sessions/demo/x/session.v4.jsonl.zstd', graphPath: 'graphs/x/graph.json', seqFrom: 11, seqTo: 99 },
  l0: '',
  signals: { failures, successes: 0, unsettled: 0, constraints: 0, tools: [] },
  threadIds: [],
  state: 'archived',
});

const claim = ({ id, kind, text, day, state = 'candidate', support, level = null }) => ({
  id,
  kind,
  text,
  ...(level ? { level } : {}),
  scopeKey: SCOPE,
  threadIds: [],
  state,
  support: support.map((s) => ({ episode: s.episode, seq: s.seq, quote: s.quote ?? text, occurredAt: T(s.day ?? day) })),
  counter: [],
  validity: { type: 'none', value: null },
  preconditions: [],
  occurredAt: T(day),
  recordedAt: T(day),
  validFrom: null,
  validTo: null,
  counters: { support: support.length, counter: 0, injections: 0, lastInjectedAt: null },
  supersedes: null,
});

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-inject-'));
  const store = createStore({ root, now: T(20) });
  store.ensureDirs();
  store.putMany('episodes', [
    episode('ep-aaaaaaa1', 21, 3),
    episode('ep-aaaaaaa2', 22, 1),
    episode('ep-aaaaaaa3', 23, 0),
  ]);
  store.putMany('claims', [
    claim({ id: 'c-0000aa01', kind: 'pattern', text: '测试入口是 node test/run.mjs 而不是 npm test', day: 21, state: 'candidate', support: [{ episode: 'ep-aaaaaaa1', seq: 41 }] }),
    claim({ id: 'c-0000aa02', kind: 'antipattern', text: "Cannot find module 'yaml'（pnpm add yaml 之后仍在）", day: 22, state: 'observed', support: [{ episode: 'ep-aaaaaaa2', seq: 12 }, { episode: 'ep-aaaaaaa1', seq: 30 }] }),
    claim({ id: 'c-0000aa03', kind: 'preference', text: '不要新增依赖', level: 'hard', day: 23, state: 'candidate', support: [{ episode: 'ep-aaaaaaa3', seq: 5 }] }),
    claim({ id: 'c-0000aa06', kind: 'preference', text: '理由：不写这句话就会为了省 token 省轮次，质量会下降', level: 'soft', day: 23, state: 'observed', support: [{ episode: 'ep-aaaaaaa3', seq: 6 }] }),
    claim({ id: 'c-0000aa04', kind: 'fact', text: 'package.json 的 engines.node 是 >=23.8', day: 23, state: 'observed', support: [{ episode: 'ep-aaaaaaa3', seq: 7 }] }),
    // 无源：没有 occurredAt、support 也只有 episode 没有 seq ⇒ 不许进卡
    {
      id: 'c-0000aa05',
      kind: 'antipattern',
      text: '无源命题（不该被注入）',
      scopeKey: SCOPE,
      state: 'candidate',
      support: [{ episode: 'ep-aaaaaaa2', quote: '无 seq 的证据' }],
      counter: [],
      occurredAt: null,
      counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null },
      supersedes: null,
    },
  ]);
  return { root, store };
}

const hit = ({ episodeId, seq, why = ['yaml'], kind = 'failure', day = 22, claimId = null, claim = null }) => ({
  episode: episodeId,
  nodeId: null,
  link: null,
  why,
  weight: 1,
  occurredAt: Number.isFinite(day) ? T(day) : null,
  kind,
  seq,
  depth: 1,
  ...(claimId ? { claimId } : {}),
  ...(claim ? { claim } : {}),
});

const walkOf = (hits, extra = {}) => ({ hits, path: [], omitted: { count: 0, reason: '' }, tokens: 0, depth: 1, ...extra });

const cardLines = (card) => String(card.section ?? '').split('\n').filter((l) => l.startsWith('- '));

let fixtureCache = null;
function fixture() {
  if (!fixtureCache) fixtureCache = makeFixture();
  return fixtureCache;
}

test.after(() => {
  if (fixtureCache?.root) {
    try { rmSync(fixtureCache.root, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
});

// ---------------------------------------------------------------------------
// 无命中 = 零注入
// ---------------------------------------------------------------------------

test('R12: 无命中 ⇒ 只有 indexLine 一行，section=null（零注入）', () => {
  const { store } = fixture();
  const signal = signalFromText('随便聊点跟历史无关的事');
  const card = buildMemoryCard({
    signal,
    walkResult: walkOf([]),
    store,
    scope: SCOPE,
    now: T(24),
  });

  assert.equal(card.shadow, true, 'M3 只有影子模式');
  assert.equal(card.section, null, '不命中 ⇒ 不展开');
  assert.deepEqual(card.claims, []);
  assert.equal(card.omissions, null, '没有东西被省，写省略反而是噪音');
  assert.match(card.indexLine, INDEX_LINE_RE);
  assert.equal(card.section, null);
  const lineCount = card.indexLine.split('\n').length;
  assert.equal(lineCount, 1, '首轮只许一行');
  assert.ok(card.tokens <= 60, `首轮一行 ≤60 tokens（实际 ${card.tokens}）`);
  assert.ok(!card.indexLine.includes('<memory-ledger>'));
});

test('R12: indexLine 是事实陈述（scope/局数/未列出≠不存在），不是指令', () => {
  const { store } = fixture();
  const card = buildMemoryCard({ walkResult: walkOf([]), store, scope: SCOPE, episodeCount: 3 });
  assert.ok(card.indexLine.startsWith('MEMORY: '));
  assert.ok(card.indexLine.includes('scope=w:d:/work/demo'));
  assert.ok(card.indexLine.includes('3 局'));
  assert.ok(card.indexLine.includes('未列出≠不存在'));
  for (const pattern of IMPERATIVE_PATTERNS) {
    assert.ok(!card.indexLine.includes(pattern), `indexLine 不得含指令式片段「${pattern}」`);
  }
});

// ---------------------------------------------------------------------------
// 命中 = 展开，但 ≤5 条 / ≤500 tokens / 每行带日期 + provenance
// ---------------------------------------------------------------------------

test('R12: 命中 ⇒ ≤5 条、≤500 tokens、每行带绝对日期与 (episode, seq)', () => {
  const { store } = fixture();
  const hits = [
    hit({ episodeId: 'ep-aaaaaaa2', seq: 12, claimId: 'c-0000aa02' }),
    hit({ episodeId: 'ep-aaaaaaa3', seq: 5, kind: 'constraint', why: ['依赖'], claimId: 'c-0000aa03' }),
    hit({ episodeId: 'ep-aaaaaaa1', seq: 41, kind: 'claim', why: ['测试'], claimId: 'c-0000aa01' }),
    hit({ episodeId: 'ep-aaaaaaa3', seq: 7, kind: 'claim', why: ['package.json'], claimId: 'c-0000aa04' }),
  ];
  const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });

  assert.ok(card.section !== null, '命中了就该展开');
  assert.ok(card.section.startsWith('<memory-ledger>'));
  assert.ok(card.section.endsWith('</memory-ledger>'));
  assert.ok(card.claims.length <= ENTRY_LIMIT, `≤${ENTRY_LIMIT} 条（实际 ${card.claims.length}）`);
  assert.ok(card.tokens <= BUDGET_TOKENS, `≤${BUDGET_TOKENS} tokens（实际 ${card.tokens}）`);
  assert.equal(card.tokens, estimateTokens(card.indexLine) + estimateTokens(card.section), 'tokens 口径 = indexLine + section');

  const lines = cardLines(card);
  assert.equal(lines.length, card.claims.length, '渲染行数 = claims 数（闸 0 会核）');
  for (const line of lines) {
    const m = PROVENANCE_LINE_RE.exec(line);
    assert.ok(m, `每行都得能被 provenance 正则解析：${line}`);
    assert.match(m[4], /^\d{4}-\d{2}-\d{2}$/, '日期是绝对日期');
    assert.ok(!m[4].includes('?'), '不是占位日期');
    assert.match(m[3], /^ep-[a-z0-9]+$/i, 'episode 出处');
    assert.ok(Number(m[5]) >= 0, 'seq 出处');
  }
  for (const c of card.claims) {
    assert.ok(Number.isFinite(c.occurredAt), 'occurredAt 是一等字段');
    assert.equal(c.date, formatCardDate(c.occurredAt));
    assert.equal(c.date, c.line.match(/\(([^,]+), (\d{4}-\d{2}-\d{2}), seq (\d+)\)$/)[2], '行里的日期 = occurredAt 的 UTC 日期');
    assert.ok(c.source.episode && Number.isFinite(c.source.seq));
  }
});

test('R12: 排序 = 失败教训 → 约束/偏好 → 事实 → 定式候选', () => {
  const { store } = fixture();
  const hits = [
    hit({ episodeId: 'ep-aaaaaaa1', seq: 41, kind: 'claim', why: ['测试'], claimId: 'c-0000aa01' }), // pattern
    hit({ episodeId: 'ep-aaaaaaa3', seq: 7, kind: 'claim', why: ['package.json'], claimId: 'c-0000aa04' }), // fact
    hit({ episodeId: 'ep-aaaaaaa3', seq: 5, kind: 'constraint', why: ['依赖'], claimId: 'c-0000aa03' }), // preference
    hit({ episodeId: 'ep-aaaaaaa2', seq: 12, claimId: 'c-0000aa02' }), // antipattern
  ];
  const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE });
  const kinds = card.claims.map((c) => c.marker);
  assert.equal(kinds[0], 'antipattern', `失败教训排最前，实际：${kinds.join(',')}`);
  assert.equal(kinds[kinds.length - 1], 'candidate', `定式候选排最后，实际：${kinds.join(',')}`);
  const lines = cardLines(card);
  assert.ok(lines[0].startsWith('- [antipattern]'), '行序同样是失败在前');
  assert.ok(lines[lines.length - 1].includes('npm test'), '行序最后是定式候选（pattern）');
  assert.deepEqual(
    card.claims.map((c) => c.claimId),
    ['c-0000aa02', 'c-0000aa03', 'c-0000aa04', 'c-0000aa01'],
    'antipattern → preference → fact → pattern',
  );
  for (const c of card.claims) {
    assert.ok(['antipattern', 'candidate', 'observed'].includes(c.state), `标记合法：${c.state}`);
  }
});

test('R12: 无源不入 —— 缺 occurredAt/seq 的 claim 不进卡，只进 omitted', () => {
  const { store } = fixture();
  // 命中一局，但该局在 store 里只有那条「无源」claim（c-0000aa05 没有 occurredAt、support 无 seq）
  const hits = [hit({ episodeId: 'ep-aaaaaaa2', seq: null, day: null })];
  const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE });

  // 回退到指针行（episode 记录里 closure.seqFrom 与 startedAt 都在）⇒ 仍然有出处
  if (card.claims.length) {
    for (const c of card.claims) {
      assert.ok(Number.isFinite(c.occurredAt) && Number.isFinite(c.source.seq), '进卡的每一条都必须有源');
    }
  }
  assert.ok(!String(card.section ?? '').includes('无源命题'), '无源 claim 的文本绝不能出现在注入里');
});

test('R12: 超条数上限 ⇒ 显式省略（计数 + 去 index.md），不丢日期与出处', () => {
  const { store } = fixture();
  const hits = [];
  for (let i = 0; i < 9; i += 1) {
    hits.push(hit({ episodeId: `ep-bbbbbbb${i}`, seq: 100 + i, why: ['yaml'], day: 22, claim: {
      id: `c-x${i}`,
      kind: 'antipattern',
      state: 'observed',
      text: `第 ${i} 条失败教训：yaml 模块安装后仍报 Cannot find module`,
      occurredAt: T(22),
      support: [{ episode: `ep-bbbbbbb${i}`, seq: 100 + i }],
    } }));
  }
  const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE });
  assert.equal(card.claims.length, ENTRY_LIMIT, '截到上限');
  assert.equal(card.omittedCount, 4, '其余计入省略');
  assert.match(card.omissions, /^omitted: 4 items/);
  assert.match(card.omissions, /index\.md/);
  assert.ok(card.section.includes('omitted: 4 items'), '省略行进 section（模型可见）');
  for (const c of card.claims) assert.ok(Number.isFinite(c.occurredAt) && c.source.seq >= 0);
});

test('R12: 超 token 预算 ⇒ 先降表示（160→60），再降条数；日期与出处一字不丢', () => {
  const { store } = fixture();
  const longText = '很长的失败教训'.repeat(40); // 每条 = 280 字
  const hits = [];
  for (let i = 0; i < 5; i += 1) {
    hits.push(hit({ episodeId: `ep-ccccccc${i}`, seq: 200 + i, claim: {
      id: `c-l${i}`,
      kind: 'antipattern',
      state: 'observed',
      text: longText,
      occurredAt: T(22),
      support: [{ episode: `ep-ccccccc${i}`, seq: 200 + i }],
    } }));
  }

  // 阶梯 1/2：默认 500 预算下 5 条全留，但文本被缩到第二级（60 字）
  const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE });
  assert.ok(card.tokens <= BUDGET_TOKENS, `预算内（实际 ${card.tokens}）`);
  assert.equal(card.claims.length, 5, '降表示够用 ⇒ 不丢条数');
  assert.equal(card.clip, TIGHT_CLIP, '走到第二级缩表示');
  for (const c of card.claims) {
    assert.ok(c.text.length <= TIGHT_CLIP, '文本缩到 60 字');
    assert.ok(Number.isFinite(c.occurredAt));
    assert.ok(c.source.episode.startsWith('ep-') && Number.isFinite(c.source.seq));
  }
  // 降表示不降出处：日期与 provenance 完整
  assert.match(card.claims[0].line, /\(ep-ccccccc0, 2026-10-22, seq 200\)$/);

  // 阶梯 3/4：预算收紧到 200 ⇒ 只能留少数条，省略显式（计数 + 去 index.md）
  const tight = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, budgetTokens: 200 });
  assert.ok(tight.tokens <= 200, `收紧预算内（实际 ${tight.tokens}）`);
  assert.ok(tight.claims.length >= 1 && tight.claims.length < 5, `只留最靠前的几条（实际 ${tight.claims.length}）`);
  assert.ok(tight.omittedCount > 0 && tight.omissions.includes('index.md'));
  for (const c of tight.claims) {
    assert.ok(Number.isFinite(c.occurredAt) && c.source.episode.startsWith('ep-') && Number.isFinite(c.source.seq));
  }
});

test('R12: 预算小到连空壳都放不下 ⇒ 零展开，但省略必须如实记数（不许静默丢）', () => {
  const { store } = fixture();
  const hits = [hit({ episodeId: 'ep-aaaaaaa2', seq: 12, claimId: 'c-0000aa02' })];
  const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, budgetTokens: 40 });
  assert.equal(card.section, null, '放不下就沉默');
  assert.deepEqual(card.claims, []);
  assert.equal(card.omittedCount, 1, '被丢的条目仍然计数（省略可发现）');
  assert.match(card.omissions, /^omitted: 1 items/);
  assert.equal(card.tokens, estimateTokens(card.indexLine), '只花首轮那一行');
});

test('R12: 卡片只陈述事实 —— 不出现任何指令式片段', () => {
  const { store } = fixture();
  const hits = [
    hit({ episodeId: 'ep-aaaaaaa2', seq: 12, claimId: 'c-0000aa02' }),
    hit({ episodeId: 'ep-aaaaaaa3', seq: 5, kind: 'constraint', why: ['依赖'], claimId: 'c-0000aa03' }),
  ];
  const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE });
  const rendered = `${card.indexLine}\n${card.section ?? ''}`;
  for (const pattern of IMPERATIVE_PATTERNS) {
    assert.ok(!rendered.includes(pattern), `注入文本不得含「${pattern}」`);
  }
  assert.ok(!/下一步|TODO|待办/.test(rendered), '不许出现下一步/TODO 形态');
});

test('R12: 命中却一条都渲染不出来 ⇒ 仍然零展开（不产空壳 section）', () => {
  const { store } = fixture();
  const hits = [{ episode: 'ep-zzzzzzz9', why: ['yaml'] }]; // 不存在的局、无 seq/occurredAt
  const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE });
  assert.equal(card.section, null);
  assert.deepEqual(card.claims, []);
  assert.equal(card.hitCount, 1, '命中数如实记（影子模式要能统计"命中但没东西可给"）');
});

test('R12: 纯函数 —— 同输入同输出，卡片文本不含时钟', () => {
  const { store } = fixture();
  const hits = [hit({ episodeId: 'ep-aaaaaaa2', seq: 12, claimId: 'c-0000aa02' })];
  const a = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
  const b = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, now: T(25) });
  assert.equal(a.section, b.section, 'now 不进渲染');
  assert.equal(a.indexLine, b.indexLine);
  assert.equal(a.tokens, b.tokens);
  assert.equal(a.signalAt, T(24));
  assert.equal(b.signalAt, T(25));
});

test('R12: 兼容 R11 walk 的 hit 形态（claim = claims/<id> 字符串 + claimKind/claimState/text）', () => {
  const { store } = fixture();
  const hit0 = {
    episode: 'ep-aaaaaaa2',
    nodeId: null,
    claim: 'c-0000aa02',
    claimKind: 'antipattern',
    claimState: 'observed',
    link: null,
    why: ['yaml'],
    weight: 1,
    occurredAt: T(22),
    seq: 12,
    kind: 'failure',
    depth: 1,
    text: 'walk 带回的摘要文本（不该盖过 store 原文）',
  };
  const card = buildMemoryCard({ walkResult: walkOf([hit0]), store, scope: SCOPE });
  assert.equal(card.claims.length, 1);
  assert.equal(card.claims[0].claimId, 'c-0000aa02', '按 claim id 回 store 取原文');
  assert.ok(card.claims[0].text.includes('Cannot find module'), '逐字原文优先于 walk 摘要');
  assert.notEqual(card.claims[0].text, hit0.text);
  assert.equal(card.claims[0].marker, 'antipattern');
  assert.equal(card.claims[0].state, 'observed', 'state 保留语义状态，marker 才是渲染标记');
  assert.equal(card.claims[0].source.seq, 12);

  // store 里查不到这条 claim（被裁掉/未入馆）⇒ 退回 walk 带的字段，出处仍用 hit 的 (episode, seq)
  const card2 = buildMemoryCard({ walkResult: walkOf([{ ...hit0, claim: 'c-gone' }]), store, scope: SCOPE });
  assert.equal(card2.claims.length, 1);
  assert.equal(card2.claims[0].text, 'walk 带回的摘要文本（不该盖过 store 原文）');
  assert.equal(card2.claims[0].source.episode, 'ep-aaaaaaa2');
  assert.equal(card2.claims[0].source.seq, 12);
});

test('R12: 与 R11 walk 组合（walk.mjs 在就真跑一遍，不在就跳过）', async (t) => {
  let walkFromSignals = null;
  try {
    const mod = await import('../src/rooms/walk.mjs');
    walkFromSignals = typeof mod.walkFromSignals === 'function' ? mod.walkFromSignals : null;
  } catch {
    walkFromSignals = null;
  }
  if (!walkFromSignals) {
    t.skip('R11 walk 未落地（本房间不依赖它）');
    return;
  }

  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-inject-walk-'));
  try {
    const store = createStore({ root, now: T(20) });
    store.ensureDirs();
    store.putMany('episodes', [episode('ep-aaaaaaa1', 21, 3), episode('ep-aaaaaaa2', 22, 1)]);
    store.replaceDerived('topics', [
      { id: 't:term:aaaa0001', kind: 'term', key: 'yaml', df: 2, idfNorm: 0.7, firstSeenAt: T(21), lastSeenAt: T(22), episodes: ['ep-aaaaaaa1', 'ep-aaaaaaa2'] },
    ], { at: T(24) });
    store.putMany('claims', [
      claim({ id: 'c-0000aa02', kind: 'antipattern', text: "Cannot find module 'yaml'", day: 22, state: 'observed', support: [{ episode: 'ep-aaaaaaa2', seq: 12 }] }),
    ]);

    const signal = signalFromText('yaml 装不上', { at: T(24) });
    const walk = walkFromSignals({ signal, store, depth: 2, limit: 5, budgetTokens: 500 });
    assert.ok(Array.isArray(walk.hits), 'walk 产出 hits');
    const card = buildMemoryCard({ signal, walkResult: walk, store, scope: SCOPE, now: T(24) });
    assert.equal(card.shadow, true);
    assert.ok(card.tokens <= BUDGET_TOKENS);
    for (const c of card.claims) {
      assert.ok(Number.isFinite(c.occurredAt));
      assert.ok(c.source.episode.startsWith('ep-') && Number.isFinite(c.source.seq));
      assert.ok(c.line.includes(formatCardDate(c.occurredAt)));
    }
    if (walk.hits.length === 0) assert.equal(card.section, null, 'walk 无命中 ⇒ 零注入');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R12: 没有 store 也能出卡（只降级成指针，不抛）', () => {
  const card = buildMemoryCard({
    walkResult: walkOf([hit({ episodeId: 'ep-aaaaaaa2', seq: 12, day: 22 })]),
    store: null,
    scope: SCOPE,
    indexPath: '/tmp/mem/index.md',
  });
  assert.equal(card.indexLine, 'MEMORY: /tmp/mem/index.md（scope=w:d:/work/demo, 0 局, 未列出≠不存在）');
  assert.ok(card.section === null || card.claims.every((c) => Number.isFinite(c.occurredAt)));
});

// ---------------------------------------------------------------------------
// shadow：只记录，不注入；只写指定目录
// ---------------------------------------------------------------------------

test('R12: writeShadow 只追加到指定目录，JSONL 一行一条（含 card/signal/at，injected:false）', () => {
  const { store } = fixture();
  const dir = mkdtempSync(path.join(tmpdir(), 'kifuin-shadow-'));
  try {
    const signal = signalFromText('yaml 报错', { at: T(24) });
    const card = buildMemoryCard({ walkResult: walkOf([hit({ episodeId: 'ep-aaaaaaa2', seq: 12, claimId: 'c-0000aa02' })]), store, scope: SCOPE, now: T(24) });

    const w1 = writeShadow({ dir, card, signal, at: T(24), dshHome: '/nonexistent-dsh-home' });
    assert.equal(w1.ok, true);
    assert.equal(w1.path, path.join(dir, 'shadow.jsonl'));
    assert.equal(w1.appended, 1);

    const w2 = writeShadow({ dir, card, signal: { ...signal, at: T(25) }, at: T(25), dshHome: '/nonexistent-dsh-home' });
    assert.equal(w2.appended, 1);

    const raw = readFileSync(path.join(dir, 'shadow.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    assert.equal(lines.length, 2, '追加写：两次 = 两行');
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.mode, 'shadow');
    assert.equal(rec.injected, false, '影子模式：记录里明写没注入');
    assert.equal(rec.at, T(24));
    assert.equal(rec.signal.at, T(24));
    assert.equal(rec.card.shadow, true);
    assert.equal(rec.card.section, card.section);
    assert.equal(rec.version, 1);

    const back = readShadow({ dir });
    assert.equal(back.parsed, 2);
    assert.equal(back.missing, false);
    // 只写这一行 JSONL，不多写任何文件
    assert.deepEqual(readdirSync(dir).sort(), ['shadow.jsonl']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R12: shadow 默认目录在仓库 evidence/shadow/ 且不在 $DSH_HOME 内', () => {
  const def = path.resolve(defaultShadowDir());
  assert.ok(def.endsWith(path.join('evidence', 'shadow')), `默认目录：${def}`);
  const home = process.env.DSH_HOME;
  if (home) {
    const rel = path.relative(path.resolve(home), def);
    assert.ok(rel.startsWith('..') || path.isAbsolute(rel), '默认 shadow 目录不得在 $DSH_HOME 内');
  }
});

test('R12: 写 $DSH_HOME 的 shadow 直接被拒（硬守卫）', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'kifuin-fakehome-'));
  try {
    assert.throws(
      () => assertSafeShadowDir(path.join(home, 'evidence', 'shadow'), { dshHome: home }),
      (err) => err instanceof InjectError && err.code === 'inject/shadow-in-dsh-home',
    );
    assert.throws(
      () => assertSafeShadowDir(home, { dshHome: home }),
      (err) => err.code === 'inject/shadow-in-dsh-home',
    );

    const { store } = fixture();
    const card = buildMemoryCard({ walkResult: walkOf([]), store, scope: SCOPE });
    assert.throws(
      () => writeShadow({ dir: path.join(home, 'shadow'), card, at: T(24), dshHome: home }),
      (err) => err.code === 'inject/shadow-in-dsh-home',
    );
    assert.equal(existsSync(path.join(home, 'shadow', 'shadow.jsonl')), false, '拒绝时一个字节都不许写');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('R12: writeShadow 拒收非 shadow 卡（防止把真注入当影子记录）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kifuin-shadow-'));
  try {
    assert.throws(() => writeShadow({ dir, card: { section: null, shadow: false } }), (err) => err.code === 'inject/not-shadow');
    assert.throws(() => writeShadow({ dir, card: null }), (err) => err.code === 'inject/missing-card');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R12: readShadow 遇到崩溃截断的尾行不抛（前缀可用）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kifuin-shadow-'));
  try {
    writeFileSync(path.join(dir, 'shadow.jsonl'), '{"version":1,"mode":"shadow"}\n{"version":1,"mode":"shad', 'utf8');
    const res = readShadow({ dir });
    assert.equal(res.parsed, 1);
    assert.equal(res.badLines, 1);
    assert.equal(res.records.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 信号与降级 walk
// ---------------------------------------------------------------------------

test('R12: signalFromText 机械抽词（ASCII 词 / CJK 2-gram / 路径 / 域名 / 错误码）', () => {
  const signal = signalFromText('yaml 报错 Cannot find module，路径 D:/work/demo/cfg.json，见 github.com，错误 ENOENT_MODULE', { at: T(24) });
  assert.equal(signal.kind, 'root-message');
  assert.equal(signal.at, T(24));
  assert.ok(signal.terms.includes('yaml'));
  assert.ok(signal.terms.includes('报错'), 'CJK 2-gram');
  assert.ok(signal.terms.every((t) => t.length >= 2), '不留单字噪声');
  const kinds = signal.entities.map((e) => e.kind);
  assert.ok(kinds.includes('file') && kinds.includes('domain') && kinds.includes('error'), `实体：${JSON.stringify(signal.entities)}`);
  assert.ok(signal.entities.some((e) => e.key === 'D:/work/demo/cfg.json'));

  // 停用词不进 terms
  const noisy = signalFromText('这个 问题 我们 可以 需要');
  assert.deepEqual(noisy.terms, []);
});

test('R12: scopeKeyFromPath 与 episode.scopeKey 同口径（小写盘符 + 正斜杠）', () => {
  assert.equal(scopeKeyFromPath('D:\\work\\demo'), 'w:d:/work/demo');
  assert.equal(scopeKeyFromPath('d:/work/demo/'), 'w:d:/work/demo');
  assert.equal(scopeKeyFromPath(''), 'w:<unknown>');
});

test('R12: degradedWalk 从 store 主题回落到棋局（R11 未落地时的等价物），每 hit 带 why', () => {
  const { store } = makeFixture();
  try {
    // 手工写一条派生主题（topics 是派生 kind，允许整目录替换）
    store.replaceDerived('topics', [{ id: 't:term:aaaa0001', kind: 'term', key: 'yaml', df: 2, idfNorm: 0.7, firstSeenAt: T(21), lastSeenAt: T(22), episodes: ['ep-aaaaaaa1', 'ep-aaaaaaa2'] }], { at: T(24) });
    const signal = signalFromText('yaml 装不上');
    const walk = degradedWalk({ signal, store });
    assert.equal(walk.degraded, true);
    assert.ok(walk.hits.length >= 1);
    for (const h of walk.hits) {
      assert.ok(Array.isArray(h.why) && h.why.length > 0, '每跳必须有 why（闸 6b）');
      assert.equal(h.depth, 1);
      assert.ok(h.episode.startsWith('ep-'));
    }
    // 失败局排在前面
    assert.ok(walk.hits.some((h) => h.kind === 'failure'));
    // 无命中 ⇒ 空
    const none = degradedWalk({ signal: signalFromText('毫不相关的主题'), store });
    assert.deepEqual(none.hits, []);
  } finally {
    rmSync(store.root, { recursive: true, force: true });
  }
});

test('R12: estimateTokens/clipLine 口径稳定（CJK 1.5 字/token、ASCII 4 字/token、单行化）', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.equal(estimateTokens('记忆'), 2); // ceil(2/1.5)
  assert.equal(clipLine('a\nb\tc'), 'a b c');
  assert.equal(singleLine('a\nb\tc'), 'a b c');
  assert.equal(singleLine('很长的句子'.repeat(50)).length, 250, 'singleLine 不截断');
  assert.ok(clipLine('字'.repeat(400)).length <= 160);
  assert.ok(clipLine('字'.repeat(400), TIGHT_CLIP).length <= TIGHT_CLIP);
  // 2026-11-04（0.133.0）：截断落在空白边界，别把词切一半（线上实测切出 `….ou…`）
  assert.equal(clipLine('aaaaaaaaaa bbbbbbbbbb cccccccccc', 18), 'aaaaaaaaaa…', '回退到最近的空白边界');
  assert.equal(clipLine('a'.repeat(40), 10), `${'a'.repeat(9)}…`, '没有空白就硬截（不为了边界丢掉一半内容）');
  assert.equal(clipLine('短文本', 100), '短文本', '没超限就原样返回');
  assert.ok(clipLine('x y z '.repeat(40), 20).endsWith('…'), '超限一定带省略号');
  assert.equal(formatCardDate(T(22)), '2026-10-22');
  assert.equal(formatCardDate(Number.NaN), '????-??-??');
});

// ---------------------------------------------------------------------------
// 作用域过滤（R12 侧兜底）+ CLI 路径把 store/scope 真喂给闸门
// ---------------------------------------------------------------------------

test('R12: normalizeScopeKey / isScopeVisible —— 与 R00 scopeKey 同口径', () => {
  const BS = String.fromCharCode(92);
  assert.equal(normalizeScopeKey(`D:${BS}Work${BS}Demo${BS}`), 'w:d:/Work/Demo', '只小写盘符、反斜杠转 /、去尾斜杠');
  assert.equal(normalizeScopeKey('w:d:/Work/Demo'), 'w:d:/Work/Demo');
  assert.equal(normalizeScopeKey('U:Owner'), 'u:owner');
  assert.equal(normalizeScopeKey(''), '');
  assert.equal(isScopeVisible('w:d:/work/demo', 'w:d:/work/demo'), true);
  assert.equal(isScopeVisible('u:owner', 'w:d:/work/demo'), true, '用户层跨项目可见');
  assert.equal(isScopeVisible('w:d:/work', 'w:d:/work/demo'), true, '子看得到祖先');
  assert.equal(isScopeVisible('w:d:/work/demo/plugin', 'w:d:/work/demo'), false, '父看不到子');
  assert.equal(isScopeVisible('w:e:/other', 'w:d:/work/demo'), false);
});

test('R12: filterHitsByScope —— 同域/u: 留下；别域与"作用域未知"分开计数', () => {
  const hits = [
    { episode: 'ep-1', scopeKey: 'w:d:/work/demo' },
    { episode: 'ep-2', scopeKey: 'w:d:/work/demo/plugin' }, // 子作用域：父看不到
    { episode: 'ep-3', scopeKey: 'u:owner' },
    { episode: 'ep-4', scopeKey: 'w:e:/other' },
    { episode: 'ep-5' }, // 没带 scopeKey ⇒ 证明不了可见
  ];
  const res = filterHitsByScope(hits, 'w:d:/work/demo');
  assert.deepEqual(res.hits.map((h) => h.episode), ['ep-1', 'ep-3']);
  assert.equal(res.dropped, 2, 'ep-2 与 ep-4');
  assert.equal(res.droppedUnknown, 1, 'ep-5');
  assert.equal(res.scope, 'w:d:/work/demo');

  const fromChild = filterHitsByScope(hits, 'w:d:/work/demo/plugin');
  assert.deepEqual(fromChild.hits.map((h) => h.episode), ['ep-1', 'ep-2', 'ep-3'], '子作用域能看到祖先与同域');

  // 没有当前作用域就不动（由闸门在需要时点出来）
  const noScope = filterHitsByScope(hits, '');
  assert.equal(noScope.hits.length, 5);
  assert.equal(noScope.dropped, 0);
});

test('R12: 跨作用域丢弃写进省略行（计数 + 原因，不静默）', () => {
  const { store } = fixture();
  const hits = [hit({ episodeId: 'ep-aaaaaaa2', seq: 12, claimId: 'c-0000aa02' })];
  const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, droppedCrossScope: 2, droppedUnknownScope: 1 });
  assert.equal(card.crossScope, 2);
  assert.equal(card.unknownScope, 1);
  assert.match(card.omissions, /^omitted: 3 items/);
  assert.match(card.omissions, /跨作用域未纳入 2 条/);
  assert.match(card.omissions, /作用域未知未纳入 1 条/);
  assert.match(card.omissions, /index\.md/, '省略行仍然指出去哪取');
  assert.ok(card.section.includes('cross') || card.section.includes('跨作用域'), '模型可见的省略行也要说');
});

/** 造一个只含一局/一主题/一 claim 的小库，作用域可控（runInject 会用 process.cwd() 算当前 scope）。 */
function makeScopedStore(scopeKey) {
  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-scope-'));
  const store = createStore({ root, now: T(20) });
  store.ensureDirs();
  store.putMany('episodes', [{ ...episode('ep-aaaaaaa1', 21, 3), scopeKey }]);
  store.replaceDerived('topics', [
    { id: 't:term:aaaa0001', kind: 'term', key: 'yaml', df: 2, idfNorm: 0.7, firstSeenAt: T(21), lastSeenAt: T(21), episodes: ['ep-aaaaaaa1'] },
  ], { at: T(24) });
  store.putMany('claims', [{
    ...claim({ id: 'c-scope001', kind: 'antipattern', text: "Cannot find module 'yaml'", day: 21, state: 'observed', support: [{ episode: 'ep-aaaaaaa1', seq: 30 }] }),
    scopeKey,
  }]);
  return { root, store };
}

test('R12: runInject 把 store + scope 传给闸门（闸 1/2/4/5 真核，不是 unverified）', async () => {
  const scope = scopeKeyFromPath(process.cwd());
  const { root } = makeScopedStore(scope);
  const shadowDir = mkdtempSync(path.join(tmpdir(), 'kifuin-shadow-'));
  try {
    const res = await runInject({ flags: { signal: 'yaml 装不上', store: root, shadow: true, 'shadow-dir': shadowDir } });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(res.card.claims.length >= 1, '同域命中应当展开');
    assert.ok(res.gates.checks.scopeChecked >= 1, '闸 1 真核过');
    assert.ok(res.gates.checks.supportChecked >= 1, '闸 2 真核过');
    assert.ok(res.gates.checks.provenanceChecked >= 1, '闸 5 真核过');
    const unverifiedGates = res.gates.checks.unverified.map((u) => u.gate);
    for (const g of ['1', '2', '4', '5']) {
      assert.equal(unverifiedGates.includes(g), false, `闸 ${g} 不该是 unverified（store 已经传进去了）`);
    }
    assert.ok(readShadow({ dir: shadowDir }).records.length >= 1, '--shadow 仍然只写指定目录');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(shadowDir, { recursive: true, force: true });
  }
});

test('R12: runInject 过滤跨作用域命中 ⇒ 零注入，省略里写明（不静默）', async () => {
  const { root } = makeScopedStore('w:e:/some/other/workspace');
  try {
    const res = await runInject({ flags: { signal: 'yaml 装不上', store: root } });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.card.section, null, '别的工作区的记忆不注入');
    // R11 已按作用域拒掉（它记在自己的 dropped 里）⇒ R12 侧兜底为 0，但审计字段要能看见
    assert.ok(res.card.crossScopeWalk >= 1, '被跨作用域挡掉的条数要能被看见');
    assert.match(res.card.omissions, /跨作用域未纳入/);
    assert.equal(res.card.claims.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Q19-B 预置（2026-11-03）：偏好只保留 hard；默认关（行为不变）
test('R12: preferenceHardOnly=true ⇒ soft 偏好不进卡；默认 false ⇒ 照旧', () => {
  const { store } = fixture();
  const hits = [
    hit({ episodeId: 'ep-aaaaaaa3', seq: 5, claimId: 'c-0000aa03', day: 23 }),
    hit({ episodeId: 'ep-aaaaaaa3', seq: 6, claimId: 'c-0000aa06', day: 23 }),
  ];
  const on = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, now: T(24), preferenceHardOnly: true, budgetTokens: 2000, limit: 10 });
  const onText = String(on.section ?? '');
  assert.ok(onText.includes('不要新增依赖'), 'hard 偏好保留');
  assert.ok(!onText.includes('理由：'), 'soft 偏好被丢弃');

  const off = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, now: T(24), budgetTokens: 2000, limit: 10 });
  assert.ok(String(off.section ?? '').includes('理由：'), '默认关：soft 仍在');
});

test('R12/A5: u:owner 类级 claim 只选同作用域 support（线上抽查发现的跨项目引用）', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kifu-scope-'));
  const store = createStore({ root, now: T(20) });
  store.ensureDirs();
  store.putMany('episodes', [
    { ...episode('ep-scope0001', 21, 2), scopeKey: 'w:d:/proj/a' },
    { ...episode('ep-scope0002', 22, 2), scopeKey: 'w:d:/proj/b' },
  ]);
  store.putMany('claims', [
    claim({
      id: 'c-scope0001', kind: 'antipattern', text: 'class:sandbox-limit · Error: tool call aborted',
      scopeKey: 'u:owner', day: 21, state: 'semantic',
      support: [
        { episode: 'ep-scope0002', seq: 11, occurredAt: T(22) },
        { episode: 'ep-scope0001', seq: 12, occurredAt: T(21) },
      ],
    }),
  ]);
  const hits = [{ claim: 'claims/c-scope0001', claimId: 'c-scope0001', claimKind: 'antipattern', claimState: 'semantic', episode: 'ep-scope0001', seq: 12, occurredAt: T(21) }];
  const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: 'w:d:/proj/a', now: T(24) });
  const text = String(card.section ?? '');
  assert.match(text, /ep-scope0001/, '应引用同作用域的先例');
  assert.ok(!text.includes('ep-scope0002'), '不得把别项目的先例渲染进本项目的卡');
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A6 引文可核（2026-11-04 audit-11）：卡上的每个字都必须落在它自己标注的 (ep, seq) 上
//   事故：文字取 claim.text（claim 的 exemplar，可能来自另一局），坐标取 src，日期取 claim.occurredAt。
//   线上 44 条引用里 15 条的文字只在本局别处、1 条本局根本没有，34/44 的日期不是所引那条事件的时间。
// ---------------------------------------------------------------------------

function makeProvenanceFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-prov-'));
  const store = createStore({ root, now: T(20) });
  store.ensureDirs();
  store.putMany('episodes', [episode('ep-bbbbbbb1', 21, 1), episode('ep-bbbbbbb2', 22, 1)]);
  store.putMany('claims', [
    // claim.text 是 21 号局（另一局）的 exemplar；support 里那条是真的 22 号局 42 处事件。
    claim({ id: 'c-bbbb0001', kind: 'antipattern', text: 'Cannot find module "left-pad"（21 号局的 exemplar）', day: 21, state: 'observed',
      support: [{ episode: 'ep-bbbbbbb2', seq: 42, quote: 'TypeError: x is not a function（22 号局 42 处的原文）', day: 22 }] }),
    claim({ id: 'c-bbbb0002', kind: 'antipattern', text: 'class:tool-unavailable · sed: -e expression #1, char 1: unknown command', day: 21, state: 'semantic',
      support: [{ episode: 'ep-bbbbbbb2', seq: 43, quote: 'sed: -e expression #1, char 1: unknown command: `,`', day: 22 }] }),
    // 旧数据形态：support 没有 quote（夹具走 claim() 的 quote 兜底，这里显式抹掉）
    { ...claim({ id: 'c-bbbb0003', kind: 'fact', text: '旧数据没有 quote 时退回 claim 文本', day: 21, state: 'observed',
      support: [{ episode: 'ep-bbbbbbb2', seq: 44, day: 22 }] }),
      support: [{ episode: 'ep-bbbbbbb2', seq: 44, occurredAt: T(22) }] },
  ]);
  return { root, store };
}

test('A6: 卡上文字取 src.quote（不是 claim.text），日期取 src.occurredAt（不是 claim.occurredAt）', () => {
  const { root, store } = makeProvenanceFixture();
  try {
    const hits = [hit({ episodeId: 'ep-bbbbbbb2', seq: 42, claimId: 'c-bbbb0001' })];
    const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
    const lines = cardLines(card);
    assert.equal(lines.length, 1, `应渲染 1 行，实际 ${lines.length}`);
    assert.ok(lines[0].includes('22 号局 42 处的原文'), `卡上应是所引位置的原文：${lines[0]}`);
    assert.ok(!lines[0].includes('21 号局的 exemplar'), `claim 的 exemplar 不许顶替现场原文：${lines[0]}`);
    assert.ok(lines[0].includes(formatCardDate(T(22))), `日期应是所引事件的时刻（${formatCardDate(T(22))}）：${lines[0]}`);
    assert.ok(!lines[0].includes(formatCardDate(T(21))), `日期不许取 claim.occurredAt：${lines[0]}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('A6: 类级 claim 的 class:<token> 标签保留成前缀，叙事部分仍是原文', () => {
  const { root, store } = makeProvenanceFixture();
  try {
    const hits = [hit({ episodeId: 'ep-bbbbbbb2', seq: 43, claimId: 'c-bbbb0002' })];
    const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
    const line = cardLines(card)[0] ?? '';
    assert.ok(line.includes('class:tool-unavailable'), `类级标签要保留：${line}`);
    assert.ok(line.includes('unknown command: `,`'), `叙事部分取原文：${line}`);
    assert.ok(line.indexOf('class:tool-unavailable') < line.indexOf('sed:'), '标签在叙事之前');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('A6: 旧数据缺 quote ⇒ 退回 claim.text（审计会把它抓成 elsewhere），日期仍取 src.occurredAt', () => {
  const { root, store } = makeProvenanceFixture();
  try {
    const hits = [hit({ episodeId: 'ep-bbbbbbb2', seq: 44, claimId: 'c-bbbb0003' })];
    const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
    const line = cardLines(card)[0] ?? '';
    assert.ok(line.includes('旧数据没有 quote 时退回 claim 文本'), `无 quote 时退回 claim.text：${line}`);
    assert.ok(line.includes(formatCardDate(T(22))), `日期仍取所引事件时刻：${line}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// T111（0.122.0）：类级 claim 只存一个代表原文 ⇒ 展示时优先选「与本次信号最贴近」的那条同域 support
// ---------------------------------------------------------------------------

test('T111: 同域 support 里更贴近信号的原文会被选中（不固定取 hit.seq 那条）', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-t111-'));
  try {
    const store = createStore({ root, now: T(20) });
    store.ensureDirs();
    store.putMany('episodes', [episode('ep-ccccc001', 21, 2)]);
    store.putMany('claims', [
      claim({
        id: 'c-cccc0001', kind: 'antipattern', text: 'class:tool-unavailable · sed: -e expression #1, unknown command', day: 21, state: 'semantic',
        support: [
          { episode: 'ep-ccccc001', seq: 10, quote: 'sed: -e expression #1, char 1: unknown command', day: 21 },
          { episode: 'ep-ccccc001', seq: 20, quote: 'json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)', day: 21 },
        ],
      }),
    ]);
    // hit 指向 seq 10（sed），但信号说的是 JSON 解析失败
    const hits = [hit({ episodeId: 'ep-ccccc001', seq: 10, claimId: 'c-cccc0001' })];
    const signal = signalFromText('json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)', { at: T(21) });
    signal.scopeKey = SCOPE;
    const card = buildMemoryCard({ signal, walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
    const line = cardLines(card)[0] ?? '';
    assert.ok(line.includes('JSONDecodeError'), `应展示与信号贴近的那条原文：${line}`);
    assert.ok(line.includes('seq 20'), `出处也要跟着换成那条（seq 20）：${line}`);
    assert.ok(line.includes('class:tool-unavailable'), `类级标签保留：${line}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T111: 没有更贴近的原文时保持原选（不为换而换）', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-t111b-'));
  try {
    const store = createStore({ root, now: T(20) });
    store.ensureDirs();
    store.putMany('episodes', [episode('ep-ccccc002', 21, 2)]);
    store.putMany('claims', [
      claim({
        id: 'c-cccc0002', kind: 'antipattern', text: 'class:tool-unavailable · sed: -e expression #1, unknown command', day: 21, state: 'semantic',
        support: [
          { episode: 'ep-ccccc002', seq: 10, quote: 'sed: -e expression #1, char 1: unknown command', day: 21 },
          { episode: 'ep-ccccc002', seq: 20, quote: 'fatal: unable to access: connection reset', day: 21 },
        ],
      }),
    ]);
    const hits = [hit({ episodeId: 'ep-ccccc002', seq: 10, claimId: 'c-cccc0002' })];
    const signal = signalFromText('TypeError: x is not a function', { at: T(21) });
    signal.scopeKey = SCOPE;
    const card = buildMemoryCard({ signal, walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
    const line = cardLines(card)[0] ?? '';
    assert.ok(line.includes('seq 10'), `没有更好候选时保持原出处：${line}`);
    assert.ok(line.includes('unknown command'), `原文也不换：${line}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// T115（0.124.0）：同一局里有更贴近信号的教训时，别拿那条无关的类级泛教训
// ---------------------------------------------------------------------------

test('T115: 同一局内按信号挑 claim —— 更贴近的那条胜出（出处随之）', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-t115-'));
  try {
    const store = createStore({ root, now: T(20) });
    store.ensureDirs();
    store.putMany('episodes', [episode('ep-ddddd001', 21, 4)]);
    store.putMany('claims', [
      // 锚定在 hit 的 seq 上，但与本次信号无关（"工具坏了"的泛教训）
      claim({ id: 'c-dddd0001', kind: 'antipattern', text: 'class:sandbox-limit · Error: tool call aborted', day: 21, state: 'semantic',
        support: [{ episode: 'ep-ddddd001', seq: 10, quote: 'Error: tool call aborted', day: 21 }] }),
      // 同一局的另一个 seq，才是本次真正对得上的那条
      claim({ id: 'c-dddd0002', kind: 'antipattern', text: 'SyntaxError: invalid or unexpected token at checkSyntax (node:internal/main/check_syntax:1)', day: 21, state: 'observed',
        support: [{ episode: 'ep-ddddd001', seq: 99, quote: 'SyntaxError: invalid or unexpected token at checkSyntax', day: 21 }] }),
    ]);
    const hits = [hit({ episodeId: 'ep-ddddd001', seq: 10, claimId: 'c-dddd0001' })];
    const signal = signalFromText('SyntaxError: invalid or unexpected token at checkSyntax (node:internal/main/check_syntax:1)', { at: T(21) });
    signal.scopeKey = SCOPE;
    const card = buildMemoryCard({ signal, walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
    const line = cardLines(card)[0] ?? '';
    assert.ok(line.includes('checkSyntax'), `应挑同局里贴近信号的那条：${line}`);
    assert.ok(!line.includes('tool call aborted'), `不该拿无关的泛教训：${line}`);
    assert.equal(card.claims[0]?.claimId, 'c-dddd0002', 'claimId 也要跟着换');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T115: 同一局里没有更贴近的教训时保持原选', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-t115b-'));
  try {
    const store = createStore({ root, now: T(20) });
    store.ensureDirs();
    store.putMany('episodes', [episode('ep-ddddd002', 21, 2)]);
    store.putMany('claims', [
      claim({ id: 'c-dddd0003', kind: 'antipattern', text: 'class:sandbox-limit · Error: tool call aborted', day: 21, state: 'semantic',
        support: [{ episode: 'ep-ddddd002', seq: 10, quote: 'Error: tool call aborted', day: 21 }] }),
      claim({ id: 'c-dddd0004', kind: 'fact', text: 'package.json 的 engines.node 是 >=23.8', day: 21, state: 'observed',
        support: [{ episode: 'ep-ddddd002', seq: 99, quote: 'engines.node >=23.8', day: 21 }] }),
    ]);
    const hits = [hit({ episodeId: 'ep-ddddd002', seq: 10, claimId: 'c-dddd0003' })];
    const signal = signalFromText('TypeError: x is not a function', { at: T(21) });
    signal.scopeKey = SCOPE;
    const card = buildMemoryCard({ signal, walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
    const line = cardLines(card)[0] ?? '';
    assert.ok(line.includes('tool call aborted'), `没有更好候选就别换：${line}`);
    assert.equal(card.claims[0]?.claimId, 'c-dddd0003');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 无源不入（0.134.0）：seq 是 1 基的，`seq: 0` 等于"不知道在哪" ⇒ 不进卡
// 线上实测（2026-11-04，pid 18464）：60 条引用里 2 条落在 seq 0，是"局级指针"行（fail=1 · topics=…），
// A6 文字层因此报 missing —— 卡上文字在该局里找不到，因为它本就不是某条事件的原文。
// ---------------------------------------------------------------------------

test('R12: seq 0 的条目不许进卡（无源不入），但其它条目照常渲染', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-seq0-'));
  try {
    const store = createStore({ root, now: T(20) });
    store.ensureDirs();
    store.putMany('episodes', [episode('ep-eeee0001', 21, 2)]);
    store.putMany('claims', [
      claim({ id: 'c-eeee0001', kind: 'antipattern', text: 'Cannot find module yaml', day: 21, state: 'observed',
        support: [{ episode: 'ep-eeee0001', seq: 12, quote: 'Cannot find module yaml' }] }),
    ]);
    // 一个"局级指针"hit：没有事件 seq（walk 给的是 0）
    const hits = [
      hit({ episodeId: 'ep-eeee0001', seq: 12, claimId: 'c-eeee0001' }),
      hit({ episodeId: 'ep-eeee0001', seq: 0 }),
    ];
    const signal = signalFromText('Cannot find module yaml', { at: T(21) });
    signal.scopeKey = SCOPE;
    const card = buildMemoryCard({ signal, walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
    const lines = cardLines(card);
    assert.ok(lines.some((l) => l.includes('Cannot find module yaml')), '有 seq 的照常渲染');
    assert.ok(!lines.some((l) => l.includes('seq 0')), `seq 0 的行不许出现：${lines.join(' | ')}`);
    assert.ok(!lines.some((l) => l.includes('fail=')), '局级指针行（fail=…）不再冒充带出处的行');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 边界闸的误伤（0.138.0）：`请求` 不是祈使句、`我记得` 不是指令
// 线上实测：全库 1192 条 claim 里 29 条被判"含指令"（其中 `请` 51 次命中大半是 `请求`），
// 加最小排除集后降到 13 条 —— 而这些被误判的 claim，原本会让**整张卡**被边界闸拦下。
// ---------------------------------------------------------------------------

test('R13: 祈使句判定的误伤排除（请求/申请/我记得 不算指令）', () => {
  const cases = [
    ['你应该先备份', true],
    ['请先跑测试', true],
    ['下一步要做什么', true],
    ['建议先看日志', true],
    ['务必先备份', true],
    ['申请权限', false],
    ['这个请求超时了', false],
    ['我记得是这样', false],
    ['邀请你参加', false],
  ];
  for (const [text, want] of cases) {
    const got = auditImperatives(text).length > 0;
    assert.equal(got, want, `${text} ⇒ ${want ? '应判指令' : '不该判指令'}`);
  }
});

// ---------------------------------------------------------------------------
// T154：同一条 claim 的两个不同出处 ⇒ 卡上只能出现一次
//
// 线上（0.14x）两次 `gate4/unsuperseded-duplicate` 的根因：R12 的去重键是
// `episode\0seq\0rawText`，**不含 claimId** —— 于是同一条 claim 被两个不同出处
// （support[0] / support[1]）各渲染一次；闸 4 按"归一化全文"判等，看到同一个 id
// 出现两次，就当成"未标 supersedes 的重复"，整张卡被打回。
// 修复：有 claim 的条目用 `claimId` 作去重主键；棋谱指针（无 claim）保持原键。
// ---------------------------------------------------------------------------

test('R12 T154: 同一条 claim 的两个不同出处 ⇒ 只渲染一次（去重键含 claimId）', () => {
  const { store } = fixture();
  // c-0000aa02 的 support 有两条：ep-aaaaaaa2/seq 12 与 ep-aaaaaaa1/seq 30
  const hits = [
    hit({ episodeId: 'ep-aaaaaaa2', seq: 12, claimId: 'c-0000aa02' }),
    hit({ episodeId: 'ep-aaaaaaa1', seq: 30, claimId: 'c-0000aa02' }),
  ];
  const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
  const rows = card.claims.filter((c) => c.claimId === 'c-0000aa02');
  assert.equal(rows.length, 1, `同一条 claim 只该出现一次，实际出现 ${rows.length} 次：${JSON.stringify(rows.map((r) => r.source))}`);
  assert.equal(card.claims.length, 1);
});

test('R12 T154: 不同 claim / 不同指针各自保留（去重不能把不同条目也并掉）', () => {
  // 用轻量夹具（短文本）：避免被 500 tokens 预算截断干扰这条断言
  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-t154-'));
  const store = createStore({ root, now: T(20) });
  store.ensureDirs();
  store.putMany('episodes', [
    { id: 'ep-aaaaaaa1', sessionId: 's1', scopeKey: SCOPE, startedAt: T(21), firstEventAt: T(21), lastEventAt: T(21), closure: { seqFrom: 11 }, l0: '', signals: { failures: 3 }, state: 'archived' },
    { id: 'ep-aaaaaaa2', sessionId: 's2', scopeKey: SCOPE, startedAt: T(22), firstEventAt: T(22), lastEventAt: T(22), closure: { seqFrom: 11 }, l0: '', signals: { failures: 1 }, state: 'archived' },
  ]);
  store.putMany('claims', [
    { id: 'c-t1540001', kind: 'fact', text: '甲', scopeKey: SCOPE, state: 'observed', support: [{ episode: 'ep-aaaaaaa1', seq: 30, quote: '甲' }], counter: [], occurredAt: T(21) },
    { id: 'c-t1540002', kind: 'fact', text: '乙', scopeKey: SCOPE, state: 'observed', support: [{ episode: 'ep-aaaaaaa2', seq: 12, quote: '乙' }], counter: [], occurredAt: T(22) },
  ]);
  try {
    const hits = [
      hit({ episodeId: 'ep-aaaaaaa1', seq: 30, claimId: 'c-t1540001' }),
      hit({ episodeId: 'ep-aaaaaaa2', seq: 12, claimId: 'c-t1540002' }),
      // 棋谱指针行（无 claim）：两条不同出处必须都保留
      hit({ episodeId: 'ep-aaaaaaa1', seq: 41 }),
      hit({ episodeId: 'ep-aaaaaaa2', seq: 42 }),
    ];
    const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
    const ids = card.claims.map((c) => c.claimId ?? '(pointer)');
    assert.equal(ids.filter((x) => x === 'c-t1540001').length, 1, JSON.stringify(card.claims.map((c) => c.line)));
    assert.equal(ids.filter((x) => x === 'c-t1540002').length, 1);
    assert.equal(ids.filter((x) => x === '(pointer)').length, 2, '指针行按原键去重，两条不同出处都保留');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// T162a：注入端认「合并节点」（merge）
//
// 合流（consolidate）已经能把多条近似 claim 压成一个合并节点：
//   merge = { version, key, rule, members:[claimId...], representative:{claimId, episode, seq, quote}, supportEpisodes, at }
// 合并节点的 text 取 representative.quote 原文。消费侧若不认它，合并节点与它的成员会在同一张卡里重复出现。
// 规则（本刀）：
//   · 合并节点被命中 ⇒ 渲染它；它的成员即使也被命中，也不再单独成行；
//   · 合并节点没被直接命中、但 ≥2 个成员被命中 ⇒ 用合并节点替换这些成员行；
//   · **没有 merge 字段的 claim 行为一字不改**（回归守卫见最后一条）。
// ---------------------------------------------------------------------------

const MERGE_FREE_GOLDEN = "<memory-ledger>\n# markers: [semantic]=≥3 局且无反例 · [candidate]=2 局 · [observed]=1 局 · [disputed]=存在反例 · [stale]=条件已变只给指针 · [antipattern]=失败教训 · 日期=occurredAt(UTC)\n- [candidate] 测试入口是 node test/run.mjs 而不是 npm test (ep-aaaaaaa1, 2026-10-21, seq 41)\n</memory-ledger>"; // 用改动前的实现算出来的逐字节快照（见回报）

const MERGE_QUOTE = 'Error: yaml 版本漂移（Cannot find module yaml）';

/** 合并节点夹具：三条 episode + 两条成员 claim + 一条合并节点 claim。 */
function makeMergeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-merge-'));
  const store = createStore({ root, now: T(20) });
  store.ensureDirs();
  const episodes = [21, 22, 23].map((day, i) => ({
    id: `ep-mrg0000${i + 1}`,
    sessionId: `session-mrg0000${i + 1}`,
    scopeKey: SCOPE,
    startedAt: T(day),
    firstEventAt: T(day),
    lastEventAt: T(day),
    recordedAt: T(day),
    closure: { logPath: null, graphPath: null, seqFrom: 10 + i, seqTo: 10 + i },
    l0: '',
    signals: { failures: 1, successes: 0, unsettled: 0, constraints: 0, tools: [] },
    state: 'archived',
  }));
  store.putMany('episodes', episodes);
  const member = (id, ep, seq, text, day) => ({
    id,
    kind: 'antipattern',
    text,
    scopeKey: SCOPE,
    threadIds: [],
    state: 'observed',
    support: [{ episode: ep, seq, quote: MERGE_QUOTE, occurredAt: T(day) }],
    counter: [],
    validity: { type: 'none', value: null },
    preconditions: [],
    occurredAt: T(day),
    recordedAt: T(day),
    counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null },
    supersedes: null,
  });
  const mergeNode = {
    ...member('c-mrg0001', 'ep-mrg00001', 30, MERGE_QUOTE, 23),
    state: 'candidate',
    support: [
      { episode: 'ep-mrg00001', seq: 30, quote: MERGE_QUOTE, occurredAt: T(21) },
      { episode: 'ep-mrg00002', seq: 12, quote: MERGE_QUOTE, occurredAt: T(22) },
    ],
    merge: {
      version: 1,
      key: 'yaml-version-drift',
      rule: 'text-similarity',
      members: ['c-mem0001', 'c-mem0002'],
      representative: { claimId: 'c-mem0001', episode: 'ep-mrg00001', seq: 30, quote: MERGE_QUOTE },
      supportEpisodes: ['ep-mrg00001', 'ep-mrg00002'],
      at: T(23),
    },
  };
  store.putMany('claims', [
    member('c-mem0001', 'ep-mrg00001', 30, MERGE_QUOTE, 21),
    member('c-mem0002', 'ep-mrg00002', 12, MERGE_QUOTE, 22),
    mergeNode,
  ]);
  return { root, store };
}

const mergeHit = (episodeId, seq, claimId, day) => ({
  episode: episodeId,
  nodeId: null,
  link: null,
  why: ['yaml'],
  weight: 1,
  occurredAt: T(day),
  kind: 'failure',
  seq,
  depth: 1,
  claimId,
});

test('T162a: 合并节点被命中 ⇒ 卡上只有合并节点那一行，成员不单独出现', () => {
  const { root, store } = makeMergeFixture();
  try {
    const hits = [
      mergeHit('ep-mrg00001', 30, 'c-mem0001', 21),
      mergeHit('ep-mrg00002', 12, 'c-mem0002', 22),
      mergeHit('ep-mrg00001', 30, 'c-mrg0001', 23),
    ];
    const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
    const ids = card.claims.map((c) => c.claimId);
    assert.deepEqual(ids, ['c-mrg0001'], `卡上只该有合并节点一行，实际：${JSON.stringify(ids)}`);
    assert.equal(card.claims.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T162a: 只有两个成员被命中（合并节点没被直接命中）⇒ 用合并节点替换成员行', () => {
  const { root, store } = makeMergeFixture();
  try {
    const hits = [
      mergeHit('ep-mrg00001', 30, 'c-mem0001', 21),
      mergeHit('ep-mrg00002', 12, 'c-mem0002', 22),
    ];
    const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
    const ids = card.claims.map((c) => c.claimId);
    assert.deepEqual(ids, ['c-mrg0001'], `应当由合并节点取代成员行，实际：${JSON.stringify(ids)}`);
    // 渲染用的 provenance 是合并节点自己的（representative 的出处），不是成员各自的
    assert.equal(card.claims[0].source.episode, 'ep-mrg00001');
    assert.equal(card.claims[0].source.seq, 30);
    assert.equal(card.claims[0].text, MERGE_QUOTE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T162a→T207: 只命中一个成员 ⇒ **冒泡**到合并节点（1 换 1，行数不变）', () => {
  const { root, store } = makeMergeFixture();
  try {
    const hits = [mergeHit('ep-mrg00001', 30, 'c-mem0001', 21)];
    const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
    const ids = card.claims.map((c) => c.claimId);
    assert.deepEqual(ids, ['c-mrg0001'], `单成员应冒泡成合并节点行，实际：${JSON.stringify(ids)}`);
    assert.equal(card.claims.length, 1, '1 换 1：行数不变');
    assert.match(String(card.claims[0].text), /代表 2 条 · 详见 c-mrg0001/, `行内要有冒泡标注，实际：${card.claims[0].text}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T162a 回归守卫: 没有 merge 字段的 claim 卡片逐字节不变', () => {
  const { store } = fixture();
  const hits = [hit({ episodeId: 'ep-aaaaaaa1', seq: 41, claimId: 'c-0000aa01' })];
  const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
  assert.equal(card.section, MERGE_FREE_GOLDEN, '无 merge 的卡片必须与改动前逐字节相同');
  assert.deepEqual(card.claims.map((c) => c.claimId), ['c-0000aa01']);
});

// ---------------------------------------------------------------------------
// T176：合并节点**只替换、不主动入选**
//
// 线上实证（`scripts/merge-acceptance.mjs` ④）：20 组合并组里"至少省 1 行"只有 33.3%，
// 还有两组**反增**（c-3011f83f 1→2、c-41157b78 2→3）。
// 根因：合并节点作为独立条目**自己命中了 topic**，而它代表的成员没被渲染 ⇒ 净 +1。
// 规则改成：
//   1. 合并节点不因为自己命中而单独成行；
//   2. ≥2 个成员被命中 ⇒ 用合并节点替换这些成员行（与 T162a 一致）；
//   3. 只有 1 个成员被命中 ⇒ 保留成员行（与 T162a 一致）；
//   4. 没有 merge 字段的 claim 行为一字不改。
// ---------------------------------------------------------------------------

test('T187 ①: 只有合并节点命中 ⇒ 这一条 hit 不成行（合并节点只在替代 ≥2 成员时出现）', () => {
  const { root, store } = makeMergeFixture();
  try {
    const hits = [mergeHit('ep-mrg00001', 30, 'c-mrg0001', 23)];
    const walkResult = walkOf(hits);
    const card = buildMemoryCard({ walkResult, store, scope: SCOPE, now: T(24) });
    const ids = card.claims.map((c) => c.claimId);
    assert.deepEqual(ids, [], `合并节点自身不许成行（也不退化成 episode 指针），实际：${JSON.stringify(ids)}`);
    const gates = runGates({ card, walkResult, store, scope: SCOPE });
    assert.equal(gates.ok, true, `空卡也要过闸：${JSON.stringify(gates.errors)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T176→T207: 合并节点命中 + 仅 1 个成员命中 ⇒ 冒泡成**一行**合并节点行（不重复、不增行）', () => {
  const { root, store } = makeMergeFixture();
  try {
    const hits = [
      mergeHit('ep-mrg00001', 30, 'c-mrg0001', 23),
      mergeHit('ep-mrg00001', 30, 'c-mem0001', 21),
    ];
    const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
    const ids = card.claims.map((c) => c.claimId);
    assert.deepEqual(ids, ['c-mrg0001'], `只该留一行合并节点行，实际：${JSON.stringify(ids)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T176: 合并节点排在成员之前（walk 顺序）⇒ 仍然只出现一次，且位置在首个成员处', () => {
  const { root, store } = makeMergeFixture();
  try {
    const hits = [
      mergeHit('ep-mrg00001', 30, 'c-mrg0001', 21),
      mergeHit('ep-mrg00001', 30, 'c-mem0001', 22),
      mergeHit('ep-mrg00002', 12, 'c-mem0002', 23),
    ];
    const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
    const ids = card.claims.map((c) => c.claimId);
    assert.deepEqual(ids, ['c-mrg0001'], `合并节点只该出现一次，实际：${JSON.stringify(ids)}`);
    assert.equal(card.claims.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('T187 ①b: 合并节点行不会以"指针"形态出现（指针行已随 T187 移除）', () => {
  const { root, store } = makeMergeFixture();
  try {
    const hits = [
      mergeHit('ep-mrg00001', 30, 'c-mrg0001', 23),
      mergeHit('ep-mrg00001', 30, 'c-mem0001', 21),
      mergeHit('ep-mrg00002', 12, 'c-mem0002', 22),
    ];
    const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
    assert.equal(card.claims.some((c) => c.kind === 'pointer'), false, '不再有指针行');
    // ≥2 成员 ⇒ 合并节点以**断言行**出现（替代表）
    assert.deepEqual(card.claims.map((c) => c.claimId), ['c-mrg0001']);
    assert.notEqual(card.claims[0].kind, 'pointer');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T177: 0 成员 + 合并节点没被命中 ⇒ 卡上什么都不出现（没东西可指）', () => {
  const { root, store } = makeMergeFixture();
  try {
    const card = buildMemoryCard({ walkResult: walkOf([]), store, scope: SCOPE, now: T(24) });
    assert.deepEqual(card.claims, []);
    assert.equal(card.section, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T177→T207 回归: ≥2 成员多换 1；单成员 1 换 1 冒泡（都不是指针行）', () => {
  const { root, store } = makeMergeFixture();
  try {
    const two = buildMemoryCard({
      walkResult: walkOf([mergeHit('ep-mrg00001', 30, 'c-mem0001', 21), mergeHit('ep-mrg00002', 12, 'c-mem0002', 22)]),
      store, scope: SCOPE, now: T(24),
    });
    assert.deepEqual(two.claims.map((c) => c.claimId), ['c-mrg0001']);
    assert.equal(two.claims[0].text, MERGE_QUOTE, '≥2 成员：原样原文，不带冒泡标注');
    assert.notEqual(two.claims[0].kind, 'pointer', '≥2 成员时是替换断言行，不是指针');

    const one = buildMemoryCard({
      walkResult: walkOf([mergeHit('ep-mrg00001', 30, 'c-mem0001', 21)]),
      store, scope: SCOPE, now: T(24),
    });
    assert.deepEqual(one.claims.map((c) => c.claimId), ['c-mrg0001'], '单成员：冒泡成合并节点行');
    assert.match(String(one.claims[0].text), /代表 2 条 · 详见 c-mrg0001/);
    assert.notEqual(one.claims[0].kind, 'pointer');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T187 ①c 守卫: 合并节点命中 + 别的行 ⇒ 只留别的行（不重复、不增行）', () => {
  const { root, store } = makeMergeFixture();
  try {
    store.putMany('claims', [{
      id: 'c-out0001',
      kind: 'fact',
      text: '无关的另一条断言',
      scopeKey: SCOPE,
      threadIds: [],
      state: 'observed',
      support: [{ episode: 'ep-mrg00001', seq: 11, quote: '无关的另一条断言', occurredAt: T(21) }],
      counter: [],
      validity: { type: 'none', value: null },
      preconditions: [],
      occurredAt: T(21),
      recordedAt: T(21),
      counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null },
      supersedes: null,
    }]);
    const hits = [
      mergeHit('ep-mrg00001', 30, 'c-mrg0001', 23),
      mergeHit('ep-mrg00001', 11, 'c-out0001', 21),
    ];
    const card = buildMemoryCard({ walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
    const ids = card.claims.map((c) => c.claimId);
    assert.deepEqual(ids, ['c-out0001'], `只留别的行，实际：${JSON.stringify(ids)}`);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T187：成员命中不许被 `pickClaim` 升级/吞并掉
//
// 背景（T179 诊断 + T185 统计）：合流收益卡在"可折组只有 4 个"。
// 源库 39 组里 35 组"本组成员行 < 2" ⇒ 折叠无从发生。其中 3 组
// （c-04807d22 / c-e05f1307 / c-ec0fcd25）明明有 **2 个成员锚点被命中**，
// 卡上却只渲染 1 行 —— 被 `pickClaim` 的"信号判别词打分升级"换掉了。
// 规则：**成员命中保留成员行**（不升级成合并节点，也不升级成别的 claim）。
// ---------------------------------------------------------------------------

/** 成员/合并节点正文**不同**的夹具：合并节点的正文才对得上信号判别词。 */
function makeMemberUpgradeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-t187-'));
  const store = createStore({ root, now: T(20) });
  store.ensureDirs();
  store.putMany('episodes', [21, 22].map((day, i) => ({
    id: `ep-up00000${i + 1}`,
    sessionId: `session-up00000${i + 1}`,
    scopeKey: SCOPE,
    startedAt: T(day),
    firstEventAt: T(day),
    lastEventAt: T(day),
    recordedAt: T(day),
    closure: { logPath: null, graphPath: null, seqFrom: 10 + i, seqTo: 10 + i },
    l0: '',
    signals: { failures: 1, successes: 0, unsettled: 0, constraints: 0, tools: [] },
    state: 'archived',
  })));
  const base = (id, ep, seq, day, text, extra = {}) => ({
    id,
    kind: 'antipattern',
    text,
    scopeKey: SCOPE,
    threadIds: [],
    state: 'observed',
    support: [{ episode: ep, seq, quote: text, occurredAt: T(day) }],
    counter: [],
    validity: { type: 'none', value: null },
    preconditions: [],
    occurredAt: T(day),
    recordedAt: T(day),
    counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null },
    supersedes: null,
    ...extra,
  });
  const MEMBER_A = '成员甲：yaml 报错原文';
  const MEMBER_B = '成员乙：yaml 报错原文';
  const MERGED = 'yaml drift 合并正文（两处报错同源）';
  store.putMany('claims', [
    base('c-up000001', 'ep-up000001', 30, 21, MEMBER_A),
    base('c-up000002', 'ep-up000002', 12, 22, MEMBER_B),
    base('c-upmrg001', 'ep-up000001', 30, 23, MERGED, {
      state: 'candidate',
      support: [
        { episode: 'ep-up000001', seq: 30, quote: MERGED, occurredAt: T(21) },
        { episode: 'ep-up000002', seq: 12, quote: MERGED, occurredAt: T(22) },
      ],
      merge: {
        version: 1,
        key: 'yaml-drift',
        rule: 'text-similarity',
        members: ['c-up000001', 'c-up000002'],
        representative: { claimId: 'c-up000001', episode: 'ep-up000001', seq: 30, quote: MERGED },
        supportEpisodes: ['ep-up000001', 'ep-up000002'],
        at: T(23),
      },
    }),
  ]);
  return { root, store };
}

/** 信号判别词 yaml / drift（4 字符以上才会进 signalTokens）：合并节点正文命中两个，成员只命中一个。 */
const upgradeSignal = () => {
  const signal = signalFromText('yaml drift 相关的问题', { at: T(24) });
  signal.scopeKey = SCOPE;
  return signal;
};

test('T187 ①→T207: 成员被命中 + 合并节点也被命中 ⇒ 只留**一行**合并节点行（1 换 1 冒泡）', () => {
  const { root, store } = makeMemberUpgradeFixture();
  try {
    const hits = [
      mergeHit('ep-up000001', 30, 'c-up000001', 21), // 成员甲
      mergeHit('ep-up000001', 30, 'c-upmrg001', 23), // 合并节点自己
    ];
    const card = buildMemoryCard({ signal: upgradeSignal(), walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
    const ids = card.claims.map((c) => c.claimId);
    assert.deepEqual(ids, ['c-upmrg001'], `应当只留一行合并节点行，实际：${JSON.stringify(ids)}`);
    assert.equal(card.claims.length, 1, '不重复成行');
    assert.equal(card.claims.some((c) => c.kind === 'pointer'), false, '不是指针行');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T187 ②: 同一条 claim 命中两次 ⇒ 卡上只出现一次（去重后冒泡成一行）', () => {
  const { root, store } = makeMemberUpgradeFixture();
  try {
    const hits = [
      mergeHit('ep-up000001', 30, 'c-up000001', 21),
      mergeHit('ep-up000001', 30, 'c-up000001', 21),
    ];
    const card = buildMemoryCard({ signal: upgradeSignal(), walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
    const ids = card.claims.map((c) => c.claimId);
    assert.deepEqual(ids, ['c-upmrg001'], `同一成员只该出现一次（冒泡后一行），实际：${JSON.stringify(ids)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T187 ③ 回归守卫: 没有 merge 关系的 claim，信号打分升级**照旧**生效', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kifuin-t187-plain-'));
  try {
    const store = createStore({ root, now: T(20) });
    store.ensureDirs();
    store.putMany('episodes', [{
      id: 'ep-pl000001', sessionId: 'session-pl000001', scopeKey: SCOPE,
      startedAt: T(21), firstEventAt: T(21), lastEventAt: T(21), recordedAt: T(21),
      closure: { logPath: null, graphPath: null, seqFrom: 10, seqTo: 10 }, l0: '',
      signals: { failures: 1, successes: 0, unsettled: 0, constraints: 0, tools: [] }, state: 'archived',
    }]);
    const plain = (id, text) => ({
      id, kind: 'fact', text, scopeKey: SCOPE, threadIds: [], state: 'observed',
      support: [{ episode: 'ep-pl000001', seq: 30, quote: text, occurredAt: T(21) }], counter: [],
      validity: { type: 'none', value: null }, preconditions: [], occurredAt: T(21), recordedAt: T(21),
      counters: { support: 1, counter: 0, injections: 0, lastInjectedAt: null }, supersedes: null,
    });
    store.putMany('claims', [plain('c-pl000001', '和信号无关的一条'), plain('c-pl000002', 'yaml drift 的那条正文')]);
    const hits = [mergeHit('ep-pl000001', 30, 'c-pl000001', 21)];
    const card = buildMemoryCard({ signal: upgradeSignal(), walkResult: walkOf(hits), store, scope: SCOPE, now: T(24) });
    assert.deepEqual(card.claims.map((c) => c.claimId), ['c-pl000002'], '无 merge 关系的 claim 升级行为一字不改');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T192 回归：升级目标集在源/影两库同口径的前提是"无 merge 的库一字不改"
//
// 背景：T192 想把 `pickClaim` 的**升级候选**排除合并节点及其成员（让源库/影库挑出同样的行）。
// 实测该改法会把 ④a 从 0 弄成 6、④b 从 3 涨到 18，已回滚；但"无 merge 的库行为一字不改"
// 这条约束必须被钉住 —— 以后再动 pickClaim 的候选集，这条 golden 先红。
// 断言：逐字节 section / claimId 顺序 / 无合并产物 / walk 结果不带 dropped 计数。
// ---------------------------------------------------------------------------

test('T192 回归: 库里没有合并组 ⇒ 升级行为一字不改（golden）', () => {
  const { store } = fixture();
  const hits = [hit({ episodeId: 'ep-aaaaaaa1', seq: 41, claimId: 'c-0000aa01' })];
  const walkResult = walkOf(hits);
  const card = buildMemoryCard({ walkResult, store, scope: SCOPE, now: T(24) });

  // ① 卡片逐字节不变（改动前的实现算出来的快照）
  assert.equal(card.section, MERGE_FREE_GOLDEN, '无 merge 的卡片必须与改动前逐字节相同');
  // ② claimId 顺序不变
  assert.deepEqual(card.claims.map((c) => c.claimId), ['c-0000aa01']);
  // ③ 库里没有合并节点，卡上也不许出现合并产物（块标记 / 合并指针）
  assert.equal(store.list('claims').some((x) => x?.record?.merge), false, '夹具库里不该有合并节点');
  assert.equal(card.claims.some((c) => c.merge || c.mergeNodeId || c._mergeBlock), false, '无 merge 的卡上不该有合并标记');
  // ④ walk 结果不被这套逻辑改动：深度仍是 1，且没有 merge 专属的 dropped 计数
  assert.equal(walkResult.depth, 1);
  assert.equal('dropped' in walkResult, false, '无 merge 的 walk 结果不带 dropped 计数');
});

// ---------------------------------------------------------------------------
// T207 触发面实验（1/2）：折叠触发从 P(≥2) 降到 P(≥1)
//
// 依据 docs/调研/47 的裁决：合流机制成立（12/12 省行）但频率 0/1000（上界 0.38%）。
// 这一刀把"只命中 1 个成员"也接到合并节点上（**1 换 1**，行数不变，行内标注"代表 N 条 · 详见 <id>"），
// 用 mergeStats 四个计数把触发面量出来；≥2 成员的"多换 1"行为不变，0 成员仍不出合并行。
// ---------------------------------------------------------------------------

test('T207 ①: 命中 1 个成员 ⇒ 冒泡（1 换 1，行数不变，行内有代表标注）', () => {
  const { root, store } = makeMergeFixture();
  try {
    const card = buildMemoryCard({
      walkResult: walkOf([mergeHit('ep-mrg00001', 30, 'c-mem0001', 21)]),
      store, scope: SCOPE, now: T(24),
    });
    assert.equal(card.claims.length, 1, '1 换 1');
    assert.equal(card.claims[0].claimId, 'c-mrg0001');
    assert.match(String(card.claims[0].text), /^代表 2 条 · 详见 c-mrg0001 · /, String(card.claims[0].text));
    assert.equal(card.mergeStats.bubbled, 1);
    assert.equal(card.mergeStats.collapsed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T207 ②: 命中 ≥2 个成员 ⇒ 仍"多换 1"（行数 = 成员数 − 1，行内是原文不加标注）', () => {
  const { root, store } = makeMergeFixture();
  try {
    const card = buildMemoryCard({
      walkResult: walkOf([mergeHit('ep-mrg00001', 30, 'c-mem0001', 21), mergeHit('ep-mrg00002', 12, 'c-mem0002', 22)]),
      store, scope: SCOPE, now: T(24),
    });
    assert.equal(card.claims.length, 1, '两条成员 ⇒ 一条合并行');
    assert.equal(card.claims[0].text, MERGE_QUOTE, '≥2 成员保持原行为：不加冒泡标注');
    assert.equal(card.mergeStats.collapsed, 2);
    assert.equal(card.mergeStats.bubbled, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T207 ③: 命中 0 个成员 ⇒ 不出现合并节点行（规则 1 保留）', () => {
  const { root, store } = makeMergeFixture();
  try {
    const card = buildMemoryCard({
      walkResult: walkOf([mergeHit('ep-mrg00001', 30, 'c-mrg0001', 23)]),
      store, scope: SCOPE, now: T(24),
    });
    assert.deepEqual(card.claims, []);
    assert.equal(card.mergeStats.membersHit, 0);
    assert.equal(card.mergeStats.collapsed, 0);
    assert.equal(card.mergeStats.bubbled, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T207 ④: mergeStats 四个计数正确（含"库里无合并节点"的全 0）', () => {
  const { root, store } = makeMergeFixture();
  try {
    // 合并节点自己 + 1 个成员 ⇒ 候选 1 / 成员 1 / 折叠 1 / 冒泡 1
    const a = buildMemoryCard({
      walkResult: walkOf([mergeHit('ep-mrg00001', 30, 'c-mrg0001', 23), mergeHit('ep-mrg00001', 30, 'c-mem0001', 21)]),
      store, scope: SCOPE, now: T(24),
    });
    assert.deepEqual(a.mergeStats, { groupsHit: 1, membersHit: 1, collapsed: 1, bubbled: 1 });

    // 两个成员、没命中合并节点 ⇒ 候选 0 / 成员 2 / 折叠 2 / 冒泡 0
    const b = buildMemoryCard({
      walkResult: walkOf([mergeHit('ep-mrg00001', 30, 'c-mem0001', 21), mergeHit('ep-mrg00002', 12, 'c-mem0002', 22)]),
      store, scope: SCOPE, now: T(24),
    });
    assert.deepEqual(b.mergeStats, { groupsHit: 1, membersHit: 2, collapsed: 2, bubbled: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  // 没有 merge 的库：字段存在且全 0（消费方不必判空）
  const plain = fixture();
  const card = buildMemoryCard({
    walkResult: walkOf([hit({ episodeId: 'ep-aaaaaaa1', seq: 41, claimId: 'c-0000aa01' })]),
    store: plain.store, scope: SCOPE, now: T(24),
  });
  assert.deepEqual(card.mergeStats, { groupsHit: 0, membersHit: 0, collapsed: 0, bubbled: 0 });
});

// ---------------------------------------------------------------- T226（audit-13 ①）：指标先有消费者
//
// `mergeStats.candidatesHit` 是**结构性死值**：T193 之后 walk 不再把合并节点当 hit 返回，
// 那个计数永远 0。它会让读的人以为"合流从来没被命中"。现改为 `groupsHit`（命中的**合并组**数），
// 由"卡片里出现该组的 ≥1 个成员"去重得到 —— 组数推不出行数，行数也推不出组数，两个都要。
test('T226: 有成员命中时 groupsHit 非零，且死值 candidatesHit 已从 mergeStats 消失', () => {
  const { root, store } = makeMergeFixture();
  try {
    const card = buildMemoryCard({
      walkResult: walkOf([mergeHit('ep-mrg00001', 30, 'c-mem0001', 21)]),
      store, scope: SCOPE, now: T(24),
    });
    assert.equal(card.mergeStats.groupsHit, 1, `命中了 1 组，实际：${JSON.stringify(card.mergeStats)}`);
    assert.equal(card.mergeStats.membersHit, 1);
    assert.equal('candidatesHit' in card.mergeStats, false, '死值字段必须从 mergeStats 里消失');
    // 没有成员命中 ⇒ 组数 0（而不是"死值 0"：这里 0 是有意义的"没触发"）
    const none = buildMemoryCard({ walkResult: walkOf([]), store, scope: SCOPE, now: T(24) });
    assert.equal(none.mergeStats.groupsHit, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

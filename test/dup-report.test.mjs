/**
 * T145 tombstone test —— 删掉 `scripts/dup-report.mjs` 会让这个文件全红：
 * 三个口径的重复对数、scope+kind 分桶、空库不抛、只读、脱敏都没有别的实现能顶。
 *
 * 夹具（6 条 claim，全部写在临时库，不碰真记忆库）：
 *   t1/t2/t3  同 scope + 同 kind（antipattern），正文只差一个十六进制 job id ⇒ 三口径都应命中
 *   t4        **同正文**但 kind=fact                     ⇒ 跨 kind 不许比（若比了，A/B/C 各多 3 对）
 *   t5        **同正文**但 scope 不同                    ⇒ 跨作用域不许比
 *   t6        完全无关的正文（同 scope + 同 kind 桶内）  ⇒ 三口径都不命中
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDupReport,
  renderMarkdown,
  toJson,
  featuresOf,
  jaccard,
  overlapCount,
  diffKindOf,
  asciiTokensOf,
  cjkBigramsOf,
  errorPrefixKeyOf,
  prefixOf,
  literalMask,
  desensitize,
  maskScopeKey,
  resolveStoreRoot,
  JACCARD_MIN,
  BIGRAM_OVERLAP_MIN,
  PREFIX_CHARS,
} from '../scripts/dup-report.mjs';
import { createStore } from '../src/rooms/persist.mjs';

const SCOPE_A = 'w:/fixture/alpha';
const SCOPE_B = 'w:/fixture/beta';

const NEAR = (id) => `排障记录：后台任务查不到时先列出任务再取值 job_list job_output worker bash-${id}`;

/** 6 条夹具 claim 的规格。 */
const SPECS = [
  { id: 'c-t1', kind: 'antipattern', scopeKey: SCOPE_A, text: NEAR('49fb11d400eb4696') },
  { id: 'c-t2', kind: 'antipattern', scopeKey: SCOPE_A, text: NEAR('7feb959e1546401f') },
  { id: 'c-t3', kind: 'antipattern', scopeKey: SCOPE_A, text: NEAR('a1b2c3d4e5f60718') },
  { id: 'c-t4', kind: 'fact', scopeKey: SCOPE_A, text: NEAR('49fb11d400eb4696') },
  { id: 'c-t5', kind: 'antipattern', scopeKey: SCOPE_B, text: NEAR('49fb11d400eb4696') },
  { id: 'c-t6', kind: 'antipattern', scopeKey: SCOPE_A, text: '发布流程：先跑 check 再打 tag，npm 不发包。' },
];

const claimRecord = (spec, seq) => ({
  id: spec.id,
  kind: spec.kind,
  scopeKey: spec.scopeKey,
  text: spec.text,
  state: 'observed',
  threadIds: [],
  support: [{ episode: 'ep-fixture', seq, quote: spec.text }],
  counter: [],
  validity: { type: 'none', value: null },
  preconditions: [{ check: 'scope', value: spec.scopeKey, why: '夹具' }],
  occurredAt: 1700000000000 + seq,
  recordedAt: 1700000000000 + seq,
  supersedes: null,
});

/** 建一个临时记忆库（写 6 条 claim），返回 root + 清理函数。 */
function makeStore(t) {
  const root = mkdtempSync(join(tmpdir(), 'kifuin-t145-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createStore({ root });
  store.ensureDirs();
  store.putMany(
    'claims',
    SPECS.map((spec, i) => claimRecord(spec, i + 1)),
  );
  return { root, store };
}

const pairIds = (report, list) => list.map((p) => `${report.claimsIndex[p.i].id}|${report.claimsIndex[p.j].id}`).sort();

/* ── ① 三个口径各自的重复对数 ────────────────────────────── */

test('① 三个口径：3 条近似 claim 每个口径都恰好 3 对', (t) => {
  const { root } = makeStore(t);
  const r = buildDupReport({ root, now: 1_700_000_000_000 });
  assert.equal(r.totals.claims, 6);
  assert.equal(r.totals.corruptFiles, 0);
  for (const key of ['A', 'B', 'C']) {
    const m = r.metrics[key];
    assert.equal(m.pairs, 3, `口径 ${key} 应命中 3 对，实际 ${m.pairs}`);
    assert.equal(m.involvedClaims, 3, `口径 ${key} 只应涉及 t1/t2/t3`);
    assert.equal(m.clusters, 1, `口径 ${key} 应合成 1 个簇`);
    assert.equal(m.reduction, 2, `口径 ${key} 3 条合 1 条 ⇒ 少 2 条`);
    // 具体是哪三条：t1/t2/t3
    const seen = new Set();
    for (const g of m.clusters_raw) for (const i of g) seen.add(r.claimsIndex[i].id);
    assert.deepEqual([...seen].sort(), ['c-t1', 'c-t2', 'c-t3']);
  }
  assert.equal(r.union.pairs, 3);
  assert.equal(r.union.clusters, 1);
  assert.equal(r.union.reduction, 2);
  // 三口径并集去重后仍是 3 对（不是 9 对）
  assert.equal(r.union.multiMetricPairs, 3, '同一对被 A/B/C 同时命中应合并计数');
});

test('① 三个口径的命中对明细（可复算）', (t) => {
  const { root } = makeStore(t);
  const r = buildDupReport({ root, now: 1_700_000_000_000 });
  const expected = ['c-t1|c-t2', 'c-t1|c-t3', 'c-t2|c-t3'];
  assert.deepEqual(pairIds(r, r.metrics.A.pairs_raw), expected);
  assert.deepEqual(pairIds(r, r.metrics.B.pairs_raw), expected);
  assert.deepEqual(pairIds(r, r.metrics.C.pairs_raw), expected);
  // 三个口径的差分形态：都只差十六进制 id
  for (const key of ['A', 'B', 'C']) assert.equal(r.metrics[key].diff['digits-differ'], 3);
  assert.equal(r.union.diff['digits-differ'], 3);
});

/* ── ② 分桶正确：跨 kind / 跨 scope 不算 ─────────────────── */

test('② 分桶：同正文但 kind 或 scope 不同的 claim 不进任何口径', (t) => {
  const { root } = makeStore(t);
  const r = buildDupReport({ root, now: 1_700_000_000_000 });
  const allIds = new Set();
  for (const key of ['A', 'B', 'C']) for (const p of r.metrics[key].pairs_raw) {
    allIds.add(r.claimsIndex[p.i].id);
    allIds.add(r.claimsIndex[p.j].id);
  }
  for (const id of ['c-t4', 'c-t5', 'c-t6']) assert.ok(!allIds.has(id), `${id} 不该出现在任何命中对里`);
  // t1/t2/t3 + t6 同桶（antipattern + scope A）⇒ 6 对可比较；t4/t5 各自成桶 ⇒ 不参与
  assert.equal(r.totals.buckets, 3, 'scope+kind 应分出 3 个桶');
  assert.equal(r.metrics.C.comparablePairs, 6, 'C 的分母 = 同桶全部 6 对');
});

test('② 反证：如果分桶失效，t4/t5 一定被三口径全部命中（证明上面的排除是真的在起作用）', () => {
  const [t1, t4, t5] = SPECS.map((s) => featuresOf(s));
  // t1 vs t4 只差 kind，t1 vs t5 只差 scope —— 特征完全一样
  assert.ok(jaccard(t1.ascii, t4.ascii) >= JACCARD_MIN, 'A 会命中 t1-t4');
  assert.ok(jaccard(t1.ascii, t5.ascii) >= JACCARD_MIN, 'A 会命中 t1-t5');
  assert.ok(overlapCount(t1.bigrams, t4.bigrams) >= BIGRAM_OVERLAP_MIN, 'B 会命中 t1-t4');
  assert.ok(overlapCount(t1.bigrams, t5.bigrams) >= BIGRAM_OVERLAP_MIN, 'B 会命中 t1-t5');
  assert.equal(t1.error.key, t4.error.key, 'C 会命中 t1-t4');
  assert.equal(t1.error.key, t5.error.key, 'C 会命中 t1-t5');
});

test('② --scope：只看一个作用域时，另一个作用域的 claim 直接不进分母', (t) => {
  const { root } = makeStore(t);
  const onlyB = buildDupReport({ root, scope: SCOPE_B, now: 1_700_000_000_000 });
  assert.equal(onlyB.totals.claims, 1);
  assert.equal(onlyB.metrics.A.pairs + onlyB.metrics.B.pairs + onlyB.metrics.C.pairs, 0);
  const onlyA = buildDupReport({ root, scope: SCOPE_A, now: 1_700_000_000_000 });
  assert.equal(onlyA.totals.claims, 5);
  assert.equal(onlyA.metrics.A.pairs, 3, 't4 是 fact ⇒ 只把 t1/t2/t3 算进来');
});

/* ── ③ 空库：0 且不抛 ───────────────────────────────────── */

test('③ 空库（目录不存在）：三个口径都是 0，且不抛', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kifuin-t145-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = buildDupReport({ root, now: 1_700_000_000_000 });
  assert.equal(r.totals.claims, 0);
  assert.equal(r.totals.corruptFiles, 0);
  for (const key of ['A', 'B', 'C']) {
    assert.equal(r.metrics[key].pairs, 0);
    assert.equal(r.metrics[key].comparablePairs, 0);
    assert.equal(r.metrics[key].hitRate, 0);
    assert.equal(r.metrics[key].reduction, 0);
  }
  assert.equal(r.union.pairs, 0);
  assert.equal(r.union.reduction, 0);
  assert.equal(r.dontMerge.clusters, 0);
  // 渲染与 JSON 都不许因为空库炸
  assert.match(renderMarkdown(r), /claim 总数：\*\*0\*\*/);
  assert.equal(toJson(r).totals.claims, 0);
});

test('③ 空库（目录存在但 claims/ 为空）：同样 0 且不抛', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kifuin-t145-empty2-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'claims'), { recursive: true });
  const r = buildDupReport({ root, now: 1_700_000_000_000 });
  assert.equal(r.totals.claims, 0);
  assert.equal(r.metrics.C.comparablePairs, 0);
});

/* ── 只读与脱敏 ─────────────────────────────────────────── */

test('只读：跑完前后整库 sha256 快照逐字相同（不写 claim、不改 manifest）', (t) => {
  const { root, store } = makeStore(t);
  const before = store.snapshot();
  const r = buildDupReport({ root, now: 1_700_000_000_000 });
  assert.ok(r.totals.claims > 0, '得真读到东西，否则只读断言是空的');
  const after = createStore({ root }).snapshot();
  assert.deepEqual([...after.files.entries()].sort(), [...before.files.entries()].sort(), '文件内容快照必须一致');
  assert.deepEqual(after.counts, before.counts);
});

test('脱敏：报告里不出现本机用户名 / 绝对路径', () => {
  const home = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\someone';
  const sample = `${home}\\default-workspace\\proj 里报错`;
  const masked = desensitize(sample);
  assert.ok(masked.includes('<user-home>'), `home 必须被脱敏，实际 ${masked}`);
  assert.ok(!masked.includes(home), '不许出现 home 路径');
  assert.equal(maskScopeKey(`w:${home}\\default-workspace\\proj`).includes(home), false, 'scope 也不许露 home');
  assert.ok(maskScopeKey('w:/a/b/c/d').startsWith('w:…/'), '长绝对路径压成 …/最后两段');
  assert.equal(maskScopeKey('u:owner'), 'u:owner', '用户层作用域原样保留');
});

/* ── 口径细节（阈值与特征不许漂移）──────────────────────── */

test('口径细节：阈值常量与特征抽取的边界', () => {
  assert.equal(JACCARD_MIN, 0.6);
  assert.equal(BIGRAM_OVERLAP_MIN, 4);
  assert.equal(PREFIX_CHARS, 40);
  // A：去停用词、去纯数字、长度 ≥2（`error` 本身就在 EN_STOPWORDS：报错串里人人都有，没有区分度）
  assert.deepEqual([...asciiTokensOf('Error: the 12 const foo_1')].sort(), ['foo_1']);
  assert.ok(!asciiTokensOf('the and 12 34').size, '全是停用词/纯数字 ⇒ 空集（该对不参与 A）');
  // B：含虚字的 2-gram 被丢掉
  const grams = cjkBigramsOf('的了是在');
  assert.equal(grams.size, 0, '全是虚字 ⇒ 0 个 gram');
  assert.ok(cjkBigramsOf('上下文压缩').has('上下') === false, '「上下」是停用 gram');
  // C：无已知错误类时 cls 为 null、key 退化成前缀
  assert.equal(errorPrefixKeyOf('unknown job bash-1').cls, null);
  assert.equal(errorPrefixKeyOf('cannot find module x').cls, 'class:module-missing');
  assert.equal(prefixOf('一二三四五六七八九十'.repeat(10)).length, 40);
  // 差异形态
  assert.equal(diffKindOf({ norm: 'a', lit: 'a' }, { norm: 'a', lit: 'a' }), 'identical');
  assert.equal(diffKindOf({ norm: 'bash-1', lit: 'bash-<hex>' }, { norm: 'bash-2', lit: 'bash-<hex>' }), 'digits-differ');
  assert.equal(diffKindOf({ norm: 'ab', lit: 'ab' }, { norm: 'cd', lit: 'cd' }), 'other');
  assert.equal(literalMask('version = "0.2.1-go.23"'), 'version = "<n>.<n>.<n>-go.<n>"');
});

test('CLI：--root 解析与 --json 结构', (t) => {
  const { root } = makeStore(t);
  assert.equal(resolveStoreRoot(['--root', root], {}), root);
  assert.match(resolveStoreRoot([], { DSH_HOME: '/tmp/home' }), /memory-context$/);
  const r = buildDupReport({ root, now: 1_700_000_000_000 });
  const j = toJson(r);
  assert.equal(j.metrics.A.pairs, 3);
  assert.equal(j.union.clusters, 1);
  assert.deepEqual(j.metrics.A.topClusters[0].sort(), ['c-t1', 'c-t2', 'c-t3']);
  assert.equal(j.thresholds.jaccardMin, 0.6);
  // JSON 里不许有 claim 全文（只给 id 与簇）
  assert.equal(JSON.stringify(j).includes(NEAR('49fb11d400eb4696')), false, 'JSON 不输出完整原文');
});

test('不该合：validity 不同的簇必须被标记为阻断', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kifuin-t145-ver-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createStore({ root });
  store.ensureDirs();
  const base = claimRecord({ ...SPECS[0], id: 'c-v1' }, 1);
  const other = {
    ...claimRecord({ ...SPECS[0], id: 'c-v2' }, 2),
    validity: { type: 'version', value: '0.2.1-go.99' },
  };
  store.putMany('claims', [base, other]);
  const r = buildDupReport({ root, now: 1_700_000_000_000 });
  assert.ok(r.union.pairs >= 1);
  assert.equal(r.dontMerge.validityDiffers, 1, '同前缀不同版本 ⇒ 标为不该合');
  assert.ok(r.dontMerge.blockedClusters >= 1);
  assert.ok(renderMarkdown(r).includes('validity'));
});

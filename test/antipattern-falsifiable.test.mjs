// T310 · antipattern 失效条件（M4/F3）的 tombstone test。
// 删掉 scripts/antipattern-falsifiable.mjs ⇒ 本文件整片红。
//
// 覆盖：
//   ① 派生规则 R1–R3（precondition / validity / validUntil / 文本条件子句）与"推不出来就 unverified"
//   ② **反误报**：`gh 登录失效` 这种命令输出里的词不算条件子句
//   ③ 覆盖率统计（total / literal / substantive / unverified / scopeOnly）
//   ④ 抽样确定性（同输入同输出、等距、n 截断）
//   ⑤ 副本守卫（只许仓库 tmp/、不许与源库互相包含）
//   ⑥ 端到端 applyToCopy：副本里 antipattern 带 `falsifiableWhen` + `falsificationStatus`，推不出来写 null
//   ⑦ CLI：--help / 缺参 / 库不存在

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';
import {
  AntipatternError,
  analyzeAntipatterns,
  applyToCopy,
  assertCopyTarget,
  deriveFalsifiableWhen,
  isSubstantiveCheck,
  main,
  parseArgs,
  sampleRows,
} from '../scripts/antipattern-falsifiable.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TMP = path.join(REPO_ROOT, 'tmp');
mkdirSync(TMP, { recursive: true });

const anti = (over = {}) => ({
  id: 'c-anti0001',
  kind: 'antipattern',
  scopeKey: 'w:test/demo',
  state: 'observed',
  text: 'Error: boom happened',
  support: [{ episode: 'ep-test01', seq: 10, quote: 'Error: boom happened', occurredAt: 1 }],
  counter: [],
  validity: { type: 'none', value: null },
  preconditions: [{ check: 'scope', value: 'w:test/demo', why: 'fixture' }],
  occurredAt: 1,
  threadIds: [],
  ...over,
});

test('T310: R1 非 scope 前置条件 ⇒ 派生（来源可核）', () => {
  const claim = anti({ preconditions: [{ check: 'scope', value: 'w:test/demo' }, { check: 'file-exists', value: 'cfg.json' }] });
  const d = deriveFalsifiableWhen(claim);
  assert.equal(d.status, 'derived');
  assert.equal(d.source, 'preconditions[1]');
  assert.match(d.clause, /file-exists = cfg\.json/);
  assert.equal(isSubstantiveCheck('file-exists'), true);
  assert.equal(isSubstantiveCheck('scope'), false);
});

test('T310: R2 validity 非 none ⇒ 派生；R3 文本条件子句 ⇒ 逐字切片', () => {
  const v = deriveFalsifiableWhen(anti({ validity: { type: 'version', value: 'pkg@1.0.0' } }));
  assert.equal(v.status, 'derived');
  assert.equal(v.source, 'validity');
  assert.match(v.clause, /version=pkg@1\.0\.0/);

  const u = deriveFalsifiableWhen(anti({ text: '除非 cfg.json 已存在，否则这条不成立', preconditions: [] }));
  assert.equal(u.status, 'derived');
  assert.equal(u.source.startsWith('text@'), true);
  assert.ok('除非 cfg.json 已存在，否则这条不成立'.includes(u.clause), 'clause 必须是原文子串');
  assert.equal(u.offset, 0);

  const vu = deriveFalsifiableWhen(anti({ validUntil: 1_790_000_000_000 }));
  assert.equal(vu.status, 'derived');
  assert.equal(vu.source, 'validUntil');
});

test('T310: 反误报 —— 命令输出里的「登录失效」不算条件子句', () => {
  const d = deriveFalsifiableWhen(anti({ text: 'FAIL network | （gh 登录失效：跑 gh auth login）', preconditions: [] }));
  assert.equal(d.status, 'unverified');
  assert.equal(d.clause, null);
});

test('T310: 推不出来 ⇒ unverified（scope-only / 无条件，分别给 reason）', () => {
  const scopeOnly = deriveFalsifiableWhen(anti());
  assert.equal(scopeOnly.status, 'unverified');
  assert.match(scopeOnly.reason, /scope-only/);
  const none = deriveFalsifiableWhen(anti({ preconditions: [] }));
  assert.equal(none.status, 'unverified');
  assert.equal(none.reason, 'no-recorded-condition');
});

test('T310: 覆盖率统计 —— 只算 kind=antipattern，literal/substantive 分开', () => {
  const claims = [
    anti({ id: 'c-a1' }),
    anti({ id: 'c-a2', preconditions: [{ check: 'file-exists', value: 'x.json' }] }),
    anti({ id: 'c-a3', validity: { type: 'version', value: 'p@1' } }),
    { ...anti({ id: 'c-f1' }), kind: 'fact' },
  ];
  const a = analyzeAntipatterns(claims);
  assert.equal(a.total, 3);
  assert.equal(a.literal, 3, '三条都有字面条件（scope 也算字面）');
  assert.equal(a.substantive, 2, '只有 file-exists 与 version 是实质条件');
  assert.equal(a.unverified, 1);
  assert.equal(a.scopeOnly, 1);
  assert.equal(a.rows.length, 3);
});

test('T310: 抽样确定性 —— 等距、同输入同输出、n 截断', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `c-${String(i).padStart(3, '0')}` }));
  const a = sampleRows(rows, 5);
  const b = sampleRows(rows, 5);
  assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id));
  assert.equal(a.length, 5);
  assert.equal(a[0].id, 'c-000');
  assert.equal(a[4].id, 'c-009');
  assert.equal(sampleRows(rows, 999).length, 10, 'n 超池取全池');
  assert.deepEqual(sampleRows([], 5), []);
});

test('T310: 副本守卫 —— 只许仓库 tmp/，不许与源库互相包含', () => {
  assert.throws(() => assertCopyTarget(path.join(REPO_ROOT, 'evidence', 'x'), '/src'), (e) => e instanceof AntipatternError && e.code === 'antipattern-falsifiable/out-not-in-tmp');
  assert.throws(() => assertCopyTarget('', '/src'), (e) => e instanceof AntipatternError);
  const ok = assertCopyTarget(path.join(TMP, 't310-guard-ok'), '/src/store');
  assert.ok(ok.startsWith(TMP));
  assert.throws(
    () => assertCopyTarget(path.join(TMP, 'src', 'copy'), path.join(TMP, 'src')),
    (e) => e instanceof AntipatternError && e.code === 'antipattern-falsifiable/out-inside-source',
  );
});

test('T310: 端到端 —— applyToCopy 只写副本，antipattern 带 falsifiableWhen/unverified', () => {
  const src = mkdtempSync(path.join(TMP, 't310-src-'));
  const out = path.join(TMP, `t310-out-${Date.now()}`);
  try {
    const store = createStore({ root: src });
    store.put('claims', anti({ id: 'c-a1' }));
    store.put('claims', anti({ id: 'c-a2', preconditions: [{ check: 'cmd', value: 'pnpm test' }] }));
    store.put('claims', { ...anti({ id: 'c-f1' }), kind: 'fact' });

    const result = applyToCopy({ srcRoot: src, outDir: out });
    assert.equal(result.copied, 3);
    assert.equal(result.derived, 1);
    assert.equal(result.unverified, 1);

    const copy = createStore({ root: out });
    const records = copy.list('claims').map((r) => r.record).filter(Boolean);
    const a1 = records.find((r) => r.id === 'c-a1');
    const a2 = records.find((r) => r.id === 'c-a2');
    const f1 = records.find((r) => r.id === 'c-f1');
    assert.equal(a1.falsifiableWhen, null, '推不出来写 null');
    assert.equal(a1.falsificationStatus, 'unverified');
    assert.match(a2.falsifiableWhen, /cmd = pnpm test/);
    assert.equal(a2.falsificationStatus, 'derived');
    assert.equal('falsifiableWhen' in f1, false, '非 antipattern 不补字段');

    // 源库没被写
    const srcRecords = createStore({ root: src }).list('claims').map((r) => r.record).filter(Boolean);
    assert.equal('falsifiableWhen' in srcRecords.find((r) => r.id === 'c-a1'), false);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('T310: CLI 兜底', () => {
  assert.deepEqual(parseArgs(['--store', 'x']), { store: 'x', out: null, apply: false, sample: 5, json: false, help: false });
  assert.equal(parseArgs(['--sample', '3']).sample, 3);
  assert.ok(parseArgs(['--bogus']).error);
  assert.equal(main(['--help']), 0);
  assert.equal(main([]), 2, '缺 --store ⇒ 2');
  assert.equal(main(['--store', path.join(TMP, 'no-such-store-t310')]), 2, '库不存在 ⇒ 2');
  assert.equal(main(['--store', REPO_ROOT, '--apply', '--out', path.join(REPO_ROOT, 'evidence', 'x')]), 2, '越界副本 ⇒ 2');
});

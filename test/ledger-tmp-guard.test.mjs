// T224 · 台账口径守卫：`tmp/` 下不许有 `*.test.mjs`。
//
// 事故（2026-11-05 发版卡住）：agent 把旧契约测试副本留在 `tmp/t162c-old/` 与 `tmp/t199-old/`，
// 而裸 `node --test` 会**递归发现**它们 ⇒ 多跑 145 条测试、其中 8 条是"已被新契约取代"的红，
// 台账（`ledger-sync`）与校验（`ledger-check`）量的文件集还不同（760 vs 759）⇒ 永远对不上。
//
// 这个文件是**守卫**，不是实现：它不修台账，只负责让"有人在 tmp/ 里留测试副本"这件事在 CI 变红。
// 删掉本文件 ⇒ 少一道闸（把 tmp 副本放进仓库，`node --test "test/*.test.mjs"` 仍是绿的，但裸 `--test` 会红）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', '.git']);

/** 递归收集 `dir` 下所有 `*.test.mjs`（跳过 node_modules/.git），返回仓库相对路径。 */
function findTestFiles(dir, depth = 0) {
  if (depth > 8) return [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTestFiles(abs, depth + 1));
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) out.push(path.relative(REPO, abs).split(path.sep).join('/'));
  }
  return out;
}

test('台账守卫: tmp/ 下不许有 *.test.mjs（旧契约副本会让 node --test 多跑一遍）', () => {
  const tmpDir = path.join(REPO, 'tmp');
  const copies = findTestFiles(tmpDir);
  assert.deepEqual(
    copies,
    [],
    `tmp/ 下存在测试副本：${copies.join(', ')}\n`
      + 'tmp 里的测试副本会让 `node --test` 多跑一遍**旧契约**（T162c 4 条 + T199 4 条），'
      + '台账随之漂移、发版卡死。做法：改名成 `*.test.mjs.off`（保留原文，不删），或用 `_stale-test-copies/` 归档。',
  );
});

test('台账守卫: 全仓 *.test.mjs 都必须在 test/ 下（不许散落在别处）', () => {
  const all = findTestFiles(REPO).filter((rel) => !rel.startsWith('tmp/'));
  const outside = all.filter((rel) => !rel.startsWith('test/'));
  assert.deepEqual(outside, [], `测试文件必须都在 test/ 下，却发现：${outside.join(', ')}`);
  assert.ok(all.length >= 60, `测试文件数异常（${all.length}）—— 是不是 glob 写错了？`);
});

/**
 * 判据（不做注释剥离 —— 注释里本来就写着"不许裸 `['--test']`"，剥离写法一错就会自己判红自己）：
 * 只认**调用点**：`execFileAsync(process.execPath, ['--test', TEST_GLOB, ...)`。
 */
const TEST_CALL_RE = /execFileAsync\(\s*process\.execPath\s*,\s*\[\s*'--test'\s*,\s*TEST_GLOB\s*\]/;
const BARE_TEST_CALL_RE = /execFileAsync\(\s*process\.execPath\s*,\s*\[\s*'--test'\s*\]/;

test('台账守卫: ledger-sync 与 ledger-check 用同一个测试口径（否则台账永远对不上）', () => {
  const sync = readFileSync(path.join(REPO, 'scripts', 'ledger-sync.mjs'), 'utf8');
  const check = readFileSync(path.join(REPO, 'scripts', 'ledger-check.mjs'), 'utf8');
  for (const [name, src] of [['ledger-sync', sync], ['ledger-check', check]]) {
    assert.ok(
      src.includes("const TEST_GLOB = 'test/*.test.mjs';"),
      `${name} 必须用 TEST_GLOB = 'test/*.test.mjs'（与 CI 同一条命令）`,
    );
    assert.match(
      src,
      TEST_CALL_RE,
      `${name} 的 node --test 调用必须传 TEST_GLOB`,
    );
    // 裸 `--test`（没有文件名/glob 参数）会递归扫全树：发现即红
    assert.ok(
      !BARE_TEST_CALL_RE.test(src),
      `${name} 里出现了裸 \`['--test']\` —— 它会递归发现 tmp/ 里的旧契约副本，必须用 TEST_GLOB`,
    );
    assert.ok(
      !src.includes('git ls-tree -r --name-only HEAD test/'),
      `${name} 又回去"只测已跟踪文件"了 —— 那样两边量的不是同一个东西（760 vs 759）`,
    );
  }
  // 两个脚本都必须有 tmp 副本告警
  for (const [name, src] of [['ledger-sync', sync], ['ledger-check', check]]) {
    assert.ok(src.includes('findTmpTestCopies'), `${name} 必须告警 tmp/ 下的 *.test.mjs（findTmpTestCopies）`);
  }
});

// ---------------------------------------------------------------------------
// T225 · A4 p50 的**量级**判据（延迟是统计量，不能按绝对相等卡）
//   事故：台账 21.5ms vs 实测 14ms（容差 7ms）⇒ 假红。同一份代码两次跑差 5–10ms 是正常的。
// ---------------------------------------------------------------------------

test('台账守卫: A4 p50 用"量级"判据 —— 台账 ≤ max(实测×2, 实测+20ms)，且实测 ≤ 50ms', async () => {
  const { a4MagnitudeOk, A4_GATE_MS } = await import('../scripts/ledger-check.mjs');

  // 门槛与 metrics-guard 同源
  assert.equal(A4_GATE_MS, 50, 'A4 的真实门槛必须还是 50ms（不许为了变绿放宽）');

  // 事故现场：台账 21.5 / 实测 14 ⇒ 上限 max(28, 34) = 34 ⇒ 放行
  const incident = a4MagnitudeOk(21.5, 14);
  assert.equal(incident.ok, true, '今晚这条必须不再是红的');
  assert.equal(incident.limit, 34);

  // 台账明显陈旧（落后到量级不同）⇒ 仍然红
  const stale = a4MagnitudeOk(100, 14);
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /量级上限/);
  assert.equal(stale.gateFailed, false, '这是"台账陈旧"，不是"门槛不过"');

  // 实测真的变慢 ⇒ 门槛红（真实门槛不许松）
  const slow = a4MagnitudeOk(14, 60);
  assert.equal(slow.ok, false);
  assert.equal(slow.gateFailed, true);
  assert.match(slow.reason, /门槛 50ms/);

  // 极小时抖动被绝对下限兜住：实测 0.5ms 时上限是 20.5ms 而不是 1ms
  assert.equal(a4MagnitudeOk(5, 0.5).ok, true);
  assert.equal(a4MagnitudeOk(21, 0.5).ok, false, '超过绝对下限仍要红');

  // 缺数不判（交给 fullCheck 的"缺测点"兜底）
  assert.equal(a4MagnitudeOk(null, 14).ok, true);
  assert.equal(a4MagnitudeOk(21.5, null).ok, true);
  assert.equal(a4MagnitudeOk(Number.NaN, Number.NaN).ok, true);
});

test('台账守卫: compare() 里 A4 走量级判据、其它轴仍严格（回归）', async () => {
  const { compare } = await import('../scripts/ledger-check.mjs');
  const ledger = { version: '0.0.0', tests: null, claim: null, threads: null, episodes: null, a2: 22.28, a4: 21.5, stamp: null };
  const actual = { version: '0.0.0', tests: null, claim: null, threads: null, episodes: null, a2: 22.28, a4: 14 };
  const bad = compare(ledger, actual, { live: false, notes: [] });
  assert.deepEqual(bad.filter((x) => x.startsWith('A4')), [], 'A4 不再假红');
  // A2 仍是绝对判据（比率可复现）
  const badA2 = compare({ ...ledger, a2: 30 }, actual, { live: false, notes: [] });
  assert.ok(badA2.some((x) => x.startsWith('A2')), 'A2 必须仍然严格（比率可复现，不许跟着放松）');
});

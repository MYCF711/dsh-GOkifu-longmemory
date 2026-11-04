// T168 的 tombstone test：删掉 `scripts/release.mjs` 里的台账自愈（`syncLedgerTests` / `rewriteLedgerTests`）
// 或 CI 闸 ⇒ 本文件红。
//
// 覆盖（任务书 T168 验收）：
//   ① 数字不一致 ⇒ **只改那一行**，且产生**一个** commit（提交信息含新数字）
//   ② 数字一致 ⇒ **零 commit**（幂等，不产生空提交）
//   ③ CI 未成功 / 超时 ⇒ **不打 tag**（假 tag 函数断言未被调用），并给出手动继续指令
//   ④ 其它行逐字节不变（golden 比对：除测试行外原文与改写后完全一致）
//   ⑤ 自愈提交后 HEAD 变了 ⇒ 必须对**新 HEAD** 等 CI；`--dry-run` 只报告不写
//
// 全部副作用走注入的假 deps：不 push、不 tag、不建 Release、不碰真仓库。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  performRelease, syncLedgerTests, rewriteLedgerTests, buildTestLine, parseTestLine, collectTrackedTestCounts,
  formatStamp, sameCounts, waitForCi, LEDGER_TEST_LINE_RE,
} from '../scripts/release.mjs';

// 2026-11-05：台账用的是**本地时间**，CI 在 UTC 上跑，写死 +08:00 的时间戳会差 8 小时（红过）。
// 用「本地构造」代替固定 epoch —— 在任何时区下都得到 2026-11-05 05:20。
const NOW = new Date(2026, 10, 5, 5, 20, 0).getTime();

// 一段带测试行的台账（前后各有多行；用 \n 与一行 \r\n 混排，验证行尾不被改动）
const LEDGER_TEXT = [
  '# 维护台账',
  '',
  '| 项 | 值 |',
  '|---|---|',
  '| 版本 | 0.148.0 |',
  '| 测试 | **612 条**（608 pass / 0 fail / 4 skip）[本] 2026-11-05 05:18 |',
  '| 语料 | 602 局 |',
  '',
  '## 下一步',
  '- 继续',
  '',
].join('\n');

function counts(total, pass, fail = 0, skip = 0) {
  return { total, pass, fail, skip };
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('T168: 只改测试行 —— 其它行逐字节不变（golden）', () => {
  const before = LEDGER_TEXT;
  const out = rewriteLedgerTests(before, counts(613, 609, 0, 4), '2026-11-05 05:20');
  assert.equal(out.changed, true);
  assert.deepEqual(out.before, counts(612, 608, 0, 4));
  assert.deepEqual(out.after, counts(613, 609, 0, 4));

  const beforeLines = before.split('\n');
  const afterLines = out.text.split('\n');
  assert.equal(afterLines.length, beforeLines.length, '行数不变');

  const idx = beforeLines.findIndex((l) => LEDGER_TEST_LINE_RE.test(l));
  assert.equal(LEDGER_TEST_LINE_RE.test(afterLines[idx]), true, '替换后仍是合法测试行');
  assert.equal(afterLines[idx], '| 测试 | **613 条**（609 pass / 0 fail / 4 skip）[本] 2026-11-05 05:20 |');

  // 除这一行外，逐行逐字节相同
  const golden = beforeLines.map((line, i) => (i === idx ? '<TEST-LINE>' : line)).join('\n');
  const goldenAfter = afterLines.map((line, i) => (i === idx ? '<TEST-LINE>' : line)).join('\n');
  assert.equal(goldenAfter, golden, '其它行必须逐字节不变');
});

test('T168: 数字一致 ⇒ 不改（幂等、不空提交）', () => {
  const out = rewriteLedgerTests(LEDGER_TEXT, counts(612, 608, 0, 4), '2099-01-01 00:00');
  assert.equal(out.changed, false);
  assert.equal(out.text, LEDGER_TEXT, '连时间戳都不动（否则每次发版都会产生空提交）');
  assert.deepEqual(out.before, counts(612, 608, 0, 4));
});

test('T168: 行尾 CRLF 与其它行原样保留', () => {
  const crlf = LEDGER_TEXT.replace('\n', '\r\n').replace('\r\n# 维护台账', '\n# 维护台账');
  const mixed = LEDGER_TEXT.split('\n');
  mixed[5] = `${mixed[5]}\r`; // 测试行用 CRLF
  const text = mixed.join('\n');
  const out = rewriteLedgerTests(text, counts(700, 700, 0, 0), '2026-11-05 05:20');
  assert.equal(out.changed, true);
  const lines = out.text.split('\n');
  assert.ok(lines[5].endsWith('\r'), '原行是 CRLF ⇒ 替换后仍是 CRLF');
  assert.equal(lines[5].replace('\r', ''), '| 测试 | **700 条**（700 pass / 0 fail / 0 skip）[本] 2026-11-05 05:20 |');
  assert.equal(lines.slice(0, 5).join('\n'), text.split('\n').slice(0, 5).join('\n'));
  assert.ok(crlf.length > 0);
});

test('T168: 缺测试行 / 解析 / 时间戳格式', () => {
  const none = rewriteLedgerTests('# 空台账\n没有测试行\n', counts(1, 1), '2026-11-05 05:20');
  assert.equal(none.changed, false);
  assert.equal(none.error, 'ledger-test-line-missing');
  assert.equal(parseTestLine('| 测试 | **1 条**（1 pass / 0 fail / 0 skip）[本] 2026-11-05 05:20 |').total, 1);
  assert.equal(parseTestLine('| 别的 | 1 |'), null);
  assert.equal(formatStamp(NOW), '2026-11-05 05:20');
  assert.equal(buildTestLine(counts(9, 8, 1, 0), '2026-01-02 03:04'), '| 测试 | **9 条**（8 pass / 1 fail / 0 skip）[本] 2026-01-02 03:04 |');
  assert.equal(sameCounts(counts(1, 1), counts(1, 1)), true);
  assert.equal(sameCounts(counts(1, 1), counts(1, 1, 0, 1)), false);
});

// ---------------------------------------------------------------------------
// 台账自愈（注入 deps）
// ---------------------------------------------------------------------------

function makeDeps(over = {}) {
  const files = {
    'MAINTENANCE.md': LEDGER_TEXT,
    'package.json': JSON.stringify({ version: '0.148.0' }),
    'CHANGELOG.md': '## 0.148.0\n- 测试段落\n## 0.147.0\n- 旧的\n',
  };
  const state = { commits: [], writes: [], pushed: 0, tags: [], releases: [] };
  const deps = {
    out: (cmd) => {
      if (cmd === 'git rev-parse --abbrev-ref HEAD') return 'main';
      if (cmd === 'git status --porcelain') return '';
      if (cmd === 'git rev-parse HEAD') return state.commits.length ? 'newhead000' : 'oldhead000';
      if (cmd === 'git rev-parse origin/main') return 'oldhead000';
      if (cmd.startsWith('git tag -l ')) return '';
      return '';
    },
    run: (cmd) => {
      if (cmd.includes('node scripts/check.mjs')) return;
      return;
    },
    readText: (rel) => files[rel],
    writeText: (rel, text) => {
      files[rel] = text;
      state.writes.push(rel);
    },
    commit: (message) => {
      state.commits.push(message);
      return 'newhead000';
    },
    push: () => {
      state.pushed += 1;
      return { ok: true };
    },
    ghRuns: () => [{ conclusion: 'success', status: 'completed', workflowName: 'rules' }],
    sleep: async () => {},
    now: () => NOW,
    tag: (t) => state.tags.push(t),
    createRelease: (t) => {
      state.releases.push(t);
      return true;
    },
    writeFile: () => {},
    mkdtemp: () => 'C:\\tmp\\kifuin-rel-test',
    fileExists: () => true,
    collectCounts: () => counts(610, 606, 0, 4),  // 2026-11-05：默认走**变少**（610 < 612）—— 变多现在放行，不再触发自愈
    ...over,
  };
  return { deps, files, state };
}

test('T168 ①: 数字不一致 ⇒ 只改那一行 + 一个 commit（走完整发布流）', async () => {
  const { deps, files, state } = makeDeps();
  const result = await performRelease({ deps, now: NOW });
  assert.equal(result.code, 0, result.reason);
  assert.equal(state.commits.length, 1, '必须恰好一个 commit');
  assert.equal(state.commits[0], 'R00 ledger: 自动同步测试数 610/606/0/4');
  assert.deepEqual(state.writes, ['MAINTENANCE.md'], '只写 MAINTENANCE.md');
  const after = files['MAINTENANCE.md'].split('\n');
  const idx = after.findIndex((l) => LEDGER_TEST_LINE_RE.test(l));
  assert.equal(after[idx], '| 测试 | **610 条**（606 pass / 0 fail / 4 skip）[本] 2026-11-05 05:20 |');
  // golden：其它行逐字节不变
  const golden = LEDGER_TEXT.split('\n').map((l, i) => (i === idx ? '<T>' : l)).join('\n');
  assert.equal(after.map((l, i) => (i === idx ? '<T>' : l)).join('\n'), golden);
  assert.deepEqual(state.tags, ['v0.148.0'], 'CI 通过后正常打 tag');
});

test('T168 ②: 数字一致 ⇒ 零提交、零写入', async () => {
  const { deps, state } = makeDeps({ collectCounts: () => counts(612, 608, 0, 4) });
  const result = await performRelease({ deps, now: NOW });
  assert.equal(result.code, 0, result.reason);
  assert.equal(state.commits.length, 0, '不许产生空提交');
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.tags, ['v0.148.0']);
});

test('T168 ③: 新 HEAD 的 CI 未成功 ⇒ 不打 tag，并给手动指令', async () => {
  const { deps, state } = makeDeps({
    ghRuns: () => [{ conclusion: 'failure', status: 'completed', workflowName: 'rules' }],
  });
  const result = await performRelease({ deps, now: NOW });
  assert.equal(result.code, 1);
  assert.equal(result.reason, 'ci-ci-failure');
  assert.deepEqual(state.tags, [], 'CI 未成功时绝不能打 tag');
  assert.deepEqual(state.releases, []);
});

test('T168 ③c: 数字一致但 CI 未成功 ⇒ 也不打 tag（默认 fail-closed）', async () => {
  const { deps, state } = makeDeps({
    collectCounts: () => counts(612, 608, 0, 4),
    ghRuns: () => [{ conclusion: 'failure', status: 'completed', workflowName: 'rules' }],
  });
  const result = await performRelease({ deps, now: NOW });
  assert.equal(result.code, 1);
  assert.equal(result.reason, 'ci-not-success');
  assert.deepEqual(state.tags, [], '没有 CI success 就绝不打 tag');
});

test('T168 ③b: CI 一直查不到结论（超时）⇒ 不打 tag', async () => {
  let t = 0;
  const { deps, state } = makeDeps({
    ghRuns: () => [],
    now: () => {
      t += 60_000;
      return NOW + t;
    },
    sleep: async () => {},
  });
  const result = await performRelease({ deps, now: NOW, ciTimeoutMs: 120_000, ciIntervalMs: 1 });
  assert.equal(result.code, 1);
  assert.equal(result.reason, 'ci-timeout');
  assert.deepEqual(state.tags, []);
});

test('T172: 推不进 main ⇒ 自动推分支 + 开 PR（不自动合并、不打 tag）', async () => {
  const state = { prs: 0, branchPushes: 0 };
  const { deps, state: s } = makeDeps({ push: () => ({ ok: false, error: 'protected branch' }) });
  deps.pushBranch = () => { state.branchPushes += 1; return { ok: true }; };
  deps.findPr = () => [];
  deps.createPr = () => { state.prs += 1; return 'https://github.com/MYCF711/dsh-kifuin/pull/999'; };
  const result = await performRelease({ deps, now: NOW });
  assert.equal(result.code, 1);
  assert.equal(result.reason, 'pr-opened');
  assert.equal(state.branchPushes, 1, '必须把提交推到 ledger-sync');
  assert.equal(state.prs, 1, '必须开一个 PR');
  assert.equal(result.pr, 'https://github.com/MYCF711/dsh-kifuin/pull/999');
  assert.deepEqual(s.tags, [], '绝不自动打 tag');
});

test('T172: 已存在 open 的 ledger-sync PR ⇒ 复用，不重复开', async () => {
  const state = { prs: 0 };
  const { deps, state: s } = makeDeps({ push: () => ({ ok: false, error: 'protected branch' }) });
  deps.pushBranch = () => ({ ok: true });
  deps.findPr = () => [{ number: 42, url: 'https://github.com/MYCF711/dsh-kifuin/pull/42', state: 'OPEN' }];
  deps.createPr = () => { state.prs += 1; return 'https://example/new'; };
  const result = await performRelease({ deps, now: NOW });
  assert.equal(result.code, 1);
  assert.equal(result.reason, 'pr-exists');
  assert.equal(state.prs, 0, '有 open PR 就不许再开一个');
  assert.equal(result.pr, 'https://github.com/MYCF711/dsh-kifuin/pull/42');
  assert.deepEqual(s.tags, []);
});

test('T172: 分支也推不上去 ⇒ 打印手动路径、不打 tag', async () => {
  const { deps, state } = makeDeps({ push: () => ({ ok: false, error: 'protected branch' }) });
  deps.pushBranch = () => ({ ok: false, error: 'rejected' });
  const result = await performRelease({ deps, now: NOW });
  assert.equal(result.code, 1);
  assert.equal(result.reason, 'push-failed');
  assert.deepEqual(state.tags, []);
});

test('T168 ⑤: --dry-run 只报告、不写不提交', async () => {
  const { deps, state, files } = makeDeps();
  const result = await performRelease({ deps, now: NOW, dryRun: true });
  assert.equal(result.code, 0);
  assert.equal(result.reason, 'dry-run');
  assert.equal(state.commits.length, 0);
  assert.deepEqual(state.writes, []);
  assert.equal(files['MAINTENANCE.md'], LEDGER_TEXT, 'dry-run 不改文件');
  assert.deepEqual(state.tags, [], 'dry-run 不打 tag');
});

test('T168: 台账缺测试行 ⇒ 拒绝自愈并中止（不打 tag）', async () => {
  const { deps, state } = makeDeps({ readText: (rel) => (rel === 'MAINTENANCE.md' ? '# 台账\n没有测试行\n' : (rel === 'package.json' ? JSON.stringify({ version: '0.148.0' }) : '## 0.148.0\n')) });
  const result = await performRelease({ deps, now: NOW });
  assert.equal(result.code, 1);
  assert.match(result.reason, /ledger-test-line-missing/);
  assert.deepEqual(state.tags, []);
});

test('T168: waitForCi —— success / failure / timeout 三态', async () => {
  const ok = await waitForCi({
    commit: 'x',
    deps: { ghRuns: () => [{ conclusion: 'success', status: 'completed', workflowName: 'rules' }], now: () => 0, sleep: async () => {} },
  });
  assert.equal(ok.ok, true);

  const bad = await waitForCi({
    commit: 'x',
    deps: { ghRuns: () => [{ conclusion: 'failure', status: 'completed', workflowName: 'rules' }], now: () => 0, sleep: async () => {} },
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'ci-failure');

  let t = 0;
  const timeout = await waitForCi({
    commit: 'x',
    timeoutMs: 10,
    intervalMs: 1,
    deps: { ghRuns: () => [{ conclusion: null, status: 'in_progress', workflowName: 'rules' }], now: () => { t += 5; return t; }, sleep: async () => {} },
  });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.reason, 'timeout');
});

test('T168: 真 MAINTENANCE.md 的测试行能被精确匹配（只改那一行）', () => {
  const real = readFileSync(new URL('../MAINTENANCE.md', import.meta.url), 'utf8');
  const lines = real.split('\n');
  const idx = lines.findIndex((l) => LEDGER_TEST_LINE_RE.test(l));
  assert.ok(idx >= 0, '真台账里必须能找到测试行');
  const parsed = parseTestLine(lines[idx]);
  assert.ok(parsed && parsed.total > 0, `解析不出计数：${lines[idx]}`);

  const unchanged = rewriteLedgerTests(real, parsed, '2099-01-01 00:00');
  assert.equal(unchanged.changed, false, '数字一致时连时间戳都不动');

  const bumped = rewriteLedgerTests(real, { ...parsed, total: parsed.total + 1, pass: parsed.pass + 1 }, '2099-01-01 00:00');
  assert.equal(bumped.changed, true);
  const after = bumped.text.split('\n');
  assert.equal(after.length, lines.length);
  for (let i = 0; i < lines.length; i += 1) {
    if (i === idx) continue;
    assert.equal(after[i], lines[i], `第 ${i + 1} 行被改了`);
  }
});

test('T168: collectTrackedTestCounts —— 只数 HEAD 已跟踪的测试文件（临时 git 仓库实证）', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'kifuin-tracked-'));
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 't']);
  mkdirSync(path.join(repo, 'test'), { recursive: true });
  const trackedSrc = ["import test from 'node:test';", "import assert from 'node:assert/strict';", "test('a', () => assert.ok(true));", ''].join(String.fromCharCode(10));
  const untrackedSrc = ["import test from 'node:test';", "test('b', () => {});", "test('c', () => {});", ''].join(String.fromCharCode(10));
  writeFileSync(path.join(repo, 'test', 'a.test.mjs'), trackedSrc);
  writeFileSync(path.join(repo, 'test', 'untracked.test.mjs'), untrackedSrc);
  git(['add', 'test/a.test.mjs']);
  git(['commit', '-q', '-m', 'init']);

  // 嵌套 node --test 会被 test runner 的递归保护跳过（输出里没有计数行），
  // 所以这里只**假执行**子进程，真跑 `git ls-tree` —— 断言"只把已跟踪文件交给 node --test"。
  const seen = [];
  const fakeExec = (file, args) => {
    seen.push(args);
    return ['✔ a (0.5ms)', 'ℹ tests 1', 'ℹ pass 1', 'ℹ fail 0', 'ℹ skipped 0', ''].join(String.fromCharCode(10));
  };
  const counts = collectTrackedTestCounts({ repoRoot: repo, execFile: fakeExec });
  assert.deepEqual(seen[0], ['--test', 'test/a.test.mjs'], '只把 HEAD 已跟踪的测试文件交给 node --test（未跟踪的那个不传）');
  assert.equal(counts.files, 1, '只数已跟踪的 1 个文件');
  assert.equal(counts.total, 1);
  assert.equal(counts.pass, 1);
  assert.equal(counts.fail, 0);
  assert.equal(counts.skip, 0);
});

test('T168: syncLedgerTests 的 dryRun 分支不写盘', async () => {
  const { deps, state } = makeDeps();
  const out = await syncLedgerTests({ repoRoot: 'X', now: NOW, dryRun: true, deps });
  assert.equal(out.changed, true);
  assert.equal(out.committed, false);
  assert.equal(out.commit, null);
  assert.equal(state.commits.length, 0);
  assert.deepEqual(state.writes, []);
});


test('T172 配套: 实测 > 台账 ⇒ 放行、不提交、不改台账（新加测试是正常进展）', async () => {
  const { deps, state } = makeDeps({ collectCounts: () => counts(700, 696, 0, 4) });
  const result = await performRelease({ deps, now: NOW });
  assert.equal(result.code, 0, `不该失败：${result.reason}`);
  assert.equal(state.commits.length, 0, '变大时不许产生提交');
  assert.equal(state.writes.length, 0, '变大时不许改台账');
});

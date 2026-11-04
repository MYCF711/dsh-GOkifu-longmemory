#!/usr/bin/env node
// 受控发布：只发 GitHub Release + annotated tag，不发 npm。
// 用法：node scripts/release.mjs [--dry-run] [--require-ci]
//
// 2026-11-05（T168）：tag 之前加一步「台账自愈」——MAINTENANCE.md 里的
// `| 测试 | **N 条**（P pass / F fail / S skip）[本] YYYY-MM-DD HH:mm |` 若与实测不一致，
// 就地改这一行并自动提交（`R00 ledger: 自动同步测试数 N/P/F/S`），再对**新 HEAD** 等 CI。
// 目的：别再靠人肉改数字 → 开 PR → 合并 → 发版白烧一轮。
// 硬边界：
//   · 只改那一行（整行正则），文件其它字节不动；数字一致时**不产生空提交**；
//   · 提交后 HEAD 变了 ⇒ 必须推上去并等到**新 HEAD 的 CI = success**；拿不到结论就打住，
//     打印手动继续的指令，**绝不对未验证的提交打 tag**；
//   · 不改 ledger-check 的其它判据（六轴/语料变少/版本号照旧全跑）。

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseTestCounts } from './ledger-parse.mjs';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUSH_LEDGER = process.argv.includes('--push-ledger');

/** 台账里那条测试行的整行正则（`| 测试 | **N 条**（P pass / F fail / S skip）[本] 时间 |`）。 */
export const LEDGER_TEST_LINE_RE = /^\|\s*测试\s*\|\s*\*\*(\d+)\s*条\*\*（(\d+)\s*pass\s*\/\s*(\d+)\s*fail\s*\/\s*(\d+)\s*skip）\[本\]\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*\|\s*$/;

/** 本地时间戳（台账用本地时间，不用 UTC）。 */
export function formatStamp(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 生成台账测试行（与 MAINTENANCE.md 现有格式逐字符对齐）。 */
export function buildTestLine(counts, stamp) {
  return `| 测试 | **${counts.total} 条**（${counts.pass} pass / ${counts.fail} fail / ${counts.skip} skip）[本] ${stamp} |`;
}

/** 从一行里解析出四元组；不是测试行返回 null。 */
export function parseTestLine(line) {
  const m = LEDGER_TEST_LINE_RE.exec(String(line ?? ''));
  if (!m) return null;
  return { total: Number(m[1]), pass: Number(m[2]), fail: Number(m[3]), skip: Number(m[4]) };
}

export function sameCounts(a, b) {
  if (!a || !b) return false;
  return a.total === b.total && a.pass === b.pass && a.fail === b.fail && a.skip === b.skip;
}

/**
 * 只替换台账里那一条测试行；其余行逐字节保留（含行尾 CRLF）。
 * @param {string} text
 * @param {{total:number,pass:number,fail:number,skip:number}} counts
 * @param {string} stamp `YYYY-MM-DD HH:mm`
 */
export function rewriteLedgerTests(text, counts, stamp) {
  const raw = String(text ?? '');
  const lines = raw.split('\n');
  let index = -1;
  let before = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    const parsed = parseTestLine(line);
    if (parsed) {
      index = i;
      before = parsed;
      break;
    }
  }
  if (index < 0) return { changed: false, text: raw, before: null, after: null, error: 'ledger-test-line-missing' };
  if (sameCounts(before, counts)) return { changed: false, text: raw, before, after: before };
  const cr = lines[index].endsWith('\r') ? '\r' : '';
  lines[index] = `${buildTestLine(counts, stamp)}${cr}`;
  return { changed: true, text: lines.join('\n'), before, after: { ...counts } };
}

// ---------------------------------------------------------------------------
// 实测测试数（与 ledger-check 同口径：只测 HEAD 里已跟踪的 test/**/*.test.mjs）
// ---------------------------------------------------------------------------

/**
 * 为什么不直接复用 ledger-check 的导出：它只导出 `parseLedger` / `compare` / `fullCheck`，
 * 数测试那段是 CLI 里的**内联代码**（`git ls-tree -r --name-only HEAD test/` → `node --test <files>`
 * → 解析 `ℹ tests/pass/fail/skipped`），没有导出函数。所以这里照抄同一口径复算一遍；
 * 计数解析复用 `scripts/ledger-parse.mjs` 的 `parseTestCounts`（与 ledger-check 的兜底分支同一个）。
 */
export function collectTrackedTestCounts({ repoRoot = REPO_ROOT, execFile = null } = {}) {
  const run = execFile ?? ((file, args) => execFileSync(file, args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const tracked = execSync('git ls-tree -r --name-only HEAD test/', { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((file) => file.endsWith('.test.mjs'));
  if (tracked.length === 0) throw new Error('HEAD 里没有已跟踪的 test/**/*.test.mjs（拒绝在无测试的情况下同步台账）');
  try {
    const stdout = run(process.execPath, ['--test', ...tracked]);
    const parsed = parseTestCounts(String(stdout ?? ''));
    if (!parsed) throw new Error('测试计数解析失败（fail-closed）');
    return { ...parsed, files: tracked.length };
  } catch (error) {
    // 有红用例时 execFile 会抛错，但 stdout 里仍有计数 —— 与 ledger-check 同一处理
    const parsed = parseTestCounts(String(error?.stdout ?? ''));
    if (!parsed) throw error;
    return { ...parsed, files: tracked.length, failed: true };
  }
}

// ---------------------------------------------------------------------------
// 台账自愈
// ---------------------------------------------------------------------------

export async function syncLedgerTests(opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const dryRun = Boolean(opts.dryRun);
  const deps = opts.deps ?? {};
  const readText = deps.readText ?? ((rel) => readFileSync(join(repoRoot, rel), 'utf8'));
  const writeText = deps.writeText ?? ((rel, text) => writeFileSync(join(repoRoot, rel), text));
  const commit = deps.commit ?? ((message) => {
    execSync('git add MAINTENANCE.md', { cwd: repoRoot });
    execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: repoRoot, stdio: 'inherit' });
    return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
  });

  const counts = (deps.collectCounts ?? (() => collectTrackedTestCounts({ repoRoot, execFile: deps.execFile ?? null })))();
  const text = readText('MAINTENANCE.md');
  const result = rewriteLedgerTests(text, counts, formatStamp(now));
  if (result.error) return { changed: false, committed: false, counts, before: null, after: null, commit: null, error: result.error };
  // 2026-11-05（T172 配套）：**测试变多不拦发布**。台账是快照，实测更大是正常进展（ledger-check 已按单向判放行），
  // 这里就不必"提交→开 PR→再发版"折腾一轮；只有**变少**才继续走自愈（那才是要查的信号）。
  if (result.changed && result.before && Number.isFinite(result.before.total) && counts.total > result.before.total) {
    return { changed: false, committed: false, counts, before: result.before, after: result.before, commit: null, growthAllowed: true };
  }
  if (!result.changed) return { changed: false, committed: false, counts, before: result.before, after: result.before, commit: null };
  if (dryRun) return { changed: true, committed: false, counts, before: result.before, after: result.after, commit: null };

  writeText('MAINTENANCE.md', result.text);
  const message = `R00 ledger: 自动同步测试数 ${counts.total}/${counts.pass}/${counts.fail}/${counts.skip}`;
  const sha = commit(message);
  return { changed: true, committed: true, counts, before: result.before, after: result.after, commit: sha ?? null, message };
}

// ---------------------------------------------------------------------------
// CI 等待（对**新 HEAD**）
// ---------------------------------------------------------------------------

/**
 * 轮询 gh run list，直到该提交的 CI 有明确结论（success / 其它结论 / 超时）。
 * 拿不到结论绝不能放行打 tag。
 */
export async function waitForCi({ commit, deps = {}, timeoutMs = 20 * 60 * 1000, intervalMs = 20 * 1000 } = {}) {
  const ghRuns = deps.ghRuns ?? ((sha) => {
    const raw = execSync(`gh run list --commit ${sha} --limit 1 --json conclusion,status,workflowName`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(raw);
  });
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const started = now();
  let last = null;
  for (;;) {
    let runs = [];
    try {
      runs = ghRuns(commit);
    } catch {
      runs = [];
    }
    const latest = Array.isArray(runs) ? runs[0] : (runs ?? null);
    if (latest) last = latest;
    if (latest && latest.conclusion === 'success') return { ok: true, reason: 'success', run: latest, waitedMs: now() - started };
    if (latest && latest.status === 'completed' && latest.conclusion !== 'success') {
      return { ok: false, reason: `ci-${latest.conclusion ?? 'unknown'}`, run: latest, waitedMs: now() - started };
    }
    if (now() - started >= timeoutMs) return { ok: false, reason: 'timeout', run: last, waitedMs: now() - started };
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// 发布主流程（全部副作用走 deps，便于测试；CLI 用 realDeps()）
// ---------------------------------------------------------------------------

export function realDeps() {
  return {
    out: (cmd, opts) => execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8', ...opts }).trim(),
    run: (cmd, opts) => execSync(cmd, { cwd: REPO_ROOT, stdio: 'inherit', ...opts }),
    readText: (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8'),
    writeText: (rel, text) => writeFileSync(join(REPO_ROOT, rel), text),
    commit: (message) => {
      execSync('git add MAINTENANCE.md', { cwd: REPO_ROOT });
      execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: REPO_ROOT, stdio: 'inherit' });
      return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    },
    push: () => {
      // 2026-11-05（AGENTS §10「禁止直推 main」）：默认**不**直推 main —— main 有 ruleset，直推本来就会被拒。
      // 只有显式 `--push-ledger` 才尝试；否则直接返回 ok:false，由上层打印 PR 路径（fail-closed，不偷偷绕规则）。
      if (!PUSH_LEDGER) {
        return { ok: false, error: 'ledger-push-disabled（默认不直推 main；要自动推请加 --push-ledger）' };
      }
      try {
        execSync('git push origin HEAD:main', { cwd: REPO_ROOT, stdio: 'inherit' });
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: String(error?.stderr ?? error?.message ?? error).split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 240),
        };
      }
    },
    pushBranch: () => {
      try {
        execSync('git push origin HEAD:refs/heads/ledger-sync', { cwd: REPO_ROOT, stdio: 'inherit' });
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: String(error?.stderr ?? error?.message ?? error).split(String.fromCharCode(10)).filter(Boolean).slice(-2).join(' | ').slice(0, 240),
        };
      }
    },
    findPr: () => JSON.parse(execSync('gh pr list --head ledger-sync --state all --json number,url,state', { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })),
    createPr: () => String(execSync('gh pr create --fill --base main --head ledger-sync', { cwd: REPO_ROOT, encoding: 'utf8' })).trim().split(String.fromCharCode(10)).filter(Boolean).pop() ?? null,
    ghRuns: (sha) => JSON.parse(execSync(`gh run list --commit ${sha} --limit 1 --json conclusion,status,workflowName`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    tag: (t) => {
      execSync(`git tag -a ${t} -m ${t}`, { cwd: REPO_ROOT, stdio: 'inherit' });
      execSync(`git push origin ${t}`, { cwd: REPO_ROOT, stdio: 'inherit' });
    },
    createRelease: (t, notesPath) => {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        try {
          execSync(`gh release create ${t} --title ${t} --notes-file "${notesPath}"`, { cwd: REPO_ROOT, stdio: 'inherit' });
          return true;
        } catch (error) {
          const msg = String(error?.stderr ?? error?.message ?? error).split('\n').filter(Boolean).slice(0, 2).join(' | ');
          console.error(`release: 第 ${attempt} 次创建 Release 失败：${msg.slice(0, 240)}`);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000 * attempt);
        }
      }
      return false;
    },
    writeFile: (file, text) => writeFileSync(file, text),
    mkdtemp: () => mkdtempSync(join(tmpdir(), 'kifuin-rel-')),
    fileExists: (file) => existsSync(file),
  };
}

export async function performRelease(opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const requireCi = Boolean(opts.requireCi);
  const deps = { ...realDeps(), ...(opts.deps ?? {}) };
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const fail = (reason, message) => {
    if (message) console.error(message);
    return { code: 1, reason };
  };

  const pkg = JSON.parse(deps.readText('package.json'));
  const tag = `v${pkg.version}`;

  const branch = deps.out('git rev-parse --abbrev-ref HEAD');
  if (branch !== 'main') return fail('not-main', `release: 必须在 main 上（当前 ${branch}）`);

  // 2026-11-04（0.143.x）：只看**已跟踪文件**的改动。未跟踪文件是并行队友正在写的 WIP，
  // 它们进不了本次 commit、也进不了 tag 指向的树 —— 用它挡发布属于误伤（今晚真被挡了一次）。
  const statusLines = deps.out('git status --porcelain').split('\n').filter(Boolean);
  const dirty = statusLines.filter((l) => !l.startsWith('??'));
  if (dirty.length) return fail('dirty-tree', `release: 工作树不干净（已跟踪文件有改动）：${dirty.join(' | ')}`);
  const untracked = statusLines.filter((l) => l.startsWith('??'));
  if (untracked.length) console.log(`release: 注意 —— 有 ${untracked.length} 个未跟踪文件（队友 WIP），不计入本次发布`);

  deps.run('git fetch origin main');
  if (deps.out('git rev-parse HEAD') !== deps.out('git rev-parse origin/main')) {
    return fail('head-not-origin', 'release: HEAD 与 origin/main 不一致');
  }
  deps.run('node scripts/check.mjs');

  // ── 台账自愈（T168）：tag 之前，把测试数字改到与实测一致 ──────────────────
  const ledger = await syncLedgerTests({ repoRoot: REPO_ROOT, now, dryRun, deps });
  if (ledger.error) {
    return fail(`ledger-${ledger.error}`, `release: 台账里找不到测试行（${ledger.error}），无法自愈；请手工检查 MAINTENANCE.md`);
  }
  if (ledger.changed) {
    const from = ledger.before ? `${ledger.before.total}/${ledger.before.pass}/${ledger.before.fail}/${ledger.before.skip}` : 'n/a';
    const to = `${ledger.counts.total}/${ledger.counts.pass}/${ledger.counts.fail}/${ledger.counts.skip}`;
    console.log(`release: 台账测试数不一致（台账 ${from} → 实测 ${to}）`);
    if (dryRun) {
      console.log(`[dry-run] 会改 MAINTENANCE.md 的测试行并提交：R00 ledger: 自动同步测试数 ${to}`);
    } else {
      console.log(`release: 已提交台账自愈：${ledger.message}`);
      const pushed = deps.push();
      if (!pushed.ok) {
        // T172：main 有 ruleset（必须 PR）⇒ 推不进去是**常态**，不是失败。
        // 自动把提交推到 `ledger-sync` 分支并开 PR；已有同分支的 open PR 就复用（不重复开）。
        // **仍然不自动合并**（不绕 main 的保护）：合并由人点，然后重跑 release。
        console.error(`release: 台账提交推不进 main（${pushed.error ? String(pushed.error).slice(0, 120) : '分支保护'}），改走 PR：`);
        const branch = deps.pushBranch ? deps.pushBranch() : { ok: false, error: 'no pushBranch' };
        if (!branch.ok) {
          console.error('release: `ledger-sync` 分支也推不上去，手动继续：');
          console.error('  1) git push origin HEAD:refs/heads/ledger-sync && gh pr create --fill --base main --head ledger-sync');
          console.error(`  2) 合并后重跑 node scripts/release.mjs${requireCi ? ' --require-ci' : ''}`);
          return { code: 1, reason: 'push-failed', tag };
        }
        let existing = [];
        try {
          existing = (deps.findPr ? deps.findPr() : []).filter((pr) => String(pr?.state ?? '').toUpperCase() === 'OPEN');
        } catch {
          existing = [];
        }
        if (existing.length) {
          console.log(`release: 复用已存在的 PR #${existing[0].number} ${existing[0].url ?? ''}（不重复开）`);
          console.error(`release: 合并 PR #${existing[0].number} 后重跑 node scripts/release.mjs${requireCi ? ' --require-ci' : ''}（台账已同步，不会再提交）`);
          return { code: 1, reason: 'pr-exists', tag, pr: existing[0].url ?? null };
        }
        let url = null;
        try {
          url = deps.createPr ? deps.createPr() : null;
        } catch (error) {
          console.error(`release: 开 PR 失败（${String(error?.message ?? error).slice(0, 160)}）。手动继续：`);
          console.error('  1) gh pr create --fill --base main --head ledger-sync');
          console.error(`  2) 合并后重跑 node scripts/release.mjs${requireCi ? ' --require-ci' : ''}`);
          return { code: 1, reason: 'push-failed', tag };
        }
        if (url) console.log(`release: 已开 PR ${url}`);
        console.error(`release: 合并后重跑 node scripts/release.mjs${requireCi ? ' --require-ci' : ''}（台账已同步，不会再提交）`);
        return { code: 1, reason: 'pr-opened', tag, pr: url };
      }
      const head = deps.out('git rev-parse HEAD');
      console.log(`release: 已推送台账提交 ${head.slice(0, 8)}，等待它的 CI …`);
      const ci = await waitForCi({ commit: head, deps, timeoutMs: opts.ciTimeoutMs, intervalMs: opts.ciIntervalMs });
      if (!ci.ok) {
        console.error(`release: 新 HEAD 的 CI 未成功（${ci.reason}${ci.run ? `，${ci.run.workflowName ?? ''} ${ci.run.conclusion ?? ci.run.status ?? ''}` : ''}），**不打 tag**。`);
        console.error(`  查状态：gh run list --commit ${head} --limit 3`);
        console.error(`  通过后重跑：node scripts/release.mjs${requireCi ? ' --require-ci' : ''}（台账已同步，不会再提交）`);
        return { code: 1, reason: `ci-${ci.reason}`, tag, ledger };
      }
      console.log(`release: 新 HEAD 的 CI 通过（${ci.run?.workflowName ?? 'CI'}，等了 ${Math.round(ci.waitedMs / 1000)}s）`);
    }
  } else {
    console.log('release: 台账测试数与实测一致（无提交）');
  }

  // T168 硬要求：**打 tag 前 HEAD 的 CI 结论文本必须是 success**；拿不到结论就不打 tag。
  // （自愈提交之后 HEAD 已换成新提交，这一步查的就是**新 HEAD**。）
  // `--require-ci` 保留为兼容参数：现在默认就是 fail-closed，不再有"只告警"的分支。
  try {
    const headSha = deps.out('git rev-parse HEAD');
    const runs = deps.ghRuns(headSha);
    const latest = Array.isArray(runs) ? runs[0] : null;
    if (!latest) {
      console.error('release: 该提交没有 CI 运行记录 —— **不打 tag**。');
      console.error(`  查状态：gh run list --commit ${headSha} --limit 3`);
      return fail('ci-missing');
    }
    if (latest.conclusion !== 'success') {
      console.error(`release: CI 结论是 ${latest.conclusion ?? latest.status}（${latest.workflowName}）—— **不打 tag**。`);
      console.error(`  查状态：gh run list --commit ${headSha} --limit 3`);
      return fail('ci-not-success');
    }
    console.log(`release: CI 通过（${latest.workflowName}）${requireCi ? '' : ''}`);
  } catch (error) {
    console.error(`release: 无法查询 CI（${String(error?.message ?? error).slice(0, 120)}）—— **不打 tag**。`);
    return fail('ci-query-failed');
  }
  if (deps.out(`git tag -l ${tag}`)) return fail('tag-exists', `release: tag ${tag} 已存在`);

  // 台账自证（2026-11-02 audit-02 教训）：发版前必须证明 MAINTENANCE 的数字能复现。
  try {
    deps.out('node scripts/ledger-check.mjs --full');
  } catch {
    return fail('ledger-check', 'release: ledger-check --full 失败（台账与实测不一致或时点过旧）。先跑 node scripts/ledger-sync.mjs 再发版。');
  }

  // tag 审计（2026-11-04 教训，0.118.0）：`v0.116.0` 曾指到 PR 前的分支提交 —— 那个提交的内容已是 0.117.0。
  try {
    deps.out('node scripts/tag-audit.mjs --quiet');
  } catch {
    return fail('tag-audit', 'release: tag 审计未通过（有 tag 与内容版本错位）。先跑 node scripts/tag-audit.mjs 看明细，修好再发版。');
  }

  // 从 CHANGELOG 抽出当前版本段落作为 release notes
  const lines = deps.readText('CHANGELOG.md').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## ${pkg.version}`));
  if (start < 0) return fail('changelog-missing', `release: CHANGELOG 缺 ${pkg.version} 段`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) if (lines[i].startsWith('## ')) { end = i; break; }
  const dir = deps.mkdtemp();
  const notesPath = join(dir, 'notes.md');
  deps.writeFile(notesPath, lines.slice(start, end).join('\n'));

  if (dryRun) {
    console.log(`[dry-run] git tag -a ${tag} -m ${tag}`);
    console.log(`[dry-run] git push origin ${tag}`);
    console.log(`[dry-run] gh release create ${tag} --title ${tag} --notes-file ${notesPath}`);
    return { code: 0, reason: 'dry-run', tag, ledger };
  }

  deps.tag(tag);
  if (!deps.createRelease(tag, notesPath)) {
    console.error(`release: tag ${tag} 已推出，但 GitHub Release 未能创建（API 持续故障）。恢复后运行：`);
    console.error(`  gh release create ${tag} --title ${tag} --notes-file "${notesPath}"`);
    return { code: 0, reason: 'release-failed-but-tagged', tag };
  }
  console.log(`released ${tag} (no npm publish)`);
  return { code: 0, reason: 'released', tag, ledger };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const requireCi = argv.includes('--require-ci');
  const result = await performRelease({ dryRun, requireCi });
  return result.code;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invoked) {
  const code = await main();
  process.exitCode = code;
}

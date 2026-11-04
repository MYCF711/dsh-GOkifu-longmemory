#!/usr/bin/env node
// 可交付性闸（2026-11-04）：**只导出 tracked 文件**，在干净目录里跑 check + 单测。
//
// 为什么需要它：`check` / `node --test` 在我们自己的工作区里跑，永远能看到未跟踪的临时件与本地状态；
// 而"可交付"的定义是**别人拿到这个仓库能不能跑**。所以这里用 `git archive HEAD` 导出（不是 clone，
// clone 会带上工作区没提交的东西吗？不会 —— 但 archive 更严格：它只给 tracked 内容，未跟踪的文件一个都不带）。
//
// 判据：导出目录里 `node scripts/check.mjs` 退出 0 且 `node --test` 全绿（fail 0）。
// 用法：node scripts/deliverability.mjs [--keep] [--json]
// 退出码：0 可交付；1 不可交付（缺文件/测试红）；2 环境不齐（不是 git 仓库）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/** 解析 `node --test` 的输出（与 ledger-check 同一套口径）。 */
export function parseTestSummary(text) {
  const m = /ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)[\s\S]*?ℹ skipped (\d+)/.exec(String(text ?? ''));
  if (!m) return null;
  return { total: Number(m[1]), pass: Number(m[2]), fail: Number(m[3]), skip: Number(m[4]) };
}

/** 判定：check 退出 0 且单测 fail=0 且至少跑了 1 条。 */
export function judgeDeliverable({ checkCode, checkOut, testSummary }) {
  const bad = [];
  if (checkCode !== 0) bad.push(`check 退出码 ${checkCode}（输出尾部：${String(checkOut ?? '').trim().slice(-200)}）`);
  if (!testSummary) bad.push('单测没跑出汇总（输出里没有 ℹ tests …）');
  else {
    if (testSummary.fail !== 0) bad.push(`单测有 ${testSummary.fail} 条失败`);
    if (testSummary.total < 1) bad.push('单测 0 条（等于没测）');
  }
  return { ok: bad.length === 0, bad };
}

export function exportTracked({ repo = REPO, dest } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  // git archive 只导出 HEAD 的 tracked 内容 —— 未跟踪文件一个都不带，这正是"可交付"该看的
  execSync(`git archive HEAD | tar -x -C "${dest.replace(/\\/g, '/')}"`, { cwd: repo, stdio: 'pipe' });
  return dest;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invoked) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const keep = argv.includes('--keep');
  let headSha;
  try { headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(); } catch {
    console.error('deliverability: 这里不是 git 仓库（或没有 HEAD）');
    process.exit(2);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kifuin-deliver-'));
  let checkCode = 0;
  let checkOut = '';
  let testOut = '';
  try {
    exportTracked({ dest: dir });
    const files = fs.readdirSync(dir);
    if (!files.includes('package.json')) { console.error('deliverability: 导出目录里没有 package.json'); process.exit(1); }
    try {
      checkOut = execFileSync(process.execPath, [path.join(dir, 'scripts', 'check.mjs')], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      checkCode = 0;
    } catch (error) {
      checkCode = typeof error?.status === 'number' ? error.status : 1;
      checkOut = `${error?.stdout ?? ''}${error?.stderr ?? ''}`;
    }
    try {
      testOut = execFileSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      testOut = `${error?.stdout ?? ''}${error?.stderr ?? ''}`;
    }
    const verdict = judgeDeliverable({ checkCode, checkOut, testSummary: parseTestSummary(testOut) });
    const out = { at: new Date().toISOString(), head: headSha, files: files.length, checkCode, tests: parseTestSummary(testOut), ...verdict };
    if (json) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`可交付性闸 · HEAD ${headSha.slice(0, 8)} · 导出 ${files.length} 个顶层条目（只含 tracked 内容）`);
      console.log(`check：${checkCode === 0 ? 'PASS' : `FAIL（exit ${checkCode}）`} · 单测：${out.tests ? `${out.tests.total} 条 / pass ${out.tests.pass} / fail ${out.tests.fail}` : 'n/a'}`);
      for (const b of verdict.bad) console.error(`ERR ${b}`);
      console.log(verdict.ok ? 'deliverability: PASS（别人拿到这个仓库能跑）' : 'deliverability: FAIL');
    }
    if (keep) console.log(`（导出目录保留：${dir}）`);
    process.exit(verdict.ok ? 0 : 1);
  } finally {
    if (!keep) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } }
  }
}

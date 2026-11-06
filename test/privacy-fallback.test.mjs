// 脱敏扫描的无 git 回退（0.128.0）：导出的 tarball 里没有 .git，扫描不能因此跑不起来。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFilesToScan, scanPrivacy } from '../scripts/privacy-scan.mjs';

const B = String.fromCharCode(92);

// 正常全量测试中也模拟一次 pre-push：生产扫描必须尊重显式 cwd，测试后恢复原环境。
function polluteWithOuterGitRepository(t) {
  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  process.env.GIT_DIR = gitDir;
  process.env.GIT_WORK_TREE = repoRoot;
  process.env.GIT_INDEX_FILE = path.join(gitDir, 'index');
  t.after(() => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

test('privacy: 没有 .git 时退化成目录遍历（不抛），并跳过 node_modules/tmp 与二进制', (t) => {
  polluteWithOuterGitRepository(t);
  const dir = mkdtempSync(path.join(tmpdir(), 'kifuin-privacy-'));
  try {
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    mkdirSync(path.join(dir, 'tmp'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'a.mjs'), 'export const ok = 1;' + B + 'n');
    writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), 'module.exports = 1;' + B + 'n');
    writeFileSync(path.join(dir, 'tmp', 'scratch.txt'), 'tmp' + B + 'n');
    writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const files = listFilesToScan({ cwd: dir });
    assert.deepEqual(files, ['src/a.mjs'], `只该扫到源码：${files.join(',')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('privacy: 回退模式下仍能抓到内网 IP / 用户目录 / 真实会话 UUID', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kifuin-privacy2-'));
  try {
    // 造样例时也不写死字面量：脱敏扫描会扫**测试文件自己**（第一版就是栽在这，scan 报 2 处）
    const ip = [192, 168, 1, 5].join('.');
    const uuid = ['session', '1a2b3c4d', '1111', '2222', '3333', '444455556666'].join('-');
    const leak = [
      `host: ${ip}`,
      `path: C:${B}Users${B}alice${B}secret.txt`,
      uuid,
    ].join(B + 'n');
    writeFileSync(path.join(dir, 'leak.md'), leak);
    const findings = scanPrivacy({ cwd: dir });
    const rules = findings.map((f) => f.rule);
    assert.ok(rules.includes('private-ip'), `要抓到内网 IP：${rules.join(',')}`);
    assert.ok(rules.includes('user-home'), `要抓到本机用户目录：${rules.join(',')}`);
    assert.ok(rules.includes('session-uuid'), `要抓到真实会话 UUID：${rules.join(',')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

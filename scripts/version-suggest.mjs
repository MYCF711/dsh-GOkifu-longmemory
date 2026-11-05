#!/usr/bin/env node
// T229 · 版本号建议：按「改了什么」给 patch / minor / major，而不是每轮 +1 minor。
//
// 背景（主人 2026-11-05 纠正）：一天发了 20 个 tag（v0.158.0 → v0.178.0），几乎全是 minor ——
// 但其中大部分只是补测试、补文档、修口径。semver 里「只改了一点点」应该是 patch（0.158.0 → 0.158.1）。
//
// 判据（机械可核，看 `git diff --name-only <上个 tag>..HEAD`）：
//   major  破坏既有契约（字段改名/删除、错误语义变更）—— 1.0 前用 minor 并在 CHANGELOG 段首标「破坏性」
//   minor  改 src/** 或 scripts/** 的**行为**（新增能力、收紧/放宽判据、改输出）
//   patch  只动 test/** docs/** evidence/** reports/**，或 CHANGELOG / 台账措辞
//
// 用法：
//   node scripts/version-suggest.mjs            # 相对最近 tag 给建议
//   node scripts/version-suggest.mjs --base v0.178.0
//   node scripts/version-suggest.mjs --json
//   node scripts/version-suggest.mjs --check    # 当前 package.json 版本是否与建议档位一致（CI 可用）
//
// 退出码：0 = 建议已给出（或 --check 通过）；1 = --check 不一致；2 = 用法/环境错误。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 只影响「文档/测试/证据/报告」的路径前缀 —— 命中这些不算行为改动
const NON_BEHAVIOR_PREFIXES = ['test/', 'docs/', 'evidence/', 'reports/'];
const NON_BEHAVIOR_FILES = new Set([
  'CHANGELOG.md',
  'MAINTENANCE.md',
  'AGENTS.md',
  'LADDER.md',
  '计划表.md',
  'README.md',
  '方案.md',
]);

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
  } catch (error) {
    if (allowFail) return '';
    throw error;
  }
}

function lastTag() {
  const tag = git(['describe', '--tags', '--abbrev=0'], { allowFail: true });
  return tag || null;
}

function changedFiles(base) {
  const range = base ? `${base}..HEAD` : 'HEAD';
  const out = git(['diff', '--name-only', range], { allowFail: true });
  if (out) return out.split('\n').filter(Boolean);
  // 没有 base（或首个提交）时退化为「HEAD 的改动」
  const head = git(['show', '--pretty=format:', '--name-only', 'HEAD'], { allowFail: true });
  return head ? head.split('\n').filter(Boolean) : [];
}

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text || '').trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function currentVersion() {
  try {
    return JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

// 判定单个文件属于哪一档
function classify(file) {
  if (NON_BEHAVIOR_FILES.has(file)) return 'patch';
  if (NON_BEHAVIOR_PREFIXES.some((prefix) => file.startsWith(prefix))) return 'patch';
  // src/** 与 scripts/** 是行为面；其余（配置、模板）按 minor 处理，宁可高不低
  if (file.startsWith('src/') || file.startsWith('scripts/')) return 'minor';
  return 'minor';
}

const RANK = { patch: 0, minor: 1, major: 2 };

export function suggestBump(files) {
  let level = 'patch';
  const buckets = { patch: [], minor: [], major: [] };
  for (const file of files) {
    const kind = classify(file);
    buckets[kind].push(file);
    if (RANK[kind] > RANK[level]) level = kind;
  }
  return { level, buckets };
}

export function bumpVersion(version, level) {
  const parsed = parseVersion(version);
  if (!parsed) return null;
  if (level === 'major') return `${parsed.major + 1}.0.0`;
  if (level === 'minor') return `${parsed.major}.${parsed.minor + 1}.0`;
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function main(argv) {
  const json = argv.includes('--json');
  const check = argv.includes('--check');
  const baseIndex = argv.indexOf('--base');
  const explicitBase = baseIndex >= 0 ? argv[baseIndex + 1] : null;

  const base = explicitBase || lastTag();
  if (!base) {
    console.error('version-suggest: 找不到可比较的 tag（先发一次版，或传 --base <ref>）');
    return 2;
  }

  const files = changedFiles(base);
  const { level, buckets } = suggestBump(files);
  const current = currentVersion();
  const next = bumpVersion(current, level);

  const report = {
    base,
    current,
    level,
    next,
    changedFiles: files.length,
    buckets: {
      patch: buckets.patch.slice(0, 20),
      minor: buckets.minor.slice(0, 20),
      major: buckets.major.slice(0, 20),
    },
    rule: 'test|docs|evidence|reports|CHANGELOG|台账 ⇒ patch；src|scripts 行为 ⇒ minor；契约破坏 ⇒ major（1.0 前用 minor + 标「破坏性」）',
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`version-suggest：相对 ${base} 共 ${files.length} 个文件`);
    console.log(`  建议档位：${level.toUpperCase()}`);
    console.log(`  当前 ${current} → 建议 ${next}`);
    console.log(`  判据：${report.rule}`);
    if (files.length) {
      console.log('  改动最多的面：');
      const top = Object.entries(
        files.reduce((acc, file) => {
          const top1 = file.split('/')[0] || '(root)';
          acc[top1] = (acc[top1] || 0) + 1;
          return acc;
        }, {}),
      )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6);
      for (const [dir, count] of top) console.log(`    ${dir}/ … ${count}`);
    }
  }

  if (!check) return 0;
  // --check：当前版本是否已经落在建议档位之后（即至少到 next）
  if (!current || !next) {
    console.error('version-suggest: --check 需要 package.json 里有合法 semver');
    return 2;
  }
  const cur = parseVersion(current);
  const want = parseVersion(next);
  const behind =
    cur.major < want.major ||
    (cur.major === want.major && cur.minor < want.minor) ||
    (cur.major === want.major && cur.minor === want.minor && cur.patch < want.patch);
  if (behind) {
    console.error(`version-suggest: 当前 ${current} 落后于建议 ${next}（档位 ${level}）—— 发版前先 bump`);
    return 1;
  }
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));

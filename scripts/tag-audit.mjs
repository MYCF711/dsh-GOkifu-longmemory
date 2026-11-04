#!/usr/bin/env node
// tag 审计（2026-11-04，0.116.0 踩坑后新档）：
//   事故形态 —— `v0.116.0` 这个 tag 指到了 PR 之前的分支提交（squash 前的 `M4: 注入卡片留样`），
//   那个提交里的 `package.json` 已经是 `0.117.0`。于是「tag 名 / 提交内容 / Release 标题」三者互不对应，
//   而所有既有的闸（check / ledger-check / CI）都查不出来：它们只看工作树，不看 tag。
//
// 本档只做两件机械判定：
//   ① **硬红**：每个 tag 的 package.json `version` 必须等于 tag 名（v0.116.0 ⇒ 0.116.0）。
//   ② **软警**：tag 指向的提交应当在 main 历史上（早期 v0.16.0 及以前有一批不在 main，属历史遗留，只告警不阻断）。
//
// 用法：node scripts/tag-audit.mjs [--json] [--main <rev>]
// 退出码：0 无硬红；1 有硬红；2 环境不齐（不是 git 仓库 / 取不到 main）。
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** 纯函数：entries = [{tag, commit, version, onMain}] */
export function auditTags(entries) {
  const bad = [];
  const warn = [];
  for (const e of entries) {
    const expected = String(e.tag).startsWith('v') ? String(e.tag).slice(1) : String(e.tag);
    if (!e.version) bad.push(`${e.tag}：提交 ${String(e.commit).slice(0, 8)} 里取不到 package.json version`);
    else if (e.version !== expected) bad.push(`${e.tag}：提交 ${String(e.commit).slice(0, 8)} 的内容是 ${e.version}，与 tag 名不符`);
    if (e.onMain === false) warn.push(`${e.tag}：提交 ${String(e.commit).slice(0, 8)} 不在 main 历史上（历史遗留，不回填）`);
  }
  return { checked: entries.length, bad, warn };
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();

/** 采集事实：每个 tag ⇒ 提交 + 该提交里的版本 + 是否在 main 上 */
export function collectTagFacts({ main = 'origin/main' } = {}) {
  let mainRev;
  try { mainRev = git(['rev-parse', main]); } catch { mainRev = git(['rev-parse', 'HEAD']); }
  const names = git(['tag', '--list']).split('\n').filter(Boolean);
  return names.map((tag) => {
    let commit = '';
    let version = null;
    let onMain = false;
    try {
      commit = git(['rev-parse', `${tag}^{commit}`]);
      const raw = git(['show', `${tag}^{commit}:package.json`]);
      version = JSON.parse(raw).version ?? null;
    } catch { version = null; }
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', commit, mainRev], { stdio: 'ignore' });
      onMain = true;
    } catch { onMain = false; }
    return { tag, commit, version, onMain };
  });
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invoked) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const mi = argv.indexOf('--main');
  const main = mi >= 0 && argv[mi + 1] ? argv[mi + 1] : 'origin/main';
  let entries;
  try { entries = collectTagFacts({ main }); } catch (error) {
    console.error(`tag-audit: 采集失败（${String(error?.message ?? error).slice(0, 120)}）`);
    process.exit(2);
  }
  const res = auditTags(entries);
  if (json) console.log(JSON.stringify({ ...res, entries }, null, 2));
  else {
    console.log(`tag-audit：${res.checked} 个 tag · 硬红 ${res.bad.length} · 软警 ${res.warn.length}`);
    for (const b of res.bad) console.error(`ERR ${b}`);
    if (res.warn.length && !argv.includes('--quiet')) {
      console.log(`（软警 ${res.warn.length} 条：早期 tag 不在 main 历史上，属历史遗留，不回填）`);
      for (const w of res.warn) console.log(`  warn ${w}`);
    }
    console.log(res.bad.length === 0 ? 'tag-audit: PASS' : 'tag-audit: FAIL（tag 与内容版本错位）');
  }
  process.exit(res.bad.length === 0 ? 0 : 1);
}

#!/usr/bin/env node
// 本实例自检：插件是否指向本工作区、版本是多少、置否可用。
// 只读，不改任何东西。退出码：0 = 就绪（重启即生效）；1 = 有问题（下面会写清是哪条）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
// DSH home 的解析必须和 `scripts/re-enable.mjs` 一致：**双击 .cmd 时 `DSH_HOME` 不在环境里**，
// 而 `%USERPROFILE%\DeepSeek Harness\home` 是错的（真 home 在安装盘，例如 `D:\DeepSeek Harness\home`）。
const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const rows = [];
const ok = (n, v) => rows.push([n, true, v]);
const bad = (n, v) => rows.push([n, false, v]);

ok('工作区', ROOT);
ok('包版本', `${pkg.name}@${pkg.version}`);

// ① store 存在
const store = path.join(HOME, 'memory-context');
if (fs.existsSync(store)) ok('记忆库', store);
else bad('记忆库', `不存在：${store}`);

// ② 主 profile 里有没有指向本工作区的软链（有软链 ⇒ 源码改动重启即生效，无需安装）
const link = path.join(HOME, 'profiles', 'desktop', 'node_modules', 'dsh-gokifu-longmemory');
if (fs.existsSync(link)) {
  let real = null;
  try { real = fs.realpathSync(link); } catch { real = null; }
  const same = real && path.resolve(real).toLowerCase() === path.resolve(ROOT).toLowerCase();
  if (same) ok('软链', `→ 本工作区（重启即生效，不需要安装）`);
  else bad('软链', `→ ${real ?? '（读不出）'}（不是本工作区）`);
} else {
  bad('软链', `不存在：${link}（需要按 docs/安装指南.md 挂一次）`);
}

// ③ 版本号是不是最新发版
const changelog = path.join(ROOT, 'CHANGELOG.md');
if (fs.existsSync(changelog)) {
  const head = fs.readFileSync(changelog, 'utf8').slice(0, 4000);
  const m = /##\s*(\d+\.\d+\.\d+)（/.exec(head);
  if (m && m[1] === pkg.version) ok('CHANGELOG', `最新段 = ${m[1]}`);
  else bad('CHANGELOG', `最新段 ${m ? m[1] : '（找不到）'} vs package ${pkg.version}`);
}

const width = Math.max(...rows.map((r) => r[0].length));
for (const [n, good, v] of rows) {
  console.log(`${good ? 'OK  ' : 'FAIL'}  ${n.padEnd(width)}  ${v}`);
}
const failed = rows.filter((r) => !r[1]).length;
console.log('');
if (failed === 0) {
  console.log('结论：就绪。完全退出 DSH 再打开，新代码即生效（软链，不需要安装步骤）。');
  process.exitCode = 0;
} else {
  console.log(`结论：${failed} 项有问题，按上面 FAIL 行处理后再重启。`);
  process.exitCode = 1;
}

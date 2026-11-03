#!/usr/bin/env node
// 关掉 DSH 后自动启用插件（2026-11-03）
// 背景：用户不想跑命令行，只愿意"重启一下"。
// 做法：本进程常驻后台，轮询 "DeepSeek Harness.exe"；一旦连续两轮不存在（= DSH 已退出），
//       立刻跑 re-enable（写 patch/package.json + pnpm install），然后退出。
// 这样用户只需：关掉 DSH → 等几秒 → 重新打开。
//
// 安全性：只在 DSH 确实不在时写配置；写之前再确认一次；全程写日志。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const LOG = path.join(REPO, 'evidence', 'enable-on-exit.log');
const DONE = path.join(REPO, 'tmp', 'enable-on-exit.done');
const PROC = 'DeepSeek Harness.exe';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, line + '\n'); } catch { /* ignore */ }
  console.error(line);
}

function dshRunning() {
  try {
    const out = execFileSync('tasklist', [], { encoding: 'utf8', windowsHide: true });
    return out.includes(PROC);
  } catch {
    return true; // 查不到就当它还在，宁可不写
  }
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

log('watcher started; waiting for DSH to exit');
let absentStreak = 0;
for (let i = 0; i < 7200; i += 1) { // 最多两小时
  if (dshRunning()) {
    absentStreak = 0;
  } else {
    absentStreak += 1;
    if (absentStreak >= 2) {
      sleepSync(1500);
      if (dshRunning()) { absentStreak = 0; continue; }
      log('DSH is gone; enabling plugin (re-enable)');
      const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 're-enable.mjs')], { cwd: REPO, encoding: 'utf8', windowsHide: true });
      log(`re-enable exit=${r.status}`);
      if (r.stdout) log(`stdout: ${r.stdout.trim().split(String.fromCharCode(10)).slice(-4).join(' | ')}`);
      if (r.stderr) log(`stderr: ${r.stderr.trim().split(String.fromCharCode(10)).slice(-4).join(' | ')}`);
      try { fs.writeFileSync(DONE, JSON.stringify({ at: Date.now(), status: r.status }) + '\n'); } catch { /* ignore */ }
      const check = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'install-doctor.mjs')], { cwd: REPO, encoding: 'utf8', windowsHide: true });
      log(`doctor: ${(check.stdout || '').split(String.fromCharCode(10)).slice(0, 2).join(' | ')}`);
      log('done; reopen DSH now');
      process.exit(0);
    }
  }
  sleepSync(1000);
}
log('timeout (2h) without seeing DSH exit; giving up');

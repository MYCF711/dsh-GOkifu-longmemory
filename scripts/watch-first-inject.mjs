#!/usr/bin/env node
// 等待"首次真实注入"（2026-11-03）：轮询 live-stats.jsonl，出现 action=inject 就把快照写进 evidence/。
// 用法：node scripts/watch-first-inject.mjs [--interval 60] [--timeout 86400]
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
const file = path.join(HOME, 'memory-context', 'live-stats.jsonl');
const out = path.join(process.cwd(), 'evidence', 'M7-A3-first-inject.md');
const interval = Number(opt('interval', '60')) * 1000;
const timeout = Number(opt('timeout', '86400')) * 1000;
const started = Date.now();

const readRows = () => {
  try {
    return fs.readFileSync(file, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return null; }
};

for (;;) {
  const rows = readRows();
  if (rows) {
    const injects = rows.filter((r) => r.action === 'inject' && String(r.src ?? '') === 'index.js');
    if (injects.length) {
      const first = injects[0];
      const lines = [
        '# A3 首次真实注入（自动记录）',
        '',
        `- 时间：${new Date(first.at).toLocaleString()}（epoch ${first.at}）`,
        `- 来源：src=${first.src} pid=${first.pid} scope=${first.scope ?? 'n/a'} scopeFrom=${first.scopeFrom ?? 'n/a'}`,
        `- digest：${first.digest ?? 'n/a'} · tokens：${first.tokens ?? 'n/a'}`,
        `- 心跳总数：${rows.length} · inject：${injects.length} · skip：${rows.filter((r) => r.action === 'skip').length}`,
        '',
        '```json',
        JSON.stringify(first, null, 2),
        '```',
        '',
      ];
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, lines.join(String.fromCharCode(10)), 'utf8');
      console.log(`first inject captured at ${new Date(first.at).toISOString()} -> ${out}`);
      process.exit(0);
    }
  }
  if (Date.now() - started > timeout) { console.error('timeout'); process.exit(1); }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, interval);
}

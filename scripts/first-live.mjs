#!/usr/bin/env node
// 首次上线复盘（2026-11-02）：把「装没装成 / 六轴过不过 / 影子本来会注入什么 / D5 触发了几次」
// 合成一份 evidence/first-live.md。装完当场就能生成第一份线上证据。
//
// 用法：node scripts/first-live.mjs [--out evidence/first-live.md] [--json]
// 退出码：0 生成成功（无论结论如何）；2 环境不齐（没有 $DSH_HOME）。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { doctor } from './install-doctor.mjs';
import { summarize as summarizeRepeat } from './repeat-report.mjs';
import { readShadow } from '../src/rooms/inject.mjs';

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');

const pct = (x) => (typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : 'n/a');

/** 纯函数：把四份输入拼成 markdown + 结论（可单测，不碰文件系统）。 */
export function buildFirstLive({ version = '?', at = new Date(), doctorReport, guard, shadow, repeat } = {}) {
  const reg = (doctorReport?.checks ?? []).find((c) => c.name.startsWith('插件注册'));
  const regText = reg?.detail ?? 'n/a';
  const disabled = Number((/(\d+) 条 disabled/.exec(regText) ?? [])[1] ?? 0);
  const sim = (doctorReport?.checks ?? []).find((c) => c.name.startsWith('热路径抽测'));
  const guardOk = guard?.ok === true;
  const values = guard?.values ?? {};
  const shadowRecords = shadow?.records ?? null;
  const shadowInject = shadow?.wouldInject ?? null;
  const repeatTotal = repeat?.total ?? null;

  const liveReady = disabled === 0 && guardOk;
  const lines = [];
  lines.push(`# 首次上线复盘（first-live）`);
  lines.push('');
  lines.push(`- 版本：\`${version}\` · 生成于 ${at.toISOString()}`);
  lines.push(`- 结论：**${liveReady ? '已上线（注册无禁用 + 六轴门槛通过）' : '尚未上线（见下）'}**`);
  lines.push('');
  lines.push('## 1 · 注册与热路径');
  lines.push('');
  lines.push(`| 项 | 值 |`);
  lines.push(`|---|---|`);
  lines.push(`| 注册状态 | ${regText} |`);
  lines.push(`| 热路径抽测 | ${sim?.detail ?? 'n/a'} |`);
  lines.push(`| install-doctor | ${doctorReport?.ok ? 'PASS' : 'FAIL'} |`);
  lines.push('');
  lines.push('## 2 · 六轴（metrics-guard）');
  lines.push('');
  lines.push(`| 轴 | 值 | 门槛 |`);
  lines.push(`|---|---|---|`);
  lines.push(`| A1 负迁移 | ${pct(values.a1)} | ≤5% |`);
  lines.push(`| A4 p50 | ${typeof values.p50 === 'number' ? values.p50.toFixed(2) + 'ms' : 'n/a'} | ≤50ms |`);
  lines.push(`| A5 越界 | ${pct(values.a5)} | =0 |`);
  lines.push(`| A6 溯源 | ${pct(values.a6)} | =100% |`);
  lines.push(`| A2b 覆盖 | ${pct(values.a2bCover)} | =100% |`);
  lines.push(`| A2b 严格 | ${pct(values.a2bStrict)}（n=${values.a2bN ?? '?'}） | ≥0.55 |`);
  lines.push(`| 门槛判定 | ${guardOk ? 'PASS' : `FAIL：${(guard?.fails ?? []).join('；') || '未知'}`} | — |`);
  lines.push('');
  lines.push('## 3 · 影子台账（本来会注入什么）');
  lines.push('');
  if (shadowRecords === null) {
    lines.push('影子台账不存在（尚未开 `shadow:true` 或还没产生记录）。');
  } else {
    lines.push(`- 记录 ${shadowRecords} 条 · 会注入 ${shadowInject ?? '?'} 条 · 沉默 ${shadow?.silent ?? '?'} 条`);
    lines.push(`- token：p50 ${shadow?.tokens?.p50 ?? 'n/a'} / p90 ${shadow?.tokens?.p90 ?? 'n/a'} / max ${shadow?.tokens?.max ?? 'n/a'}`);
  }
  lines.push('');
  lines.push('## 4 · D5 二次命中（repeat-hint 遥测）');
  lines.push('');
  if (repeatTotal === null) {
    lines.push('没有遥测（真注入后才会产生；影子模式不写）。');
  } else {
    lines.push(`- 触发 ${repeatTotal} 次 · 涉及会话 ${repeat?.sessions ?? '?'} · token 均值 ${repeat?.tokensAvg ?? 'n/a'}`);
    for (const [cls, n] of repeat?.byClass ?? []) lines.push(`- ${cls}：${n} 次`);
  }
  lines.push('');
  lines.push('## 5 · 下一步');
  lines.push('');
  if (!liveReady) {
    lines.push('1. 按 `docs/安装指南.md` §1 三步启用（dry-run → 退出 DSH 执行 re-enable → 重开后 doctor/guard）；');
    lines.push('2. 若仍显示 `disabled:true`，说明第 ② 步没有在**退出 DSH 后**执行。');
  } else {
    lines.push('1. 观察 1–2 天：`node scripts/repeat-report.mjs`、`node scripts/shadow-report.mjs`；');
    lines.push('2. 任何回归先跑 `node scripts/metrics-guard.mjs`，按它给出的轴定位；');
    lines.push('3. 需要“某时点为真”的核对时用 `node scripts/cli.mjs facts --at <日期>`。');
  }
  lines.push('');
  return { markdown: lines.join(String.fromCharCode(10)), liveReady, disabled, guardOk };
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invoked) {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const outFile = path.resolve(outIdx >= 0 ? argv[outIdx + 1] : path.join(REPO, 'evidence', 'first-live.md'));
  if (!fs.existsSync(HOME)) {
    console.error(`没有 $DSH_HOME：${HOME}`);
    process.exit(2);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const doctorReport = await doctor({ home: HOME });
  let guard = { ok: false, fails: ['metrics-guard 未跑起来'], values: {} };
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.join(REPO, 'scripts/metrics-guard.mjs'), '--json'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
    guard = JSON.parse(stdout);
  } catch (error) {
    try { guard = JSON.parse(fs.readFileSync(path.join(REPO, 'evidence/metrics-guard.json'), 'utf8')); } catch { /* 保留失败态 */ }
  }
  const shadow = readShadow({ dir: path.join(REPO, 'evidence', 'shadow') });
  const shadowSummary = shadow.missing ? { records: null } : shadow;
  const repeatFile = path.join(HOME, 'memory-context-shadow', 'repeat-hint.jsonl');
  const repeat = fs.existsSync(repeatFile)
    ? summarizeRepeat(fs.readFileSync(repeatFile, 'utf8').split(String.fromCharCode(10)).filter(Boolean))
    : { total: null };
  const result = buildFirstLive({ version: pkg.version, at: new Date(), doctorReport, guard, shadow: shadowSummary, repeat });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, result.markdown + String.fromCharCode(10));
  if (argv.includes('--json')) console.log(JSON.stringify({ outFile, liveReady: result.liveReady, disabled: result.disabled, guardOk: result.guardOk }));
  else console.log(`已生成 ${outFile} · liveReady=${result.liveReady}（disabled=${result.disabled} guard=${result.guardOk ? 'PASS' : 'FAIL'}）`);
}

#!/usr/bin/env node
// 一页状态摘要（2026-11-03）：把"现在到底怎么样"用一条命令生成，避免每次巡检都手工拼。
// 内容：版本/git → 质量门（check/ledger/metrics）→ 六轴 → 安装状态 → 真实会话回放 → 待决问题。
// 用法：node scripts/status-digest.mjs [--json] [--write <path>] [--sessions 12]
// 只读；唯一写入是 --write 指定的文件。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const json = argv.includes('--json');
const writeTo = opt('write', null);
const sessions = opt('sessions', '12');

function run(cmd, args, okExit = 0) {
  try {
    const out = execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: out.trim() };
  } catch (error) {
    return { ok: false, out: `${String(error?.stdout ?? '')}${String(error?.stderr ?? '')}`.trim() };
  }
}
const node = process.execPath;

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const head = run('git', ['log', '-1', '--oneline']).out;
const branch = run('git', ['branch', '--show-current']).out;
const dirty = run('git', ['status', '--porcelain']).out;

const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');
const hasStore = fs.existsSync(path.join(HOME, 'memory-context'));
const check = run(node, ['scripts/check.mjs']);
const ledger = run(node, ['scripts/ledger-check.mjs', '--full']);
const guard = run(node, ['scripts/metrics-guard.mjs']);
// guard 会重写 evidence/metrics-guard.json（脚本副作用）：摘要工具顺手复原，保持工作树干净
run('git', ['checkout', '--', 'evidence/metrics-guard.json']);
const m5 = run(node, ['scripts/m5-report.mjs', '--json']);
const doctor = run(node, ['scripts/install-doctor.mjs']);
const replay = run(node, ['scripts/replay-live.mjs', '--sessions', sessions, '--json']);

let axes = null;
try { axes = JSON.parse(m5.out).axes; } catch { /* 无 store 时 m5 会失败 */ }
let replaySum = null;
try { replaySum = JSON.parse(replay.out); } catch { /* 同上 */ }

const digest = {
  generatedAt: new Date().toISOString(),
  repo: { branch, head, dirty: dirty === '' ? 'clean' : dirty.split('\n').length + ' 个改动' },
  version: pkg.version,
  gates: {
    check: check.ok ? 'PASS' : 'FAIL',
    // 无 store 时"台账/六轴"类检查不适用：标 N/A，不要误报 FAIL（2026-11-03 冷启动演练发现）
    ledger: ledger.ok ? 'PASS' : (hasStore ? 'FAIL' : 'N/A（无 store）'),
    metricsGuard: guard.ok ? 'PASS' : (hasStore ? 'FAIL' : 'N/A（无 store）'),
  },
  hasStore,
  metrics: guard.out.split('\n').filter((l) => l.includes('metrics-guard PASS')).pop() ?? null,
  sixAxis: axes ? Object.fromEntries(Object.entries(axes).map(([k, v]) => [k, v?.value ?? null])) : null,
  install: doctor.out.split('\n').filter((l) => l.startsWith('ok') || l.startsWith('ERR')).slice(0, 6),
  replay: replaySum ? {
    sessions: replaySum.sessions, injected: replaySum.injected, empty: replaySum.empty,
    crossScope: replaySum.crossScopeRefs, p50: replaySum.injectionLatencyMs?.p50, p95: replaySum.injectionLatencyMs?.p95,
  } : null,
  pending: ['Q18=A/B（类级章节跨工作区）', 'Q19=A/B/C（偏好是否收紧；开关已就绪默认关）', '安装三步（退出 DSH → re-enable → 重开后 doctor）'],
};

const md = [
  `# 棋院 · 状态摘要（${digest.generatedAt.slice(0, 19).replace('T', ' ')}Z）`,
  '',
  `- 版本 **${digest.version}** · 分支 \`${branch}\` · HEAD \`${head}\` · 工作树 ${digest.repo.dirty}`,
  `- 质量门：check **${digest.gates.check}** · ledger **${digest.gates.ledger}** · guard **${digest.gates.metricsGuard}**`,
  digest.metrics ? `- \`${digest.metrics}\`` : null,
  digest.sixAxis ? `- 六轴：${Object.entries(digest.sixAxis).map(([k, v]) => `${k}=${v}`).join(' · ')}` : null,
  digest.replay ? `- 真实会话回放（${digest.replay.sessions} 局）：注入 ${digest.replay.injected} · 沉默 ${digest.replay.empty} · 跨作用域 ${digest.replay.crossScope} · 注入 p50 ${Number(digest.replay.p50).toFixed(1)}ms / p95 ${Number(digest.replay.p95).toFixed(1)}ms` : null,
  '',
  '## 安装状态',
  ...(digest.install.length ? digest.install.map((l) => `- ${l}`) : ['- （install-doctor 无输出）']),
  '',
  '## 待决（只能由主人拍板/动手）',
  ...digest.pending.map((p) => `- ${p}`),
].filter(Boolean).join('\n');

if (json) console.log(JSON.stringify(digest, null, 2));
else {
  console.log(md);
  if (writeTo) {
    const abs = path.resolve(REPO, writeTo);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, md + '\n');
    console.error(`digest → ${path.relative(REPO, abs)}`);
  }
}

// 巡检一条命令：心跳 + 当前宿主 A5/A6 + 六轴闸，并把结论落成一份带日期的证据。
//
// 为什么要有它：整点巡检每次都要手动跑 3–4 条命令、再从输出里挑数字抄进 evidence ——
// 抄错一次就把错数写进了台账。这里把它们跑一遍、只打印**结论行**，并直接写成 Markdown。
//
// 用法：
//   node scripts/patrol.mjs                 # 心跳 + 当前宿主审计（快，~10s）
//   node scripts/patrol.mjs --full          # 再加 metrics-guard（慢，~10min）
//   node scripts/patrol.mjs --write         # 同时写 evidence/M8-patrol-<日期>.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
const now = new Date();
const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

const run = (args, timeout = 600000) => {
  try {
    return { ok: true, out: execFileSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout }) };
  } catch (error) {
    return { ok: false, out: `${error?.stdout ?? ''}${error?.stderr ?? ''}`, err: String(error?.message ?? error) };
  }
};

/** 从 `live-stats.mjs` 的输出里取"动作/原因"两行。 */
export function parseLiveStats(text) {
  const lines = String(text ?? '').split('\n');
  const action = lines.find((l) => l.startsWith('动作：')) ?? '';
  const reason = lines.find((l) => l.startsWith('原因：')) ?? '';
  const inject = Number(/inject=(\d+)/.exec(action)?.[1] ?? NaN);
  const skip = Number(/skip=(\d+)/.exec(action)?.[1] ?? NaN);
  // gates-failed 在「原因」那一行（动作行只有 skip/inject）—— 一开始写成同一条，读数一直是 ?。
  const gate = Number(/gates-failed=(\d+)/.exec(reason)?.[1] ?? NaN);
  return { inject: Number.isFinite(inject) ? inject : null, skip: Number.isFinite(skip) ? skip : null, gatesFailed: Number.isFinite(gate) ? gate : null };
}

/** 从 `audit-card-samples --current` 的摘要行里取六项读数。 */
export function parseAudit(text) {
  const s = String(text ?? '');
  const num = (re) => { const m = re.exec(s); return m ? Number(m[1]) : null; };
  const pidMatch = /宿主 pid=(\d+)/.exec(s);
  return {
    samples: num(/样本 (\d+) 张/),
    refs: num(/引用 (\d+) 条/),
    atSeq: num(/at-seq (\d+)/),
    elsewhere: num(/elsewhere (\d+)/),
    missing: num(/missing (\d+)/),
    joined: num(/joined (\d+)/),
    dateOk: num(/日期一致 (\d+)\/(\d+)/),
    crossScope: num(/跨作用域 (\d+)/),
    pid: pidMatch ? Number(pidMatch[1]) : null,
  };
}

export function verdictOf(audit) {
  const problems = [];
  if (audit.crossScope > 0) problems.push(`跨作用域 ${audit.crossScope} 条（A5 必须 0）`);
  if (audit.missing > 0) problems.push(`missing ${audit.missing} 条（A6 文字层）`);
  if (audit.dateOk !== null && audit.refs !== null && audit.dateOk !== audit.refs) problems.push(`日期不一致 ${audit.refs - audit.dateOk} 条`);
  return { ok: problems.length === 0, problems };
}

const live = run([path.join(REPO, 'scripts', 'live-stats.mjs')]);
const stats = parseLiveStats(live.out);
const auditRun = run([path.join(REPO, 'scripts', 'audit-card-samples.mjs'), '--current']);
const audit = parseAudit(auditRun.out);
const verdict = verdictOf(audit);

let guard = null;
if (process.argv.includes('--full')) {
  const g = run([path.join(REPO, 'scripts', 'metrics-guard.mjs')]);
  guard = { ok: g.ok && /metrics-guard PASS/.test(g.out), line: (g.out.split('\n').find((l) => /metrics-guard/.test(l)) ?? '').trim() };
}

const lines = [
  `# 巡检 ${day} ${clock}`,
  '',
  '| 项 | 读数 | 判定 |',
  '|---|---|---|',
  `| A3 心跳 | inject=${stats.inject ?? '?'} · skip=${stats.skip ?? '?'} · gates-failed=${stats.gatesFailed ?? '?'} | ${stats.inject > 0 ? '通过' : '无注入（查是否没信号）'} |`,
  `| A5 跨作用域 | ${audit.crossScope ?? '?'} | ${audit.crossScope === 0 ? '通过' : '**最高优先级**'} |`,
  `| A6 文字层 | at-seq ${audit.atSeq ?? '?'}/${audit.refs ?? '?'} · missing ${audit.missing ?? '?'} · joined ${audit.joined ?? '?'} · 日期 ${audit.dateOk ?? '?'}/${audit.refs ?? '?'} | ${verdict.ok ? '通过' : '**要看**'} |`,
  `| 样本 | ${audit.samples ?? '?'} 张（当前宿主 pid=${audit.pid ?? '?'}） | — |`,
  ...(guard ? [`| 六轴闸 | ${guard.line || '（无输出）'} | ${guard.ok ? '通过' : '**红了**'} |`] : []),
  '',
  verdict.ok ? '结论：三项体检全绿。' : `结论：需要处理 —— ${verdict.problems.join('；')}。`,
  '',
  `命令：\`node scripts/patrol.mjs${process.argv.includes('--full') ? ' --full' : ''}\``,
].join('\n');

console.log(lines);

if (process.argv.includes('--write')) {
  const dir = path.join(REPO, 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `M8-patrol-${day}.md`);
  fs.writeFileSync(target, `${lines}\n`);
  console.log(`\n已写入：${target}`);
}

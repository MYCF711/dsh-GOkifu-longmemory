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
    return { ok: true, code: 0, out: execFileSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout }) };
  } catch (error) {
    return { ok: false, code: typeof error?.status === 'number' ? error.status : null, out: `${error?.stdout ?? ''}${error?.stderr ?? ''}`, err: String(error?.message ?? error) };
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
    atSeq: num(/at-seq (\d+)/) ?? num(/(?:^|\s)ok (\d+)/m),
    elsewhere: num(/elsewhere (\d+)/) ?? num(/offset (\d+)/),
    missing: num(/missing (\d+)/) ?? num(/notFound (\d+)/),
    joined: num(/joined (\d+)/),
    unreadable: num(/unreadable (\d+)/),
    dateOk: num(/日期一致 (\d+)\/(\d+)/),
    crossScope: num(/跨作用域 (\d+)/),
    pid: pidMatch ? Number(pidMatch[1]) : null,
  };
}

/**
 * T250：**主判据 A2b** 的巡检行。
 *
 * 数据来源是 `metrics-guard.mjs --json` 的输出（`ok / fails / values.{a2bStrict,a2bCover,a2bN,sampleSource}`），
 * **本文件不重写任何阈值** —— 红/绿、样本来源、n 全部由 metrics-guard 决定，patrol 只负责显示。
 * fail-closed：拿不到 JSON（进程挂了/输出不是 JSON）⇒ 该行显示 `**要看**` 并带原因，绝不静默略过。
 *
 * @param {string|null} guardStdout metrics-guard --json 的 stdout
 * @returns {{text:string, ok:boolean}}
 */
export function a2bRowOf(guardStdout) {
  const raw = String(guardStdout ?? '').trim();
  let out = null;
  try { out = JSON.parse(raw); } catch { out = null; }
  if (!out || typeof out !== 'object') {
    return { ok: false, text: '| 主判据 A2b | 拿不到 metrics-guard 的输出（fail-closed） | **要看** |' };
  }
  const v = out.values ?? {};
  const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : 'n/a');
  const n = Number.isFinite(v.a2bN) ? v.a2bN : '?';
  const source = v.sampleSource ?? 'report';
  const body = '严格 ' + pct(v.a2bStrict) + '（n=' + n + ' · ' + source + '）· 覆盖 ' + pct(v.a2bCover);
  if (out.ok === true) return { ok: true, text: '| 主判据 A2b | ' + body + ' | 通过 |' };
  const reasons = Array.isArray(out.fails) && out.fails.length ? out.fails.join('；') : '未通过（无原因字符串）';
  return { ok: false, text: '| 主判据 A2b | ' + body + ' | **要看**：' + reasons + ' |' };
}

/**
 * T269 · **语义不变量（SI）** 巡检行。
 *
 * 数据来源是 `semantic-check.mjs --sample 30 --tolerance 1 --json` 的输出；
 * **本文件不重写任何 SI 判据**（SI-1/SI-2/SI-4/SI-5 的红绿全部由校验器决定），只读它的 exit code 与 JSON。
 * fail-closed：跑不动 / 超时 / 输出不是 JSON ⇒ 该行 `**要看**` 并带原因，绝不静默略过。
 *
 * @param {string} stdout semantic-check --json 的 stdout
 * @param {number|null} exitCode 进程退出码（0=pass · 1=fail/unverified · 2=参数/库缺失 · null=超时/被杀）
 * @returns {{text:string, ok:boolean}}
 */
export function semanticRowOf(stdout, exitCode = 0) {
  const raw = String(stdout ?? '').trim();
  let out = null;
  try { out = JSON.parse(raw); } catch { out = null; }
  const timedOut = exitCode === null;
  if (!out || typeof out !== 'object') {
    const why = timedOut ? '超时/被杀（fail-closed）' : '拿不到 semantic-check 的输出（fail-closed）';
    return { ok: false, text: `| 语义不变量 | ${why} | **要看** |` };
  }
  const pass = Number(out.pass ?? 0);
  const fail = Number(out.fail ?? 0);
  const unverified = Number(out.unverified ?? 0);
  const buckets = out.buckets && typeof out.buckets === 'object' ? out.buckets : {};
  const reasons = Object.entries(buckets).map(([k, v]) => `${k} ${v}`).join(' · ');
  const first = Array.isArray(out.samples) && out.samples[0] ? out.samples[0] : null;
  const firstText = first ? ` · 首例 ${first.claimId ?? '?'}` : '';
  const body = `pass ${pass} · fail ${fail} · unverified ${unverified}${reasons ? `（${reasons}${firstText}）` : ''}${timedOut ? ' · 超时' : ''}`;
  const ok = exitCode === 0 && fail === 0 && unverified === 0;
  return { ok, text: `| 语义不变量 | ${body} | ${ok ? '通过' : '**要看**'} |` };
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

// T250：**主判据（A2b 召回相关度）默认就跑** —— 它是第一验收面，不该只挂在 --full 上。
// 只读 metrics-guard 的判定结果（--json），阈值一律不在本文件出现。
const guardRun = run([path.join(REPO, 'scripts', 'metrics-guard.mjs'), '--json']);
const a2b = a2bRowOf(guardRun.out);

// T269：语义不变量（SI）—— 只读 semantic-check 的 exit code + JSON，不重写判据；120s 超时 ⇒ unverified（fail-closed）
const semanticRun = run([path.join(REPO, 'scripts', 'semantic-check.mjs'), '--sample', '30', '--tolerance', '1', '--json'], 120000);
const semantic = semanticRowOf(semanticRun.out, semanticRun.code ?? (semanticRun.ok ? 0 : null));

const lines = [
  `# 巡检 ${day} ${clock}`,
  '',
  '| 项 | 读数 | 判定 |',
  '|---|---|---|',
  a2b.text, // T250：主判据永远第一行
  `| A3 心跳 | inject=${stats.inject ?? '?'} · skip=${stats.skip ?? '?'} · gates-failed=${stats.gatesFailed ?? '?'} | ${stats.inject > 0 ? '通过' : '无注入（查是否没信号）'} |`,
  `| A5 跨作用域 | ${audit.crossScope ?? '?'} | ${audit.crossScope === 0 ? '通过' : '**最高优先级**'} |`,
  `| A6 文字层 | ok ${audit.atSeq ?? '?'}/${audit.refs ?? '?'} · offset ${audit.elsewhere ?? 0} · notFound ${audit.missing ?? '?'} · unreadable ${audit.unreadable ?? 0} · 日期 ${audit.dateOk ?? '?'}/${audit.refs ?? '?'} | ${verdict.ok ? '通过' : '**要看**'} |`,
  semantic.text, // T269：语义不变量（SI-1/2/4/5），紧接 A6 之后
  `| 样本 | ${audit.samples ?? '?'} 张（当前宿主 pid=${audit.pid ?? '?'}） | — |`,
  '',
  (verdict.ok && a2b.ok && semantic.ok)
    ? '结论：三项体检 + 主判据（A2b）+ 语义不变量（SI）全绿。'
    : `结论：需要处理 —— ${[a2b.ok ? null : '主判据 A2b 红了', semantic.ok ? null : '语义不变量（SI）红了', ...verdict.problems].filter(Boolean).join('；')}。`,
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

#!/usr/bin/env node
// 台账自证（2026-11-02 audit-02 教训）：MAINTENANCE.md 里写的数字，必须能被命令当场复现。
// 两轮审计都栽在"文档说了不实的话"，所以把它机械化：数字对不上就退出 1。
//
// 核对项：
//   1. 版本：`main = X.Y.Z` 必须等于 package.json 的 version
//   2. 测试：`**N 条**（P pass / F fail / S skip）` 必须等于 `node --test "test/*.test.mjs"` 实测（CI 同一条命令）
//   3. 语料：`claim N` / `**N 卷**` 必须等于 `cli audit --json`
//   4. AGENTS §7 仍是指针、且不含"条测试"
//   5. 发布物：CHANGELOG 有当前版本段（check.mjs 已覆盖，这里再守一次）
//
// 用法：node scripts/ledger-check.mjs [--json] [--no-tests]（--no-tests 跳过较慢的 node --test）
// 退出码：0 全部一致；1 有不一致；2 环境不齐（没有 store 时只跳过语料项并标注）。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseTestCounts, describeFailure } from './ledger-parse.mjs';

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

/**
 * 测试口径（T224）：与 CI 和 `scripts/ledger-sync.mjs` **完全一致** —— `node --test "test/*.test.mjs"`。
 * 不许再出现裸 `['--test']`（它会按"test 目录"约定把 `test/` 下的辅助脚本也算成测试），
 * 也不许再按 `git ls-tree HEAD` 只测已跟踪文件（那样与 sync 量的不是同一个东西 ⇒ 760 vs 759）。
 * 守卫：`test/ledger-tmp-guard.test.mjs` 断言两边都是这个 glob。
 */
const TEST_GLOB = 'test/*.test.mjs';

/** `tmp/` 下的 `*.test.mjs`（旧契约副本）一律不计入：返回相对路径，调用方告警。 */
function findTmpTestCopies() {
  const out = [];
  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) out.push(path.relative(REPO, abs).split(path.sep).join('/'));
    }
  };
  walk(path.join(REPO, 'tmp'));
  return out;
}

export function parseLedger(text) {
  const version = /main\s*=\s*(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
  const tests = /\*\*(\d+)\s*条\*\*（(\d+)\s*pass\s*\/\s*(\d+)\s*fail\s*\/\s*(\d+)\s*skip）/.exec(text);
  const claim = /claim\s*(\d+)/.exec(text)?.[1] ?? null;
  const threads = /\*\*(\d+)\s*卷\*\*/.exec(text)?.[1] ?? null;
  const episodes = /\|\s*语料\s*\|\s*(\d+)\s*局/.exec(text)?.[1] ?? null;
  const a2 = /A2\s*\*\*(\d+(?:\.\d+)?)%\*\*/.exec(text)?.[1] ?? null;
  const a4 = /A4\s*p50\s*\*\*(\d+(?:\.\d+)?)ms[^*]*\*\*/.exec(text)?.[1] ?? null;
  const stampText = /\[本\]\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(text)?.[1] ?? null;
  return {
    version,
    tests: tests ? { total: Number(tests[1]), pass: Number(tests[2]), fail: Number(tests[3]), skip: Number(tests[4]) } : null,
    claim: claim !== null ? Number(claim) : null,
    threads: threads !== null ? Number(threads) : null,
    episodes: episodes !== null ? Number(episodes) : null,
    a2: a2 !== null ? Number(a2) : null,
    a4: a4 !== null ? Number(a4) : null,
    stamp: stampText,
  };
}

// 2026-11-04：插件在宿主里跑起来后，autoArchive 会持续把新会话入馆 ⇒ 台账写下的数字是**快照**，
// 发版检查时必然已经涨了几个。给"线上在跑"的漂移容忍（只对计数，不给方向性指标开口子）。
export const LIVE_DRIFT = Object.freeze({ claim: 12, threads: 12, episodes: 12 });

// ---------------------------------------------------------------------------
// A4 p50：延迟是**统计量**，不是可复现的标量（T225）
// ---------------------------------------------------------------------------

/**
 * A4 p50 的**真实门槛**（ms）—— 与 `scripts/metrics-guard.mjs` 的 `a4p50MaxMs` 同源：
 * 这条不放松，p50 真变慢（如 300ms）先被它拦下。
 */
export const A4_GATE_MS = 50;
/** 台账值允许是实测值的几倍（同一命令跨时段的量级差）。 */
export const A4_REL_SLACK = 2;
/** 绝对下限（ms）：实测很小时（如 1ms），2 倍也才 2ms，抖动会把它顶穿 ⇒ 再留 20ms。 */
export const A4_ABS_SLACK_MS = 20;

/**
 * A4 p50 的**量级**判据（T225）。
 *
 * 为什么不再比"绝对相等"：p50 是统计量 —— GC、磁盘缓存、CPU 调度都会让它抖，同一份代码同一批数据
 * 两次跑差 5–10ms 属正常（今晚实测 21.5 vs 14）。拿"绝对值相等 ± 固定容差"去卡统计量，
 * 等于**要求统计量可复现到毫秒**，在任何机器上都不成立，只会周期性假红。
 *
 * 判据（两条都要过）：
 *   ① 实测 p50 ≤ `gateMs`（真实门槛，50ms）；
 *   ② 台账 p50 ≤ `max(实测 × relSlack, 实测 + absSlackMs)`（量级校验：台账落后于实测说明台账陈旧，
 *      但"落后 1.5 倍"不算问题 —— 只有"落后到量级不同"才红）。
 * 任一侧不是有限数 ⇒ 不判（交给 `fullCheck` 的"缺测点"兜底）。
 *
 * @param {number} ledgerMs 台账里的 p50
 * @param {number} actualMs 本次实测的 p50
 * @param {{gateMs?:number, relSlack?:number, absSlackMs?:number}} [opts]
 * @returns {{ok:boolean, limit:number|null, gateFailed:boolean, reason:string|null}}
 */
export function a4MagnitudeOk(ledgerMs, actualMs, { gateMs = A4_GATE_MS, relSlack = A4_REL_SLACK, absSlackMs = A4_ABS_SLACK_MS } = {}) {
  if (!Number.isFinite(ledgerMs) || !Number.isFinite(actualMs)) return { ok: true, limit: null, gateFailed: false, reason: null };
  const limit = Math.max(actualMs * relSlack, actualMs + absSlackMs);
  if (actualMs > gateMs) {
    return {
      ok: false,
      limit,
      gateFailed: true,
      reason: `实测 ${actualMs.toFixed(2)}ms > 门槛 ${gateMs}ms（这是真实门槛，不是抖动）`,
    };
  }
  if (ledgerMs > limit) {
    return {
      ok: false,
      limit,
      gateFailed: false,
      reason: `台账 ${ledgerMs}ms 高于量级上限 ${limit.toFixed(1)}ms（= max(实测×${relSlack}, 实测+${absSlackMs}ms)）—— 台账可能陈旧`,
    };
  }
  return { ok: true, limit, gateFailed: false, reason: null };
}

export function compare(ledger, actual, { live = false, staleHours = 6, notes = null } = {}) {
  // 2026-11-04（0.143.0）：`live` 是按心跳新鲜度判的（15 分钟内有写入）。宿主空闲时它就变成 false，
  // 于是又退回对称容差、把「语料正常增长」判成红 —— 发布时（正好没人发消息）连撞了两次。
  // 判据应该看**有没有实测到 store**：能读到库，增长就是真的；读不到（干净克隆/CI）本来也不比。
  const hasStore = Number.isFinite(actual?.claim) || Number.isFinite(actual?.episodes);
  const soft = live || hasStore;
  const has = (v) => Number.isFinite(v);
  const bad = [];
  // 容差按比例：语料在线上持续增长，固定 ±12 会被正常归档追上；2%（下限 12）仍能挡住"改错了"的量级。
  const scale = (v, base) => (live ? Math.max(base, Math.ceil((Number.isFinite(v) ? v : 0) * 0.02)) : 0);
  const drift = live
    ? { claim: scale(actual.claim, LIVE_DRIFT.claim), threads: scale(actual.threads, LIVE_DRIFT.threads), episodes: scale(actual.episodes, LIVE_DRIFT.episodes) }
    : { claim: 0, threads: 0, episodes: 0 };
  if (ledger.version && actual.version && ledger.version !== actual.version) bad.push(`版本：台账 ${ledger.version} vs package ${actual.version}`);
  // 2026-11-05（T172）：测试数改成**单向**判 —— 每加一波测试就要多花一轮 PR，白烧。
  //   · 实测 > 台账 ⇒ **放行**（新加测试是正常进展），只记一条 note 级信息（不进 bad、不影响退出码）；
  //   · 实测 < 台账 ⇒ **红**（测试被删/被跳过才是真信号）；
  //   · 持平 ⇒ 通过。
  // 口径与语料那条一致（只查变少），其它项（版本 / A2 / A4 / 语料）一字不改。
  if (ledger.tests && actual.tests) {
    for (const k of ['total', 'pass', 'fail', 'skip']) {
      const l = ledger.tests[k];
      const a = actual.tests[k];
      if (!Number.isFinite(l) || !Number.isFinite(a)) continue;
      if (a < l) bad.push(`测试 ${k}：实测 ${a} 少于台账 ${l} —— 测试变少要查（被删/被跳过）`);
      else if (a > l && Array.isArray(notes)) notes.push(`测试 ${k}：实测 ${a} > 台账 ${l}（新增测试，单向放行）`);
    }
  }
  // 2026-11-04（0.137.0）：**语料只增不减** —— 变少是数据丢失（真问题），变多是线上一直在归档（预期）。
  // 原来的对称容差会让"每次发版都被正常增长挡住"（今天连撞三次）。线上（live）改成单向规则：
  //   ① 实测 < 台账 - 容差 ⇒ 红（有人删了/归档坏了解析）；
  //   ② 实测 > 台账 + 容差 且台账时点超过 staleHours ⇒ 红（台账太久没刷，读数不可信）；
  //   ③ 其余（增长但台账够新）⇒ 放行。
  // 非线上（干净克隆/CI，测不到真库）仍按原对称容差判。
  const ledgerAgeH = (() => {
    if (typeof ledger.stamp !== 'string') return null;
    const t = Date.parse(ledger.stamp.replace(' ', 'T') + ':00+08:00');
    return Number.isFinite(t) ? (Date.now() - t) / 3_600_000 : null;
  })();
  const corpusCheck = (name, ledgerV, actualV, tol) => {
    if (!has(ledgerV) || !has(actualV)) return;
    if (!soft) {
      if (Math.abs(ledgerV - actualV) > tol) bad.push(`${name}：台账 ${ledgerV} vs 实测 ${actualV}（容差 ${tol}）`);
      return;
    }
    if (actualV < ledgerV - tol) { bad.push(`${name}：实测 ${actualV} 少于台账 ${ledgerV}（容差 ${tol}）—— 语料只增不减，变少要查`); return; }
    if (actualV > ledgerV + tol && ledgerAgeH !== null && ledgerAgeH > staleHours) {
      bad.push(`${name}：台账 ${ledgerV} vs 实测 ${actualV}（台账 ${ledgerAgeH.toFixed(1)}h 未更新，超 ${staleHours}h 上限）`);
    }
  };
  corpusCheck('claim', ledger.claim, actual.claim, drift.claim);
  corpusCheck('卷', ledger.threads, actual.threads, drift.threads);
  corpusCheck('局数', ledger.episodes, actual.episodes, drift.episodes);
  // 波动量给容差（同一命令两次测量：A4 p50 抖 ±0.5ms，A2 随语料微动 ±0.5pp）
  // A2 在 26.5–26.8% 之间随 pipeline 时间窗微动（2026-11-02 实测抖动 ±0.15pp）⇒ 容差 0.5pp
  // 2026-11-04（0.137.0）：A2 是 LOO，分母是整库；线上持续归档时它自己会动（今天 22.53 → 23.04，涨的部分来自新局）。
  // 线上放宽到 2pp；真正关心的退化由 A2b 严格口径（逐条注入召回）与消融复测抓，不让整库变大冒充回归。
  const a2Tol = soft ? 2 : 0.5;
  if (has(ledger.a2) && has(actual.a2) && Math.abs(ledger.a2 - actual.a2) > a2Tol) bad.push(`A2：台账 ${ledger.a2}% vs 实测 ${actual.a2}%（容差 ${a2Tol}pp${live ? '，线上整库增长' : ''}）`);
  // 2026-11-05（T225）：A4 p50 是**统计量**（GC / 磁盘缓存 / CPU 调度），同一份代码两次跑差 5–10ms 属正常
  // （今晚实测 21.5 vs 14）。拿"绝对相等 ± 固定容差"去卡统计量 = 要求它可复现到毫秒 ⇒ 只会周期性假红。
  // 改成**量级判据**：台账值 ≤ max(实测×2, 实测+20ms)；另保留"实测 p50 ≤ 50ms"的真实门槛
  // （与 scripts/metrics-guard.mjs 的 a4p50MaxMs 同源）。放宽的只是"台账 vs 实测"的比对方式，门槛一点没松。
  if (has(ledger.a4) && has(actual.a4)) {
    const a4Verdict = a4MagnitudeOk(ledger.a4, actual.a4);
    if (!a4Verdict.ok) bad.push(`A4 p50：${a4Verdict.reason}`);
    else if (Array.isArray(notes) && Math.abs(ledger.a4 - actual.a4) > 0.5) {
      notes.push(`A4 p50：台账 ${ledger.a4}ms vs 实测 ${actual.a4}ms（量级内，上限 ${a4Verdict.limit.toFixed(1)}ms）`);
    }
  }
  return bad;
}

/** --full 的加严项：缺测点/陈旧/解析失败都算不一致（fail-closed）。 */
export function fullCheck(ledger, bad, { now = Date.now(), m5CollectFailed = null } = {}) {
  const out = [...bad];
  if (ledger.tests === null) out.push('台账缺测试行');
  if (ledger.stamp === null) out.push('台账缺 [本] 时点');
  else {
    const t = Date.parse(`${ledger.stamp.replace(' ', 'T')}:00`);
    if (!Number.isFinite(t)) out.push(`台账时点不可解析：${ledger.stamp}`);
    // 2026-11-03：20 分钟改成 6 小时。真正的护栏是**数字一致性**（下面 compare 会逐项比），
    // 时点只用来抓"改完大事忘了 sync"；窗口太短会被发版流程本身（PR/CI 排队）卡死。
    else if (now - t > 6 * 60 * 60 * 1000) out.push(`台账时点过旧：${ledger.stamp}（>6 小时，先跑 ledger-sync）`);
  }
  if (m5CollectFailed) out.push(`m5 采集失败（不是台账的问题）：${m5CollectFailed}`);
  else if (ledger.a2 === null || ledger.a4 === null) out.push('台账缺 A2/A4 实测值');
  if (ledger.episodes === null) out.push('台账缺局数');
  return out;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invoked) {
  const json = process.argv.includes('--json');
  const full = process.argv.includes('--full');
  const skipTests = process.argv.includes('--no-tests') && !full;
  let badParseTests = false;
  const ledger = parseLedger(read('MAINTENANCE.md'));
  const actual = { version: JSON.parse(read('package.json')).version, tests: null, claim: null, threads: null, episodes: null, a2: null, a4: null };
  if (!skipTests) {
    try {
      // 2026-11-05（T224）：口径与 **CI 完全一致** —— `node --test "test/*.test.mjs"`（glob 由 node 自己展开）。
      // 历史包袱（两个都不对，现在都删掉）：
      //   · 裸 `--test`：按"test 目录"约定把 `test/` 下的辅助脚本（如 `test/run.mjs`）也算成一条，
      //     还会递归进 `tmp/` 跑旧契约副本 ⇒ 比 CI 多 1 条以上；
      //   · 上一版改成 `git ls-tree HEAD test/` 只测**已跟踪**文件：sync 那边没改 ⇒ 两边量的不是同一个东西
      //     （760 vs 759），台账永远对不上（这正是 T224 发版卡住的原因）。
      // 现在两边同一个 glob；`tmp/` 下的 `*.test.mjs` 一律不计入并告警（守卫见 test/ledger-tmp-guard.test.mjs）。
      const copies = findTmpTestCopies();
      if (copies.length > 0) {
        console.error(`ledger-check: 发现 tmp/ 下 ${copies.length} 个 *.test.mjs（旧契约副本）——已跳过、不计入：${copies.slice(0, 3).join(', ')}${copies.length > 3 ? ' …' : ''}`);
      }
      const { stdout } = await execFileAsync(process.execPath, ['--test', TEST_GLOB], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
      const t = /\u2139 tests (\d+)[\s\S]*?\u2139 pass (\d+)[\s\S]*?\u2139 fail (\d+)[\s\S]*?\u2139 skipped (\d+)/.exec(stdout);
      if (t) actual.tests = { total: Number(t[1]), pass: Number(t[2]), fail: Number(t[3]), skip: Number(t[4]) };
      else badParseTests = true;
    } catch (error) {
      // node --test 有失败用例时 execFile 会抛错，但 stdout 里仍有计数 —— 必须解析，不能当 n/a
      const text = String(error?.stdout ?? '');
      const parsed = parseTestCounts(text);
      if (parsed) actual.tests = { total: parsed.total, pass: parsed.pass, fail: parsed.fail, skip: parsed.skip };
      else { actual.tests = null; badParseTests = true; }
      // 2026-11-04：只报"红了"等于没法修 —— 把**哪一条**红打出来；
      // execFile 有时拿不到 stdout（本轮真踩过，输出为空查不到名字），此时用 tap 报告器再跑一次兜底。
      let why = describeFailure(text);
      if (why.includes('没解析出测试名')) {
        try {
          const again = await execFileAsync(process.execPath, ['--test', TEST_GLOB, '--test-reporter=tap'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
          why = describeFailure(again?.stdout ?? '');
        } catch (second) {
          why = describeFailure(`${second?.stdout ?? ''}${second?.stderr ?? ''}`);
        }
      }
      console.error(`ledger-check: node --test 有失败或解析失败（${String(error?.message ?? error).slice(0, 60)}）${why}`);
    }
  }
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.join(REPO, 'scripts', 'cli.mjs'), 'audit', '--json'], { cwd: REPO, maxBuffer: 32 * 1024 * 1024 });
    const a = JSON.parse(stdout);
    actual.claim = a.claims?.total ?? null;
    actual.threads = a.threads?.total ?? a.threads ?? null;
  } catch { /* 没 store 就跳过语料核对，下面标注 */ }
  try {
    const { createStore } = await import('../src/rooms/persist.mjs');
    actual.episodes = createStore({ root: path.join(HOME, 'memory-context') }).list('episodes').length;
  } catch { actual.episodes = null; }
  // 2026-11-04：m5 --json 会**间歇性静默死亡**。原实现把异常吞成 a2/a4=null，报错却说"台账缺 A2/A4"——
  // 把采集失败伪装成台账问题，是最坏的一种误导。现在把 m5 的 exit/stderr 打出来，并单独标"采集失败"。
  let m5CollectFailed = null;
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.join(REPO, 'scripts', 'm5-report.mjs'), '--json'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
    const j = JSON.parse(stdout);
    const a2 = j.axes?.A2?.value;
    const a4 = j.axes?.A4?.value;
    actual.a2 = Number.isFinite(a2) ? Number((a2 * 100).toFixed(2)) : null;
    actual.a4 = Number.isFinite(a4) ? Number(a4.toFixed(2)) : null;
  } catch (error) {
    actual.a2 = null;
    actual.a4 = null;
    const tail = (text, n = 400) => String(text ?? '').trim().slice(-n);
    m5CollectFailed = `exit=${error?.code ?? 'n/a'}${tail(error?.stderr) ? ` · stderr: ${tail(error.stderr)}` : ''}${tail(error?.stdout) ? ` · stdout 尾部: ${tail(error.stdout, 200)}` : ''}`;
  }
  // 安装指南不得写死版本号/测试条数（2026-11-02 audit-04：这正是「按它安装」最先读到的文件）
  try {
    const guide = read('docs/安装指南.md');
    if (/\d+\.\d+\.\d+/.test(guide)) bad.push('docs/安装指南.md：不要写死版本号（指向 MAINTENANCE）');
    if (/\d+\s*条/.test(guide)) bad.push('docs/安装指南.md：不要写死测试条数（指向 MAINTENANCE）');
  } catch { /* 没这文件就不管 */ }
  // AGENTS §7 指针 + 不含测试条数
  const agents = read('AGENTS.md');
  const sec7 = agents.slice(agents.indexOf('## 7 ·'), agents.indexOf('## 8 ·'));
  const agentsOk = agents.includes('本节的旧快照会过期') && !sec7.includes('条测试');
  // 线上在跑（<store>/live-stats.jsonl 15 分钟内有写入）⇒ 计数快照必然漂移，给计数容差（方向性指标不开口子）
  const LIVE_WINDOW_MS = 15 * 60 * 1000;
  let live = false;
  try {
    const st = fs.statSync(path.join(process.env.DSH_HOME || 'D:/DeepSeek Harness/home', 'memory-context', 'live-stats.jsonl'));
    live = Date.now() - st.mtimeMs < LIVE_WINDOW_MS;
  } catch { live = false; }
  const notes = [];
  let bad = compare(ledger, actual, { live, notes });
  if (badParseTests) bad.push('测试计数解析失败（fail-closed）');
  if (full) bad = fullCheck(ledger, bad, { m5CollectFailed });
  if (!agentsOk) bad.push('AGENTS §7：指针缺失或写回了测试条数');
  if (!read('CHANGELOG.md').includes(`## ${actual.version}`)) bad.push(`CHANGELOG 缺 ${actual.version} 段`);

  const out = { ledger, actual, agentsOk, skippedCorpus: actual.claim === null, ok: bad.length === 0, bad, notes };
  if (json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`ledger-check：台账 ${ledger.version} · 测试 ${ledger.tests ? `${ledger.tests.total}/${ledger.tests.pass}/${ledger.tests.fail}/${ledger.tests.skip}` : 'n/a'} · claim ${ledger.claim} · 卷 ${ledger.threads}${out.skippedCorpus ? '（无 store，跳过语料核对）' : ''}`);
    console.log(`实测：版本 ${actual.version} · 测试 ${actual.tests ? `${actual.tests.total}/${actual.tests.pass}/${actual.tests.fail}/${actual.tests.skip}` : 'n/a'} · claim ${actual.claim} · 卷 ${actual.threads}`);
    for (const b of bad) console.error(`ERR ${b}`);
    for (const n of notes) console.log(`NOTE ${n}`);
    console.log(out.ok ? 'ledger-check: PASS' : 'ledger-check: FAIL（台账与实测不一致）');
  }
  process.exit(out.ok ? 0 : 1);
}

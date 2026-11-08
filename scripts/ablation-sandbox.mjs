#!/usr/bin/env node
// T353 · ablation 沙箱跑批：在**仓库一次性副本**里跑 A/B，题里的绝对路径跟着改写。
//
// 为什么要副本：0.8.6 把出题改成"重锚 + toolCallId 因果关联"后，真库出的题**会真改源文件**
// （`cat > …python…` 改写 `scripts/*.mjs`）。直接在主工作树跑 = 真改本地资产。
// 副本里跑，改坏了删掉即可。
//
// 三件事，各自幂等：
//   --prepare   建一次性 worktree 副本 + 隔离 DSH_HOME + 出题（路径改写、危险题剔除）
//   --run       逐 (任务, 臂) 起独立 headless 会话；跑完立刻按签名判复发并记账
//   --report    出分 + 生成脱敏报告
//
// 用法：
//   node scripts/ablation-sandbox.mjs --prepare [--n 20]
//   node scripts/ablation-sandbox.mjs --run [--limit 600] [--max-pairs 10]
//   node scripts/ablation-sandbox.mjs --report
//
// 安全边界：只在 `tmp/sandbox/<ts>/` 下工作；DSH_HOME 指向沙箱 home；
// 题里出现发布/合并/改宿主配置/改本机配置的动词一律剔除。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { buildMemoryCard, signalFromText, filterHitsByScope } from '../src/rooms/inject.mjs';
import { walkFromSignals } from '../src/rooms/walk.mjs';
import { cardText } from '../src/plugin.mjs';
import { listCandidates, judgeRecurrence, eventsFromLog, record, score, defaultHome } from './ablation-live.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
// 沙箱放**仓库外**：仓库内的 test 扫文件时会看见副本，把全量测试搞红（实测）。
// 放系统临时目录，跑完 / 删掉都不影响仓库。
const SANDBOX_ROOT = path.join(os.tmpdir(), 'kifu-ablation-sandbox');
const POINTER = path.join(SANDBOX_ROOT, 'current.txt');

// 只挡**朝外**或**动本机**的动词。改副本文件的题照跑 —— 副本本来就是拿来改坏的；
// 把「会写盘的题」全剔掉，恰恰会丢掉最容易复现失败的那批题。
// T9 事故（2026-11-08）：原表只挡 `gh pr|release|api`，漏了 `gh repo edit` / `gh issue create`
// —— 本机 gh 已登录且带 repo scope，那道题会**真在 GitHub 上建 issue**（对外、不可撤）。
// `gh` 的写子命令**全部**挡掉（pr/release/api/repo/issue/label/workflow/project/run），
// 只读的 `gh view/list/status/checks/diff` 不在这个名单里，不受影响。
// `gh` 的**写子命令**全挡；只读子命令（`pr checks` / `issue list` / `repo view`）不许误伤。
const DANGER = /(\bgh\s+(?:(?:pr|issue|release|repo|label|workflow|project|run)\s+(?:create|edit|merge|close|delete|comment|review|run|enable|disable|ready|lock|pin|set-|add|remove)|api\b|release\s+create)|\bnpm\s+publish\b|\bmagpie\b|\btaskkill\b|Stop-Process|Start-Process|\bgit\s+push\b|\bgit\s+remote\b|--force)/i;

// 写盘标志：重定向 / heredoc / python 以写模式开文件 / write 工具。
const WRITE_MARK = /(>>|>\s*[^\s|]+\s*(?:<<|$)|\bcat\s*>|\bopen\([^)]*['"][wa]|\bwrite\s+\S)/;

/**
 * 题里若**带写盘动作**且引用了**副本之外**的绝对工作区路径 ⇒ 会脏真仓，剔除。
 * prepare 只把 ROOT 改写成副本；其它仓（如 `/d/主工作区/...`）没有副本，写过去就是真写。
 * 只读题（grep/read/git show 等）不受影响。
 */
export function writesOutsideSandbox(prompt, rewrittenRoot) {
  const p = String(prompt ?? '');
  if (!WRITE_MARK.test(p)) return false;
  const abs = p.match(/(?:[A-Za-z]:)?[\/\\][\w./\\一-鿿 -]{6,}/g) ?? [];
  const root = String(rewrittenRoot ?? '').split('\\').join('/');
  return abs.some((a) => {
    const n = a.split('\\').join('/');
    if (!/^(?:[A-Za-z]:[\/\\]|\/[a-z]\/)/i.test(a)) return false; // 只认绝对路径
    return !n.startsWith(root) && !/^\/(?:tmp|dev|proc|etc|usr|var)\//.test(n);
  });
}

const opt = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

function sandboxDir() {
  if (fs.existsSync(POINTER)) {
    const p = fs.readFileSync(POINTER, 'utf8').trim();
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function makeSandbox() {
  fs.mkdirSync(SANDBOX_ROOT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(SANDBOX_ROOT, stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(POINTER, dir);
  return dir;
}

// DSH 安装根 = $DSH_HOME 的上一级（`<…>/DeepSeek Harness`），Desktop 在它下面。
const dshInstallRoot = () => path.dirname(defaultHome());
const desktopExe = () => path.join(dshInstallRoot(), 'Desktop', 'DeepSeek Harness.exe');
const headlessBin = () => path.join(dshInstallRoot(), 'Desktop', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

// ---------------------------------------------------------------------------
// --prepare
// ---------------------------------------------------------------------------
function prepare() {
  const dir = makeSandbox();
  const repo = path.join(dir, 'repo');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });

  console.log(`[prepare] 沙箱 ${dir}`);
  const wt = spawnSync('git', ['worktree', 'add', '--detach', repo, 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (wt.status !== 0) {
    console.error(`[prepare] git worktree 建副本失败：${String(wt.stderr ?? '').slice(0, 300)}`);
    return 1;
  }

  // 隔离 home 需要模型路由：从主库 profiles/headless 复制（只复制，不写回）。
  const srcPatch = path.join(defaultHome(), 'profiles', 'headless', 'cordis.patch.yml');
  const dstPatch = path.join(home, 'profiles', 'headless', 'cordis.patch.yml');
  if (!fs.existsSync(srcPatch)) {
    console.error(`[prepare] 找不到主库 headless 配置：${srcPatch}`);
    return 1;
  }
  fs.mkdirSync(path.dirname(dstPatch), { recursive: true });
  fs.copyFileSync(srcPatch, dstPatch);

  // 出题：从**真库**挑（只读），但把仓库根路径改写成副本路径，免得题去改主工作树。
  const store = createStore({ root: path.join(defaultHome(), 'memory-context') });
  const raw = listCandidates({ store, n: Number(opt('n', '40')) });
  const norm = (s) => String(s ?? '').split('\\').join('/');
  const from = norm(ROOT);
  const to = norm(repo);
  const tasks = [];
  let dropped = 0;
  for (const t of raw) {
    const prompt = String(t.taskPrompt ?? '');
    if (!prompt) { dropped += 1; continue; }
    if (DANGER.test(prompt)) { dropped += 1; continue; }
    const rewritten = prompt.split(from).join(to);
    if (writesOutsideSandbox(rewritten, to)) { dropped += 1; continue; }
    tasks.push({ ...t, taskPrompt: rewritten });
  }
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(tasks, null, 2));
  console.log(`[prepare] 题 ${tasks.length} 条（剔除危险/空题 ${dropped} 条）`);
  console.log(`[prepare] 副本 ${repo}`);
  console.log(`[prepare] home ${home}`);
  return 0;
}

// ---------------------------------------------------------------------------
// --run
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// A 臂的「记忆」从哪来：**在主仓用主库实算一张真卡，拼进 prompt**（手喂卡）。
//
// 为什么不靠在沙箱里装插件（T9 成员实测的三连坑）：
//   ① headless profile 默认没有 kifu-loader ⇒ 插件根本不在；
//   ② 只复制 memory-context 不够 —— `resolveSessionScope` 按沙箱 cwd 推 scope，
//      与主库 episode 的 scope 不同 ⇒ A5 跨作用域闸把卡清空（T352 §7 已踩过）；
//   ③ 为此还得改写副本里全部 scopeKey。
// 手喂卡把这三件**整组绕开**：卡是文本，与沙箱 cwd 无关；A/B 两臂只差这一张卡。
// 主库**只读**。
// ---------------------------------------------------------------------------
function cardForTask({ task, store, episodesById }) {
  const scope = episodesById.get(String(task?.episode ?? ''))?.scopeKey ?? null;
  if (!scope) return { text: '', scope: null };
  const signal = signalFromText(String(task.taskPrompt ?? ''), { at: Date.now() });
  signal.scopeKey = scope;
  const walk = walkFromSignals({ signal, store, scope, cache: null, depth: 2, limit: 5, budgetTokens: 500 });
  const scoped = filterHitsByScope(walk.hits ?? [], scope);
  const walkResult = { ...walk, hitCount: (walk.hits ?? []).length, hits: scoped.hits, crossScope: scoped.dropped, unknownScope: scoped.droppedUnknown };
  const card = buildMemoryCard({ signal, walkResult, store, scope, now: Date.now(), limit: 5, budgetTokens: 500, droppedCrossScope: scoped.dropped, droppedUnknownScope: scoped.droppedUnknown });
  return { text: card.section ? cardText(card) : '', scope, tokens: card.tokens, hitCount: walkResult.hitCount };
}

function run() {
  const dir = sandboxDir();
  if (!dir) { console.error('[run] 没有沙箱，先跑 --prepare'); return 2; }
  const repo = path.join(dir, 'repo');
  const home = path.join(dir, 'home');
  const tasks = JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8'));
  const pairs = Math.max(1, Number(opt('max-pairs', '10')));
  const perRunMs = Math.max(60, Number(opt('limit', '600'))) * 1000;
  const exe = desktopExe();
  const bin = headlessBin();

  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, MAGPIE_GATEWAY_KEY: process.env.MAGPIE_GATEWAY_KEY || 'sandbox' };
  const sessionsBase = path.join(home, 'sessions');
  const snapshot = () => {
    const out = new Set();
    if (!fs.existsSync(sessionsBase)) return out;
    for (const s of fs.readdirSync(sessionsBase)) {
      const d = path.join(sessionsBase, s);
      if (!fs.statSync(d).isDirectory()) continue;
      for (const x of fs.readdirSync(d)) out.add(path.join(d, x, 'session.v4.jsonl.zstd'));
    }
    return out;
  };

  const runsDir = path.join(dir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const picked = tasks.slice(0, pairs);
  console.log(`[run] ${picked.length} 题 × 2 臂，单次上限 ${perRunMs / 1000}s，副本 ${repo}`);

  // A 臂的真卡：主库只读，一次建 store，逐题实算（不装沙箱插件，见 cardForTask 注释）。
  const liveStore = createStore({ root: path.join(defaultHome(), 'memory-context') });
  const episodesById = new Map(liveStore.list('episodes').map((e) => [e?.record?.id, e?.record]).filter(([id]) => typeof id === 'string'));

  let ok = 0;
  for (const t of picked) {
    const card = cardForTask({ task: t, store: liveStore, episodesById });
    fs.writeFileSync(path.join(runsDir, `${t.taskId}.card.json`), JSON.stringify({ scope: card.scope, tokens: card.tokens ?? 0, hitCount: card.hitCount ?? 0, hasCard: Boolean(card.text) }, null, 2));
    for (const variant of ['B', 'A']) {
      // A = 真卡 + 题；B = 只有题。两臂**只差这一张卡**。
      const prompt = variant === 'A' && card.text ? `${card.text}\n\n${t.taskPrompt}` : t.taskPrompt;
      const before = snapshot();
      const started = Date.now();
      const r = spawnSync(exe, [bin, 'headless', '-'], {
        input: prompt,
        env, cwd: repo, timeout: perRunMs, maxBuffer: 64 * 1024 * 1024, encoding: null,
      });
      fs.writeFileSync(path.join(runsDir, `${t.taskId}.${variant}.out.txt`), r.stdout ?? Buffer.alloc(0));
      fs.writeFileSync(path.join(runsDir, `${t.taskId}.${variant}.err.txt`), r.stderr ?? Buffer.alloc(0));
      fs.writeFileSync(path.join(runsDir, `${t.taskId}.${variant}.prompt.txt`), prompt);
      const log = [...snapshot()].find((x) => !before.has(x)) ?? null;
      let recurred = null;
      if (log && fs.existsSync(log)) {
        // 判分**只扫 tool/result**：A 臂卡正文里可能就有该错误原文，
        // 扫全事件会把「注入的卡」算成「复发」（A 假阳性，成员实测提醒）。
        const row = judgeRecurrence({ tasks: [t], events: eventsFromLog(log), onlyToolResults: true })[0];
        recurred = row?.recurred ?? null;
      }
      if (recurred !== null) {
        record({ taskId: t.taskId, variant, recurred, note: 'sandbox' });
        ok += 1;
      }
      const sec = Math.round((Date.now() - started) / 1000);
      // 超时判据（机械）：spawnSync 超时是 status=null + SIGTERM（**不会**给 rc=124，
      // rc=124 是 coreutils `timeout` 的，T352 那批是外层 timeout 给的）。
      const timedOut = r.error?.code === 'ETIMEDOUT' || (r.status === null && r.signal === 'SIGTERM') || sec >= perRunMs / 1000 - 5;
      console.log(`  ${t.taskId} ${variant} ${recurred === null ? 'NOLOG' : `recurred=${recurred}`} rc=${r.status}${timedOut ? ' TIMEOUT' : ''} card=${variant === 'A' ? (card.text ? card.tokens + 'tok' : 'EMPTY') : '-'} ${sec}s`);
    }
  }
  fs.writeFileSync(path.join(dir, 'done.json'), JSON.stringify({ at: new Date().toISOString(), judged: ok }, null, 2));
  console.log(`[run] 完成，记了 ${ok} 条`);
  return 0;
}

// ---------------------------------------------------------------------------
// --report
// ---------------------------------------------------------------------------
function report() {
  const s = score();
  const dir = sandboxDir();
  const lines = [];
  lines.push('# T353 · ablation 沙箱跑批报告');
  lines.push('');
  lines.push(`> 生成于 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · 沙箱 \`<SANDBOX>\``);
  lines.push('');
  lines.push('| 口径 | 值 |');
  lines.push('|---|---|');
  lines.push(`| 配对任务数 | ${s.tasks} |`);
  lines.push(`| A（有记忆）复发 | ${s.A.recurred}/${s.A.n} = ${s.A.rate === null ? '—' : (s.A.rate * 100).toFixed(1) + '%'} |`);
  lines.push(`| B（无记忆）复发 | ${s.B.recurred}/${s.B.n} = ${s.B.rate === null ? '—' : (s.B.rate * 100).toFixed(1) + '%'} |`);
  lines.push(`| 仅 A 复发 / 仅 B 复发 | ${s.discordant.onlyA} / ${s.discordant.onlyB} |`);
  lines.push(`| McNemar 精确 p | ${s.mcnemarP} |`);
  lines.push('');
  lines.push(`**判定**：${s.verdict}`);
  lines.push('');
  lines.push('判据：B（无记忆）复发显著更多（`onlyB > onlyA` 且 `p < 0.05`）才算「记忆有用」；');
  lines.push('`onlyA == onlyB` 判「无差别」，此时该查**卡上写了什么**，不是「要不要插件」。');
  if (dir) lines.push('', `沙箱：\`${dir.replace(ROOT, '<REPO>')}\``);
  const out = path.join(ROOT, 'evidence', 'T353-ablation-report.md');
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  console.log(`\n[report] 已写 ${out.replace(ROOT, '<REPO>')}`);
  return 0;
}

function main() {
  if (has('prepare')) return prepare();
  if (has('run')) return run();
  if (has('report')) return report();
  console.error('用法：--prepare | --run | --report');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`ablation-sandbox 失败：${String(e?.message ?? e)}`);
    process.exitCode = 2;
  }
}

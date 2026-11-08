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
const META_ROOT = path.join(ROOT, 'tmp', 'ablation-meta');
const POINTER = path.join(SANDBOX_ROOT, 'current.txt');
const META_POINTER = path.join(META_ROOT, 'current.txt');

// 只挡**朝外**或**动本机**的动词。改副本文件的题照跑 —— 副本本来就是拿来改坏的；
// 把「会写盘的题」全剔掉，恰恰会丢掉最容易复现失败的那批题。
// T9 事故（2026-11-08）：原表只挡 `gh pr|release|api`，漏了 `gh repo edit` / `gh issue create`
// —— 本机 gh 已登录且带 repo scope，那道题会**真在 GitHub 上建 issue**（对外、不可撤）。
// `gh` 的写子命令**全部**挡掉（pr/release/api/repo/issue/label/workflow/project/run），
// 只读的 `gh view/list/status/checks/diff` 不在这个名单里，不受影响。
// `gh` 的**写子命令**全挡；只读子命令（`pr checks` / `issue list` / `repo view`）不许误伤。
const normSlash = (s) => String(s ?? '').split('\\').join('/');

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

/**
 * T17 ①：题面里**落在副本外**的绝对路径（含 `$HOME`/`$DSH_HOME`/`~` 这类等价于绝对路径的写法）。
 * 非空 ⇒ 这个动作在副本里结构上不可复现（prepare 只重写 ROOT），不许进题池。
 * 注意：`/tmp`、其它盘符路径、别的仓都算「副本外」——它们不会被 prepare 改写。
 */
export function outsideActionPaths(prompt, repoRoot) {
  const p = String(prompt ?? '');
  const root = normSlash(repoRoot).replace(/\/+$/, '').toLowerCase();
  const out = [];
  // 环境变量/家目录：展开后要么指向沙箱 home（里面有 sessions/ 答案键）、要么指向本机用户目录
  if (/(^|[\s"'`;|&=])\$(?:DSH_HOME|HOME)\b|(^|[\s"'`;|&=])~[\\/]/.test(p)) out.push('$HOME/$DSH_HOME/~');
  // 带空格的路径必须按引号整体取（`"D:/DeepSeek Harness/..."`）；取完后从串里抹掉，
  // 否则裸匹配会在空格处截断成 `D:/DeepSeek` 误判。
  const quotedRe = /"([^"]{4,})"|'([^']{4,})'|`([^`]{4,})`/g;
  const quoted = [...p.matchAll(quotedRe)].map((m) => m[1] ?? m[2] ?? m[3]);
  const withoutQuoted = p.replace(quotedRe, ' ');
  // 未加引号但含空格的 ROOT 路径：先整体抹掉，避免裸匹配在空格处截断成 `D:/DeepSeek`
  const withoutRoot = withoutQuoted.split(normSlash(repoRoot)).join(' ');
  const bare = withoutRoot.match(/(?:[A-Za-z]:)?[\\/][^\s"'`;|&<>()]{4,}/g) ?? [];
  for (const raw of [...quoted, ...bare]) {
    const a = String(raw).trim().replace(/[),.]+$/, '');
    if (!/^(?:[A-Za-z]:[\\/]|\/[a-z]\/|\/tmp\/)/i.test(a)) continue; // URL（//host/…）/相对路径不算
    const n = normSlash(a).toLowerCase();
    if (/^\/(?:dev\/null|dev\/stdout|dev\/stderr)$/.test(n)) continue;
    if (/^\/(?:tmp|home|root|etc|usr|var|opt|proc|sys|bin|sbin|mnt|media)\//.test(n)) { out.push(a); continue; }
    if (!n.startsWith(root)) out.push(a);
  }
  return [...new Set(out)];
}

/** 题面动作是否**全部落回副本**（T17 ① 的判据）。 */
export function taskStaysInRepo(prompt, repoRoot) {
  return outsideActionPaths(prompt, repoRoot).length === 0;
}

/**
 * T17 ②：一条会话事件流里，有没有去读评测答案键（tasks.json / cards.json / runs 产物 / sessions）。
 * 返回命中的工具名列表（空数组 = 干净）。宽口径（会包含自身 DSH_HOME 的 sessions，报告里再分档）。
 */
export function answerKeyHits(events, metaDir = null) {
  const needles = [/(?:^|[\/])tasks\.json\b/i, /(?:^|[\/])cards\.json\b/i, /[\/]runs[\/]/i, /[\/]sessions[\/]/i, /\.prompt\.txt\b/i, /\.out\.txt\b/i, /\.meta\.json\b/i];
  if (metaDir) needles.push(new RegExp(normSlash(metaDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  const clean = (x) => normSlash(x).replace(/\/{2,}/g, '/');
  const hits = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (e?.type !== 'tool/call') continue;
    const m = e?.data?.message ?? e?.data ?? {};
    let raw = m.arguments ?? m.args ?? m.input ?? '';
    // 事件里的 arguments 常常是**JSON 字符串**；先 parse 再 stringify，
    // 否则转义引号 `\"` 会被 clean 成 `/"`，把 "internal/sessions" 误判成 `/sessions/`。
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { /* keep */ } }
    const args = clean(JSON.stringify(raw));
    if (!args) continue;
    if (needles.some((re) => re.test(args))) hits.push(String(m.name ?? m.toolName ?? 'tool'));
  }
  return hits;
}

/** 同 answerKeyHits，但返回命中详情（工具名 + 参数片段），用于报告里人工核对。 */
export function answerKeyHitDetails(events, metaDir = null) {
  const needles = [/(?:^|[\/])tasks\.json\b/i, /(?:^|[\/])cards\.json\b/i, /[\/]runs[\/]/i, /[\/]sessions[\/]/i, /\.prompt\.txt\b/i, /\.out\.txt\b/i, /\.meta\.json\b/i];
  const clean = (x) => normSlash(x).replace(/\/{2,}/g, '/');
  const out = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (e?.type !== 'tool/call') continue;
    const m = e?.data?.message ?? e?.data ?? {};
    let raw = m.arguments ?? m.args ?? m.input ?? '';
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { /* keep */ } }
    const args = clean(JSON.stringify(raw));
    if (!args) continue;
    if (needles.some((re) => re.test(args))) out.push(`${String(m.name ?? 'tool')}: ${args.slice(0, 160)}`);
  }
  return out;
}

/**
 * T17 ②b：repo 副本里也抄着历次失败原文（CHANGELOG / evidence/*）。
 * 不脱敏的话，A 臂可以 grep 到「这题的错误原文」——等于答案键躺在 cwd 里。
 * 只在**副本**里把本批题目的 errorText 换成 [T17-REDACTED]，主仓不动。
 */
export function scrubAnswerKeys(repoDir, tasks) {
  // 同一段错误原文在证据文件里可能被截成不同长度（全文/120字/40字），
  // 所以每个任务取 3 个长度档当 needle，避免「长针匹配不到短引用」。
  const needles = [...new Set((Array.isArray(tasks) ? tasks : [])
    .map((t) => String(t?.errorText ?? '').trim())
    .filter((s) => s.length >= 20)
    .flatMap((s) => [s.slice(0, 40), s.slice(0, Math.min(80, s.length)), s.slice(0, Math.min(160, s.length))])
    .filter((s) => s.length >= 20))];
  const exts = /\.(?:md|mjs|js|cjs|json|jsonl|txt|yml|yaml|ts|py|sh)$/i;
  const stats = { needles: needles.length, files: 0, hits: 0 };
  if (!needles.length) return stats;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!exts.test(e.name)) continue;
      let text;
      try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      let next = text;
      for (const n of needles) {
        if (!next.includes(n)) continue;
        stats.hits += next.split(n).length - 1;
        next = next.split(n).join('[T17-REDACTED]');
      }
      if (next !== text) { fs.writeFileSync(p, next, 'utf8'); stats.files += 1; }
    }
  };
  walk(repoDir);
  return stats;
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
  fs.mkdirSync(META_ROOT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(SANDBOX_ROOT, stamp);
  const meta = path.join(META_ROOT, stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(POINTER, dir);
  fs.writeFileSync(META_POINTER, meta);
  return { dir, meta };
}

function metaDirFor(dir) {
  return dir ? path.join(META_ROOT, path.basename(dir)) : null;
}

function metaDir() {
  if (fs.existsSync(META_POINTER)) {
    const p = fs.readFileSync(META_POINTER, 'utf8').trim();
    if (p && fs.existsSync(p)) return p;
  }
  const d = sandboxDir();
  const fallback = metaDirFor(d);
  return fallback && fs.existsSync(fallback) ? fallback : null;
}

// DSH 安装根 = $DSH_HOME 的上一级（`<…>/DeepSeek Harness`），Desktop 在它下面。
const dshInstallRoot = () => path.dirname(defaultHome());
const desktopExe = () => path.join(dshInstallRoot(), 'Desktop', 'DeepSeek Harness.exe');
const headlessBin = () => path.join(dshInstallRoot(), 'Desktop', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

// ---------------------------------------------------------------------------
// --prepare
// ---------------------------------------------------------------------------
function prepare() {
  const { dir, meta } = makeSandbox();
  const repo = path.join(dir, 'repo');
  // T17 ②：home 不再是一个长期目录（里面 sessions/ 会攒下每局日志 = 答案）；
  // 只留一个模板，每次 run 复制成独立 home、跑完即删。
  const homeTemplate = path.join(meta, 'home-template');
  fs.mkdirSync(homeTemplate, { recursive: true });

  console.log(`[prepare] 沙箱 ${dir}`);
  console.log(`[prepare] meta  ${meta}（cwd 够不到，答案键在这里）`);
  const wt = spawnSync('git', ['worktree', 'add', '--detach', repo, 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (wt.status !== 0) {
    console.error(`[prepare] git worktree 建副本失败：${String(wt.stderr ?? '').slice(0, 300)}`);
    return 1;
  }

  // 隔离 home 需要模型路由：从主库 profiles/headless 复制（只复制，不写回）。
  const srcPatch = path.join(defaultHome(), 'profiles', 'headless', 'cordis.patch.yml');
  const dstPatch = path.join(homeTemplate, 'profiles', 'headless', 'cordis.patch.yml');
  if (!fs.existsSync(srcPatch)) {
    console.error(`[prepare] 找不到主库 headless 配置：${srcPatch}`);
    return 1;
  }
  fs.mkdirSync(path.dirname(dstPatch), { recursive: true });
  fs.copyFileSync(srcPatch, dstPatch);

  // 出题：从**真库**挑（只读），但把仓库根路径改写成副本路径，免得题去改主工作树。
  const store = createStore({ root: path.join(defaultHome(), 'memory-context') });
  const episodesById = new Map(store.list('episodes').map((e) => [e?.record?.id, e?.record]).filter(([id]) => typeof id === 'string'));
  const raw = listCandidates({ store, n: Number(opt('n', '40')) });
  const from = normSlash(ROOT);
  const to = normSlash(repo);
  const stats = { candidates: raw.length, kept: 0, dropped: { emptyPrompt: 0, danger: 0, outsidePath: 0, dirtyWrite: 0, emptyCard: 0 } };
  const tasks = [];
  const cards = {};
  for (const t of raw) {
    const prompt = String(t.taskPrompt ?? '');
    if (!prompt) { stats.dropped.emptyPrompt += 1; continue; }
    if (DANGER.test(prompt)) { stats.dropped.danger += 1; continue; }
    // T17 ①：动作路径必须全部落回本仓（否则副本里结构上不可复现）
    if (!taskStaysInRepo(prompt, ROOT)) { stats.dropped.outsidePath += 1; continue; }
    const rewritten = prompt.split(from).join(to);
    if (writesOutsideSandbox(rewritten, to)) { stats.dropped.dirtyWrite += 1; continue; }
    // T17 ③：A 臂卡为空 ⇒ A≡B，在 prepare 就剔除（用**原始题面**算卡，副本路径不影响语义）
    const card = cardForTask({ task: t, store, episodesById });
    if (!card.text) { stats.dropped.emptyCard += 1; continue; }
    stats.kept += 1;
    tasks.push({ ...t, taskPrompt: rewritten });
    cards[t.taskId] = { text: card.text, scope: card.scope, tokens: card.tokens ?? 0, hitCount: card.hitCount ?? 0 };
  }
  // T17 ②b：副本里脱敏本批题目的错误原文（答案键）
  const scrub = scrubAnswerKeys(repo, tasks);
  fs.writeFileSync(path.join(meta, 'tasks.json'), JSON.stringify(tasks, null, 2));
  fs.writeFileSync(path.join(meta, 'cards.json'), JSON.stringify(cards, null, 2));
  fs.writeFileSync(path.join(meta, 'pool.json'), JSON.stringify({ ...stats, answerKeyScrub: scrub, at: new Date().toISOString() }, null, 2));
  console.log(`[prepare] 候选 ${stats.candidates} 条 → 有效题 ${tasks.length} 条`);
  console.log(`[prepare] 剔除：${JSON.stringify(stats.dropped)}`);
  console.log(`[prepare] 副本脱敏：${scrub.hits} 处 / ${scrub.files} 个文件（${scrub.needles} 条 needle）`);
  console.log(`[prepare] 副本 ${repo}`);
  console.log(`[prepare] home 模板 ${homeTemplate}`);
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
  const meta = metaDir();
  if (!dir || !meta) { console.error('[run] 没有沙箱，先跑 --prepare'); return 2; }
  const repo = path.join(dir, 'repo');
  const homeTemplate = path.join(meta, 'home-template');
  const tasksFile = path.join(meta, 'tasks.json');
  const cardsFile = path.join(meta, 'cards.json');
  const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const cards = JSON.parse(fs.readFileSync(cardsFile, 'utf8'));
  // T17 ②：跑批期间**把答案键从盘上撤走**（只留在本进程内存），跑完再写回。
  // 这样即使模型翻到 meta 目录，也没有 tasks.json/cards.json 可读；崩溃则重跑 --prepare。
  fs.rmSync(tasksFile, { force: true });
  fs.rmSync(cardsFile, { force: true });
  const pairs = Math.max(1, Number(opt('max-pairs', '10')));
  const perRunMs = Math.max(60, Number(opt('limit', '600'))) * 1000;
  const exe = desktopExe();
  const bin = headlessBin();

  const runsDir = path.join(meta, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const resultsFile = path.join(meta, 'results.jsonl');
  const picked = tasks.slice(0, pairs);
  console.log(`[run] ${picked.length} 题 × 2 臂，单次上限 ${perRunMs / 1000}s，副本 ${repo}`);
  if (picked.length < pairs) console.log(`[run] 注意：有效题只有 ${tasks.length} 条，少于 --max-pairs ${pairs}`);

  // T17 ②：跑批期间**不落任何运行产物**（out/err/prompt/session 都是答案或线索），
  // 每臂用独立 home，跑完立刻删；全部结束后才统一写盘。
  const pending = [];
  let ok = 0;
  let idx = 0;
  for (const t of picked) {
    const card = cards[t.taskId] ?? { text: '', tokens: 0, hitCount: 0, scope: null };
    for (const variant of ['B', 'A']) {
      idx += 1;
      const prompt = variant === 'A' && card.text ? `${card.text}\n\n${t.taskPrompt}` : t.taskPrompt;
      const runHome = path.join(meta, 'homes', `r${String(idx).padStart(2, '0')}-${variant}`);
      fs.mkdirSync(path.dirname(runHome), { recursive: true });
      fs.cpSync(homeTemplate, runHome, { recursive: true });
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: runHome, MAGPIE_GATEWAY_KEY: process.env.MAGPIE_GATEWAY_KEY || 'sandbox' };
      const sessionsBase = path.join(runHome, 'sessions');
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
      const before = snapshot();
      const started = Date.now();
      const r = spawnSync(exe, [bin, 'headless', '-'], {
        input: prompt,
        env, cwd: repo, timeout: perRunMs, maxBuffer: 64 * 1024 * 1024, encoding: null,
      });
      const ended = Date.now();
      const log = [...snapshot()].find((x) => !before.has(x)) ?? null;
      let recurred = null;
      let keyHits = [];
      let keyHitDetails = [];
      if (log && fs.existsSync(log)) {
        const events = eventsFromLog(log);
        // 判分**只扫 tool/result**：A 臂卡正文里可能就有该错误原文，
        // 扫全事件会把「注入的卡」算成「复发」（A 假阳性，成员实测提醒）。
        const row = judgeRecurrence({ tasks: [t], events, onlyToolResults: true })[0];
        recurred = row?.recurred ?? null;
        keyHits = answerKeyHits(events, meta);
        keyHitDetails = answerKeyHitDetails(events, meta);
      }
      // 清掉本次 home（含 session 日志/答案），不留盘
      if (process.env.T17_KEEP_HOME !== '1') { try { fs.rmSync(runHome, { recursive: true, force: true }); } catch { /* ignore */ } }
      if (recurred !== null) {
        record({ taskId: t.taskId, variant, recurred, note: 'sandbox:t17', file: resultsFile });
        ok += 1;
      }
      const sec = Math.round((ended - started) / 1000);
      // 超时判据（机械）：spawnSync 超时是 status=null + SIGTERM（**不会**给 rc=124，
      // rc=124 是 coreutils `timeout` 的，T352 那批是外层 timeout 给的）。
      const timedOut = r.error?.code === 'ETIMEDOUT' || (r.status === null && r.signal === 'SIGTERM') || sec >= perRunMs / 1000 - 5;
      pending.push({
        taskId: t.taskId, variant, prompt, out: r.stdout ?? Buffer.alloc(0), err: r.stderr ?? Buffer.alloc(0),
        meta: { taskId: t.taskId, variant, startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(), sec, status: r.status ?? null, signal: r.signal ?? null, timedOut, recurred, keyHits, keyHitDetails, cardTokens: variant === 'A' ? (card.tokens ?? 0) : 0 },
      });
      console.log(`  ${t.taskId} ${variant} ${recurred === null ? 'NOLOG' : `recurred=${recurred}`} rc=${r.status}${timedOut ? ' TIMEOUT' : ''} card=${variant === 'A' ? (card.text ? card.tokens + 'tok' : 'EMPTY') : '-'} keys=${keyHits.length} ${sec}s`);
    }
  }
  // 统一落盘（此时批已结束，选手看不到）
  fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
  fs.writeFileSync(cardsFile, JSON.stringify(cards, null, 2));
  for (const p of pending) {
    fs.writeFileSync(path.join(runsDir, `${p.taskId}.${p.variant}.out.txt`), p.out);
    fs.writeFileSync(path.join(runsDir, `${p.taskId}.${p.variant}.err.txt`), p.err);
    fs.writeFileSync(path.join(runsDir, `${p.taskId}.${p.variant}.prompt.txt`), p.prompt);
    fs.writeFileSync(path.join(runsDir, `${p.taskId}.${p.variant}.meta.json`), JSON.stringify(p.meta, null, 2));
  }
  fs.writeFileSync(path.join(meta, 'done.json'), JSON.stringify({ at: new Date().toISOString(), judged: ok }, null, 2));
  console.log(`[run] 完成，记了 ${ok} 条 → ${resultsFile}`);
  return 0;
}

// ---------------------------------------------------------------------------
// --report
// ---------------------------------------------------------------------------
function readJson(fp, dflt = null) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return dflt; }
}
function pctOf(rate) { return rate === null || rate === undefined ? '—' : (rate * 100).toFixed(1) + '%'; }

function report() {
  const dir = sandboxDir();
  const meta = metaDir();
  if (!dir || !meta) { console.error('[report] 没有沙箱'); return 2; }
  const mask = (x) => normSlash(String(x ?? '')).replace(normSlash(ROOT), '<REPO>').split(normSlash(os.tmpdir())).join('<TMP>');
  const resultsFile = path.join(meta, 'results.jsonl');
  const s = score({ file: resultsFile });
  const pool = readJson(path.join(meta, 'pool.json'), {});
  const tasks = readJson(path.join(meta, 'tasks.json'), []);
  const cards = readJson(path.join(meta, 'cards.json'), {});
  const runsDir = path.join(meta, 'runs');
  const metas = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((x) => x.endsWith('.meta.json')).map((x) => readJson(path.join(runsDir, x), null)).filter(Boolean) : [];
  const pairs = [];
  const byTask = new Map();
  for (const m of metas) { const o = byTask.get(m.taskId) ?? {}; o[m.variant] = m; byTask.set(m.taskId, o); }
  for (const [taskId, o] of byTask) if (o.A && o.B) pairs.push({ taskId, A: o.A, B: o.B, card: cards[taskId] ?? null });

  // ---- 污染对：A/B 臂触达**机器级**答案源（旧沙箱 tasks.json / 主 DSH home 的原始会话日志）----
  // 这类对即使结构上在副本里跑，也不能算「无答案键可达」；整对剔除，不计入有效对。
  const severeRe = /(?:^|[\/])tasks\.json\b|[\/]home[\/]sessions[\/]|chess-context[\/]sessions/i;
  const contaminated = new Set();
  for (const m of metas) {
    if ((m.keyHitDetails ?? []).some((d) => severeRe.test(d))) contaminated.add(m.taskId);
  }
  const validPairs = pairs.filter((p) => !contaminated.has(p.taskId));
  const validResults = path.join(meta, 'results-valid.jsonl');
  const validRows = validPairs.flatMap((p) => [
    { taskId: p.taskId, variant: 'A', recurred: p.A.recurred, run: p.A.endedAt, note: 't17:valid' },
    { taskId: p.taskId, variant: 'B', recurred: p.B.recurred, run: p.B.endedAt, note: 't17:valid' },
  ]);
  fs.writeFileSync(validResults, validRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const sv = score({ file: validResults });

  // ---- 有效性闸 ----
  const repoDir = path.join(dir, 'repo');
  const gate1 = { candidates: pool.candidates ?? null, kept: tasks.length, dropped: pool.dropped ?? null, allInside: tasks.every((t) => taskStaysInRepo(String(t.taskPrompt ?? ''), repoDir)) };
  const emptyCards = pairs.filter((p) => !p.card || !(p.card.tokens > 0) || !(p.card.hitCount > 0));
  const gate2 = { pairs: pairs.length, withCard: pairs.length - emptyCards.length, empty: emptyCards.map((p) => p.taskId) };
  const keyRuns = metas.filter((m) => Array.isArray(m.keyHits) && m.keyHits.length > 0);
  const keyDetails = keyRuns.flatMap((m) => (m.keyHitDetails ?? []).map((d) => `${m.taskId}/${m.variant} · ${d}`));
  const sandboxEntries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const scrub = pool.answerKeyScrub ?? null;
  const gate3 = { runs: metas.length, keyHitRuns: keyRuns.length, keyHitDetail: keyRuns.map((m) => `${m.taskId}/${m.variant}`), keyDetails, sandboxEntries, scrub };
  const timed = metas.filter((m) => m.timedOut);
  const gate4 = { runs: metas.length, A: timed.filter((m) => m.variant === 'A').length, B: timed.filter((m) => m.variant === 'B').length, detail: timed.map((m) => `${m.taskId}/${m.variant}`) };

  const redact = (x) => String(x ?? '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>');
  const L = [];
  L.push('# T17 · ablation 有效批报告（题池落副本 + 防答案键 + 空卡剔除）');
  L.push('');
  L.push(`> 生成于 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · 沙箱 \`${mask(dir)}\` · meta \`${mask(meta)}\``);
  L.push('> 数据源：`<meta>/results.jsonl`（只含本批，不混 T9）；判分 `judgeRecurrence({onlyToolResults:true})`；超时判据 `status=null+SIGTERM` / 墙钟触顶。');
  L.push('');
  L.push('## 0 · 结论');
  L.push('');
  L.push(`- **有效对 ${validPairs.length} 对**（全批 ${pairs.length} 对；剔除 ${pairs.length - validPairs.length} 对：A 臂触达机器级答案源，见 §1.1）；A（有记忆）复发 **${sv.A.recurred}/${sv.A.n} = ${pctOf(sv.A.rate)}**，B（无记忆）复发 **${sv.B.recurred}/${sv.B.n} = ${pctOf(sv.B.rate)}**；onlyA **${sv.discordant.onlyA}** / onlyB **${sv.discordant.onlyB}**；McNemar 精确 p = **${sv.mcnemarP}**。`);
  L.push(`- **方向**：${sv.discordant.onlyB > sv.discordant.onlyA ? '偏「记忆有用」（B 复发更多）' : sv.discordant.onlyA > sv.discordant.onlyB ? '**方向相反**（A 复发更多）' : '无方向（两臂不一致数相等）'}；**显著性**：${sv.mcnemarP < 0.05 ? 'p < 0.05，达到显著' : `p ≥ 0.05，未达显著（不一致对 ${sv.discordant.onlyA + sv.discordant.onlyB} 对，0 vs 6 才显著）`}。`);
  L.push(`- **判别力（阳性对照）**：B 臂复发 ${sv.B.recurred}/${sv.B.n} —— ${sv.B.recurred >= 2 ? '≥2，本批有判别力 ✅' : '**< 2，本批判别力不足**（题在副本里基本不复现，方向即使有也不能当结论）'}。`);
  L.push(`- 自动判定（脚本口径）：${sv.verdict}；但本批 B 臂 ${sv.B.recurred}/${sv.B.n} 复发 ⇒ 「无差别」的真实含义是**题不复现**，不是「记忆没起作用」。`);
  L.push('');
  L.push('## 1 · 有效性闸（①–④ 全过 + ⑤ 有判别力，才算有效批）');
  L.push('');
  L.push('| 闸 | 判据 | 结果 |');
  L.push('|---|---|---|');
  L.push(`| ① 题池落副本 | 题面动作里的绝对路径必须全在本仓（prepare 可重写到副本；/tmp、别的仓、$HOME/~ 都算副本外） | 候选 ${gate1.candidates ?? '—'} → 有效题 **${gate1.kept}**（剔除：${JSON.stringify(gate1.dropped)}）· 全落副本=${gate1.allInside ? '✅' : '❌'} |`);
  L.push(`| ② A 有真卡 | 每对 A 的卡 tokens>0 且 hitCount>0 | **${gate2.withCard}/${gate2.pairs}**${gate2.empty.length ? `（空卡：${gate2.empty.join(', ')}）` : ' ✅'} |`);
  L.push(`| ③ 无答案键可达 | (a) 沙箱目录只含 repo；(b) 跑批期间 tasks.json/cards.json **不在盘上**、runs/ 跑完才落盘、每臂独立 home 跑完即删；(c) 副本内本批 errorText 已脱敏；(d) 逐 run 扫 tool/call + out 文本 | 目录=${JSON.stringify(gate3.sandboxEntries)} · 脱敏 ${gate3.scrub ? `${gate3.scrub.hits} 处/${gate3.scrub.files} 文件` : '—'} · 宽口径触碰 **${gate3.keyHitRuns}/${gate3.runs}**（多为自身 DSH_HOME/sessions）· **污染对 ${pairs.length - validPairs.length}**（A 臂触达机器级答案源：${[...contaminated].join(', ') || '无'}） |`);
  L.push(`| ④ 超时 | 墙钟 ≥ limit−5s 或 status=null+SIGTERM | A **${gate4.A}** 条 / B **${gate4.B}** 条${gate4.detail.length ? `（${gate4.detail.join(', ')}）` : ' ✅'} |`);
  L.push(`| ⑤ 阳性对照 | B 臂复发 ≥2（否则题不复现，实验无判别力） | **${sv.B.recurred}/${sv.B.n}** ${sv.B.recurred >= 2 ? '✅' : '❌'} |`);
  L.push('');
  const gates1234 = gate1.allInside && gate2.empty.length === 0 && contaminated.size === 0 && gate4.A === 0 && gate4.B === 0;
  L.push(`**闸 ①–④（有效子集）：${gate1.allInside && gate2.empty.length === 0 && gate4.A === 0 && gate4.B === 0 ? '✅ 全过' : '❌ 未全过'} · 全批污染对 ${contaminated.size} 条（已剔除）· 判别力（⑤）：${sv.B.recurred >= 2 ? '✅' : '❌ 不足'}**`);
  L.push('');
  if (contaminated.size) {
    L.push('### 1.1 被剔除的污染对（A 臂触达机器级答案源）');
    L.push('');
    for (const m of metas.filter((x) => contaminated.has(x.taskId) && (x.keyHitDetails ?? []).length)) {
      for (const d of m.keyHitDetails.filter((x) => severeRe.test(x))) L.push(`- \`${m.taskId}/${m.variant} · ${redact(d).replace(/`/g, "'")}\``);
    }
    L.push('');
  }
  if (gate3.keyDetails.length) {
    L.push('### 1.2 宽口径命中详情（逐条核对用）');
    L.push('');
    for (const d of gate3.keyDetails.slice(0, 16)) L.push(`- \`${redact(d).replace(/`/g, "'")}\``);
    L.push('');
  }
  L.push('## 2 · 逐对明细');
  L.push('');
  L.push('| # | taskId | A 卡 tok/hits | A 判分 | B 判分 | A 时长s | B 时长s | A 状态 | B 状态 |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  pairs.forEach((p, i) => {
    L.push(`| ${i + 1} | ${p.taskId}${contaminated.has(p.taskId) ? ' ❌剔除' : ''} | ${p.card ? `${p.card.tokens}/${p.card.hitCount}` : '—'} | ${p.A.recurred} | ${p.B.recurred} | ${p.A.sec} | ${p.B.sec} | ${p.A.timedOut ? 'TIMEOUT' : 'ok'} | ${p.B.timedOut ? 'TIMEOUT' : 'ok'} |`);
  });
  L.push('');
  L.push('## 3 · 这说明什么 / 下一步');
  L.push('');
  L.push(`- **能说的**：在「动作落副本 + A 有真卡 + 无（机器级）答案键 + 无超时」的 ${validPairs.length} 对里，两臂都不复发 ⇒ **这批题在副本里不复现**，不是「记忆没用」。`);
  L.push(`- **不能说的**：任何「记忆有用/没用」的方向结论——阳性对照（B 臂复发）${sv.B.recurred}/${sv.B.n}，实验没有判别力。`);
  L.push('- **原因（实测）**：题是从**别的环境/别的时段**的真实会话里回放的，副本只有本仓 HEAD，没有原会话的仓库状态、工具链（go/npm 包）、网络与 /tmp 资产 ⇒ 签名无法再现。');
  L.push('- **下一轮建议**：① 题池改成「在沙箱里**故意注入**一个可复现的失败」再考（阳性对照可控）；或 ② 只从**本仓当次状态**能复现的失败出题（例如当前 HEAD 上的确定性报错），不要跨仓回放；③ 跑前清理旧沙箱与 tmp/abl 等历史答案文件。');
  L.push('');
  L.push('## 4 · 判据口径');
  L.push('');
  L.push('- 题池：`listCandidates` → 空题剔除 → 危险动词剔除 → **绝对路径必须全部落回本仓**（`outsideActionPaths`）→ 写盘越界剔除（`writesOutsideSandbox`）→ **空卡剔除**（`cardForTask`）。');
  L.push('- 答案键：`tasks.json`/`cards.json` 在 `--run` 开始时从磁盘删除、只留在进程内存，批结束才写回；每臂用独立 `home`（DSH_HOME），跑完立即删除（session 日志不留盘）；`runs/` 产物在整批结束后统一落盘。meta 根在 `<REPO>/tmp/ablation-meta/<ts>`，沙箱目录下只有 `repo/`。');
  L.push('- 判分：`tool/result` 里出现题目的归一化错误签名即 `recurred=true`（零模型）；`record()` 幂等（同 taskId+variant 覆盖）。');
  L.push('- 记分：`score()` 配对 + 精确 McNemar；`onlyB > onlyA` 且 `p < 0.05` 才算「记忆有用」。');
  L.push('');
  L.push('## 5 · 复现');
  L.push('');
  L.push('```bash');
  L.push('node scripts/ablation-sandbox.mjs --prepare --n 100');
  L.push('node scripts/ablation-sandbox.mjs --run --max-pairs 14 --limit 600');
  L.push('node scripts/ablation-sandbox.mjs --report --out evidence/T17-ablation-valid.md');
  L.push('```');

  const out = path.resolve(opt('out', path.join(ROOT, 'evidence', 'T17-ablation-valid.md')));
  fs.writeFileSync(out, L.join('\n') + '\n');
  console.log(L.join('\n'));
  console.log(`\n[report] 已写 ${mask(out)}`);
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

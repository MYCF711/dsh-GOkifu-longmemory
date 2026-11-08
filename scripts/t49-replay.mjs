#!/usr/bin/env node
// T49 真库回放：**线上真实会话里，那 N 次「同一张卡重投」会被新的去重闸拦下几次？**
//
// 为什么要这个脚本（而不是只有单测）：
//   单测证明的是"实现符合契约"，不证明"线上那 36 对真的会被拦"。T49 的修法判据是
//   **卡正文逐字出现在 `payload.messages` 里**，所以只要把真实会话日志按顺序回放一遍、
//   在每次注入那一刻看"这张卡的正文在不在此前的消息里"，就能在不重启宿主的前提下拿到真库读数。
//
// 它不做什么：
//   · 不跑 `decidePreStep`（那需要完整 payload 与真实库状态，回放会失真）；
//   · 不改任何文件；只读会话日志，结果打到 stdout。
//
// 用法：
//   node scripts/t49-replay.mjs                     # 全部会话（按 mtime 预筛 7 天）
//   node scripts/t49-replay.mjs --session <id前缀>   # 只回放某一局
//   node scripts/t49-replay.mjs --json              # 机器可读
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readFrames, parseEvents } from '../src/rooms/logread.mjs';
import { CARD_SOURCE_KIND, messageText } from '../src/plugin.mjs';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
const SESSIONS = path.join(HOME, 'sessions');

const argv = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const asJson = argv.includes('--json');
const onlySession = opt('session');
const sinceDays = Number(opt('days', '7'));

/** 递归列出会话日志（按 mtime 预筛：窗口前没写过的文件不可能有窗口内事件）。 */
function listLogs(dir, floorMs) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name !== 'session.v4.jsonl.zstd') continue;
      let st = null;
      try { st = fs.statSync(p); } catch { continue; }
      if (Number.isFinite(st.mtimeMs) && st.mtimeMs < floorMs) continue;
      out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * 回放一局：返回每次注入的判定。
 *
 * 判据与 `cardAlreadyInContext` 完全一致（同一个函数、同一个 `messageText`），
 * 所以"回放说会拦"= "线上会拦"，不是另写一套近似。
 *
 * @param {object[]} events 会话事件（按日志顺序）
 * @returns {{session:string, injections:object[]}}
 */
export function replaySession(events) {
  // 两套模型分开算，因为**压缩有没有把卡压掉**只能估计、不能确定：
  //   · 上界（wouldBlock）：完全不看压缩 —— 卡只要投过就一直算"还在上下文里"；
  //   · 下界（wouldBlockStrict）：一遇压缩就清空历史 —— 卡被压掉 ⇒ 不拦（对应 m5-report 的 necessary 档）。
  // 真值落在两者之间；两套都用**同一个** `messageText`，不是另写近似。
  const messages = [];
  const messagesStrict = []; // 压缩后清空
  const injections = [];
  for (const e of events) {
    const type = e?.type;
    if (type === 'compaction/start' || type === 'compaction/prune') {
      messagesStrict.length = 0; // 保守：压缩后一律当作"卡不在了"
      continue;
    }
    if (type !== 'user/message' && type !== 'assistant/message') continue;
    const data = e?.data ?? {};
    const source = data?.source ?? e?.payload?.message?.source ?? null;
    const role = type === 'user/message' ? 'user' : 'assistant';
    // 插件注入的卡：此刻上下文里**还没有**它自己，先判再入列（顺序错了会把卡自己算成"已在"）
    if (source && source.kind === CARD_SOURCE_KIND) {
      const text = messageText({ role, content: data.content });
      // 与 cardText({indexLine:'', section:text}) 等价：cardText 会 trim
      const wouldBlock = text ? messages.some((m) => messageText(m) === text) : false;
      const wouldBlockStrict = text ? messagesStrict.some((m) => messageText(m) === text) : false;
      injections.push({
        at: Number.isFinite(e?.time) ? new Date(e.time).toISOString() : null,
        seq: Number.isFinite(e?.seq) ? e.seq : null,
        digest: typeof source.digest === 'string' ? source.digest : null,
        tokens: text ? Math.ceil(text.length / 4) : 0, // 粗估，只用于"省了多少"的量级
        wouldBlock,
        wouldBlockStrict,
      });
    }
    const msg = { role, content: data?.content };
    messages.push(msg);
    messagesStrict.push(msg);
  }
  return { injections };
}

function main() {
  const floor = Date.now() - sinceDays * 86_400_000;
  const files = listLogs(SESSIONS, floor).filter((f) => !onlySession || f.includes(onlySession));
  const rows = [];
  let parsed = 0;
  const skipped = [];
  for (const file of files) {
    let events;
    try {
      const out = parseEvents(readFrames(fs.readFileSync(file)));
      events = Array.isArray(out?.events) ? out.events : (Array.isArray(out) ? out : []);
    } catch (error) {
      skipped.push({ file: path.basename(path.dirname(file)), why: String(error?.message ?? error).slice(0, 120) });
      continue;
    }
    parsed += 1;
    const session = path.basename(path.dirname(file));
    const { injections } = replaySession(events);
    if (injections.length) rows.push({ session, injections });
  }

  const all = rows.flatMap((r) => r.injections);
  const blocked = all.filter((x) => x.wouldBlock);
  const blockedStrict = all.filter((x) => x.wouldBlockStrict);
  const summary = {
    scanned: { files: files.length, parsed, skipped: skipped.length },
    sessions: rows.length,
    injections: all.length,
    wouldBlock: blocked.length,
    wouldBlockStrict: blockedStrict.length,
    wouldInject: all.length - blockedStrict.length,
    blockRate: all.length ? blocked.length / all.length : null,
    blockRateStrict: all.length ? blockedStrict.length / all.length : null,
    tokensSaved: blocked.reduce((sum, x) => sum + (Number.isFinite(x.tokens) ? x.tokens : 0), 0),
    tokensSavedStrict: blockedStrict.reduce((sum, x) => sum + (Number.isFinite(x.tokens) ? x.tokens : 0), 0),
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ summary, rows: rows.map((r) => ({ session: r.session, injections: r.injections })), skipped }, null, 2)}\n`);
    return;
  }

  process.stdout.write('== T49 真库回放（同一张卡在本会话重投，新的去重闸会拦几次）==\n');
  process.stdout.write(`扫 ${summary.scanned.files} 个会话日志（解析成功 ${parsed}，跳过 ${summary.scanned.skipped}）· 窗口 ${sinceDays} 天\n`);
  process.stdout.write(`有注入的会话 ${summary.sessions} 个 · 注入 ${summary.injections} 次\n`);
  process.stdout.write(`上界（不看压缩）  会拦下 ${summary.wouldBlock} 次（${(100 * (summary.blockRate ?? 0)).toFixed(2)}%）· 少烧约 ${summary.tokensSaved} token（粗估）\n`);
  process.stdout.write(`下界（压缩即清空）会拦下 ${summary.wouldBlockStrict} 次（${(100 * (summary.blockRateStrict ?? 0)).toFixed(2)}%）· 少烧约 ${summary.tokensSavedStrict} token（粗估）\n`);
  process.stdout.write('真值在两者之间：卡被压缩压掉的次数越少，越靠近上界。\n');
  const worst = rows
    .map((r) => ({ session: r.session, blocked: r.injections.filter((x) => x.wouldBlock).length, total: r.injections.length }))
    .filter((r) => r.blocked > 0)
    .sort((a, b) => b.blocked - a.blocked)
    .slice(0, 10);
  if (worst.length) {
    process.stdout.write('\n按会话（拦下最多在前）：\n');
    for (const r of worst) process.stdout.write(`  ${r.session.slice(0, 8)}  拦 ${r.blocked} / 投 ${r.total}\n`);
  }
  if (skipped.length) {
    process.stdout.write(`\n跳过的坏文件 ${skipped.length} 个（不编造）：\n`);
    for (const s of skipped.slice(0, 5)) process.stdout.write(`  ${s.file} · ${s.why}\n`);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();

// R08 joseki —— 定式提炼（每招溯源；M2 只到 candidate，不升 standard）
//
// ── 契约（AGENTS §4.6 / §11 R08、docs/数据契约.md §4、方案 §4.7、§5.1b、Q5）──
// 职责：把「同一作用域里反复成立的**成功边序列**」提炼成候选定式（一段最佳应对序列），
//       每一招都指回源头棋谱（episode + nodeId + edgeId + seq + quote）。
// 入口：promoteJoseki({episodes, signals, now, options})
//        → {joseki, links, stats}
//   joseki = 定式候选数组（每条见下）
//   links  = shares-joseki 边（同一候选被 ≥2 局下过 ⇒ 把这几局连起来；方案 §4.6 的「连接组织」）
// 输入：
//   episodes = [{ id:"ep-…", sessionId, parentSessionId|null, scopeKey, startedAt|occurredAt,
//                 signals? }]（signals 可挂在条目上）
//   signals  = 按棋谱 id 的 R03.extractSignals 输出：Map | {epId: 信号} | [{episode, …}] |
//              [{episode, signals}] | 单条 signals（只有 1 局时）
// 每条定式：
//   { id:"j-<hash8>", version:1, title,
//     steps:[{ n, action, expect, source:{episode,nodeId,edgeId,seq,quote}, occurredAt }],
//     preconditions:[{check:"scope", value, why}], assumptions:[],
//     support:["ep-…"], counter:[], state:"candidate", supersedes:null,
//     recordedAt, updatedAt, scopeKey, signature:[step sig…] }
//   - action = 该招的**机械签名**（工具 + 主参数归一，见 stepSignature）；
//   - expect = 该招在证据里的结算方式（`success` 或 `success(verifyKind=…)`）——不猜验证语义；
//   - source 取**最早支撑局**的那条边（最早 = occurredAt 升序，再按 episode id 升序）；
//   - recordedAt = 入参 now（缺省 null，绝不拿 Date.now() 冒充）；updatedAt = 各招 occurredAt 的最大值。
// 机械规则（无模型调用、无"像不像"判断）：
//   1. 招的签名：解析边的动作原文 `tool(key=value …)` → 取第一个主参数
//      （command/cmd/script/file_path/path/file/url/query/pattern/name）；工作区根前缀抹掉、
//      斜杠统一、长十六进制/13 位以上 epoch 数字归一，再截 160 字。`write` 只取 file_path，**不取 content**。
//   2. 片段：同局成功边按 seq 升序排成序列，取长度 minSteps(2)–maxSteps(3) 的连续窗口。
//   3. 准入（Q5 候选）：同一 (scopeKey, 签名序列) 被 **≥2 局独立**支撑
//      （独立 = sessionId 不同、且两者不是父子会话）；**无反例**（见 4）；**每步都有 source**；
//      preconditions 可核（这里唯一可核的是作用域）。三条有任一不满足 ⇒ 不产出。
//   4. 反例（机械、保守）：若某支撑局的该窗口内（首招 seq < failure.seq < 末招 seq）夹着失败边，
//      记为该候选的反例 ⇒ 不产出（stats.dropped.countered 计数）。
//      保守的理由：同一线路上出现过失败，就不满足「无反例」；宁可少算，不可多算（方案 §5.1a）。
//   5. 去冗余：若窗口 W 是另一个保留候选 J 的连续子窗口（|J| = |W|+1）且 support(J) ⊇ support(W)，
//      丢 W（「哪一段是定式」不重复记账）。
//   6. 不升 standard：M2 只有 candidate（Q5 的第二档由 M4 的机械规则触发），本模块**永不**产出
//      standard/disputed/superseded。
// 无源不入：缺 seq 或 quote 的成功边不构成招；某候选的任一招取不到 source ⇒ 整条不产出。
// 错误语义：入参不是对象 ⇒ throw JosekiError('joseki/input')。
// 允许依赖：R00/R03（形状约定）+ node: 内置模块。禁止依赖：模型调用、上游包、R05/R06/R09。

import { createHash } from 'node:crypto';

export class JosekiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'JosekiError';
    this.code = code;
  }
}

export const DEFAULT_JOSEKI_OPTIONS = Object.freeze({
  minSteps: 2,            // 片段的招数下限（契约：≥2 步）
  maxSteps: 3,            // 片段的招数上限（防组合爆炸；M2 的保守上限）
  minSupport: 2,          // 独立支撑局数下限（Q5 候选档）
  sameScope: true,        // 只在同一 scopeKey 内配对（preconditions 的 scope 可核）
  requireIndependent: true, // 支撑局必须相互独立（不同 sessionId、非父子）
  rootOnly: false,        // true ⇒ 忽略 delegationDepth>0 的子代理局（它们归并到父局）
  maxQuote: 200,          // 每步 quote 上限（码点）
  maxTitleChars: 100,
});

/** 主参数候选（按动作原文里**文本顺序**取第一个命中的；`write` 因此只取 file_path 不取 content）。 */
export const PRIMARY_ARG_KEYS = Object.freeze([
  'command', 'cmd', 'script', 'file_path', 'path', 'file', 'url', 'query', 'pattern', 'name',
]);

const ARG_START_RE = /(?:^|[\s(])([a-z_][a-z0-9_]*)=/g;

function hash8(input) {
  return createHash('sha256').update(String(input)).digest('hex').slice(0, 8);
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** scopeKey → 工作区根（`w:d:/x` → `d:/x`）；非 w: 作用域返回 ''。 */
export function workspaceOf(scopeKey) {
  const raw = String(scopeKey ?? '');
  return raw.startsWith('w:') ? raw.slice(2) : '';
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 动作原文归一（纯字符串）：抹掉工作区根前缀、统一斜杠、压空白、长十六进制/时间戳归一、截断。
 * 只在签名内部使用，不改写原始 quote（证据保真）。
 */
export function normalizeActionText(text, scopeKey, maxLen = 160) {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const ws = workspaceOf(scopeKey);
  if (ws) {
    for (const variant of [ws, ws.replace(/\//g, '\\')]) {
      if (variant.length >= 3) s = s.replace(new RegExp(escapeRe(variant), 'gi'), '');
    }
  }
  s = s.replace(/\\/g, '/');
  s = s.replace(/\b[0-9a-f]{16,}\b/gi, '<id>');
  s = s.replace(/\b\d{13,}\b/g, '<ts>');
  s = s.replace(/\s+/g, ' ').trim();
  return clip(s, maxLen);
}

/**
 * 一招的机械签名。
 * `bash(command=npm test)` → {tool:"bash", key:"command", value:"npm test", text:"bash:command=npm test"}
 * `write(file_path=D:\\ws\\src\\a.mjs content=…)` → {tool:"write", key:"file_path", value:"/src/a.mjs", …}
 * 无 `tool(` 形状 → 整段归一文本当签名（tool=null）。
 * @returns {{tool:string|null, key:string|null, value:string, text:string}}
 */
export function stepSignature(quote, { scopeKey = null } = {}) {
  const raw = String(quote ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return { tool: null, key: null, value: '', text: '' };
  const head = /^([A-Za-z][\w.-]{0,40})\s*\(/.exec(raw);
  if (!head) {
    const text = normalizeActionText(raw, scopeKey);
    return { tool: null, key: null, value: text, text };
  }
  const tool = head[1].toLowerCase();
  const rest = raw.slice(head.index + head[0].length);

  // 主参数：动作原文里文本顺序第一个「主参数键=」
  ARG_START_RE.lastIndex = 0;
  let hit = null;
  for (let m = ARG_START_RE.exec(rest); m; m = ARG_START_RE.exec(rest)) {
    if (PRIMARY_ARG_KEYS.includes(m[1])) {
      hit = { key: m[1], from: m.index + m[0].length };
      break;
    }
  }
  if (!hit) {
    const text = normalizeActionText(raw, scopeKey);
    return { tool, key: null, value: text, text: `${tool}:${text}` };
  }
  // 取值：到下一个「键=」或字符串结尾；去掉包裹的引号与结尾的 `)`
  ARG_START_RE.lastIndex = hit.from;
  const next = ARG_START_RE.exec(rest);
  const to = next ? next.index : rest.length;
  let value = rest.slice(hit.from, to).trim();
  if (value.endsWith(')')) value = value.slice(0, -1).trim();
  if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1);
  }
  value = normalizeActionText(value, scopeKey);
  return { tool, key: hit.key, value, text: `${tool}:${hit.key}=${value}` };
}

/** 信号归一：接受 Map / {epId: 信号} / [{episode,…}] / [{episode, signals}] / 单条信号。 */
function normalizeSignals(signals, episodes) {
  const out = new Map();
  if (!signals) {
    for (const ep of episodes) if (ep?.signals && ep.id) out.set(ep.id, ep.signals);
    return out;
  }
  if (signals instanceof Map) {
    for (const [id, sig] of signals) if (sig) out.set(id, sig);
    return out;
  }
  if (Array.isArray(signals)) {
    for (const item of signals) {
      if (!item || typeof item !== 'object') continue;
      const id = item.episode?.id ?? item.episode ?? item.episodeId ?? item.id ?? null;
      const sig = item.signals ?? item;
      if (typeof id === 'string' && sig) out.set(id, sig);
    }
    return out;
  }
  if (typeof signals === 'object') {
    const looksLikeOne = Array.isArray(signals.successes) || Array.isArray(signals.failures);
    if (looksLikeOne) {
      if (episodes.length === 1 && episodes[0].id) out.set(episodes[0].id, signals);
      return out;
    }
    for (const [id, sig] of Object.entries(signals)) if (sig && typeof sig === 'object') out.set(id, sig);
  }
  return out;
}

/** 棋谱的事件时间（occurredAt 一侧）。 */
function episodeAt(ep) {
  for (const key of ['occurredAt', 'startedAt', 'firstEventAt']) {
    if (Number.isFinite(ep?.[key])) return ep[key];
  }
  return null;
}

function sessionOf(ep) {
  return typeof ep?.sessionId === 'string' && ep.sessionId ? ep.sessionId : ep.id;
}

/** 两局是否独立（方案 §5.1a 的前两条，机械）：不同 sessionId 且非父子。 */
export function isIndependentEpisode(a, b) {
  if (!a || !b || a.id === b.id) return false;
  const sa = sessionOf(a);
  const sb = sessionOf(b);
  if (sa === sb) return false;
  const pa = a.parentSessionId ?? null;
  const pb = b.parentSessionId ?? null;
  if (pa && pa === sb) return false;
  if (pb && pb === sa) return false;
  return true;
}

/** 一组棋谱里是否存在 2 局互相独立的支撑。 */
export function hasIndependentPair(list) {
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (isIndependentEpisode(list[i], list[j])) return true;
    }
  }
  return false;
}

/** 成功边 → 招（只收有 seq + quote 的，无源不入）。 */
function stepsOf(signals, scopeKey, opts) {
  const steps = [];
  const skipped = { noSource: 0, noQuote: 0 };
  for (const entry of Array.isArray(signals?.successes) ? signals.successes : []) {
    if (!entry) continue;
    if (!Number.isFinite(entry.seq)) {
      skipped.noSource += 1;
      continue;
    }
    const quote = String(entry.quote ?? '').trim();
    if (!quote) {
      skipped.noQuote += 1;
      continue;
    }
    const sig = stepSignature(quote, { scopeKey });
    if (!sig.text) {
      skipped.noQuote += 1;
      continue;
    }
    steps.push({
      seq: entry.seq,
      sig,
      nodeId: entry.nodeId ?? null,
      edgeId: entry.edgeId ?? null,
      quote: clip(quote, opts.maxQuote),
      occurredAt: Number.isFinite(entry.occurredAt) ? entry.occurredAt : null,
      verifyKind: entry.verifyKind ?? null,
    });
  }
  steps.sort((a, b) => (a.seq - b.seq) || String(a.edgeId ?? '').localeCompare(String(b.edgeId ?? ''), 'en'));
  return { steps, skipped };
}

function failuresOf(signals) {
  return (Array.isArray(signals?.failures) ? signals.failures : [])
    .filter((f) => f && Number.isFinite(f.seq))
    .map((f) => ({
      seq: f.seq,
      quote: clip(f.quote, 200),
      edgeId: f.edgeId ?? null,
      nodeId: f.nodeId ?? null,
      occurredAt: Number.isFinite(f.occurredAt) ? f.occurredAt : null,
    }))
    .sort((a, b) => a.seq - b.seq);
}

/**
 * 提炼候选定式。
 * @param {{episodes?:Array, signals?:any, now?:number|null, options?:object}} input
 * @returns {{joseki:Array, links:Array, stats:object}}
 */
export function promoteJoseki({ episodes = [], signals = null, now = null, options = {} } = {}) {
  if (episodes === null || typeof episodes !== 'object') {
    throw new JosekiError('joseki: input must be an object {episodes, signals}', 'joseki/input');
  }
  const opts = { ...DEFAULT_JOSEKI_OPTIONS, ...options };
  const minSteps = Math.max(2, Number.isFinite(opts.minSteps) ? opts.minSteps : 2);
  const maxSteps = Math.max(minSteps, Number.isFinite(opts.maxSteps) ? opts.maxSteps : minSteps);

  const eps = (Array.isArray(episodes) ? episodes : [])
    .filter((e) => e && typeof e.id === 'string' && e.id !== '')
    .map((e) => ({ ...e, scopeKey: typeof e.scopeKey === 'string' && e.scopeKey ? e.scopeKey : 'w:unknown', at: episodeAt(e) }))
    .filter((e) => (opts.rootOnly ? !(Number.isFinite(e.delegationDepth) && e.delegationDepth > 0) : true));

  const sigs = normalizeSignals(signals, eps);
  const byId = new Map(eps.map((e) => [e.id, e]));
  const dropped = { noSource: 0, noQuote: 0, notIndependent: 0, countered: 0, subWindow: 0, singleSupport: 0 };
  let successEdges = 0;
  let windows = 0;

  // ---- 1. 每局的招序列 + 失败边 ----
  const perEpisode = [];
  for (const ep of eps) {
    const sig = sigs.get(ep.id);
    if (!sig) continue;
    const { steps, skipped } = stepsOf(sig, ep.scopeKey, opts);
    dropped.noSource += skipped.noSource;
    dropped.noQuote += skipped.noQuote;
    successEdges += Array.isArray(sig.successes) ? sig.successes.length : 0;
    if (!steps.length) continue;
    perEpisode.push({ ep, steps, failures: failuresOf(sig) });
  }

  // ---- 2. 窗口 → bucket（键 = scope + 签名序列）----
  const buckets = new Map();
  for (const { ep, steps, failures } of perEpisode) {
    for (let len = minSteps; len <= Math.min(maxSteps, steps.length); len += 1) {
      for (let start = 0; start + len <= steps.length; start += 1) {
        const window = steps.slice(start, start + len);
        windows += 1;
        const firstSeq = window[0].seq;
        const lastSeq = window[window.length - 1].seq;
        // 反例：窗口内夹失败边（首招 < failure < 末招）
        const inner = failures.filter((f) => f.seq > firstSeq && f.seq < lastSeq);
        const scopeKey = opts.sameScope ? ep.scopeKey : '*';
        const key = `${scopeKey}\u0000${window.map((s) => s.sig.text).join('\u0000')}`;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { key, scopeKey, window, holders: new Map(), counters: [] };
          buckets.set(key, bucket);
        }
        if (!bucket.holders.has(ep.id)) {
          bucket.holders.set(ep.id, {
            ep,
            firstSeq,
            lastSeq,
            steps: window,
            innerFailures: inner,
            occurredAt: window[0].occurredAt ?? ep.at,
          });
        }
        for (const f of inner) {
          if (!bucket.counters.some((c) => c.episode === ep.id && c.seq === f.seq)) {
            bucket.counters.push({ episode: ep.id, seq: f.seq, edgeId: f.edgeId, nodeId: f.nodeId, quote: f.quote, occurredAt: f.occurredAt });
          }
        }
      }
    }
  }

  // ---- 3. 准入：support / 独立性 / 反例 / 每步 source ----
  const kept = [];
  for (const bucket of buckets.values()) {
    const holders = [...bucket.holders.values()].sort((a, b) => {
      const ta = Number.isFinite(a.occurredAt) ? a.occurredAt : Number.POSITIVE_INFINITY;
      const tb = Number.isFinite(b.occurredAt) ? b.occurredAt : Number.POSITIVE_INFINITY;
      return (ta - tb) || (a.ep.id < b.ep.id ? -1 : a.ep.id > b.ep.id ? 1 : 0);
    });
    if (holders.length < Math.max(2, Number.isFinite(opts.minSupport) ? opts.minSupport : 2)) {
      dropped.singleSupport += 1;
      continue;
    }
    if (opts.requireIndependent && !hasIndependentPair(holders.map((h) => h.ep))) {
      dropped.notIndependent += 1;
      continue;
    }
    if (bucket.counters.length > 0) {
      dropped.countered += 1;
      continue;
    }
    // 每步 source：取最早支撑局的那一招；缺 seq/quote 的招不构成定式
    const representative = holders[0];
    const steps = [];
    let bad = false;
    for (let i = 0; i < representative.steps.length; i += 1) {
      const s = representative.steps[i];
      if (!representative.ep.id || !Number.isFinite(s.seq) || !s.quote) {
        bad = true;
        break;
      }
      steps.push({
        n: i + 1,
        action: s.sig.text,
        expect: s.verifyKind ? `success(${s.verifyKind})` : 'success',
        source: {
          episode: representative.ep.id,
          nodeId: s.nodeId,
          edgeId: s.edgeId,
          seq: s.seq,
          quote: s.quote,
        },
        occurredAt: s.occurredAt,
      });
    }
    if (bad || steps.length === 0) {
      dropped.noSource += 1;
      continue;
    }

    const support = holders.map((h) => h.ep.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const sigTexts = representative.steps.map((s) => s.sig.text);
    const scopeKey = bucket.scopeKey === '*' ? (byId.get(support[0])?.scopeKey ?? 'w:unknown') : bucket.scopeKey;
    const times = steps.map((s) => s.occurredAt).filter((t) => Number.isFinite(t));
    if (!times.length) {
      // occurredAt 是硬字段：一步都没有发生时间 ⇒ 假记忆，不产出
      dropped.noSource += 1;
      continue;
    }
    kept.push({
      id: `j-${hash8(`${scopeKey}\u0000${sigTexts.join('\u0000')}`)}`,
      version: 1,
      title: clip(sigTexts.join(' → '), opts.maxTitleChars),
      steps,
      preconditions: [{
        check: 'scope',
        value: scopeKey,
        why: '证据只覆盖该工作区（w: 层不自动上升，方案 §4.10）',
      }],
      assumptions: [],
      support,
      counter: [],
      state: 'candidate',
      supersedes: null,
      recordedAt: Number.isFinite(now) ? now : null,
      updatedAt: Math.max(...times),
      scopeKey,
      signature: sigTexts,
      occurrences: holders.length,
    });
  }

  // ---- 4. 去冗余：被更长候选覆盖的子窗口 ----
  const sigKey = (j) => j.signature.join('\u0000');
  const supportKey = (j) => j.support.join(',');
  const final = kept.filter((j) => {
    const covered = kept.some((k) => k !== j
      && k.signature.length === j.signature.length + 1
      && k.scopeKey === j.scopeKey
      && supportKey(k) === supportKey(j)
      && k.signature.join('\u0000').includes(sigKey(j)));
    if (covered) dropped.subWindow += 1;
    return !covered;
  });
  final.sort((a, b) => (a.scopeKey < b.scopeKey ? -1 : a.scopeKey > b.scopeKey ? 1 : 0)
    || (b.support.length - a.support.length)
    || (a.signature.join('\u0000') < b.signature.join('\u0000') ? -1 : 1)
    || (a.id < b.id ? -1 : 1));

  // ---- 5. shares-joseki 边（方案 §4.6「连接组织」）----
  const links = [];
  for (const j of final) {
    const at = new Map(j.support.map((id) => [id, episodeAt(byId.get(id))]));
    for (let i = 0; i < j.support.length; i += 1) {
      for (let k = i + 1; k < j.support.length; k += 1) {
        const a = j.support[i];
        const b = j.support[k];
        const times = [at.get(a), at.get(b)].filter((x) => Number.isFinite(x));
        links.push({
          a: { episode: a },
          b: { episode: b },
          kind: 'shares-joseki',
          topics: [],
          why: j.id,
          weight: 1,
          occurredAt: times.length ? Math.min(...times) : null,
        });
      }
    }
  }
  links.sort((x, y) => (x.a.episode < y.a.episode ? -1 : x.a.episode > y.a.episode ? 1 : 0)
    || (x.b.episode < y.b.episode ? -1 : x.b.episode > y.b.episode ? 1 : 0)
    || (x.why < y.why ? -1 : 1));

  const stats = {
    episodes: eps.length,
    episodesWithSignals: perEpisode.length,
    successEdges,
    windows,
    candidates: final.length,
    bySteps: final.reduce((acc, j) => { const k = String(j.steps.length); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
    dropped,
  };

  return { joseki: final, links, stats };
}

export default { promoteJoseki, stepSignature, normalizeActionText, isIndependentEpisode, hasIndependentPair, DEFAULT_JOSEKI_OPTIONS };

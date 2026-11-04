// 棋院 SDK（PTC / run_code 调用面）—— 契约见 docs/SDK-PTC.md。
//
// 设计三条铁律（改这里之前先读契约）：
//   ① **只读**：没有写入/入馆接口（入馆只走会话钩子）；本文件不写盘。
//   ② **零模型、零网络**：只读 sidecar 文件并做机械 walk。
//   ③ **有界且 JSON 安全**：limit/budgetTokens 有上限并夹紧（结果里如实标 clamped），
//      返回值可直接 JSON.stringify（无 Map/Set/类实例/undefined）。
//
// 复用的是既有房间（R11 walk / R12 inject / R13 gates / R15 persist），这里只做**收口**，不重写逻辑。
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from './rooms/persist.mjs';
import { createWalkCache, walkFromSignals } from './rooms/walk.mjs';
import { buildMemoryCard, signalFromText, estimateTokens, scopeKeyFromPath } from './rooms/inject.mjs';
import { runGates } from './rooms/gates.mjs';
import { errorClassKeyOf } from './rooms/topic.mjs';

export const SDK_VERSION = 1;

const KINDS = Object.freeze(['episodes', 'topics', 'claims', 'links', 'threads', 'joseki', 'adjudications']);
export const MAX_LIMIT = 50;
export const MAX_BUDGET_TOKENS = 2000;
export const MAX_DEPTH = 2;

export class SdkError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'SdkError';
    this.code = code;
    this.detail = detail;
  }
}

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return { value: fallback, clamped: false };
  const v = Math.floor(n);
  if (v < min) return { value: min, clamped: true };
  if (v > max) return { value: max, clamped: true };
  return { value: v, clamped: v !== n };
};

const requireText = (text) => {
  if (typeof text !== 'string' || text.trim() === '') throw new SdkError('bad-argument', 'text 必须是非空字符串');
  return text;
};

const defaultDshHome = () => process.env.DSH_HOME
  || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');

/** 把 walk hit 收成 JSON 安全的轻量结构（why 可能是数组，保留但截断）。 */
const hitView = (hit) => ({
  episode: String(hit?.episode ?? ''),
  seq: Number.isFinite(hit?.seq) ? hit.seq : null,
  kind: typeof hit?.kind === 'string' ? hit.kind : null,
  weight: Number.isFinite(hit?.weight) ? hit.weight : null,
  why: Array.isArray(hit?.why) ? hit.why.slice(0, 6).map(String) : (typeof hit?.why === 'string' ? hit.why : null),
});

export function createMemorySdk({ dshHome = null, scope = null, now = null } = {}) {
  const home = dshHome || defaultDshHome();
  const storeRoot = path.join(home, 'memory-context');
  const resolvedScope = scope == null ? null : String(scope);
  const clock = typeof now === 'function' ? now : () => (Number.isFinite(now) ? now : Date.now());

  // 2026-11-04（契约修订）：**库不存在不是错误** —— 新机器 / 还没入过馆时，每个读接口返回
  // `status: 'missing'` + 空数组（PTC 代码块不该因为"还没记忆"就抛异常）。
  // 但"存在却读不动"（权限/损坏）仍然抛 `store-unreadable`，不吞。
  const storeMissing = () => !fs.existsSync(storeRoot) || !fs.statSync(storeRoot).isDirectory();

  let store = null;
  let cache = null;
  const ensure = () => {
    if (store) return store;
    if (storeMissing()) return null;
    try {
      store = createStore({ root: storeRoot });
      cache = createWalkCache(store);
    } catch (error) {
      throw new SdkError('store-unreadable', `记忆库读不了：${String(error?.message ?? error)}`);
    }
    return store;
  };

  const listSafe = (kind) => {
    const st = ensure();
    if (!st) return [];
    try { return st.list(kind).map((x) => x?.record).filter(Boolean); } catch (error) {
      if (error instanceof SdkError) throw error;
      throw new SdkError('store-unreadable', `列 ${kind} 失败：${String(error?.message ?? error)}`);
    }
  };

  const signalFor = (text) => {
    const signal = signalFromText(text, { at: clock() });
    if (resolvedScope) signal.scopeKey = resolvedScope;
    // 与线上钩子同一套信号构造（src/plugin.mjs 的 resolveSignal 路径）：文本里贴着报错原文时
    // 补一个类级错误实体，否则"同一类坑"的历史棋谱不会被命中 —— 少了这一步卡片会莫名变空。
    const errClass = errorClassKeyOf(text);
    if (errClass) {
      signal.entities = Array.isArray(signal.entities) ? signal.entities : [];
      if (!signal.entities.some((e) => String(e?.key ?? '') === errClass)) {
        signal.entities.push({ kind: 'error', key: errClass });
      }
    }
    return signal;
  };

  const doWalk = (text, opts = {}) => {
    const t = requireText(text);
    const st = ensure();
    if (!st) {
      const empty = { hits: [], omitted: { count: 0, byLimit: 0, byBudget: 0, crossScope: 0 } };
      return { walk: empty, scope: resolvedScope, clamped: { limit: false, depth: false, budgetTokens: false }, missing: true };
    }
    const limit = clampInt(opts.limit, 1, MAX_LIMIT, 5);
    const depth = clampInt(opts.depth, 1, MAX_DEPTH, 2);
    const budget = clampInt(opts.budgetTokens, 100, MAX_BUDGET_TOKENS, 500);
    const scope = opts.scope === undefined ? resolvedScope : (opts.scope == null ? null : String(opts.scope));
    const walk = walkFromSignals({
      signal: signalFor(t), store: st, scope, cache, depth: depth.value, limit: limit.value, budgetTokens: budget.value,
      // Q18=A（关闸）：类级 claim 不借跨域证据。SDK 默认与线上一致；要实验就显式传 true。
      allowCrossScopeClass: opts.allowCrossScopeClass === true,
    });
    return { walk, scope, clamped: { limit: limit.clamped, depth: depth.clamped, budgetTokens: budget.clamped }, missing: false };
  };

  const api = {
    version: SDK_VERSION,
    scope: resolvedScope,
    storePath: storeRoot,

    describe() {
      return {
        version: SDK_VERSION,
        storePath: storeRoot,
        scope: resolvedScope,
        kinds: [...KINDS],
        limits: { maxLimit: MAX_LIMIT, maxBudgetTokens: MAX_BUDGET_TOKENS, maxDepth: MAX_DEPTH },
        readOnly: true,
      };
    },

    stats() {
      const counts = {};
      for (const kind of KINDS) counts[kind] = listSafe(kind).length;
      const episodes = listSafe('episodes');
      const claims = listSafe('claims');
      const maxOf = (records, key) => records.reduce((acc, r) => (Number.isFinite(r?.[key]) && r[key] > acc ? r[key] : acc), 0);
      const n = Object.values(counts).reduce((a, b) => a + b, 0);
      return {
        ok: true,
        n,
        counts,
        status: storeMissing() ? 'missing' : (n > 0 ? 'measured' : 'empty'),
        latest: {
          episodeAt: maxOf(episodes, 'endedAt') || maxOf(episodes, 'startedAt') || null,
          claimAt: maxOf(claims, 'occurredAt') || null,
        },
      };
    },

    get(kind, id) {
      if (typeof kind !== 'string' || !KINDS.includes(kind)) {
        throw new SdkError('unsupported-kind', `kind 必须是 ${KINDS.join('/')} 之一：${String(kind)}`);
      }
      if (typeof id !== 'string' || id === '') throw new SdkError('bad-argument', 'id 必须是非空字符串');
      const st = ensure();
      if (!st) return { ok: false, reason: 'not-found', kind, id, status: 'missing' };
      const record = (() => {
        try { return st.get(kind, id); } catch (error) {
          throw new SdkError('store-unreadable', `读 ${kind}/${id} 失败：${String(error?.message ?? error)}`);
        }
      })();
      if (!record) return { ok: false, reason: 'not-found', kind, id };
      return { ok: true, kind, id, record };
    },

    search(text, opts = {}) {
      const { walk, scope, clamped, missing } = doWalk(text, opts);
      const hits = (walk?.hits ?? []).map(hitView);
      return { ok: true, n: hits.length, hits, scope, clamped, omitted: walk?.omitted ?? null, status: missing ? 'missing' : (hits.length ? 'measured' : 'empty') };
    },

    walk(text, opts = {}) {
      const { walk, scope, clamped, missing } = doWalk(text, opts);
      const hits = (walk?.hits ?? []).map(hitView);
      return { ok: true, n: hits.length, hits, scope, clamped, omitted: walk?.omitted ?? null, status: missing ? 'missing' : (hits.length ? 'measured' : 'empty') };
    },

    card(text, opts = {}) {
      const { walk, scope, clamped, missing } = doWalk(text, opts);
      const st = ensure();
      if (!st) {
        return { ok: true, section: '', tokens: 0, n: 0, claims: [], omitted: null, gates: { ok: true, errors: [] }, scope, clamped, status: 'missing' };
      }
      const limit = clampInt(opts.limit, 1, MAX_LIMIT, 5);
      const budget = clampInt(opts.budgetTokens, 100, MAX_BUDGET_TOKENS, 500);
      const signal = signalFor(requireText(text));
      const card = buildMemoryCard({
        signal, walkResult: walk, store: st, scope, limit: limit.value, budgetTokens: budget.value,
      });
      const wantGates = opts.gates !== false;
      const gates = wantGates
        ? runGates({ card, walkResult: walk, store: st, cache, scope })
        : { ok: true, errors: [], skipped: true };
      const section = typeof card?.section === 'string' ? card.section : '';
      return {
        ok: true,
        section,
        tokens: estimateTokens(section),
        n: Array.isArray(card?.claims) ? card.claims.length : 0,
        claims: (Array.isArray(card?.claims) ? card.claims : []).map((c) => ({
          claimId: c?.claimId ?? null,
          marker: c?.marker ?? null,
          text: typeof c?.text === 'string' ? c.text : null,
        })),
        omitted: walk?.omitted ?? null,
        gates: { ok: gates?.ok === true, errors: Array.isArray(gates?.errors) ? gates.errors.slice(0, 10) : [] },
        scope,
        clamped,
        status: section ? 'measured' : 'empty',
      };
    },

    recentFailures(opts = {}) {
      const limit = clampInt(opts.limit, 1, MAX_LIMIT, 10);
      const scope = opts.scope === undefined ? resolvedScope : (opts.scope == null ? null : String(opts.scope));
      if (storeMissing()) {
        return { ok: true, n: 0, total: 0, clamped: limit.clamped, scope, status: 'missing', items: [] };
      }
      const claims = listSafe('claims')
        .filter((c) => c?.kind === 'antipattern' && Array.isArray(c.support) && c.support.length)
        .filter((c) => !scope || c.scopeKey === scope || (c.support ?? []).some((s) => s?.scopeKey === scope));
      const items = [];
      for (const claim of claims) {
        for (const sup of claim.support) {
          if (typeof sup?.quote !== 'string' || sup.quote === '') continue;
          items.push({
            claimId: claim.id,
            episode: String(sup.episode ?? ''),
            seq: Number.isFinite(sup.seq) ? sup.seq : null,
            occurredAt: Number.isFinite(sup.occurredAt) ? sup.occurredAt : (claim.occurredAt ?? null),
            scopeKey: sup.scopeKey ?? claim.scopeKey ?? null,
            quote: sup.quote.length > 400 ? `${sup.quote.slice(0, 400)}…` : sup.quote,
          });
        }
      }
      items.sort((a, b) => (b.occurredAt ?? 0) - (a.occurredAt ?? 0));
      const page = items.slice(0, limit.value);
      return {
        ok: true,
        n: page.length,
        total: items.length,
        clamped: limit.clamped,
        scope,
        status: page.length ? 'measured' : 'empty',
        items: page,
      };
    },

    /** 给代码块用的便利：把一个路径转成作用域键（与钩子同一实现，避免两套口径）。 */
    scopeOf(p) {
      if (typeof p !== 'string' || p === '') throw new SdkError('bad-argument', 'scopeOf 需要非空路径');
      return scopeKeyFromPath(p);
    },
  };
  return api;
}
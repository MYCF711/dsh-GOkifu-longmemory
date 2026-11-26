// R12 inject —— **转发垫片**（task-11 / 重构 B 期：三房拆分后的兼容入口）
//
// 这个文件现在只剩"转发"，实现分别在三个房间里（各有自己的契约与墓碑测试）：
//   `inject-gate.mjs` —— 十道闸的**判定原语**（作用域 / 预算 / 来源 / 指令式 / file-exists 的单源实现）
//   `inject-card.mjs` —— **卡片产物**：hit → 记忆行 → 记忆卡（渲染 + token 预算裁剪）+ 影子记录 + CLI
//   `inject-slot.mjs` —— **槽位幂等账本**（`{slotId, contentHash, seq}` 持久化到 sidecar）
//
// 为什么保留这一层：M6 迁移期内不破旧调用方 —— 仓里有 30+ 处 `from './inject.mjs'`
// （`src/sdk.mjs`、`src/plugin.mjs`、`src/rooms/gates.mjs`、`src/rooms/view.mjs`、`scripts/a2b-*.mjs` …）。
// 垫片的契约是**导出面一字不变**：`export *` 转发两房 + 显式转发常量表的 6 个名字 + 原 `default` 对象。
// 墓碑测试：`test/inject.test.mjs` 的「task-11 · 三房拆分」段 ——
//   删掉任一新房间 ⇒ 该房间的 import 失败；把实现搬回本文件（垫片变厚）⇒ 行数断言红。
//
// 依赖：只允许三个房间 + 常量表。**本文件不许再写实现**（判据在房间里，垫片只做转发）。

import * as gate from './inject-gate.mjs';
import * as card from './inject-card.mjs';
import {
  // task-9 / P0-4：注入侧的条数与预算来自唯一权威表（数值与上游对应值都写在 limits.mjs）。
  ENTRY_LIMIT,
  BUDGET_TOKENS,
  INDEX_LINE_BUDGET,
  TEXT_CLIP,
  TIGHT_CLIP,
  POINTER_SUPPORT_LIMIT,
} from './limits.mjs';

export * from './inject-gate.mjs';
export * from './inject-card.mjs';
export * from './inject-slot.mjs';
export { ENTRY_LIMIT, BUDGET_TOKENS, INDEX_LINE_BUDGET, TEXT_CLIP, TIGHT_CLIP, POINTER_SUPPORT_LIMIT };

/**
 * 原 `default` 导出的**同一份键序**（消费方若按对象取，不会因为拆房而少键）。
 * 只重排引用，不新增语义。
 */
export default {
  CARD_VERSION: card.CARD_VERSION,
  ENTRY_LIMIT,
  BUDGET_TOKENS,
  INDEX_LINE_BUDGET,
  TEXT_CLIP,
  TIGHT_CLIP,
  IMPERATIVE_PATTERNS: gate.IMPERATIVE_PATTERNS,
  GOVERNANCE_PATTERNS: gate.GOVERNANCE_PATTERNS,
  PROVENANCE_LINE_RE: gate.PROVENANCE_LINE_RE,
  INDEX_LINE_RE: gate.INDEX_LINE_RE,
  MARKERS_LINE: gate.MARKERS_LINE,
  POINTER_SUPPORT_LIMIT,
  POINTER_TIER_DEFAULT: card.POINTER_TIER_DEFAULT,
  POINTER_BODY_RE: card.POINTER_BODY_RE,
  isPointerCandidate: card.isPointerCandidate,
  pointerBodyOf: card.pointerBodyOf,
  tierOf: card.tierOf,
  InjectError: card.InjectError,
  estimateTokens: gate.estimateTokens,
  formatCardDate: gate.formatCardDate,
  clipLine: card.clipLine,
  singleLine: card.singleLine,
  signalFromText: card.signalFromText,
  scopeKeyFromPath: gate.scopeKeyFromPath,
  renderIndexLine: card.renderIndexLine,
  displayPath: card.displayPath,
  buildMemoryCard: card.buildMemoryCard,
  degradedWalk: card.degradedWalk,
  defaultShadowDir: card.defaultShadowDir,
  assertSafeShadowDir: card.assertSafeShadowDir,
  writeShadow: card.writeShadow,
  readShadow: card.readShadow,
  runInject: card.runInject,
};
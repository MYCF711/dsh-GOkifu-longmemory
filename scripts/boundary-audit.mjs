#!/usr/bin/env node
// 边界静态审计（2026-11-02，补 docs/记忆的职责边界.md §5 的缺位脚本）。
// 只扫「可能进入模型上下文的字符串字面量」，检查是否含指令式措辞或治理痕迹。
//
// 与运行时闸（src/rooms/gates.mjs）的区别：
//   - 运行时闸检查**渲染结果**（每张卡、每次注入）；
//   - 本脚本检查**源码里的字面量**（提交前就能发现"有人往模板里写了指令句"）。
// 两者互补：静态漏掉的动态拼接由运行时闸兜底。
//
// 用法：node scripts/boundary-audit.mjs [--json]
// 退出码：0 干净；1 有命中；2 环境问题。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/** 会进入模型上下文的文件（渲染路径 + 插件消息构造）。 */
export const SCAN_FILES = [
  'src/rooms/inject.mjs', // 卡片渲染（唯一真正进模型上下文的地方）
  'src/plugin.mjs',       // 注入消息构造
];
// 说明：gates.mjs 里的字符串是**给代码/日志看的失败原因**，不注入模型上下文，故不扫。

/** 指令式片段（与 inject.IMPERATIVE_PATTERNS 同源语义；此处独立列出以免自指）。 */
export const IMPERATIVE = ['你应该', '请', '下一步', '建议', '务必', '记得', '不要忘记', '可以试试'];
/** 工具治理痕迹。 */
export const GOVERNANCE = ['permission:', 'approval:', 'allow:', 'deny:', 'ask:'];

/** 剥掉注释与"声明这些词"的清单块，避免把检测表本身当违规。 */
export function stripNoise(source) {
  let out = source;
  out = out.replace(/\/\*[\s\S]*?\*\//g, ''); // 块注释
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 行注释（避开 https://）
  // 去掉 IMPERATIVE_PATTERNS/GOVERNANCE_PATTERNS 的数组体（它们是检测源，不是注入文本）
  out = out.replace(/export const (IMPERATIVE_PATTERNS|GOVERNANCE_PATTERNS)[\s\S]*?\]\);/g, '');
  return out;
}

/** 找出可能进入模型上下文的字符串/模板字面量（粗略但可解释）。 */
export function extractLiterals(source) {
  const literals = [];
  const re = /`([^`]*)`|'([^'\\n]*)'|"([^"\\n]*)"/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const text = m[1] ?? m[2] ?? m[3] ?? '';
    if (!text) continue;
    const line = source.slice(0, m.index).split(String.fromCharCode(10)).length;
    literals.push({ text, line });
  }
  return literals;
}

export function auditSource(source, file = '<inline>') {
  const hits = [];
  for (const { text, line } of extractLiterals(stripNoise(source))) {
    // 纯标识符/路径/正则片段跳过（避免噪声）
    if (!/[\u4e00-\u9fff]/.test(text) && !/[A-Za-z]/.test(text)) continue;
    for (const word of IMPERATIVE) {
      if (text.includes(word)) hits.push({ file, line, kind: 'imperative', word, snippet: text.slice(0, 60) });
    }
    for (const word of GOVERNANCE) {
      if (text.toLowerCase().includes(word)) hits.push({ file, line, kind: 'governance', word, snippet: text.slice(0, 60) });
    }
  }
  return hits;
}

export function auditRepo(files = SCAN_FILES) {
  const hits = [];
  for (const rel of files) {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) continue;
    hits.push(...auditSource(fs.readFileSync(abs, 'utf8'), rel));
  }
  return hits;
}

const invoked = process.argv[1] ? import.meta.url === new URL(`file://${path.resolve(process.argv[1]).split(String.fromCharCode(92)).join('/')}`).href : false;
if (invoked) {
  let hits = [];
  try {
    hits = auditRepo();
  } catch (error) {
    console.error(`boundary-audit: 跑不起来（${String(error?.message ?? error)}）`);
    process.exit(2);
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify({ hits, count: hits.length }, null, 2));
  else {
    for (const h of hits.slice(0, 20)) console.error(`ERR ${h.file}:${h.line} [${h.kind}:${h.word}] ${h.snippet}`);
    console.log(hits.length === 0 ? 'boundary-audit: PASS（0 处）' : `boundary-audit: ${hits.length} 处（见上）`);
  }
  process.exit(hits.length === 0 ? 0 : 1);
}

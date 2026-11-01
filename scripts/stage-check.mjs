#!/usr/bin/env node
// 安装前检查：校验 staging 配置是否被插件接受（不加载宿主、不改 profiles、不写盘）。
import fs from 'node:fs';
import { sanitizeConfig, DEFAULT_CONFIG } from '../src/plugin.mjs';

const file = process.argv[2] ?? 'docs/staging/shadow.json';
if (!fs.existsSync(file)) {
  console.error(`配置不存在：${file}`);
  process.exit(2);
}
let raw;
try {
  raw = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`JSON 解析失败：${String(error?.message ?? error)}`);
  process.exit(1);
}
const cfg = sanitizeConfig(raw);
const warnings = [];
for (const key of Object.keys(raw)) {
  if (!(key in DEFAULT_CONFIG)) warnings.push(`未知键将被忽略：${key}`);
}
if (cfg.enabled === true && cfg.shadow === true) warnings.push('enabled 与 shadow 同时为 true：shadow 优先，不会真注入');
if (cfg.enabled === true && cfg.shadow === false) warnings.push('这是「真注入」配置：确认已跑过影子期');
console.log(JSON.stringify({ file, config: cfg, warnings, ok: true }, null, 2));

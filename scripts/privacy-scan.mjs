#!/usr/bin/env node
// 脱敏守卫：公开仓库里不允许出现内网地址、本机用户目录、密钥形态、真实会话 UUID。
// 用法：node scripts/privacy-scan.mjs [--json]
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SYNTHETIC_SESSIONS = ['session-0000000','session-11111111','session-1234abcd','session-99999999','session-aaaaaaa','session-bbbbbbb','session-ccccccc','session-ddddddd','session-22222222','session-33333333'];

const RULES = [
  { id: 'private-ip', re: /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/, why: '内网 IP' },
  // 2026-11-04 修：原规则写成 /[A-Za-z]:+Users+/（+ 被转义成正则的字面加号）⇒ 只匹配 "C:+Users+"，
  // 真实的 Windows 用户目录（盘符 + 反斜杠 + Users + 反斜杠）一个都抓不到 —— 这条守卫从来没生效过。
  // 用 \x5c 表示反斜杠，避免再被转义坑一把。
  { id: 'user-home', re: /[A-Za-z]:\x5cUsers\x5c[^\s`'"]+/, why: '本机用户目录' },
  { id: 'key-dir', re: /[A-Za-z]:\x5cMyKey\b/i, why: '密钥目录名' },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, why: 'GitHub token' },
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/, why: 'API key' },
  { id: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/, why: 'AWS key' },
  { id: 'private-key', re: /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/, why: '私钥' },
  { id: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/, why: 'Bearer token' },
  { id: 'session-uuid', re: /session-(?!0{6,}|a{6,}|b{6,}|d{6,}|1{4}abcd|1234abcd)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, why: '真实会话 UUID' },
];

/**
 * 取待扫文件列表：优先 `git ls-files`；**没有 git 时退化成目录遍历**。
 * 为什么要有 fallback：导出的 tarball / 发行包里没有 `.git`，`git ls-files` 会直接抛
 * （2026-11-04 可交付性闸实测：`git archive` 导出的目录里 check 根本跑不起来）。
 */
export function listFilesToScan({ cwd = process.cwd() } = {}) {
  try {
    // 2026-11-04 修：`git ls-files` 对非 ASCII 路径会加引号转义（"docs/\350..."），
    // existsSync 于是一律失败 ⇒ 本仓大量中文名文档被静默跳过。用 -z 拿 NUL 分隔的原始路径。
    return execSync('git ls-files -z', { cwd, encoding: 'utf8' }).split('\u0000').filter(Boolean);
  } catch {
    const SKIP_DIRS = new Set(['.git', 'node_modules', 'tmp', 'dist', 'coverage', '.cache', '.next', 'out']);
    const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zst|zstd|zip|gz|tgz|woff2?|ttf|otf|mp4|mp3|wav|exe|dll|node)$/i;
    const out = [];
    const walk = (dir) => {
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs); continue; }
        if (!e.isFile() || SKIP_EXT.test(e.name)) continue;
        out.push(path.relative(cwd, abs).split(path.sep).join('/'));
      }
    };
    walk(cwd);
    return out.sort();
  }
}

export function scanPrivacy({ cwd = process.cwd() } = {}) {
  const files = listFilesToScan({ cwd });
  const findings = [];
  for (const file of files) {
    const abs = `${cwd}/${file}`;
    if (!existsSync(abs)) continue;
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (const rule of RULES) {
      for (let i = 0; i < lines.length; i += 1) {
        if (!rule.re.test(lines[i])) continue;
        if (rule.id === 'session-uuid' && SYNTHETIC_SESSIONS.some((p) => lines[i].includes(p))) continue;
        // 占位符形态（脱敏清单里写规则本身）不算泄漏：<name> / <user> / <user-home>
        if (rule.id === 'user-home' && (lines[i].includes('Users\<') || lines[i].includes('<user-home>'))) continue;
        findings.push({ file, line: i + 1, rule: rule.id, why: rule.why, sample: lines[i].trim().slice(0, 120) });
      }
    }
  }
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('privacy-scan.mjs')) {
  const findings = scanPrivacy();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ findings, count: findings.length }, null, 2));
  } else {
    for (const f of findings) console.error(`${f.file}:${f.line} [${f.rule}] ${f.why} :: ${f.sample}`);
    console.log(findings.length ? `privacy-scan: ${findings.length} 处需脱敏` : 'privacy-scan: PASS（0 处）');
  }
  process.exitCode = findings.length ? 1 : 0;
}

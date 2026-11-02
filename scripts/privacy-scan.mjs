#!/usr/bin/env node
// 脱敏守卫：公开仓库里不允许出现内网地址、本机用户目录、密钥形态、真实会话 UUID。
// 用法：node scripts/privacy-scan.mjs [--json]
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const SYNTHETIC_SESSIONS = ['session-0000000','session-11111111','session-1234abcd','session-99999999','session-aaaaaaa','session-bbbbbbb','session-ccccccc','session-ddddddd','session-22222222','session-33333333'];

const RULES = [
  { id: 'private-ip', re: /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/, why: '内网 IP' },
  { id: 'user-home', re: /[A-Za-z]:\+Users\+[^\\s`'"]+/, why: '本机用户目录' },
  { id: 'key-dir', re: /[A-Za-z]:\+MyKey\b/i, why: '密钥目录名' },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, why: 'GitHub token' },
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/, why: 'API key' },
  { id: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/, why: 'AWS key' },
  { id: 'private-key', re: /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/, why: '私钥' },
  { id: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/, why: 'Bearer token' },
  { id: 'session-uuid', re: /session-(?!0{6,}|a{6,}|b{6,}|d{6,}|1{4}abcd|1234abcd)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, why: '真实会话 UUID' },
];

export function scanPrivacy({ cwd = process.cwd() } = {}) {
  const files = execSync('git ls-files', { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);
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

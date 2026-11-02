#!/usr/bin/env node
// 仓库自检：版本一致性 + 必备文件 + 私有/不发 npm + 房间清单存在
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const fail = [];
const ok = [];
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const pkg = JSON.parse(read('package.json'));
if (pkg.private !== true) fail.push('package.json: private 必须为 true（不发 npm）');
else ok.push('private:true');
if (pkg.version && pkg.name) ok.push(`version=${pkg.version}`);

const changelog = read('CHANGELOG.md');
if (!changelog.includes(`## ${pkg.version}`)) fail.push(`CHANGELOG.md: 缺少 ${pkg.version} 段`);
else ok.push('changelog 有当前版本段');

for (const f of ['AGENTS.md', 'MAINTENANCE.md', '方案.md', 'docs/记忆的职责边界.md', 'docs/拷问记录.md', 'docs/对标-Hindsight.md']) {
  if (!existsSync(new URL(`../${f}`, import.meta.url))) fail.push(`缺少 ${f}`); else ok.push(f);
}

// 房间目录与 AGENTS §11 的清单对得上（M1 起逐步增加）
const rooms = ['src/rooms/episode.mjs', 'src/rooms/logread.mjs', 'src/rooms/graphread.mjs', 'src/rooms/extract.mjs', 'src/rooms/topic.mjs', 'src/rooms/link.mjs', 'src/rooms/index.mjs', 'src/rooms/cli.mjs', 'src/rooms/persist.mjs', 'src/rooms/thread.mjs', 'src/rooms/joseki.mjs', 'src/rooms/claim.mjs', 'src/rooms/walk.mjs', 'src/rooms/inject.mjs', 'src/rooms/gates.mjs', 'src/rooms/adjudicate.mjs'];
const missing = rooms.filter((r) => !existsSync(new URL(`../${r}`, import.meta.url)));
const strictRooms = process.argv.includes('--strict-rooms');
if (missing.length && strictRooms) fail.push(`房间未建：${missing.join(', ')}`);
else if (missing.length) console.warn(`warn 房间未建（M1 进行中）：${missing.join(', ')}`);
else ok.push('房间齐');

// 防止误发 npm：package.json 里不得出现 publishConfig.registry
if (pkg.publishConfig?.registry) fail.push('package.json: 不允许 publishConfig.registry（不发 npm）');

// 脱敏守卫：公开仓库不允许内网地址/本机用户目录/密钥形态/真实会话 UUID
try {
  const { scanPrivacy } = await import('./privacy-scan.mjs');
  const leaks = scanPrivacy();
  if (leaks.length) fail.push(`脱敏：${leaks.length} 处（${leaks.slice(0, 3).map((l) => `${l.file}:${l.line}[${l.rule}]`).join(' ')}…）`);
  else ok.push('privacy-scan 0 处');
} catch (error) {
  fail.push(`脱敏扫描跑不起来：${String(error?.message ?? error)}`);
}

// 工作树干净检查只在 release.mjs 做，这里只报分支
try { const br = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(); ok.push(`branch=${br}`); } catch { fail.push('不是 git 仓库'); }

console.log(ok.map((x) => `ok  ${x}`).join('\n'));
if (fail.length) { console.error(fail.map((x) => `ERR ${x}`).join('\n')); process.exit(1); }
console.log('check: PASS');

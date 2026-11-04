#!/usr/bin/env node
// 仓库自检：版本一致性 + 必备文件 + 私有/不发 npm + 房间清单存在
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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

// 防止 AGENTS §7 再写死版本/测试数（2026-11-02 审计 P1-3）：只允许指针
const agents = read('AGENTS.md');
if (!agents.includes('本节的旧快照会过期')) fail.push('AGENTS.md §7：必须保留「不写数字、只写去哪看」的指针段');
else {
  // 审计 P1-3 复盘：模板字符串里的 \s 会退化成 s（死断言）。改用区间扫描，不依赖正则转义。
  const from = agents.indexOf('## 7 ·');
  const to = agents.indexOf('## 8 ·');
  const sec7 = from >= 0 && to > from ? agents.slice(from, to) : '';
  const wroteNumber = sec7.includes('条测试') || /[0-9]+\s*条/.test(sec7) || /[0-9]+\.[0-9]+\.[0-9]+/.test(sec7);
  if (wroteNumber) fail.push('AGENTS.md §7：不要写回测试条数/版本号（数字请进 MAINTENANCE.md）');
  else ok.push('AGENTS §7 指针');
}

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

// 边界静态审计（2026-11-02）：模型可见字面量里不得出现指令式/治理痕迹
try {
  const { auditRepo } = await import('./boundary-audit.mjs');
  const hits = auditRepo();
  if (hits.length) fail.push(`边界：${hits.length} 处（${hits.slice(0, 2).map((h) => `${h.file}:${h.line}[${h.word}]`).join(' ')}…）`);
  else ok.push('boundary-audit 0 处');
} catch (error) {
  fail.push(`边界审计跑不起来：${String(error?.message ?? error)}`);
}

// 调研清单完整性（2026-11-03）：MAINTENANCE 的知识库清单必须覆盖 docs/调研 下的全部编号
try {
  const dir = new URL('../docs/调研/', import.meta.url);
  const nums = readdirSync(dir).map((f) => /^(\d{2})-/.exec(f)?.[1]).filter(Boolean);
  const ledger = read('MAINTENANCE.md') + read('AGENTS.md');
  const missing = nums.filter((n) => !new RegExp(`docs/调研/${n}|\`${n}-`).test(ledger));
  if (missing.length) fail.push(`MAINTENANCE 知识库清单缺：${missing.join(', ')}`);
  else ok.push(`调研清单 ${nums.length} 篇`);
} catch (error) {
  fail.push(`调研清单检查失败：${String(error?.message ?? error)}`);
}

// 工作树干净检查只在 release.mjs 做，这里只报分支
// 2026-11-04：没有 git 不算失败 —— 导出的 tarball / 发行包本来就没有 .git（可交付性闸要在这种目录里跑）。
// 目录里不能跑的是"发布前必须干净"这类判据；这里只记一行 note，不判红。
try { const br = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(); ok.push(`branch=${br}`); } catch { ok.push('branch=（无 git：导出的包，跳过）'); }

console.log(ok.map((x) => `ok  ${x}`).join('\n'));
if (fail.length) { console.error(fail.map((x) => `ERR ${x}`).join('\n')); process.exit(1); }
console.log('check: PASS');

#!/usr/bin/env node
// T195 · 只写 **staging** 的 profile patch 生成器：把"记忆插件确定启用 + 工具面挂上"落成待替换文件 + 一键脚本。
//
// 铁律（$DSH_HOME/AGENTS.md §3）：`profiles/*/cordis.patch.yml` 是热重载开关，会话里**绝不直接写**。
// 所以本脚本只产出：
//   tmp/cordis.patch.staged.yml     —— 待替换内容（默认 dry-run 只在终端打印 diff 摘要，--apply 才写）
//   tmp/apply-kifu-profile.sh / .ps1 —— 备份 → 校验 → 原子替换 → 打印回滚命令
// 真正落盘由**用户**执行那一行命令完成。
//
// 用法：
//   node scripts/kifu-profile-stage.mjs                # dry-run：只打印 diff 摘要
//   node scripts/kifu-profile-stage.mjs --apply        # 写 tmp/ 三个文件（仍不碰 profile）
//   node scripts/kifu-profile-stage.mjs --verify <f>   # 只校验一个文件（apply 脚本内部用这个）
//
// 幂等：已存在 `- id: kifu-tools` ⇒ 不重复追加；已无矛盾的 disabled ⇒ 不再改那一段。跑两次结果相同。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const TOOLS_ID = 'kifu-tools';
export const MEMORY_ID = 'dsh-gokifu-longmemory';
const KIFU_RE = /kifu|gokifu/i;

export function defaultHome(env = process.env) {
  return path.resolve(env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || '.', 'DeepSeek Harness', 'home'));
}

/** 工具面条目：原样搬 `scripts/print-tools-plugin-entry.mjs` 的输出片段（不复制常量，避免漂移）。 */
export function toolsEntryBlock(repoRoot = REPO_ROOT) {
  const out = execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'print-tools-plugin-entry.mjs')], { encoding: 'utf8' });
  const lines = out.split('\n');
  const start = lines.findIndex((l) => l.startsWith('# === 棋院工具面'));
  if (start < 0) throw new Error('print-tools-plugin-entry 的输出里找不到工具面条目块');
  const block = [];
  for (let i = start; i < lines.length; i += 1) {
    block.push(lines[i]);
    if (/^\s+name:\s*\S+\/tools\s*$/.test(lines[i])) break;
  }
  return block.join('\n');
}

/**
 * 结构校验（无新依赖）：
 *   · 顶层必须是条目数组（每个非注释、非空行要么是 `- ` 起始，要么是缩进的键值/列表）
 *   · 不许有 tab 缩进、不许有未闭合的引号
 *   · 若运行环境里真有 `yaml`，额外用它解析一次（有就顺带用，没有也不引入）
 * @returns {{ok:boolean, errors:string[], parsedEntries:number, yamlModule:boolean}}
 */
export function verifyPatch(text) {
  const errors = [];
  const lines = String(text ?? '').split('\n');
  if (!lines.some((l) => /^- /.test(l))) errors.push('顶层没有任何 "- " 条目（patch 必须是顶层数组）');
  let entries = 0;
  let inBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.includes('\t')) errors.push(`第 ${i + 1} 行含 TAB（YAML 只允许空格缩进）`);
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    if (/^- /.test(line)) { entries += 1; inBlock = true; continue; }
    if (/^\s+\S/.test(line)) { if (!inBlock) errors.push(`第 ${i + 1} 行是缩进行但没有所属条目`); continue; }
    errors.push(`第 ${i + 1} 行既不是 "- " 条目也不是缩进行：${line.slice(0, 60)}`);
  }
  const quotes = (String(text ?? '').match(/(['"])/g) ?? []).length;
  if (quotes % 2 !== 0) errors.push('引号数量为奇数（可能有未闭合的引号）');
  // 项目没有 yaml 依赖；这里"有就顺带用，没有就走结构校验"，不引入任何新依赖。
  let yamlModule = false;
  let probeFile = null;
  try {
    probeFile = path.join(os.tmpdir(), `kifu-verify-${process.pid}-${Date.now()}.yml`);
    fs.writeFileSync(probeFile, String(text ?? ''));
    const out = execFileSync(process.execPath, ['-e', "const y=require('yaml');const fs=require('fs');const j=y.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(Array.isArray(j)?String(j.length):'not-array')", probeFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    yamlModule = true;
    if (out.trim() === 'not-array') errors.push('yaml 解析结果不是顶层数组');
  } catch {
    yamlModule = false; // 没有 yaml 模块属预期：结构校验已覆盖
  } finally {
    if (probeFile) { try { fs.rmSync(probeFile, { force: true }); } catch { /* ignore */ } }
  }
  return { ok: errors.length === 0, errors, parsedEntries: entries, yamlModule };
}

/**
 * 生成 staged 内容：
 *   ① 删掉"同名条目一条 enabled 一条 disabled"的矛盾段（注释行 + 两/多条 disabled 条目），
 *      在原位置写回**一条**启用条目 `- id: dsh-gokifu-longmemory / name: dsh-gokifu-longmemory`；
 *   ② 末尾追加 `kifu-tools` 条目（已有则跳过）。
 * @returns {{text:string, changes:Array<{kind:string, detail:string}>, removed:number, added:number}}
 */
export function stagePatch(sourceText, { toolsBlock = null } = {}) {
  const lines = String(sourceText ?? '').split('\n');
  const changes = [];
  const out = [];
  let removed = 0;
  let insertedMemory = false;
  let skippedMemory = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isKifuEntryStart = /^- /.test(line);
    if (!isKifuEntryStart) { out.push(line); continue; }
    // 收集该条目块
    const block = [line];
    let j = i + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j])) { block.push(lines[j]); j += 1; }
    const blockText = block.join('\n');
    const idM = /^-\s+id:\s*(\S+)/.exec(line);
    const id = idM ? idM[1].replace(/^['"]|['"]$/g, '') : null;
    const isKifu = KIFU_RE.test(id ?? '') || KIFU_RE.test(blockText);
    if (isKifu && /^\s+disabled:\s*true\s*$/m.test(blockText)) {
      removed += 1;
      changes.push({ kind: 'remove-disabled', detail: `${id ?? '(no id)'}（原第 ${i + 1} 行）` });
      if (!insertedMemory) {
        // 用一条**启用**的条目替代（只在第一次删除的位置插入）
        out.push(`- id: ${MEMORY_ID}`, `  name: ${MEMORY_ID}`);
        insertedMemory = true;
        changes.push({ kind: 'enable', detail: `- id: ${MEMORY_ID} / name: ${MEMORY_ID}` });
      }
      i = j - 1;
      continue;
    }
    if (KIFU_RE.test(id ?? '') && !/^\s+disabled:\s*true\s*$/m.test(blockText)) {
      skippedMemory += 1; // 已经是启用条目，保留原样
    }
    out.push(...block);
    i = j - 1;
  }

  // 工具面条目
  let added = 0;
  const hasTools = out.some((l) => new RegExp(`^-\\s+id:\\s*['"]?${TOOLS_ID}['"]?\\s*$`).test(l));
  if (!hasTools) {
    const block = toolsBlock ?? toolsEntryBlock();
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(block);
    added = 1;
    changes.push({ kind: 'add', detail: `- id: ${TOOLS_ID}（原样搬 print-tools-plugin-entry 输出）` });
  }
  return { text: out.join('\n'), changes, removed, added, keptEnabled: skippedMemory };
}

/** 生成一键脚本（bash + PowerShell）：备份 → 校验 → 原子替换 → 打印回滚。 */
export function buildApplyScripts({ stagedPath, targetPath, backupDir }) {
  // bash 里反斜杠会转义引号：Windows 路径统一成正斜杠（Git Bash 认）
  const posix = (p) => String(p ?? '').split(String.fromCharCode(92)).join('/');
  const stagedSh = posix(stagedPath);
  const targetSh = posix(targetPath);
  const backupSh = posix(backupDir);
  const repoSh = posix(REPO_ROOT);
  const sh = `#!/usr/bin/env bash
# T195 · 把 staging 后的 cordis.patch.yml 换上（**由用户执行**；本脚本自身不重启 DSH）
set -euo pipefail
STAGED="\${1:-${stagedSh}}"
TARGET="\${2:-${targetSh}}"
BACKUP_DIR="\${3:-${backupSh}}"
REPO="\${REPO_ROOT:-${repoSh}}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$BACKUP_DIR/cordis.patch.yml.bak-$STAMP"

echo "staged : $STAGED"
echo "target : $TARGET"

[ -f "$STAGED" ] || { echo "缺 staged 文件：$STAGED" >&2; exit 2; }
[ -f "$TARGET" ] || { echo "缺目标文件：$TARGET" >&2; exit 2; }

# 1) 校验（结构 + 有 yaml 模块时额外解析）；失败就**不替换**
if ! node "$REPO/scripts/kifu-profile-stage.mjs" --verify "$STAGED"; then
  echo "校验失败：目标文件未被修改" >&2
  exit 3
fi

# 2) 备份
mkdir -p "$BACKUP_DIR"
cp -p "$TARGET" "$BACKUP"

# 3) 原子替换（同目录临时文件 + rename）
TMP="$TARGET.tmp.$STAMP"
cp "$STAGED" "$TMP"
mv -f "$TMP" "$TARGET"

echo "已替换：$TARGET"
echo "回滚命令： cp -p \\"$BACKUP\\" \\"$TARGET\\""
echo "然后由你在桌面点「重启」让配置生效（本脚本不会重启 DSH）。"
`;
  const ps1 = `# T195 · 把 staging 后的 cordis.patch.yml 换上（由用户执行；本脚本不重启 DSH）
param(
  [string]$Staged = "${stagedPath}",
  [string]$Target = "${targetPath}",
  [string]$BackupDir = "${backupDir}"
)
$ErrorActionPreference = "Stop"
$repo = if ($env:REPO_ROOT) { $env:REPO_ROOT } else { "${REPO_ROOT}" }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path $BackupDir ("cordis.patch.yml.bak-" + $stamp)

Write-Host "staged : $Staged"
Write-Host "target : $Target"
if (-not (Test-Path $Staged)) { Write-Error "缺 staged 文件：$Staged"; exit 2 }
if (-not (Test-Path $Target)) { Write-Error "缺目标文件：$Target"; exit 2 }

# 1) 校验失败就不替换
& node (Join-Path $repo "scripts/kifu-profile-stage.mjs") --verify $Staged
if ($LASTEXITCODE -ne 0) { Write-Error "校验失败：目标文件未被修改"; exit 3 }

# 2) 备份
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
Copy-Item $Target $backup -Force

# 3) 原子替换（同目录临时文件 + Move -Force）
$tmp = "$Target.tmp.$stamp"
Copy-Item $Staged $tmp -Force
Move-Item $tmp $Target -Force

Write-Host "已替换：$Target"
Write-Host "回滚命令： Copy-Item '$backup' '$Target' -Force"
Write-Host "然后由你在桌面点「重启」让配置生效（本脚本不会重启 DSH）。"
`;
  return { sh, ps1 };
}

/** 主流程：读 profile patch → stage → （--apply 时）写 tmp 三个文件。 */
export function runStage({ home = defaultHome(), profile = 'desktop', apply = false, repoRoot = REPO_ROOT } = {}) {
  const profileDir = path.join(home, 'profiles', profile);
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  if (!fs.existsSync(patchPath)) return { code: 2, error: `找不到 profile patch：${patchPath}` };
  const source = fs.readFileSync(patchPath, 'utf8');
  const staged = stagePatch(source, { toolsBlock: toolsEntryBlock(repoRoot) });
  const check = verifyPatch(staged.text);

  const tmpDir = path.join(repoRoot, 'tmp');
  const stagedPath = path.join(tmpDir, 'cordis.patch.staged.yml');
  const shPath = path.join(tmpDir, 'apply-kifu-profile.sh');
  const ps1Path = path.join(tmpDir, 'apply-kifu-profile.ps1');
  const backupDir = path.join(profileDir, 'backup');
  const scripts = buildApplyScripts({ stagedPath, targetPath: patchPath, backupDir });

  const result = {
    code: check.ok ? 0 : 3,
    patchPath,
    stagedPath,
    shPath,
    ps1Path,
    changes: staged.changes,
    removed: staged.removed,
    added: staged.added,
    verify: check,
    applied: false,
    diffSummary: summarizeDiff(source, staged.text),
  };
  if (apply) {
    if (!check.ok) return { ...result, code: 3, error: `staged 校验失败：${check.errors.join('; ')}` };
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(stagedPath, staged.text);
    fs.writeFileSync(shPath, scripts.sh);
    fs.writeFileSync(ps1Path, scripts.ps1);
    result.applied = true;
  }
  return result;
}

/** 只打印"改了几处"的摘要，不打印全文。 */
export function summarizeDiff(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  const tally = (arr) => {
    const m = new Map();
    for (const l of arr) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const ta = tally(a);
  const tb = tally(b);
  // 按"行内容的多重集差"计数（同名条目重复出现也不会互相抵消）
  const removed = [];
  const added = [];
  for (const [line, n] of ta) {
    const extra = n - (tb.get(line) ?? 0);
    for (let k = 0; k < extra; k += 1) removed.push(line);
  }
  for (const [line, n] of tb) {
    const extra = n - (ta.get(line) ?? 0);
    for (let k = 0; k < extra; k += 1) added.push(line);
  }
  return { beforeLines: a.length, afterLines: b.length, removedLines: removed.length, addedLines: added.length, added, removed };
}

export function formatReport(r) {
  if (r.error) return `kifu-profile-stage: ${r.error}`;
  const lines = [];
  lines.push(`profile patch：${r.patchPath}`);
  lines.push(`staged（${r.applied ? '已写' : 'dry-run，未写'}）：${r.stagedPath}`);
  lines.push(`改动 ${r.changes.length} 处：`);
  for (const c of r.changes) lines.push(`  · [${c.kind}] ${c.detail}`);
  const d = r.diffSummary;
  lines.push(`diff：-${d.removedLines} / +${d.addedLines} 行（${d.beforeLines} → ${d.afterLines}）`);
  lines.push(`校验：${r.verify.ok ? 'OK' : `失败（${r.verify.errors.join('; ')}）`} · 条目 ${r.verify.parsedEntries} 个 · yaml 模块 ${r.verify.yamlModule ? '可用' : '不可用（已用结构校验替代）'}`);
  lines.push(`工具面条目：${r.added === 0 ? '已存在（跳过）' : '已追加 1 条'}`);
  if (r.applied) {
    lines.push('');
    lines.push('下一步（由**你**执行，我不重启 DSH）：');
    lines.push(`  bash "${r.shPath}"`);
    lines.push(`  # 或 PowerShell: pwsh -File "${r.ps1Path}"`);
  }
  return lines.join('\n');
}

export function runCli(argv = process.argv.slice(2)) {
  const vi = argv.indexOf('--verify');
  if (vi >= 0) {
    const file = argv[vi + 1];
    if (!file || !fs.existsSync(file)) return { code: 2, stdout: `缺文件：${file}` };
    const res = verifyPatch(fs.readFileSync(file, 'utf8'));
    return {
      code: res.ok ? 0 : 3,
      stdout: res.ok
        ? `校验 OK（条目 ${res.parsedEntries} 个 · yaml 模块 ${res.yamlModule ? '可用' : '不可用，已用结构校验替代'}）`
        : `校验失败：\n${res.errors.map((e) => `  - ${e}`).join('\n')}`,
    };
  }
  const apply = argv.includes('--apply');
  const pi = argv.indexOf('--profile');
  const profile = pi >= 0 ? argv[pi + 1] : 'desktop';
  const r = runStage({ profile, apply });
  return { code: r.code, stdout: formatReport(r) };
}

export function main(argv = process.argv.slice(2)) {
  const res = runCli(argv);
  process.stdout.write(`${res.stdout}\n`);
  return res.code;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invoked) process.exitCode = main();

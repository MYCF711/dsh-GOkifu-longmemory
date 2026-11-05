#!/usr/bin/env node
// T195/T217 · 只写 **staging** 的 profile patch 生成器：把"记忆插件确定启用 + 工具面挂上"落成待替换文件 + 一键脚本。
//
// ⚠ 热重载风险（AGENTS.md §2.2，2026-10-30 真机事故）：
//   `profiles/*/cordis.patch.yml` 是**热重载开关** —— 运行中写它会让整树热重载，
//   idle 的子代理可能读到已撤销的 inbox 投影 ⇒ 未捕获 Promise ⇒ host `exit(1)`。
//   所以本脚本**只产出 staging**，真正替换由**用户在方便时**执行；脚本自身绝不重启 DSH。
//
// 用法：
//   node scripts/kifu-profile-stage.mjs                # dry-run：只打印 diff 摘要
//   node scripts/kifu-profile-stage.mjs --apply        # 写 tmp/ 三个文件（仍不碰 profile）
//   node scripts/kifu-profile-stage.mjs --verify <f>   # 只校验一个文件（apply 脚本内部用）
//
// T217（独立复核 T215 判定"不能直接跑"后的修复）：
//   F1 真 YAML 解析（用 profile 里的 yaml@2.9.x，找不到才回落结构校验并醒目告警）
//   F2 staging 记录目标 sha256，apply 前比对，不一致 ⇒ 拒绝写（exit 5）
//   F3 备份后 cmp + 打印 sha256；回滚走"cp 到临时文件再 mv"
//   F4 顶部热重载提示；PS1 用 `Write-Host …; exit N`（`Write-Error` 会先抛终止错误，退成 1）
//   F5 备份文件名带毫秒；文件结尾补换行
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
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

/** 在 profile / 仓库里定位 `yaml` 模块（本机仓库没有 node_modules）。 */
export function yamlModulePath({ home = defaultHome(), profile = 'desktop' } = {}) {
  const bases = [path.join(home, 'profiles', profile, 'package.json'), path.join(REPO_ROOT, 'package.json')];
  for (const base of bases) {
    try {
      return createRequire(base).resolve('yaml');
    } catch { /* 试下一个 */ }
  }
  return null;
}

/**
 * T217 F1 · 真 YAML 校验。
 * 查找顺序：`<DSH_HOME>/profiles/<profile>/node_modules/yaml` → 仓库 `node_modules/yaml`
 * → 都没有才回落"结构校验"，且**必须**带醒目 warning（不是 YAML 校验）。
 * @returns {{ok:boolean, errors:string[], parsedEntries:number, engine:string, path?:string, warning?:string}}
 */
export function verifyPatch(text, { home = defaultHome(), profile = 'desktop' } = {}) {
  const NL = String.fromCharCode(10);
  const modPath = yamlModulePath({ home, profile });
  if (modPath) {
    try {
      const yaml = createRequire(modPath)('yaml');
      let ver = yaml.version;
      if (!ver) {
        try { ver = JSON.parse(fs.readFileSync(path.join(path.dirname(modPath), '..', 'package.json'), 'utf8')).version; } catch { /* 版本可选 */ }
      }
      const doc = yaml.parse(String(text ?? ''));
      if (!Array.isArray(doc)) {
        return { ok: false, errors: ['顶层不是数组（patch 必须是顶层数组）'], parsedEntries: 0, engine: 'yaml', path: modPath };
      }
      return { ok: true, errors: [], parsedEntries: doc.length, engine: `yaml@${ver ?? '?'}`, path: modPath };
    } catch (error) {
      return { ok: false, errors: [String(error?.message ?? error).split(NL)[0].slice(0, 240)], parsedEntries: 0, engine: 'yaml', path: modPath };
    }
  }
  // 回落：结构校验（结果里带 warning，调用方必须打印）
  const errors = [];
  const text2 = String(text ?? '');
  const lines = text2.split(NL);
  if (!lines.some((l) => l.startsWith('- '))) errors.push('顶层没有 "- " 条目（patch 必须是顶层数组）');
  if (text2.includes(String.fromCharCode(9))) errors.push('含 TAB（YAML 只允许空格缩进）');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*[A-Za-z0-9_$.-]+:\s*([[{])/.exec(lines[i]);
    if (!m) continue;
    const close = m[1] === '[' ? ']' : '}';
    if (!lines[i].includes(close)) errors.push(`第 ${i + 1} 行 ${m[1]} 未闭合`);
  }
  return {
    ok: errors.length === 0,
    errors,
    parsedEntries: lines.filter((l) => l.startsWith('- ')).length,
    engine: 'fallback-structural',
    warning: '⚠ 结构校验，不是 YAML 校验（找不到 yaml 模块）',
  };
}

export function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/**
 * 生成 staged 内容：把矛盾的 disabled 段换成一条启用条目，并追加 `kifu-tools`（已有则跳过）。
 * @returns {{text:string, changes:Array<{kind:string,detail:string}>, removed:number, added:number}}
 */
export function stagePatch(sourceText, { toolsBlock = null } = {}) {
  const lines = String(sourceText ?? '').split('\n');
  const changes = [];
  const out = [];
  let removed = 0;
  let insertedMemory = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^- /.test(line)) { out.push(line); continue; }
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
        out.push(`- id: ${MEMORY_ID}`, `  name: ${MEMORY_ID}`);
        insertedMemory = true;
        changes.push({ kind: 'enable', detail: `- id: ${MEMORY_ID} / name: ${MEMORY_ID}` });
      }
      i = j - 1;
      continue;
    }
    out.push(...block);
    i = j - 1;
  }

  let added = 0;
  const hasTools = out.some((l) => new RegExp(`^-\\s+id:\\s*['"]?${TOOLS_ID}['"]?\\s*$`).test(l));
  if (!hasTools) {
    const block = toolsBlock ?? toolsEntryBlock();
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(block);
    added = 1;
    changes.push({ kind: 'add', detail: `- id: ${TOOLS_ID}（原样搬 print-tools-plugin-entry 输出）` });
  }
  const text = out.join('\n');
  return { text: text.endsWith('\n') ? text : `${text}\n`, changes, removed, added };
}

/**
 * 生成一键脚本（F3/F4/F5）。
 * 退出码：0 成功 · 2 缺文件 · 3 YAML 校验失败 · 4 备份 sha256 不一致 · 5 目标已被别人改过（base sha 不一致）
 */
export function buildApplyScripts({ stagedPath, targetPath, backupDir, baseSha = null }) {
  const posix = (p) => String(p ?? '').split(String.fromCharCode(92)).join('/');
  const stagedSh = posix(stagedPath);
  const targetSh = posix(targetPath);
  const backupSh = posix(backupDir);
  const repoSh = posix(REPO_ROOT);
  const baseShaSh = baseSha ?? '';
  const sh = `#!/usr/bin/env bash
# T217 · 把 staging 后的 cordis.patch.yml 换上（**由主人执行**；本脚本不重启 DSH）
#
# ⚠ 热重载风险：运行中替换 cordis.patch.yml 会整树热重载，可能让 host exit(1)
#   （AGENTS.md §2.2 / 2026-10-30 事故）。请在最方便的时候跑，跑完在桌面点「重启」。
#
# 退出码：0 成功 · 2 缺文件 · 3 YAML 校验失败 · 4 备份 sha256 不一致 · 5 目标已被别人改过
set -euo pipefail
STAGED="\${1:-${stagedSh}}"
TARGET="\${2:-${targetSh}}"
BACKUP_DIR="\${3:-${backupSh}}"
REPO="\${REPO_ROOT:-${repoSh}}"
BASE_SHA="\${KIFU_BASE_SHA:-${baseShaSh}}"
STAMP="$(date +%Y%m%d-%H%M%S-%3N)"
BACKUP="$BACKUP_DIR/cordis.patch.yml.bak-$STAMP"

echo "staged : $STAGED"
echo "target : $TARGET"
[ -f "$STAGED" ] || { echo "缺 staged 文件：$STAGED" >&2; exit 2; }
[ -f "$TARGET" ] || { echo "缺目标文件：$TARGET" >&2; exit 2; }

# F2 · 目标必须还是 staging 时那一份（防静默盖掉别人的改动）
CUR_SHA=$(sha256sum "$TARGET" | awk '{print $1}' | sed 's/^[^0-9a-f]*//')
if [ -n "$BASE_SHA" ] && [ "$CUR_SHA" != "$BASE_SHA" ]; then
  echo "目标已被别人改过：期望 $BASE_SHA，实际 $CUR_SHA —— 拒绝写" >&2
  exit 5
fi

# F1 · 真 YAML 校验（失败就不替换）
node "$REPO/scripts/kifu-profile-stage.mjs" --verify "$STAGED" || { echo "校验失败：目标文件未被修改" >&2; exit 3; }

# F3 · 备份 + cmp + 打印 sha256
mkdir -p "$BACKUP_DIR"
cp -p "$TARGET" "$BACKUP"
BAK_SHA=$(sha256sum "$BACKUP" | awk '{print $1}' | sed 's/^[^0-9a-f]*//')
echo "备份：$BACKUP"
echo "  target sha256 = $CUR_SHA"
echo "  backup sha256 = $BAK_SHA"
if [ "$CUR_SHA" != "$BAK_SHA" ]; then
  echo "备份 sha256 与源不一致 —— 拒绝继续（目标未动）" >&2
  exit 4
fi

# 原子替换：同目录临时文件 + mv
TMP="$TARGET.tmp.$STAMP"
cp "$STAGED" "$TMP"
mv -f "$TMP" "$TARGET"

echo "已替换：$TARGET"
echo "回滚（cp 到临时文件再 mv，中途被杀也不会留半截）："
echo "  cp -p \\"$BACKUP\\" \\"$TARGET.rollback.$STAMP\\" && mv -f \\"$TARGET.rollback.$STAMP\\" \\"$TARGET\\""
echo "然后由你在桌面点「重启」让配置生效（本脚本不会重启 DSH）。"
`;
  const ps1 = `# T217 · 把 staging 后的 cordis.patch.yml 换上（由主人执行；本脚本不重启 DSH）
# ⚠ 热重载风险：运行中替换会整树热重载，可能让 host exit(1)（AGENTS.md §2.2）。
# 退出码：0 成功 · 2 缺文件 · 3 YAML 校验失败 · 4 备份 sha256 不一致 · 5 目标已被别人改过
param(
  [string]$Staged = "${stagedPath}",
  [string]$Target = "${targetPath}",
  [string]$BackupDir = "${backupDir}"
)
$ErrorActionPreference = "Stop"
$repo = if ($env:REPO_ROOT) { $env:REPO_ROOT } else { "${REPO_ROOT}" }
$baseSha = if ($env:KIFU_BASE_SHA) { $env:KIFU_BASE_SHA } else { "${baseShaSh}" }
$stamp = (Get-Date).ToString("yyyyMMdd-HHmmss-fff")
$backup = Join-Path $BackupDir ("cordis.patch.yml.bak-" + $stamp)

Write-Host "staged : $Staged"
Write-Host "target : $Target"
if (-not (Test-Path $Staged)) { Write-Host "缺 staged 文件：$Staged"; exit 2 }
if (-not (Test-Path $Target)) { Write-Host "缺目标文件：$Target"; exit 2 }

$curSha = (Get-FileHash $Target -Algorithm SHA256).Hash.ToLower()
if ($baseSha -and $curSha -ne $baseSha) { Write-Host "目标已被别人改过：期望 $baseSha，实际 $curSha —— 拒绝写"; exit 5 }

& node (Join-Path $repo "scripts/kifu-profile-stage.mjs") --verify $Staged
if ($LASTEXITCODE -ne 0) { Write-Host "校验失败：目标文件未被修改"; exit 3 }

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
Copy-Item $Target $backup -Force
$bakSha = (Get-FileHash $backup -Algorithm SHA256).Hash.ToLower()
Write-Host "备份：$backup"
Write-Host "  target sha256 = $curSha"
Write-Host "  backup sha256 = $bakSha"
if ($curSha -ne $bakSha) { Write-Host "备份 sha256 与源不一致 —— 拒绝继续（目标未动）"; exit 4 }

$tmp = "$Target.tmp.$stamp"
Copy-Item $Staged $tmp -Force
Move-Item $tmp $Target -Force

Write-Host "已替换：$Target"
Write-Host "回滚（cp 到临时文件再 mv）："
Write-Host "  Copy-Item '$backup' '$Target.rollback.$stamp' -Force; Move-Item '$Target.rollback.$stamp' '$Target' -Force"
Write-Host "然后由你在桌面点「重启」让配置生效（本脚本不会重启 DSH）。"
`;
  return { sh, ps1 };
}

/** 主流程：读 profile patch → stage → （--apply 时）写 tmp 三个文件（+ base sha）。 */
export function runStage({ home = defaultHome(), profile = 'desktop', apply = false, repoRoot = REPO_ROOT } = {}) {
  const profileDir = path.join(home, 'profiles', profile);
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  if (!fs.existsSync(patchPath)) return { code: 2, error: `找不到 profile patch：${patchPath}` };
  const source = fs.readFileSync(patchPath, 'utf8');
  const baseSha = sha256(source);
  const staged = stagePatch(source, { toolsBlock: toolsEntryBlock(repoRoot) });
  const check = verifyPatch(staged.text, { home, profile });

  const tmpDir = path.join(repoRoot, 'tmp');
  const stagedPath = path.join(tmpDir, 'cordis.patch.staged.yml');
  const shPath = path.join(tmpDir, 'apply-kifu-profile.sh');
  const ps1Path = path.join(tmpDir, 'apply-kifu-profile.ps1');
  const backupDir = path.join(profileDir, 'backup');
  const scripts = buildApplyScripts({ stagedPath, targetPath: patchPath, backupDir, baseSha });

  const result = {
    code: check.ok ? 0 : 3,
    patchPath,
    stagedPath,
    shPath,
    ps1Path,
    baseSha,
    stagedSha: sha256(staged.text),
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
  const removed = [];
  const added = [];
  for (const [line, n] of ta) { const extra = n - (tb.get(line) ?? 0); for (let k = 0; k < extra; k += 1) removed.push(line); }
  for (const [line, n] of tb) { const extra = n - (ta.get(line) ?? 0); for (let k = 0; k < extra; k += 1) added.push(line); }
  return { beforeLines: a.length, afterLines: b.length, removedLines: removed.length, addedLines: added.length, added, removed };
}

export function formatReport(r) {
  if (r.error) return `kifu-profile-stage: ${r.error}`;
  const lines = [];
  lines.push('⚠ 热重载风险：运行中替换 cordis.patch.yml 会整树热重载，可能让 host exit(1)（AGENTS.md §2.2）');
  lines.push(`profile patch：${r.patchPath}`);
  lines.push(`  base sha256   = ${r.baseSha}`);
  lines.push(`  staged sha256 = ${r.stagedSha}`);
  lines.push(`staged（${r.applied ? '已写' : 'dry-run，未写'}）：${r.stagedPath}`);
  lines.push(`改动 ${r.changes.length} 处：`);
  for (const c of r.changes) lines.push(`  · [${c.kind}] ${c.detail}`);
  const d = r.diffSummary;
  lines.push(`diff：-${d.removedLines} / +${d.addedLines} 行（${d.beforeLines} → ${d.afterLines}）`);
  if (r.verify.warning) lines.push(r.verify.warning);
  lines.push(`校验：${r.verify.ok ? 'OK' : `失败（${r.verify.errors.join('; ')}）`} · 引擎 ${r.verify.engine} · 条目 ${r.verify.parsedEntries} 个`);
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
    if (res.warning) process.stderr.write(`${res.warning}\n`);
    return {
      code: res.ok ? 0 : 3,
      stdout: res.ok ? `校验 OK（引擎 ${res.engine} · 条目 ${res.parsedEntries} 个）` : `校验失败：\n${res.errors.map((e) => `  - ${e}`).join('\n')}`,
    };
  }
  const apply = argv.includes('--apply');
  const pi = argv.indexOf('--profile');
  const r = runStage({ profile: pi >= 0 ? argv[pi + 1] : 'desktop', apply });
  return { code: r.code, stdout: formatReport(r) };
}

export function main(argv = process.argv.slice(2)) {
  const res = runCli(argv);
  process.stdout.write(`${res.stdout}\n`);
  return res.code;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invoked) process.exitCode = main();

// T195 的 tombstone test：删掉 `scripts/kifu-profile-doctor.mjs` / `kifu-profile-stage.mjs` 的实现 ⇒ 本文件红。
//
// 覆盖：
//   ① 矛盾条目被识别（同 name 一条 enabled 一条 disabled；重复 id）
//   ② staging 后 `kifu-tools` **恰好一条**，且记忆插件那两条矛盾 disabled 被换成一条启用
//   ③ 幂等：stagePatch 跑两次，输出逐字节相同
//   ④ YAML 校验失败时**不替换**（apply 脚本退出 3，目标文件原样）
//
// 全部在 os.tmpdir 下用假 profile；不碰 `$DSH_HOME`、不改任何真实 profile。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { parsePatchEntries, analyzeEntries, collectIds } from '../scripts/kifu-profile-doctor.mjs';
import { stagePatch, verifyPatch, buildApplyScripts, summarizeDiff } from '../scripts/kifu-profile-stage.mjs';

const FAKE_PATCH = `# fake profile patch
- id: alpha
  name: "@x/alpha"

# === 临时禁用：dsh-gokifu-longmemory ===
- id: kifu-longmemory
  name: dsh-gokifu-longmemory
  disabled: true
- id: dsh-gokifu-longmemory
  name: dsh-gokifu-longmemory
  disabled: true
- id: kifu-memory
  name: dsh-gokifu-longmemory
- id: beta
  name: "@x/beta"
`;

const TOOLS_BLOCK = `# === 棋院工具面（PTC / run_code）：kifu_* 五个只读工具 ===
- id: kifu-tools
  name: dsh-gokifu-longmemory/tools
`;

let tmp;
test.before(() => { tmp = mkdtempSync(path.join(tmpdir(), 'kifu-t195-')); });
test.after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

// ① 矛盾识别
test('T195 ①: 同 name 一条 enabled 一条 disabled ⇒ 报矛盾；重复 id 也要报', () => {
  const entries = parsePatchEntries(FAKE_PATCH);
  const a = analyzeEntries(entries);
  assert.equal(a.kifu.length, 3, `棋院相关条目 3 条，实际 ${a.kifu.length}`);
  assert.equal(a.contradictions.length, 1, '同名（dsh-gokifu-longmemory）既 enabled 又 disabled');
  assert.equal(a.contradictions[0].name, 'dsh-gokifu-longmemory');
  assert.equal(a.contradictions[0].disabled.length, 2);
  assert.equal(a.contradictions[0].enabled.length, 1);

  const dup = analyzeEntries(parsePatchEntries(`- id: same\n  name: a\n- id: same\n  name: a\n`));
  assert.equal(dup.duplicateIds.length, 1, '同一 id 出现两次要报');
  assert.deepEqual(dup.duplicateIds[0].lines, [1, 3]);
});

test('T195: bundle patch 的嵌套 id 也要收（顶层解析会漏）', () => {
  const ids = collectIds(`- insert:\n    - id: kifu-memory\n      name: 'kifu-loader'\n`);
  assert.deepEqual(ids, ['kifu-memory']);
});

// ② staging
test('T195 ②: staging 后 kifu-tools 恰好一条，矛盾 disabled 换成一条启用', () => {
  const staged = stagePatch(FAKE_PATCH, { toolsBlock: TOOLS_BLOCK });
  const tools = staged.text.split('\n').filter((l) => /^-\s+id:\s*kifu-tools\s*$/.test(l));
  assert.equal(tools.length, 1, `kifu-tools 必须恰好一条，实际 ${tools.length}`);

  const memory = staged.text.split('\n').filter((l) => /^-\s+id:\s*dsh-gokifu-longmemory\s*$/.test(l));
  assert.equal(memory.length, 1, '记忆插件条目只剩一条');
  assert.ok(!/id: kifu-longmemory/.test(staged.text), '旧的 kifu-longmemory 条目应被移除');
  assert.ok(!/disabled:\s*true/.test(staged.text), '残留的 disabled: true 会让下次重启行为不可预期');
  assert.equal(verifyPatch(staged.text).ok, true, JSON.stringify(verifyPatch(staged.text).errors));
  assert.ok(staged.changes.some((c) => c.kind === 'add'));
  assert.ok(staged.changes.some((c) => c.kind === 'remove-disabled'));
});

// ③ 幂等
test('T195 ③: stagePatch 跑两次输出逐字节相同（幂等）', () => {
  const once = stagePatch(FAKE_PATCH, { toolsBlock: TOOLS_BLOCK });
  const twice = stagePatch(once.text, { toolsBlock: TOOLS_BLOCK });
  assert.equal(twice.text, once.text, '第二遍不应再改任何东西');
  assert.equal(twice.added, 0, '已有 kifu-tools ⇒ 不重复追加');
  const d = summarizeDiff(once.text, twice.text);
  assert.equal(d.addedLines, 0);
  assert.equal(d.removedLines, 0);
});

// ④ 校验失败不替换
test('T195 ④: YAML 校验失败 ⇒ apply 脚本退出 3，目标文件不被替换', () => {
  const dir = mkdtempSync(path.join(tmp, 'apply-'));
  const target = path.join(dir, 'cordis.patch.yml');
  const staged = path.join(dir, 'cordis.patch.staged.yml');
  const backupDir = path.join(dir, 'backup');
  writeFileSync(target, FAKE_PATCH);
  // 故意写坏的 staged：TAB 缩进 + 不成条目
  writeFileSync(staged, `- id: kifu-tools\n\tname: broken\nplain text line\n`);
  assert.equal(verifyPatch(readFileSync(staged, 'utf8')).ok, false, '坏文件必须校验失败');

  const { sh } = buildApplyScripts({ stagedPath: staged, targetPath: target, backupDir });
  const shPath = path.join(dir, 'apply.sh');
  writeFileSync(shPath, sh);
  let code = 0;
  try {
    execFileSync('bash', [shPath], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    code = error.status ?? 1;
  }
  assert.equal(code, 3, `校验失败必须退出 3，实际 ${code}`);
  assert.equal(readFileSync(target, 'utf8'), FAKE_PATCH, '目标文件必须原样未动');

  // 好的 staged ⇒ 替换成功且留了备份
  const good = path.join(dir, 'good.yml');
  writeFileSync(good, stagePatch(FAKE_PATCH, { toolsBlock: TOOLS_BLOCK }).text);
  execFileSync('bash', [shPath, good], { encoding: 'utf8', stdio: 'pipe' });
  assert.match(readFileSync(target, 'utf8'), /kifu-tools/, '校验通过时才替换');
  mkdirSync(backupDir, { recursive: true });
  assert.ok(readFileSync(target, 'utf8').includes('dsh-gokifu-longmemory'));
});

// ── T217：真 YAML 校验 + base sha + 备份 sha256 + PS1 退出码 ─────────────────

const VALID = '- id: alpha\n  name: "@x/alpha"\n';

test('T217 ①: 真 YAML 解析 —— 四种非法全 FAIL，合法通过', () => {
  const ok = verifyPatch(VALID);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.match(ok.engine, /^yaml@|^fallback-structural$/);

  const bad = {
    '未闭合 [' : '- id: a\n  config: [1,2\n',
    '未闭合 {' : '- id: a\n  config: {x: 1\n',
    '非法锚点' : '- id: a\n  name: &\n',
    '重复键'   : '- id: a\n  id: b\n',
  };
  for (const [name, text] of Object.entries(bad)) {
    const r = verifyPatch(text);
    assert.equal(r.ok, false, `${name} 必须判 FAIL（实际 ${JSON.stringify(r)}）`);
    assert.ok(r.errors.length > 0, `${name} 必须给报错`);
  }
});

test('T217 ①b: 非法 staged ⇒ apply 脚本退出 3 且目标文件原样', () => {
  const dir = mkdtempSync(path.join(tmp, 'yaml-bad-'));
  const target = path.join(dir, 'cordis.patch.yml');
  const staged = path.join(dir, 'staged.yml');
  writeFileSync(target, FAKE_PATCH);
  writeFileSync(staged, '- id: a\n  config: [1,2\n'); // 未闭合
  const { sh } = buildApplyScripts({ stagedPath: staged, targetPath: target, backupDir: path.join(dir, 'backup') });
  const shPath = path.join(dir, 'apply.sh');
  writeFileSync(shPath, sh);
  let code = 0;
  try { execFileSync('bash', [shPath, staged, target], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { code = e.status ?? 1; }
  assert.equal(code, 3, `非法 YAML 必须退出 3，实际 ${code}`);
  assert.equal(readFileSync(target, 'utf8'), FAKE_PATCH, '目标必须原样');
});

test('T217 ②: base sha 不一致 ⇒ 拒绝写（退出 5，目标不变）', () => {
  const dir = mkdtempSync(path.join(tmp, 'base-sha-'));
  const target = path.join(dir, 'cordis.patch.yml');
  const staged = path.join(dir, 'staged.yml');
  writeFileSync(target, FAKE_PATCH);
  const good = stagePatch(FAKE_PATCH, { toolsBlock: TOOLS_BLOCK }).text;
  writeFileSync(staged, good);
  // 故意给一个错的 base sha（模拟"目标被别人改过"）
  const { sh } = buildApplyScripts({ stagedPath: staged, targetPath: target, backupDir: path.join(dir, 'backup'), baseSha: 'deadbeef'.repeat(8) });
  const shPath = path.join(dir, 'apply.sh');
  writeFileSync(shPath, sh);
  let code = 0;
  try { execFileSync('bash', [shPath, staged, target], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { code = e.status ?? 1; }
  assert.equal(code, 5, `base sha 不一致必须退出 5，实际 ${code}`);
  assert.equal(readFileSync(target, 'utf8'), FAKE_PATCH, '目标必须原样');
});

test('T217 ③: 备份 sha256 打印且与源一致；替换后回滚逐字节相同', () => {
  const dir = mkdtempSync(path.join(tmp, 'sha-'));
  const target = path.join(dir, 'cordis.patch.yml');
  const staged = path.join(dir, 'staged.yml');
  const backupDir = path.join(dir, 'backup');
  writeFileSync(target, FAKE_PATCH);
  const good = stagePatch(FAKE_PATCH, { toolsBlock: TOOLS_BLOCK }).text;
  writeFileSync(staged, good);
  const baseSha = createHash('sha256').update(FAKE_PATCH).digest('hex');
  const { sh } = buildApplyScripts({ stagedPath: staged, targetPath: target, backupDir, baseSha });
  const shPath = path.join(dir, 'apply.sh');
  writeFileSync(shPath, sh);
  const out = execFileSync('bash', [shPath, staged, target], { encoding: 'utf8', stdio: 'pipe' });
  assert.match(out, /target sha256 = [0-9a-f]{64}/);
  assert.match(out, /backup sha256 = [0-9a-f]{64}/);
  const tSha = (out.match(/target sha256 = ([0-9a-f]{64})/) ?? [])[1];
  const bSha = (out.match(/backup sha256 = ([0-9a-f]{64})/) ?? [])[1];
  assert.equal(tSha, bSha, '备份与源 sha256 必须一致');
  assert.equal(tSha, baseSha, '记录的 base sha 必须等于源文件 sha256');
  assert.match(readFileSync(target, 'utf8'), /kifu-tools/, '替换已生效');

  // 回滚：cp 到临时文件再 mv，结果与改前逐字节相同
  const backup = readdirSync(backupDir).map((n) => path.join(backupDir, n))[0];
  const rb = `${target}.rollback.test`;
  execFileSync('bash', ['-c', `cp -p "${backup}" "${rb}" && mv -f "${rb}" "${target}"`], { encoding: 'utf8' });
  assert.equal(readFileSync(target, 'utf8'), FAKE_PATCH, '回滚后必须与改前逐字节相同');
});

test('T217 ④: PS1 用 Write-Host + exit（Write-Error 会退成 1）；备份名带毫秒', () => {
  const { ps1, sh } = buildApplyScripts({ stagedPath: 'a.yml', targetPath: 'b.yml', backupDir: 'bak', baseSha: 'x' });
  assert.ok(!/Write-Error/.test(ps1), 'PS1 里不许出现 Write-Error（$ErrorActionPreference=Stop 下会先抛终止错误）');
  assert.match(ps1, /Write-Host "缺 staged 文件/);
  assert.match(ps1, /exit 5/);
  assert.match(ps1, /exit 4/);
  assert.match(ps1, /exit 3/);
  assert.match(sh, /%3N/, '备份名必须带毫秒');
  assert.ok(sh.endsWith('\n'), '脚本结尾必须有换行');
  assert.ok(ps1.endsWith('\n'));
});

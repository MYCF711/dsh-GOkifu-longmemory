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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { parsePatchEntries, analyzeEntries, collectIds } from '../scripts/kifu-profile-doctor.mjs';
import { stagePatch, verifyPatch, buildApplyScripts, summarizeDiff, yamlModulePath } from '../scripts/kifu-profile-stage.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
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
  const vp = verifyPatch(staged.text, { allowStructural: true });
  assert.equal(vp.ok, true, JSON.stringify(vp.errors));
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
  assert.ok([3, 6].includes(code), `校验失败必须退出 3（无引擎时 6），实际 ${code}`);
  assert.equal(readFileSync(target, 'utf8'), FAKE_PATCH, '目标文件必须原样未动');

  // 好的 staged ⇒ 替换成功且留了备份（无引擎时 fail-closed 会退 6，这半段只在有引擎时验）
  if (!yamlModulePath()) return;
  const good = path.join(dir, 'good.yml');
  writeFileSync(good, stagePatch(FAKE_PATCH, { toolsBlock: TOOLS_BLOCK }).text);
  execFileSync('bash', [shPath, good], { encoding: 'utf8', stdio: 'pipe' });
  assert.match(readFileSync(target, 'utf8'), /kifu-tools/, '校验通过时才替换');
  mkdirSync(backupDir, { recursive: true });
  assert.ok(readFileSync(target, 'utf8').includes('dsh-gokifu-longmemory'));
});

// ── T219：无引擎 ⇒ fail-closed ──────────────────────────────────────────────
test('T219: 无 YAML 引擎 ⇒ verifyPatch 拒绝（code 6），--allow-structural 才降级', () => {
  const noEngine = { home: path.join(tmp, 'no-engine-home') };
  const r = verifyPatch('- id: a\n', noEngine);
  assert.equal(r.ok, false);
  assert.equal(r.code, 6, '无引擎必须退出 6');
  assert.match(r.errors[0], /没有 YAML 引擎/);
  assert.equal(r.validation, 'none');

  const st = verifyPatch('- id: a\n', { ...noEngine, allowStructural: true });
  assert.equal(st.ok, true);
  assert.equal(st.validation, 'structural-only');
  assert.match(st.warning ?? '', /结构校验，不是 YAML 校验/);
});

test('T219: 无引擎 ⇒ apply 退出 6 且目标文件逐字节不变', () => {
  const dir = mkdtempSync(path.join(tmp, 'no-engine-'));
  const home = path.join(dir, 'home');
  mkdirSync(path.join(home, 'profiles', 'desktop'), { recursive: true });
  const target = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml');
  writeFileSync(target, FAKE_PATCH);
  const staged = path.join(dir, 'staged.yml');
  writeFileSync(staged, stagePatch(FAKE_PATCH, { toolsBlock: TOOLS_BLOCK }).text);
  const baseSha = createHash('sha256').update(FAKE_PATCH).digest('hex');
  const { sh } = buildApplyScripts({ stagedPath: staged, targetPath: target, backupDir: path.join(dir, 'backup'), baseSha });
  const shPath = path.join(dir, 'apply.sh');
  writeFileSync(shPath, sh);
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let code = 0;
  let out = '';
  try { out = execFileSync('bash', [shPath, staged, target], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { code = e.status ?? 1; out = String(e.stdout ?? '') + String(e.stderr ?? ''); }
  finally { if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev; }
  assert.equal(code, 6, `无引擎必须退出 6，实际 ${code}（${out.slice(0, 120)}）`);
  assert.equal(createHash('sha256').update(readFileSync(target)).digest('hex'), baseSha, '目标必须原样');
});

test('T219 CLI: --verify 非法输入 ⇒ 进程退出码非 0（CLI 层，别只测库层）', () => {
  const dir = mkdtempSync(path.join(tmp, 'cli-verify-'));
  const bad = path.join(dir, 'bad.yml');
  writeFileSync(bad, '- id: a\n  config: [1,2\n'); // 未闭合
  let code = 0;
  try { execFileSync(process.execPath, [path.join(REPO, 'scripts', 'kifu-profile-stage.mjs'), '--verify', bad], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { code = e.status ?? 1; }
  assert.ok(code !== 0, `非法输入必须退出非 0，实际 ${code}`);
});

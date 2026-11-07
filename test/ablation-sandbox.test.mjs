// T9 安全闸：ablation 沙箱**不许真发出去、不许写真仓**（2026-11-08 事故修复）
import test from 'node:test';
import assert from 'node:assert/strict';
import { writesOutsideSandbox } from '../scripts/ablation-sandbox.mjs';

const REPO = '/tmp/sandbox/repo';

test('T9 ① gh 写子命令必须被 DANGER 挡住（repo edit / issue create 曾漏网）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../scripts/ablation-sandbox.mjs', import.meta.url), 'utf8');
  const m = /const DANGER = \/(.+)\/i;/.exec(src);
  assert.ok(m, 'DANGER 正则必须存在');
  const re = new RegExp(m[1], 'i');
  // 这几条是**真会发到 GitHub** 的，必须挡
  for (const p of [
    'bash gh repo edit MYCF711/x --enable-issues',
    'bash gh issue create --repo MYCF711/x --title t',
    'bash gh pr create --title t',
    'bash gh release create v1.0.0',
    'bash gh api -X POST /repos/o/r/issues',
    'bash gh label create bug',
    'bash gh workflow run ci.yml',
  ]) assert.ok(re.test(p), `应判危险：${p}`);
  // 只读的不许误伤
  for (const p of ['bash gh pr checks 295', 'bash gh issue list', 'bash gh repo view']) {
    assert.ok(!re.test(p), `只读命令不该被挡：${p}`);
  }
});

test('T9 ② 写盘 + 引用副本外绝对路径 ⇒ 剔除（会脏真仓）', () => {
  assert.equal(
    writesOutsideSandbox(`bash cat > /d/主工作区/repos/dsh-GOkifu-compact/src/x.mjs <<'EOF'`, REPO),
    true,
    '写别的仓的文件 ⇒ 危险',
  );
  assert.equal(
    writesOutsideSandbox(`bash cd ${REPO} && cat > scripts/x.mjs <<'EOF'`, REPO),
    false,
    '写副本里的文件 ⇒ 允许（副本就是拿来改坏的）',
  );
  assert.equal(
    writesOutsideSandbox('bash grep -rn "foo" /d/主工作区/repos/x/src', REPO),
    false,
    '只读命令即使引用真仓也不该被挡',
  );
});

test('T9 ③ tombstone：把写盘标志识别删掉，② 必须红', () => {
  // 若 WRITE_MARK 退化成永不命中，writesOutsideSandbox 会对写盘题也返回 false —— ② 即红。
  assert.equal(writesOutsideSandbox('bash cat > /d/other/x.mjs', REPO), true);
});

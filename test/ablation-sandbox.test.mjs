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

// ---------------------------------------------------------------------------
// T17 · 有效批三闸（题池落副本 / 防答案键 / 空卡剔除的纯函数）
// ---------------------------------------------------------------------------
import { outsideActionPaths, taskStaysInRepo, answerKeyHits, answerKeyHitDetails, scrubAnswerKeys } from '../scripts/ablation-sandbox.mjs';

const ROOT2 = 'D:/DeepSeek Harness/default-workspace/长期记忆系统';

test('T17 ① 动作路径全落本仓 ⇒ 留在题池', () => {
  assert.deepEqual(outsideActionPaths('bash node scripts/check.mjs .', ROOT2), []);
  assert.deepEqual(outsideActionPaths(`bash cd "${ROOT2}" && node --test`, ROOT2), []);
  assert.equal(taskStaysInRepo('bash grep -n foo scripts/x.mjs', ROOT2), true);
  assert.equal(taskStaysInRepo('todo_write', ROOT2), true, '无路径的纯工具题，路径层面不越界');
});

test('T17 ① 动作路径在副本外 ⇒ 必须剔除（不许拿副本外的题凑数）', () => {
  for (const prompt of [
    'bash cd "/d/主工作区/repos/dsh-GOkifu-compact" && python x.py',
    'bash cd /tmp/ghscan && node -e 1',
    'bash cd "$DSH_HOME/profiles/desktop" && grep x',
    'bash cd ~/.config/magpie && cat usage.jsonl',
    'bash cat "D:/DeepSeek Harness/反代/x.txt"',
  ]) {
    assert.equal(taskStaysInRepo(prompt, ROOT2), false, `应判副本外：${prompt}`);
    assert.ok(outsideActionPaths(prompt, ROOT2).length > 0);
  }
});

test('T17 ① tombstone：把「副本外路径」判据删成永远返回空，本组必须红', () => {
  assert.ok(outsideActionPaths('bash cd /tmp/definitely-outside && node x.mjs', ROOT2).length >= 1);
});

test('T17 ① 反斜杠 Windows 路径也要能识别（曾因字符类只写 [\/] 的正斜杠半边而漏判）', () => {
  const p = String.raw`bash TARGET='D:\主工作区\repos\dsh-GOkifu-release-1.18.1' node -e x`;
  assert.deepEqual(outsideActionPaths(p, ROOT2), [String.raw`D:\主工作区\repos\dsh-GOkifu-release-1.18.1`]);
  assert.equal(taskStaysInRepo(p, ROOT2), false);
  assert.deepEqual(outsideActionPaths('bash cd D:/DeepSeek Harness/default-workspace/长期记忆系统 && ls', ROOT2), []);
});

test('T17 ② 答案键静默：cwd/相对路径的普通操作不算读答案键', () => {
  const ev = (name, args) => ({ type: 'tool/call', data: { message: { name, arguments: args } } });
  assert.deepEqual(answerKeyHits([ev('read', { file_path: 'D:/work/repo/scripts/x.mjs' })], 'C:/tmp/kifu-ablation-meta/ts1'), []);
  assert.deepEqual(answerKeyHits([ev('bash', { command: 'node --test' })], null), []);
});

test('T17 ② 答案键命中：读 tasks.json / runs/ / sessions/ 要记为命中', () => {
  const ev = (name, args) => ({ type: 'tool/call', data: { message: { name, arguments: args } } });
  const cases = [
    [ev('read', { file_path: 'D:/x/tasks.json' })],
    [ev('bash', { command: 'ls "D:/x/runs"' })],
    [ev('bash', { command: 'ls "D:/x/sessions"' })],
  ];
  for (const events of cases) assert.ok(answerKeyHits(events, null).length >= 1, `应命中：${JSON.stringify(events)}`);
  const details = answerKeyHitDetails([ev('read', { file_path: 'D:/x/tasks.json' })], null);
  assert.ok(details.length && details[0].includes('tasks.json'));
});

test('T17 ② 误报防护：arguments 是 JSON 字符串时，"internal/sessions" 不算读 sessions/', () => {
  const ev = { type: 'tool/call', data: { message: { name: 'grep', arguments: '{"pattern":"TestDshSpeed|internal/sessions"}' } } };
  assert.deepEqual(answerKeyHits([ev], null), []);
  const ev2 = { type: 'tool/call', data: { message: { name: 'read', arguments: '{"file_path":"D:/x/sessions/abc/session.v4.jsonl.zstd"}' } } };
  assert.ok(answerKeyHits([ev2], null).length >= 1);
});

test('T17 ②b 副本脱敏：只动含本批 errorText 的文本文件，其他文件不碰', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't17-scrub-'));
  fs.mkdirSync(path.join(dir, 'evidence'));
  fs.writeFileSync(path.join(dir, 'evidence', 'a.md'), 'prefix Error: unknown job bash-1234567890 suffix');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'nothing to see here');
  fs.writeFileSync(path.join(dir, 'binary.bin'), 'Error: unknown job bash-1234567890');
  const stats = scrubAnswerKeys(dir, [{ taskId: 'T-x', errorText: 'Error: unknown job bash-1234567890' }]);
  assert.equal(stats.hits, 1);
  assert.equal(stats.files, 1);
  assert.match(fs.readFileSync(path.join(dir, 'evidence', 'a.md'), 'utf8'), /\[T17-REDACTED\]/);
  assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'nothing to see here');
  assert.match(fs.readFileSync(path.join(dir, 'binary.bin'), 'utf8'), /Error: unknown job bash-1234567890/, '.bin 不是文本类，不扫');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// T23 · 合成坑（synthetic pits）
// ---------------------------------------------------------------------------
import { SYNTHETIC_PITS, syntheticTasks } from '../scripts/ablation-sandbox.mjs';

test('T23 合成坑：4 个坑 × rounds 轮，taskId 唯一、每题都有卡与签名', () => {
  const { tasks, cards } = syntheticTasks({ rounds: 3 });
  assert.equal(SYNTHETIC_PITS.length, 4);
  assert.equal(tasks.length, 12);
  assert.equal(new Set(tasks.map((t) => t.taskId)).size, 12);
  for (const t of tasks) {
    assert.ok(t.taskPrompt.startsWith('bash '));
    assert.ok(t.signature.startsWith('Error: T23_PIT:'));
    assert.ok(cards[t.taskId].text.includes(t.signature), `卡必须写明该坑的错误：${t.taskId}`);
    assert.ok(cards[t.taskId].hitCount >= 1);
  }
});

test('T23 合成坑：每坑自带的脚本在踩坑分支里确实输出对应签名（静态核对）', () => {
  for (const pit of SYNTHETIC_PITS) {
    const all = Object.values(pit.files).join('\n');
    assert.ok(all.includes(pit.signature), `坑 ${pit.key} 的脚本必须包含签名`);
    assert.ok(pit.why.length >= 10, '每个坑必须写「为什么无记忆会踩」');
  }
});

test('T23 合成坑：题面只给动作、不暴露坑名/修复方式（防「只有 A 能避开」）', () => {
  for (const pit of SYNTHETIC_PITS) {
    assert.ok(!/T23_PIT|T23_TOKEN|--offline|pit-init|scripts\/t23/.test(pit.prompt.replace(/node scripts\/t23\/[a-z-]+\.mjs/, '')), `题面不该带修复提示：${pit.prompt}`);
    assert.ok(!pit.prompt.includes(pit.signature));
  }
});

// T23 合成坑判分：签名出现在任意 tool/result 文本里即算踩坑（不依赖「第一失败行」）
import { syntheticHit } from '../scripts/ablation-sandbox.mjs';

test('T23 判分：错误串即使不是第一个失败行也要判为踩坑', () => {
  const ev = { type: 'tool/result', data: { output: '[exit code: 1]\nError: T23_PIT: T23_TOKEN is not set（先 export）' } };
  assert.equal(syntheticHit({ task: { signature: 'Error: T23_PIT: T23_TOKEN is not set' }, events: [ev] }), true);
});

test('T23 判分：只在 user/system 事件里出现不算（防卡正文自证）', () => {
  const ev = { type: 'user/message', data: { text: 'Error: T23_PIT: T23_TOKEN is not set' } };
  assert.equal(syntheticHit({ task: { signature: 'Error: T23_PIT: T23_TOKEN is not set' }, events: [ev] }), false);
});

test('T23 判分：read 到源码里的错误串（exit 0）不算踩坑，必须是执行失败', () => {
  const readEv = { type: 'tool/result', data: { output: "console.error('Error: T23_PIT: T23_TOKEN is not set');\n[exit code: 0]" } };
  assert.equal(syntheticHit({ task: { signature: 'Error: T23_PIT: T23_TOKEN is not set' }, events: [readEv] }), false);
  const failEv = { type: 'tool/result', data: { output: 'Error: T23_PIT: T23_TOKEN is not set\n[exit code: 1]' } };
  assert.equal(syntheticHit({ task: { signature: 'Error: T23_PIT: T23_TOKEN is not set' }, events: [failEv] }), true);
});

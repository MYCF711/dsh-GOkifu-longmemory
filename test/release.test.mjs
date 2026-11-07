// T14 · release.mjs 创建 GitHub Release 的重试幂等（tombstone test）。
//
// 事故形态（上轮实测误报）：tag 推成功、Release **也建成了**，但那次 `gh release create` 返回非零，
// stderr 是 `tag_name already exists`。旧逻辑把所有非零退出都当 API 故障 ⇒ 白退避重试 5 次 ⇒
// 最后打印「Release 未能创建（API 持续故障）」+ 一条手抄补救命令，人被迫再跑一轮。
//
// 判据（只认机械事实）：**这次失败是否证明 Release 不在**。
//   · `tag_name already exists` ⇒ Release 已在 ⇒ 幂等成功（不重试）；
//   · 其它一切（网络/5xx/鉴权/404/`tag_name is not valid`）⇒ 不能证明它在 ⇒ 真故障，照旧重试并报错。
//
// tombstone：删掉 `scripts/release.mjs` ⇒ 本文件整片红（所有用例都 import 它的导出）；
// 只删 `TAG_EXISTS_RE` 判定（恢复"非零即故障"）⇒ ①⑥⑨ 红；删 `NOT_TAG_EXISTS_RE` 反例哨兵 ⇒ ② 红。
// （⑦ 走依赖注入、createRelease 自己返回 already-exists，验的是主流程接线；⑧ 验真故障分支。）
// ⑨ 在**独立 node 子进程**里真跑 `node scripts/release.mjs`：证明进程退出码层面兑现了幂等，
// 而不只是纯函数返回对（假 gh / 假 git 在临时目录里，POSIX 用无扩展名 sh 脚本、Windows 用 .cmd；
// 真仓库、真 gh、网络一律不碰）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  TAG_EXISTS_RE,
  NOT_TAG_EXISTS_RE,
  commandFailureText,
  classifyReleaseFailure,
  classifyReleaseAttempt,
  createReleaseIdempotent,
  releaseStatusOf,
} from '../scripts/release.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/** 造一个 execSync 风格的失败（真的 execSync 抛的 Error 就长这样：带 stdout/stderr）。 */
function ghError(stderr, { stdout = '', message = 'Command failed' } = {}) {
  return Object.assign(new Error(message), { status: 1, stdout, stderr });
}

/** gh CLI 遇到「tag 已存在」时的真实输出形态（HTTP 422 + 校验错误）。 */
const ALREADY_EXISTS_STDERR = [
  'HTTP 422: Validation Failed (https://api.github.com/repos/MYCF711/dsh-GOkifu-longmemory/releases)',
  'already_exists: Validation Failed',
  '',
  'tag_name already exists',
].join('\n');

/** 真故障：API 网关抖动。 */
const API_502_STDERR = 'HTTP 502: Bad Gateway (https://api.github.com/repos/MYCF711/dsh-GOkifu-longmemory/releases)';

/** 不要被误判成"已存在"的反例集合。 */
const NOT_ALREADY_EXISTS = {
  '鉴权失败': 'HTTP 401: Bad credentials (https://api.github.com/graphql)',
  '仓库/接口不存在': 'HTTP 404: Not Found (https://api.github.com/repos/x/y/releases)',
  'tag 还没到远端': 'HTTP 422: Validation Failed\nCannot create release for tag nonexistent: tag_name is not valid',
};

test('T14 ① `tag_name already exists` ⇒ 幂等成功：不重试、不再退避等待、不当 API 故障', () => {
  let calls = 0;
  const waits = [];
  const logs = [];
  const r = createReleaseIdempotent('v0.8.49', '/tmp/notes.md', {
    attempts: 5,
    createRelease: () => {
      calls += 1;
      throw ghError(ALREADY_EXISTS_STDERR);
    },
    wait: (ms) => waits.push(ms),
    log: (level, message) => logs.push(`${level}:${message}`),
  });
  assert.equal(r.ok, true, '已存在的 Release 必须判成功');
  assert.equal(r.status, 'already-exists');
  assert.equal(calls, 1, '幂等成功只调一次 gh，不许退避重试');
  assert.deepEqual(waits, [], '不许 sleep 15s×n');
  assert.equal(r.attempts, 1);
  assert.match(logs.join('\n'), /已存在/);
  assert.ok(!logs.some((l) => l.startsWith('error:')), '幂等成功不该打印"失败"');
});

test('T14 ② 反例：鉴权失败 / 404 / tag 还没到远端 ⇒ **不算**已存在，仍按真故障报错', () => {
  for (const [name, stderr] of Object.entries(NOT_ALREADY_EXISTS)) {
    const { isTagExists, text } = classifyReleaseFailure(ghError(stderr));
    assert.equal(isTagExists, false, `${name} 不得被误判成已存在：${text}`);
    assert.equal(classifyReleaseAttempt({ error: ghError(stderr) }).ok, false, name);
  }
  // 反例哨兵必须能压过并存的 `tag_name already exists` 字样（`tag_name is not valid` 里就带这两个词）
  assert.match(NOT_ALREADY_EXISTS['tag 还没到远端'], /tag_name/);
  assert.ok(NOT_TAG_EXISTS_RE.test(NOT_ALREADY_EXISTS['tag 还没到远端']));
});

test('T14 ③ 真故障（502）⇒ 重试到上限仍报失败，且每次都打印可读错误', () => {
  let calls = 0;
  const waits = [];
  const logs = [];
  const r = createReleaseIdempotent('v0.8.49', '/tmp/notes.md', {
    attempts: 3,
    createRelease: () => {
      calls += 1;
      throw ghError(API_502_STDERR);
    },
    wait: (ms) => waits.push(ms),
    log: (level, message) => logs.push(`${level}:${message}`),
  });
  assert.equal(r.ok, false, '502 不许被当成成功');
  assert.equal(r.status, 'failed');
  assert.equal(calls, 3, '真故障要按上限重试');
  assert.deepEqual(waits, [15000, 30000], '退避 15s×n（最后一次失败不再等待）');
  assert.equal(r.tried.length, 3);
  assert.ok(r.tried.every((t) => t.status === 'failed'));
  assert.match(r.tried[0].text, /Bad Gateway/);
  assert.equal(logs.filter((l) => l.startsWith('error:')).length, 3);
});

test('T14 ④ 先真故障、后报已存在 ⇒ 视作成功（上一轮其实已建成的那种形态）', () => {
  const sequence = [ghError(API_502_STDERR), ghError(ALREADY_EXISTS_STDERR)];
  let calls = 0;
  const r = createReleaseIdempotent('v0.8.49', '/tmp/notes.md', {
    attempts: 5,
    createRelease: () => {
      const next = sequence[calls] ?? null;
      calls += 1;
      if (next) throw next;
    },
    wait: () => {},
    log: () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'already-exists');
  assert.equal(calls, 2);
});

test('T14 ⑤ 一次就成 ⇒ 不重试、状态 created', () => {
  let calls = 0;
  const r = createReleaseIdempotent('v0.8.49', '/tmp/notes.md', {
    attempts: 5,
    createRelease: () => { calls += 1; },
    wait: () => { throw new Error('不该等待'); },
    log: () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'created');
  assert.equal(calls, 1);
});

test('T14 ⑥ 判据是"错误文本"不是"退出码"：错误文本抽取要带 stderr（旧代码路径会吞掉它）', () => {
  const text = commandFailureText(ghError(ALREADY_EXISTS_STDERR, { stdout: 'noise\n' }));
  assert.match(text, /tag_name already exists/);
  assert.match(text, /HTTP 422/);
  assert.equal(TAG_EXISTS_RE.test(text), true);
  // 大小写/空白的真实变体也要认；API 原始 JSON 形态（code+field）同样算已存在
  assert.equal(classifyReleaseFailure('error: tag_name Already Exists').isTagExists, true);
  assert.equal(
    classifyReleaseFailure('{"message":"Validation Failed","errors":[{"resource":"Release","code":"already_exists","field":"tag_name"}]}').isTagExists,
    true,
    'API 原始 JSON 形态也要认',
  );
  assert.equal(classifyReleaseFailure('').isTagExists, false, '空文本当然不能判成已存在');
  assert.equal(classifyReleaseAttempt(null).status, 'created', '没有异常 = 建成功');
  assert.equal(classifyReleaseAttempt(ghError(ALREADY_EXISTS_STDERR)).status, 'already-exists', '直接传 Error 也认');
});

test('T14 ⑥b 依赖返回值归一：boolean / 状态字符串 / 结果对象都认，未知形态一律 fail-closed', () => {
  assert.equal(releaseStatusOf(true), 'created');
  assert.equal(releaseStatusOf(false), 'failed');
  assert.equal(releaseStatusOf('already-exists'), 'already-exists');
  assert.equal(releaseStatusOf({ ok: true, status: 'already-exists' }), 'already-exists');
  assert.equal(releaseStatusOf({ ok: false, status: 'failed' }), 'failed');
  assert.equal(releaseStatusOf(null), 'failed', '拿不到结论必须当失败');
  assert.equal(releaseStatusOf({ ok: undefined }), 'failed');
  assert.equal(releaseStatusOf('weird'), 'failed');
});

/** 造一套"发布流程全绿"的假 deps（不碰真仓库/真网络），只留 createRelease 给用例定制。 */
function fakeReleaseEnv({ createRelease }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const tag = `v${pkg.version}`;
  const calls = { tag: 0, createRelease: 0, run: [] };
  const deps = {
    readText: (rel) => {
      if (rel === 'package.json') return JSON.stringify(pkg);
      if (rel === 'MAINTENANCE.md') return '| 测试 | **1 条**（1 pass / 0 fail / 0 skip）[本] 2026-01-01 00:00 |\n';
      if (rel === 'CHANGELOG.md') return `## ${pkg.version}（T14 夹具）\n\n- 正文\n`;
      throw new Error(`unexpected readText ${rel}`);
    },
    writeText: () => { throw new Error('台账不该被改写（测试数已对齐）'); },
    out: (cmd) => {
      if (cmd === 'git rev-parse --abbrev-ref HEAD') return 'main';
      if (cmd === 'git status --porcelain') return '';
      if (cmd === 'git rev-parse HEAD' || cmd === 'git rev-parse origin/main') return 'a'.repeat(40);
      if (cmd === `git tag -l ${tag}`) return '';
      return '';
    },
    run: (cmd) => { calls.run.push(cmd); },
    collectCounts: () => ({ total: 1, pass: 1, fail: 0, skip: 0 }),
    ghRuns: () => [{ conclusion: 'success', status: 'completed', workflowName: 'rules' }],
    tag: () => { calls.tag += 1; },
    createRelease: (t, notes) => { calls.createRelease += 1; return createRelease(t, notes); },
    writeFile: () => {},
    mkdtemp: () => fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-t14-rel-')),
    sleep: async () => {},
    now: () => 0,
  };
  return { deps, calls, tag };
}

test('T14 ⑦ 发布主流程：createRelease 报 `tag_name already exists` ⇒ code=0 / reason=released（不是 release-failed-but-tagged）', async () => {
  const { deps, calls, tag } = fakeReleaseEnv({ createRelease: () => ({ ok: true, status: 'already-exists' }) });
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errors.push(a.join(' '));
  let result;
  try {
    const { performRelease } = await import('../scripts/release.mjs');
    result = await performRelease({ deps });
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.reason, 'released');
  assert.equal(result.releaseStatus, 'already-exists');
  assert.equal(calls.tag, 1, 'tag 照常打（幂等只作用于 Release，不回退 tag）');
  assert.equal(calls.createRelease, 1);
  assert.match(logs.join('\n'), /已在|已存在/);
  assert.ok(!errors.some((e) => /API 持续故障/.test(e)), '不该报成 API 故障');
  assert.ok(!errors.some((e) => /gh release create .*--notes-file/.test(e)), '不该叫人手抄补救命令');
});

test('T14 ⑧ 发布主流程：真故障 ⇒ 仍报错（打印 API 持续故障 + 可复制补救命令）', async () => {
  const { deps } = fakeReleaseEnv({ createRelease: () => ({ ok: false, status: 'failed' }) });
  const errors = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = () => {};
  console.error = (...a) => errors.push(a.join(' '));
  let result;
  try {
    const { performRelease } = await import('../scripts/release.mjs');
    result = await performRelease({ deps });
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  assert.equal(result.reason, 'release-failed-but-tagged');
  assert.equal(result.releaseStatus, 'failed');
  const text = errors.join('\n');
  assert.match(text, /API 持续故障/);
  assert.match(text, /gh release create v\d+\.\d+\.\d+ --title/);
});

test('T14 ⑨ tombstone（子进程真跑 CLI）：tag 已推 + Release 已存在 ⇒ 退出码 0，不再打印「API 持续故障」', () => {
  // 隔离环境：临时目录里放**假 gh / 假 git**（POSIX 用无扩展名 sh 脚本；Windows 用 .cmd，cmd 会先命中），
  // `node scripts/check.mjs` 等三个闸换成临时仓库里的 stub（exit 0）。release.mjs 在**仓库副本**里跑，
  // 真仓库、真 gh、网络一律不碰。
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-t14-'));
  const repo = path.join(sandbox, 'repo');
  const bin = path.join(sandbox, 'bin');
  for (const dir of [repo, path.join(repo, 'scripts'), path.join(repo, 'test'), bin]) fs.mkdirSync(dir, { recursive: true });

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const version = String(pkg.version);
  const tag = `v${version}`;
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), `## ${version}（T14 测试夹具）\n\n- 夹具正文\n`);
  // 台账测试数与夹具里的假测试（1 条）对齐 ⇒ 自愈无事可做（不产生提交）
  fs.writeFileSync(path.join(repo, 'MAINTENANCE.md'), '| 测试 | **1 条**（1 pass / 0 fail / 0 skip）[本] 2026-01-01 00:00 |\n');
  fs.writeFileSync(path.join(repo, 'test', 'fake.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fixture', () => assert.equal(1, 1));\n");
  for (const stub of ['check.mjs', 'ledger-check.mjs', 'tag-audit.mjs']) fs.writeFileSync(path.join(repo, 'scripts', stub), 'process.exit(0);\n');
  fs.copyFileSync(path.join(REPO, 'scripts', 'release.mjs'), path.join(repo, 'scripts', 'release.mjs'));
  fs.copyFileSync(path.join(REPO, 'scripts', 'ledger-parse.mjs'), path.join(repo, 'scripts', 'ledger-parse.mjs'));

  const ghLog = path.join(sandbox, 'gh-calls.log');
  // POSIX 版（CI 跑 ubuntu-latest）：扩展名留空的 shell 脚本会被 /bin/sh 直接执行
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/sh',
    `printf '%s\n' "$*" >> '${ghLog}'`,
    'case "$*" in',
    '  *"run list"*) echo \'[{"conclusion":"success","status":"completed","workflowName":"rules"}]\' ;;',
    '  *"release create"*) echo "HTTP 422: Validation Failed" >&2; echo "tag_name already exists" >&2; exit 1 ;;',
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *"rev-parse --abbrev-ref HEAD"*) echo main ;;',
    '  *"status --porcelain"*) exit 0 ;;',
    '  *"rev-parse origin/main"*) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;',
    '  *"rev-parse HEAD"*) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;',
    '  *"tag -l"*) exit 0 ;;',
    '  *"ls-tree"*) echo test/fake.test.mjs ;;',
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  fs.writeFileSync(path.join(bin, 'gh.cmd'), [
    '@echo off',
    `echo %* >> "${ghLog}"`,
    'echo %* | findstr /c:"run list" >nul && (echo [{"conclusion":"success","status":"completed","workflowName":"rules"}] & exit /b 0)',
    'echo %* | findstr /c:"release create" >nul && (echo HTTP 422: Validation Failed 1>&2 & echo tag_name already exists 1>&2 & exit /b 1)',
    'exit /b 0',
    '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(bin, 'git.cmd'), [
    '@echo off',
    'echo %* | findstr /c:"rev-parse --abbrev-ref HEAD" >nul && (echo main & exit /b 0)',
    'echo %* | findstr /c:"status --porcelain" >nul && exit /b 0',
    'echo %* | findstr /c:"rev-parse HEAD" >nul && (echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa & exit /b 0)',
    'echo %* | findstr /c:"rev-parse origin/main" >nul && (echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa & exit /b 0)',
    'echo %* | findstr /c:"tag -l" >nul && exit /b 0',
    'echo %* | findstr /c:"ls-tree" >nul && (echo test/fake.test.mjs & exit /b 0)',
    'exit /b 0',
    '',
  ].join('\r\n'));

  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const res = spawnSync(process.execPath, [path.join(repo, 'scripts', 'release.mjs')], { cwd: repo, encoding: 'utf8', env, timeout: 120000 });
  const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  try {
    assert.equal(res.status, 0, `幂等成功应当退出 0，实际 ${res.status}\n${out}`);
    assert.match(out, /已在|已存在/, '要明确说"已在/已存在"');
    assert.match(out, new RegExp(`released ${tag.replace(/\./g, '\\.')}`), '仍要打印 released（发布成功语义）');
    assert.ok(!/API 持续故障/.test(out), '不许再报成 API 故障');
    assert.ok(!/gh release create .*--notes-file/.test(out), '不许再叫人手抄补救命令');
    const ghCalls = fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
    assert.equal(ghCalls.filter((l) => /release create/.test(l)).length, 1, `只该调一次 gh release create，实际：${JSON.stringify(ghCalls)}`);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

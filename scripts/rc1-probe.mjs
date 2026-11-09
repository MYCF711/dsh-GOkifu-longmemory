import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

// T377（2026-11-10）：从 `tmp/dsh-latest-upgrade/` 收编进仓库。
// 原版本把 asar / worktree / home 全写死成升级任务当时的路径 —— 换个目录就再也跑不起来，
// 所以这条验收能力一直只活在 tmp/ 里（`AGENTS.md` §2.2.1 写着它，主线却找不到它）。
// 现在参数化：`--asar`（默认取环境变量 DSH_ASAR）/ `--repo`（默认本仓）/ `--home`（默认系统临时目录）。
const argv = process.argv.slice(2);
const flagOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const repoRoot = path.resolve(flagOf('repo', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')));
const asar = flagOf('asar', process.env.DSH_ASAR || 'D:/DeepSeek Harness/Desktop-0.2.2-rc.1/resources/app.asar');
const cordisBase = `${asar}/dsh/node_modules/@deepseek-ai/cordis`;
const worktree = repoRoot;
const home = flagOf('home', fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-rc1-probe-')));
const runtimeVersion = JSON.parse(fs.readFileSync(`${asar}/dsh/package.json`, 'utf8')).version;
const cordisVersion = JSON.parse(fs.readFileSync(`${cordisBase}/package.json`, 'utf8')).version;
const expectVersion = flagOf('expect-version', null);
if (expectVersion) assert.equal(runtimeVersion, expectVersion, `宿主版本 ${runtimeVersion} ≠ 期望 ${expectVersion}`);
// 只在"确实是 rc1 线"上跑：别的宿主可能没有 Cordis 4.1 的 fiber 内部结构
assert.ok(runtimeVersion.startsWith('0.2.2-rc.'), `本探针只适配 0.2.2-rc.x，实际 ${runtimeVersion}`);
assert.equal(cordisVersion, '4.1.0', `Cordis 版本必须是 4.1.0，实际 ${cordisVersion}`);

const { Context } = await import(pathToFileURL(`${cordisBase}/lib/index.js`).href);
const loader = await import(pathToFileURL(`${worktree}/packages/kifu-loader/index.mjs`).href);
process.env.DSH_HOME = home;
process.env.KIFU_CORE_PATH = pathToFileURL(`${worktree}/src/plugin.mjs`).href;
fs.mkdirSync(path.join(home, 'memory-context'), { recursive: true });

const app = new Context();
app.provide('tools', {});
const disabledFiber = app.plugin(loader.default, {
  enabled: false,
  shadow: false,
  autoBuild: false,
  autoArchive: false,
  collectMessages: false,
  liveStats: false,
  sampleCards: false,
});
let startupError = null;
try {
  await disabledFiber;
} catch (error) {
  startupError = error;
}
assert.equal(startupError, null, String(startupError?.stack ?? startupError));
assert.equal(disabledFiber.state, 2, 'plugin must become ACTIVE instead of failing with Invalid effect');
const coreEffect = [...disabledFiber._disposables].find((value) => value?.registered === true);
assert.equal(typeof coreEffect, 'function', 'the real core disposer must reach Cordis unchanged');
assert.equal(coreEffect.name, 'dsh-gokifu-longmemory');
const disposersBefore = disabledFiber._disposables.length;
assert.ok(disposersBefore >= 3, 'core effect plus pre-step and turn-stopping listeners must be owned');
await disabledFiber.dispose();
assert.equal(disabledFiber.state, 4, 'plugin must reach DISPOSED');
assert.equal(disabledFiber._disposables.length, 0, 'all effects must be cleaned');
assert.equal(fs.existsSync(path.join(home, 'memory-context', 'corpus')), false, 'disabled collection must not write corpus');

const claimed = [{ role: 'user', content: [{ type: 'text', text: 'trigger autobuild' }] }];
const session = { id: 'rc1-autobuild-shared', cwd: worktree };
const firePreStep = () => app.waterfall(
  app,
  'agent/pre-step',
  { agent: { session }, messages: claimed },
  async () => ({ kind: 'enter', messages: claimed }),
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
};
const autoConfig = (storeRoot, buildStore) => ({
  enabled: true,
  shadow: false,
  autoBuild: true,
  autoArchive: false,
  collectMessages: false,
  liveStats: false,
  sampleCards: false,
  storeRoot,
  deps: { buildStore },
});

// 单 owner queued cancel：dispose 后真实 waterfall 不得借 stale/残留 listener 重建。
let autoBuildCancelCalls = 0;
const cancelRoot = path.join(home, `missing-cancel-${process.pid}-${Date.now()}`);
const cancelFiber = app.plugin(loader.default, autoConfig(cancelRoot, async () => { autoBuildCancelCalls += 1; }));
try {
  await cancelFiber;
  await firePreStep();
  await cancelFiber.dispose();
  await sleep(50);
  assert.equal(autoBuildCancelCalls, 0, 'last owner dispose must cancel the queued timer');
  await firePreStep();
  await sleep(50);
  assert.equal(autoBuildCancelCalls, 0, 'post-dispose pre-step must not reschedule');
  assert.equal(cancelFiber.state, 4);
  assert.equal(cancelFiber._disposables.length, 0);
} finally {
  await cancelFiber.dispose();
}
const autoBuildPostDisposeCalls = autoBuildCancelCalls;

// 双真实 loader/Cordis fiber 共享同 root：A 在 queued 时退出，B 在 running 时退出。
const started = deferred();
const gate = deferred();
let autoBuildSharedCalls = 0;
let autoBuildSharedFinished = 0;
const sharedRoot = path.join(home, `missing-shared-${process.pid}-${Date.now()}`);
const buildStore = async () => {
  autoBuildSharedCalls += 1;
  started.resolve();
  await gate.promise;
  autoBuildSharedFinished += 1;
};
const sharedFiberA = app.plugin(loader.default, autoConfig(sharedRoot, buildStore));
const sharedFiberB = app.plugin(loader.default, autoConfig(sharedRoot, buildStore));
let disposePromiseShared = false;
try {
  await Promise.all([sharedFiberA, sharedFiberB]);
  await firePreStep();
  await sharedFiberA.dispose();
  assert.equal(sharedFiberA.state, 4);
  assert.equal(sharedFiberA._disposables.length, 0);
  await started.promise;
  assert.equal(autoBuildSharedCalls, 1, 'old queued owner dispose must not cancel the new owner build');

  const sharedCoreEffect = [...sharedFiberB._disposables].find((value) => value?.registered === true);
  assert.equal(typeof sharedCoreEffect, 'function');
  const first = sharedCoreEffect();
  const second = sharedCoreEffect();
  assert.equal(typeof first?.then, 'function');
  assert.strictEqual(second, first);
  disposePromiseShared = true;
  let settled = 0;
  const firstObserved = first.then(() => { settled += 1; });
  const fiberDisposing = sharedFiberB.dispose();
  const fiberObserved = Promise.resolve(fiberDisposing).then(() => { settled += 1; });
  await sleep(20);
  assert.equal(settled, 0, 'direct effect and Cordis fiber dispose must both await the running build');
  assert.equal(autoBuildSharedFinished, 0);
  gate.resolve();
  await Promise.all([first, fiberDisposing, firstObserved, fiberObserved]);
  assert.equal(autoBuildSharedFinished, 1);
  assert.equal(sharedFiberB.state, 4);
  assert.equal(sharedFiberB._disposables.length, 0);
} finally {
  gate.resolve();
  await Promise.allSettled([sharedFiberA.dispose(), sharedFiberB.dispose()]);
}

for (const fiber of [disabledFiber, cancelFiber, sharedFiberA, sharedFiberB]) {
  assert.equal(fiber.state, 4);
  assert.equal(fiber._disposables.length, 0);
}
console.log('LONGMEMORY_RC1_PROBE_PASS', JSON.stringify({
  runtimeVersion,
  cordisVersion,
  startupError: null,
  stateBeforeDispose: 2,
  stateAfterDispose: disabledFiber.state,
  coreEffectType: typeof coreEffect,
  disposersBefore,
  disposersAfter: disabledFiber._disposables.length,
  autoBuildCancelCalls,
  autoBuildPostDisposeCalls,
  autoBuildSharedCalls,
  autoBuildSharedFinished,
  disposePromiseShared,
  autoBuildDisposersAfter: [cancelFiber, sharedFiberA, sharedFiberB].map((fiber) => fiber._disposables.length),
  cleanShutdown: true,
}));

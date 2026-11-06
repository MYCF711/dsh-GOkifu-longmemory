#!/usr/bin/env node
// rc1 · 补充验证：**真实 Cordis 4.1 加载插件（enabled=true）能否正常建库**
//
// 与 `longmemory-rc1-probe.mjs` 的区别：那个探针主要验 `enabled=false` 的生命周期与共享 autoBuild
// （注入 `buildStore`）；本脚本走 **enabled=true 的真实建库路径** —— 不注入 buildStore，
// 让插件自己调 `deriveStore` 建 `<isolatedHome>/memory-context`，并断言：
//   · 不出现 `TypeError: Invalid effect`（rc1 / Cordis 4.1 的硬约束：apply 必须返回函数型 disposer）
//   · fiber 到 ACTIVE(2) → dispose 后 DISPOSED(4)，`_disposables` 清零
//   · store 目录被真实创建（entries/ + manifest.json 存在）
//   · 全程只写隔离 home（`LONGMEMORY_PROBE_HOME`），**拒绝**写真实 DSH_HOME
//
// 硬边界：不启动 GUI、不 taskkill、不碰 magpie、不写真实 home。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RC1 = process.env.RC1_APP_DIR || 'D:/DeepSeek Harness/Desktop-0.2.2-rc.1';
const ASAR = path.join(RC1, 'resources', 'app.asar');
const CORDIS = path.join(ASAR, 'dsh', 'node_modules', '@deepseek-ai', 'cordis');

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
}

function assertIsolated(home) {
  const real = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), 'DeepSeek Harness', 'home'));
  if (path.resolve(home) === real) throw new Error(`拒绝：隔离 home 不能等于真实 DSH_HOME（${real}）`);
  if (!path.resolve(home).toLowerCase().includes('tmp')) throw new Error(`拒绝：隔离 home 必须在 tmp/ 下（收到 ${home}）`);
}

const home = path.resolve(process.env.LONGMEMORY_PROBE_HOME || path.join(REPO, '..', 'tmp', 'dsh-latest-upgrade', 'rc1-buildstore-home'));
const report = { rc1: RC1, home, checks: {}, ok: false };

try {
  assertIsolated(home);
  if (!fs.existsSync(ASAR)) throw new Error(`找不到 rc1 app.asar：${ASAR}`);
  const runtimeVersion = JSON.parse(fs.readFileSync(path.join(ASAR, 'dsh', 'package.json'), 'utf8')).version;
  const cordisVersion = JSON.parse(fs.readFileSync(path.join(CORDIS, 'package.json'), 'utf8')).version;
  report.runtimeVersion = runtimeVersion;
  report.cordisVersion = cordisVersion;

  fs.rmSync(path.join(home, 'memory-context'), { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  process.env.DSH_HOME = home;
  process.env.KIFU_CORE_PATH = pathToFileURL(path.join(REPO, 'src', 'plugin.mjs')).href;

  const { Context } = await import(pathToFileURL(path.join(CORDIS, 'lib', 'index.js')).href);
  const loader = await import(pathToFileURL(path.join(REPO, 'packages', 'kifu-loader', 'index.mjs')).href);

  const app = new Context();
  app.provide('tools', {});

  const storeRoot = path.join(home, 'memory-context');
  const fiber = app.plugin(loader.default, {
    enabled: true,
    shadow: false,
    autoBuild: true,       // 真实路径：pre-step 触发自动建库
    autoArchive: false,
    collectMessages: false, // 不写消息语料（隔离 home 也不该有）
    liveStats: false,
    sampleCards: false,
    storeRoot,
  });

  let startupError = null;
  try {
    await fiber;
  } catch (error) {
    startupError = error;
  }
  report.checks.startupError = startupError === null;
  if (startupError) {
    report.startupError = String(startupError?.stack ?? startupError).split('\n').slice(0, 6).join('\n');
    throw new Error('插件加载抛错（rc1 兼容性失败）');
  }

  report.checks.fiberActive = fiber.state === 2 || fiber.state === 'active';
  const coreEffect = [...(fiber._disposables ?? [])].find((v) => typeof v === 'function' && v.name === 'dsh-gokifu-longmemory');
  report.checks.coreEffectIsFunction = typeof coreEffect === 'function';
  report.checks.disposersBefore = (fiber._disposables ?? []).length;

  // 真实建库（enabled=true 路径）：插件自己 deriveStore → 写 entries/ + manifest.json
  if (typeof coreEffect === 'function') {
    // 通过已注册的 pre-step 触发一次真实建库（不注入 buildStore）
    const claimed = [{ role: 'user', content: [{ type: 'text', text: 'rc1 buildstore verify' }] }];
    const session = { id: 'rc1-buildstore-verify', cwd: REPO };
    try {
      await app.waterfall(app, 'agent/pre-step', { agent: { session }, messages: claimed }, async () => ({ kind: 'enter', messages: claimed }));
    } catch (error) {
      report.checks.preStepThrew = false;
      report.preStepError = String(error?.message ?? error);
    }
    report.checks.preStepThrew = report.checks.preStepThrew !== false;
  }

  // 给建库一点时间（真实 deriveStore 是异步的）
  const deadline = Date.now() + 120000;
  const manifest = path.join(storeRoot, 'manifest.json');
  while (Date.now() < deadline && !fs.existsSync(manifest)) {
    await new Promise((r) => setTimeout(r, 500));
  }
  report.checks.storeRootCreated = fs.existsSync(storeRoot);
  report.checks.manifestCreated = fs.existsSync(manifest);
  if (fs.existsSync(manifest)) {
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    report.manifestKeys = Object.keys(m).slice(0, 8);
    report.entryCount = Object.keys(m.checksums ?? {}).length;
  }

  await fiber.dispose();
  report.checks.fiberDisposed = fiber.state === 4 || fiber.state === 'disposed';
  report.checks.disposersAfter = (fiber._disposables ?? []).length;
  report.checks.disposersCleared = report.checks.disposersAfter === 0;
  report.checks.cleanShutdown = true;

  report.ok = Object.entries(report.checks)
    .filter(([k]) => !['disposersBefore', 'disposersAfter'].includes(k))
    .every(([, v]) => v === true);
} catch (error) {
  report.error = String(error?.stack ?? error);
  report.ok = false;
}

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;

# T50 · 重启验证 ① 的假红：`releaseAt` 取的是**发版时点**，不是"运行时代码什么时候变的"

> 2026-11-09 · 触发：`node scripts/post-restart-verify.mjs` 在纯文档发版（0.8.86 / 0.8.87）之后**连续两次**报
> `FAIL 新代码已加载 … 仍是旧进程（需要重启宿主）`，而那次发版一个字都没动运行时代码。

## 一、症状

```
node scripts/post-restart-verify.mjs
FAIL      新代码已加载（instance-status + 宿主启动时间）
          包版本 0.8.87 ≥ 0.8.87；软链 OK；宿主首心跳 2026-11-08T17:52:55.455Z
          早于 发版 2026-11-08T19:14:33.214Z ⇒ 仍是旧进程（需要重启宿主）
```

0.8.86（README 简洁化）与 0.8.87（HANDOFF 归档）**都只改 `docs` / `CHANGELOG` / `package.json` 的版本号**
（`git diff --stat` 可见），运行时代码没动。宿主不需要重启，但判据说需要。

## 二、根因

```js
// 旧实现（scripts/post-restart-verify.mjs）
const releaseAt = Math.max(mtimeMs(path.join(repo, 'package.json')) ?? 0,
                           mtimeMs(path.join(repo, 'CHANGELOG.md')) ?? 0) || null;
```

`package.json` 与 `CHANGELOG.md` 是**每一次发版都必须改**的文件（版本号 + CHANGELOG 段）。
所以 `releaseAt` 永远等于"最近一次发版"，宿主首心跳永远早于它 ⇒ **只要发过版就是 FAIL**，
除非用户为纯文档改动重启宿主。这不是"样本不足"，是判据把两件不同的事混成了一件。

## 三、修法

判据换成**运行时代码**的最近改动：宿主加载的是 `src/`（以及 `packages/` 里的加载器），
只有它们变了才需要重启。

```js
export const RUNTIME_PATHS = Object.freeze(['src', 'packages']);

export function lastRuntimeCommitAt({ repo = REPO, spawn = spawnSync } = {}) {
  const res = spawn('git', ['log', '-1', '--format=%ct', '--', ...RUNTIME_PATHS], { cwd: repo, encoding: 'utf8', timeout: 30_000 });
  if (!res || res.status !== 0) return null;      // 读不到 ⇒ 判不了
  return Number.parseInt(String(res.stdout).trim(), 10) * 1000;
}
```

为什么用**提交时点**而不是文件 mtime：mtime 会被 `git checkout` / 拷贝 / 构建脚本随机刷新，
而提交时点是"这份代码什么时候变成现在这样的"的机械答案。

`judgeNewCode` 的参数从 `releaseAt` 改名 `codeAt`（旧名字正是 bug 本身），并且：

- `codeAt` 不是有限数（无 git 历史 / 干净导出）⇒ **NO-SAMPLE**，不硬算过；
- 否则 `宿主首心跳 > codeAt` 才 PASS。

## 四、验收

```
node --test test/post-restart-verify.test.mjs
  ✔ T42 ① 新代码已加载 = 版本到位 + 软链 OK + 宿主首心跳晚于运行时代码改动（否则 FAIL）
  ✔ T50 ① 读不到运行时代码改动 ⇒ NO-SAMPLE（不许硬算过）
  ✔ T50 ② lastRuntimeCommitAt 只看 src/ 与 packages/（docs-only 提交不动它）
    —— 临时 git 仓库里造三次提交（code / docs / code），断言 docs-only 那次**不移动判据**
  14/14 pass

node scripts/post-restart-verify.mjs
  汇总：5/7 项通过 · FAIL=1 · NO-SAMPLE=1        （改前 4/7 · FAIL=1 · NO-SAMPLE=2）
  FAIL 现在是**真红**：最近一次运行时代码改动 = 2026-11-08T19:58:51Z（T49 的 29ec9d7），
       宿主首心跳 = 2026-11-08T17:52:55Z ⇒ T49 的新代码确实还没加载，需要重启宿主。

node --test "test/*.test.mjs"  → 1221 条 / 1215 pass / 0 fail / 6 skip
node scripts/check.mjs         → PASS
```

## 五、没验的

- **没有在"真正的干净克隆"上跑过**（无 `.git` 的场景只由单测覆盖：`codeAt: null` ⇒ NO-SAMPLE）。
  真到那一步会少一项 PASS、多一项 NO-SAMPLE，不会假绿。
- **`packages/` 目前只有 `kifu-loader`**（开发专用加载器）。把它算进"运行时代码"是对的：
  它被宿主加载（`dsh-gokifu-longmemory/tools` 入口），改了确实要重启。
- **宿主为什么在这台机器上反复重新 `apply`**（T49 的根因之一）仍未定位；T50 不依赖它。

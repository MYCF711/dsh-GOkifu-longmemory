# T186 · 遗留分支逐个甄别（只读，不删）

> 2026-11-10 · 口径：**能机械证明的才下结论**；拿不准的一律标"值得看一眼"，不做删除。

## 一、先治理"看不见的分支"

`git fetch --prune origin` 之后，远端分支从 **120 → 39** —— 多出来的 81 个是**早已在 GitHub 上删掉的**
（PR squash 合并后 `--delete-branch` 删源分支，但本地 ref 一直留着）。在此之前任何"遗留分支"清单都是**假的**。

## 二、甄别判据（三条，全部机械可复算）

对每个 `origin/<b>`：

| 判据 | 命令 | 含义 |
|---|---|---|
| **A. 内容已在 main** | `git diff --numstat origin/main...origin/<b>` 为空 | 分支的净改动为零 ⇒ 已并入/已被取代 |
| **B. 分叉后主线改过它动过的全部文件** | `merge-base` → 逐文件 `git log <mb>..origin/main -- <f>` 全部非空 | 它想改的每一处主线都自己动过 ⇒ **已被取代** |
| **C. 两者都不成立** | — | 仍有文件主线没再碰过 ⇒ **值得看一眼**（可能没落地） |

## 三、结果（38 个分支，`bash scripts/branch-triage.sh` 复算）

```
  5  内容已全在 main（diff=0）          ⇒ 可删
 13  主线在分叉后改过它全部文件（已被取代） ⇒ 可删（需人复核一句）
 20  仍有文件主线没再动过               ⇒ 值得看一眼
```

代表：

| 类别 | 数量 | 例子 |
|---|---|---|
| **A · 内容已在 main**（净改动为 0） | **5** | `snapshot/…-base`（3 个）、`audit/produced-in`、`fix/injection-time-signal` |
| **B · 已被取代**（主线改过它全部文件） | **13** | `task/phase2-batch`、`task/t45-walk`、`feat/archive-merge`、`audit/coverage`、`ledger-sync` |
| **C · 值得看一眼** | **20** | `compat/*`（5 个）、`fix/profile-verify`、`fix/honest-baseline`、`docs/note-52/53`、`audit/e2-stop` |

## 四、C 类里最值得补的两条

1. **`compat/dsh-0.2.2-rc.1*`（5 个）** —— 这是 `AGENTS.md` §2.2.1 交接的素材。主线**已经**有 rc1 兼容
   （当前宿主就是 `Desktop-0.2.2-rc.1`，测试全绿），所以这 5 个分支大概率是"参考实现"，
   但 §2.2.1 写明的探针（`longmemory-rc1-probe.mjs`）**主线里没有** —— 值得看一眼要不要把探针移进来。
2. **`fix/profile-verify`（3/8 文件主线没再动过）** —— 涉及 profile 校验；与我们今天踩的
   「工具面在 rc1 宿主上没挂上」（T375）可能是同一块区域。

## 五、结论

- **18 个分支可以删**（5 + 13，判据可复算），但**我这轮不删**：删远端分支是不可逆的对外动作，
  按纪律先报给你，点头我再删。
- **20 个"值得看一眼"**，其中 `compat/*` 与 `fix/profile-verify` 优先。
- 本地分支同理未动（`git branch -D` 同样只在你点头后执行）。

## 六、复算

```bash
git fetch --prune origin
bash scripts/branch-triage.sh | sort -r
```

# T217 · profile 脚本校验缺口修复（T215 六问逐条复核）

> `[本] 2026-11-05 11:50 +08:00` · **真 profile 一个字节没动**（sha256 前后一致 `794cb8ac…`）。
> 产物：`scripts/kifu-profile-stage.mjs`、`test/kifu-profile-stage.test.mjs`、`tmp/apply-kifu-profile.sh|ps1`、`tmp/t217-redo.cjs`

## 0 · 一句话

**现在这条命令可以给主人跑。** 写前校验已经是**真 YAML 解析**（`yaml@2.9.1`，profile 里那份），
不再是"只看缩进"的假校验；备份可校验（sha256 对拍）、目标被改过就拒写、回滚走"cp 到临时文件再 mv"。

## 1 · 改了什么（F1–F5 对照）

| 项 | 改前 | 改后 |
|---|---|---|
| **F1 校验** | `require('yaml')` 在仓库根 ⇒ 本机没有 `node_modules` ⇒ 恒回落"结构校验"（**假校验**） | `yamlModulePath()` 依次找 `<DSH_HOME>/profiles/<profile>/package.json` → 仓库 `package.json`；实测命中 **`yaml@2.9.1`**。找不到才回落，且回落**必打印** `⚠ 结构校验，不是 YAML 校验` |
| **F2 目标被改过** | 无 | staging 记录 `base sha256`；apply 前比对，不一致 ⇒ **退出 5、拒绝写** |
| **F3 备份可校验** | 只 `cp`，不校验 | `cp -p` 后 `sha256sum` 对拍并**打印两个 sha256**；不一致 ⇒ **退出 4** |
| **F3 回滚** | `cp` 直接覆盖 | `cp` 到 `$TARGET.rollback.<stamp>` 再 `mv -f`（中途被杀不会留半截） |
| **F4 热重载提示** | 无 | 脚本首 3 行 + 报告首行都写明 2026-10-30 事故（`AGENTS.md` §2.2） |
| **F4 PS1 退出码** | `Write-Error; exit N`（`$ErrorActionPreference='Stop'` 下先抛终止错误 ⇒ 实际退出 **1**） | 全部改 `Write-Host "…"; exit N`，退出码与 bash 版一致（2/3/4/5） |
| **F5 备份名** | `%Y%m%d-%H%M%S`（同秒覆盖） | `%Y%m%d-%H%M%S-%3N` / `yyyyMMdd-HHmmss-fff`（带毫秒）；文件结尾补换行 |

## 2 · 四种非法 YAML 必须 FAIL（实测）

```
$ node scripts/kifu-profile-stage.mjs --verify <file>
未闭合 [   → false  ["Flow sequence in block collection must be sufficiently indented and end with a ]"]
未闭合 {   → false  ["Flow map in block collection must be sufficiently indented and end with a }"]
非法锚点   → false  ["Anchor cannot be an empty string at line 2, column 9:"]
重复键     → false  ["Map keys must be unique at line 2, column 3:"]
合法 patch → true (引擎 yaml@2.9.1 · 条目 18 个)
```
apply 脚本遇到非法 staged：**退出 3，目标文件原样**（T217 ①b 实测）。

## 3 · 假目录全流程（`tmp/t217-fake-profile`，已清理）

```
base sha   = 794cb8ac672ae550d326b294b602cd7874932ed7c70d79d8b0651d342985a529
staged sha = aa3740effd43aa2f536644ba376984659d1ee5eb6b43a6d5b5c066f669591872

备份：…/cordis.patch.yml.bak-20261105-114336-107
  target sha256 = 794cb8ac672ae550d326b294b602cd7874932ed7c70d79d8b0651d342985a529
  backup sha256 = 794cb8ac672ae550d326b294b602cd7874932ed7c70d79d8b0651d342985a529
已替换：…/cordis.patch.yml
回滚（cp 到临时文件再 mv）：
  cp -p "…bak-20261105-114336-107" "…rollback.20261105-114336-107" && mv -f …
```
替换 diff（-4 / +6）：
```
360,362d359
< - id: kifu-longmemory
<   name: dsh-gokifu-longmemory
<   disabled: true
365d361
<   disabled: true
409a406,411
> # === 棋院工具面（PTC / run_code）：kifu_* 五个只读工具 ===
> # 与主插件分开挂：…
> - id: kifu-tools
>   name: dsh-gokifu-longmemory/tools
```
**回滚后 sha256 = `794cb8ac…` = 改前**（逐字节相同）。

## 4 · T215 六问「改后」状态

| # | T215 判定 | 改后 |
|---|---|---|
| 1 | 备份在写之前 ✓ | ✓ 仍是"先备份再动"，且现在备份**可校验** |
| 2 | **备份不可校验 ✗** | ✓ **已修**：`cp` 后 sha256 对拍 + 打印，不一致退出 4 |
| 3 | 替换原子 ✓ | ✓ 保持（同目录临时文件 + `mv`）；回滚也改成同款 |
| 4 | 回滚可执行且逐字节相同 ✓ | ✓ 保持（假目录实测 sha256 与改前相同） |
| 5 | 中断后目标完好 ✓ | ✓ 保持；另加 `base sha256` 检查，**别人改过就拒写**（退出 5） |
| 6 | 写前校验是假的 ✗ | ✓ **已修**：真 `yaml@2.9.1` 解析，找不到才回落并醒目告警 |

## 5 · 测试

```
$ node --test "test/kifu-profile-stage.test.mjs"
ℹ tests 10   ℹ pass 10   ℹ fail 0   ℹ duration_ms 2746.14
```
新增 5 条：① 真 YAML（四种非法全 FAIL）② 非法 staged ⇒ 退出 3 且目标原样 ③ base sha 不一致 ⇒ 退出 5 ④ 备份 sha256 打印且与源一致 + 回滚逐字节相同 ⑤ PS1 无 `Write-Error`、退出码 2/3/4/5 齐全、备份名带毫秒。

## 6 · 主人要跑的那一条

```bash
bash "D:/DeepSeek Harness/default-workspace/长期记忆系统/tmp/apply-kifu-profile.sh"
```
跑完在桌面点「重启」（脚本不重启 DSH；热重载风险见脚本首行）。

## 7 · 可重放补丁

```bash
node tmp/t217-redo.cjs          # 幂等；anchor 不匹配抛错
node tmp/t217-redo.cjs --check  # 只报告
```

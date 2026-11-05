# T215 · 主人要跑的那条命令的独立复核（`tmp/apply-kifu-profile.sh`）

> `[本] 2026-11-05 11:36 +08:00` · **只读真 profile**（一个字节没动）· 未重启 DSH、未 taskkill
> 审对象：`tmp/apply-kifu-profile.sh`（`8705b78b…`）· `tmp/apply-kifu-profile.ps1`（`f283770b…`）· `scripts/kifu-profile-stage.mjs`（`c4a6e2e2…`）
> 演练目录：`tmp/t215-fake-profile/`（真 patch 的副本，`794cb8ac…`）· 真 patch 复核后仍是 `794cb8ac…`（未被碰）

## 0 · 一句话裁决

**不能直接跑 —— 必须先改「校验」这一处。**
`--verify` 只有在环境里装着 `yaml` 模块时才是真 YAML 解析；本机**仓库没有 `node_modules`**，`require('yaml')` 必然失败，于是退化成**只查行结构**（`- ` 前缀 / 缩进 / TAB / 引号奇偶）。我实测把一份**语法非法**的 patch（`- id: [unclosed`）交给脚本，它报「校验 OK」并**真的写进了目标文件**（`794cb8ac…` → `1edc47c5…`）。这类文件一旦生效，host 组合树会失败 —— 正是 `AGENTS.md` §2.2 那条事故的形状。

其余五问：**备份在写之前 ✓ / 备份不可校验 ✗ / 替换原子 ✓ / 回滚可执行且逐字节相同 ✓ / 无部分写入但会留孤儿 `.tmp.*` ✗ / 没有热重载提示 ✗**。

## 1 · 逐条回答（每条带证据）

### Q1 备份在**写之前**吗？备份**可校验**吗？

**顺序对**：`--verify`（第 1 步）→ `cp -p "$TARGET" "$BACKUP"`（第 2 步）→ `cp` 到 TMP + `mv`（第 3 步）。任何一步失败 `set -euo pipefail` 都会在写目标之前中止。

**但备份不可校验**：脚本不打印、也不比较备份的 sha256 / `cmp`，只打印回滚命令。演练里我是**自己**算的 sha256 才发现备份是好的：

```
改前:  794cb8ac672ae550d326b294b602cd7874932ed7c70d79d8b0651d342985a529  cordis.patch.yml
备份:  794cb8ac672ae550d326b294b602cd7874932ed7c70d79d8b0651d342985a529  backup/cordis.patch.yml.bak-20261105-113147
```
（`cp -p` 若因磁盘满/权限只写了半个文件，脚本同样会继续往下走并打印「已替换」——没有任何一处会停下来。）

### Q2 替换是**原子**的吗？

**是。** 同目录临时文件 + `mv -f`（同盘 ⇒ rename）。实测两点：

```
$ echo hi > probe.tmp && echo old > probe.target && mv -f probe.tmp probe.target
probe.tmp 还在吗: 不在（⇒ rename 语义）

$ 150MB 文件 mv 期间每 20ms 采样目标大小：
157286400 157286400 … （60 次全是新尺寸，没有 4/半截/0 的中间态）
```

PS1 的 `Move-Item -Force` 同样是 rename 语义，行为一致。

### Q3 校验失败时**真的不写**吗？

**形式上是**（`--verify` 非零 ⇒ `exit 3`，目标未被碰）——**但这份校验抓不到 YAML 语法错误**，所以这道防线形同虚设：

```
$ node scripts/kifu-profile-stage.mjs --verify tmp/t215-fake-profile/broken.staged.yml
校验 OK（条目 1 个 · yaml 模块 不可用，已用结构校验替代）

$ bash tmp/apply-kifu-profile.sh tmp/t215-fake-profile/broken.staged.yml …/cordis.patch.yml …/backup
已替换：…/cordis.patch.yml
script-exit=0

$ sha256sum …/cordis.patch.yml
1edc47c50922d75a…      ← 改前是 794cb8ac…（**坏 YAML 被写进去了**）
```

四种非法 YAML 全部被判「PASS」：

```
PASS  未闭合方括号（YAML 非法）  errors=[]
PASS  未闭合花括号                errors=[]
PASS  非法锚点/别名              errors=[]
PASS  重复键                      errors=[]
```

**根因**：`verifyPatch` 用 `require('yaml')` 做真解析，但仓库没有 `node_modules`（`require('yaml')` → `MODULE_NOT_FOUND`），catch 之后只留下结构检查。而**机器上其实有 yaml 模块**：

```
$ node -e "console.log(require('<DSH_HOME>/profiles/desktop/node_modules/yaml/package.json').version)"
2.9.1
$ node -e "require('<…>/yaml').parse('- id: [unclosed\n  name: x\n')"
解析失败（正确）：Flow sequence in block collection must be sufficiently indented and end with a ] at line 2, column 3
```
⇒ 修法不是"引入新依赖"，是**让探针去 profile 的 `node_modules` 找 yaml**（或 `createRequire` 指向那里）。

### Q4 回滚命令**可执行**吗？

**可以**（引号完整、路径存在、`-p` 保留时间戳），演练实测恢复后逐字节相同：

```
$ cp -p "tmp/t215-fake-profile/backup/cordis.patch.yml.bak-20261105-113539" "tmp/t215-fake-profile/cordis.patch.yml"
$ cmp <备份> <目标> && echo "cmp: 回滚后与改前逐字节相同 ✓"
cmp: 回滚后与改前逐字节相同 ✓
$ sha256sum …/cordis.patch.yml
794cb8ac672ae550…      ← 与改前一致
```

**但**：`cp` 是"先截断再写"，**回滚过程本身不原子** —— 回滚时断电/被杀，目标会变成半截（比"没回滚"更糟，因为备份还在但用户以为已经恢复）。

### Q5 有没有**任何**路径会让 `cordis.patch.yml` 变成半截？

**目标文件本身没有**：写目标只有 `mv -f` 一次，rename 原子（Q2）。**但失败会在 profile 目录里留孤儿临时文件**，脚本没有 `trap` 清理：

```
中断演练（PATH 垫片让 cp 先写 1000 字节再被杀）：
  目标 sha256 = 794cb8ac…（未变 ✓）
  残留：cordis.patch.yml.tmp.20261105-113237   262009 字节
        cordis.patch.yml.tmp.20261105-113250     1000 字节（半截）
```
另外 `mv` 之后若目标是**被宿主占用**的（Windows 文件锁），`mv` 会失败 → `set -e` 中止 → 目标保持原样（这一点是安全的），但同样留下 TMP。

### Q6 **重载风险**提示了吗？

**没有。** 脚本最后两行只说：

```
回滚命令： cp -p "…bak-…" "…cordis.patch.yml"
然后由你在桌面点「重启」让配置生效（本脚本不会重启 DSH）。
```

它没有告诉用户：**写这个文件本身**就可能触发整树热重载（`AGENTS.md` §2.2 的 2026-10-30 事故：写到 patch → 热重载 → idle 子代理读到已撤销的 inbox → host `exit(1)`）。也没有"写入前先确认无人正在会话/延迟几秒"之类的保护。
（我尝试从 `app.asar` 里定位 watcher 实现，二进制只命中字符串，**未能拿到可引用的代码**；这一条按项目自己的成文法 + 脚本自身的注释定级。）

## 2 · 演练三份输出

### 2.1 改前 → 改后（逐行 diff）

```
@@ -357,12 +357,8 @@
     preference: dark
 
 # === 临时禁用：dsh-gokifu-longmemory（cap: 等 @deepseek-ai/dsh-client-ui-settings 卡死 web boot）===
-- id: kifu-longmemory
-  name: dsh-gokifu-longmemory
-  disabled: true
 - id: dsh-gokifu-longmemory
   name: dsh-gokifu-longmemory
-  disabled: true
 - id: subagent-model-selection-settings
@@ -407,3 +403,9 @@
   name: "@deepseek-ai/dsh-session-log-deepseek"
   config:
     enabled: false
+
+# === 棋院工具面（PTC / run_code）：kifu_* 五个只读工具 ===
+# 与主插件分开挂：宿主只把 tools 服务交给**声明了 inject** 的插件；本插件缺服务时只是自己不加载，
+# 记忆注入（主插件）完全不受影响。
+- id: kifu-tools
+  name: dsh-gokifu-longmemory/tools
\ No newline at end of file
```
（两个 `disabled: true` 的 kifu 块被移除、插入一条启用的 `dsh-gokifu-longmemory` + `kifu-tools` 段；**文件结尾没有换行**。）

### 2.2 回滚后是否逐字节相同

```
cmp: 回滚后与改前逐字节相同 ✓
sha256 = 794cb8ac672ae550d326b294b602cd7874932ed7c70d79d8b0651d342985a529
```

### 2.3 中途 kill 后目标是否完好

```
$ kill -9 <脚本 pid>          # 正处在写 TMP 的窗口
/usr/bin/bash: line 7: … Killed …
目标 sha256 = 794cb8ac672ae550…      ← 完好
残留 cordis.patch.yml.tmp.20261105-113250（1000 字节，半截 TMP）
```

## 3 · 额外发现（不在 6 问里，但会咬人）

1. **无 base 哈希 ⇒ 会静默回退别人的改动**：staging 时读了真 patch，apply 时**不校验目标是否仍是当初那份**。这个库今天 02:28 就有人改过 patch（mtime 为证）；在多 agent 并发下，"staging 之后别人又改了 patch" ⇒ apply 会把人家的改动整个盖掉，且没有任何提示。
2. **PS1 的退出码与文档不符**：`$ErrorActionPreference = "Stop"` 下 `Write-Error` 会先抛终止错误，`exit 2` 永远执行不到。实测：
   ```
   PS1 缺文件分支的真实退出码 = 1（脚本写的是 exit 2）
   ```
   任何"用退出码判断成功/失败"的调用方都会误判。
3. **时间戳只到秒**：`STAMP=$(date +%Y%m%d-%H%M%S)` 同时用于 TMP 与备份名 —— 同一秒内跑两次，第二份**备份会覆盖唯一的好备份**（`cp -p` 默认覆盖）。
4. **备份目录在 profile 内**（`home/profiles/desktop/backup`）：写它也是往 profile 目录里写（不是 patch 文件本身，风险低，但和"绝不在 profile 里写东西"的直觉冲突）。

## 4 · 最坏情况

用户按提示跑完、桌面点「重启」之后：`cordis.patch.yml` 如果是**语法非法**（本次实测可复现），host 组合树失败 ⇒ **DSH 起不来**。此时唯一恢复手段是命令行执行备份回滚 —— 而如果同一秒跑过两次、备份已被覆盖，或回滚命令贴错路径，就**没有可用备份**了（真 profile 里现在堆着 8 个 `.bak-*`，正是这种"靠人记"的脆弱性）。

## 5 · 修法（只报告，本刀不改；四改都是小改）

| # | 位置 | 改法 | 为什么必须 |
|---|---|---|---|
| **F1** | `scripts/kifu-profile-stage.mjs` · `verifyPatch` | 探针改为从 `<DSH_HOME>/profiles/<profile>/node_modules/yaml` 解析（本机已装 2.9.1）；解析失败 ⇒ `ok:false` | 没有真 YAML 解析，"校验"就是摆设（本次实测坏文件被写入） |
| **F2** | `tmp/apply-kifu-profile.sh` | staging 时把目标 sha256 写进 staged 的伴生文件，apply 时先比对；不一致 ⇒ 拒绝 | 防"静默回退别人的改动"（多 agent 并发是常态） |
| **F3** | 同上 | 备份后 `cmp -s` 校验 + 打印 sha256；回滚命令改成 `cp` 到临时文件再 `mv`（原子回滚） | 备份可校验、回滚可中断 |
| **F4** | 同上 + PS1 | 顶部加一行热重载风险提示（"写这个文件可能触发整树热重载；请先确认无人在跑"）；PS1 的 `Write-Error; exit N` 改成 `Write-Host … -ForegroundColor Red; exit N` | 目前只提示"点重启"，误导 |

## 6 · 复现

```bash
# 假 profile（真 patch 的副本）
mkdir -p tmp/t215-fake-profile/backup
cp "D:/DeepSeek Harness/home/profiles/desktop/cordis.patch.yml" tmp/t215-fake-profile/cordis.patch.yml
sha256sum tmp/t215-fake-profile/cordis.patch.yml    # 794cb8ac…

# 生成 staged（不跑 --apply，避免写仓库 tmp/）
node --input-type=module -e 'import fs from "node:fs";import {stagePatch,toolsEntryBlock} from "./scripts/kifu-profile-stage.mjs";
const s=stagePatch(fs.readFileSync("tmp/t215-fake-profile/cordis.patch.yml","utf8"),{toolsBlock:toolsEntryBlock()});
fs.writeFileSync("tmp/t215-fake-profile/cordis.patch.staged.yml",s.text);console.log(s.changes.map(c=>c.kind))'

# 演练：apply → diff → 回滚 → cmp
bash tmp/apply-kifu-profile.sh tmp/t215-fake-profile/cordis.patch.staged.yml tmp/t215-fake-profile/cordis.patch.yml tmp/t215-fake-profile/backup
diff -u tmp/t215-fake-profile/backup/*.bak-* tmp/t215-fake-profile/cordis.patch.yml
cp -p tmp/t215-fake-profile/backup/*.bak-* tmp/t215-fake-profile/cordis.patch.yml && cmp <备份> <目标> && echo 相同

# 坏 YAML 被放行（F1 的证据）
printf -- '- id: [unclosed\n  name: x\n' > tmp/t215-fake-profile/broken.staged.yml
bash tmp/apply-kifu-profile.sh tmp/t215-fake-profile/broken.staged.yml tmp/t215-fake-profile/cordis.patch.yml tmp/t215-fake-profile/backup
```

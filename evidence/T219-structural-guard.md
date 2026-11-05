# T219 · 无 YAML 引擎时 fail-closed（CLI 层收尾）

> `[本] 2026-11-05 12:20 +08:00` · 真 profile 未动（`339dcb32…` 前后一致）。
> 产物：`scripts/kifu-profile-stage.mjs`、`test/kifu-profile-stage.test.mjs`、`tmp/apply-kifu-profile.sh|ps1`、`tmp/t219-redo.cjs`

## 1 · 两个 CLI 缺陷（已修）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| ❶ | `--verify` 失败却 **exit 0** | `main()` 返回 `res.code`，但 verify 分支没把 6 带上来 | `code: res.ok ? 0 : (res.code ?? 3)` + `process.exitCode = main()` |
| ❷ | 引擎明明加载成功，却打印「yaml 模块 **不可用**」 | 报告用 `r.verify.yamlModule`，而 `verifyPatch` 早改成 `engine` ⇒ 恒 falsy | 统一用 `engine`：`engine !== 'none'` ⇒ 打印 `可用（yaml@2.9.1）`；只有 `engine === 'none'` 才打印「⚠ 结构校验，不是 YAML 校验」 |

## 2 · 实测（四条验收）

```
$ node scripts/kifu-profile-stage.mjs --verify tmp/cordis.patch.staged.yml
校验 OK（引擎 yaml@2.9.1 · 条目 18 个 · yaml 模块 可用）
exit=0

$ DSH_HOME=/nonexistent node scripts/kifu-profile-stage.mjs --verify tmp/cordis.patch.staged.yml
校验失败：
  - ✗ 没有 YAML 引擎（试过 <profile>/node_modules/yaml 与仓库 node_modules），拒绝在没有真校验的情况下修改 patch
exit=6

$ DSH_HOME=…/tmp/t219v/home bash tmp/t219v/apply.sh
✗ 写前校验失败（exit=6），目标未改动：…/cordis.patch.yml
exit=6
sha256 = 339dcb3274bd8c74…   ← 与改前相同
```

## 3 · 测试（两个环境都绿）

```
$ node --test "test/kifu-profile-stage.test.mjs"
ℹ tests 8   ℹ pass 8   ℹ fail 0   ℹ skipped 0

$ DSH_HOME=/nonexistent node --test "test/kifu-profile-stage.test.mjs"
ℹ tests 8   ℹ pass 8   ℹ fail 0   ℹ skipped 0
```
新增 CLI 级用例：`--verify 非法输入 ⇒ 进程退出码非 0`（此前只测库层，所以 ❶ 漏网）。

## 4 · 一句话回报（原样给主人）

> **这条命令只有在本机能解析到 YAML 引擎（`<profile>/node_modules/yaml` 或仓库 `node_modules/yaml`）时才允许写；没有引擎就拒绝执行、退出 6，目标文件一个字节都不会动 —— 除非你显式加 `--allow-structural` 自担风险降级。**

## 5 · 可重放补丁

```bash
node tmp/t219-redo.cjs          # 幂等；anchor 不匹配抛错
node tmp/t219-redo.cjs --check  # 只报告
```

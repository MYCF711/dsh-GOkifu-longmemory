# T367 · `kifu_consolidate`：S4 工具面的最后一块（只读预览）

> 2026-11-09 · 计划表 T143「S4 工具面：`kifu_view` / `kifu_consolidate`（只读预览）」。

## 一、发现

`计划表.md` 的 T143 一直标「⏳ 进行中」，但实际只有 `kifu_view` 落了地 —— 工具面是 **6 个**：
`stats / search / card / recent_failures / view / get`，**没有 `kifu_consolidate`**。

## 二、为什么它必须是「只读预览」

`rooms/consolidate.mjs` 的 `consolidate()` 有写模式：`dryRun:false` + `outStoreDir` ⇒ 产**影子库**。
那是「改记忆」的动作，绝不该从代码块（PTC）里发生。所以：

- 工具面**不暴露** `dryRun` 参数（想写也传不进来）；
- SDK 的 `consolidate()` **写死** `dryRun: true`；
- 输出有界：组数 `limit`（≤50）、每组成员 ≤10 个、正文按 `previewChars` 截断（40–400，默认 160）。

## 三、改了什么

| 文件 | 改动 |
|---|---|
| `src/sdk.mjs` | 新增 `consolidate(opts)`（只读；`limit`/`previewChars` 夹紧；JSON 安全；库缺失优雅返回 `status:'missing'`） |
| `src/tools.mjs` | 注册 `${TOOL_PREFIX}_consolidate`（`scope` / `limit` / `previewChars`） |
| `test/tools*.test.mjs`、`test/tools-plugin.e2e.test.mjs` | 工具数 6 → 7；e2e 真库调用补一条 |

## 四、验收

```
node --test test/t367-kifu-consolidate.test.mjs → 3/3
  ✔ ① 工具存在、**没有** dryRun 参数、并发安全
  ✔ ② 输出有界（limit 夹紧 / 成员 ≤10 / 正文按 previewChars 截断）+ JSON 安全
  ✔ ③ 真跑一次**一个字节都不写**（整库 sha256 前后一致）
node --test "test/*.test.mjs" → 1288 条 / 1282 pass / 0 fail / 6 skip
node scripts/check.mjs        → PASS
```

## 五、一个诚实的细节：`ok` 不是"工具能用"

`consolidate()` 的 `ok` 是**质量闸 t1–t5 的合取**（其中 t5 = `reduction ≤ 25%`）。
小夹具（2 条合 1 组 = 50%）下 `ok:false` 是**如实**的，不是 bug ——
所以测试里钉的是「输出有界 / 零写入 / 参数不可绕过」，不是「ok 必须 true」。
**预览工具不该为了让测试好看而谎报 ok。**

## 六、边界

- 工具面**只读**：写模式仍然只能走 `scripts/consolidate` 一类的 CLI + 显式影子库。
- `ok:false` 的含义是「这批数据合流收益不达标」，**不是**「工具坏了」；调用方看 `stats` / `quality` 分项。

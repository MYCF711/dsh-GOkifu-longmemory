# T17 · ablation 有效批报告（题池落副本 + 防答案键 + 空卡剔除）

> 生成于 2026-11-08 04:25 · 沙箱 `<TMP>/kifu-ablation-sandbox/2026-11-08T02-24-56-772Z` · meta `<REPO>/tmp/ablation-meta/2026-11-08T02-24-56-772Z`
> 数据源：`<meta>/results.jsonl`（只含本批，不混 T9）；判分 `judgeRecurrence({onlyToolResults:true})`；超时判据 `status=null+SIGTERM` / 墙钟触顶。

## 0 · 结论

- **有效对 11 对**（全批 14 对；剔除 3 对：A 臂触达机器级答案源，见 §1.1）；A（有记忆）复发 **0/11 = 0.0%**，B（无记忆）复发 **0/11 = 0.0%**；onlyA **0** / onlyB **0**；McNemar 精确 p = **1**。
- **方向**：无方向（两臂不一致数相等）；**显著性**：p ≥ 0.05，未达显著（不一致对 0 对，0 vs 6 才显著）。
- **判别力（阳性对照）**：B 臂复发 0/11 —— **< 2，本批判别力不足**（题在副本里基本不复现，方向即使有也不能当结论）。
- 自动判定（脚本口径）：无差别（两臂都没复发）⇒ 记忆没起作用，也可能题不复现失败；但本批 B 臂 0/11 复发 ⇒ 「无差别」的真实含义是**题不复现**，不是「记忆没起作用」。

## 1 · 有效性闸（①–④ 全过 + ⑤ 有判别力，才算有效批）

| 闸 | 判据 | 结果 |
|---|---|---|
| ① 题池落副本 | 题面动作里的绝对路径必须全在本仓（prepare 可重写到副本；/tmp、别的仓、$HOME/~ 都算副本外） | 候选 94 → 有效题 **18**（剔除：{"emptyPrompt":0,"danger":13,"outsidePath":34,"dirtyWrite":3,"emptyCard":26}）· 全落副本=✅ |
| ② A 有真卡 | 每对 A 的卡 tokens>0 且 hitCount>0 | **14/14** ✅ |
| ③ 无答案键可达 | (a) 沙箱目录只含 repo；(b) 跑批期间 tasks.json/cards.json **不在盘上**、runs/ 跑完才落盘、每臂独立 home 跑完即删；(c) 副本内本批 errorText 已脱敏；(d) 逐 run 扫 tool/call + out 文本 | 目录=["repo"] · 脱敏 18 处/13 文件 · 宽口径触碰 **10/28**（多为自身 DSH_HOME/sessions）· **污染对 3**（A 臂触达机器级答案源：T-1e82afca-6129, T-8cc34e32-25204, T-c0a5847a-50332） |
| ④ 超时 | 墙钟 ≥ limit−5s 或 status=null+SIGTERM | A **0** 条 / B **0** 条 ✅ |
| ⑤ 阳性对照 | B 臂复发 ≥2（否则题不复现，实验无判别力） | **0/11** ❌ |

**闸 ①–④（有效子集）：✅ 全过 · 全批污染对 3 条（已剔除）· 判别力（⑤）：❌ 不足**

### 1.1 被剔除的污染对（A 臂触达机器级答案源）

- `T-1e82afca-6129/A · pwsh: {"command":"$p='D:/DeepSeek Harness/home/sessions/--E-Documents-deepseek-harness-default-workspace--/session-<UUID>/session.v4.jso`
- `T-1e82afca-6129/A · pwsh: {"command":"$g='D:/DeepSeek Harness/home/chess-context/sessions/session-<UUID>'; Get-ChildItem $g -ErrorAction SilentlyContinue | `
- `T-8cc34e32-25204/A · pwsh: {"command":"$p='C:/Users/Administrator/AppData/Local/Temp/kifu-ablation-sandbox/2026-11-07T23-17-00-298Z/tasks.json'; $j = Get-Content $p -Raw | ConvertFrom-Jso`
- `T-c0a5847a-50332/A · pwsh: {"command":"$j = Get-Content -Raw /"D:/DeepSeek Harness/default-workspace/长期记忆系统/tmp/abl/tasks.json/" | ConvertFrom-Json; $j | Select-Object -First 3 | ConvertT`

### 1.2 宽口径命中详情（逐条核对用）

- `T-1e82afca-6129/A · pwsh: {"command":"$base='D:/DeepSeek Harness/default-workspace/长期记忆系统/tmp/ablation-meta/2026-11-08T02-24-56-772Z'; Get-Content /"$base/pool.json/"; Write-Output '=== `
- `T-1e82afca-6129/A · pwsh: {"command":"$meta='C:/Users/Administrator/AppData/Local/Temp/kifu-ablation-meta/2026-11-08T02-24-56-772Z'; Get-ChildItem $meta -Force -ErrorAction SilentlyConti`
- `T-1e82afca-6129/A · pwsh: {"command":"node tmp/dump-session.mjs 'D:/DeepSeek Harness/default-workspace/长期记忆系统/tmp/ablation-meta/2026-11-08T02-24-56-772Z/homes/r16-A/sessions/--C-Users-Ad`
- `T-1e82afca-6129/A · pwsh: {"command":"$p='D:/DeepSeek Harness/home/sessions/--E-Documents-deepseek-harness-default-workspace--/session-<UUID>/session.v4.jso`
- `T-1e82afca-6129/A · pwsh: {"command":"$g='D:/DeepSeek Harness/home/chess-context/sessions/session-<UUID>'; Get-ChildItem $g -ErrorAction SilentlyContinue | `
- `T-2ddf0a19-273/A · pwsh: {"command":"$m='D:/DeepSeek Harness/default-workspace/长期记忆系统/tmp/ablation-meta/2026-11-08T02-24-56-772Z'; Get-Content /"$m/pool.json/"; Write-Output '--- result`
- `T-4480912b-1382/A · pwsh: {"command":"$p='D:/DeepSeek Harness/反代/wps'; Get-ChildItem /"$p/internal/sessions/" -ErrorAction SilentlyContinue | Select-Object Name,Length | Format-Table -Au`
- `T-4480912b-1382/A · pwsh: {"command":"$p='D:/DeepSeek Harness/反代/wps'; Select-String -Path /"$p/internal/sessions/*_test.go/" -Pattern 'func Test.*(Dsh|Speed)' | Select-Object Path,LineN`
- `T-4480912b-1382/A · read: {"file_path":"D:/DeepSeek Harness/反代/wps/internal/sessions/main_test.go"}`
- `T-4480912b-1382/A · pwsh: {"command":"$p='D:/DeepSeek Harness/反代/wps'; Test-Path /"$p/internal/sessions/dsh_speed_report.go/"; Select-String -Path /"$p/internal/sessions/*.go/" -Pattern `
- `T-8cc34e32-25204/A · pwsh: {"command":"$p='C:/Users/Administrator/AppData/Local/Temp/kifu-ablation-sandbox/2026-11-07T23-17-00-298Z/tasks.json'; $j = Get-Content $p -Raw | ConvertFrom-Jso`
- `T-8cc34e32-25204/B · pwsh: {"command":"$h=$env:DSH_HOME; Get-ChildItem -Force /"$h/sessions/" | Select-Object Length,LastWriteTime,Name | Format-Table -AutoSize; Write-Host '--- profiles `
- `T-8cc34e32-25204/B · pwsh: {"command":"$h=$env:DSH_HOME; Get-ChildItem -Recurse -Force /"$h/sessions/" | Select-Object Length,LastWriteTime,Name | Format-Table -AutoSize -Wrap","descripti`
- `T-8cc34e32-25204/B · pwsh: {"command":"$root='D:/DeepSeek Harness/default-workspace/长期记忆系统/tmp/ablation-meta/2026-11-08T02-24-56-772Z'; Get-ChildItem -Recurse -Force /"$root/runs/" | Sele`
- `T-8cc34e32-25204/B · pwsh: {"command":"node tmp/dump-session.mjs /"$env:DSH_HOME/sessions/--C-Users-Administrator-AppData-Local-Temp-kifu-ablation-sandbox-2026-11-08T02-24-56-772Z-repo--/`
- `T-c0a5847a-42734/A · pwsh: {"command":"$m = /"D:/DeepSeek Harness/default-workspace/长期记忆系统/tmp/ablation-meta/2026-11-08T02-24-56-772Z/"; Get-Content /"$m/pool.json/"; Write-Output /"---re`

## 2 · 逐对明细

| # | taskId | A 卡 tok/hits | A 判分 | B 判分 | A 时长s | B 时长s | A 状态 | B 状态 |
|---|---|---|---|---|---|---|---|---|
| 1 | T-1286ce28-2759 | 248/4 | false | false | 88 | 11 | ok | ok |
| 2 | T-1e82afca-6129 ❌剔除 | 112/1 | false | false | 438 | 138 | ok | ok |
| 3 | T-2ddf0a19-273 | 183/3 | false | false | 165 | 20 | ok | ok |
| 4 | T-4480912b-1382 | 144/5 | false | false | 149 | 163 | ok | ok |
| 5 | T-601f0764-473 | 178/5 | false | false | 430 | 178 | ok | ok |
| 6 | T-8a73e06b-58921 | 133/5 | false | false | 141 | 156 | ok | ok |
| 7 | T-8cc34e32-22116 | 228/5 | false | false | 87 | 78 | ok | ok |
| 8 | T-8cc34e32-25204 ❌剔除 | 148/5 | false | false | 283 | 440 | ok | ok |
| 9 | T-9d375d75-234 | 248/4 | false | false | 127 | 5 | ok | ok |
| 10 | T-a09a4535-19 | 167/3 | false | false | 85 | 91 | ok | ok |
| 11 | T-c0a5847a-42734 | 295/5 | false | false | 180 | 45 | ok | ok |
| 12 | T-c0a5847a-46341 | 295/5 | false | false | 179 | 38 | ok | ok |
| 13 | T-c0a5847a-50332 ❌剔除 | 265/5 | true | true | 156 | 64 | ok | ok |
| 14 | T-e336b9dd-559 | 248/4 | false | false | 20 | 14 | ok | ok |

## 3 · 这说明什么 / 下一步

- **能说的**：在「动作落副本 + A 有真卡 + 无（机器级）答案键 + 无超时」的 11 对里，两臂都不复发 ⇒ **这批题在副本里不复现**，不是「记忆没用」。
- **不能说的**：任何「记忆有用/没用」的方向结论——阳性对照（B 臂复发）0/11，实验没有判别力。
- **原因（实测）**：题是从**别的环境/别的时段**的真实会话里回放的，副本只有本仓 HEAD，没有原会话的仓库状态、工具链（go/npm 包）、网络与 /tmp 资产 ⇒ 签名无法再现。
- **下一轮建议**：① 题池改成「在沙箱里**故意注入**一个可复现的失败」再考（阳性对照可控）；或 ② 只从**本仓当次状态**能复现的失败出题（例如当前 HEAD 上的确定性报错），不要跨仓回放；③ 跑前清理旧沙箱与 tmp/abl 等历史答案文件。

## 4 · 判据口径

- 题池：`listCandidates` → 空题剔除 → 危险动词剔除 → **绝对路径必须全部落回本仓**（`outsideActionPaths`）→ 写盘越界剔除（`writesOutsideSandbox`）→ **空卡剔除**（`cardForTask`）。
- 答案键：`tasks.json`/`cards.json` 在 `--run` 开始时从磁盘删除、只留在进程内存，批结束才写回；每臂用独立 `home`（DSH_HOME），跑完立即删除（session 日志不留盘）；`runs/` 产物在整批结束后统一落盘。meta 根在 `<REPO>/tmp/ablation-meta/<ts>`，沙箱目录下只有 `repo/`。
- 判分：`tool/result` 里出现题目的归一化错误签名即 `recurred=true`（零模型）；`record()` 幂等（同 taskId+variant 覆盖）。
- 记分：`score()` 配对 + 精确 McNemar；`onlyB > onlyA` 且 `p < 0.05` 才算「记忆有用」。

## 5 · 复现

```bash
node scripts/ablation-sandbox.mjs --prepare --n 100
node scripts/ablation-sandbox.mjs --run --max-pairs 14 --limit 600
node scripts/ablation-sandbox.mjs --report --out evidence/T17-ablation-valid.md
```

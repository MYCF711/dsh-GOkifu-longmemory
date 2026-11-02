# M7 · 安装医生 `scripts/install-doctor.mjs`（2026-11-02）

## 目的
A3「可靠性」卡在“没安装”。装完之后需要一条命令回答：**到底装上没有、装上以后健康不健康**。

## 检查项（全部只读）
| # | 检查 | 失败含义 |
|---|---|---|
| 1 | 插件注册：`$DSH_HOME` 的 yml/json 里出现 `dsh-gokifu-longmemory`；并识别 `disabled: true` | 没安装 / 被禁用 |
| 2 | 设置接口 `handleConfigRoute(GET)` 返回 config + stats | 插件入口加载不了 |
| 3 | 记忆库 `verify()` 通过、claim 数与过期数 | 库损坏 |
| 4 | `evidence/` 可写 + 最近一次 `metrics-guard.json` 时间 | 证据链断了 |
| 5 | `host-sim --runs 5` 的 `failed` 必须为 0 | 热路径会失败 |

退出码：全绿 0；有 FAIL 1。

## 本机实跑（2026-11-02 18:58）
```
ok   插件注册 · $DSH_HOME\profiles\desktop\cordis.patch.yml · 其中 4 条 disabled:true（等 re-enable）
ok   设置接口 GET · status=200 stats={exists:true, episodes:116, claims:295}
ok   记忆库 verify · files=2169 errors=0
ok   记忆库内容 · claims=295 stale=22
ok   证据目录可写 · 最近 metrics-guard: 2026-11-02T10:45:08Z
ok   热路径抽测 · runs=5 injected=3 empty=2 failed=0 warn=0 p95=14.89ms
install-doctor: PASS
```

## 重要发现
`cordis.patch.yml` 里插件**注册了两次且都是 `disabled: true`**（历史改名/重复添加留下的两条）。
所以“没装上”的准确描述是：**已注册、被禁用**。`scripts/re-enable.mjs` 会把它们恢复；
装完请跑本脚本 + `metrics-guard` 两项作为验收。

# 冷启动演练：空 home 上跑状态摘要（2026-11-03）

## 目的
主人在空 profile 上安装时，**任何脚本都不许崩**，且"没有数据"要显示成 **N/A**，不是 **FAIL**。

## 演练（`DSH_HOME=tmp/cold-home`，只放一份 package.json，无 store、无 patch）
```
质量门：check PASS · ledger N/A（无 store） · guard N/A（无 store）
六轴：A1=null A2=null A3=0 A4=0.02 A5=null A6=null
真实会话回放（0 局）：注入 0 · 沉默 0
安装状态：设置接口 status=200 stats={exists:false,…} · 热路径抽测 runs=5 failed=0 warn=5（库不存在，沉默）
```

## 发现并修掉的一处误报
`status-digest` 初版把"无 store 时 ledger/guard 失败"直接写成 **FAIL**，在冷启动场景是**误导**。
现在：`hasStore=false` ⇒ 这两项标 **N/A（无 store）**，其它项照常。

## 预期中的两个 FAIL（不是 bug）
| 项 | 为什么 FAIL |
|---|---|
| 插件注册 | 冷 home 里没有 patch（没装）——正是"安装前"的正常状态 |
| 记忆库内容 | claims=0（还没归档过）——首次归档后自然消失 |

## 顺带改进
`install-doctor` 的热路径抽测现在会注明：`warn 为预期：库还不存在，插件沉默`（此前 warn=5 看起来像故障）。

## 结论
- 空 home 上：**不崩**、不误报、不写 `$DSH_HOME` 之外的任何东西；
- 装完之后的第一条命令就是 `node scripts/install-doctor.mjs`，它会明确告诉你还差哪一步。

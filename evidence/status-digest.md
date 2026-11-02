# 棋院 · 状态摘要（2026-11-02 19:05:57Z）
- 版本 **0.76.1** · 分支 `main` · HEAD `728ec0b R00 docs: 调研索引 00（机制对照）（0.76.1） (#145)` · 工作树 2 个改动
- 质量门：check **PASS** · ledger **PASS** · guard **PASS**
- `metrics-guard PASS · A1=0 A5=0 A6=1 A2b严格=0.8421052631578947（n=19） 覆盖=1 p50=2.01ms`
- 六轴：A1=0 · A2=0.26066350710900477 · A3=0 · A4=2.17 · A5=0 · A6=1
- 真实会话回放（12 局）：注入 12 · 沉默 0 · 跨作用域 0 · 注入 p50 15.4ms / p95 39.9ms
## 安装状态
- ok   插件注册（配置里出现包名） · $DSH_HOME\profiles\desktop\cordis.patch.yml, $DSH_HOME\storages\schedule.json · 其中 4 条 disabled:true（等 re-enable）
- ok   设置接口 GET · status=200 stats={"exists":true,"episodes":117,"claims":322,"updatedAt":1793625171995}
- ok   记忆库 verify · files=2217 errors=0
- ok   记忆库内容 · claims=322 stale=25
- ok   证据目录可写 · 最近 metrics-guard: 2026-11-02T18:38:37.072Z
- ok   热路径抽测 · runs=5 injected=3 empty=2 failed=0 warn=0 p95=15.4ms
## 待决（只能由主人拍板/动手）
- Q18=A/B（类级章节跨工作区）
- Q19=A/B/C（偏好是否收紧；开关已就绪默认关）
- 安装三步（退出 DSH → re-enable → 重开后 doctor）

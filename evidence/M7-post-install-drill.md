# 装完之后 30 秒：把"验收"先彩排一遍（2026-11-03）

## 目的
主人关一次 DSH 的成本很高。装完之后要跑什么、会看到什么，先用**假 home + 真实库副本**走一遍，
这样真装时任何一行不对，都能立刻对上号。

## 做法
```bash
rm -rf tmp/post-home && mkdir -p tmp/post-home/profiles/desktop
cp 真实 profile/package.json 与 cordis.patch.yml  → tmp/post-home/profiles/desktop/
cp -r 真实 memory-context                          → tmp/post-home/memory-context   # 真实库副本

DSH_HOME=tmp/post-home node scripts/re-enable.mjs       # 摘除 3 条禁用 + 补依赖
DSH_HOME=tmp/post-home node scripts/install-doctor.mjs
DSH_HOME=tmp/post-home node scripts/status-digest.mjs
```

## 实测输出
```
ok 插件注册 · … 未见 disabled
ok 设置接口 GET · status=200 stats={exists:true, episodes:167, claims:533}
ok 记忆库 verify · files=3607 errors=0
ok 记忆库内容 · claims=533 stale=63
ok 热路径抽测 · runs=5 injected=3 empty=2 failed=0 warn=0 p95=20.06ms
```

## 结论
1. **"未见 disabled"** 是成功启用的第一判据；
2. `re-enable` 在已禁用状态下的输出是「摘除 3 条」（不是 2 条——其中一条是旧的 id 重复项）；
3. 真实库副本上 doctor 全绿，说明**装完就能直接验收**，不需要等归档；
4. 假 home 上 `status-digest` 的 ledger/guard 会 FAIL（账本描述的是真实工作区），属预期，别当故障。

## 与真实安装的差别
- 真实安装后 `live-stats.jsonl` 会随对话出现心跳行（假 home 没有宿主，所以没有）；
- 真实安装不影响 `memory-context/` 内容（只影响插件是否加载）。

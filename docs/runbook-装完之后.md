# Runbook：装完之后按这个顺序跑（2026-11-03）

> 目标：**每一步都有期望输出**；任何一步不对，按 §5 回滚。
> 三轮彩排已过（假 home）：摘除 3 条 → 依赖/bundle 补齐 → doctor 注册 ok。

## 1. 安装（只能由人做，约 2 分钟）

```bash
# ① 退出 DSH（桌面退出/重启按钮，不要用 taskkill）
# ② 项目根目录：
node scripts/re-enable.mjs
#    期望：完成。重新打开 DSH，然后跑 node scripts/install-doctor.mjs 验收。
#    会生成 cordis.patch.yml.bak-reenable-<ts> 与 package.json.bak-reenable-<ts>
# ③ 重新打开 DSH
```

## 2. 验收（装完立刻跑）

```bash
node scripts/install-doctor.mjs
```
期望（首次归档前）：
```
ok   插件注册（配置里出现包名） · …未见 disabled
ok   设置接口 GET · status=200 stats={"exists":true,…}   # 若 exists:false 也正常，见下
ok   记忆库 verify · files=N errors=0
ok   记忆库内容 · claims=N stale=M
ok   热路径抽测 · runs=5 injected=? empty=? failed=0 warn=0
```

`exists:false` 说明库还没建：随便聊一句（触发一次 `agent/pre-step`）后再跑一次即可。

## 3. 出第一份线上证据

```bash
node scripts/m5-report.mjs --json        # 看 A3 是否从 not-live 变化
node scripts/first-live.mjs              # 首条 live 记录（存在库与日志时）
node scripts/repeat-report.mjs           # D5 二次命中遥测（首次可能为空：没有 repeat-hint.jsonl）
node scripts/status-digest.mjs --write evidence/status-digest.md
```
期望：`A3.status` 从 `not-live` 变成有值的 `measured`（或给出明确原因），`replay`/`digest` 全绿。

## 4. 日常巡检（每小时已排程）

```bash
node scripts/status-digest.mjs           # 一页看全
node scripts/metrics-guard.mjs           # 六轴门槛（A2b 掉 10pp 就红）
```

## 5. 回滚（任何一步不对）

```bash
# 用 re-enable 生成的备份原样恢复（不要手改 cordis.patch.yml）
ls "$DSH_HOME/profiles/desktop" | grep bak-reenable
cp "$DSH_HOME/profiles/desktop/cordis.patch.yml.bak-reenable-<ts>" "$DSH_HOME/profiles/desktop/cordis.patch.yml"
cp "$DSH_HOME/profiles/desktop/package.json.bak-reenable-<ts>"     "$DSH_HOME/profiles/desktop/package.json"
# 然后重新打开 DSH
```
> 库不会被删（`memory-context/` 是独立目录）；回滚只影响"插件是否加载"。

## 6. 已知的正常现象（别当故障）

| 现象 | 解释 |
|---|---|
| `warn=5`（首次） | 库还不存在，插件沉默（doctor 会注明"预期"） |
| `exists:false` | 还没归档过；聊一句后自动建库（零配置） |
| `repeat-report` 报"无台账" | 还没有二次命中；有重复失败后才出现 |
| `A3 not-live` 仍在 | 插件没被真实加载：检查 doctor 的"插件注册"那行 |

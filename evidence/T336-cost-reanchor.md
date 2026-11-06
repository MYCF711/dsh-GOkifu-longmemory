# T330 · antipattern 的 `cost`（T3 付过代价）

> `[本] 2026-11-06T10:34:53.704Z` · **只读**（不写库）· 未跑全量测试、未重启 DSH。
> 只认机械痕迹：retry / rework / interruption / steps。**判不出 ⇒ `cost: 0`（没测到，不是没代价）**。

## 0 · 一句话

**110 / 1105 条能机械判出"付过代价"（9.95%）**；其余 995 条 `cost: 0`（没测到代价）。

## 1 · 汇总

```
antipattern 1105 · 测到代价 110 · cost:0 995
痕迹分布：{"rework":71,"retry":45}
失败→恢复平均 14840.9 步
```

## 2 · 逐字对照（3 条）

### 1. `c-019a52a3`（ep-8cc34e32 seq 2320）cost=1 · rework · steps=1271

```
ok verify: OK · 文件 1281 · 字节 1950576 · 错误 0 · 告警 0 rebuild: FAIL · 派生变更 0 · 未变 0 · skipped 0
```

### 2. `c-01c643fc`（ep-00b50089 seq 9006）cost=1 · rework · steps=862

```
SyntaxError: Illegal return statement at checkSyntax (node:internal/main/check_syntax:72:5)
```

### 3. `c-03f3bbfc`（ep-8a73e06b seq 62）cost=1 · retry · steps=46779

```
total 83 drwxr-xr-x 1 WeiCong 197121 0 Nov 2 15:15 . drwxr-xr-x 1 WeiCong 197121 0 Nov 1 20:05 ..
```


## 3 · cost:0 的样本（前 5，没测到代价）

- `c-00248579` "Error: unknown job bash-49fb11d400eb4696"
- `c-008c3e04` "[notice] A new release of pip is available: 26.2.1 -> 26.2.2 [notice] To update,"
- `c-00a2178a` "Error: writing under C:/Windows/Fonts/msyh.ttc would destroy the running runtime"
- `c-00f68083` "✗ C172 「2 分钟总览」必须与 CHANGELOG / HANDOFF / live-folds.json 同步（此前无人守） ✗ C305 进度页现状摘"
- `c-0153220d` "11: * 1. `worldstate.touch(paths)` 收到的是**单个路径字符串**（engine 的 `st.touchPath`）， 30:"


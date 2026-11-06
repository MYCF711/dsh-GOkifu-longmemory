# T300 · 自动化 tombstone（删掉实现必红）

> `[本] 2026-11-06 12:20 +08:00` · 只读真库；只临时移走源码文件并**无条件恢复**。
> 产物：`scripts/tombstone-check.mjs`、`test/tombstone-check.test.mjs`、`tmp/t300-redo.cjs`

## 1 · 做法

对每个 `impl → test` 对：`fs.renameSync(impl → tmp/tombstone/*.bak)` → 跑 `node --test <test>` → 断言 exit ≠ 0 → **`finally` 无条件恢复**。

三态：**有效**（移走后红）· **无效**（移走后仍绿 ⇒ 测试没覆盖该房间）· **未验证**（测试缺失/runner 异常）。

## 2 · 测试

```
$ node --test "test/tombstone-check.test.mjs"
✔ T300 ①: 移走实现后测试红 ⇒ 判「有效」
✔ T300 ②: 移走实现后测试仍绿 ⇒ 判「无效」并报出（测试没覆盖该房间）
✔ T300 ③: 测试跑崩/抛异常时文件仍被恢复（finally 硬要求）
✔ T300 ③b: runner 抛异常（模拟进程被杀）也必须恢复
✔ T300 ④: 测试文件不存在 ⇒ 「未验证」单列（不判绿也不判红）
ℹ tests 5   ℹ pass 5   ℹ fail 0
```

## 3 · 真跑（三个房间）

```
$ node scripts/tombstone-check.mjs
| src/rooms/walk.mjs → test/walk.test.mjs       | 有效 | exit 1 |
| src/rooms/claim.mjs → test/claim.test.mjs     | 有效 | exit 1 |
| src/rooms/persist.mjs → test/persist.test.mjs | 有效 | exit 1 |
结论：全部有效
```

对照（证明这些测试本来是绿的，不是"本来就红"）：
```
$ node --test test/walk.test.mjs   → tests 34 · pass 34 · fail 0
$ node --test test/claim.test.mjs  → tests 18 · pass 18 · fail 0
```

## 4 · 源码树干净

```
$ git status --short src/
（无输出）    # 三个实现文件都已回到原位
```

## 5 · 踩到的坑（值得记）

`node --test` **嵌套**跑时，子进程继承 `NODE_TEST_CONTEXT` ⇒ 内层把结果走 IPC 回父进程，`status` 恒为 0 ⇒ **所有 tombstone 都被误判「无效」**。
修法：spawn 时 `delete env.NODE_TEST_CONTEXT`（顺带删 `NODE_OPTIONS`），让子进程是**独立**的测试运行。

## 6 · 结论

**自动化了**：`node scripts/tombstone-check.mjs` 一条命令验"删掉实现必红"，三个已登记房间全部**有效**，暂无"测试没覆盖自己房间"的情况。

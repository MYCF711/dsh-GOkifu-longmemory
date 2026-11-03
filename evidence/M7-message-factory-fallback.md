# 最后一个注入阻塞：宿主包在 asar 里，外部插件解析不到（2026-11-04 已修）

## 现象（这条才是"命中也不注入"的真因）
用真实插件入口 + 真实 store 跑宿主仿真，喂入下面这段（三条都在 A2b 冻结卷里能命中）：
```
Error: file has not been read — read the file, then retry
error: failed to push some refs to github.com
Error: cannot find module 'x'
```
结果：`kind=enter`，但 **messages 没增加**，并 warn：
```
注入失败（继续本轮）：Cannot find package '@deepseek-ai/dsh-llm' imported from …\src\plugin.mjs
```

## 根因
插件用 `await import('@deepseek-ai/dsh-llm')` 造注入消息；这个包只存在于 **宿主 asar 内部**，
外部插件按自己的文件路径（仓库目录）解析不到 —— 于是"命中→建卡→过闸"都走通了，**最后一步造消息失败**，静默沉默。

## 修法（不碰 asar、不新增依赖）
1. 先试宿主包；解析不到就用**本地等价工厂** `makeUserMessageFallback`；
2. 形状逐字段对齐宿主源码（在 asar 里读到的实现）：
   `createUserMessage(input) = createMessage({...input, role:'user'})`，
   `createMessage = deepFreeze(structuredClone({...input, id: randomUUID()}))`；
3. 新增单测断言：`role='user'`、`id` 是 uuid、`content` 透传、`source` 保留、对象与数组都冻结。

## 验证（仿真，真实库）
```
kind: enter · msgs: 2
0 user null hi
1 user {"kind":"dsh-gokifu-longmemory","form":"memory-card","digest":"160ea23331a6bc06"} [object Object]
```
即：注入消息已带 `source.kind=dsh-gokifu-longmemory`，位置在 claimed 消息之后。

## 顺带修掉的取证污染
仿真会往真实 `live-stats.jsonl` 写心跳（`src:"sim-inject.mjs"`）。已把统计口径收紧：
- `m5` 的 A3 只统计 **`src=index.js`**（宿主写入）的行；
- 首注入守望同样只认 `src=index.js`。
当前 3 条 `src:sim-inject.mjs` 的 `inject` 行是仿真产生的，**不算线上注入**。

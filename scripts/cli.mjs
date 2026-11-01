#!/usr/bin/env node
// R14 cli 的命令行入口：薄封装，逻辑全在 src/rooms/cli.mjs（可独立单测）。
//
//   node scripts/cli.mjs stats [--root <dir>] [--json]
//   node scripts/cli.mjs dump <sid> [--root <dir>]
//   node scripts/cli.mjs walk <term> [--root <dir>] [--limit <n>] [--json]
//   node scripts/cli.mjs index [--root <dir>]
//
// 只读：不写 <DSH_HOME>，不写会话日志，不建 sidecar。

import { main } from '../src/rooms/cli.mjs';

const code = await main(process.argv.slice(2));
process.exitCode = code;

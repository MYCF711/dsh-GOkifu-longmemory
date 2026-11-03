// kifu-loader：把棋院插件换个包名挂进 profile。
// 原因（2026-11-03）：cordis.patch.yml 里有两块历史遗留的 disabled:true（dsh-gokifu-longmemory），
// 那两块会让同名包被禁用；改包名不需要动热重载开关，重启即生效。
export * from '../../src/plugin.mjs';
export { default } from '../../src/plugin.mjs';

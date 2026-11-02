@echo off
chcp 65001 >nul
title 棋院 · 开启长期记忆插件
echo ============================================
echo  ⚠ 请先在 DSH 里用「退出/重启」把应用**完全关掉**
echo     （本窗口开着、DSH 也开着时不要继续）
echo ============================================
echo.
pause
cd /d "%~dp0"
echo [1/2] 检查 node ...
where node >nul 2>nul || (echo 找不到 node.exe，请先装 Node.js & pause & exit /b 1)
echo [2/2] 执行 re-enable（会备份 cordis.patch.yml 与 package.json）...
node scripts\re-enable.mjs
if errorlevel 1 (
  echo.
  echo 失败：请把上面的报错整段截图/复制给 lead。
  pause
  exit /b 1
)
echo.
echo 完成。现在重新打开 DSH，然后在本目录跑：
echo    node scripts\install-doctor.mjs
echo 期望看到「ok 插件注册 … 未见 disabled」。
pause

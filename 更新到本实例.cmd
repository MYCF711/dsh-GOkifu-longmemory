@echo off
chcp 65001 >nul
title Kifu-in update (safe, read-only)
echo ============================================
echo  Kifu-in · 更新到本实例
echo.
echo  这一步只做「自检」，不改任何文件：
echo  插件是指向本工作区的软链，所以
echo  「完全退出 DSH 再打开」就是更新本身。
echo ============================================
echo.
cd /d "%~dp0."
where node >nul 2>nul
if errorlevel 1 (
  echo FAILED: node.exe not found. Install Node.js first.
  pause
  exit /b 1
)
echo [1/2] 自检
node "scripts/instance-status.mjs"
if errorlevel 1 (
  echo.
  echo 自检没全过，先按上面的 FAIL 行处理，别急着重启。
  pause
  exit /b 1
)
echo.
echo [2/2] 仓库闸（只读检查，不改文件）
node "scripts/check.mjs"
if errorlevel 1 (
  echo.
  echo FAILED: 仓库闸没过。工作区状态没被改动，DSH 照常可用。
  pause
  exit /b 1
)
echo.
echo ============================================
echo  OK: 可以重启了。
echo  1) 完全退出 DSH（退出应用，不是关窗口）
echo  2) 重新打开
echo  新代码即生效。
echo ============================================
pause
exit /b 0

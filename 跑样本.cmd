@echo off
chcp 65001 >nul
title Kifu-in ablation samples (sandboxed)
echo ============================================
echo  Kifu-in · 跑样本（沙箱，不碰主工作树）
echo.
echo  它做三件事，全都在 tmp\sandbox\ 里：
echo   1) 建一个仓库的一次性副本
echo   2) 在副本里跑 A/B（有记忆 / 无记忆）
echo   3) 出分并写 evidence\T353-ablation-report.md
echo.
echo  主工作树、主记忆库、正在跑的 DSH 都不会被改动。
echo  中途关掉也没事，删掉 tmp\sandbox\ 就等于没跑过。
echo ============================================
echo.
cd /d "%~dp0."
where node >nul 2>nul
if errorlevel 1 (
  echo FAILED: node.exe not found. Install Node.js first.
  pause
  exit /b 1
)

set PAIRS=%1
if "%PAIRS%"=="" set PAIRS=12
set LIMIT=%2
if "%LIMIT%"=="" set LIMIT=600

echo [1/3] 建副本 + 出题（约 10 秒）
node "scripts/ablation-sandbox.mjs" --prepare --n 40
if errorlevel 1 (
  echo FAILED: 建副本失败。什么都没改，DSH 照常可用。
  pause
  exit /b 1
)
echo.
echo [2/3] 跑 A/B：%PAIRS% 题 x 2 臂，单次上限 %LIMIT% 秒
echo      （每题两臂，慢的话可能跑一两个小时，让它跑就行）
node "scripts/ablation-sandbox.mjs" --run --max-pairs %PAIRS% --limit %LIMIT%
echo.
echo [3/3] 出分
node "scripts/ablation-sandbox.mjs" --report
echo.
echo ============================================
echo  结果在 evidence\T353-ablation-report.md
echo  判定读法：
echo    显著偏向「记忆有用」   = 记忆起作用了
echo    未达显著               = 样本还不够，明天接着攒
echo    两臂都没复发           = 是题不复现失败，不是记忆没用
echo ============================================
pause
exit /b 0

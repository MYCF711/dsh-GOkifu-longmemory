@echo off
chcp 65001 >nul
title Kifu-in enable (safe)
echo ============================================
echo  1) FULLY QUIT DSH first (quit the app, do not just close the window)
echo  2) Then run this file
echo  It refuses to touch anything while DSH is running.
echo ============================================
echo.
pause
cd /d "%~dp0."
where node >nul 2>nul
if errorlevel 1 (
  echo node.exe not found. Install Node.js first.
  pause
  exit /b 1
)
node "scripts/re-enable.mjs"
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" echo OK: plugin enabled. You can reopen DSH now.
if "%RC%"=="2" echo SKIPPED: DSH is still running. Nothing was changed. Quit DSH and run again.
if "%RC%"=="1" echo FAILED: changes were rolled back. DSH config is unchanged and safe.
echo.
pause
exit /b %RC%

@echo off
title Kifu-in enable
echo ============================================
echo  Please FULLY QUIT DSH first (quit/restart in app).
echo  Do NOT continue while DSH is still running.
echo ============================================
echo.
pause
cd /d "%~dp0."
echo [1/2] checking node ...
where node >nul 2>nul
if errorlevel 1 (
  echo node.exe not found. Install Node.js first.
  pause
  exit /b 1
)
echo [2/2] running re-enable (backups patch + package.json) ...
node "scripts/re-enable.mjs"
if errorlevel 1 (
  echo.
  echo FAILED. Copy this window text to lead.
  pause
  exit /b 1
)
echo.
echo DONE. Reopen DSH, then run: node "scripts/install-doctor.mjs"
echo Expect the disabled line to become: no disabled
pause

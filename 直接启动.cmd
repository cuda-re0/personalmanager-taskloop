@echo off
rem ============================================================
rem  taskloop launcher - starts the EXISTING build (no rebuild).
rem  Use this after you already built once and changed nothing.
rem  If the UI looks old, use the build launcher instead.
rem ============================================================
setlocal
title taskloop - start (no build)
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"

if not exist "out\main\index.js" (
  echo No build found. Use the other launcher ^(the one that builds^) first.
  echo.
  pause
  exit /b 1
)

for /f %%i in ('git rev-parse --short HEAD 2^>nul') do set "SHA=%%i"
echo starting...   HEAD=%SHA%
echo   build timestamp is the "modified" time of out\main\index.js
echo.
call "node_modules\.bin\electron.cmd" .
if errorlevel 1 pause
exit /b 0

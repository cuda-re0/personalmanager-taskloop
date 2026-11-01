@echo off
rem ============================================================
rem  taskloop launcher - ALWAYS builds, then starts the app.
rem  Double-click this file. Takes about 15 seconds to build.
rem  Single-instance lock is on: re-launching brings the existing main window up.
rem ============================================================
setlocal
title taskloop - build and start
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"

echo [1/3] checking dependencies...
if not exist "node_modules\electron\package.json" (
  call npm install
  if errorlevel 1 goto fail
)

echo [2/3] building...
call npm run build
if errorlevel 1 goto fail

for /f %%i in ('git rev-parse --short HEAD 2^>nul') do set "SHA=%%i"
echo [3/3] starting...   HEAD=%SHA%
echo.
echo   Keep this window open while using the app.
echo.
call "node_modules\.bin\electron.cmd" .
if errorlevel 1 goto fail
exit /b 0

:fail
echo.
echo [taskloop] FAILED - read the error above.
echo.
pause
exit /b 1

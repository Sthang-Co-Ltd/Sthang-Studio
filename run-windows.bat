@echo off
setlocal
cd /d "%~dp0"
title Sthang Studio

REM Keep the desktop branding in sync after manual installs and signed updates.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ensure-shortcut.ps1" >nul 2>nul

echo.
echo === Sthang Studio ===
echo Captions workspace: fast review, precise timing and CapCut SRT.
echo Install folder: "%CD%"
echo.

where node >nul 2>nul || (
  echo ERROR: Node.js was not found.
  echo Run INSTALL-NEW-PC.bat to finish setup.
  pause
  exit /b 1
)

if not exist "scripts\launch-studio.ps1" (
  echo ERROR: The Sthang Studio launcher is incomplete.
  echo Run the current manual Windows installer to repair it.
  pause
  exit /b 1
)

echo AI connection: configure anytime inside Settings ^> AI connection.
echo Starting local Studio services. Keep this window open while using the app.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-studio.ps1"
set "EXITCODE=%errorlevel%"

REM Exit code 42 means the stable broker handed control to a verified new version.
if "%EXITCODE%"=="42" exit /b 0

echo.
echo ============================================================
echo Sthang Studio stopped. Exit code: %EXITCODE%
echo If you did not intentionally stop it, copy the safe error above.
echo ============================================================
pause
exit /b %EXITCODE%

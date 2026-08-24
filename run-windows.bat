@echo off
setlocal
cd /d "%~dp0"
title Sthang Studio

REM Keep the desktop branding in sync after upgrades.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ensure-shortcut.ps1" >nul 2>nul

echo.
echo === Sthang Studio ===
echo Captions workspace: fast review, precise timing and CapCut SRT.
echo Project folder: "%CD%"
echo.

where node >nul 2>nul || (
  echo ERROR: Node.js was not found.
  echo Run INSTALL-NEW-PC.bat to finish setup.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo ERROR: Sthang Studio setup is not finished.
  echo Run INSTALL-NEW-PC.bat, then launch Sthang Studio again.
  pause
  exit /b 1
)

if not exist "apps\server\.env" (
  echo Creating optional local settings file...
  copy ".env.example" "apps\server\.env" >nul
)

if not exist ".venv\Scripts\python.exe" (
  echo ERROR: Local caption timing is not installed yet.
  echo Run INSTALL-NEW-PC.bat to finish setup, then launch Sthang Studio again.
  pause
  exit /b 1
)

echo AI connection: configure anytime inside Settings ^> AI connection.
echo.
echo Starting backend on http://localhost:8787
echo Starting web app on http://localhost:5188
echo Caption timing: local and ready after setup.
echo IMPORTANT: Keep this window OPEN while using the app.
echo.
echo First caption generation may take longer while timing resources are prepared.
echo This launcher avoids node_modules\.bin shims so paths containing ^& work.
echo.

node "scripts\dev.mjs"
set EXITCODE=%errorlevel%
echo.
echo ============================================================
echo Sthang Studio stopped. Exit code: %EXITCODE%
echo If you did not intentionally stop it, copy the error above.
echo ============================================================
pause
exit /b %EXITCODE%

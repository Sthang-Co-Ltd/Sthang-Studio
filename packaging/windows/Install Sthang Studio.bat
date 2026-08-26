@echo off
setlocal
cd /d "%~dp0"
title Sthang Studio Setup

set "STHANG_FILES=%~dp0Sthang Studio Files"
set "STHANG_INSTALLER=%STHANG_FILES%\scripts\install-release-package.ps1"

if not exist "%STHANG_INSTALLER%" (
  echo.
  echo Sthang Studio setup files are missing.
  echo Extract the entire downloaded ZIP first, then run Install Sthang Studio.bat again.
  echo.
  pause
  exit /b 1
)

echo.
echo === Sthang Studio Setup ===
echo Preparing Sthang Studio for this Windows user...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%STHANG_INSTALLER%" -SourceRoot "%STHANG_FILES%"
set "EXITCODE=%errorlevel%"

if not "%EXITCODE%"=="0" (
  echo.
  echo Sthang Studio setup did not finish successfully.
  echo Keep this window open and use the message above to retry.
  pause
)

exit /b %EXITCODE%

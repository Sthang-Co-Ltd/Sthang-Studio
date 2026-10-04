@echo off
setlocal
cd /d "%~dp0"
title Sthang Studio - Local Timing Setup
set "PYTHONUTF8=1"
set "ORT_DISABLE_TELEMETRY=1"
set "HF_HUB_DISABLE_TELEMETRY=1"
set "DO_NOT_TRACK=1"
echo Preparing reviewed local timing dependencies safely...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-local-timing-windows.ps1"
set "SETUP_EXIT=%ERRORLEVEL%"
REM The immutable provisioner validates every candidate; OTA also rechecks the
REM cached model without permitting an import-triggered download.
if not "%SETUP_EXIT%"=="0" goto :finish
if "%KCS_REQUIRE_KFA%"=="1" (
  ".venv\Scripts\python.exe" "scripts\check-windows-timing.py"
  if errorlevel 1 exit /b 1
)
:finish
if not "%KCS_NONINTERACTIVE%"=="1" pause
exit /b %SETUP_EXIT%

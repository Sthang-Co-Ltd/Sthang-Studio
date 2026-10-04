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
if not "%KCS_NONINTERACTIVE%"=="1" pause
exit /b %SETUP_EXIT%

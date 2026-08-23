@echo off
setlocal
cd /d "%~dp0"
title Sthang Studio - New PC Installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-new-pc.ps1"
set EXITCODE=%errorlevel%
echo.
if not "%EXITCODE%"=="0" echo Installer stopped with exit code %EXITCODE%.
pause
exit /b %EXITCODE%

@echo off
setlocal
cd /d "%~dp0"
title Stop Sthang Studio

echo.
echo This will stop process trees currently listening on ports 8787 and 5188.
echo Use it only when an older Sthang Studio window was closed but the ports stayed occupied.
echo.
choice /M "Continue"
if errorlevel 2 exit /b 0

set FOUND=0
for %%P in (8787 5188) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr /R /C:":%%P .*LISTENING"') do (
    set FOUND=1
    echo Stopping PID %%A on port %%P...
    taskkill /PID %%A /T /F >nul 2>nul
  )
)

echo.
if "%FOUND%"=="0" (
  echo No listening process was found on ports 8787 or 5188.
) else (
  echo Done. You can run run-windows.bat again.
)
pause

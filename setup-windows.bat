@echo off
setlocal
cd /d "%~dp0"
title Sthang Studio Setup

echo.
echo === Sthang Studio setup v0.7.10 ===
where node >nul 2>nul || (echo ERROR: Node.js is not installed. Install Node.js, then run this again.& if not "%KCS_NONINTERACTIVE%"=="1" pause & exit /b 1)
where npm >nul 2>nul || (echo ERROR: npm was not found.& if not "%KCS_NONINTERACTIVE%"=="1" pause & exit /b 1)
if not exist "apps\server\.env" copy ".env.example" "apps\server\.env" >nul

echo Node:
node --version
echo npm:
call npm --version

echo.
echo Checking FFmpeg...
where ffmpeg >nul 2>nul || (
  echo WARNING: ffmpeg was not found on PATH.
  echo Install FFmpeg before generating captions, or set FFMPEG_PATH in apps\server\.env.
)
where ffprobe >nul 2>nul || (
  echo WARNING: ffprobe was not found on PATH.
  echo Install FFmpeg before generating captions, or set FFPROBE_PATH in apps\server\.env.
)

echo.
echo Installing Node dependencies...
call npm install
if errorlevel 1 (echo ERROR: npm install failed.& if not "%KCS_NONINTERACTIVE%"=="1" pause & exit /b 1)

echo.
echo Building shared caption package...
REM Invoke TypeScript through Node directly so paths containing ^& remain safe.
node "node_modules\typescript\bin\tsc" -p "packages\shared\tsconfig.json"
if errorlevel 1 (echo ERROR: shared package build failed.& if not "%KCS_NONINTERACTIVE%"=="1" pause & exit /b 1)

echo.
echo Verifying server and web TypeScript...
node "scripts\typecheck.mjs"
if errorlevel 1 (echo ERROR: application typecheck failed.& if not "%KCS_NONINTERACTIVE%"=="1" pause & exit /b 1)

echo.
echo Core app setup complete.
echo Now setting up the FREE local timing engine...
call "setup-local-timing-windows.bat"
if errorlevel 1 (
  echo.
  echo Core app installed, but local timing setup did not finish.
  echo Fix the Python error above, then run setup-local-timing-windows.bat again.
  if not "%KCS_NONINTERACTIVE%"=="1" pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ensure-shortcut.ps1" >nul 2>nul

echo.
echo ============================================================
echo Sthang Studio setup complete.
echo.
echo 1. Run run-windows.bat or use the Sthang Studio desktop shortcut
 echo 2. Open Settings ^> AI connection and paste your Gemini API key
 echo 3. The app opens at http://localhost:5188
 echo ============================================================
if not "%KCS_NONINTERACTIVE%"=="1" pause

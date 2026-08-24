$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host ""
Write-Host "=== Sthang Studio - New PC Installer ===" -ForegroundColor Cyan
Write-Host "This checks Node.js LTS, Python 3.12 and FFmpeg, then sets up the app and local caption timing." -ForegroundColor DarkGray
Write-Host "The first timing setup may download a Khmer alignment model (roughly a few hundred MB)." -ForegroundColor DarkGray

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Ensure-WingetPackage([string]$Command, [string]$PackageId, [string]$Label, [scriptblock]$Verifier) {
  if (& $Verifier) {
    Write-Host "[OK] $Label already available." -ForegroundColor Green
    return
  }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "$Label is missing and WinGet is unavailable. Install $Label manually, then run INSTALL-NEW-PC.bat again."
  }
  Write-Host "Installing $Label..." -ForegroundColor Yellow
  winget install --id $PackageId -e --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "$Label installation failed." }
  Refresh-Path
  if (-not (& $Verifier)) { throw "$Label was installed but is not visible yet. Restart Windows or reopen this installer." }
}

Ensure-WingetPackage 'node' 'OpenJS.NodeJS.LTS' 'Node.js LTS' { [bool](Get-Command node -ErrorAction SilentlyContinue) }
Ensure-WingetPackage 'py' 'Python.Python.3.12' 'Python 3.12' { try { py -3.12 --version *> $null; $LASTEXITCODE -eq 0 } catch { $false } }
Ensure-WingetPackage 'ffmpeg' 'Gyan.FFmpeg' 'FFmpeg' { [bool](Get-Command ffmpeg -ErrorAction SilentlyContinue) }

Write-Host ""
Write-Host "Running Sthang Studio setup..." -ForegroundColor Cyan
$env:KCS_NONINTERACTIVE = '1'
cmd /c "`"$Root\setup-windows.bat`""
if ($LASTEXITCODE -ne 0) { throw 'Sthang Studio setup did not finish. Fix the error above, then run INSTALL-NEW-PC.bat again.' }

Write-Host ""
Write-Host "AI setup happens inside the app: Settings > AI connection." -ForegroundColor Cyan

try {
  & (Join-Path $Root 'scripts\ensure-shortcut.ps1')
  Write-Host "[OK] Desktop shortcut created/updated: Sthang Studio" -ForegroundColor Green
} catch {
  Write-Host "Desktop shortcut could not be created, but the app is installed." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Installation complete." -ForegroundColor Green
Write-Host "Double-click Sthang Studio on the desktop or run run-windows.bat. Then open Settings > AI connection and paste your Gemini key."

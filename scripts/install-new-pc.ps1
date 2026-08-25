$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$LocalBase = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:USERPROFILE }
$ToolsRoot = Join-Path $LocalBase 'Sthang Studio\tools'
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) 'Sthang-Studio-Install'
New-Item -ItemType Directory -Path $ToolsRoot -Force | Out-Null
New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null

Write-Host ""
Write-Host "=== Sthang Studio - New PC Installer ===" -ForegroundColor Cyan
Write-Host "This checks Node.js, Python and FFmpeg, then sets up the app and local caption timing." -ForegroundColor DarkGray
Write-Host "The first timing setup may download a Khmer alignment model (roughly a few hundred MB)." -ForegroundColor DarkGray

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Add-UserPath([string]$PathToAdd) {
  if (-not (Test-Path $PathToAdd)) { throw "Cannot add missing path: $PathToAdd" }

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @()
  if ($userPath) {
    $entries = @($userPath -split ';' | Where-Object { $_ -and $_.Trim() })
  }
  $alreadyPresent = $false
  foreach ($entry in $entries) {
    if ([string]::Equals($entry.TrimEnd('\'), $PathToAdd.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
      $alreadyPresent = $true
      break
    }
  }
  if (-not $alreadyPresent) {
    $newUserPath = if ($userPath) { "$userPath;$PathToAdd" } else { $PathToAdd }
    [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
  }

  $sessionEntries = @($env:Path -split ';' | Where-Object { $_ -and $_.Trim() })
  $sessionPresent = $false
  foreach ($entry in $sessionEntries) {
    if ([string]::Equals($entry.TrimEnd('\'), $PathToAdd.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
      $sessionPresent = $true
      break
    }
  }
  if (-not $sessionPresent) {
    $env:Path = "$PathToAdd;$env:Path"
  }
}

function Download-File([string]$Url, [string]$Destination, [string]$Label) {
  Write-Host "Downloading $Label..." -ForegroundColor Yellow
  if (Test-Path $Destination) { Remove-Item $Destination -Force -ErrorAction SilentlyContinue }

  try {
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
      Write-Host "Download progress:" -ForegroundColor DarkGray
      & $curl.Source --fail --location --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 1800 --output $Destination $Url
      $curlExit = $LASTEXITCODE
      if ($curlExit -ne 0) { throw "download command exited with code $curlExit" }
    } else {
      Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -TimeoutSec 1800
    }
  } catch {
    if (Test-Path $Destination) { Remove-Item $Destination -Force -ErrorAction SilentlyContinue }
    throw "Could not download $Label within 30 minutes. Check your internet connection and run INSTALL-NEW-PC.bat again. ($Url)"
  }

  if (-not (Test-Path $Destination) -or (Get-Item $Destination).Length -le 0) {
    throw "$Label download was empty or incomplete. Run INSTALL-NEW-PC.bat again."
  }

  $sizeMb = [math]::Round((Get-Item $Destination).Length / 1MB, 1)
  Write-Host "[OK] $Label downloaded ($sizeMb MB)." -ForegroundColor Green
}

function Test-Node {
  try {
    $node = Get-Command node -ErrorAction Stop
    & $node.Source -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Test-Python312 {
  try {
    if (Get-Command py -ErrorAction SilentlyContinue) {
      py -3.12 -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)" *> $null
      if ($LASTEXITCODE -eq 0) { return $true }
    }
  } catch { }
  try {
    if (Get-Command python -ErrorAction SilentlyContinue) {
      python -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)" *> $null
      if ($LASTEXITCODE -eq 0) { return $true }
    }
  } catch { }
  return $false
}

function Test-FFmpeg {
  return [bool](Get-Command ffmpeg -ErrorAction SilentlyContinue) -and [bool](Get-Command ffprobe -ErrorAction SilentlyContinue)
}

function Try-WingetPackage([string]$PackageId, [string]$Label, [scriptblock]$Verifier) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { return $false }

  Write-Host "Installing $Label with WinGet..." -ForegroundColor Yellow
  winget install --id $PackageId -e --accept-package-agreements --accept-source-agreements | Out-Host
  $wingetExit = $LASTEXITCODE
  if ($wingetExit -eq 0) {
    Refresh-Path
    if (& $Verifier) {
      Write-Host "[OK] $Label installed with WinGet." -ForegroundColor Green
      return $true
    }
  }

  Write-Host "WinGet could not finish $Label setup. Trying the direct fallback instead..." -ForegroundColor Yellow
  return $false
}

function Install-NodeFallback {
  $version = '22.22.0'
  $archiveName = "node-v$version-win-x64.zip"
  $archive = Join-Path $TempRoot $archiveName
  $sums = Join-Path $TempRoot "node-v$version-SHASUMS256.txt"
  $target = Join-Path $ToolsRoot "node-v$version-win-x64"

  if (-not (Test-Path (Join-Path $target 'node.exe'))) {
    Download-File "https://nodejs.org/dist/v$version/$archiveName" $archive "Node.js LTS $version"
    Download-File "https://nodejs.org/dist/v$version/SHASUMS256.txt" $sums "Node.js checksum"

    $escaped = [regex]::Escape($archiveName)
    $line = Get-Content $sums | Where-Object { $_ -match "$escaped$" } | Select-Object -First 1
    if (-not $line) { throw "Could not verify the Node.js download checksum." }
    $expected = (($line -split '\s+')[0]).ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "Node.js download checksum did not match. Delete the installer download and try again." }

    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
    Expand-Archive -Path $archive -DestinationPath $ToolsRoot -Force
  }

  Add-UserPath $target
  if (-not (Test-Node)) { throw "Node.js direct setup did not finish correctly." }
  Write-Host "[OK] Node.js LTS ready (direct per-user setup)." -ForegroundColor Green
}

function Install-PythonFallback {
  $version = '3.12.10'
  $installer = Join-Path $TempRoot "python-$version-amd64.exe"
  $target = Join-Path $ToolsRoot "python-$version"
  $pythonExe = Join-Path $target 'python.exe'

  if (-not (Test-Path $pythonExe)) {
    Download-File "https://www.python.org/ftp/python/$version/python-$version-amd64.exe" $installer "Python $version"
    if ((Get-Item $installer).Length -lt 5000000) { throw "Python installer download looks incomplete." }

    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
    Write-Host "Installing Python $version for this Windows user..." -ForegroundColor Yellow
    Write-Host "This can take several minutes in Windows Sandbox. Keep this window open." -ForegroundColor DarkGray
    $pythonLog = Join-Path $TempRoot "python-$version-install.log"
    $pythonArgs = @(
      '/quiet',
      "/log `"$pythonLog`"",
      'InstallAllUsers=0',
      'InstallLauncherAllUsers=0',
      "TargetDir=`"$target`"",
      'PrependPath=0',
      'Include_launcher=0',
      'Include_test=0',
      'Include_doc=0',
      'Shortcuts=0',
      'Include_tcltk=0',
      'Include_pip=1',
      'Include_dev=1',
      'Include_exe=1',
      'Include_lib=1',
      'Include_tools=1'
    )
    $pythonProcess = Start-Process -FilePath $installer -ArgumentList ($pythonArgs -join ' ') -Wait -PassThru
    $pythonExit = $pythonProcess.ExitCode
    if ($pythonExit -ne 0) {
      throw "Python $version direct setup failed with exit code $pythonExit. Installer log: $pythonLog"
    }

    if (-not (Test-Path $pythonExe)) {
      $defaultPythonExe = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
      if (Test-Path $defaultPythonExe) {
        $pythonExe = $defaultPythonExe
        $target = Split-Path -Parent $pythonExe
      } else {
        throw "Python $version installer reported success but python.exe was not found. Installer log: $pythonLog"
      }
    }
  }

  Add-UserPath $target
  $scripts = Join-Path $target 'Scripts'
  if (Test-Path $scripts) { Add-UserPath $scripts }
  & $pythonExe -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)" *> $null
  if ($LASTEXITCODE -ne 0) { throw "Python 3.12 direct setup did not finish correctly." }
  Write-Host "[OK] Python 3.12 ready (direct per-user setup)." -ForegroundColor Green
}

function Install-FFmpegFallback {
  $version = '8.1.2'
  $archiveName = "ffmpeg-$version-essentials_build.zip"
  $archive = Join-Path $TempRoot $archiveName
  $target = Join-Path $ToolsRoot 'ffmpeg'
  $expectedSha256 = 'db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec'
  $ffmpegExe = $null

  if (Test-Path $target) {
    $ffmpegExe = Get-ChildItem -Path $target -Filter ffmpeg.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  }

  if (-not $ffmpegExe) {
    Download-File "https://github.com/GyanD/codexffmpeg/releases/download/$version/$archiveName" $archive "FFmpeg $version essentials build"

    $actual = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
    if ($actual -ne $expectedSha256) { throw "FFmpeg download checksum did not match. Delete the installer download and try again." }

    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Expand-Archive -Path $archive -DestinationPath $target -Force
    $ffmpegExe = Get-ChildItem -Path $target -Filter ffmpeg.exe -File -Recurse | Select-Object -First 1
  }

  if (-not $ffmpegExe) { throw "FFmpeg direct setup did not contain ffmpeg.exe." }
  $bin = Split-Path -Parent $ffmpegExe.FullName
  if (-not (Test-Path (Join-Path $bin 'ffprobe.exe'))) { throw "FFmpeg direct setup did not contain ffprobe.exe." }
  Add-UserPath $bin
  if (-not (Test-FFmpeg)) { throw "FFmpeg direct setup did not finish correctly." }
  Write-Host "[OK] FFmpeg + ffprobe ready (direct per-user setup)." -ForegroundColor Green
}

function Ensure-Node {
  if (Test-Node) {
    Write-Host "[OK] Node.js already available." -ForegroundColor Green
    return
  }
  if (Try-WingetPackage 'OpenJS.NodeJS.LTS' 'Node.js LTS' { Test-Node }) { return }
  Install-NodeFallback
}

function Ensure-Python {
  if (Test-Python312) {
    Write-Host "[OK] Python 3.12 already available." -ForegroundColor Green
    return
  }
  if (Try-WingetPackage 'Python.Python.3.12' 'Python 3.12' { Test-Python312 }) { return }
  Install-PythonFallback
}

function Ensure-FFmpeg {
  if (Test-FFmpeg) {
    Write-Host "[OK] FFmpeg already available." -ForegroundColor Green
    return
  }
  if (Try-WingetPackage 'Gyan.FFmpeg' 'FFmpeg' { Test-FFmpeg }) { return }
  Install-FFmpegFallback
}

try {
  if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw "The current Sthang Studio Windows installer supports x64 Windows only. Detected architecture: $($env:PROCESSOR_ARCHITECTURE)."
  }

  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host "WinGet is not available. That's okay - using direct per-user downloads instead." -ForegroundColor Yellow
  }

  Ensure-Node
  Ensure-Python
  Ensure-FFmpeg

  Write-Host ""
  Write-Host "Running Sthang Studio setup..." -ForegroundColor Cyan
  $env:KCS_NONINTERACTIVE = '1'
  cmd /c "`"$Root\setup-windows.bat`""
  if ($LASTEXITCODE -ne 0) { throw 'Sthang Studio setup did not finish.' }

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
  exit 0
} catch {
  Write-Host ""
  Write-Host "Sthang Studio installation could not finish." -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Yellow
  Write-Host "Fix the message above, then run INSTALL-NEW-PC.bat again. Your existing Sthang Studio files were not deleted." -ForegroundColor DarkGray
  exit 1
}

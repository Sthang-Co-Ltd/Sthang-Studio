param(
  [Parameter(Mandatory = $true)]
  [string]$SourceRoot
)

$ErrorActionPreference = 'Stop'
$InstallRoot = $null
$ServerEnv = $null
$ServerEnvBackup = $null
$HadServerEnv = $false

function Copy-SourceTree([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
    Copy-Item -LiteralPath $item.FullName -Destination $Destination -Recurse -Force
  }
}

try {
  $SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
  if (-not $env:LOCALAPPDATA) {
    throw 'Windows local app storage could not be located for this user.'
  }

  $InstallRoot = Join-Path $env:LOCALAPPDATA 'Sthang Studio\app'
  if ([string]::Equals(
      $SourceRoot.TrimEnd('\'),
      $InstallRoot.TrimEnd('\'),
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw 'Run this installer from the extracted release package, not from the installed Sthang Studio app folder.'
  }

  $ServerEnv = Join-Path $InstallRoot 'apps\server\.env'
  $ServerEnvBackup = Join-Path ([IO.Path]::GetTempPath()) ('Sthang-Studio-env-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  $HadServerEnv = Test-Path -LiteralPath $ServerEnv

  Write-Host ''
  Write-Host 'Installing Sthang Studio into your Windows user profile...' -ForegroundColor Cyan
  Write-Host $InstallRoot -ForegroundColor DarkGray

  if ($HadServerEnv) {
    Copy-Item -LiteralPath $ServerEnv -Destination $ServerEnvBackup -Force
  }

  # Refresh only packaged application source. Runtime/user state intentionally
  # remains untouched: data, uploads, exports, node_modules and .venv all live
  # outside these source directories. The optional advanced .env file is backed
  # up separately and restored even if source refresh fails partway through.
  foreach ($name in @('apps', 'packages', 'local-timing', 'scripts', 'config')) {
    $path = Join-Path $InstallRoot $name
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Recurse -Force
    }
  }

  Copy-SourceTree $SourceRoot $InstallRoot

  if ($HadServerEnv -and (Test-Path -LiteralPath $ServerEnvBackup)) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $ServerEnv) -Force | Out-Null
    Copy-Item -LiteralPath $ServerEnvBackup -Destination $ServerEnv -Force
  }

  $Installer = Join-Path $InstallRoot 'INSTALL-NEW-PC.bat'
  if (-not (Test-Path -LiteralPath $Installer)) {
    throw 'The packaged Sthang Studio installer is incomplete.'
  }

  Write-Host ''
  Write-Host 'Application files are ready. Starting Windows setup...' -ForegroundColor Cyan
  & $env:ComSpec /d /c "`"$Installer`""
  $ExitCode = $LASTEXITCODE
  if ($ExitCode -ne 0) {
    throw "Sthang Studio setup stopped with exit code $ExitCode."
  }

  # A deliberate manual install is also the recovery path. Only after the new
  # root source and dependencies are known-good, clear OTA activation state so
  # the desktop shortcut launches this manually installed version next time.
  $UpdateRoot = Join-Path $InstallRoot 'updates'
  foreach ($StateFile in @('active.json', 'transaction.json', 'pending-install.json', 'rollback.json', 'last-failure.json')) {
    $StatePath = Join-Path $UpdateRoot $StateFile
    if (Test-Path -LiteralPath $StatePath) {
      Remove-Item -LiteralPath $StatePath -Force
    }
  }
  if (Test-Path -LiteralPath (Join-Path $UpdateRoot 'active.json')) {
    throw 'The manual installation finished, but the previous OTA activation pointer could not be cleared. Close Studio and run this installer again.'
  }

  Write-Host ''
  Write-Host 'Sthang Studio is installed.' -ForegroundColor Green
  Write-Host 'You can delete the downloaded setup folder now. Use the Sthang Studio desktop shortcut to launch the app.' -ForegroundColor DarkGray
  exit 0
} catch {
  Write-Host ''
  Write-Host 'Sthang Studio installation could not finish.' -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Yellow
  exit 1
} finally {
  if ($HadServerEnv -and $ServerEnvBackup -and (Test-Path -LiteralPath $ServerEnvBackup)) {
    if ($ServerEnv) {
      try {
        New-Item -ItemType Directory -Path (Split-Path -Parent $ServerEnv) -Force | Out-Null
        Copy-Item -LiteralPath $ServerEnvBackup -Destination $ServerEnv -Force
      } catch { }
    }
    Remove-Item -LiteralPath $ServerEnvBackup -Force -ErrorAction SilentlyContinue
  }
}

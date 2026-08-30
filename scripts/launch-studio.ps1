param()
$ErrorActionPreference = 'Stop'
$InstallRoot = Split-Path -Parent $PSScriptRoot
$UpdateRoot = Join-Path $InstallRoot 'updates'
$ActiveFile = Join-Path $UpdateRoot 'active.json'
$PendingFile = Join-Path $UpdateRoot 'pending-install.json'
$BrokerVersion = '1.0.0'
$ActivationLaunch = [bool]$env:STHANG_STUDIO_UPDATE_ACTIVATION
$ForceLegacy = $false

if (-not $ActivationLaunch) {
  & node (Join-Path $InstallRoot 'scripts\update-runtime.mjs') recover $InstallRoot
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'Studio could not complete update recovery. The legacy installed version will be used.' -ForegroundColor Yellow
    $ForceLegacy = $true
  }
}

$SourceRoot = $InstallRoot
$ActiveVersion = ''
if (-not $ForceLegacy -and (Test-Path -LiteralPath $ActiveFile)) {
  try {
    $Active = Get-Content -LiteralPath $ActiveFile -Raw | ConvertFrom-Json
    $Version = [string]$Active.version
    if ($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$') {
      throw 'The active version is invalid.'
    }
    $Digest = ([string]$Active.manifestDigest).ToLowerInvariant()
    if ($Digest -notmatch '^[0-9a-f]{64}$') { throw 'The active manifest identity is invalid.' }
    $Relative = ([string]$Active.relativePath).Replace('/', '\')
    if ($Relative -ne "versions\$Version") { throw 'The active version path is invalid.' }
    $Candidate = [IO.Path]::GetFullPath((Join-Path $InstallRoot $Relative))
    $VersionsRoot = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'versions'))
    $Expected = [IO.Path]::GetFullPath((Join-Path $VersionsRoot $Version))
    if (-not [string]::Equals($Candidate, $Expected, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'The active version path is outside the immutable version area.'
    }
    $MarkerPath = Join-Path $Candidate '.sthang-update-version.json'
    $Marker = Get-Content -LiteralPath $MarkerPath -Raw | ConvertFrom-Json
    if ($Marker.schemaVersion -ne 1 -or [string]$Marker.version -ne $Version -or [string]$Marker.manifestDigest -ne $Digest) {
      throw 'The active immutable version marker is invalid.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Candidate 'scripts\dev.mjs'))) {
      throw 'The active version is incomplete.'
    }
    $SourceRoot = $Candidate
    $ActiveVersion = $Version
  } catch {
    Write-Host 'The active update pointer was invalid. The legacy installed version will be used.' -ForegroundColor Yellow
    $SourceRoot = $InstallRoot
    $ActiveVersion = ''
  }
}

$TypeScript = Join-Path $SourceRoot 'node_modules\typescript\bin\tsc'
$Python = Join-Path $SourceRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $TypeScript)) {
  throw 'Sthang Studio dependencies are not ready for the selected version. Use the manual Windows installer to repair the installation.'
}
if (-not (Test-Path -LiteralPath $Python)) {
  throw 'Local caption timing is not ready for the selected version. Use the manual Windows installer to repair the installation.'
}

$EnvironmentFile = Join-Path $InstallRoot 'apps\server\.env'
if (-not (Test-Path -LiteralPath $EnvironmentFile)) {
  $Example = Join-Path $InstallRoot '.env.example'
  if (-not (Test-Path -LiteralPath $Example)) { throw 'The optional Studio settings template is missing.' }
  New-Item -ItemType Directory -Path (Split-Path -Parent $EnvironmentFile) -Force | Out-Null
  Copy-Item -LiteralPath $Example -Destination $EnvironmentFile -Force
}

$TrustRootFile = Join-Path $InstallRoot 'config\update-trust-root.json'
if (-not (Test-Path -LiteralPath $TrustRootFile)) {
  throw 'The Studio update trust root is missing. Use the manual Windows installer to repair the installation.'
}

$env:STHANG_STUDIO_INSTALL_ROOT = $InstallRoot
$env:STHANG_STUDIO_STATE_ROOT = $InstallRoot
$env:STHANG_STUDIO_ENV_FILE = $EnvironmentFile
$env:STHANG_STUDIO_UPDATE_TRUST_ROOT_FILE = $TrustRootFile
$env:STHANG_STUDIO_ACTIVE_VERSION = $ActiveVersion
$env:STHANG_STUDIO_BROKER_VERSION = $BrokerVersion
Remove-Item Env:STHANG_STUDIO_UPDATE_ACTIVATION -ErrorAction SilentlyContinue

Set-Location $SourceRoot
& node (Join-Path $SourceRoot 'scripts\dev.mjs')
$ExitCode = $LASTEXITCODE

if ($ExitCode -eq 42) {
  if (-not (Test-Path -LiteralPath $PendingFile)) {
    Write-Host 'Studio requested an update restart, but no verified pending release was found.' -ForegroundColor Red
    exit 1
  }
  Set-Location $InstallRoot
  & node (Join-Path $InstallRoot 'scripts\update-runtime.mjs') apply $PendingFile
  if ($LASTEXITCODE -eq 0) { exit 42 }
  exit 1
}

exit $ExitCode

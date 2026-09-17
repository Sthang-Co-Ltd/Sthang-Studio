param([switch]$BrokerProbe)
$ErrorActionPreference = 'Stop'
$InstallRoot = Split-Path -Parent $PSScriptRoot
$UpdateRoot = Join-Path $InstallRoot 'updates'
$ActiveFile = Join-Path $UpdateRoot 'active.json'
$PendingFile = Join-Path $UpdateRoot 'pending-install.json'
$BrokerVersion = '1.0.1'
$ActivationLaunch = [bool]$env:STHANG_STUDIO_UPDATE_ACTIVATION
$ForceLegacy = $false

# A broker upgrade stages a complete immutable bundle before atomically replacing
# this one entrypoint. Never run a mixture of old and new broker scripts.
$BrokerRoot = $InstallRoot
$BundleRoot = Join-Path $InstallRoot ("broker-versions\$BrokerVersion")
if (Test-Path -LiteralPath $BundleRoot) { $BrokerRoot = $BundleRoot }
$BrokerScripts = Join-Path $BrokerRoot 'scripts'
$BrokerDefinitionFile = Join-Path $BrokerRoot 'config\studio-broker.json'
$BrokerFiles = @(
  'scripts/launch-studio.ps1',
  'scripts/update-runtime.mjs',
  'scripts/update-protocol.mjs',
  'scripts/prepare-studio-update.ps1'
)

function Assert-BrokerRegularPath([string]$FilePath) {
  $Item = Get-Item -LiteralPath $FilePath -Force
  if ($Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'The Studio update helper contains an unexpected file. Use the manual recovery package.'
  }
  $Directory = $Item.Directory
  while ($Directory) {
    if ($Directory.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw 'The Studio update helper cannot run through redirected directories. Use the manual recovery package.'
    }
    $Directory = $Directory.Parent
  }
  return $Item
}

$DefinitionFile = Assert-BrokerRegularPath $BrokerDefinitionFile
if ($DefinitionFile.Length -gt 32768) { throw 'The Studio update helper definition is invalid.' }
$Definition = Get-Content -LiteralPath $BrokerDefinitionFile -Raw | ConvertFrom-Json
if ($Definition.schemaVersion -ne 1 -or $Definition.product -cne 'sthang-studio' -or
    $Definition.platform -cne 'windows-x64' -or $Definition.brokerVersion -cne $BrokerVersion -or
    @($Definition.files.PSObject.Properties).Count -ne $BrokerFiles.Count) {
  throw 'The Studio update helper identity is invalid. Use the manual recovery package.'
}
foreach ($Relative in $BrokerFiles) {
  $Property = $Definition.files.PSObject.Properties[$Relative]
  if (-not $Property -or [string]$Property.Value.sha256 -cnotmatch '^[0-9a-f]{64}$') {
    throw 'The Studio update helper file list is invalid.'
  }
  $FilePath = Join-Path $BrokerRoot $Relative.Replace('/', '\')
  $File = Assert-BrokerRegularPath $FilePath
  if ($File.Length -ne $Property.Value.sizeBytes -or $File.Length -le 0 -or $File.Length -gt 262144 -or
      (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Property.Value.sha256) {
    throw 'The Studio update helper failed integrity checking. Use the manual recovery package.'
  }
}
# When using a bundle, the stable entrypoint must be its exact reviewed launcher.
$ExpectedLauncher = $Definition.files.PSObject.Properties['scripts/launch-studio.ps1'].Value.sha256
if ((Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedLauncher) {
  throw 'The stable Studio launcher does not match its update helper.'
}
if ($BrokerProbe) {
  Write-Output "STHANG_STUDIO_BROKER=$BrokerVersion"
  exit 0
}

if (-not $ActivationLaunch) {
  & node (Join-Path $BrokerScripts 'update-runtime.mjs') recover $InstallRoot
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
  & node (Join-Path $BrokerScripts 'update-runtime.mjs') apply $PendingFile
  if ($LASTEXITCODE -eq 0) { exit 42 }
  exit 1
}

exit $ExitCode

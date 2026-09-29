param(
  [string]$BucketName = 'sthang-studio-updates'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$MaxPackageBytes = 8 * 1024 * 1024
$ReviewedWranglerVersion = '4.143.0'
$Wrangler = Join-Path $Root 'node_modules\wrangler\bin\wrangler.js'
$WranglerPackage = Join-Path $Root 'node_modules\wrangler\package.json'

function Invoke-Wrangler([string[]]$Arguments) {
  $Previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $Output = & node.exe $Wrangler @Arguments 2>&1
    $ExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $Previous
  }
  [pscustomobject]@{
    ExitCode = $ExitCode
    Text = (($Output | ForEach-Object { "$_" }) -join "`r`n")
  }
}

if ($BucketName -notmatch '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$') { throw 'BucketName is invalid.' }
foreach ($Command in @('git.exe','node.exe','npm.cmd')) {
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { throw "$Command is required." }
}
if (-not (Test-Path -LiteralPath $Wrangler -PathType Leaf) -or -not (Test-Path -LiteralPath $WranglerPackage -PathType Leaf)) {
  throw 'Run npm ci before staging so the reviewed Wrangler CLI is available.'
}
$RootPackage = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
$RootLock = Get-Content (Join-Path $Root 'package-lock.json') -Raw | ConvertFrom-Json
$InstalledWrangler = Get-Content $WranglerPackage -Raw | ConvertFrom-Json
$DeclaredWranglerVersion = [string]($RootPackage.devDependencies.wrangler)
$LockedWranglerVersion = [string](($RootLock.packages.'node_modules/wrangler').version)
$InstalledWranglerVersion = [string]($InstalledWrangler.version)
if (
  ($DeclaredWranglerVersion -ne $ReviewedWranglerVersion) -or
  ($LockedWranglerVersion -ne $ReviewedWranglerVersion) -or
  ($InstalledWranglerVersion -ne $ReviewedWranglerVersion)
) {
  throw "The installed Wrangler CLI must exactly match the reviewed $ReviewedWranglerVersion dependency. Run npm ci and retry."
}

& git.exe fetch --no-tags origin main
if ($LASTEXITCODE -ne 0) { throw 'Could not refresh accepted main.' }
$Head = (& git.exe rev-parse HEAD).Trim()
$Main = (& git.exe rev-parse origin/main).Trim()
if ($Head -ne $Main) { throw 'Stage macOS OTA only from the exact current accepted main commit.' }
$Dirty = (& git.exe status --porcelain --untracked-files=no) -join "`n"
if ($LASTEXITCODE -ne 0 -or $Dirty.Trim()) { throw 'Tracked source must be clean before staging.' }

$Trust = Get-Content (Join-Path $Root 'config\update-trust-root-macos.json') -Raw | ConvertFrom-Json
if (
  ($Trust.provisioned -ne $true) -or
  ([string]$Trust.platform -ne 'macos-arm64') -or
  ([string]$Trust.endpoint -ne 'https://updates.sthang.app/studio/macos-arm64/latest.json')
) { throw 'The accepted macOS Studio public trust root is not provisioned correctly.' }
$Version = (& node.exe -p "require('./package.json').version").Trim()
if ($LASTEXITCODE -ne 0 -or $Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$') {
  throw 'package.json release version is invalid.'
}
$Notes = Join-Path $Root "release-notes\v$Version.txt"
if (-not (Test-Path -LiteralPath $Notes -PathType Leaf)) { throw "Missing committed release-notes/v$Version.txt." }
$BuildEvidence = Join-Path $Root '.sthang\macos-release-build.json'
if (-not (Test-Path -LiteralPath $BuildEvidence -PathType Leaf)) { throw 'Missing committed macOS release build evidence.' }

Write-Host 'Running macOS OTA release validation (no hosted runner)...' -ForegroundColor Cyan
foreach ($Command in @('test:public','check:public','test:updater','test:macos','test:startup','typecheck','build')) {
  & npm.cmd run $Command
  if ($LASTEXITCODE -ne 0) { throw "$Command failed." }
}

Write-Host 'Packaging exact manual recovery + macOS OTA candidates...' -ForegroundColor Cyan
& npm.cmd run package:macos -- -SkipValidation
if ($LASTEXITCODE -ne 0) { throw 'macOS packaging failed.' }
$Package = Join-Path $Root "release-artifacts\Sthang-Studio-OTA-macOS-Apple-Silicon-v$Version.zip"
$UnsignedManifest = Join-Path $Root "release-artifacts\Sthang-Studio-OTA-macOS-Apple-Silicon-v$Version.release-unsigned.json"
if (-not (Test-Path -LiteralPath $Package -PathType Leaf) -or -not (Test-Path -LiteralPath $UnsignedManifest -PathType Leaf)) {
  throw 'The macOS OTA package/evidence was not produced.'
}
$PackageLength = (Get-Item -LiteralPath $Package).Length
if ($PackageLength -le 0 -or $PackageLength -gt $MaxPackageBytes) { throw 'macOS OTA package exceeds the production signer staging limit.' }

& git.exe fetch --no-tags origin main
if ($LASTEXITCODE -ne 0) { throw 'Could not re-check accepted main before staging.' }
$MainAfterBuild = (& git.exe rev-parse origin/main).Trim()
if ($MainAfterBuild -ne $Head) { throw 'Accepted main changed during macOS release preparation. Rebuild from the new main commit.' }
$DirtyAfterBuild = (& git.exe status --porcelain --untracked-files=no) -join "`n"
if ($LASTEXITCODE -ne 0 -or $DirtyAfterBuild.Trim()) { throw 'macOS release preparation changed tracked source.' }

$ObjectKey = "staging/macos-arm64/$Head/package.zip"
Write-Host "Staging exact macOS package to private R2 object $ObjectKey..." -ForegroundColor Cyan
$Upload = Invoke-Wrangler @('r2','object','put',"$BucketName/$ObjectKey",'--file',$Package,'--remote')
Write-Host $Upload.Text
if ($Upload.ExitCode -ne 0) { throw 'R2 macOS staging upload failed.' }

Write-Host ''
Write-Host 'Studio macOS OTA candidate staged.' -ForegroundColor Green
Write-Host "Commit:  $Head"
Write-Host "Version: $Version"
Write-Host "R2 key:  $ObjectKey"
Write-Host "Bytes:   $PackageLength"
Write-Host ''
Write-Host 'Authorize signing with the exact release issue comment: /studio-ota-sign-macos' -ForegroundColor DarkGray
Write-Host 'After public recovery/source evidence is accepted, promote with: /studio-ota-promote-macos' -ForegroundColor DarkGray
Write-Host 'No release was signed, published, or promoted by this staging command.' -ForegroundColor Yellow

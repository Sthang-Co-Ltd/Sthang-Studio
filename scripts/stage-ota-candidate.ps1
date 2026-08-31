param(
  [string]$BucketName = 'sthang-studio-updates'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if ($BucketName -notmatch '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$') { throw 'BucketName is invalid.' }
foreach ($Command in @('git.exe','node.exe','npm.cmd','npx.cmd')) {
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { throw "$Command is required." }
}

& git.exe fetch --no-tags origin main
if ($LASTEXITCODE -ne 0) { throw 'Could not refresh accepted main.' }
$Head = (& git.exe rev-parse HEAD).Trim()
$Main = (& git.exe rev-parse origin/main).Trim()
if ($Head -ne $Main) { throw 'Stage only the exact current accepted main commit.' }
$Dirty = (& git.exe status --porcelain --untracked-files=no) -join "`n"
if ($LASTEXITCODE -ne 0 -or $Dirty.Trim()) { throw 'Tracked source must be clean before staging.' }

$Trust = Get-Content (Join-Path $Root 'config\update-trust-root.json') -Raw | ConvertFrom-Json
if ($Trust.provisioned -ne $true) { throw 'The accepted Studio public trust root is not provisioned yet.' }
$Version = (& node.exe -p "require('./package.json').version").Trim()
if ($LASTEXITCODE -ne 0 -or $Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$') {
  throw 'package.json release version is invalid.'
}
$Notes = Join-Path $Root "release-notes\v$Version.txt"
if (-not (Test-Path -LiteralPath $Notes)) { throw "Missing committed release-notes/v$Version.txt." }

Write-Host 'Running local release validation (no hosted runner)...' -ForegroundColor Cyan
foreach ($Command in @('test:public','check:public','test:updater','test:update-powershell','typecheck','build')) {
  & npm.cmd run $Command
  if ($LASTEXITCODE -ne 0) { throw "$Command failed." }
}

Write-Host 'Packaging the exact OTA candidate...' -ForegroundColor Cyan
& npm.cmd run package:ota -- -SkipValidation -ReleaseNotesFile $Notes
if ($LASTEXITCODE -ne 0) { throw 'OTA packaging failed.' }
$Package = Join-Path $Root "release-artifacts\Sthang-Studio-OTA-v$Version.zip"
if (-not (Test-Path -LiteralPath $Package)) { throw 'OTA package was not produced.' }

$ObjectKey = "staging/$Head/package.zip"
Write-Host "Staging exact package to private R2 object $ObjectKey..." -ForegroundColor Cyan
& npx.cmd wrangler r2 object put "$BucketName/$ObjectKey" --file $Package --remote
if ($LASTEXITCODE -ne 0) { throw 'R2 staging upload failed.' }

Write-Host ''
Write-Host 'Studio OTA candidate staged.' -ForegroundColor Green
Write-Host "Commit:  $Head"
Write-Host "Version: $Version"
Write-Host "R2 key:  $ObjectKey"
Write-Host ''
Write-Host 'The signer still verifies every staged ZIP entry against the accepted GitHub source before signing.' -ForegroundColor DarkGray
Write-Host 'No release was signed, published, or promoted.' -ForegroundColor Yellow

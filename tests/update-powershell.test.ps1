$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ('Sthang-Studio-Updater-Test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function New-TestZip([string]$Path, [object[]]$Entries) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $Archive = [IO.Compression.ZipFile]::Open($Path, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($Pair in $Entries) {
      $Name = [string]$Pair[0]
      $Contents = [string]$Pair[1]
      $Entry = $Archive.CreateEntry($Name)
      $Stream = $Entry.Open()
      $Writer = New-Object IO.StreamWriter($Stream, (New-Object Text.UTF8Encoding($false)))
      try { $Writer.Write($Contents) } finally { $Writer.Dispose(); $Stream.Dispose() }
    }
  } finally { $Archive.Dispose() }
}

function New-LauncherFixture([string]$Name, [bool]$SourceCheckout, [bool]$ValidMarker) {
  $Fixture = Join-Path $TempRoot $Name
  $VersionRoot = Join-Path $Fixture 'versions\0.85.4'
  foreach ($Directory in @(
    (Join-Path $Fixture 'scripts'),
    (Join-Path $Fixture 'updates'),
    (Join-Path $Fixture 'node_modules\typescript\bin'),
    (Join-Path $Fixture '.venv\Scripts'),
    (Join-Path $Fixture 'apps\server'),
    (Join-Path $Fixture 'config'),
    (Join-Path $VersionRoot 'scripts'),
    (Join-Path $VersionRoot 'node_modules\typescript\bin'),
    (Join-Path $VersionRoot '.venv\Scripts')
  )) { New-Item -ItemType Directory -Path $Directory -Force | Out-Null }
  if ($SourceCheckout) { New-Item -ItemType Directory -Path (Join-Path $Fixture '.git') | Out-Null }
  Copy-Item -LiteralPath (Join-Path $Root 'scripts\launch-studio.ps1') -Destination (Join-Path $Fixture 'scripts\launch-studio.ps1')
  foreach ($Relative in @(
    'node_modules\typescript\bin\tsc', '.venv\Scripts\python.exe',
    'versions\0.85.4\node_modules\typescript\bin\tsc',
    'versions\0.85.4\.venv\Scripts\python.exe',
    'scripts\dev.mjs', 'versions\0.85.4\scripts\dev.mjs',
    'apps\server\.env', 'config\update-trust-root.json'
  )) { [IO.File]::WriteAllText((Join-Path $Fixture $Relative), '') }
  $Digest = 'a' * 64
  @{ version = '0.85.4'; manifestDigest = $Digest; relativePath = 'versions\0.85.4' } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Fixture 'updates\active.json')
  @{ schemaVersion = 1; version = '0.85.4'; manifestDigest = $(if ($ValidMarker) { $Digest } else { 'b' * 64 }) } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $VersionRoot '.sthang-update-version.json')
  return $Fixture
}

function Invoke-LauncherFixture([string]$Fixture, [string]$Name, [int]$ExpectedExit) {
  $Trace = Join-Path $TempRoot ($Name + '.trace')
  $env:STHANG_LAUNCH_TEST_TRACE = $Trace
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Fixture 'scripts\launch-studio.ps1') | Out-Null
  Assert-True ($LASTEXITCODE -eq $ExpectedExit) "$Name returned the wrong exit code."
  return Get-Content -LiteralPath $Trace
}

try {
  $Scripts = @(
    'scripts\launch-studio.ps1',
    'scripts\prepare-studio-update.ps1',
    'scripts\package-ota-release.ps1',
    'scripts\package-windows-release.ps1',
    'scripts\install-release-package.ps1'
  )
  foreach ($Relative in $Scripts) {
    $Tokens = $null
    $Errors = $null
    [Management.Automation.Language.Parser]::ParseFile((Join-Path $Root $Relative), [ref]$Tokens, [ref]$Errors) | Out-Null
    if ($Errors.Count -gt 0) {
      throw "$Relative has PowerShell syntax errors: $($Errors[0].Message)"
    }
  }

  . (Join-Path $Root 'scripts\prepare-studio-update.ps1') -LibraryOnly

  $HashFixture = Join-Path $TempRoot 'hash-fixture.bin'
  [IO.File]::WriteAllBytes($HashFixture, [Text.Encoding]::ASCII.GetBytes('abc'))
  Assert-True ((Get-Sha256 $HashFixture) -eq 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') 'The broker SHA-256 implementation returned the wrong digest.'
  $OtaPackager = Get-Content -LiteralPath (Join-Path $Root 'scripts\package-ota-release.ps1') -Raw
  Assert-True ($OtaPackager -notmatch '\bGet-FileHash\b') 'The OTA packager must not depend on PowerShell module auto-loading for SHA-256.'

  $GoodZip = Join-Path $TempRoot 'good.zip'
  $GoodDest = Join-Path $TempRoot 'good'
  New-Item -ItemType Directory -Path $GoodDest -Force | Out-Null
  New-TestZip $GoodZip @(, @('source/file.txt', 'hello'))
  Expand-SafeZip $GoodZip $GoodDest 5
  Assert-True ((Get-Content -LiteralPath (Join-Path $GoodDest 'source\file.txt') -Raw) -eq 'hello') 'Safe ZIP extraction did not preserve the expected file.'

  foreach ($Case in @(
    @{ Name = 'traversal'; Entries = @(, @('../escape.txt', 'bad')); Pattern = 'unsafe path' },
    @{ Name = 'alternate-stream'; Entries = @(, @('source/file.txt:secret', 'bad')); Pattern = 'unsafe path' },
    @{ Name = 'reserved-name'; Entries = @(, @('source/CON.txt', 'bad')); Pattern = 'reserved Windows path' },
    @{ Name = 'case-conflict'; Entries = @(@('source/File.txt', 'a'), @('source/file.txt', 'b')); Pattern = 'duplicate or case-conflicting' }
  )) {
    $Zip = Join-Path $TempRoot ($Case.Name + '.zip')
    $Dest = Join-Path $TempRoot ($Case.Name + '-dest')
    New-Item -ItemType Directory -Path $Dest -Force | Out-Null
    New-TestZip $Zip $Case.Entries
    $Rejected = $false
    try { Expand-SafeZip $Zip $Dest ([long](($Case.Entries | ForEach-Object { [Text.Encoding]::UTF8.GetByteCount([string]$_[1]) } | Measure-Object -Sum).Sum)) }
    catch {
      $Rejected = $_.Exception.Message -match $Case.Pattern
    }
    Assert-True $Rejected "Unsafe ZIP case '$($Case.Name)' was not rejected correctly."
  }

  $JsonPath = Join-Path $TempRoot 'active.json'
  Write-JsonAtomic $JsonPath ([ordered]@{ schemaVersion = 1; version = '0.7.14' })
  Write-JsonAtomic $JsonPath ([ordered]@{ schemaVersion = 1; version = '0.8.0' })
  $Parsed = Get-Content -LiteralPath $JsonPath -Raw | ConvertFrom-Json
  Assert-True ($Parsed.version -eq '0.8.0') 'Atomic JSON replacement did not expose the new complete value.'

  $Launcher = Get-Content -LiteralPath (Join-Path $Root 'run-windows.bat') -Raw
  Assert-True ($Launcher -match 'scripts\\launch-studio\.ps1') 'The stable Windows launcher is not wired to the update broker.'
  $Installer = Get-Content -LiteralPath (Join-Path $Root 'scripts\install-release-package.ps1') -Raw
  Assert-True ($Installer -match 'active\.json') 'The manual recovery installer does not clear the OTA active pointer.'

  $NodeBin = Join-Path $TempRoot 'bin'
  New-Item -ItemType Directory -Path $NodeBin | Out-Null
  @'
@echo off
echo %*>>"%STHANG_LAUNCH_TEST_TRACE%"
if "%~nx1"=="dev.mjs" if "%STHANG_LAUNCH_TEST_DEV_EXIT%"=="42" exit /b 42
exit /b 0
'@ | Set-Content -LiteralPath (Join-Path $NodeBin 'node.cmd') -Encoding Ascii
  $OriginalPath = $env:PATH
  $OriginalActivation = $env:STHANG_STUDIO_UPDATE_ACTIVATION
  try {
    $env:PATH = "$NodeBin;$OriginalPath"
    Remove-Item Env:STHANG_STUDIO_UPDATE_ACTIVATION -ErrorAction SilentlyContinue
    $Checkout = New-LauncherFixture 'checkout' $true $true
    $CheckoutTrace = @(Invoke-LauncherFixture $Checkout 'checkout' 0)
    Assert-True ($CheckoutTrace.Count -eq 1 -and $CheckoutTrace[0] -like "*$Checkout\scripts\dev.mjs*") 'A source checkout must launch its current scripts without update recovery.'
    $Installed = New-LauncherFixture 'installed' $false $true
    $InstalledTrace = @(Invoke-LauncherFixture $Installed 'installed' 0)
    Assert-True ($InstalledTrace.Count -eq 2 -and $InstalledTrace[0] -like '*update-runtime.mjs*recover*' -and $InstalledTrace[1] -like "*$Installed\versions\0.85.4\scripts\dev.mjs*") 'An installed copy must recover and launch its verified active version.'
    $BadMarker = New-LauncherFixture 'bad-marker' $false $false
    $BadMarkerTrace = @(Invoke-LauncherFixture $BadMarker 'bad-marker' 0)
    Assert-True ($BadMarkerTrace.Count -eq 2 -and $BadMarkerTrace[1] -like "*$BadMarker\scripts\dev.mjs*") 'An invalid installed version marker must fall back to the stable root.'
    [IO.File]::WriteAllText((Join-Path $Checkout 'updates\pending-install.json'), '{}')
    $env:STHANG_LAUNCH_TEST_DEV_EXIT = '42'
    $CheckoutRestartTrace = @(Invoke-LauncherFixture $Checkout 'checkout-restart' 1)
    Assert-True ($CheckoutRestartTrace.Count -eq 1) 'A source checkout must not apply a signed update restart.'
  } finally {
    $env:PATH = $OriginalPath
    if ($null -eq $OriginalActivation) { Remove-Item Env:STHANG_STUDIO_UPDATE_ACTIVATION -ErrorAction SilentlyContinue }
    else { $env:STHANG_STUDIO_UPDATE_ACTIVATION = $OriginalActivation }
    Remove-Item Env:STHANG_LAUNCH_TEST_TRACE -ErrorAction SilentlyContinue
    Remove-Item Env:STHANG_LAUNCH_TEST_DEV_EXIT -ErrorAction SilentlyContinue
  }

  $Prepare = Get-Content -LiteralPath (Join-Path $Root 'scripts\prepare-studio-update.ps1') -Raw
  $NpmIndex = $Prepare.IndexOf('& npm.cmd ci')
  $PythonIndex = $Prepare.IndexOf("& `$env:ComSpec /d /c 'setup-local-timing-windows.bat'")
  $TypecheckIndex = $Prepare.IndexOf('& npm.cmd run typecheck')
  $BuildIndex = $Prepare.IndexOf('& npm.cmd run build')
  $MoveIndex = $Prepare.IndexOf('Move-Item -LiteralPath $ExtractRoot -Destination $Target')
  Assert-True ($NpmIndex -ge 0 -and $PythonIndex -gt $NpmIndex -and $TypecheckIndex -gt $PythonIndex -and $BuildIndex -gt $TypecheckIndex -and $MoveIndex -gt $BuildIndex) 'Dependency/setup/build validation must finish before the immutable version is moved into place.'
  Assert-True ($Prepare -notmatch 'active\.json') 'The dependency preparation script must never modify the active-version pointer.'

  Write-Host 'Windows updater PowerShell tests passed.' -ForegroundColor Green
} finally {
  Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

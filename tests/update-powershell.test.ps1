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

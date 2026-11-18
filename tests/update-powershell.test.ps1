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
  $ArchiveScripts = @(
    'scripts\install-new-pc.ps1',
    'scripts\package-macos-release.ps1',
    'scripts\package-ota-release.ps1',
    'scripts\package-windows-release.ps1',
    'scripts\windows-managed-runtime.ps1'
  )
  $Scripts = @(
    'scripts\launch-studio.ps1',
    'scripts\windows-archive.ps1',
    'scripts\setup-local-timing-windows.ps1',
    'scripts\setup-windows-reviewed-node.ps1',
    'scripts\prepare-studio-update.ps1',
    'scripts\install-release-package.ps1',
    'scripts\stage-ota-candidate.ps1',
    'scripts\stage-macos-ota-candidate.ps1',
    'scripts\deploy-ota-signer.ps1'
  ) + $ArchiveScripts
  foreach ($Relative in $Scripts) {
    $Tokens = $null
    $Errors = $null
    $Ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Root $Relative), [ref]$Tokens, [ref]$Errors)
    if ($Errors.Count -gt 0) {
      throw "$Relative has PowerShell syntax errors: $($Errors[0].Message)"
    }
    if ($ArchiveScripts -contains $Relative) {
      $DirectExpand = $Ast.Find({
        param($Node)
        $Node -is [Management.Automation.Language.CommandAst] -and $Node.GetCommandName() -match '(^|\\)Expand-Archive$'
      }, $true)
      Assert-True ($null -eq $DirectExpand) "$Relative must use Expand-StudioArchive for ZIP extraction."
      Assert-True ($Ast.Extent.Text -match '(?m)^\s*\.\s+\(Join-Path \$PSScriptRoot ''windows-archive\.ps1''\)') "$Relative must dot-source windows-archive.ps1 beside itself."
    }
  }
  Write-Host 'Archive caller static checks passed.'

  $ShadowRoot = Join-Path $TempRoot 'shadow-modules'
  $ShadowFolder = Join-Path $ShadowRoot 'Microsoft.PowerShell.Archive\99.0.0'
  New-Item -ItemType Directory -Path $ShadowFolder -Force | Out-Null
  $ShadowManifest = Join-Path $ShadowFolder 'Microsoft.PowerShell.Archive.psd1'
  Set-Content -LiteralPath $ShadowManifest -Encoding ASCII -Value @'
@{
  RootModule = 'Microsoft.PowerShell.Archive.psm1'
  ModuleVersion = '99.0.0'
  FunctionsToExport = @('Expand-Archive')
}
'@
  Set-Content -LiteralPath (Join-Path $ShadowFolder 'Microsoft.PowerShell.Archive.psm1') -Encoding ASCII -Value @'
function Expand-Archive { throw 'shadow archive module used' }
'@

  $ArchiveZip = Join-Path $TempRoot 'archive[fixture].zip'
  New-TestZip $ArchiveZip @(, @('file.txt', 'archive fixture'))
  $ArchiveFixture = Join-Path $TempRoot 'archive-fixture.ps1'
  Set-Content -LiteralPath $ArchiveFixture -Encoding ASCII -Value @'
param(
  [ValidateSet('ShadowControl', 'ShadowPath', 'ShadowLoaded', 'Core')][string]$Mode,
  [string]$Helper,
  [string]$Zip,
  [string]$Destination,
  [string]$ShadowManifest
)
$ErrorActionPreference = 'Stop'

if ($Mode -eq 'ShadowControl') {
  $ShadowUsed = $false
  try { Expand-Archive -LiteralPath $Zip -DestinationPath $Destination }
  catch { $ShadowUsed = $_.Exception.Message -eq 'shadow archive module used' }
  if (-not $ShadowUsed) { throw 'Bare Expand-Archive did not fail with the shadow module error.' }
  Write-Host 'Bare Expand-Archive reproduced the shadow module error.'
  return
}

if ($Mode -eq 'ShadowLoaded') {
  Import-Module -Name $ShadowManifest -ErrorAction Stop
}

. $Helper
Expand-StudioArchive -LiteralPath $Zip -DestinationPath $Destination
$File = Join-Path $Destination 'file.txt'
if ((Get-Content -LiteralPath $File -Raw) -ne 'archive fixture') {
  throw 'Archive extraction did not preserve the fixture content.'
}
Set-Content -LiteralPath $File -Value 'overwritten content'
Expand-StudioArchive -LiteralPath $Zip -DestinationPath $Destination -Force
if ((Get-Content -LiteralPath $File -Raw) -ne 'archive fixture') {
  throw 'Archive extraction with -Force did not overwrite the fixture.'
}

$MissingRejected = $false
try { Expand-StudioArchive -LiteralPath (Join-Path (Split-Path -Parent $Zip) 'missing.zip') -DestinationPath $Destination }
catch { $MissingRejected = $_.FullyQualifiedErrorId -like 'ArchiveCmdletPathNotFound,*' }
if (-not $MissingRejected) { throw 'The missing ZIP did not raise the expected archive error.' }
Write-Host "$Mode extraction, -Force overwrite and missing ZIP checks passed."
'@
  $ArchiveFixtureArgs = @('-Helper', (Join-Path $Root 'scripts\windows-archive.ps1'), '-Zip', $ArchiveZip, '-ShadowManifest', $ShadowManifest)
  $OriginalModulePath = $env:PSModulePath
  try {
    $env:PSModulePath = $ShadowRoot + [IO.Path]::PathSeparator + $OriginalModulePath
    foreach ($Mode in @('ShadowControl', 'ShadowPath', 'ShadowLoaded')) {
      & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ArchiveFixture @ArchiveFixtureArgs -Mode $Mode -Destination (Join-Path $TempRoot $Mode)
      Assert-True ($LASTEXITCODE -eq 0) "Windows PowerShell archive fixture '$Mode' failed."
    }
  } finally {
    $env:PSModulePath = $OriginalModulePath
  }

  $Pwsh = Get-Command -Name pwsh -CommandType Application -ErrorAction SilentlyContinue
  if ($Pwsh) {
    & $Pwsh.Source -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ArchiveFixture @ArchiveFixtureArgs -Mode Core -Destination (Join-Path $TempRoot 'Core')
    Assert-True ($LASTEXITCODE -eq 0) 'PowerShell Core archive fixture failed.'
  } else {
    Write-Host 'PowerShell Core archive fixture skipped because pwsh is not on PATH.'
  }

  . (Join-Path $Root 'scripts\prepare-studio-update.ps1') -LibraryOnly

  $HashFixture = Join-Path $TempRoot 'hash-fixture.bin'
  [IO.File]::WriteAllBytes($HashFixture, [Text.Encoding]::ASCII.GetBytes('abc'))
  Assert-True ((Get-Sha256 $HashFixture) -eq 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') 'The broker SHA-256 implementation returned the wrong digest.'
  $TimingZip = Join-Path $TempRoot 'timing-controls.zip'
  $TimingRoot = Join-Path $TempRoot 'timing-controls'
  $TimingEntries = @(
    @('local-timing/locks/manifest.json', '{"schemaVersion":1}'),
    @('scripts/check-timing-dependencies.py', '# reviewed dependency check'),
    @('scripts/check-windows-timing.py', '# reviewed functional check')
  )
  New-TestZip $TimingZip $TimingEntries
  foreach ($Entry in $TimingEntries) {
    $Path = Join-Path $TimingRoot $Entry[0]
    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    [IO.File]::WriteAllText($Path, $Entry[1], (New-Object Text.UTF8Encoding($false)))
  }
  Assert-PreparedTimingFiles $TimingZip $TimingRoot
  foreach ($Entry in $TimingEntries) {
    $Path = Join-Path $TimingRoot $Entry[0]
    [IO.File]::WriteAllText($Path, ('x' * $Entry[1].Length), (New-Object Text.UTF8Encoding($false)))
    $Rejected = $false
    try { Assert-PreparedTimingFiles $TimingZip $TimingRoot }
    catch { $Rejected = $_.Exception.Message -match 'does not match the signed package' }
    Assert-True $Rejected "A changed timing control file '$($Entry[0])' was accepted."
    [IO.File]::WriteAllText($Path, $Entry[1], (New-Object Text.UTF8Encoding($false)))
  }

  Write-Host 'Prepared timing control integrity fixtures passed.'
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

  foreach ($Relative in @(
    'scripts\stage-ota-candidate.ps1',
    'scripts\stage-macos-ota-candidate.ps1',
    'scripts\deploy-ota-signer.ps1'
  )) {
    $WranglerScript = Get-Content -LiteralPath (Join-Path $Root $Relative) -Raw
    Assert-True ($WranglerScript -match '\$ReviewedWranglerVersion\s*=\s*''4\.143\.0''') "$Relative must pin the reviewed Wrangler version before authenticated use."
    Assert-True ($WranglerScript -match "'node_modules/wrangler'" -and $WranglerScript -match 'LockedWranglerVersion') "$Relative must verify the lockfile Wrangler version."
    Assert-True ($WranglerScript -match 'InstalledWranglerVersion') "$Relative must verify the installed Wrangler version."
  }

  $Prepare = Get-Content -LiteralPath (Join-Path $Root 'scripts\prepare-studio-update.ps1') -Raw
  $NpmIndex = $Prepare.IndexOf('& $ReviewedNpm ci')
  $PythonIndex = $Prepare.IndexOf("& `$env:ComSpec /d /c 'setup-local-timing-windows.bat'")
  $TypecheckIndex = $Prepare.IndexOf('& $ReviewedNpm run typecheck')
  $BuildIndex = $Prepare.IndexOf('& $ReviewedNpm run build')
  $MoveIndex = $Prepare.IndexOf('Move-Item -LiteralPath $ExtractRoot -Destination $Target')
  Assert-True ($NpmIndex -ge 0 -and $PythonIndex -gt $NpmIndex -and $TypecheckIndex -gt $PythonIndex -and $BuildIndex -gt $TypecheckIndex -and $MoveIndex -gt $BuildIndex) 'Dependency/setup/build validation must finish before the immutable version is moved into place.'
  Assert-True ($Prepare -notmatch 'active\.json') 'The dependency preparation script must never modify the active-version pointer.'

  Write-Host 'Windows updater PowerShell tests passed.' -ForegroundColor Green
} finally {
  Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

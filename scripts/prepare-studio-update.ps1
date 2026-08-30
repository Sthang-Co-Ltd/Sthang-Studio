param(
  [string]$PendingPath,
  [switch]$LibraryOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$MarkerName = '.sthang-update-version.json'

function Get-Sha256([string]$Path) {
  $Hasher = [Security.Cryptography.SHA256]::Create()
  $Stream = [IO.File]::OpenRead($Path)
  try {
    return [BitConverter]::ToString($Hasher.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant()
  } finally {
    $Stream.Dispose()
    $Hasher.Dispose()
  }
}

function Write-JsonAtomic([string]$Path, $Value) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
  $Nonce = [Guid]::NewGuid().ToString('N')
  $Temp = "$Path.$PID.$Nonce.tmp"
  $Backup = "$Path.$PID.$Nonce.bak"
  try {
    [IO.File]::WriteAllText($Temp, (($Value | ConvertTo-Json -Depth 16) + "`n"), $Utf8NoBom)
    if (Test-Path -LiteralPath $Path) {
      [IO.File]::Replace($Temp, $Path, $Backup, $true)
      Remove-Item -LiteralPath $Backup -Force -ErrorAction SilentlyContinue
    } else {
      [IO.File]::Move($Temp, $Path)
    }
  } finally {
    Remove-Item -LiteralPath $Temp -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $Backup -Force -ErrorAction SilentlyContinue
  }
}

function Assert-Under([string]$Parent, [string]$Child, [string]$Label) {
  $ParentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  $ChildFull = [IO.Path]::GetFullPath($Child)
  if (-not $ChildFull.StartsWith($ParentFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label is outside the Studio update area."
  }
}

function Get-SafeArchiveName([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw 'The update archive contains an empty path.' }
  $Name = $Value.Replace('/', '\')
  $Trimmed = $Name.TrimEnd('\')
  if (
    -not $Trimmed -or
    $Name.StartsWith('\') -or
    $Name.StartsWith('/') -or
    $Name -match '^[A-Za-z]:' -or
    $Name -match '(^|\\)\.\.(\\|$)' -or
    $Name -match '(^|\\)\.(\\|$)' -or
    $Name.Contains(':') -or
    $Name.Contains('\\')
  ) {
    throw 'The update archive contains an unsafe path.'
  }

  foreach ($Part in $Trimmed.Split('\')) {
    if (-not $Part -or $Part.EndsWith(' ') -or $Part.EndsWith('.') -or $Part -match '[\x00-\x1F]') {
      throw 'The update archive contains a Windows-unsafe path.'
    }
    if ($Part -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') {
      throw 'The update archive contains a reserved Windows path.'
    }
  }
  return $Name
}

function Expand-SafeZip([string]$ArchivePath, [string]$Destination, [long]$MaximumBytes) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $Archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
  $Seen = @{}
  try {
    $Total = [long]0
    $EntryCount = 0
    foreach ($Entry in $Archive.Entries) {
      $EntryCount += 1
      if ($EntryCount -gt 20000) { throw 'The update archive contains too many entries.' }
      $Name = Get-SafeArchiveName $Entry.FullName
      $Trimmed = $Name.TrimEnd('\')
      $Key = $Trimmed.ToLowerInvariant()
      if ($Seen.ContainsKey($Key)) { throw 'The update archive contains duplicate or case-conflicting paths.' }
      $Seen[$Key] = $true

      $UnixMode = ([int64]$Entry.ExternalAttributes -shr 16) -band 0xF000
      if ($UnixMode -eq 0xA000) { throw 'The update archive contains a symbolic link.' }
      $Total += [long]$Entry.Length
      if ($Total -gt $MaximumBytes) { throw 'The update archive expands beyond its signed size limit.' }

      $Target = [IO.Path]::GetFullPath((Join-Path $Destination $Name))
      Assert-Under $Destination $Target 'An update archive entry'
      if ($Name.EndsWith('\')) {
        New-Item -ItemType Directory -Path $Target -Force | Out-Null
        continue
      }

      New-Item -ItemType Directory -Path (Split-Path -Parent $Target) -Force | Out-Null
      $Input = $Entry.Open()
      $Output = [IO.File]::Open($Target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try {
        $Input.CopyTo($Output)
        $Output.Flush($true)
      } finally {
        $Output.Dispose()
        $Input.Dispose()
      }
      if ((Get-Item -LiteralPath $Target).Length -ne [long]$Entry.Length) {
        throw 'An update archive entry was not extracted completely.'
      }
    }
    if ($Total -ne $MaximumBytes) { throw 'The update archive expanded size did not match its signed manifest.' }
  } finally {
    $Archive.Dispose()
  }
}

if ($LibraryOnly) { return }
if (-not $PendingPath) { throw 'PendingPath is required.' }

$PendingPath = (Resolve-Path -LiteralPath $PendingPath).Path
$Pending = Get-Content -LiteralPath $PendingPath -Raw | ConvertFrom-Json
if ($Pending.schemaVersion -ne 1 -or -not $Pending.verifiedAt) {
  throw 'The pending update was not verified by the stable Studio broker.'
}

$InstallRoot = [IO.Path]::GetFullPath([string]$Pending.installRoot)
$UpdateRoot = [IO.Path]::GetFullPath([string]$Pending.updateRoot)
$VersionsRoot = [IO.Path]::GetFullPath([string]$Pending.versionsRoot)
$ManifestPath = [IO.Path]::GetFullPath([string]$Pending.manifestPath)
$PackagePath = [IO.Path]::GetFullPath([string]$Pending.packagePath)
$Version = [string]$Pending.targetVersion
if ($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$') {
  throw 'The target version is invalid.'
}

Assert-Under $InstallRoot $UpdateRoot 'The update directory'
Assert-Under $InstallRoot $VersionsRoot 'The version directory'
Assert-Under $UpdateRoot $ManifestPath 'The staged manifest'
Assert-Under $UpdateRoot $PackagePath 'The staged package'
if ((Get-Sha256 $ManifestPath) -ne ([string]$Pending.manifestDigest).ToLowerInvariant()) {
  throw 'The staged update manifest failed verification.'
}
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if (
  $Manifest.schemaVersion -ne 1 -or
  [string]$Manifest.product -ne 'sthang-studio' -or
  [string]$Manifest.platform -ne 'windows-x64' -or
  [string]$Manifest.channel -ne 'preview' -or
  [string]$Manifest.version -ne $Version
) {
  throw 'The staged signed manifest identity is invalid.'
}
if ((Get-Item -LiteralPath $PackagePath).Length -ne [long]$Manifest.package.sizeBytes) {
  throw 'The staged update package size failed verification.'
}
if ((Get-Sha256 $PackagePath) -ne ([string]$Manifest.package.sha256).ToLowerInvariant()) {
  throw 'The staged update package failed verification.'
}

$Target = [IO.Path]::GetFullPath((Join-Path $InstallRoot ([string]$Pending.targetRelativePath)))
Assert-Under $VersionsRoot $Target 'The target version'
$ReceiptPath = Join-Path $UpdateRoot ("receipts\$Version.json")
$MarkerPath = Join-Path $Target $MarkerName

function Assert-PreparedTarget([string]$PreparedRoot) {
  $Marker = Get-Content -LiteralPath (Join-Path $PreparedRoot $MarkerName) -Raw | ConvertFrom-Json
  if (
    $Marker.schemaVersion -ne 1 -or
    $Marker.version -ne $Version -or
    $Marker.manifestDigest -ne $Pending.manifestDigest -or
    $Marker.packageSha256 -ne $Manifest.package.sha256
  ) {
    throw 'The existing immutable version directory does not match this release.'
  }
  if ((Get-Sha256 (Join-Path $PreparedRoot 'package-lock.json')) -ne ([string]$Manifest.setup.packageLockSha256).ToLowerInvariant()) {
    throw 'The existing immutable version has an unexpected package lock.'
  }
  foreach ($File in $Manifest.setup.pythonFiles) {
    $Relative = ([string]$File.path).Replace('/', '\')
    $Dependency = Join-Path $PreparedRoot $Relative
    if ((Get-Sha256 $Dependency) -ne ([string]$File.sha256).ToLowerInvariant()) {
      throw 'The existing immutable version has an unexpected Python dependency file.'
    }
  }
  foreach ($Required in @(
    'scripts\dev.mjs',
    'scripts\update-protocol.mjs',
    'node_modules\typescript\bin\tsc',
    '.venv\Scripts\python.exe',
    'apps\server\src\index.ts',
    'apps\web\package.json',
    'config\update-trust-root.json'
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $PreparedRoot $Required))) {
      throw "The existing immutable version is incomplete: $Required"
    }
  }
}

if (Test-Path -LiteralPath $Target) {
  if (-not (Test-Path -LiteralPath $MarkerPath)) { throw 'An unverified immutable version directory already exists.' }
  Assert-PreparedTarget $Target
  if (-not (Test-Path -LiteralPath $ReceiptPath)) {
    Write-JsonAtomic $ReceiptPath ([ordered]@{
      schemaVersion = 1
      version = $Version
      manifestDigest = [string]$Pending.manifestDigest
      packageSha256 = [string]$Manifest.package.sha256
      preparedAt = (Get-Date).ToUniversalTime().ToString('o')
    })
  }
  exit 0
}

$WorkRoot = Join-Path $UpdateRoot ('work\' + $Version + '-' + [Guid]::NewGuid().ToString('N'))
$ExtractRoot = Join-Path $WorkRoot 'source'
New-Item -ItemType Directory -Path $ExtractRoot -Force | Out-Null
try {
  Expand-SafeZip $PackagePath $ExtractRoot ([long]$Manifest.package.unpackedSizeBytes)
  foreach ($Protected in @('data','uploads','exports','node_modules','.venv','versions','updates','release-artifacts',$MarkerName)) {
    if (Test-Path -LiteralPath (Join-Path $ExtractRoot $Protected)) {
      throw "The update archive contains protected runtime state: $Protected"
    }
  }
  if (Test-Path -LiteralPath (Join-Path $ExtractRoot 'apps\server\.env')) {
    throw 'The update archive contains protected local settings.'
  }

  $PackageJson = Get-Content -LiteralPath (Join-Path $ExtractRoot 'package.json') -Raw | ConvertFrom-Json
  if ([string]$PackageJson.version -ne $Version) { throw 'The package version does not match its signed manifest.' }
  if ((Get-Sha256 (Join-Path $ExtractRoot 'package-lock.json')) -ne ([string]$Manifest.setup.packageLockSha256).ToLowerInvariant()) {
    throw 'The package lock failed signed verification.'
  }
  foreach ($File in $Manifest.setup.pythonFiles) {
    $Relative = ([string]$File.path).Replace('/', '\')
    if ($Relative -notmatch '^local-timing\\requirements(?:-[a-z0-9-]+)?\.txt$') {
      throw 'A Python dependency path is invalid.'
    }
    $Dependency = Join-Path $ExtractRoot $Relative
    if ((Get-Sha256 $Dependency) -ne ([string]$File.sha256).ToLowerInvariant()) {
      throw 'A Python dependency file failed signed verification.'
    }
  }
  foreach ($Required in @(
    'scripts\dev.mjs',
    'scripts\update-protocol.mjs',
    'apps\server\src\index.ts',
    'apps\web\package.json',
    'config\update-trust-root.json',
    'setup-local-timing-windows.bat'
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $ExtractRoot $Required))) {
      throw "The update package is incomplete: $Required"
    }
  }

  Push-Location $ExtractRoot
  try {
    & npm.cmd ci --include=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Node dependency preparation failed.' }
    $env:KCS_NONINTERACTIVE = '1'
    & $env:ComSpec /d /c 'setup-local-timing-windows.bat'
    if ($LASTEXITCODE -ne 0) { throw 'Local timing dependency preparation failed.' }
    & npm.cmd run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'The staged Studio application failed TypeScript validation.' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'The staged Studio application failed its production build.' }
  } finally {
    Remove-Item Env:KCS_NONINTERACTIVE -ErrorAction SilentlyContinue
    Pop-Location
  }

  Write-JsonAtomic (Join-Path $ExtractRoot $MarkerName) ([ordered]@{
    schemaVersion = 1
    version = $Version
    manifestDigest = [string]$Pending.manifestDigest
    packageSha256 = [string]$Manifest.package.sha256
    preparedAt = (Get-Date).ToUniversalTime().ToString('o')
  })
  Assert-PreparedTarget $ExtractRoot

  New-Item -ItemType Directory -Path $VersionsRoot -Force | Out-Null
  Move-Item -LiteralPath $ExtractRoot -Destination $Target
  Write-JsonAtomic $ReceiptPath ([ordered]@{
    schemaVersion = 1
    version = $Version
    manifestDigest = [string]$Pending.manifestDigest
    packageSha256 = [string]$Manifest.package.sha256
    preparedAt = (Get-Date).ToUniversalTime().ToString('o')
  })
} finally {
  if (Test-Path -LiteralPath $WorkRoot) {
    Remove-Item -LiteralPath $WorkRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

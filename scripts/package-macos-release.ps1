param(
  [switch]$SkipValidation
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Invoke-Checked([string]$Label, [scriptblock]$Command) {
  Write-Host ""
  Write-Host $Label -ForegroundColor Cyan
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
}

function Get-Sha256Hex([string]$Path) {
  $Stream = [IO.File]::OpenRead($Path)
  $Hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $Bytes = $Hasher.ComputeHash($Stream)
    return ([BitConverter]::ToString($Bytes)).Replace('-', '').ToLowerInvariant()
  } finally {
    $Hasher.Dispose()
    $Stream.Dispose()
  }
}

$Package = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
$Version = [string]$Package.version
if (-not $Version) { throw 'package.json does not contain a release version.' }
$OutputDir = Join-Path $Root 'release-artifacts'
$ArtifactName = "Sthang-Studio-macOS-Apple-Silicon-v$Version.zip"
$ArtifactPath = Join-Path $OutputDir $ArtifactName
$ChecksumPath = "$ArtifactPath.sha256"
$OtaArtifactName = "Sthang-Studio-OTA-macOS-Apple-Silicon-v$Version.zip"
$OtaArtifactPath = Join-Path $OutputDir $OtaArtifactName
$OtaChecksumPath = "$OtaArtifactPath.sha256"
$OtaManifestPath = Join-Path $OutputDir "Sthang-Studio-OTA-macOS-Apple-Silicon-v$Version.release-unsigned.json"

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
foreach ($OldOutput in @($ArtifactPath, $ChecksumPath, $OtaArtifactPath, $OtaChecksumPath, $OtaManifestPath)) {
  if (Test-Path -LiteralPath $OldOutput) {
    Remove-Item -LiteralPath $OldOutput -Force
  }
}

if (-not $SkipValidation) {
  Invoke-Checked 'Running macOS compatibility regressions...' { npm.cmd run test:macos }
  Invoke-Checked 'Running public-readiness check...' { npm.cmd run check:public }
  Invoke-Checked 'Running typecheck...' { npm.cmd run typecheck }
}

$TrackedChanges = (& git status --porcelain --untracked-files=no) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Git status could not be read.' }
if ($TrackedChanges.Trim()) {
  throw 'Tracked files have uncommitted changes. Commit or restore them before building a release package.'
}

$Commit = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $Commit) { throw 'The current Git commit could not be resolved.' }
$SourceTree = (& git rev-parse ($Commit + '^{tree}')).Trim()
if ($LASTEXITCODE -ne 0 -or -not $SourceTree) { throw 'The current Git tree could not be resolved.' }
$PublishedAt = (& git show -s --format=%cI $Commit).Trim()
if ($LASTEXITCODE -ne 0 -or -not $PublishedAt) { throw 'The current Git commit timestamp could not be resolved.' }

$StageRoot = Join-Path ([IO.Path]::GetTempPath()) ('Sthang-Studio-macOS-Package-' + [Guid]::NewGuid().ToString('N'))
$BuildArchive = Join-Path $StageRoot 'tracked-build-source.zip'
$BuildRoot = Join-Path $StageRoot 'tracked-build-source'
$PackageFolder = Join-Path $StageRoot ("Sthang Studio $Version")
$FilesFolder = Join-Path $PackageFolder 'Sthang Studio Files'
$PayloadZip = Join-Path $StageRoot 'payload.zip'

New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
New-Item -ItemType Directory -Path $FilesFolder -Force | Out-Null

try {
  Write-Host ''
  Write-Host "Preparing exact tracked release build for commit $Commit..." -ForegroundColor Cyan
  & git -c core.autocrlf=false -c core.eol=lf archive --format=zip "--output=$BuildArchive" $Commit
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the exact tracked release-build source archive.' }
  Expand-Archive -LiteralPath $BuildArchive -DestinationPath $BuildRoot -Force

  $BuildPackageLock = Join-Path $BuildRoot 'package-lock.json'
  if (-not (Test-Path -LiteralPath $BuildPackageLock)) {
    throw 'Exact tracked release-build source is missing package-lock.json.'
  }
  $BuildPackageLockSha = Get-Sha256Hex $BuildPackageLock

  Invoke-Checked 'Installing exact release-build dependencies...' {
    Push-Location $BuildRoot
    try {
      npm.cmd ci --include=dev --ignore-scripts=false --no-audit --no-fund
    } finally {
      Pop-Location
    }
  }
  Invoke-Checked 'Running production build from exact tracked source...' {
    Push-Location $BuildRoot
    try {
      npm.cmd run build
    } finally {
      Pop-Location
    }
  }
  $BuildPackageLockShaAfterBuild = Get-Sha256Hex $BuildPackageLock
  if ($BuildPackageLockShaAfterBuild -ne $BuildPackageLockSha) {
    throw "The exact release-build package-lock.json changed during dependency install/build. Before: $BuildPackageLockSha After: $BuildPackageLockShaAfterBuild"
  }

  $CommitAfterBuild = (& git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $CommitAfterBuild -ne $Commit) {
    throw 'The Git commit changed during the production build. Re-run packaging from the new exact commit.'
  }
  $TrackedChangesAfterBuild = (& git status --porcelain --untracked-files=no) -join "`n"
  if ($LASTEXITCODE -ne 0) { throw 'Git status could not be read after the production build.' }
  if ($TrackedChangesAfterBuild.Trim()) {
    throw 'Tracked files changed during the production build. Restore them before building a release package.'
  }

  $PayloadPaths = @(
    'apps',
    'packages',
    'local-timing',
    'scripts',
    'config',
    'docs/MACOS-COMPATIBILITY.md',
    'docs/OTA-UPDATES.md',
    '.sthang',
    '.env.example',
    'package.json',
    'package-lock.json',
    'INSTALL-MACOS.sh',
    'setup-local-timing-macos.sh',
    'run-macos.sh',
    'README.md',
    'LICENSE',
    'PRIVACY.md',
    'SECURITY.md',
    'SUPPORT.md',
    'THIRD_PARTY_NOTICES.md',
    'TRADEMARKS.md'
  )

  Write-Host ''
  Write-Host "Creating clean Apple Silicon macOS package for Sthang Studio $Version..." -ForegroundColor Cyan
  & git -c core.autocrlf=false -c core.eol=lf archive --format=zip "--output=$PayloadZip" $Commit -- @PayloadPaths
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the tracked macOS release payload.' }
  Expand-Archive -LiteralPath $PayloadZip -DestinationPath $FilesFolder -Force

  foreach ($BuildOutput in @(
    'apps\server\dist',
    'apps\web\dist',
    'packages\shared\dist'
  )) {
    $SourceBuild = Join-Path $BuildRoot $BuildOutput
    if (-not (Test-Path -LiteralPath $SourceBuild)) {
      throw "Required production build output is missing after the exact tracked build: $BuildOutput"
    }
    $DestinationBuild = Join-Path $FilesFolder $BuildOutput
    New-Item -ItemType Directory -Path (Split-Path -Parent $DestinationBuild) -Force | Out-Null
    Copy-Item -LiteralPath $SourceBuild -Destination $DestinationBuild -Recurse -Force
  }
  $RuntimeMarker = Join-Path $FilesFolder '.sthang\macos-curated-runtime'
  Set-Content -LiteralPath $RuntimeMarker -Value 'production-runtime-v1' -Encoding ASCII
  $PayloadPackageLockSha = Get-Sha256Hex (Join-Path $FilesFolder 'package-lock.json')
  if ($PayloadPackageLockSha -ne $BuildPackageLockSha) {
    throw "Packaged package-lock.json does not match the exact tracked release-build lock. Build: $BuildPackageLockSha Package: $PayloadPackageLockSha"
  }
  $DerivedManifest = Join-Path $FilesFolder '.sthang\macos-derived-runtime.json'
  Invoke-Checked 'Verifying derived macOS production output...' {
    node (Join-Path $Root 'scripts\verify-macos-derived-runtime.mjs') $FilesFolder $DerivedManifest $Commit $BuildPackageLockSha $SourceTree
  }

  Invoke-Checked 'Validating runtime-only dependency install...' {
    Push-Location $FilesFolder
    try {
      npm.cmd ci --omit=dev --ignore-scripts --workspace '@kcs/server' --workspace '@kcs/shared' --include-workspace-root
    } finally {
      Pop-Location
    }
  }
  Invoke-Checked 'Smoke-testing curated production runtime...' {
    node (Join-Path $FilesFolder 'scripts\smoke-macos-curated-runtime.mjs') $FilesFolder
  }
  $StagedNodeModules = Join-Path $FilesFolder 'node_modules'
  if (Test-Path -LiteralPath $StagedNodeModules) {
    Remove-Item -LiteralPath $StagedNodeModules -Recurse -Force
  }

  $ReleaseNotes = Join-Path $BuildRoot ("release-notes\v$Version.txt")
  if (-not (Test-Path -LiteralPath $ReleaseNotes -PathType Leaf)) {
    throw "The exact tracked release source is missing release-notes/v$Version.txt."
  }
  Invoke-Checked 'Creating rootless macOS OTA payload...' {
    python (Join-Path $Root 'scripts\create-macos-ota-zip.py') $FilesFolder $OtaArtifactPath
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $OtaArchive = [IO.Compression.ZipFile]::OpenRead($OtaArtifactPath)
  try {
    $OtaEntries = @($OtaArchive.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
    if ($OtaEntries.Count -eq 0) { throw 'macOS OTA package contains no files.' }
    $OtaUnpackedSize = [Int64](($OtaEntries | Measure-Object -Property Length -Sum).Sum)
    foreach ($Required in @(
      'INSTALL-MACOS.sh',
      'run-macos.sh',
      'scripts/launch-studio-macos.sh',
      'scripts/prepare-studio-update-macos.sh',
      'scripts/prepare-studio-update-macos.py',
      'scripts/update-runtime.mjs',
      'config/update-trust-root-macos.json',
      '.sthang/macos-curated-runtime',
      '.sthang/macos-release-build.json',
      '.sthang/macos-derived-runtime.json',
      'apps/server/dist/index.js',
      'apps/web/dist/index.html',
      'packages/shared/dist/index.js',
      'package-lock.json'
    )) {
      if ($null -eq $OtaArchive.GetEntry($Required)) { throw "macOS OTA package is missing required entry: $Required" }
    }
    foreach ($Entry in $OtaEntries) {
      $Name = $Entry.FullName.Replace('\', '/')
      if ($Name -match '(^|/)(data|uploads|exports|tools|node_modules|\.venv|versions|updates|release-artifacts)(/|$)' -or $Name -match '(^|/)\.env($|/)') {
        throw "macOS OTA package contains protected runtime state: $Name"
      }
    }
  } finally {
    $OtaArchive.Dispose()
  }
  Invoke-Checked 'Creating unsigned macOS OTA release manifest...' {
    node (Join-Path $Root 'scripts\create-macos-ota-manifest.mjs') $FilesFolder $OtaArtifactPath $OtaManifestPath $Commit $SourceTree $OtaUnpackedSize $ReleaseNotes $PublishedAt
  }
  Invoke-Checked 'Verifying unsigned macOS OTA candidate...' {
    node (Join-Path $Root 'scripts\update-release.mjs') verify-unsigned --trust-root (Join-Path $FilesFolder 'config\update-trust-root-macos.json') --manifest $OtaManifestPath --package $OtaArtifactPath
  }
  $OtaHash = Get-Sha256Hex $OtaArtifactPath
  Set-Content -LiteralPath $OtaChecksumPath -Value "$OtaHash  $OtaArtifactName" -Encoding ASCII

  $InstallerTemplate = Join-Path $Root 'packaging\macos\Install Sthang Studio.command'
  $ReadmeTemplate = Join-Path $Root 'packaging\macos\Read Me.txt'
  Copy-Item -LiteralPath $InstallerTemplate -Destination (Join-Path $PackageFolder 'Install Sthang Studio.command') -Force
  $Readme = (Get-Content -LiteralPath $ReadmeTemplate -Raw).Replace('{{VERSION}}', $Version)
  Set-Content -LiteralPath (Join-Path $PackageFolder 'Read Me.txt') -Value $Readme -Encoding UTF8

  Invoke-Checked 'Creating ZIP with macOS executable permissions...' {
    python (Join-Path $Root 'scripts\create-macos-release-zip.py') $PackageFolder $ArtifactPath
  }

  $Archive = [IO.Compression.ZipFile]::OpenRead($ArtifactPath)
  try {
    $ArchiveRoot = "Sthang Studio $Version/"
    $Entries = @($Archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    $TopLevel = @(
      $Entries |
        Where-Object { $_.StartsWith($ArchiveRoot, [StringComparison]::Ordinal) } |
        ForEach-Object { $_.Substring($ArchiveRoot.Length) } |
        Where-Object { $_ } |
        ForEach-Object { ($_ -split '/')[0] } |
        Sort-Object -Unique
    )
    $ExpectedTopLevel = @('Install Sthang Studio.command', 'Read Me.txt', 'Sthang Studio Files')
    if (($TopLevel -join '|') -ne ($ExpectedTopLevel -join '|')) {
      throw "macOS release ZIP top level is not the expected three-item layout. Found: $($TopLevel -join ', ')"
    }

    foreach ($Required in @(
      "${ArchiveRoot}Install Sthang Studio.command",
      "${ArchiveRoot}Read Me.txt",
      "${ArchiveRoot}Sthang Studio Files/INSTALL-MACOS.sh",
      "${ArchiveRoot}Sthang Studio Files/run-macos.sh",
      "${ArchiveRoot}Sthang Studio Files/setup-local-timing-macos.sh",
      "${ArchiveRoot}Sthang Studio Files/scripts/install-release-package-macos.sh",
      "${ArchiveRoot}Sthang Studio Files/scripts/macos-managed-runtime.sh",
      "${ArchiveRoot}Sthang Studio Files/scripts/launch-studio-macos.sh",
      "${ArchiveRoot}Sthang Studio Files/scripts/prepare-studio-update-macos.sh",
      "${ArchiveRoot}Sthang Studio Files/scripts/prepare-studio-update-macos.py",
      "${ArchiveRoot}Sthang Studio Files/config/update-trust-root-macos.json",
      "${ArchiveRoot}Sthang Studio Files/.sthang/macos-curated-runtime",
      "${ArchiveRoot}Sthang Studio Files/.sthang/macos-release-build.json",
      "${ArchiveRoot}Sthang Studio Files/.sthang/macos-derived-runtime.json",
      "${ArchiveRoot}Sthang Studio Files/apps/server/dist/index.js",
      "${ArchiveRoot}Sthang Studio Files/apps/web/dist/index.html",
      "${ArchiveRoot}Sthang Studio Files/packages/shared/dist/index.js",
      "${ArchiveRoot}Sthang Studio Files/package-lock.json",
      "${ArchiveRoot}Sthang Studio Files/.sthang/product-manifest.json"
    )) {
      if ($Entries -notcontains $Required) { throw "macOS release ZIP is missing required entry: $Required" }
    }

    $ManifestEntryName = "${ArchiveRoot}Sthang Studio Files/.sthang/macos-derived-runtime.json"
    $ManifestEntry = $Archive.GetEntry($ManifestEntryName)
    if ($null -eq $ManifestEntry) { throw 'macOS derived-runtime manifest could not be inspected.' }
    $ManifestStream = $ManifestEntry.Open()
    $ManifestReader = New-Object IO.StreamReader($ManifestStream, [Text.Encoding]::UTF8, $true)
    try {
      $Manifest = ($ManifestReader.ReadToEnd() | ConvertFrom-Json)
    } finally {
      $ManifestReader.Dispose()
      $ManifestStream.Dispose()
    }
    if ([int]$Manifest.schemaVersion -ne 2) {
      throw "Unsupported macOS derived-runtime manifest schema: $($Manifest.schemaVersion)"
    }
    if ([string]$Manifest.sourceCommit -ne $Commit) {
      throw 'macOS derived-runtime manifest source commit does not match the packaged commit.'
    }
    if ([string]$Manifest.sourceTree -ne $SourceTree) {
      throw 'macOS derived-runtime manifest source tree does not match the packaged commit tree.'
    }
    if ([string]$Manifest.packageLockSha256 -ne $BuildPackageLockSha) {
      throw 'macOS derived-runtime manifest package-lock hash does not match the exact release-build lock.'
    }
    $BuildEvidenceEntry = $Archive.GetEntry("${ArchiveRoot}Sthang Studio Files/.sthang/macos-release-build.json")
    if ($null -eq $BuildEvidenceEntry) { throw 'Source-owned macOS release build evidence could not be inspected.' }
    $BuildEvidenceStream = $BuildEvidenceEntry.Open()
    $BuildEvidenceHasher = [Security.Cryptography.SHA256]::Create()
    try {
      $ArchivedBuildEvidenceHash = ([BitConverter]::ToString($BuildEvidenceHasher.ComputeHash($BuildEvidenceStream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $BuildEvidenceHasher.Dispose()
      $BuildEvidenceStream.Dispose()
    }
    if ($ArchivedBuildEvidenceHash -ne [string]$Manifest.buildEvidenceSha256) {
      throw 'Packaged source-owned macOS release build evidence hash does not match the derived-runtime manifest.'
    }

    $ManifestFiles = @($Manifest.files)
    if ($ManifestFiles.Count -eq 0) {
      throw 'macOS derived-runtime manifest contains no derived files.'
    }
    $SeenDerived = @{}
    foreach ($Derived in $ManifestFiles) {
      $Relative = ([string]$Derived.path).Replace('\', '/')
      if (-not $Relative -or $SeenDerived.ContainsKey($Relative)) {
        throw "macOS derived-runtime manifest contains a missing or duplicate path: $Relative"
      }
      $SeenDerived[$Relative] = $true
      $ExpectedEntryName = "${ArchiveRoot}Sthang Studio Files/$Relative"
      $DerivedEntry = $Archive.GetEntry($ExpectedEntryName)
      if ($null -eq $DerivedEntry) {
        throw "macOS release ZIP is missing a derived file recorded by the manifest: $Relative"
      }
      if ([Int64]$DerivedEntry.Length -ne [Int64]$Derived.size) {
        throw "macOS release ZIP derived file size does not match the manifest: $Relative"
      }
      $DerivedStream = $DerivedEntry.Open()
      $DerivedHasher = [Security.Cryptography.SHA256]::Create()
      try {
        $DerivedHash = ([BitConverter]::ToString($DerivedHasher.ComputeHash($DerivedStream))).Replace('-', '').ToLowerInvariant()
      } finally {
        $DerivedHasher.Dispose()
        $DerivedStream.Dispose()
      }
      if ($DerivedHash -ne [string]$Derived.sha256) {
        throw "macOS release ZIP derived file hash does not match the manifest: $Relative"
      }
    }

    $DerivedPrefixes = @(
      "${ArchiveRoot}Sthang Studio Files/apps/server/dist/",
      "${ArchiveRoot}Sthang Studio Files/apps/web/dist/",
      "${ArchiveRoot}Sthang Studio Files/packages/shared/dist/"
    )
    foreach ($ArchiveEntry in $Archive.Entries) {
      $ArchiveName = $ArchiveEntry.FullName.Replace('\', '/')
      if ($ArchiveName.EndsWith('/')) { continue }
      $MatchesDerivedRoot = $false
      foreach ($Prefix in $DerivedPrefixes) {
        if ($ArchiveName.StartsWith($Prefix, [StringComparison]::Ordinal)) {
          $MatchesDerivedRoot = $true
          break
        }
      }
      if (-not $MatchesDerivedRoot) { continue }
      $Relative = $ArchiveName.Substring(("${ArchiveRoot}Sthang Studio Files/").Length)
      if (-not $SeenDerived.ContainsKey($Relative)) {
        throw "macOS release ZIP contains an unmanifested derived file: $Relative"
      }
    }

    $LockEntry = $Archive.GetEntry("${ArchiveRoot}Sthang Studio Files/package-lock.json")
    if ($null -eq $LockEntry) { throw 'Packaged package-lock.json could not be inspected.' }
    $LockStream = $LockEntry.Open()
    $LockHasher = [Security.Cryptography.SHA256]::Create()
    try {
      $ArchivedLockHash = ([BitConverter]::ToString($LockHasher.ComputeHash($LockStream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $LockHasher.Dispose()
      $LockStream.Dispose()
    }
    if ($ArchivedLockHash -ne [string]$Manifest.packageLockSha256) {
      throw 'Packaged package-lock.json hash does not match the derived-runtime manifest.'
    }

    $InstallerEntry = $Archive.GetEntry("${ArchiveRoot}Install Sthang Studio.command")
    if ($null -eq $InstallerEntry) { throw 'macOS installer entry could not be inspected.' }
    # ZipArchive exposes ExternalAttributes as a signed Int32 on Windows. Shift
    # the raw bit pattern first so entries with the Unix owner-execute bit set do
    # not fail a checked UInt32 conversion before we inspect the mode bits.
    $UnixMode = ($InstallerEntry.ExternalAttributes -shr 16) -band 0x1FF
    if (($UnixMode -band 0x49) -ne 0x49) {
      throw 'Install Sthang Studio.command is not executable in the generated ZIP.'
    }
  } finally {
    $Archive.Dispose()
  }

  $Hash = Get-Sha256Hex $ArtifactPath
  Set-Content -LiteralPath $ChecksumPath -Value "$Hash  $ArtifactName" -Encoding ASCII
  $SizeMb = [math]::Round((Get-Item -LiteralPath $ArtifactPath).Length / 1MB, 2)

  Write-Host ''
  Write-Host 'macOS release package ready.' -ForegroundColor Green
  Write-Host "Artifact: $ArtifactPath"
  Write-Host "Size: $SizeMb MB"
  Write-Host "SHA256: $Hash"
  Write-Host "Commit: $Commit"
  Write-Host "Unsigned OTA candidate: $OtaArtifactPath"
  Write-Host "OTA SHA256: $OtaHash"
  Write-Host ''
  Write-Host 'Inside the downloaded ZIP, users see only:' -ForegroundColor DarkGray
  Write-Host '  Install Sthang Studio.command' -ForegroundColor DarkGray
  Write-Host '  Read Me.txt' -ForegroundColor DarkGray
  Write-Host '  Sthang Studio Files/' -ForegroundColor DarkGray
} finally {
  if (Test-Path -LiteralPath $StageRoot) {
    Remove-Item -LiteralPath $StageRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

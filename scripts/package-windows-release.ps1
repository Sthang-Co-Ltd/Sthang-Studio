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

$Package = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
$Version = [string]$Package.version
if (-not $Version) { throw 'package.json does not contain a release version.' }

if (-not $SkipValidation) {
  Invoke-Checked 'Running public-readiness check...' { npm.cmd run check:public }
  Invoke-Checked 'Running typecheck...' { npm.cmd run typecheck }
  Invoke-Checked 'Running production build...' { npm.cmd run build }
}

$TrackedChanges = (& git status --porcelain --untracked-files=no) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Git status could not be read.' }
if ($TrackedChanges.Trim()) {
  throw 'Tracked files have uncommitted changes. Commit or restore them before building a release package.'
}

$Commit = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $Commit) { throw 'The current Git commit could not be resolved.' }

$OutputDir = Join-Path $Root 'release-artifacts'
$StageRoot = Join-Path ([IO.Path]::GetTempPath()) ('Sthang-Studio-Package-' + [Guid]::NewGuid().ToString('N'))
$PackageFolder = Join-Path $StageRoot ("Sthang Studio $Version")
$FilesFolder = Join-Path $PackageFolder 'Sthang Studio Files'
$PayloadZip = Join-Path $StageRoot 'payload.zip'

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
New-Item -ItemType Directory -Path $FilesFolder -Force | Out-Null

try {
  # Runtime/public-install payload only. Developer workflow files and repository
  # administration docs remain available in the public source repository but do
  # not clutter the Windows download.
  $PayloadPaths = @(
    'apps',
    'packages',
    'local-timing',
    'scripts',
    '.env.example',
    '.npmrc',
    'package.json',
    'package-lock.json',
    'INSTALL-NEW-PC.bat',
    'setup-windows.bat',
    'setup-local-timing-windows.bat',
    'run-windows.bat',
    'STOP-STHANG-STUDIO.bat',
    'STOP-KHMER-CAPTION-STUDIO.bat',
    'README.md',
    'LICENSE',
    'PRIVACY.md',
    'SECURITY.md',
    'SUPPORT.md',
    'THIRD_PARTY_NOTICES.md',
    'TRADEMARKS.md'
  )

  Write-Host ''
  Write-Host "Creating clean Windows package for Sthang Studio $Version..." -ForegroundColor Cyan
  & git archive --format=zip "--output=$PayloadZip" HEAD -- @PayloadPaths
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the tracked release payload.' }

  Expand-Archive -LiteralPath $PayloadZip -DestinationPath $FilesFolder -Force

  $InstallerTemplate = Join-Path $Root 'packaging\windows\Install Sthang Studio.bat'
  $ReadmeTemplate = Join-Path $Root 'packaging\windows\Read Me.txt'
  Copy-Item -LiteralPath $InstallerTemplate -Destination (Join-Path $PackageFolder 'Install Sthang Studio.bat') -Force
  $Readme = (Get-Content -LiteralPath $ReadmeTemplate -Raw).Replace('{{VERSION}}', $Version)
  Set-Content -LiteralPath (Join-Path $PackageFolder 'Read Me.txt') -Value $Readme -Encoding UTF8

  $ArtifactName = "Sthang-Studio-Windows-v$Version.zip"
  $ArtifactPath = Join-Path $OutputDir $ArtifactName
  if (Test-Path -LiteralPath $ArtifactPath) { Remove-Item -LiteralPath $ArtifactPath -Force }

  # Compress-Archive can skip files carrying the Windows Hidden attribute. Use
  # .NET ZipFile directly so the release payload is complete (including dotfiles
  # such as .env.example) and so the outer Sthang Studio folder is preserved.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory(
    $PackageFolder,
    $ArtifactPath,
    [IO.Compression.CompressionLevel]::Optimal,
    $true
  )

  # Verify the archive shape before it can be treated as a release candidate.
  # This protects the calm first impression and catches accidental payload loss.
  $Archive = [IO.Compression.ZipFile]::OpenRead($ArtifactPath)
  try {
    $ArchiveRoot = "Sthang Studio $Version/"
    $RelativeEntries = @(
      $Archive.Entries |
        ForEach-Object { $_.FullName.Replace('\', '/') } |
        Where-Object { $_.StartsWith($ArchiveRoot, [StringComparison]::Ordinal) } |
        ForEach-Object { $_.Substring($ArchiveRoot.Length) }
    )

    $TopLevel = @(
      $RelativeEntries |
        Where-Object { $_ } |
        ForEach-Object { ($_ -split '/')[0] } |
        Sort-Object -Unique
    )
    $ExpectedTopLevel = @('Install Sthang Studio.bat', 'Read Me.txt', 'Sthang Studio Files')
    if (($TopLevel -join '|') -ne ($ExpectedTopLevel -join '|')) {
      throw "Release ZIP top level is not the expected three-item layout. Found: $($TopLevel -join ', ')"
    }

    $RequiredEntries = @(
      'Sthang Studio Files/.env.example',
      'Sthang Studio Files/.npmrc',
      'Sthang Studio Files/INSTALL-NEW-PC.bat',
      'Sthang Studio Files/package-lock.json',
      'Sthang Studio Files/scripts/install-release-package.ps1'
    )
    foreach ($RequiredEntry in $RequiredEntries) {
      if ($RelativeEntries -notcontains $RequiredEntry) {
        throw "Release ZIP is missing required payload entry: $RequiredEntry"
      }
    }
  } finally {
    $Archive.Dispose()
  }

  $Hasher = [Security.Cryptography.SHA256]::Create()
  $ArtifactStream = [IO.File]::OpenRead($ArtifactPath)
  try {
    $HashBytes = $Hasher.ComputeHash($ArtifactStream)
    $Hash = [BitConverter]::ToString($HashBytes).Replace('-', '').ToLowerInvariant()
  } finally {
    $ArtifactStream.Dispose()
    $Hasher.Dispose()
  }
  $ChecksumPath = "$ArtifactPath.sha256"
  Set-Content -LiteralPath $ChecksumPath -Value "$Hash  $ArtifactName" -Encoding ASCII

  $SizeMb = [math]::Round((Get-Item -LiteralPath $ArtifactPath).Length / 1MB, 2)
  Write-Host ''
  Write-Host 'Windows release package ready.' -ForegroundColor Green
  Write-Host "Artifact: $ArtifactPath"
  Write-Host "Size: $SizeMb MB"
  Write-Host "SHA256: $Hash"
  Write-Host "Commit: $Commit"
  Write-Host ''
  Write-Host 'Inside the downloaded ZIP, users see only:' -ForegroundColor DarkGray
  Write-Host '  Install Sthang Studio.bat' -ForegroundColor DarkGray
  Write-Host '  Read Me.txt' -ForegroundColor DarkGray
  Write-Host '  Sthang Studio Files\' -ForegroundColor DarkGray
} finally {
  if (Test-Path -LiteralPath $StageRoot) {
    Remove-Item -LiteralPath $StageRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

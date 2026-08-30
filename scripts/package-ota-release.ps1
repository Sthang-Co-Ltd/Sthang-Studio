param(
  [switch]$SkipValidation,
  [string]$ReleaseNotesFile
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$Package = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
$Version = [string]$Package.version
if ($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$') { throw 'package.json does not contain a valid release version.' }

if (-not $SkipValidation) {
  foreach ($Command in @('test:public','check:public','test:updater','typecheck','build')) {
    & npm.cmd run $Command
    if ($LASTEXITCODE -ne 0) { throw "$Command failed." }
  }
}
$TrackedChanges = (& git status --porcelain --untracked-files=no) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Git status could not be read.' }
if ($TrackedChanges.Trim()) { throw 'Tracked files must be clean before packaging an OTA candidate.' }

$Output = Join-Path $Root 'release-artifacts'
$Stage = Join-Path ([IO.Path]::GetTempPath()) ('Sthang-Studio-OTA-' + [Guid]::NewGuid().ToString('N'))
$Source = Join-Path $Stage 'source'
$PayloadZip = Join-Path $Stage 'payload.zip'
New-Item -ItemType Directory -Path $Output -Force | Out-Null
New-Item -ItemType Directory -Path $Source -Force | Out-Null
try {
  $Paths = @(
    'apps','packages','local-timing','scripts','config','.sthang','.env.example',
    'package.json','package-lock.json','INSTALL-NEW-PC.bat','setup-windows.bat',
    'setup-local-timing-windows.bat','run-windows.bat','STOP-STHANG-STUDIO.bat',
    'STOP-KHMER-CAPTION-STUDIO.bat','README.md','LICENSE','PRIVACY.md','SECURITY.md',
    'SUPPORT.md','THIRD_PARTY_NOTICES.md','TRADEMARKS.md'
  )
  & git archive --format=zip "--output=$PayloadZip" HEAD -- @Paths
  if ($LASTEXITCODE -ne 0) { throw 'Could not archive the reviewed OTA payload.' }
  Expand-Archive -LiteralPath $PayloadZip -DestinationPath $Source -Force

  foreach ($Protected in @('data','uploads','exports','node_modules','.venv','versions','updates','release-artifacts','.sthang-update-version.json')) {
    if (Test-Path (Join-Path $Source $Protected)) { throw "OTA payload contains protected state: $Protected" }
  }
  if (Test-Path (Join-Path $Source 'apps\server\.env')) { throw 'OTA payload contains local environment data.' }
  foreach ($Required in @('config\update-trust-root.json','scripts\update-runtime.mjs','scripts\update-protocol.mjs','scripts\launch-studio.ps1','package-lock.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Source $Required))) { throw "OTA payload is missing: $Required" }
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $Artifact = Join-Path $Output "Sthang-Studio-OTA-v$Version.zip"
  if (Test-Path $Artifact) { Remove-Item $Artifact -Force }
  [IO.Compression.ZipFile]::CreateFromDirectory($Source,$Artifact,[IO.Compression.CompressionLevel]::Optimal,$false)

  $Python = @()
  foreach ($File in Get-ChildItem (Join-Path $Source 'local-timing') -Filter 'requirements*.txt' | Sort-Object Name) {
    $Python += [ordered]@{
      path = 'local-timing/' + $File.Name
      sha256 = (Get-FileHash $File.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  if ($Python.Count -lt 1) { throw 'No Python dependency declarations were packaged.' }

  if ($ReleaseNotesFile) {
    $NotesPath = (Resolve-Path -LiteralPath $ReleaseNotesFile).Path
    $Notes = (Get-Content -LiteralPath $NotesPath -Raw).Replace("`r`n", "`n").Replace("`r", "`n").Trim()
  } else {
    $Notes = 'Unreleased Sthang Studio update candidate. Replace these bounded plain-text notes during deliberate release preparation.'
  }
  if (-not $Notes -or $Notes.Length -gt 4000 -or ($Notes -split "`n").Count -gt 40) { throw 'Release notes must be 1-4000 characters and no more than 40 lines.' }
  foreach ($Line in ($Notes -split "`n")) { if ($Line.Length -gt 240) { throw 'Each release-note line must be no more than 240 characters.' } }

  $Manifest = [ordered]@{
    schemaVersion = 1
    product = 'sthang-studio'
    platform = 'windows-x64'
    channel = 'preview'
    version = $Version
    publishedAt = (Get-Date).ToUniversalTime().ToString('o')
    releaseNotes = $Notes
    package = [ordered]@{
      url = "https://updates.sthang.app/studio/windows/v$Version/Sthang-Studio-OTA-v$Version.zip"
      sha256 = (Get-FileHash $Artifact -Algorithm SHA256).Hash.ToLowerInvariant()
      sizeBytes = (Get-Item $Artifact).Length
      unpackedSizeBytes = [long](Get-ChildItem $Source -File -Recurse -Force | Measure-Object Length -Sum).Sum
    }
    compatibility = [ordered]@{ minBrokerVersion='1.0.0'; stateSchema=1; manualInstallerRequired=$false }
    setup = [ordered]@{
      strategy = 'npm-ci-and-local-timing'
      packageLockSha256 = (Get-FileHash (Join-Path $Source 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
      pythonFiles = $Python
    }
  }
  $Unsigned = Join-Path $Output "Sthang-Studio-OTA-v$Version.release.unsigned.json"
  [IO.File]::WriteAllText($Unsigned, (($Manifest | ConvertTo-Json -Depth 10) + "`n"), $Utf8NoBom)
  $Checksum = Join-Path $Output "Sthang-Studio-OTA-v$Version.zip.sha256"
  [IO.File]::WriteAllText($Checksum, "$($Manifest.package.sha256)  $(Split-Path -Leaf $Artifact)`n", [Text.Encoding]::ASCII)

  & node (Join-Path $Root 'scripts\update-release.mjs') verify-unsigned --manifest $Unsigned --package $Artifact
  if ($LASTEXITCODE -ne 0) { throw 'The unsigned OTA candidate failed protocol verification.' }

  Write-Host "OTA package candidate: $Artifact" -ForegroundColor Green
  Write-Host "Checksum: $Checksum" -ForegroundColor Green
  Write-Host "Unsigned manifest: $Unsigned" -ForegroundColor Yellow
  Write-Host 'No release was signed, uploaded, published, or promoted.' -ForegroundColor DarkGray
} finally {
  if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force -ErrorAction SilentlyContinue }
}

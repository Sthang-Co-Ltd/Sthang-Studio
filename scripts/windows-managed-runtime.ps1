# Shared app-private Python provisioning. Dot-source only; no global PATH writes.
# Reviewed candidate bytes still require native Windows acceptance before release.
$env:ORT_DISABLE_TELEMETRY = '1'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$env:DO_NOT_TRACK = '1'
$StudioPythonVersion = '3.12.15'
$StudioPythonRelease = '20261003'
$StudioPythonArchive = 'cpython-3.12.15+20261003-x86_64-pc-windows-msvc-install_only.tar.gz'
$StudioPythonUrl = 'https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.12.15%2B20261003-x86_64-pc-windows-msvc-install_only.tar.gz'
$StudioPythonSha256 = '4b6f0beebbb695a0f3ea237b8c3eaa5bd424f47a7bc25b2fbe3a43390c770f08'

function Test-StudioPython([string]$Python) {
  if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) { return $false }
  try {
    & $Python -c "import ensurepip,platform,ssl,struct,sys,venv; assert (3,12,15) <= sys.version_info[:3] < (3,13,0); assert struct.calcsize('P')==8; assert platform.machine().lower() in ('amd64','x86_64')" *> $null
    return $LASTEXITCODE -eq 0
  } catch { return $false }
}

function Get-StudioManagedPython {
  if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Sthang Studio requires native x64 Windows.' }
  $LocalBase = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:USERPROFILE }
  $Tools = Join-Path $LocalBase 'Sthang Studio\tools'
  $Target = Join-Path $Tools "python-$StudioPythonVersion-$StudioPythonRelease"
  $Python = Join-Path $Target 'python.exe'
  if (Test-StudioPython $Python) { return $Python }
  $Work = Join-Path $Tools ('.install-python-' + [Guid]::NewGuid().ToString('N'))
  $Archive = Join-Path $Work $StudioPythonArchive
  $Extract = Join-Path $Work 'extract'
  $Candidate = Join-Path $Extract 'python'
  $Backup = $Target + '.previous-' + [Guid]::NewGuid().ToString('N')
  $HadPrevious = $false
  New-Item -ItemType Directory -Path $Extract -Force | Out-Null
  try {
    Write-Host "Downloading app-private Python $StudioPythonVersion..."
    $Curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($Curl) {
      & $Curl.Source --fail --location --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 1800 --output $Archive $StudioPythonUrl
      if ($LASTEXITCODE -ne 0) { throw 'The private Python download failed.' }
    } else {
      Invoke-WebRequest -Uri $StudioPythonUrl -OutFile $Archive -UseBasicParsing -TimeoutSec 1800
    }
    if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $StudioPythonSha256) {
      throw 'The private Python archive failed SHA-256 verification.'
    }
    # tar.exe is supplied by supported Windows; no developer/compiler prerequisite.
    $Tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path -LiteralPath $Tar)) { throw 'Windows tar.exe is unavailable. Install current Windows updates, then retry.' }
    & $Tar -xzf $Archive -C $Extract
    if ($LASTEXITCODE -ne 0) { throw 'The private Python archive could not be extracted.' }
    if (-not (Test-StudioPython (Join-Path $Candidate 'python.exe'))) { throw 'The verified Python candidate failed native x64/SSL/venv validation.' }
    if (Test-Path -LiteralPath $Target) {
      Move-Item -LiteralPath $Target -Destination $Backup
      $HadPrevious = $true
    }
    try {
      Move-Item -LiteralPath $Candidate -Destination $Target
      if (-not (Test-StudioPython $Python)) { throw 'Private Python failed final-path validation.' }
    } catch {
      if (Test-Path -LiteralPath $Target) { Move-Item -LiteralPath $Target -Destination $Candidate }
      if ($HadPrevious) { Move-Item -LiteralPath $Backup -Destination $Target }
      throw
    }
    return $Python
  } finally {
    if (Test-Path -LiteralPath $Work) { Remove-Item -LiteralPath $Work -Recurse -Force }
  }
}

$StudioNodeVersion = '24.21.0'
$StudioNodeSha256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'

function Test-StudioNode([string]$Node) {
  if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { return $false }
  try {
    & $Node -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major === 24 && minor >= 21 && process.arch === 'x64' ? 0 : 1)" *> $null
    return $LASTEXITCODE -eq 0
  } catch { return $false }
}

function Get-StudioManagedNode([switch]$NoDownload) {
  $LocalBase = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:USERPROFILE }
  $Tools = Join-Path $LocalBase 'Sthang Studio\tools'
  $ArchiveName = "node-v$StudioNodeVersion-win-x64.zip"
  $Target = Join-Path $Tools "node-v$StudioNodeVersion-win-x64"
  $Node = Join-Path $Target 'node.exe'
  if ((Test-StudioNode $Node) -and (Test-Path -LiteralPath (Join-Path $Target 'npm.cmd'))) { return $Node }
  if ($NoDownload) { throw 'The reviewed private Node runtime is missing or outdated. Run INSTALL-NEW-PC.bat to repair it.' }
  if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Sthang Studio requires native x64 Windows.' }
  $Work = Join-Path $Tools ('.install-node-' + [Guid]::NewGuid().ToString('N'))
  $Archive = Join-Path $Work $ArchiveName
  $Extract = Join-Path $Work 'extract'
  $Candidate = Join-Path $Extract "node-v$StudioNodeVersion-win-x64"
  $Backup = $Target + '.previous-' + [Guid]::NewGuid().ToString('N')
  $HadPrevious = $false
  New-Item -ItemType Directory -Path $Extract -Force | Out-Null
  try {
    Write-Host "Downloading app-private Node.js $StudioNodeVersion..."
    $Url = "https://nodejs.org/dist/v$StudioNodeVersion/$ArchiveName"
    $Curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($Curl) {
      & $Curl.Source --fail --location --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 1800 --output $Archive $Url
      if ($LASTEXITCODE -ne 0) { throw 'The private Node download failed.' }
    } else { Invoke-WebRequest -Uri $Url -OutFile $Archive -UseBasicParsing -TimeoutSec 1800 }
    if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $StudioNodeSha256) { throw 'The private Node archive failed SHA-256 verification.' }
    Expand-Archive -LiteralPath $Archive -DestinationPath $Extract
    if (-not (Test-StudioNode (Join-Path $Candidate 'node.exe')) -or -not (Test-Path -LiteralPath (Join-Path $Candidate 'npm.cmd'))) { throw 'The verified Node candidate failed native x64/security-floor validation.' }
    if (Test-Path -LiteralPath $Target) { Move-Item -LiteralPath $Target -Destination $Backup; $HadPrevious = $true }
    try {
      Move-Item -LiteralPath $Candidate -Destination $Target
      if (-not (Test-StudioNode $Node)) { throw 'Private Node failed final-path validation.' }
    } catch {
      if (Test-Path -LiteralPath $Target) { Move-Item -LiteralPath $Target -Destination $Candidate }
      if ($HadPrevious) { Move-Item -LiteralPath $Backup -Destination $Target }
      throw
    }
    return $Node
  } finally {
    if (Test-Path -LiteralPath $Work) { Remove-Item -LiteralPath $Work -Recurse -Force }
  }
}

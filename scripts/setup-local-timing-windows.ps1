$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
$env:ORT_DISABLE_TELEMETRY = '1'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$env:DO_NOT_TRACK = '1'
$env:PYTHONUTF8 = '1'
try {
  . (Join-Path $PSScriptRoot 'windows-managed-runtime.ps1')
  # Released brokers call this step directly, before candidate build/typecheck.
  # Prepare their subsequent bounded Node re-exec without changing global PATH.
  $ReviewedNode = Get-StudioManagedNode
  $Python = Get-StudioManagedPython
  & $Python (Join-Path $PSScriptRoot 'provision-timing.py') --profile windows-py312-x64
  if ($LASTEXITCODE -ne 0) { throw 'The reviewed timing environment could not be prepared. Existing timing files were retained.' }
  exit 0
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}

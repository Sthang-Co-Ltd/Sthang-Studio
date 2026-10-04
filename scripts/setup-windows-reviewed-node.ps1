$ErrorActionPreference = 'Stop'
try {
  . (Join-Path $PSScriptRoot 'windows-managed-runtime.ps1')
  $Node = Get-StudioManagedNode
  $env:Path = (Split-Path -Parent $Node) + ';' + $env:Path
  $env:STHANG_STUDIO_NODE_READY = '1'
  & $env:ComSpec /d /c ('"' + (Join-Path (Split-Path -Parent $PSScriptRoot) 'setup-windows.bat') + '"')
  exit $LASTEXITCODE
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}

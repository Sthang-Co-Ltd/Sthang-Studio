function Expand-StudioArchive {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$LiteralPath,
    [Parameter(Mandatory)][string]$DestinationPath,
    [switch]$Force
  )

  if ($PSVersionTable.PSEdition -eq 'Core') {
    Microsoft.PowerShell.Archive\Expand-Archive -LiteralPath $LiteralPath -DestinationPath $DestinationPath -Force:$Force -ErrorAction $ErrorActionPreference
    return
  }

  # A pwsh parent can leave its .NET-incompatible Archive module on PSModulePath.
  $Inbox = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Archive\Microsoft.PowerShell.Archive.psd1'
  if (-not (Test-Path -LiteralPath $Inbox -PathType Leaf)) {
    throw "Windows PowerShell's built-in archive module is missing."
  }
  $InboxFolder = Split-Path -Parent $Inbox
  $Module = Import-Module -Name $Inbox -PassThru -ErrorAction Stop
  $Expand = $Module.ExportedCommands['Expand-Archive']
  if (-not $Expand -or -not $Expand.Module -or $Expand.Module.ModuleBase -ne $InboxFolder) {
    throw "Windows PowerShell could not resolve its built-in archive command."
  }

  & $Expand -LiteralPath $LiteralPath -DestinationPath $DestinationPath -Force:$Force -ErrorAction $ErrorActionPreference
}

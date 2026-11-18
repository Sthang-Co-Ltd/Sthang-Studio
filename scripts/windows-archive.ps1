function Expand-StudioArchive {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$LiteralPath,
    [Parameter(Mandatory)][string]$DestinationPath,
    [switch]$Force
  )

  if ($PSVersionTable.PSEdition -ne 'Core') {
    # A pwsh parent can leave its .NET-incompatible Archive module on PSModulePath.
    $Inbox = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Archive\Microsoft.PowerShell.Archive.psd1'
    if (-not (Test-Path -LiteralPath $Inbox -PathType Leaf)) {
      throw "Windows PowerShell's built-in archive module is missing."
    }
    $InboxFolder = Split-Path -Parent $Inbox
    Get-Module -Name Microsoft.PowerShell.Archive |
      Where-Object { $_.ModuleBase -ne $InboxFolder } |
      Remove-Module -ErrorAction Stop
    Import-Module -Name $Inbox -ErrorAction Stop

    $Expand = Get-Command -Name Microsoft.PowerShell.Archive\Expand-Archive -ErrorAction Stop
    if ($Expand.Module.ModuleBase -ne $InboxFolder) {
      throw "Windows PowerShell could not resolve its built-in archive command."
    }
  }

  Microsoft.PowerShell.Archive\Expand-Archive -LiteralPath $LiteralPath -DestinationPath $DestinationPath -Force:$Force
}

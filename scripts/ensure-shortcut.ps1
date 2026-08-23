$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Desktop = [Environment]::GetFolderPath('Desktop')
if (-not $Desktop) { exit 0 }

$Shell = New-Object -ComObject WScript.Shell
$Target = Join-Path $Root 'run-windows.bat'
$ShortcutPath = Join-Path $Desktop 'Sthang Studio.lnk'
$Icon = Join-Path $Root 'apps\web\public\brand\sthang-studio.ico'

$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $Target
$Shortcut.WorkingDirectory = $Root
$Shortcut.Description = 'Launch Sthang Studio — short-form video finishing workspace'
if (Test-Path $Icon) { $Shortcut.IconLocation = "$Icon,0" }
$Shortcut.Save()

# Remove only the legacy shortcut that points to this same installation.
$LegacyPath = Join-Path $Desktop 'Khmer Caption Studio.lnk'
if (Test-Path $LegacyPath) {
  try {
    $Legacy = $Shell.CreateShortcut($LegacyPath)
    if ([string]::Equals($Legacy.TargetPath, $Target, [System.StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item $LegacyPath -Force
    }
  } catch { }
}

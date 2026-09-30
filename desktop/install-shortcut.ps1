# Creates a "TrendScope" shortcut in the Start Menu (and optionally the Desktop),
# pointing at start-trendscope.bat and using the generated icon.
#
# This is deliberately OPT-IN: nothing in the app, the npm scripts or the test suite
# writes to your Start Menu or Desktop. Run it once if you want the icon in the shell:
#   powershell -NoProfile -ExecutionPolicy Bypass -File desktop\install-shortcut.ps1
# Add -Desktop to also drop one on the Desktop.
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
param(
  [switch]$Desktop
)

$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "desktop\bin\TrendScope.exe"
$bat = Join-Path $root "start-trendscope.bat"
$ico = Join-Path $root "src-tauri\icons\icon.ico"

# Prefer the native exe (that is the "desktop program" experience: open and go).
# Fall back to the .bat, which also installs deps and rebuilds.
if (Test-Path $exe) { $target = $exe } else { $target = $bat }
if (-not (Test-Path $target)) { Write-Error "nothing to point at: $target missing"; exit 1 }
if (-not (Test-Path $ico)) { Write-Error "missing $ico - run: npx tauri icon desktop\icon-source.png"; exit 1 }

$shell = New-Object -ComObject WScript.Shell

function Make-Shortcut([string]$dir) {
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $path = Join-Path $dir "TrendScope.lnk"
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $target
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = $ico
  $lnk.Description = "TrendScope - local trend and topic workbench"
  $lnk.Save()
  Write-Host ("created: " + $path + "  ->  " + $target)
}

$programs = [Environment]::GetFolderPath("Programs")
Make-Shortcut $programs

if ($Desktop) {
  $desk = [Environment]::GetFolderPath("Desktop")
  Make-Shortcut $desk
}

Write-Host "Done. Look for 'TrendScope' in the Start Menu."

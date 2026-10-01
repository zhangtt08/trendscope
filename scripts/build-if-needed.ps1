#requires -Version 5.1
<#
.SYNOPSIS
    TrendScope - build only when the sources are newer than the last successful build.

.DESCRIPTION
    start-trendscope.bat used to run "npm run build" (tsc -p tsconfig.server.json
    + tsc --noEmit + vite build) on every single launch, which dominated startup time
    even when nothing had changed.

    This script records a build stamp (dist\.build-stamp) after every successful
    build and compares the newest build input against that stamp.

    A timestamp heuristic over the output files themselves does NOT work here:
    vite copies everything in public\ into dist\ while preserving the source
    mtime, so "oldest file in dist\" is always public\'s favicon.ico and the
    check can never report "up to date". The stamp is written by us, so it is
    immune to whatever the bundler does to file times.

    Safety checks that still force a rebuild:
      * no stamp file (never built, or dist\ was deleted)
      * dist\index.html or dist-server\index.js missing (partial build)
      * any expected build input missing

.PARAMETER CheckOnly
    Report the decision but never build.
    Exit 0 = up to date, 2 = rebuild needed, 1 = internal error.

.PARAMETER Force
    Rebuild even when everything is up to date.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-if-needed.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-if-needed.ps1 -CheckOnly
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-if-needed.ps1 -Force
#>
[CmdletBinding()]
param(
    [switch] $CheckOnly,
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

# Build inputs. 'scripts' is deliberately excluded: it holds tsx-run helpers that
# are not compiled into dist\, and including it would make this file's own
# timestamp trigger an endless rebuild loop.
$inputPaths = @(
    'src',
    'server',
    'public',
    'drizzle',
    'index.html',
    'package.json',
    'tsconfig.json',
    'tsconfig.server.json',
    'vite.config.ts',
    'vitest.config.ts',
    'drizzle.config.ts'
)
$stampPath = 'dist\.build-stamp'
$entryPoints = @('dist\index.html', 'dist-server\index.js')

function Get-NewestWriteTime {
    param([string[]] $Paths)

    $newest = $null
    foreach ($p in $Paths) {
        if (-not (Test-Path -LiteralPath $p)) { continue }
        $item = Get-Item -LiteralPath $p
        if ($item.PSIsContainer) {
            $files = Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue
            if (-not $files) { continue }
            $max = ($files | Measure-Object -Property LastWriteTime -Maximum).Maximum
        }
        else {
            $max = $item.LastWriteTime
        }
        if ($null -ne $max -and ($null -eq $newest -or $max -gt $newest)) { $newest = $max }
    }
    return $newest
}

$missingInputs = @($inputPaths | Where-Object { -not (Test-Path -LiteralPath $_) })
$missingEntries = @($entryPoints | Where-Object { -not (Test-Path -LiteralPath $_) })
$newestInput = Get-NewestWriteTime -Paths $inputPaths
$stampTime = $null
if (Test-Path -LiteralPath $stampPath) {
    $stampTime = (Get-Item -LiteralPath $stampPath).LastWriteTime
}

$reason = $null
if ($Force) {
    $reason = 'forced by -Force'
}
elseif ($missingInputs.Count) {
    $reason = "expected build input is missing: $($missingInputs -join ', ')"
}
elseif ($missingEntries.Count) {
    $reason = "build output looks incomplete: $($missingEntries -join ', ')"
}
elseif ($null -eq $stampTime) {
    $reason = 'no build stamp found (never built, or dist\ was removed)'
}
elseif ($null -eq $newestInput) {
    $reason = 'could not determine the newest source timestamp'
}
elseif ($newestInput -gt $stampTime) {
    $reason = ('sources changed at {0}, last build was {1}' -f `
        $newestInput.ToString('yyyy-MM-dd HH:mm:ss'), $stampTime.ToString('yyyy-MM-dd HH:mm:ss'))
}

if (-not $reason) {
    Write-Host ('[build] Up to date - last build {0}, newest source {1}.' -f `
        $stampTime.ToString('yyyy-MM-dd HH:mm:ss'), $newestInput.ToString('yyyy-MM-dd HH:mm:ss'))
    Write-Host '[build] Skipping rebuild. Delete dist\ to force one.'
    exit 0
}

Write-Host "[build] Rebuild required: $reason"
if ($CheckOnly) { exit 2 }

Write-Host '[build] Running: npm run build ...'
& npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[build] npm run build failed with exit code $LASTEXITCODE."
    Write-Host '[build] Stamp NOT written, so the next launch will retry the build.'
    exit $LASTEXITCODE
}

foreach ($entry in $entryPoints) {
    if (-not (Test-Path -LiteralPath $entry)) {
        Write-Host "[build] Build reported success but $entry is missing; not stamping."
        exit 1
    }
}

$head = 'unknown'
try { $head = (& git rev-parse --short HEAD 2>$null) } catch { $head = 'unknown' }
if (-not $head) { $head = 'unknown' }
$stampBody = @(
    "built-at   : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    "git-head   : $head"
    "inputs     : $($inputPaths -join ', ')"
) -join [Environment]::NewLine
Set-Content -LiteralPath $stampPath -Value $stampBody -Encoding ASCII
Write-Host "[build] Done. Stamp written to $stampPath (git $head)."
exit 0

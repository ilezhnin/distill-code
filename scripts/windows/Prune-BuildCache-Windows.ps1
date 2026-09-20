<#
.SYNOPSIS
    Reclaim disk from the Rust/Tauri build cache without touching the toolchain.

.DESCRIPTION
    `Cleanup-Windows.ps1` is the uninstall lane: it removes node_modules, git
    hooks and (with -All) the shared toolchain, so it is the wrong tool for
    "the debug build ate the drive again". This script only reclaims build
    output and dead state, and leaves everything needed to build:

      - legacy %LOCALAPPDATA%\berd-tauri (pre-2026-09 cargo target; nothing
        writes there any more)
      - the dead %LOCALAPPDATA%\distill-dev\goose build directory (the Goose
        backend is gone, replaced by the in-app Rust ACP host). Other
        goose* directories are only reported, never removed.
      - interrupted-build leftovers in <target>\debug\deps\.tmp*
      - <target>\debug\incremental (rebuilt on the next build, slower once)
      - with -Deep, the whole cargo target dir (full rebuild, ~10-30 min)

    Default mode is a dry run; pass -Remove to actually delete.

.PARAMETER Remove
    Delete instead of reporting.

.PARAMETER Deep
    Also drop the entire cargo target dir, not just incremental/temp state.

.EXAMPLE
    just prune-build-cache
    just prune-build-cache -Remove
    just prune-build-cache -Remove -Deep
#>
[CmdletBinding()]
param(
    [switch]$Remove,
    [switch]$Deep
)

$ErrorActionPreference = "Stop"
trap {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking

Assert-WindowsHost
Set-Location (Get-DistillRepoRoot)

$script:Reclaimed = 0L

function Get-PathSize {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return -1L }
    $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue |
        Measure-Object -Sum Length).Sum
    if ($null -eq $sum) { return 0L }
    return [int64]$sum
}

function Format-Size {
    param([Parameter(Mandatory = $true)][int64]$Bytes)
    if ($Bytes -ge 1GB) { return "{0:N2} GB" -f ($Bytes / 1GB) }
    return "{0:N1} MB" -f ($Bytes / 1MB)
}

function Invoke-Prune {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [AllowNull()][AllowEmptyString()][string]$Path
    )
    if ([string]::IsNullOrWhiteSpace($Path)) {
        Write-Host "absent  $Name" -ForegroundColor DarkGray
        return
    }
    $size = Get-PathSize -Path $Path
    if ($size -lt 0) {
        Write-Host "absent  $Name - $Path" -ForegroundColor DarkGray
        return
    }
    $script:Reclaimed += $size
    if (-not $Remove) {
        Write-Host ("would   {0} - {1} ({2})" -f $Name, $Path, (Format-Size $size)) -ForegroundColor Yellow
        return
    }
    try {
        # The target dir comes from DISTILL_TAURI_CARGO_TARGET_DIR when set, so a
        # mistyped override (a drive root, the user profile, the repo itself,
        # a relative path) must not become a recursive delete under -Deep.
        Assert-SafeCleanupPath -Path $Path -AllowedRoot $Path
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
        Write-Host ("removed {0} - {1} ({2})" -f $Name, $Path, (Format-Size $size)) -ForegroundColor Green
    } catch {
        $script:Reclaimed -= $size
        Write-Host ("failed  {0} - {1}: {2}" -f $Name, $Path, $_.Exception.Message) -ForegroundColor Red
    }
}

$targetDir = Get-TauriCargoTargetDir
$devRoot = Get-DistillDevRoot

Write-WindowsDevSection ("Build cache prune (" + $(if ($Remove) { "remove" } else { "dry run" }) + ")")
Write-WindowsDevInfo "cargo target dir: $targetDir"
if (Test-PathOnSystemDrive $targetDir) {
    Write-Host ("This target dir is on the system drive. Set DISTILL_TAURI_CARGO_TARGET_DIR to a path on " +
        "another drive (user-level env var) so future builds land there.") -ForegroundColor Yellow
}
if (-not $Remove) {
    Write-WindowsDevInfo "Dry run. Re-run with -Remove to delete (add -Deep to drop the whole target dir)."
}

Write-WindowsDevSection "Dead state from earlier layouts"
Invoke-Prune -Name "legacy Tauri cargo target" -Path (Get-LegacyTauriCargoTargetRoot)
# Only the exact managed-build directory, never a "goose*" glob: names like
# goose-dirty-backup-<date> are hand-made backups, and a prune script has no
# business deciding those are disposable. They get reported, not removed.
Invoke-Prune -Name "dead Goose backend build" -Path (Join-Path $devRoot "goose")
foreach ($other in @(Get-ChildItem -LiteralPath $devRoot -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "goose*" -and $_.Name -ne "goose" })) {
    Write-Host ("keep    unrecognized Goose-era directory - {0} ({1}); delete it yourself if you do not want it" -f
        $other.FullName, (Format-Size (Get-PathSize -Path $other.FullName))) -ForegroundColor DarkGray
}

Write-WindowsDevSection "Reclaimable build output"
# A live build owns the temp archives and incremental dirs this section
# deletes, so pulling them out from under it corrupts the build rather
# than just slowing it down.
$busy = @(Get-Process -Name cargo, rustc, Distill -ErrorAction SilentlyContinue)
if ($Remove -and $busy.Count -gt 0) {
    throw ("A build or the app is still running (" + (($busy | ForEach-Object { $_.ProcessName }) -join ", ") +
        "). Close it, then rerun.")
}
if ($Deep) {
    Invoke-Prune -Name "cargo target dir" -Path $targetDir
} else {
    $debugDir = Join-Path $targetDir "debug"
    Invoke-Prune -Name "incremental cache" -Path (Join-Path $debugDir "incremental")
    # `.tmp*.temp-archive` dirs under deps are half-written static archives an
    # interrupted link left behind; cargo never reuses them and never cleans
    # them up (multiple GB each for distill_lib / sherpa-onnx).
    foreach ($tmp in @(Get-ChildItem -LiteralPath (Join-Path $debugDir "deps") -Directory -Force -Filter ".tmp*" -ErrorAction SilentlyContinue)) {
        Invoke-Prune -Name "interrupted-build leftovers" -Path $tmp.FullName
    }
}

Write-WindowsDevSection "Summary"
$verb = if ($Remove) { "Reclaimed" } else { "Reclaimable" }
Write-Host ("{0}: {1}" -f $verb, (Format-Size $script:Reclaimed)) -ForegroundColor Cyan
if (-not $Deep) {
    Write-WindowsDevInfo "Add -Deep to also drop the whole target dir (forces a full rebuild)."
}

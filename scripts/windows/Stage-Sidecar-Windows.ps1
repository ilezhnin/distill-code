# Stage native Windows sidecars for Tauri's externalBin bundling.
#
# Mirrors the Unix scripts/prepare-*-sidecar.sh flow, but stages real
# `<stem>-<triple>.exe` files and validates each as a PE image of the target
# architecture instead of relying on chmod/-x (a no-op on Windows).
#
# The same script is invoked by dev and release. -Triple makes the target an
# explicit shared input: the caller passes the exact triple it hands Tauri via
# --target so the staged `<stem>-<triple>.exe` names cannot diverge from what
# Tauri resolves. When omitted it defaults to the Rust host triple, matching a
# hostless `tauri build`.
param(
    [string]$Triple
)

$ErrorActionPreference = "Stop"
trap {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking

Assert-WindowsHost
Set-Location (Get-DistillRepoRoot)
Update-SessionPathFromRegistry
Assert-MsvcEnvironment

# Tauri resolves externalBin against the build's target triple. Prefer the
# explicit -Triple the caller hands `tauri build --target`; fall back to the
# Rust host triple for a hostless build.
if ([string]::IsNullOrWhiteSpace($Triple)) {
    $Triple = Get-RustHostTriple
}
if ([string]::IsNullOrWhiteSpace($Triple)) {
    throw "Could not determine the Rust target triple for sidecar staging."
}
if ($null -eq (Get-WindowsTripleMachine -Triple $Triple)) {
    throw "Triple '$Triple' is not a supported Windows sidecar target."
}
Write-WindowsDevInfo "Staging Windows sidecars for target: $Triple"

$binDir = Join-Path (Join-Path (Get-DistillRepoRoot) "src-tauri") "binaries"

# ── distillctl ──────────────────────────────────────────────────
# Build the workspace crate for the target triple, then stage its .exe. Cargo
# writes to the Tauri target dir the rest of the build shares. Passing --target
# nests the output under the triple, matching the Unix script's behaviour when
# an explicit triple is supplied.
$tauriTargetDir = Get-TauriCargoTargetDir
$env:CARGO_TARGET_DIR = $tauriTargetDir
$hostTriple = Get-RustHostTriple
$cargoArgs = @("build", "-p", "distillctl", "-p", "distill-monitor", "--release")
if (-not [string]::IsNullOrWhiteSpace($hostTriple) -and $Triple -ne $hostTriple) {
    $cargoArgs += @("--target", $Triple)
    $distillctlReleaseDir = Join-Path (Join-Path $tauriTargetDir $Triple) "release"
} else {
    $distillctlReleaseDir = Join-Path $tauriTargetDir "release"
}
Invoke-CheckedCommand -FilePath "cargo" -ArgumentList $cargoArgs `
    -WorkingDirectory (Join-Path (Get-DistillRepoRoot) "src-tauri") -Label "cargo build -p distillctl -p distill-monitor --release"
$distillctlSource = Join-Path $distillctlReleaseDir (Get-WindowsExeName "distillctl")
$staged = Stage-WindowsSidecar -SourcePath $distillctlSource -Triple $Triple -Stem "distillctl" -BinDir $binDir
Write-WindowsDevInfo "Staged distillctl sidecar: $staged"

# ── distill-monitor ─────────────────────────────────────────────
$monitorSource = Join-Path $distillctlReleaseDir (Get-WindowsExeName "distill-monitor")
$staged = Stage-WindowsSidecar -SourcePath $monitorSource -Triple $Triple -Stem "distill-monitor" -BinDir $binDir
Write-WindowsDevInfo "Staged distill-monitor sidecar: $staged"

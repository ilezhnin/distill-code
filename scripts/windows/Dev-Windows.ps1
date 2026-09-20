$ErrorActionPreference = "Stop"
$global:LASTEXITCODE = 0
trap {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking

Assert-WindowsHost
Set-Location (Get-DistillRepoRoot)
Update-SessionPathFromRegistry
Assert-MsvcEnvironment
Initialize-FnmEnvironment | Out-Null
Initialize-PublicNpmEnvironment
Update-SessionPathFromRegistry

& (Join-Path $PSScriptRoot "Setup-Windows.ps1")
if ($LASTEXITCODE -ne 0) {
    throw "Setup-Windows.ps1 failed with exit code $LASTEXITCODE."
}
$pnpm = Get-PnpmCommand
if ([string]::IsNullOrWhiteSpace($pnpm)) {
    throw "pnpm is not available. Run 'just bootstrap-windows install', open a new PowerShell, then retry."
}

$env:VITE_PORT = [string](Get-StableVitePort)
$env:VITE_DESIGN_SYSTEM_EXPLORER = "1"
if ([string]::IsNullOrWhiteSpace($env:RUST_LOG)) {
    $env:RUST_LOG = "perf=debug,info"
}
$tauriCargoTargetDir = Get-TauriCargoTargetDir
$env:CARGO_TARGET_DIR = $tauriCargoTargetDir
Write-WindowsDevInfo "Using Vite port: $env:VITE_PORT"
Write-WindowsDevInfo "Using Tauri Cargo target dir: $env:CARGO_TARGET_DIR"

$E2eMode = $env:DISTILL_E2E_MODE -eq "1"
if ($E2eMode) {
    if ([string]::IsNullOrWhiteSpace($env:DISTILL_E2E_RUN_ROOT)) {
        throw "DISTILL_E2E_RUN_ROOT is required when DISTILL_E2E_MODE=1."
    }
    $e2e = New-E2eRunContract `
        -RunRoot $env:DISTILL_E2E_RUN_ROOT `
        -RunId $env:DISTILL_E2E_RUN_ID `
        -DriverToken $env:APP_TEST_DRIVER_TOKEN
    $env:DISTILL_E2E_RUN_ROOT = $e2e.RunRoot
    $env:DISTILL_E2E_RUN_ID = $e2e.RunId
    $env:APP_TEST_DRIVER_TOKEN = $e2e.DriverToken
    [Environment]::SetEnvironmentVariable("APP_TEST_DRIVER_PORT", $null, "Process")
    New-Item -ItemType Directory -Force -Path $e2e.RunRoot | Out-Null

    $runtimeConfigPath = $null
    if (-not [string]::IsNullOrWhiteSpace($env:DISTILL_E2E_RUNTIME_CONFIG)) {
        if (-not (Test-Path $env:DISTILL_E2E_RUNTIME_CONFIG -PathType Leaf)) {
            throw "DISTILL_E2E_RUNTIME_CONFIG must reference an existing JSON file."
        }
        $runtimeConfigPath = Join-Path $e2e.RunRoot "runtime-config.json"
        if ((Normalize-FullPath $env:DISTILL_E2E_RUNTIME_CONFIG) -ne (Normalize-FullPath $runtimeConfigPath)) {
            Copy-Item -LiteralPath $env:DISTILL_E2E_RUNTIME_CONFIG -Destination $runtimeConfigPath
        }
        Get-Content -LiteralPath $runtimeConfigPath -Raw | ConvertFrom-Json | Out-Null
        $env:DISTILL_E2E_RUNTIME_CONFIG = $runtimeConfigPath
    }

    Remove-Item -LiteralPath $e2e.DriverReadyPath -Force -ErrorAction SilentlyContinue
    Write-WindowsDevInfo "Using isolated E2E run root: $($e2e.RunRoot)"
    Write-WindowsDevInfo "Using isolated E2E identifier: $($e2e.Identifier)"
    Write-WindowsDevInfo "App test driver will publish readiness at: $($e2e.DriverReadyPath)"
}

$version = Resolve-AppVersion
$env:VITE_APP_VERSION = $version.RichVersion
Write-WindowsDevInfo "Using app version: $($version.Version) ($($version.RichVersion))"

$distillctlArgs = @("build", "-p", "distillctl")
Invoke-CheckedCommand -FilePath "cargo" -ArgumentList $distillctlArgs -WorkingDirectory (Join-Path (Get-DistillRepoRoot) "src-tauri") -Label "cargo build distillctl"
$env:DISTILLCTL_BIN = Join-Path (Join-Path $env:CARGO_TARGET_DIR "debug") "distillctl.exe"
if (-not (Test-Path $env:DISTILLCTL_BIN -PathType Leaf)) {
    throw "Expected distillctl.exe at $env:DISTILLCTL_BIN after cargo build."
}
Write-WindowsDevInfo "Using distillctl CLI: $env:DISTILLCTL_BIN"

Invoke-CheckedCommand -FilePath "cargo" -ArgumentList @("build", "-p", "distill-monitor") -WorkingDirectory (Join-Path (Get-DistillRepoRoot) "src-tauri") -Label "cargo build distill-monitor"
$env:DISTILL_MONITOR_BIN = Join-Path (Join-Path $env:CARGO_TARGET_DIR "debug") "distill-monitor.exe"
if (-not (Test-Path $env:DISTILL_MONITOR_BIN -PathType Leaf)) {
    throw "Expected distill-monitor.exe at $env:DISTILL_MONITOR_BIN after cargo build."
}
Write-WindowsDevInfo "Using distill-monitor CLI: $env:DISTILL_MONITOR_BIN"

$env:CARGO_TARGET_DIR = $tauriCargoTargetDir

$distroDir = Join-Path (Get-DistillRepoRoot) "distro"
if ([string]::IsNullOrWhiteSpace($env:DISTILL_DISTRO_DIR) -and (Test-Path $distroDir -PathType Container)) {
    $env:DISTILL_DISTRO_DIR = $distroDir
    Write-WindowsDevInfo "Using distro dir: $env:DISTILL_DISTRO_DIR"
}

# Fail fast if a previous run's vite survived: tauri only kills its direct
# child on Windows (cmd -> pnpm.cmd -> node), so an abnormal exit can leave
# vite holding this checkout's deterministic port and --strictPort would die
# mid-startup with a less actionable error.
if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    $portListener = Get-NetTCPConnection -LocalPort ([int]$env:VITE_PORT) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $portListener) {
        throw "Port $env:VITE_PORT is already in use by PID $($portListener.OwningProcess) (likely an orphaned vite from a previous dev run). Stop it with: Stop-Process -Id $($portListener.OwningProcess)"
    }
}

# Use the resolved shim's bare name (pnpm.cmd / pnpm.exe): it is on PATH by
# construction (Get-PnpmCommand found it there), and a bare name sidesteps
# cmd.exe quote-stripping issues that a full path with spaces would hit inside
# tauri's beforeDevCommand.
$pnpmShimName = Split-Path -Leaf $pnpm
$devConfig = @{
    version = $version.Version
    build = @{
        devUrl = "http://localhost:$env:VITE_PORT"
        beforeDevCommand = @{
            script = "$pnpmShimName exec vite --port $env:VITE_PORT --strictPort"
            cwd = ".."
            wait = $false
        }
    }
}
if ($E2eMode) {
    $devConfig.identifier = $e2e.Identifier
    $devConfig.productName = "Distill E2E ($($e2e.RunId))"
}
$devConfigPath = if ($E2eMode) {
    $e2e.ConfigPath
} else {
    Join-Path (Get-DistillDevRoot) "tauri-dev-windows.config.json"
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $devConfigPath) | Out-Null
# Write without a BOM: Windows PowerShell's `Set-Content -Encoding UTF8` adds
# one, and Tauri's serde-based --config parsing rejects BOM-prefixed JSON.
$devConfigJson = $devConfig | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($devConfigPath, $devConfigJson, [System.Text.UTF8Encoding]::new($false))
Write-WindowsDevInfo "Using Tauri dev config: $devConfigPath"

$tauriArguments = @(
    "exec", "tauri", "dev",
    "--features", (Get-DistillAppFeatures),
    "--config", "src-tauri/tauri.dev.conf.json",
    "--config", $devConfigPath
)
# E2E needs one stable native launch. Plugin build scripts generate files
# under src-tauri, so the ordinary dev watcher can otherwise invalidate its
# own in-flight compile before the test driver publishes readiness.
#
# DISTILL_DEV_NO_WATCH=1 is the same switch for working on Distill *in* this
# dev app: an agent saving a file under src-tauri otherwise makes the watcher
# rebuild and relaunch the app, which kills the bridge running that agent's
# turn. Vite still hot-reloads the renderer; Rust changes wait for a relaunch.
$NoWatch = $E2eMode -or ($env:DISTILL_DEV_NO_WATCH -eq "1")
if ($NoWatch) {
    $tauriArguments += "--no-watch"
}
Invoke-CheckedCommand -FilePath $pnpm -ArgumentList $tauriArguments -Label "pnpm exec tauri dev"

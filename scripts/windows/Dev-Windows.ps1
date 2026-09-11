$ErrorActionPreference = "Stop"
$global:LASTEXITCODE = 0
trap {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking

Assert-WindowsHost
Set-Location (Get-BerdRepoRoot)
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

$E2eMode = $env:BERD_E2E_MODE -eq "1"
if ($E2eMode) {
    if ([string]::IsNullOrWhiteSpace($env:BERD_E2E_RUN_ROOT)) {
        throw "BERD_E2E_RUN_ROOT is required when BERD_E2E_MODE=1."
    }
    $e2e = New-E2eRunContract `
        -RunRoot $env:BERD_E2E_RUN_ROOT `
        -RunId $env:BERD_E2E_RUN_ID `
        -DriverToken $env:APP_TEST_DRIVER_TOKEN
    $env:BERD_E2E_RUN_ROOT = $e2e.RunRoot
    $env:BERD_E2E_RUN_ID = $e2e.RunId
    $env:APP_TEST_DRIVER_TOKEN = $e2e.DriverToken
    [Environment]::SetEnvironmentVariable("APP_TEST_DRIVER_PORT", $null, "Process")
    New-Item -ItemType Directory -Force -Path $e2e.RunRoot | Out-Null

    $runtimeConfigPath = $null
    if (-not [string]::IsNullOrWhiteSpace($env:BERD_E2E_RUNTIME_CONFIG)) {
        if (-not (Test-Path $env:BERD_E2E_RUNTIME_CONFIG -PathType Leaf)) {
            throw "BERD_E2E_RUNTIME_CONFIG must reference an existing JSON file."
        }
        $runtimeConfigPath = Join-Path $e2e.RunRoot "runtime-config.json"
        if ((Normalize-FullPath $env:BERD_E2E_RUNTIME_CONFIG) -ne (Normalize-FullPath $runtimeConfigPath)) {
            Copy-Item -LiteralPath $env:BERD_E2E_RUNTIME_CONFIG -Destination $runtimeConfigPath
        }
        Get-Content -LiteralPath $runtimeConfigPath -Raw | ConvertFrom-Json | Out-Null
        $env:BERD_E2E_RUNTIME_CONFIG = $runtimeConfigPath
    }

    Remove-Item -LiteralPath $e2e.DriverReadyPath -Force -ErrorAction SilentlyContinue
    Write-WindowsDevInfo "Using isolated E2E run root: $($e2e.RunRoot)"
    Write-WindowsDevInfo "Using isolated E2E identifier: $($e2e.Identifier)"
    Write-WindowsDevInfo "App test driver will publish readiness at: $($e2e.DriverReadyPath)"
}

$version = Resolve-AppVersion
$env:VITE_APP_VERSION = $version.RichVersion
Write-WindowsDevInfo "Using app version: $($version.Version) ($($version.RichVersion))"

$berdctlArgs = @("build", "-p", "berdctl")
Invoke-CheckedCommand -FilePath "cargo" -ArgumentList $berdctlArgs -WorkingDirectory (Join-Path (Get-BerdRepoRoot) "src-tauri") -Label "cargo build berdctl"
$env:BERDCTL_BIN = Join-Path (Join-Path $env:CARGO_TARGET_DIR "debug") "berdctl.exe"
if (-not (Test-Path $env:BERDCTL_BIN -PathType Leaf)) {
    throw "Expected berdctl.exe at $env:BERDCTL_BIN after cargo build."
}
Write-WindowsDevInfo "Using berdctl CLI: $env:BERDCTL_BIN"

Invoke-CheckedCommand -FilePath "cargo" -ArgumentList @("build", "-p", "berd-monitor") -WorkingDirectory (Join-Path (Get-BerdRepoRoot) "src-tauri") -Label "cargo build berd-monitor"
$env:BERD_MONITOR_BIN = Join-Path (Join-Path $env:CARGO_TARGET_DIR "debug") "berd-monitor.exe"
if (-not (Test-Path $env:BERD_MONITOR_BIN -PathType Leaf)) {
    throw "Expected berd-monitor.exe at $env:BERD_MONITOR_BIN after cargo build."
}
Write-WindowsDevInfo "Using berd-monitor CLI: $env:BERD_MONITOR_BIN"

$env:CARGO_TARGET_DIR = $tauriCargoTargetDir

# bb.exe is intentionally not staged: the bb CLI resource is only mapped and
# resolved on macOS (tauri.macos.conf.json + commands/cli.rs), so building it
# here would spend minutes producing an artifact the Windows app never reads.

$distroDir = Join-Path (Get-BerdRepoRoot) "distro"
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
    $devConfig.productName = "Berd E2E ($($e2e.RunId))"
}
$devConfigPath = if ($E2eMode) {
    $e2e.ConfigPath
} else {
    Join-Path (Get-BerdDevRoot) "tauri-dev-windows.config.json"
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $devConfigPath) | Out-Null
# Write without a BOM: Windows PowerShell's `Set-Content -Encoding UTF8` adds
# one, and Tauri's serde-based --config parsing rejects BOM-prefixed JSON.
$devConfigJson = $devConfig | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($devConfigPath, $devConfigJson, [System.Text.UTF8Encoding]::new($false))
Write-WindowsDevInfo "Using Tauri dev config: $devConfigPath"

$tauriArguments = @(
    "exec", "tauri", "dev",
    "--features", (Get-BerdAppFeatures),
    "--config", "src-tauri/tauri.dev.conf.json",
    "--config", $devConfigPath
)
if ($E2eMode) {
    # E2E needs one stable native launch. Plugin build scripts generate files
    # under src-tauri, so the ordinary dev watcher can otherwise invalidate its
    # own in-flight compile before the test driver publishes readiness.
    $tauriArguments += "--no-watch"
}
Invoke-CheckedCommand -FilePath $pnpm -ArgumentList $tauriArguments -Label "pnpm exec tauri dev"

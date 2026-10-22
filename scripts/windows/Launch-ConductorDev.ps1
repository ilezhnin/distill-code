$ErrorActionPreference = "Stop"
$global:LASTEXITCODE = 0
Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking

Assert-WindowsHost
Set-Location (Get-FlockRepoRoot)
Update-SessionPathFromRegistry
Assert-MsvcEnvironment
Initialize-FnmEnvironment | Out-Null
Update-SessionPathFromRegistry

$pnpm = Get-PnpmCommand
if ([string]::IsNullOrWhiteSpace($pnpm)) {
    throw "pnpm is not available after bootstrap."
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

$version = Resolve-AppVersion
$env:VITE_APP_VERSION = $version.RichVersion

Invoke-CheckedCommand -FilePath "cargo" -ArgumentList @("build", "-p", "flockctl", "-p", "flock-monitor") -WorkingDirectory (Join-Path (Get-FlockRepoRoot) "src-tauri") -Label "cargo build flockctl flock-monitor"
$flockctlBin = Join-Path (Join-Path $env:CARGO_TARGET_DIR "debug") "flockctl.exe"
$monitorBin = Join-Path (Join-Path $env:CARGO_TARGET_DIR "debug") "flock-monitor.exe"
foreach ($cliBin in @($flockctlBin, $monitorBin)) {
    if (-not (Test-Path -LiteralPath $cliBin -PathType Leaf)) {
        throw "Expected $(Split-Path -Leaf $cliBin) at $cliBin after cargo build."
    }
}
# FLOCKCTL_BIN / FLOCK_MONITOR_BIN, plus the pre-rename spellings for one release.
Set-FlockCliBinEnvironment -FlockctlBin $flockctlBin -MonitorBin $monitorBin

Initialize-FlockDistroDirEnvironment | Out-Null

if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    $portListener = Get-NetTCPConnection -LocalPort ([int]$env:VITE_PORT) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $portListener) {
        throw "Port $env:VITE_PORT is already in use by PID $($portListener.OwningProcess)."
    }
}

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
$devConfigPath = Join-Path (Get-FlockDevRoot) "tauri-dev-windows.config.json"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $devConfigPath) | Out-Null
$devConfigJson = $devConfig | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($devConfigPath, $devConfigJson, [System.Text.UTF8Encoding]::new($false))
Write-WindowsDevInfo "Using Tauri dev config: $devConfigPath"

$tauriArguments = @(
    "exec", "tauri", "dev",
    "--features", (Get-FlockAppFeatures),
    "--config", "src-tauri/tauri.dev.conf.json",
    "--config", $devConfigPath,
    "--no-watch"
)
Invoke-CheckedCommand -FilePath $pnpm -ArgumentList $tauriArguments -Label "pnpm exec tauri dev"

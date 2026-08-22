$ErrorActionPreference = "Stop"
$global:LASTEXITCODE = 0
Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking

Assert-WindowsHost
Set-Location (Get-BerdRepoRoot)
Update-SessionPathFromRegistry
Assert-MsvcEnvironment
Initialize-FnmEnvironment | Out-Null
Assert-LibClangEnvironment
Update-SessionPathFromRegistry

$pnpm = Get-PnpmCommand
if ([string]::IsNullOrWhiteSpace($pnpm)) {
    throw "pnpm is not available after bootstrap."
}

if ([string]::IsNullOrWhiteSpace($env:GOOSE_BIN)) {
    $env:GOOSE_BIN = Join-Path (Resolve-GooseDevPaths).CargoTargetDir "debug\goose.exe"
}
if (-not (Test-Path $env:GOOSE_BIN -PathType Leaf)) {
    throw "Goose binary missing at $($env:GOOSE_BIN). Set GOOSE_BIN or run just setup-windows."
}
Assert-DistillGooseBinary -BinPath $env:GOOSE_BIN

$env:VITE_PORT = [string](Get-StableVitePort)
$env:VITE_DESIGN_SYSTEM_EXPLORER = "1"
if ([string]::IsNullOrWhiteSpace($env:RUST_LOG)) {
    $env:RUST_LOG = "perf=debug,info"
}
$tauriCargoTargetDir = Get-TauriCargoTargetDir
$env:CARGO_TARGET_DIR = $tauriCargoTargetDir
Write-WindowsDevInfo "Using Vite port: $env:VITE_PORT"
Write-WindowsDevInfo "Using Goose: $env:GOOSE_BIN"
Write-WindowsDevInfo "Using Tauri Cargo target dir: $env:CARGO_TARGET_DIR"

$version = Resolve-AppVersion
$env:VITE_APP_VERSION = $version.RichVersion

Invoke-CheckedCommand -FilePath "cargo" -ArgumentList @("build", "-p", "berdctl") -WorkingDirectory (Join-Path (Get-BerdRepoRoot) "src-tauri") -Label "cargo build berdctl"
$env:BERDCTL_BIN = Join-Path (Join-Path $env:CARGO_TARGET_DIR "debug") "berdctl.exe"
if (-not (Test-Path $env:BERDCTL_BIN -PathType Leaf)) {
    throw "Expected berdctl.exe at $env:BERDCTL_BIN after cargo build."
}

$distroDir = Join-Path (Get-BerdRepoRoot) "distro"
if ([string]::IsNullOrWhiteSpace($env:GOOSE_DISTRO_DIR) -and (Test-Path $distroDir -PathType Container)) {
    $env:GOOSE_DISTRO_DIR = $distroDir
}

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
$devConfigPath = Join-Path (Resolve-GooseDevPaths).DevRoot "tauri-dev-windows.config.json"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $devConfigPath) | Out-Null
$devConfigJson = $devConfig | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($devConfigPath, $devConfigJson, [System.Text.UTF8Encoding]::new($false))
Write-WindowsDevInfo "Using Tauri dev config: $devConfigPath"

$env:VITE_AUTH_GATE = "0"
$env:VITE_TELEMETRY = "0"
$env:VITE_TELEMETRY_ENFORCED = "0"
$env:VITE_FEEDBACK = "0"
$env:VITE_UPDATER_ENABLED = "false"
$tauriArguments = @(
    "exec", "tauri", "dev",
    "--features", (Get-BerdAppFeatures),
    "--config", "src-tauri/tauri.dev.conf.json",
    "--config", $devConfigPath,
    "--no-watch"
)
Invoke-CheckedCommand -FilePath $pnpm -ArgumentList $tauriArguments -Label "pnpm exec tauri dev"

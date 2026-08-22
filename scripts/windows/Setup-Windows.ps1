param(
    # Skip the managed Goose build (used by Dev-Windows.ps1 when GOOSE_BIN
    # overrides the managed binary, mirroring unix `just _setup-no-goose`).
    [switch]$SkipGooseBuild,
    # Development defaults to debug. Release automation opts in explicitly so
    # setup and bundling reuse the same optimized managed Goose artifact.
    [ValidateSet("debug", "release")][string]$GooseBuildProfile = "debug"
)

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

$pnpm = Get-PnpmCommand
if ([string]::IsNullOrWhiteSpace($pnpm)) {
    throw "pnpm is not available. Run 'just bootstrap-windows install', open a new PowerShell, then retry."
}
Assert-PnpmReady

Write-WindowsDevSection "Install pnpm dependencies"
Invoke-CheckedCommand -FilePath $pnpm -ArgumentList @(
    "install",
    "--network-concurrency=4",
    "--fetch-retries=5"
) -Label "pnpm install"

Write-WindowsDevSection "Build SDK"
Invoke-CheckedCommand -FilePath $pnpm -ArgumentList @("build") -WorkingDirectory (Join-Path (Get-BerdRepoRoot) "sdk") -Label "sdk pnpm build"

Write-WindowsDevSection "Install hooks"
$lefthook = Get-CommandSource "lefthook"
if ([string]::IsNullOrWhiteSpace($lefthook) -or (Test-CodexRuntimePath $lefthook)) {
    throw "lefthook is not available in the user environment. Install it, then rerun 'just setup-windows'."
}
Invoke-CheckedCommand -FilePath $lefthook -ArgumentList @("install", "--force") -Label "lefthook install --force"

if ($SkipGooseBuild) {
    Write-WindowsDevInfo "Skipping pinned Goose build (GOOSE_BIN override)."
} else {
    Write-WindowsDevSection "Build pinned Goose"
    $env:GOOSE_DEV_MODE = "required"
    $env:GOOSE_BUILD_PROFILE = $GooseBuildProfile
    Invoke-EnsureLocalGoose -Action Build | Out-Null
    $settings = Get-GooseBackendSettings
    $paths = Resolve-GooseDevPaths
    Assert-DistillGooseBinary -BinPath (Resolve-GooseBinaryPath -Paths $paths -Settings $settings)
}

Write-Host ""
Write-Host "Windows setup complete." -ForegroundColor Green

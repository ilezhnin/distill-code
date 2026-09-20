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

Write-WindowsDevSection "Install hooks"
$lefthook = Get-CommandSource "lefthook"
if ([string]::IsNullOrWhiteSpace($lefthook) -or (Test-CodexRuntimePath $lefthook)) {
    throw "lefthook is not available in the user environment. Install it, then rerun 'just setup-windows'."
}
Invoke-CheckedCommand -FilePath $lefthook -ArgumentList @("install", "--force") -Label "lefthook install --force"

Write-Host ""
Write-Host "Windows setup complete." -ForegroundColor Green

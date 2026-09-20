# Build a native Windows Distill bundle with real sidecars staged.
#
# This is what `just bundle` / `bundle-debug` run; bundling exists only on
# Windows. The driver stages through Stage-Sidecar-Windows.ps1 (real *-<triple>.exe files,
# PE-validated) and hands Tauri the same explicit target triple so the staged
# names and Tauri's externalBin resolution cannot diverge.
param(
    [ValidateSet("nsis", "msi")][string]$Bundle = "nsis",
    [AllowNull()][AllowEmptyString()][string]$Version,
    [switch]$SkipDependencyInstall,
    [switch]$Debug
)

$ErrorActionPreference = "Stop"
$global:LASTEXITCODE = 0
trap {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking

Assert-WindowsHost
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

$repoRoot = Get-DistillRepoRoot
Set-Location $repoRoot
$targetTriple = "x86_64-pc-windows-msvc"
$targetDir = Get-TauriCargoTargetDir
$env:CARGO_TARGET_DIR = $targetDir

if (-not $SkipDependencyInstall) {
    Write-WindowsDevInfo "Installing locked JavaScript dependencies."
    Invoke-CheckedCommand -FilePath $pnpm -ArgumentList @("install", "--frozen-lockfile") -Label "pnpm install --frozen-lockfile"
}

# Stage distillctl/distill-monitor as validated *-<triple>.exe.
Invoke-WindowsChildScript -ScriptPath (Join-Path $PSScriptRoot "Stage-Sidecar-Windows.ps1") `
    -ArgumentList @("-Triple", $targetTriple) -Label "Stage Windows sidecars"

Write-WindowsDevInfo "Resolving application version from Git metadata."
$resolvedVersion = Resolve-AppVersion $Version
Write-WindowsDevInfo "Building Distill $($resolvedVersion.Version) ($($resolvedVersion.RichVersion))."

$env:CARGO_TARGET_DIR = $targetDir
$env:DISTILL_APP_VERSION = $resolvedVersion.RichVersion
$env:VITE_APP_VERSION = $resolvedVersion.RichVersion

$baseFeatures = @("distillctl")
if ($Debug) {
    $baseFeatures += "devtools"
}
$features = Get-DistillAppFeatures -BaseFeatures $baseFeatures

# Build the config overlay: the version and bundle target; debug bundles also
# fold in the base config with devtools enabled. Write without a BOM: Tauri's
# serde --config parsing rejects BOM-prefixed JSON.
$configPath = Join-Path ([System.IO.Path]::GetTempPath()) ("distill-tauri-{0}.{1}.json" -f ($(if ($Debug) { "debug" } else { "version" }), [System.IO.Path]::GetRandomFileName()))
if ($Debug) {
    if ($Bundle -ne "nsis") {
        throw "Debug Windows bundles currently support only NSIS."
    }
    # Tauri merges overlays with json_patch (RFC 7386), which REPLACES arrays
    # wholesale. Setting devtools on app.windows[0] therefore requires carrying
    # the full base app.windows array, or the other window props would be
    # dropped. Carrying the full base config also carries its
    # bundle.externalBin, so pin that to the Windows contract in the same
    # overlay.
    $baseConfig = Read-JsonFile (Join-Path (Join-Path (Get-DistillRepoRoot) "src-tauri") "tauri.conf.json")
    $baseConfig.version = $resolvedVersion.RichVersion
    $baseConfig.app.windows[0] | Add-Member -NotePropertyName devtools -NotePropertyValue $true -Force
    $windowsConf = Read-JsonFile (Join-Path (Join-Path (Get-DistillRepoRoot) "src-tauri") "tauri.windows.conf.json")
    $baseConfig.bundle.externalBin = (Get-ObjectValue (Get-ObjectValue $windowsConf "bundle") "externalBin")
    $configJson = $baseConfig | ConvertTo-Json -Depth 32
} else {
    $configJson = ([pscustomobject]@{
        version = $resolvedVersion.RichVersion
        bundle = @{ targets = @($Bundle) }
    } | ConvertTo-Json -Depth 5)
}
[System.IO.File]::WriteAllText($configPath, $configJson, [System.Text.UTF8Encoding]::new($false))

$schemaPath = Join-Path $repoRoot "src-tauri\gen\schemas\windows-schema.json"
$schemaBackup = Join-Path ([System.IO.Path]::GetTempPath()) ("distill-windows-schema-" + [Guid]::NewGuid().ToString("N") + ".json")
$schemaExisted = Test-Path -LiteralPath $schemaPath
if ($schemaExisted) {
    Copy-Item -LiteralPath $schemaPath -Destination $schemaBackup
}
try {
    Invoke-CheckedCommand -FilePath $pnpm -ArgumentList @(
        "exec", "tauri", "build",
        "--target", $targetTriple,
        "--features", $features,
        "--bundles", $Bundle,
        "--config", $configPath
    ) -Label "pnpm exec tauri build --bundles $Bundle"
} finally {
    Remove-Item -Path $configPath -Force -ErrorAction SilentlyContinue
    if ($schemaExisted) {
        Copy-Item -Force -LiteralPath $schemaBackup -Destination $schemaPath
    } else {
        Remove-Item -Force -ErrorAction SilentlyContinue $schemaPath
    }
    Remove-Item -Force -ErrorAction SilentlyContinue $schemaBackup
}

function Assert-WindowsBundleVersion {
    param(
        [Parameter(Mandatory = $true)][string]$BundleDir,
        [Parameter(Mandatory = $true)][string]$TargetDir,
        [Parameter(Mandatory = $true)][string]$TargetTriple,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion,
        [Parameter(Mandatory = $true)][string]$BundleType,
        [Parameter(Mandatory = $true)][string]$ProductName
    )

    $appPath = Join-Path $TargetDir "$TargetTriple\release\Distill.exe"
    if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) {
        throw "Built application executable not found: $appPath"
    }
    $actualVersion = (Get-Item -LiteralPath $appPath).VersionInfo.ProductVersion
    if ($actualVersion -ne $ExpectedVersion) {
        throw "Built application version mismatch: expected '$ExpectedVersion', got '$actualVersion' at $appPath."
    }

    # The bundler names installers after productName, not the Cargo binary
    # (which stays Distill.exe above): Distill_<version>_x64-setup.exe.
    $bundlePattern = if ($BundleType -eq "nsis") {
        "${ProductName}_${ExpectedVersion}_x64-setup.exe"
    } else {
        "${ProductName}_${ExpectedVersion}_x64_en-US.msi"
    }
    $bundlePath = Join-Path $BundleDir $bundlePattern
    if (-not (Test-Path -LiteralPath $bundlePath -PathType Leaf)) {
        throw "Expected $BundleType bundle not found: $bundlePath"
    }

    return $bundlePath
}

$bundleDir = Join-Path $targetDir "$targetTriple\release\bundle\$Bundle"
$productName = Get-ObjectValue (Read-JsonFile (Join-Path $repoRoot "src-tauri\tauri.conf.json")) "productName"
if ([string]::IsNullOrWhiteSpace($productName)) {
    throw "src-tauri\tauri.conf.json has no productName; cannot locate the installer."
}
$bundlePath = Assert-WindowsBundleVersion `
    -BundleDir $bundleDir `
    -TargetDir $targetDir `
    -TargetTriple $targetTriple `
    -ExpectedVersion $resolvedVersion.RichVersion `
    -BundleType $Bundle `
    -ProductName $productName
Write-Host ""
Write-Host "Windows bundle ready: $bundlePath" -ForegroundColor Green

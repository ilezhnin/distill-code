<#
.SYNOPSIS
    One-click Distill Code dev launcher (the desktop shortcut target).

.DESCRIPTION
    Brings up everything the dev app needs from a plain Explorer environment,
    so nothing has to be started by hand in separate terminals:

      1. toolchain environment: MSVC, fnm-managed Node, pnpm on PATH
      2. dependencies: pnpm install, the vendored SDK build
      3. the pinned + Distill-patched managed Goose backend (built if stale)
      4. berdctl.exe
      5. stale leftovers from a previous run (orphaned Vite on this checkout's
         port, Berd.exe / goosed whose dev session is gone)
      6. Vite + the Tauri dev app; the app itself starts `goose serve`, which
         starts the per-session ACP bridges (Claude / Codex / Grok)

    The Tauri build reuses this checkout's `src-tauri\target` so a warm cache
    is never thrown away (override with BERD_TAURI_CARGO_TARGET_DIR).

    Starting from the desktop instead of a terminal inside Orca / Claude Code /
    Codex also keeps the whole process tree free of that pane's identity.

.PARAMETER InstallShortcut
    Create or refresh "Distill Code.lnk" on the desktop pointing at this
    script, then exit without launching.

.PARAMETER SkipSetup
    Skip the dependency checks (pnpm install / SDK / managed Goose / berdctl)
    for a faster relaunch. Artifacts must already exist.

.PARAMETER NoPause
    Do not wait for a key press when the launch fails (the shortcut relies on
    the pause so the error stays readable).

.EXAMPLE
    pwsh -File scripts\windows\Launch-Distill.ps1 -InstallShortcut
    pwsh -File scripts\windows\Launch-Distill.ps1
#>
[CmdletBinding()]
param(
    [switch]$InstallShortcut,
    [switch]$SkipSetup,
    [switch]$NoPause
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$global:LASTEXITCODE = 0

$script:ShortcutName = "Distill Code.lnk"

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-PowerShellHostPath {
    $pwsh = Join-Path $env:ProgramFiles "PowerShell\7\pwsh.exe"
    if (Test-Path -LiteralPath $pwsh -PathType Leaf) {
        return $pwsh
    }
    $current = (Get-Process -Id $PID).Path
    if (-not [string]::IsNullOrWhiteSpace($current) -and (Test-Path -LiteralPath $current -PathType Leaf)) {
        return $current
    }
    return (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe")
}

function Install-DesktopShortcut {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$ScriptPath
    )
    $desktop = [Environment]::GetFolderPath("Desktop")
    if ([string]::IsNullOrWhiteSpace($desktop) -or -not (Test-Path -LiteralPath $desktop -PathType Container)) {
        throw "Desktop folder not found."
    }
    $linkPath = Join-Path $desktop $script:ShortcutName
    $icon = Join-Path $RepoRoot "src-tauri\icons\icon.ico"

    $shell = New-Object -ComObject WScript.Shell
    try {
        $link = $shell.CreateShortcut($linkPath)
        $link.TargetPath = Get-PowerShellHostPath
        $link.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
        $link.WorkingDirectory = $RepoRoot
        $link.Description = "Distill Code (dev): Vite + Tauri app + goosed + ACP bridges"
        if (Test-Path -LiteralPath $icon -PathType Leaf) {
            $link.IconLocation = "$icon,0"
        }
        $link.WindowStyle = 1
        $link.Save()
    } finally {
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
    }
    return $linkPath
}

function Get-ProcessCommandLine {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    try {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        if ($null -ne $process) { return [string]$process.CommandLine }
    } catch {}
    return ""
}

function Test-ProcessAlive {
    param([int]$ProcessId)
    if ($ProcessId -le 0) { return $false }
    return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Stop-ProcessQuietly {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$Reason
    )
    try {
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
        Write-Host "    stopped PID $ProcessId ($Reason)"
    } catch {
        Write-Host "    could not stop PID $ProcessId ($Reason): $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

function Test-PathUnder {
    param(
        [AllowEmptyString()][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    $normalizedPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $normalizedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    return $normalizedPath.StartsWith($normalizedRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

# One launcher per checkout: a second click while the first is still building
# must not mistake the first run's Vite for an orphan.
function Get-LaunchMutexName {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    $sha = [System.Security.Cryptography.SHA1]::Create()
    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($RepoRoot.ToLowerInvariant()))
    } finally {
        $sha.Dispose()
    }
    $hex = ($hash | ForEach-Object { $_.ToString("x2") }) -join ""
    return "Local\DistillDevLauncher-$hex"
}

function Enter-LaunchMutex {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    $mutex = New-Object System.Threading.Mutex($false, (Get-LaunchMutexName -RepoRoot $RepoRoot))
    $acquired = $false
    try {
        $acquired = $mutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        # The previous holder died without releasing; it is ours now.
        $acquired = $true
    }
    if (-not $acquired) {
        $mutex.Dispose()
        return $null
    }
    return $mutex
}

# `tauri dev` sessions (node running @tauri-apps/cli) for this checkout —
# including ones still compiling, before Berd.exe exists.
function Get-LiveTauriDevProcesses {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    $needle = Join-Path $RepoRoot "node_modules"
    $result = @()
    foreach ($process in (Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue)) {
        $commandLine = [string]$process.CommandLine
        if ($commandLine -notmatch 'tauri\.js"?\s+"?dev\b') { continue }
        if ($commandLine.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
        $result += [int]$process.ProcessId
    }
    return $result
}

function Show-ExistingApp {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    try {
        Add-Type -AssemblyName Microsoft.VisualBasic -ErrorAction Stop
        [Microsoft.VisualBasic.Interaction]::AppActivate($ProcessId)
    } catch {}
}

# Berd.exe instances built from this checkout, with whether their `cargo run`
# parent (the live `tauri dev` session) is still around.
function Get-CheckoutAppProcesses {
    param([Parameter(Mandatory = $true)][string]$TargetDir)
    $result = @()
    foreach ($process in (Get-CimInstance Win32_Process -Filter "Name = 'Berd.exe'" -ErrorAction SilentlyContinue)) {
        if (-not (Test-PathUnder -Path ([string]$process.ExecutablePath) -Root $TargetDir)) { continue }
        $parentAlive = Test-ProcessAlive -ProcessId ([int]$process.ParentProcessId)
        $parentName = ""
        if ($parentAlive) {
            $parentName = (Get-Process -Id ([int]$process.ParentProcessId) -ErrorAction SilentlyContinue).ProcessName
        }
        $result += [pscustomobject]@{
            ProcessId = [int]$process.ProcessId
            Live = ($parentAlive -and $parentName -ieq "cargo")
        }
    }
    return $result
}

function Stop-StaleDevProcesses {
    param(
        [Parameter(Mandatory = $true)][string]$TargetDir,
        [Parameter(Mandatory = $true)][string]$GooseTargetDir,
        [Parameter(Mandatory = $true)][int]$VitePort
    )
    foreach ($app in (Get-CheckoutAppProcesses -TargetDir $TargetDir)) {
        if (-not $app.Live) {
            Stop-ProcessQuietly -ProcessId $app.ProcessId -Reason "orphaned Berd.exe from a previous run"
        }
    }
    foreach ($process in (Get-CimInstance Win32_Process -Filter "Name = 'goose.exe'" -ErrorAction SilentlyContinue)) {
        if (-not (Test-PathUnder -Path ([string]$process.ExecutablePath) -Root $GooseTargetDir)) { continue }
        if (([string]$process.CommandLine) -notmatch '\bserve\b') { continue }
        if (Test-ProcessAlive -ProcessId ([int]$process.ParentProcessId)) { continue }
        Stop-ProcessQuietly -ProcessId ([int]$process.ProcessId) -Reason "orphaned goose serve"
    }
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        $listener = Get-NetTCPConnection -LocalPort $VitePort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $listener) {
            $owner = [int]$listener.OwningProcess
            $commandLine = Get-ProcessCommandLine -ProcessId $owner
            if ($commandLine -match 'vite') {
                Stop-ProcessQuietly -ProcessId $owner -Reason "orphaned vite on port $VitePort"
                Start-Sleep -Milliseconds 500
            } else {
                throw "Port $VitePort is in use by PID $owner, which is not Vite. Stop it and retry."
            }
        }
    }
}

function Test-NewerThan {
    # $true when any file under $SourceDirs is newer than $Artifact (or it is missing).
    param(
        [Parameter(Mandatory = $true)][string]$Artifact,
        [Parameter(Mandatory = $true)][string[]]$SourceDirs
    )
    if (-not (Test-Path -LiteralPath $Artifact -PathType Leaf)) { return $true }
    $artifactTime = (Get-Item -LiteralPath $Artifact).LastWriteTimeUtc
    foreach ($dir in $SourceDirs) {
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        $newest = Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
        if ($null -ne $newest -and $newest.LastWriteTimeUtc -gt $artifactTime) { return $true }
    }
    return $false
}

$scriptPath = $MyInvocation.MyCommand.Path
$exitCode = 0
$launched = $false
$alreadyRunning = $false
$launchMutex = $null
$tauriTargetDir = $null
$gooseTargetDir = $null
$vitePort = 0

try {
    Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking
    Assert-WindowsHost
    $repoRoot = Get-BerdRepoRoot
    Set-Location $repoRoot

    if ($InstallShortcut) {
        $link = Install-DesktopShortcut -RepoRoot $repoRoot -ScriptPath $scriptPath
        Write-Host "Shortcut written: $link" -ForegroundColor Green
        exit 0
    }

    try { $Host.UI.RawUI.WindowTitle = "Distill Code (dev)" } catch {}
    Write-Host "Distill Code dev launcher" -ForegroundColor Green
    Write-Host "repo: $repoRoot"

    Write-Step "Toolchain environment"
    Update-SessionPathFromRegistry
    Assert-MsvcEnvironment
    if (-not (Initialize-FnmEnvironment)) {
        Write-WindowsDevInfo "fnm not found; using Node from PATH"
    }
    Initialize-PublicNpmEnvironment
    Update-SessionPathFromRegistry
    $pnpm = Get-PnpmCommand
    if ([string]::IsNullOrWhiteSpace($pnpm)) {
        throw "pnpm is not available. Run 'just bootstrap-windows install', open a new PowerShell, then retry."
    }
    Write-WindowsDevInfo "pnpm: $pnpm"

    $tauriTargetDir = $env:BERD_TAURI_CARGO_TARGET_DIR
    if ([string]::IsNullOrWhiteSpace($tauriTargetDir)) {
        $tauriTargetDir = Join-Path $repoRoot "src-tauri\target"
    }
    $goosePaths = Resolve-GooseDevPaths
    $gooseTargetDir = $goosePaths.CargoTargetDir
    $vitePort = Get-StableVitePort

    Write-Step "Previous run leftovers"
    $launchMutex = Enter-LaunchMutex -RepoRoot $repoRoot
    if ($null -eq $launchMutex) {
        Write-Host "Another Distill launcher for this checkout is still starting up. Wait for its window to appear." -ForegroundColor Yellow
        $alreadyRunning = $true
        exit 0
    }
    $liveDev = @(Get-LiveTauriDevProcesses -RepoRoot $repoRoot)
    $liveApps = @(Get-CheckoutAppProcesses -TargetDir $tauriTargetDir | Where-Object { $_.Live })
    if ($liveDev.Count -gt 0 -or $liveApps.Count -gt 0) {
        if ($liveApps.Count -gt 0) {
            Write-Host "Distill is already running from this checkout (Berd.exe PID $($liveApps[0].ProcessId))." -ForegroundColor Yellow
            Show-ExistingApp -ProcessId $liveApps[0].ProcessId
        } else {
            Write-Host "A 'tauri dev' session for this checkout is already starting (node PID $($liveDev[0])); its window will appear when the build finishes." -ForegroundColor Yellow
        }
        Write-Host "Close that app window (or its terminal) first if you want a fresh start."
        $alreadyRunning = $true
        exit 0
    }
    Stop-StaleDevProcesses -TargetDir $tauriTargetDir -GooseTargetDir $gooseTargetDir -VitePort $vitePort

    if ($SkipSetup) {
        Write-Step "Dependencies (skipped: -SkipSetup)"
        if ([string]::IsNullOrWhiteSpace($env:GOOSE_BIN)) {
            $env:GOOSE_BIN = Join-Path $gooseTargetDir "debug\goose.exe"
        }
    } else {
        Write-Step "Dependencies"
        $modulesStamp = Join-Path $repoRoot "node_modules\.modules.yaml"
        if (Test-NewerThan -Artifact $modulesStamp -SourceDirs @((Join-Path $repoRoot "pnpm-lock.yaml"))) {
            Invoke-CheckedCommand -FilePath $pnpm -ArgumentList @("install", "--network-concurrency=4", "--fetch-retries=5") -Label "pnpm install"
        } else {
            Write-WindowsDevInfo "pnpm dependencies are current"
        }

        $sdkArtifact = Join-Path $repoRoot "sdk\dist\index.js"
        if (Test-NewerThan -Artifact $sdkArtifact -SourceDirs @((Join-Path $repoRoot "sdk\src"), (Join-Path $repoRoot "sdk\schema"), (Join-Path $repoRoot "sdk\package.json"))) {
            Invoke-CheckedCommand -FilePath $pnpm -ArgumentList @("build") -WorkingDirectory (Join-Path $repoRoot "sdk") -Label "sdk pnpm build"
        } else {
            Write-WindowsDevInfo "SDK build is current"
        }

        if ([string]::IsNullOrWhiteSpace($env:GOOSE_BIN)) {
            $env:GOOSE_BUILD_PROFILE = "debug"
            # "auto" so a stale binary comes back as Ready=$false instead of
            # throwing; the rebuild below runs in "required" mode.
            $env:GOOSE_DEV_MODE = "auto"
            $goose = Invoke-EnsureLocalGoose -Action Check
            if (-not $goose.Ready) {
                Write-WindowsDevInfo "Managed Goose is stale or missing: $($goose.Message)"
                Write-WindowsDevInfo "Building the pinned Goose backend (this can take a while on a cold cache)..."
                $env:GOOSE_DEV_MODE = "required"
                $goose = Invoke-EnsureLocalGoose -Action Build
            }
            if (-not $goose.Ready) {
                throw "Managed Goose is not ready: $($goose.Message)"
            }
            $env:GOOSE_BIN = $goose.BinPath
        } else {
            Write-WindowsDevInfo "Using explicitly set GOOSE_BIN: $env:GOOSE_BIN"
        }
    }
    # Invoke-EnsureLocalGoose points CARGO_TARGET_DIR at the Goose checkout;
    # the app build must go back to this checkout's warm target dir.
    $env:CARGO_TARGET_DIR = $tauriTargetDir
    if (-not (Test-Path -LiteralPath $env:GOOSE_BIN -PathType Leaf)) {
        throw "Goose binary missing at $env:GOOSE_BIN. Run 'just setup-windows' (or relaunch without -SkipSetup)."
    }
    Assert-DistillGooseBinary -BinPath $env:GOOSE_BIN
    Write-WindowsDevInfo "goose: $env:GOOSE_BIN"

    $srcTauri = Join-Path $repoRoot "src-tauri"
    $env:BERDCTL_BIN = Join-Path $tauriTargetDir "debug\berdctl.exe"
    if (-not $SkipSetup) {
        Invoke-CheckedCommand -FilePath "cargo" -ArgumentList @("build", "-p", "berdctl") -WorkingDirectory $srcTauri -Label "cargo build berdctl"
    }
    if (-not (Test-Path -LiteralPath $env:BERDCTL_BIN -PathType Leaf)) {
        throw "berdctl.exe missing at $env:BERDCTL_BIN. Relaunch without -SkipSetup."
    }
    Write-WindowsDevInfo "berdctl: $env:BERDCTL_BIN"

    Write-Step "App"
    $distroDir = Join-Path $repoRoot "distro"
    if ([string]::IsNullOrWhiteSpace($env:GOOSE_DISTRO_DIR) -and (Test-Path -LiteralPath $distroDir -PathType Container)) {
        $env:GOOSE_DISTRO_DIR = $distroDir
    }
    $env:VITE_PORT = [string]$vitePort
    $env:VITE_DESIGN_SYSTEM_EXPLORER = "1"
    if ([string]::IsNullOrWhiteSpace($env:RUST_LOG)) {
        $env:RUST_LOG = "perf=debug,info"
    }
    $env:VITE_AUTH_GATE = if ($env:VITE_BUILDERBOT -eq "1") { "1" } else { "0" }
    foreach ($name in @("VITE_TELEMETRY", "VITE_TELEMETRY_ENFORCED", "VITE_FEEDBACK")) {
        if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, "Process"))) {
            [Environment]::SetEnvironmentVariable($name, "0", "Process")
        }
    }
    if ([string]::IsNullOrWhiteSpace($env:VITE_UPDATER_ENABLED)) {
        $env:VITE_UPDATER_ENABLED = "false"
    }
    $version = Resolve-AppVersion
    $env:VITE_APP_VERSION = $version.RichVersion

    $pnpmShimName = Split-Path -Leaf $pnpm
    $devConfig = @{
        version = $version.Version
        build = @{
            devUrl = "http://localhost:$vitePort"
            beforeDevCommand = @{
                script = "$pnpmShimName exec vite --port $vitePort --strictPort"
                cwd = ".."
                wait = $false
            }
        }
    }
    $devConfigPath = Join-Path $goosePaths.DevRoot "tauri-dev-windows.config.json"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $devConfigPath) | Out-Null
    [System.IO.File]::WriteAllText($devConfigPath, ($devConfig | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))

    $features = Get-BerdAppFeatures
    Write-WindowsDevInfo "version: $($version.RichVersion)"
    Write-WindowsDevInfo "vite: http://localhost:$vitePort"
    Write-WindowsDevInfo "cargo target: $tauriTargetDir"
    Write-WindowsDevInfo "features: $features"
    Write-Host ""
    Write-Host "Starting Vite + Tauri dev app (goosed and the ACP bridges start inside the app)." -ForegroundColor Green
    Write-Host "Close the app window or press Ctrl+C here to stop everything." -ForegroundColor DarkGray
    Write-Host ""

    $launched = $true
    & $pnpm exec tauri dev --features $features --config "src-tauri/tauri.dev.conf.json" --config $devConfigPath
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) { $exitCode = 0 }
} catch {
    $exitCode = 1
    Write-Host ""
    Write-Host "Distill launch failed: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ScriptStackTrace) {
        Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    }
} finally {
    if ($launched -and $tauriTargetDir -and $gooseTargetDir -and $vitePort -gt 0) {
        Write-Step "Cleanup"
        try {
            Stop-StaleDevProcesses -TargetDir $tauriTargetDir -GooseTargetDir $gooseTargetDir -VitePort $vitePort
        } catch {
            Write-Host "    $($_.Exception.Message)" -ForegroundColor Yellow
        }
        Write-Host "Distill dev session ended (exit code $exitCode)."
    }
}

if ($exitCode -ne 0 -and -not $NoPause) {
    Write-Host ""
    Read-Host "Press Enter to close this window" | Out-Null
}
exit $exitCode

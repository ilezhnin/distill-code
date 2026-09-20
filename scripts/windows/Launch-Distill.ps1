<#
.SYNOPSIS
    One-click Distill Code dev launcher (the desktop shortcut target).

.DESCRIPTION
    Brings up everything the dev app needs from a plain Explorer environment,
    so nothing has to be started by hand in separate terminals:

      1. toolchain environment: MSVC, fnm-managed Node, pnpm on PATH
      2. dependencies: pnpm install
      3. distillctl.exe and distill-monitor.exe
      4. stale leftovers from a previous run (orphaned Vite on this checkout's
         port, Distill.exe whose dev session is gone)
      5. Vite + the Tauri dev app; the app itself starts the per-session ACP
         bridges (Claude / Codex / Grok)

    The Tauri build reuses this checkout's `src-tauri\target` so a warm cache
    is never thrown away (override with DISTILL_TAURI_CARGO_TARGET_DIR).

    Starting from the desktop instead of a terminal inside Orca / Claude Code /
    Codex also keeps the whole process tree free of that pane's identity.

.PARAMETER InstallShortcut
    Create or refresh "Distill Code.lnk" on the desktop pointing at this
    script, then exit without launching.

.PARAMETER SkipSetup
    Skip the dependency checks (pnpm install / distillctl / distill-monitor)
    for a faster relaunch. Artifacts must already exist.

.PARAMETER NoPause
    Do not wait for a key press when the launch fails (the shortcut relies on
    the pause so the error stays readable).

.PARAMETER Watch
    Keep Tauri's Rust watcher on, so a change under src-tauri rebuilds and
    relaunches the app. Off by default: a relaunch kills every running turn,
    including the one of an agent that made the change from inside this app.

.EXAMPLE
    pwsh -File scripts\windows\Launch-Distill.ps1 -InstallShortcut
    pwsh -File scripts\windows\Launch-Distill.ps1
#>
[CmdletBinding()]
param(
    [switch]$InstallShortcut,
    [switch]$SkipSetup,
    [switch]$NoPause,
    [switch]$Watch
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
        $link.Description = "Distill Code (dev): Vite + Tauri app + ACP bridges"
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
# including ones still compiling, before Distill.exe exists.
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

# Distill.exe instances built from this checkout, with whether their `cargo run`
# parent (the live `tauri dev` session) is still around.
function Get-CheckoutAppProcesses {
    param([Parameter(Mandatory = $true)][string]$TargetDir)
    $result = @()
    foreach ($process in (Get-CimInstance Win32_Process -Filter "Name = 'Distill.exe'" -ErrorAction SilentlyContinue)) {
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
        [Parameter(Mandatory = $true)][int]$VitePort
    )
    foreach ($app in (Get-CheckoutAppProcesses -TargetDir $TargetDir)) {
        if (-not $app.Live) {
            Stop-ProcessQuietly -ProcessId $app.ProcessId -Reason "orphaned Distill.exe from a previous run"
        }
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
$vitePort = 0

try {
    Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking
    Assert-WindowsHost
    $repoRoot = Get-DistillRepoRoot
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
    # pnpm is reached through a Corepack shim, which asks for confirmation
    # before downloading a package manager it has not cached. Started from
    # a desktop shortcut that prompt has nothing to read from, so the
    # launcher hangs with no output instead of failing.
    $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
    Update-SessionPathFromRegistry
    Assert-MsvcEnvironment
    if (-not (Initialize-FnmEnvironment)) {
        Write-WindowsDevInfo "fnm not found; using Node from PATH"
    }
    Initialize-PublicNpmEnvironment
    Update-SessionPathFromRegistry
    $pnpm = Get-PnpmCommand
    if ([string]::IsNullOrWhiteSpace($pnpm)) {
        # The launcher is the desktop shortcut, so a missing package manager
        # has to be provisioned here rather than bounced back to the user as a
        # terminal command. Corepack ships with Node, so this works from a
        # plain Node install with no fnm.
        Write-WindowsDevInfo "pnpm not found; provisioning pnpm@$(Get-RequiredPnpmVersion)"
        Install-PnpmForUser | Out-Null
        $pnpm = Get-PnpmCommand
    }
    if ([string]::IsNullOrWhiteSpace($pnpm)) {
        throw "pnpm is not available and could not be installed automatically. Run 'just bootstrap-windows install', open a new PowerShell, then retry."
    }
    Write-WindowsDevInfo "pnpm: $pnpm"

    $tauriTargetDir = Get-TauriCargoTargetDir
    if (Test-PathOnSystemDrive $tauriTargetDir) {
        Write-Host ("Cargo target dir is on the system drive ($tauriTargetDir); a debug build there grows to tens of GB. " +
            "Set DISTILL_TAURI_CARGO_TARGET_DIR to a path on another drive to move it.") -ForegroundColor Yellow
    }
    $devRoot = Get-DistillDevRoot
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
            Write-Host "Distill is already running from this checkout (Distill.exe PID $($liveApps[0].ProcessId))." -ForegroundColor Yellow
            Show-ExistingApp -ProcessId $liveApps[0].ProcessId
        } else {
            Write-Host "A 'tauri dev' session for this checkout is already starting (node PID $($liveDev[0])); its window will appear when the build finishes." -ForegroundColor Yellow
        }
        Write-Host "Close that app window (or its terminal) first if you want a fresh start."
        $alreadyRunning = $true
        exit 0
    }
    Stop-StaleDevProcesses -TargetDir $tauriTargetDir -VitePort $vitePort

    if ($SkipSetup) {
        Write-Step "Dependencies (skipped: -SkipSetup)"
    } else {
        Write-Step "Dependencies"
        $modulesStamp = Join-Path $repoRoot "node_modules\.modules.yaml"
        if (Test-NewerThan -Artifact $modulesStamp -SourceDirs @((Join-Path $repoRoot "pnpm-lock.yaml"))) {
            Invoke-CheckedCommand -FilePath $pnpm -ArgumentList @("install", "--network-concurrency=4", "--fetch-retries=5") -Label "pnpm install"
        } else {
            Write-WindowsDevInfo "pnpm dependencies are current"
        }

    }
    $env:CARGO_TARGET_DIR = $tauriTargetDir

    $srcTauri = Join-Path $repoRoot "src-tauri"
    # `tauri dev` builds only the app crate; the agent-facing CLIs are
    # workspace members it never touches. Without distill-monitor here the app's
    # PATH shim pointed at a missing (or stale) target\debug\distill-monitor.exe.
    $env:DISTILLCTL_BIN = Join-Path $tauriTargetDir "debug\distillctl.exe"
    $env:DISTILL_MONITOR_BIN = Join-Path $tauriTargetDir "debug\distill-monitor.exe"
    if (-not $SkipSetup) {
        Invoke-CheckedCommand -FilePath "cargo" -ArgumentList @("build", "-p", "distillctl", "-p", "distill-monitor") -WorkingDirectory $srcTauri -Label "cargo build distillctl distill-monitor"
    }
    foreach ($cliBin in @($env:DISTILLCTL_BIN, $env:DISTILL_MONITOR_BIN)) {
        if (-not (Test-Path -LiteralPath $cliBin -PathType Leaf)) {
            throw "$(Split-Path -Leaf $cliBin) missing at $cliBin. Relaunch without -SkipSetup."
        }
    }
    Write-WindowsDevInfo "distillctl: $env:DISTILLCTL_BIN"
    Write-WindowsDevInfo "distill-monitor: $env:DISTILL_MONITOR_BIN"

    Write-Step "App"
    $distroDir = Join-Path $repoRoot "distro"
    if ([string]::IsNullOrWhiteSpace($env:DISTILL_DISTRO_DIR) -and (Test-Path -LiteralPath $distroDir -PathType Container)) {
        $env:DISTILL_DISTRO_DIR = $distroDir
    }
    $env:VITE_PORT = [string]$vitePort
    $env:VITE_DESIGN_SYSTEM_EXPLORER = "1"
    if ([string]::IsNullOrWhiteSpace($env:RUST_LOG)) {
        $env:RUST_LOG = "perf=debug,info"
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
    $devConfigPath = Join-Path $devRoot "tauri-dev-windows.config.json"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $devConfigPath) | Out-Null
    [System.IO.File]::WriteAllText($devConfigPath, ($devConfig | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))

    # This launcher is the desktop-shortcut/daily-driver entry point, so it
    # builds without `app-test-driver`: that feature binds an unauthenticated
    # UI-driving socket on 127.0.0.1:9999 that any local process - including a
    # command an agent runs - can use to read the rendered transcript and input
    # values and to click any control. Use `just dev-windows` when you want the
    # driver (see docs/app-e2e.md).
    $features = Get-DistillAppFeatures -BaseFeatures @("distillctl")
    Write-WindowsDevInfo "version: $($version.RichVersion)"
    Write-WindowsDevInfo "vite: http://localhost:$vitePort"
    Write-WindowsDevInfo "cargo target: $tauriTargetDir"
    Write-WindowsDevInfo "features: $features"
    Write-Host ""
    Write-Host "Starting Vite + Tauri dev app (the ACP bridges start inside the app)." -ForegroundColor Green
    Write-Host "Close the app window or press Ctrl+C here to stop everything." -ForegroundColor DarkGray
    Write-Host ""

    # The daily driver is where agents work on Distill itself. With Tauri's
    # Rust watcher on, an agent saving a file under src-tauri makes `tauri dev`
    # rebuild and relaunch the app it is running in: the bridges die with it and
    # the turn is lost mid-edit. So the watcher is off unless asked for; Rust
    # changes are picked up by the next launch, and Vite still hot-reloads the
    # renderer, which no turn depends on.
    $tauriArguments = @("exec", "tauri", "dev", "--features", $features, "--config", "src-tauri/tauri.dev.conf.json", "--config", $devConfigPath)
    if (-not $Watch) {
        $tauriArguments += "--no-watch"
    }

    $launched = $true
    & $pnpm @tauriArguments
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
    if ($launched -and $tauriTargetDir -and $vitePort -gt 0) {
        Write-Step "Cleanup"
        try {
            Stop-StaleDevProcesses -TargetDir $tauriTargetDir -VitePort $vitePort
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

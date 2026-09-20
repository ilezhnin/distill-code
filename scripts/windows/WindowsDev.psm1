Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$script:RequiredPnpmVersion = "10.33.0"
# Single source of truth for the Node pin: node-runtime.lock.json, the same
# file `just bump-node-runtime` and scripts/update-acp-tools-lock.mjs read. A
# second literal here drifted from the lock and made the acp-tools refresh
# refuse to run on every machine these scripts provision.
$script:RequiredNodeVersion = (Get-Content -Raw -LiteralPath (Join-Path $script:RepoRoot "node-runtime.lock.json") |
    ConvertFrom-Json).version.TrimStart("v")
$script:PublicNpmRegistry = "https://registry.npmjs.org/"
$script:WebView2ClientIds = @(
    "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "{F1E7DD3E-2BBD-4C03-AB8D-0808074AC3E6}"
)

function Test-IsWindowsHost {
    return $env:OS -eq "Windows_NT" -or [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
}

function Test-IsElevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-WindowsHost {
    if (-not (Test-IsWindowsHost)) {
        throw "This command runs on Windows only; Distill has no macOS or Linux build."
    }
}

function Get-DistillRepoRoot {
    return $script:RepoRoot
}

function Get-RequiredPnpmVersion {
    return $script:RequiredPnpmVersion
}

function Get-RequiredNodeVersion {
    return $script:RequiredNodeVersion
}

function Get-PublicNpmRegistry {
    return $script:PublicNpmRegistry
}

function Test-IsBlockNpmValue {
    param([AllowNull()][AllowEmptyString()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $false
    }
    return ($Value -like "*global.block-artifacts.com*") -or ($Value -like "*block-certs*")
}

function Get-RequiredRustVersion {
    $toolchainFile = Join-Path $script:RepoRoot "rust-toolchain.toml"
    $match = Select-String -Path $toolchainFile -Pattern '^\s*channel\s*=\s*"([^"]+)"' | Select-Object -First 1
    if ($null -eq $match) {
        throw "Could not read Rust channel from $toolchainFile."
    }
    return $match.Matches[0].Groups[1].Value
}

function Write-WindowsDevSection {
    param([Parameter(Mandatory = $true)][string]$Title)
    Write-Host ""
    Write-Host "== $Title ==" -ForegroundColor Cyan
}

function Write-WindowsDevInfo {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "[distill-windows] $Message"
}

function Get-CommandSource {
    param([Parameter(Mandatory = $true)][string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command -and -not [System.IO.Path]::HasExtension($Name)) {
        $command = Get-Command "$Name.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    if ($null -eq $command) {
        return $null
    }
    return $command.Source
}

function Get-NpmCommand {
    $cmd = Get-CommandSource "npm.cmd"
    if (-not [string]::IsNullOrWhiteSpace($cmd)) {
        return $cmd
    }
    return (Get-CommandSource "npm")
}

function Get-PnpmCommand {
    $cmd = Get-CommandSource "pnpm.cmd"
    if (-not [string]::IsNullOrWhiteSpace($cmd)) {
        return $cmd
    }
    return (Get-CommandSource "pnpm")
}

function Get-CorepackCommand {
    $cmd = Get-CommandSource "corepack.cmd"
    if (-not [string]::IsNullOrWhiteSpace($cmd)) {
        return $cmd
    }
    return (Get-CommandSource "corepack")
}

function Repair-WindowsProcessEnvironment {
    # Managed launchers can provide a partial Windows environment (for
    # example PATHEXT=.CPL with no ComSpec/SystemDrive/ProgramData). Native
    # child processes then fail to resolve ordinary executables or expand
    # shell-folder paths. Repair only missing/invalid process values from
    # authoritative machine state; do not mutate persistent user settings.
    $machinePathExt = [Environment]::GetEnvironmentVariable("PATHEXT", "Machine")
    if (-not [string]::IsNullOrWhiteSpace($machinePathExt)) {
        $processPathExt = [Environment]::GetEnvironmentVariable("PATHEXT", "Process")
        $extensions = @($processPathExt -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        foreach ($requiredExtension in @(".COM", ".EXE", ".BAT", ".CMD")) {
            if ($extensions -inotcontains $requiredExtension) {
                [Environment]::SetEnvironmentVariable("PATHEXT", $machinePathExt, "Process")
                break
            }
        }
    }

    if ([string]::IsNullOrWhiteSpace($env:ComSpec)) {
        $comSpec = [Environment]::GetEnvironmentVariable("ComSpec", "Machine")
        if ([string]::IsNullOrWhiteSpace($comSpec) -and -not [string]::IsNullOrWhiteSpace($env:SystemRoot)) {
            $comSpec = Join-Path $env:SystemRoot "System32\cmd.exe"
        }
        if (-not [string]::IsNullOrWhiteSpace($comSpec)) {
            [Environment]::SetEnvironmentVariable("ComSpec", $comSpec, "Process")
        }
    }

    if ([string]::IsNullOrWhiteSpace($env:SystemDrive) -and -not [string]::IsNullOrWhiteSpace($env:SystemRoot)) {
        $systemDrive = [System.IO.Path]::GetPathRoot($env:SystemRoot)
        if (-not [string]::IsNullOrWhiteSpace($systemDrive)) {
            [Environment]::SetEnvironmentVariable("SystemDrive", $systemDrive.TrimEnd('\'), "Process")
        }
    }

    if ([string]::IsNullOrWhiteSpace($env:ProgramData)) {
        $shellFolders = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders" -ErrorAction SilentlyContinue
        $programData = Get-ObjectValue $shellFolders "Common AppData"
        if ([string]::IsNullOrWhiteSpace($programData) -and -not [string]::IsNullOrWhiteSpace($env:SystemDrive)) {
            $programData = Join-Path $env:SystemDrive "ProgramData"
        }
        if (-not [string]::IsNullOrWhiteSpace($programData)) {
            [Environment]::SetEnvironmentVariable("ProgramData", $programData, "Process")
        }
    }
}

function Update-SessionPathFromRegistry {
    Repair-WindowsProcessEnvironment
    $pathParts = New-Object System.Collections.Generic.List[string]
    $processPath = [Environment]::GetEnvironmentVariable("Path", "Process")
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    foreach ($pathValue in @($processPath, $machinePath, $userPath)) {
        if ([string]::IsNullOrWhiteSpace($pathValue)) {
            continue
        }
        foreach ($part in ($pathValue -split ";")) {
            if (-not [string]::IsNullOrWhiteSpace($part) -and -not $pathParts.Contains($part)) {
                $pathParts.Add($part)
            }
        }
    }

    if ($pathParts.Count -gt 0) {
        $env:Path = ($pathParts -join ";")
    }
}

function Test-CodexRuntimePath {
    param([AllowNull()][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $false
    }
    return $Path -match "\\\.cache\\codex-runtimes\\"
}

function New-DistillTemporaryFile {
    # Avoid PowerShell module autoloading here. GitHub-hosted Windows runners can
    # launch nested Windows PowerShell with Microsoft.PowerShell.Utility absent
    # from PSModulePath, which makes the New-TemporaryFile cmdlet unavailable.
    return Get-Item -LiteralPath ([System.IO.Path]::GetTempFileName())
}

# Wait for exactly one process to exit.
#
# `Start-Process -Wait` does not do this: PowerShell puts the child in a job
# object and waits for every process it spawned as well. An MSVC-backed cargo
# build leaves `vctip.exe` (the Visual C++ telemetry helper) running long after
# cl.exe and cargo are gone, so `-Wait` hangs there indefinitely -- the launcher
# would print "cargo build distillctl", finish the build, and then sit forever with
# no output. Starting with -PassThru but no -Wait and joining on the process
# handle waits for that process only.
# Every `Start-Process -PassThru` call site reads `$process.Handle` right
# after starting: .NET only records the exit code for a Process object that
# holds its handle, and without it ExitCode comes back $null, which every
# `-ne 0` check then reads as a failure (CI lost the MSVC environment to it).
function Wait-ForProcessExit {
    param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)
    $Process.WaitForExit()
    # WaitForExit() returns as soon as the process object is signalled, which
    # can be before ExitCode is populated on the PowerShell-side object.
    $Process.Refresh()
    return $Process
}

function Invoke-CaptureCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$WorkingDirectory = (Get-Location).Path
    )

    $stdout = New-DistillTemporaryFile
    $stderr = New-DistillTemporaryFile
    try {
        $arguments = Join-WindowsProcessArguments $ArgumentList
        $process = Start-Process -FilePath $FilePath -ArgumentList $arguments -WorkingDirectory $WorkingDirectory -PassThru -NoNewWindow -RedirectStandardOutput $stdout.FullName -RedirectStandardError $stderr.FullName
        $null = $process.Handle
        Wait-ForProcessExit -Process $process | Out-Null
        $output = @()
        if (Test-Path $stdout.FullName) {
            $output += @(Get-Content $stdout.FullName -ErrorAction SilentlyContinue)
        }
        if (Test-Path $stderr.FullName) {
            $output += @(Get-Content $stderr.FullName -ErrorAction SilentlyContinue)
        }
    } finally {
        Remove-Item -LiteralPath $stdout.FullName, $stderr.FullName -Force -ErrorAction SilentlyContinue
    }

    $text = (@($output) -join [Environment]::NewLine).Trim()
    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        Output = $text
        Lines = @($output)
    }
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$WorkingDirectory = (Get-Location).Path,
        [string]$Label = $FilePath
    )

    Write-WindowsDevInfo $Label
    $resolved = Get-CommandSource $FilePath
    if (-not [string]::IsNullOrWhiteSpace($resolved)) {
        $FilePath = $resolved
    }

    if ([System.IO.Path]::GetExtension($FilePath) -ieq ".cmd" -or [System.IO.Path]::GetExtension($FilePath) -ieq ".bat") {
        $command = "`"$FilePath`" $(Join-WindowsProcessArguments $ArgumentList)"
        $process = Start-Process -FilePath "cmd.exe" -ArgumentList "/d /s /c `"$command`"" -WorkingDirectory $WorkingDirectory -PassThru -NoNewWindow
        $null = $process.Handle
    } else {
        $arguments = Join-WindowsProcessArguments $ArgumentList
        $process = Start-Process -FilePath $FilePath -ArgumentList $arguments -WorkingDirectory $WorkingDirectory -PassThru -NoNewWindow
        $null = $process.Handle
    }
    Wait-ForProcessExit -Process $process | Out-Null
    if ($process.ExitCode -ne 0) {
        throw "$Label failed with exit code $($process.ExitCode)."
    }
}

# Invoke a sibling PowerShell script as a native child process and fail on a
# nonzero exit code. Dot-sourcing or `& script.ps1` runs the child in-process,
# where a SUCCESSFUL script leaves $LASTEXITCODE untouched (commonly $null),
# so a following `if ($LASTEXITCODE -ne 0)` guard reads a stale/`$null` value
# and false-fails ($null -ne 0 is $true). Running the script through the same
# host executable that is running this process gives it a real, deliberately
# captured native exit code, so success (0) and failure (nonzero) are both
# detected correctly and control only proceeds past a genuinely successful step.
function Invoke-WindowsChildScript {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$ArgumentList = @(),
        [string]$Label = $ScriptPath
    )

    if (-not (Test-Path $ScriptPath -PathType Leaf)) {
        throw "Child script not found: $ScriptPath"
    }

    $shell = (Get-Process -Id $PID).Path
    if ([string]::IsNullOrWhiteSpace($shell)) {
        throw "Could not resolve the current PowerShell host executable to run $ScriptPath."
    }

    # Windows PowerShell (powershell.exe) honours machine execution policy; if it
    # is Restricted/AllSigned the child would refuse to run even though the
    # parent lane started under -ExecutionPolicy Bypass. Pass Bypass to the child
    # too when the host is powershell.exe (pwsh ignores per-invocation policy).
    $shellArgs = @("-NoProfile")
    if ([System.IO.Path]::GetFileNameWithoutExtension($shell) -ieq "powershell") {
        $shellArgs += @("-ExecutionPolicy", "Bypass")
    }
    $shellArgs += @("-File", $ScriptPath)
    $shellArgs += $ArgumentList

    Write-WindowsDevInfo $Label
    $process = Start-Process -FilePath $shell -ArgumentList (Join-WindowsProcessArguments $shellArgs) -PassThru -NoNewWindow
    $null = $process.Handle
    Wait-ForProcessExit -Process $process | Out-Null
    if ($process.ExitCode -ne 0) {
        throw "$Label failed with exit code $($process.ExitCode)."
    }
}

function Join-WindowsProcessArguments {
    param([string[]]$Arguments)
    $quoted = foreach ($argument in $Arguments) {
        if ($argument -match '[\s"]') {
            # MSVCRT quoting: backslashes are literal except when they precede
            # a double quote, so double any run of trailing backslashes before
            # an escaped quote or the closing quote (`C:\path\` stays intact).
            $escaped = $argument -replace '(\\*)"', '$1$1\"'
            $escaped = $escaped -replace '(\\+)$', '$1$1'
            '"' + $escaped + '"'
        } else {
            $argument
        }
    }
    return ($quoted -join " ")
}

# Maps the renderer build gates onto the matching Tauri Cargo feature set.
function Get-DistillAppFeatures {
    param([string[]]$BaseFeatures = @("distillctl", "app-test-driver"))

    $features = New-Object System.Collections.Generic.List[string]
    foreach ($feature in $BaseFeatures) {
        if (-not [string]::IsNullOrWhiteSpace($feature)) {
            $features.Add($feature)
        }
    }
    return ($features -join ",")
}

function Normalize-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not [System.IO.Path]::IsPathRooted($Path)) {
        # GetFullPath resolves relative paths against the process CWD, which
        # PowerShell's Set-Location does not update; cleanup paths must always
        # be rooted so a stray relative value cannot resolve somewhere else.
        throw "Refusing to normalize relative path '$Path'; cleanup paths must be absolute."
    }
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Assert-SafeCleanupPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedRoot
    )
    $full = Normalize-FullPath $Path
    $root = Normalize-FullPath $AllowedRoot

    # Never allow removal of broad user/system roots, whatever the caller
    # passed as AllowedRoot; a bad env override must not become `rm -rf $HOME`.
    $protected = New-Object System.Collections.Generic.List[string]
    foreach ($candidate in @($env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA, $env:TEMP, $env:SystemRoot, $env:ProgramFiles, $HOME, (Get-DistillRepoRoot))) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            $protected.Add((Normalize-FullPath $candidate))
        }
    }
    if ([System.IO.Path]::GetPathRoot($full).TrimEnd('\', '/') -eq $full) {
        throw "Refusing to remove drive root $Path."
    }
    foreach ($protectedRoot in $protected) {
        if ($full -ieq $protectedRoot) {
            throw "Refusing to remove protected directory $Path."
        }
    }

    if ($full -ieq $root) {
        return
    }
    $prefix = $root + [System.IO.Path]::DirectorySeparatorChar
    if ($full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        return
    }
    throw "Refusing to remove $Path because it is outside expected cleanup root $AllowedRoot."
}

function Get-LocalAppDataRoot {
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        return $env:LOCALAPPDATA
    }
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        return (Join-Path $env:USERPROFILE "AppData\Local")
    }
    return (Join-Path $HOME "AppData\Local")
}

function Get-UserProfileRoot {
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        return $env:USERPROFILE
    }
    return $HOME
}

function Get-RoamingAppDataRoot {
    if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
        return $env:APPDATA
    }
    return (Join-Path (Get-UserProfileRoot) "AppData\Roaming")
}

function Get-FnmRoot {
    if (-not [string]::IsNullOrWhiteSpace($env:FNM_DIR)) {
        return $env:FNM_DIR
    }
    return (Join-Path (Get-RoamingAppDataRoot) "fnm")
}

function Resolve-WindowsCleanupPaths {
    $localAppData = Get-LocalAppDataRoot
    $userProfile = Get-UserProfileRoot
    $fnmRoot = Get-FnmRoot
    $blockCertDir = Join-Path $userProfile ".block-certs"
    $nodeVersion = "v$(Get-RequiredNodeVersion)"
    $repoRoot = Get-DistillRepoRoot

    # Honor the same overrides the rest of the lane uses so cleanup targets
    # the state that setup/dev actually created: the active cargo target dir
    # (repo-local unless DISTILL_TAURI_CARGO_TARGET_DIR overrides it), plus the
    # %LOCALAPPDATA%\berd-tauri tree older checkouts left behind.
    $distillTauriRoot = Get-TauriCargoTargetDir
    $legacyDistillTauriRoot = Get-LegacyTauriCargoTargetRoot
    if ($legacyDistillTauriRoot -eq $distillTauriRoot) {
        $legacyDistillTauriRoot = $null
    }

    return [pscustomobject]@{
        DistillDevRoot = (Get-DistillDevRoot)
        DistillTauriRoot = $distillTauriRoot
        LegacyDistillTauriRoot = $legacyDistillTauriRoot
        BlockCertDir = $blockCertDir
        BlockCertFile = Join-Path $blockCertDir "root-certs.pem"
        CorepackPnpmVersionDir = Join-Path $localAppData "node\corepack\v1\pnpm\$(Get-RequiredPnpmVersion)"
        FnmRoot = $fnmRoot
        FnmNodeVersionDir = Join-Path $fnmRoot "node-versions\$nodeVersion"
        FnmMultishellsDir = Join-Path $localAppData "fnm_multishells"
        RepoNodeModules = Join-Path $repoRoot "node_modules"
        RepoPnpmStore = Join-Path $repoRoot ".pnpm-store"
        RepoDist = Join-Path $repoRoot "dist"
        GitHooksDir = Join-Path $repoRoot ".git\hooks"
    }
}

function Get-DistillDevRoot {
    $devRoot = $env:DISTILL_DEV_ROOT
    if ([string]::IsNullOrWhiteSpace($devRoot)) {
        $devRoot = Join-Path (Get-LocalAppDataRoot) "distill-dev"
    }
    return $devRoot
}

function Get-TauriCargoTargetDir {
    if (-not [string]::IsNullOrWhiteSpace($env:DISTILL_TAURI_CARGO_TARGET_DIR)) {
        return $env:DISTILL_TAURI_CARGO_TARGET_DIR
    }
    # Repo-local by default. A debug Tauri build of this workspace is 30-60 GB
    # (deps + incremental + PDBs); parking that under %LOCALAPPDATA% fills the
    # system drive and, when the checkout lives on another drive, keeps a
    # second full copy alive next to the one `Launch-Distill.ps1` builds.
    # Point DISTILL_TAURI_CARGO_TARGET_DIR somewhere else to override.
    return (Join-Path (Get-DistillRepoRoot) "src-tauri\target")
}

# Where pre-2026-09 checkouts wrote the Tauri cargo target. Kept only so
# cleanup can reclaim it; nothing builds here any more.
function Get-LegacyTauriCargoTargetRoot {
    return (Join-Path (Get-LocalAppDataRoot) "berd-tauri")
}

# $true when $Path sits on the drive Windows booted from. Used to warn before
# a multi-tens-of-GB build cache lands on the system drive.
function Test-PathOnSystemDrive {
    param([Parameter(Mandatory = $true)][string]$Path)
    $systemDrive = $env:SystemDrive
    if ([string]::IsNullOrWhiteSpace($systemDrive)) { return $false }
    try {
        $full = [System.IO.Path]::GetFullPath($Path)
    } catch {
        return $false
    }
    return $full.StartsWith(($systemDrive.TrimEnd("\") + "\"), [System.StringComparison]::OrdinalIgnoreCase)
}

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-Content -Raw -Path $Path | ConvertFrom-Json)
}

function Get-ObjectValue {
    param(
        [AllowNull()]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )
    if ($null -eq $Object) {
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Test-WindowsCommandAvailability {
    param([Parameter(Mandatory = $true)][string]$Name)

    $source = Get-CommandSource $Name
    $usesCodexRuntime = (-not [string]::IsNullOrWhiteSpace($source)) -and (Test-CodexRuntimePath $source)
    return [pscustomobject]@{
        Name = $Name
        Source = $source
        Available = (-not [string]::IsNullOrWhiteSpace($source)) -and (-not $usesCodexRuntime)
        UsesCodexRuntime = $usesCodexRuntime
    }
}

# Availability check from an already-resolved source path (used for tools like
# pnpm/corepack where the shim name varies: pnpm.cmd, pnpm.exe, pnpm.ps1).
function Test-ResolvedCommandAvailability {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [AllowNull()][AllowEmptyString()][string]$Source
    )
    $usesCodexRuntime = (-not [string]::IsNullOrWhiteSpace($Source)) -and (Test-CodexRuntimePath $Source)
    return [pscustomobject]@{
        Name = $Name
        Source = $Source
        Available = (-not [string]::IsNullOrWhiteSpace($Source)) -and (-not $usesCodexRuntime)
        UsesCodexRuntime = $usesCodexRuntime
    }
}

function Test-PnpmVersion {
    param([AllowNull()][AllowEmptyString()][string]$Version)

    return (-not [string]::IsNullOrWhiteSpace($Version)) -and ($Version.Trim() -eq (Get-RequiredPnpmVersion))
}

function Get-PnpmReadiness {
    param([AllowNull()][AllowEmptyString()][string]$Source = (Get-PnpmCommand))

    $availability = Test-ResolvedCommandAvailability -Name "pnpm" -Source $Source
    $version = $null
    if ($availability.Available) {
        $result = Invoke-CaptureCommand -FilePath $Source -ArgumentList @("--version")
        if ($result.ExitCode -eq 0) {
            $version = $result.Output.Trim()
        }
    }

    return [pscustomobject]@{
        Name = $availability.Name
        Source = $availability.Source
        Available = $availability.Available
        UsesCodexRuntime = $availability.UsesCodexRuntime
        Version = $version
        Ready = Test-PnpmVersion -Version $version
    }
}

function Get-WindowsPrerequisiteSnapshot {
    $winGet = Test-WindowsCommandAvailability "winget"
    $git = Test-WindowsCommandAvailability "git"
    $rustup = Test-WindowsCommandAvailability "rustup"
    $rustc = Test-WindowsCommandAvailability "rustc"
    $cargo = Test-WindowsCommandAvailability "cargo"
    $fnm = Test-WindowsCommandAvailability "fnm"

    if ($fnm.Available) {
        Initialize-FnmEnvironment | Out-Null
    }

    $node = Test-WindowsCommandAvailability "node"
    $corepack = Test-ResolvedCommandAvailability -Name "corepack" -Source (Get-CorepackCommand)
    $pnpm = Get-PnpmReadiness
    $cmake = Test-WindowsCommandAvailability "cmake"
    $just = Test-WindowsCommandAvailability "just"
    $lefthook = Test-WindowsCommandAvailability "lefthook"

    $gitBash = Get-GitBashPath
    $msvcPath = Get-MsvcInstallPath
    $buildToolsPath = $null
    if ([string]::IsNullOrWhiteSpace($msvcPath)) {
        $buildToolsPath = Get-VisualStudioBuildToolsInstallPath
    }
    $msvcReady = $false
    if (-not [string]::IsNullOrWhiteSpace($msvcPath)) {
        $msvcReady = (Initialize-MsvcEnvironment) -and -not [string]::IsNullOrWhiteSpace((Get-CommandSource "link.exe"))
    }

    $npmReachability = $null
    if ($node.Available) {
        $npmReachability = Test-NpmRegistryReachability
    }

    return [pscustomobject]@{
        WinGet = $winGet
        Git = $git
        GitBash = [pscustomobject]@{ Found = -not [string]::IsNullOrWhiteSpace($gitBash); Path = $gitBash }
        Msvc = [pscustomobject]@{ Ready = $msvcReady; InstallPath = $msvcPath; BuildToolsPath = $buildToolsPath }
        WebView2 = Test-WebView2Runtime
        Rustup = $rustup
        Rustc = $rustc
        Cargo = $cargo
        Fnm = $fnm
        Node = $node
        Corepack = $corepack
        Pnpm = $pnpm
        NpmReachability = $npmReachability
        Cmake = $cmake
        Just = $just
        Lefthook = $lefthook
    }
}

function Get-WindowsExeName {
    param([Parameter(Mandatory = $true)][string]$Name)
    if ($Name.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase)) {
        return $Name
    }
    return "$Name.exe"
}

# ── Windows sidecar staging ──────────────────────────────────
# Tauri resolves externalBin entries on Windows as `<stem>-<triple>.exe`.
# Unlike the Unix scripts, Windows has no execute bit: "executability" is
# expressed as a valid PE image of the target architecture. These helpers
# parse the PE headers directly so staging can reject non-PE inputs, wrong
# architectures, and truncated files instead of trusting a chmod that does
# nothing on Windows.

# COFF machine identifiers from winnt.h (IMAGE_FILE_MACHINE_*).
$script:PeMachineAmd64 = 0x8664
$script:PeMachineArm64 = 0xAA64
$script:PeMachineI386 = 0x014C
# IMAGE_FILE_EXECUTABLE_IMAGE from the COFF Characteristics field.
$script:PeCharacteristicsExecutableImage = 0x0002

# Return the exact Tauri-resolved sidecar file name for a stem/triple, e.g.
# Get-WindowsSidecarName "distillctl" "x86_64-pc-windows-msvc"
#   -> distillctl-x86_64-pc-windows-msvc.exe
function Get-WindowsSidecarName {
    param(
        [Parameter(Mandatory = $true)][string]$Stem,
        [Parameter(Mandatory = $true)][string]$Triple
    )
    return (Get-WindowsExeName "$Stem-$Triple")
}

# Map a Windows target triple to the COFF machine value its binaries must
# carry. Returns $null for triples this staging path does not support.
function Get-WindowsTripleMachine {
    param([Parameter(Mandatory = $true)][string]$Triple)
    switch -Regex ($Triple) {
        '^(x86_64|x86_64h)-.*-windows-' { return $script:PeMachineAmd64 }
        '^aarch64-.*-windows-' { return $script:PeMachineArm64 }
        '^(i586|i686)-.*-windows-' { return $script:PeMachineI386 }
        default { return $null }
    }
}

# Parse the PE headers of a file without executing it. Returns an object
# describing whether the file is a PE image, its COFF machine value, and
# whether the executable-image characteristic is set. `IsPe` is $false for
# anything that is not a well-formed PE (missing MZ/PE signatures, truncated
# headers, or a shell script masquerading as a binary).
function Get-PeFileInfo {
    param([Parameter(Mandatory = $true)][string]$Path)

    $result = [pscustomobject]@{
        IsPe = $false
        Machine = $null
        IsExecutableImage = $false
    }

    if (-not (Test-Path $Path -PathType Leaf)) {
        return $result
    }

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    # Need at least the DOS header up to the e_lfanew pointer at 0x3C.
    if ($bytes.Length -lt 64) {
        return $result
    }
    # DOS magic "MZ".
    if ($bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
        return $result
    }

    $peOffset = [System.BitConverter]::ToInt32($bytes, 0x3C)
    # PE signature (4) + COFF header (20) must fit within the file.
    if ($peOffset -lt 0 -or ($peOffset + 24) -gt $bytes.Length) {
        return $result
    }
    # PE signature "PE\0\0".
    if ($bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45 -or
        $bytes[$peOffset + 2] -ne 0x00 -or $bytes[$peOffset + 3] -ne 0x00) {
        return $result
    }

    # COFF header layout (20 bytes, starting after the 4-byte PE signature):
    #   +0  Machine (u16)          +16 SizeOfOptionalHeader (u16)
    #   +2  NumberOfSections (u16) +18 Characteristics (u16)
    $coffOffset = $peOffset + 4
    $machine = [System.BitConverter]::ToUInt16($bytes, $coffOffset)
    $numberOfSections = [System.BitConverter]::ToUInt16($bytes, $coffOffset + 2)
    $sizeOfOptionalHeader = [System.BitConverter]::ToUInt16($bytes, $coffOffset + 16)
    $characteristics = [System.BitConverter]::ToUInt16($bytes, $coffOffset + 18)

    # A real image must carry an optional header; the section table follows it.
    # Verify both regions fit in the file so a file truncated after the COFF
    # header (or with a bogus header size) is rejected rather than blessed.
    $optionalHeaderOffset = $coffOffset + 20
    # The optional-header magic (first 2 bytes) is needed to know the required
    # minimum size, so the header must at least reach it and fit in the file.
    if ($sizeOfOptionalHeader -lt 2) {
        return $result
    }
    if (($optionalHeaderOffset + [int]$sizeOfOptionalHeader) -gt $bytes.Length) {
        return $result
    }

    # Optional-header magic distinguishes PE32 (0x10B) from PE32+ (0x20B).
    # Anything else is not a loadable image.
    $optionalMagic = [System.BitConverter]::ToUInt16($bytes, $optionalHeaderOffset)
    if ($optionalMagic -ne 0x10B -and $optionalMagic -ne 0x20B) {
        return $result
    }

    # Enforce the architecture-appropriate minimum optional-header size. The
    # PE/COFF spec fixes the standard + Windows-specific fields at 96 bytes for
    # PE32 and 112 bytes for PE32+ (before the optional data directories). A
    # SizeOfOptionalHeader smaller than this cannot describe a loadable image,
    # so a file that stops just past the magic (the reachable minimal-file
    # defect) is rejected here rather than blessed.
    $minOptionalHeaderSize = if ($optionalMagic -eq 0x20B) { 112 } else { 96 }
    if ([int]$sizeOfOptionalHeader -lt $minOptionalHeaderSize) {
        return $result
    }

    # A loadable image has at least one section. Reject NumberOfSections = 0 so
    # a header-only file with no section table cannot pass.
    if ($numberOfSections -lt 1) {
        return $result
    }

    # The section table is NumberOfSections * 40 bytes immediately after the
    # optional header; require it to fit as well.
    $sectionTableOffset = $optionalHeaderOffset + [int]$sizeOfOptionalHeader
    $sectionTableBytes = [int]$numberOfSections * 40
    if (($sectionTableOffset + $sectionTableBytes) -gt $bytes.Length) {
        return $result
    }

    $result.IsPe = $true
    $result.Machine = [int]$machine
    $result.IsExecutableImage = (($characteristics -band $script:PeCharacteristicsExecutableImage) -ne 0)
    return $result
}

# Validate that a file is a PE executable image whose architecture matches the
# requested target triple. Throws with an actionable message otherwise. This
# replaces the Unix `chmod +x`/`[[ -x ]]` executability contract, which is a
# no-op on Windows.
function Assert-WindowsSidecarBinary {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Triple
    )

    $expectedMachine = Get-WindowsTripleMachine -Triple $Triple
    if ($null -eq $expectedMachine) {
        throw "Unsupported Windows sidecar target triple: $Triple"
    }

    $info = Get-PeFileInfo -Path $Path
    if (-not $info.IsPe) {
        throw "Sidecar is not a valid Windows PE executable: $Path"
    }
    if (-not $info.IsExecutableImage) {
        throw "Sidecar PE image is not marked executable: $Path"
    }
    if ($info.Machine -ne $expectedMachine) {
        throw ("Sidecar architecture 0x{0:X4} does not match {1} (expected 0x{2:X4}): {3}" -f `
            $info.Machine, $Triple, $expectedMachine, $Path)
    }
}

# Compute the SHA-256 of a file as a lowercase hex string without relying on
# Microsoft.PowerShell.Utility. GitHub-hosted runners can launch nested shells
# with that module absent from PSModulePath.
function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha256.ComputeHash($stream)
        return ([System.BitConverter]::ToString($hash)).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

# Remove stale staged sidecars for a stem before writing the current one so a
# renamed target triple, a leftover extensionless Unix-staged file, or an
# aborted prior run cannot linger in the bundle inputs. Only files matching
# the stem are touched.
function Remove-StaleWindowsSidecars {
    param(
        [Parameter(Mandatory = $true)][string]$BinDir,
        [Parameter(Mandatory = $true)][string]$Stem,
        [Parameter(Mandatory = $true)][string]$KeepName
    )

    if (-not (Test-Path $BinDir -PathType Container)) {
        return
    }

    # `<stem>-<triple>` with or without .exe, plus the bare `<stem>`/`<stem>.exe`
    # the Unix scripts would have produced under Git Bash.
    Get-ChildItem -Path $BinDir -File -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.Name -like "$Stem-*") -or ($_.Name -eq $Stem) -or ($_.Name -eq (Get-WindowsExeName $Stem))
        } |
        Where-Object { $_.Name -ne $KeepName } |
        ForEach-Object { Remove-Item -Path $_.FullName -Force -ErrorAction Stop }
}

# Stage one sidecar for Tauri's Windows externalBin resolution. Validates the
# source PE/architecture, clears stale staged files, copies to the exact
# `<stem>-<triple>.exe` name, then re-validates the staged copy and confirms it
# is a byte-for-byte match of the source. Returns the staged path.
function Stage-WindowsSidecar {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$Triple,
        [Parameter(Mandatory = $true)][string]$Stem,
        [Parameter(Mandatory = $true)][string]$BinDir
    )

    if (-not (Test-Path $SourcePath -PathType Leaf)) {
        throw "Sidecar source binary not found: $SourcePath"
    }
    Assert-WindowsSidecarBinary -Path $SourcePath -Triple $Triple

    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    $stagedName = Get-WindowsSidecarName -Stem $Stem -Triple $Triple
    $stagedPath = Join-Path $BinDir $stagedName

    Remove-StaleWindowsSidecars -BinDir $BinDir -Stem $Stem -KeepName $stagedName

    $sourceSha = Get-FileSha256 -Path $SourcePath
    Copy-Item -Path $SourcePath -Destination $stagedPath -Force

    $stagedSha = Get-FileSha256 -Path $stagedPath
    if ($stagedSha -ne $sourceSha) {
        throw "Staged sidecar checksum mismatch for $stagedPath (expected $sourceSha, got $stagedSha)."
    }
    Assert-WindowsSidecarBinary -Path $stagedPath -Triple $Triple

    return $stagedPath
}

function Get-GitDescribeVersion {
    $describe = Invoke-CaptureCommand -FilePath "git" -ArgumentList @("-C", $script:RepoRoot, "describe", "--tags", "--long", "--dirty", "--match", "v[0-9]*.[0-9]*.[0-9]*")
    if ($describe.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($describe.Output)) {
        return $null
    }
    $value = $describe.Output.Trim()
    if ($value -match '^v?([0-9]+)\.([0-9]+)\.([0-9]+)-([0-9]+)-g([0-9a-f]+)(-dirty)?$') {
        $major = [int]$Matches[1]
        $minor = [int]$Matches[2]
        $patch = [int]$Matches[3]
        $commits = [int]$Matches[4]
        $sha = $Matches[5]
        $dirty = $Matches[6]
        if ($commits -eq 0 -and [string]::IsNullOrWhiteSpace($dirty)) {
            $numeric = "$major.$minor.$patch"
            return [pscustomobject]@{ Version = $numeric; RichVersion = $numeric }
        }
        $numeric = "$major.$minor.$($patch + 1)"
        $rich = "$numeric-dev.$commits+g$sha"
        if (-not [string]::IsNullOrWhiteSpace($dirty)) {
            $rich = "$rich.dirty"
        }
        return [pscustomobject]@{ Version = $numeric; RichVersion = $rich }
    }
    return $null
}

function Resolve-AppVersion {
    param([AllowNull()][string]$Override)

    if ([string]::IsNullOrWhiteSpace($Override)) {
        $Override = $env:DISTILL_APP_VERSION_OVERRIDE
    }
    if (-not [string]::IsNullOrWhiteSpace($Override)) {
        $numeric = ($Override -split "[-+]")[0]
        return [pscustomobject]@{ Version = $numeric; RichVersion = $Override }
    }

    $gitVersion = Get-GitDescribeVersion
    if ($null -ne $gitVersion) {
        return $gitVersion
    }

    $package = Read-JsonFile (Join-Path $script:RepoRoot "package.json")
    $version = Get-ObjectValue $package "version"
    return [pscustomobject]@{ Version = $version; RichVersion = $version }
}

function New-E2eRunContract {
    param(
        [Parameter(Mandatory = $true)][string]$RunRoot,
        [AllowNull()][AllowEmptyString()][string]$RunId,
        [AllowNull()][AllowEmptyString()][string]$DriverToken
    )

    $normalizedRoot = Normalize-FullPath $RunRoot
    $rootRunId = Split-Path -Leaf $normalizedRoot
    if ([string]::IsNullOrWhiteSpace($RunId)) {
        $RunId = $rootRunId
    }
    if ($RunId -notmatch '^[A-Za-z0-9-]{1,64}$') {
        throw "DISTILL_E2E_RUN_ID must be 1-64 ASCII letters, digits, or '-'."
    }
    if ($rootRunId -cne $RunId) {
        throw "DISTILL_E2E_RUN_ROOT must end with DISTILL_E2E_RUN_ID '$RunId'."
    }

    if ([string]::IsNullOrWhiteSpace($DriverToken)) {
        $bytes = New-Object byte[] 32
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $rng.GetBytes($bytes)
        } finally {
            $rng.Dispose()
        }
        $DriverToken = -join ($bytes | ForEach-Object { $_.ToString("x2") })
    }
    if ($DriverToken -cnotmatch '^[A-Za-z0-9]{32,128}$') {
        throw "APP_TEST_DRIVER_TOKEN must be 32-128 ASCII letters or digits."
    }

    return [pscustomobject]@{
        RunRoot = $normalizedRoot
        RunId = $RunId
        Identifier = "com.levocat.distill.e2e.$RunId"
        DriverToken = $DriverToken
        ConfigPath = Join-Path $normalizedRoot "tauri-dev-windows.config.json"
        DriverReadyPath = Join-Path $normalizedRoot "app-test-driver.json"
    }
}

function Get-StableVitePort {
    $path = (Get-Location).Path
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($path)
    $hash = $sha.ComputeHash($bytes)
    # Match the unix recipe exactly: python's int(hexdigest, 16) reads the
    # digest big-endian; BigInteger wants little-endian with a zero pad byte
    # to stay unsigned.
    [System.Array]::Reverse($hash)
    $unsigned = New-Object byte[] ($hash.Length + 1)
    [System.Array]::Copy($hash, 0, $unsigned, 0, $hash.Length)
    $value = New-Object System.Numerics.BigInteger (, $unsigned)
    return [int](10000 + ($value % 55000))
}

function Get-RustHostTriple {
    $result = Invoke-CaptureCommand -FilePath "rustc" -ArgumentList @("-vV")
    if ($result.ExitCode -ne 0) {
        return $null
    }
    foreach ($line in ($result.Output -split "`r?`n")) {
        if ($line -match '^host:\s*(.+)$') {
            return $Matches[1].Trim()
        }
    }
    return $null
}

function Get-GitBashPath {
    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $candidates += (Join-Path $env:ProgramFiles "Git\bin\bash.exe")
    }
    $programFilesX86 = ${env:ProgramFiles(x86)}
    if (-not [string]::IsNullOrWhiteSpace($programFilesX86)) {
        $candidates += (Join-Path $programFilesX86 "Git\bin\bash.exe")
    }
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate -PathType Leaf) {
            return $candidate
        }
    }
    return (Get-CommandSource "bash")
}

function Get-VsWherePath {
    $candidates = @()
    $programFilesX86 = ${env:ProgramFiles(x86)}
    if (-not [string]::IsNullOrWhiteSpace($programFilesX86)) {
        $candidates += (Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe")
    }
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $candidates += (Join-Path $env:ProgramFiles "Microsoft Visual Studio\Installer\vswhere.exe")
    }
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate -PathType Leaf) {
            return $candidate
        }
    }
    return (Get-CommandSource "vswhere")
}

function Get-VsInstallerPath {
    $candidates = @()
    $programFilesX86 = ${env:ProgramFiles(x86)}
    if (-not [string]::IsNullOrWhiteSpace($programFilesX86)) {
        $candidates += (Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\setup.exe")
        $candidates += (Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vs_installer.exe")
    }
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $candidates += (Join-Path $env:ProgramFiles "Microsoft Visual Studio\Installer\setup.exe")
        $candidates += (Join-Path $env:ProgramFiles "Microsoft Visual Studio\Installer\vs_installer.exe")
    }
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate -PathType Leaf) {
            return $candidate
        }
    }
    return (Get-CommandSource "vs_installer")
}

function Get-VisualStudioInstallPathFromInstanceState {
    $programData = $env:ProgramData
    if ([string]::IsNullOrWhiteSpace($programData)) {
        $systemDrive = $env:SystemDrive
        if ([string]::IsNullOrWhiteSpace($systemDrive)) {
            $systemDrive = [System.IO.Path]::GetPathRoot($env:SystemRoot)
        }
        if ([string]::IsNullOrWhiteSpace($systemDrive)) {
            return $null
        }
        $programData = Join-Path $systemDrive "ProgramData"
    }
    $instancesRoot = Join-Path $programData "Microsoft\VisualStudio\Packages\_Instances"
    if (-not (Test-Path $instancesRoot -PathType Container)) {
        return $null
    }

    # Recovery path for hosts where Visual Studio Installer state exists but
    # vswhere returns nothing. Never guess an install path from directory names.
    $candidates = New-Object System.Collections.Generic.List[object]
    foreach ($stateFile in Get-ChildItem $instancesRoot -Filter "state.json" -Recurse -File -ErrorAction SilentlyContinue) {
        try {
            $state = Get-Content $stateFile.FullName -Raw | ConvertFrom-Json
            $installPath = Get-ObjectValue $state "installationPath"
            $product = Get-ObjectValue (Get-ObjectValue $state "product") "id"
            $isComplete = Get-ObjectValue $state "isComplete"
            $isLaunchable = Get-ObjectValue $state "isLaunchable"
            $vsDevCmd = if ([string]::IsNullOrWhiteSpace($installPath)) { $null } else { Join-Path $installPath "Common7\Tools\VsDevCmd.bat" }
            if ($product -eq "Microsoft.VisualStudio.Product.BuildTools" -and
                -not [string]::IsNullOrWhiteSpace($installPath) -and
                $isComplete -ne $false -and
                $isLaunchable -ne $false -and
                (Test-Path $vsDevCmd -PathType Leaf)) {
                $candidates.Add([pscustomobject]@{
                    InstallPath = $installPath
                    InstalledAt = $stateFile.LastWriteTimeUtc
                })
            }
        } catch {
            continue
        }
    }

    $selected = $candidates | Sort-Object InstalledAt -Descending | Select-Object -First 1
    if ($null -eq $selected) {
        return $null
    }
    return $selected.InstallPath
}
function Get-VisualStudioBuildToolsInstallPath {
    $vswhere = Get-VsWherePath
    if (-not [string]::IsNullOrWhiteSpace($vswhere)) {
        $result = Invoke-CaptureCommand -FilePath $vswhere -ArgumentList @("-latest", "-products", "Microsoft.VisualStudio.Product.BuildTools", "-property", "installationPath")
        if ($result.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($result.Output)) {
            return ($result.Output -split "`r?`n" | Select-Object -First 1).Trim()
        }
    }
    return (Get-VisualStudioInstallPathFromInstanceState)
}

function Get-MsvcInstallPath {
    $vswhere = Get-VsWherePath
    if (-not [string]::IsNullOrWhiteSpace($vswhere)) {
        $result = Invoke-CaptureCommand -FilePath $vswhere -ArgumentList @("-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath")
        if ($result.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($result.Output)) {
            return ($result.Output -split "`r?`n" | Select-Object -First 1).Trim()
        }
    }
    return (Get-VisualStudioInstallPathFromInstanceState)
}

function Get-MsvcArch {
    if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
        return "arm64"
    }
    return "x64"
}

function Initialize-MsvcEnvironment {
    $installPath = Get-MsvcInstallPath
    if ([string]::IsNullOrWhiteSpace($installPath)) {
        return $false
    }

    $vsDevCmd = Join-Path $installPath "Common7\Tools\VsDevCmd.bat"
    if (-not (Test-Path $vsDevCmd -PathType Leaf)) {
        return $false
    }

    $arch = Get-MsvcArch
    $environmentFile = New-DistillTemporaryFile
    try {
        # Capturing `cmd.exe` output directly through Windows PowerShell can
        # return no pipeline records for batch files on some hosts. Have cmd
        # write the environment itself, then import the stable file contents.
        # VsDevCmd otherwise spawns vctip.exe (the VC telemetry sender),
        # which outlives cmd.exe and would keep any job-based wait blocked.
        $command = "set VSCMD_SKIP_SENDTELEMETRY=1 && call `"$vsDevCmd`" -no_logo -arch=$arch -host_arch=$arch >nul && set > `"$($environmentFile.FullName)`""
        $arguments = "/d /s /c `"$command`""
        $process = Start-Process cmd.exe -ArgumentList $arguments -PassThru -NoNewWindow
        $null = $process.Handle
        Wait-ForProcessExit -Process $process | Out-Null
        if ($process.ExitCode -ne 0) {
            return $false
        }
        $lines = Get-Content $environmentFile.FullName -ErrorAction Stop
    } finally {
        Remove-Item -LiteralPath $environmentFile.FullName -Force -ErrorAction SilentlyContinue
    }

    if ($null -eq $lines) {
        return $false
    }
    foreach ($line in $lines) {
        if ($line -match '^([^=]+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], "Process")
        }
    }
    Repair-WindowsSdkEnvironment
    return $true
}

function Repair-WindowsSdkEnvironment {
    if (-not [string]::IsNullOrWhiteSpace($env:WindowsSdkDir) -and
        -not [string]::IsNullOrWhiteSpace($env:WindowsSDKVersion) -and
        $env:WindowsSDKVersion -ne "\") {
        return
    }

    $sdk = Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Microsoft SDKs\Windows\v10.0" -ErrorAction SilentlyContinue
    if ($null -eq $sdk -or [string]::IsNullOrWhiteSpace($sdk.InstallationFolder)) {
        return
    }
    $versions = Get-ChildItem (Join-Path $sdk.InstallationFolder "Include") -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName "um\Windows.h") } |
        Sort-Object { [version]$_.Name } -Descending
    $version = $versions | Select-Object -First 1
    if ($null -eq $version) {
        return
    }

    $env:WindowsSdkDir = $sdk.InstallationFolder
    $env:WindowsSDKVersion = "$($version.Name)\"
    $env:UniversalCRTSdkDir = $sdk.InstallationFolder
    $env:UCRTVersion = $version.Name

    $include = @(
        (Join-Path $version.FullName "ucrt"),
        (Join-Path $version.FullName "shared"),
        (Join-Path $version.FullName "um"),
        (Join-Path $version.FullName "winrt"),
        (Join-Path $version.FullName "cppwinrt")
    ) | Where-Object { Test-Path $_ -PathType Container }
    $env:INCLUDE = (@($env:INCLUDE) + $include | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ";"

    $libRoot = Join-Path (Join-Path $sdk.InstallationFolder "Lib") $version.Name
    $lib = @(
        (Join-Path $libRoot "ucrt\x64"),
        (Join-Path $libRoot "um\x64")
    ) | Where-Object { Test-Path $_ -PathType Container }
    $env:LIB = (@($env:LIB) + $lib | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ";"

    $sdkBin = Join-Path (Join-Path (Join-Path $sdk.InstallationFolder "bin") $version.Name) "x64"
    if (Test-Path $sdkBin -PathType Container) {
        $env:Path = "$sdkBin;$env:Path"
    }
}

function Assert-MsvcEnvironment {
    if (-not (Initialize-MsvcEnvironment)) {
        throw "MSVC Build Tools are not ready. Run 'just bootstrap-windows install', then retry from PowerShell."
    }
    if ([string]::IsNullOrWhiteSpace((Get-CommandSource "link.exe"))) {
        throw "MSVC linker link.exe is not on PATH after loading the Visual Studio environment. Re-run 'just bootstrap-windows install' and ensure the Visual C++ tools workload completed."
    }
}

function Invoke-MsvcWorkloadInstall {
    $installPath = Get-MsvcInstallPath
    if ([string]::IsNullOrWhiteSpace($installPath)) {
        $installPath = Get-VisualStudioBuildToolsInstallPath
    }
    $installer = Get-VsInstallerPath
    if ([string]::IsNullOrWhiteSpace($installPath) -or [string]::IsNullOrWhiteSpace($installer)) {
        return $false
    }

    Write-WindowsDevInfo "Repairing Visual Studio Build Tools VC workload at $installPath."
    $arguments = @(
        "modify",
        "--installPath",
        $installPath,
        "--add",
        "Microsoft.VisualStudio.Workload.VCTools",
        "--includeRecommended",
        "--passive",
        "--norestart"
    )

    if (-not (Test-IsElevated)) {
        Write-WindowsDevInfo "Requesting administrator approval for Visual Studio Build Tools repair."
        try {
            $process = Start-Process -FilePath $installer -ArgumentList (Join-WindowsProcessArguments -Arguments $arguments) -Verb RunAs -Wait -PassThru
            Update-SessionPathFromRegistry
            if ($process.ExitCode -eq 0 -and (Initialize-MsvcEnvironment) -and -not [string]::IsNullOrWhiteSpace((Get-CommandSource "link.exe"))) {
                return $true
            }
            Write-WindowsDevInfo "Elevated Visual Studio repair exited with code $($process.ExitCode)."
            Write-WindowsDevInfo "Visual Studio repair did not make link.exe available."
            return $false
        } catch {
            Write-WindowsDevInfo "Could not start elevated Visual Studio repair: $($_.Exception.Message)"
            return $false
        }
    }

    $result = Invoke-CaptureCommand -FilePath $installer -ArgumentList $arguments
    Update-SessionPathFromRegistry
    if ($result.ExitCode -eq 0 -and (Initialize-MsvcEnvironment) -and -not [string]::IsNullOrWhiteSpace((Get-CommandSource "link.exe"))) {
        return $true
    }
    if (-not [string]::IsNullOrWhiteSpace($result.Output)) {
        Write-WindowsDevInfo $result.Output
    }
    Write-WindowsDevInfo "Visual Studio repair did not make link.exe available."
    return $false
}

function Invoke-CorepackPreparePnpm {
    $corepack = Get-CorepackCommand
    if ([string]::IsNullOrWhiteSpace($corepack)) {
        return $false
    }
    $oldPrompt = $env:COREPACK_ENABLE_DOWNLOAD_PROMPT
    try {
        $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
        Invoke-CheckedCommand -FilePath $corepack -ArgumentList @("prepare", "pnpm@$(Get-RequiredPnpmVersion)", "--activate") -Label "corepack prepare pnpm@$(Get-RequiredPnpmVersion)"
        return $true
    } catch {
        Write-WindowsDevInfo "Corepack could not activate pnpm: $($_.Exception.Message)"
        return $false
    } finally {
        $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = $oldPrompt
    }
}

function Invoke-NpmInstallPnpm {
    $npm = Get-NpmCommand
    if ([string]::IsNullOrWhiteSpace($npm)) {
        return $false
    }
    try {
        Invoke-CheckedCommand -FilePath $npm -ArgumentList @("install", "-g", "pnpm@$(Get-RequiredPnpmVersion)") -Label "npm install -g pnpm@$(Get-RequiredPnpmVersion)"
        return $true
    } catch {
        Write-WindowsDevInfo "npm could not install pnpm: $($_.Exception.Message)"
        return $false
    }
}

# npm's global prefix (%APPDATA%\npm by default). It is user-writable and
# already on the user PATH, unlike the Node install dir under Program Files.
function Get-NpmGlobalPrefix {
    $npm = Get-NpmCommand
    if ([string]::IsNullOrWhiteSpace($npm)) {
        return $null
    }
    $result = Invoke-CaptureCommand -FilePath $npm -ArgumentList @("prefix", "-g")
    if ($result.ExitCode -ne 0) {
        return $null
    }
    $prefix = $result.Output.Trim()
    if ([string]::IsNullOrWhiteSpace($prefix)) {
        return $null
    }
    return $prefix
}

# Put the pinned pnpm on PATH without elevation, and report whether it worked.
#
# `corepack prepare --activate` only fills Corepack's cache: it exits 0 while
# leaving `pnpm` unresolvable, so its exit code cannot be the success signal.
# `corepack enable` is what writes the shims, and by default it writes them
# next to node.exe -- under "C:\Program Files\nodejs" that needs admin. Both
# problems go away by pointing the shims at npm's global prefix, with a global
# npm install of the same pin as the last resort. Every step is verified by
# re-resolving pnpm.
function Install-PnpmForUser {
    if (-not [string]::IsNullOrWhiteSpace((Get-PnpmCommand))) {
        return $true
    }
    if ([string]::IsNullOrWhiteSpace((Get-CommandSource "node"))) {
        Write-WindowsDevInfo "node is unavailable, so pnpm cannot be provisioned"
        return $false
    }

    Initialize-PublicNpmEnvironment
    $prefix = Get-NpmGlobalPrefix
    $corepack = Get-CorepackCommand
    if (-not [string]::IsNullOrWhiteSpace($corepack)) {
        Invoke-CorepackPreparePnpm | Out-Null
        $enableArgs = @("enable")
        if (-not [string]::IsNullOrWhiteSpace($prefix)) {
            $enableArgs += @("--install-directory", $prefix)
        }
        $enable = Invoke-CaptureCommand -FilePath $corepack -ArgumentList $enableArgs
        if ($enable.ExitCode -ne 0) {
            Write-WindowsDevInfo "corepack enable failed: $($enable.Output)"
        }
    }

    Add-SessionPathEntry -Path $prefix
    Update-SessionPathFromRegistry
    Add-SessionPathEntry -Path $prefix
    if (-not [string]::IsNullOrWhiteSpace((Get-PnpmCommand))) {
        return $true
    }

    Invoke-NpmInstallPnpm | Out-Null
    Update-SessionPathFromRegistry
    Add-SessionPathEntry -Path $prefix
    return (-not [string]::IsNullOrWhiteSpace((Get-PnpmCommand)))
}

# Prepend $Path to the session PATH when it is a real directory that is not
# already there. Update-SessionPathFromRegistry rebuilds PATH from the
# registry, so callers that create a directory mid-run have to re-add it.
function Add-SessionPathEntry {
    param([AllowNull()][AllowEmptyString()][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Container)) {
        return
    }
    $existing = @($env:Path -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    foreach ($part in $existing) {
        if ($part.TrimEnd("\") -eq $Path.TrimEnd("\")) {
            return
        }
    }
    $env:Path = ($Path + ";" + $env:Path)
}

function Assert-PnpmReady {
    $pnpm = Get-PnpmCommand
    if ([string]::IsNullOrWhiteSpace($pnpm) -or (Test-CodexRuntimePath $pnpm)) {
        throw "pnpm is not available in the user environment."
    }

    $version = Invoke-CaptureCommand -FilePath $pnpm -ArgumentList @("--version")
    if ($version.ExitCode -eq 0 -and $version.Output.Trim() -eq (Get-RequiredPnpmVersion)) {
        return
    }

    throw "pnpm did not report $(Get-RequiredPnpmVersion). Run 'just bootstrap-windows install'."
}

function Test-NpmRegistryReachability {
    param([string]$Registry = $script:PublicNpmRegistry)

    Initialize-PublicNpmEnvironment
    if ([string]::IsNullOrWhiteSpace((Get-CommandSource "node"))) {
        return [pscustomobject]@{
            Ready = $false
            Message = "node is unavailable, so npm HTTPS reachability could not be checked"
        }
    }

    $script = @'
const https = require("node:https");
const url = process.argv[2];
const req = https.request(url, { method: "HEAD", timeout: 15000 }, (res) => {
  console.log(`HTTP ${res.statusCode}`);
  res.resume();
  process.exitCode = res.statusCode >= 400 ? 1 : 0;
});
req.on("timeout", () => req.destroy(new Error("timed out after 15s")));
req.on("error", (error) => {
  console.error(`${error.code || "ERROR"}: ${error.message}`);
  process.exit(1);
});
req.end();
'@

    $scriptFile = New-DistillTemporaryFile
    try {
        Set-Content -Path $scriptFile -Value $script -Encoding UTF8
        $result = Invoke-CaptureCommand -FilePath "node" -ArgumentList @($scriptFile.FullName, $Registry)
    } finally {
        Remove-Item -LiteralPath $scriptFile -Force -ErrorAction SilentlyContinue
    }
    return [pscustomobject]@{
        Ready = ($result.ExitCode -eq 0)
        Message = $result.Output
    }
}

function Test-WebView2Runtime {
    $keys = @()
    foreach ($clientId in $script:WebView2ClientIds) {
        $keys += @(
            "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$clientId",
            "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$clientId",
            "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$clientId"
        )
    }
    foreach ($key in $keys) {
        if (Test-Path $key) {
            $props = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
            $version = Get-ObjectValue $props "pv"
            # Microsoft's documented detection: pv must exist and not be
            # 0.0.0.0 (a broken/partial uninstall leaves pv = 0.0.0.0).
            if (-not [string]::IsNullOrWhiteSpace($version) -and $version -ne "0.0.0.0") {
                return [pscustomobject]@{ Found = $true; Version = $version; Path = $key }
            }
        }
    }
    return [pscustomobject]@{ Found = $false; Version = $null; Path = $null }
}

function Initialize-FnmEnvironment {
    $fnm = Get-CommandSource "fnm.exe"
    if ([string]::IsNullOrWhiteSpace($fnm)) {
        $fnm = Get-CommandSource "fnm"
    }
    if ([string]::IsNullOrWhiteSpace($fnm)) {
        return $false
    }

    $stdout = New-DistillTemporaryFile
    $stderr = New-DistillTemporaryFile
    try {
        $process = Start-Process $fnm -ArgumentList "env --shell powershell" -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdout.FullName -RedirectStandardError $stderr.FullName
        if ($process.ExitCode -ne 0) {
            return $false
        }
        $envScript = Get-Content $stdout.FullName -Raw -ErrorAction Stop
    } finally {
        Remove-Item -LiteralPath $stdout.FullName, $stderr.FullName -Force -ErrorAction SilentlyContinue
    }
    if ([string]::IsNullOrWhiteSpace($envScript)) {
        return $false
    }
    $envScript | Invoke-Expression
    return $true
}

function Ensure-FnmNode {
    $fnm = Get-CommandSource "fnm"
    if ([string]::IsNullOrWhiteSpace($fnm)) {
        throw "fnm is not installed. Run 'just bootstrap-windows install'."
    }
    Initialize-FnmEnvironment | Out-Null
    Invoke-CheckedCommand -FilePath $fnm -ArgumentList @("install", (Get-RequiredNodeVersion)) -Label "fnm install Node $(Get-RequiredNodeVersion)"
    Invoke-CheckedCommand -FilePath $fnm -ArgumentList @("use", (Get-RequiredNodeVersion)) -Label "fnm use Node $(Get-RequiredNodeVersion)"
    Initialize-FnmEnvironment | Out-Null
}

function Initialize-PublicNpmEnvironment {
    # Distill uses public npm. Leftover Berd/Block Artifactory settings from
    # the user or process environment would send pnpm/corepack at a VPN-only
    # host; rewrite those to registry.npmjs.org and drop Block CA overrides.
    $public = $script:PublicNpmRegistry
    $clearedBlockRegistry = $false
    foreach ($name in @("NPM_CONFIG_REGISTRY", "COREPACK_NPM_REGISTRY")) {
        $processValue = [System.Environment]::GetEnvironmentVariable($name, "Process")
        $effective = $processValue
        if ([string]::IsNullOrWhiteSpace($effective)) {
            $effective = [System.Environment]::GetEnvironmentVariable($name, "User")
        }
        if (Test-IsBlockNpmValue $effective) {
            $clearedBlockRegistry = $true
            if ($name -eq "NPM_CONFIG_REGISTRY") {
                [System.Environment]::SetEnvironmentVariable($name, $public, "Process")
            } else {
                [System.Environment]::SetEnvironmentVariable($name, $null, "Process")
            }
        }
    }
    foreach ($name in @("NPM_CONFIG_CAFILE", "NODE_EXTRA_CA_CERTS")) {
        $processValue = [System.Environment]::GetEnvironmentVariable($name, "Process")
        if (Test-IsBlockNpmValue $processValue) {
            [System.Environment]::SetEnvironmentVariable($name, $null, "Process")
        }
    }
    $integrity = [System.Environment]::GetEnvironmentVariable("COREPACK_INTEGRITY_KEYS", "Process")
    if ($clearedBlockRegistry -and $integrity -eq "0") {
        [System.Environment]::SetEnvironmentVariable("COREPACK_INTEGRITY_KEYS", $null, "Process")
    }
}

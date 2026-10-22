$ErrorActionPreference = "Stop"
$global:LASTEXITCODE = 0
Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking

$script:Failures = 0

function Assert-Equal {
    param([string]$Name, [object]$Actual, [object]$Expected)
    if ($Actual -ne $Expected) {
        $script:Failures += 1
        Write-Host "FAIL $Name - expected '$Expected', got '$Actual'" -ForegroundColor Red
    } else {
        Write-Host "PASS $Name" -ForegroundColor Green
    }
}

function Assert-Throws {
    param([string]$Name, [scriptblock]$Action)
    try {
        & $Action | Out-Null
        $script:Failures += 1
        Write-Host "FAIL $Name - expected an exception, none was thrown" -ForegroundColor Red
    } catch {
        Write-Host "PASS $Name" -ForegroundColor Green
    }
}

function Assert-NoThrow {
    param([string]$Name, [scriptblock]$Action)
    try {
        & $Action | Out-Null
        Write-Host "PASS $Name" -ForegroundColor Green
    } catch {
        $script:Failures += 1
        Write-Host "FAIL $Name - unexpected exception: $($_.Exception.Message)" -ForegroundColor Red
    }
}

$oldFlockDevRoot = $env:FLOCK_DEV_ROOT
# The user-level pre-rename spellings may be set on a developer machine; the
# fallback tests below set and clear them, so restore whatever was there.
$oldLegacyDevRoot = $env:DISTILL_DEV_ROOT
$oldLegacyTargetDir = $env:DISTILL_TAURI_CARGO_TARGET_DIR
$oldFlockTargetDir = $env:FLOCK_TAURI_CARGO_TARGET_DIR
$oldLocalAppData = $env:LOCALAPPDATA
$oldUserProfile = $env:USERPROFILE
$oldAppData = $env:APPDATA
$oldFnmDir = $env:FNM_DIR

try {
    $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("flock-windowsdev-test-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $temp | Out-Null
    $env:FLOCK_DEV_ROOT = Join-Path $temp "root"

    Assert-Equal "temporary file helper uses the framework temp-file primitive" `
        ((Get-Command New-FlockTemporaryFile -CommandType Function).Definition -match 'GetTempFileName') $true
    Assert-Equal "checksum helper uses framework cryptography instead of PowerShell.Utility" `
        (((Get-Command Get-FileSha256 -CommandType Function).Definition -match 'System.Security.Cryptography.SHA256') -and `
         ((Get-Command Get-FileSha256 -CommandType Function).Definition -notmatch 'Get-FileHash')) $true
    $checksumFixture = Join-Path $temp "sha256-fixture.txt"
    [System.IO.File]::WriteAllText($checksumFixture, "abc", [System.Text.UTF8Encoding]::new($false))
    Assert-Equal "checksum helper returns canonical lowercase SHA-256" `
        (Get-FileSha256 -Path $checksumFixture) `
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    $temporaryFile = New-FlockTemporaryFile
    try {
        Assert-Equal "temporary file helper creates a filesystem file" `
            (Test-Path -LiteralPath $temporaryFile.FullName -PathType Leaf) $true
    } finally {
        Remove-Item -LiteralPath $temporaryFile.FullName -Force -ErrorAction SilentlyContinue
    }

    Assert-Equal "process args: plain arg unquoted" (Join-WindowsProcessArguments -Arguments @("--wait")) "--wait"
    Assert-Equal "process args: spaces quoted" (Join-WindowsProcessArguments -Arguments @("C:\Program Files\x")) '"C:\Program Files\x"'
    Assert-Equal "process args: trailing backslash doubled inside quotes" (Join-WindowsProcessArguments -Arguments @("C:\Program Files\")) '"C:\Program Files\\"'
    Assert-Equal "process args: embedded quote escaped" (Join-WindowsProcessArguments -Arguments @('say "hi"')) '"say \"hi\""'

    # Dev builds include the driver, enabled only with a valid launcher token.
    # The NSIS bundle and desktop shortcut omit it entirely.
    Assert-Equal "dev app feature default includes the loopback test driver" (Get-FlockAppFeatures) "flockctl,app-test-driver"
    Assert-Equal "an explicit base feature set drops the loopback test driver" (Get-FlockAppFeatures -BaseFeatures @("flockctl")) "flockctl"
    $launchFlock = Get-Content -Raw (Join-Path (Get-FlockRepoRoot) "scripts/windows/Launch-Flock.ps1")
    Assert-Equal "desktop launcher builds without the loopback test driver" ($launchFlock -match 'Get-FlockAppFeatures -BaseFeatures @\("flockctl"\)') $true
    # Agents work on Flock from inside the shortcut-launched app; a Rust
    # watcher there relaunches the app under them and kills their turn.
    Assert-Equal "desktop launcher keeps the Rust watcher off unless asked" `
        ($launchFlock -match '(?ms)if \(-not \$Watch\) \{\r?\n\s+\$tauriArguments \+= "--no-watch"\r?\n\s+\}') $true
    # Only an optimized launch lifts the app crates' opt-level, and only in its
    # own process: every other build keeps the fast dev profile.
    Assert-Equal "desktop launcher optimizes the app crates only when asked" `
        ($launchFlock -match '(?ms)if \(\$Optimized\) \{\r?\n\s+\$tauriArguments \+= @\("--runner", \(Join-Path \$repoRoot "scripts\\windows\\cargo-optimized\.cmd"\)\)') $true
    Assert-Equal "an optimized launch leaves the environment its shells inherit alone" `
        ($launchFlock -match 'CARGO_PROFILE_DEV_OPT_LEVEL') $false
    Assert-Equal "an optimized launch refuses the Rust watcher" `
        ($launchFlock -match '(?m)if \(\$Optimized -and \$Watch\) \{') $true
    $optimizedCargo = Get-Content -Raw (Join-Path (Get-FlockRepoRoot) "scripts/windows/cargo-optimized.cmd")
    Assert-Equal "the optimized cargo sets opt-level on its command line" `
        ($optimizedCargo -match '(?m)^cargo --config profile\.dev\.opt-level=2 %\*\r?$') $true

    # ── Artifact names follow the Cargo package (Levocat Flock rename) ──
    # The app crate is `levocat-flock` with lib `levocat_flock_lib`; every
    # script that names a build output derives from those two names, so the
    # Cargo manifest is the single source the assertions read.
    $cargoManifest = Get-Content -Raw (Join-Path (Get-FlockRepoRoot) "src-tauri\Cargo.toml")
    $cargoPackageName = [regex]::Match($cargoManifest, '(?ms)^\[package\]\r?\n.*?^name\s*=\s*"([^"]+)"').Groups[1].Value
    $cargoLibName = [regex]::Match($cargoManifest, '(?ms)^\[lib\]\r?\n.*?^name\s*=\s*"([^"]+)"').Groups[1].Value
    $cargoDefaultRun = [regex]::Match($cargoManifest, '(?m)^default-run\s*=\s*"([^"]+)"').Groups[1].Value
    Assert-Equal "Cargo package is the Levocat Flock app" $cargoPackageName "levocat-flock"
    Assert-Equal "Cargo lib is the Levocat Flock app library" $cargoLibName "levocat_flock_lib"
    Assert-Equal "Cargo default-run is the package binary" $cargoDefaultRun $cargoPackageName
    $appExeName = "$cargoPackageName.exe"
    # Cargo writes the binary's PDB under the crate name with '-' as '_'.
    $appPdbName = ($cargoPackageName -replace '-', '_') + ".pdb"
    $expectedLaunchOutputs = @(
        $appExeName, $appPdbName, "lib$cargoLibName.rlib", "$cargoLibName.dll", "$cargoLibName.dll.lib",
        "$cargoLibName.dll.exp", "$cargoLibName.lib", "$cargoLibName.pdb"
    )
    $launchOutputsMatch = [regex]::Match($launchFlock, '(?ms)\$outputs = @\((.*?)\)\r?\n')
    Assert-Equal "desktop launcher declares the deps cleanup list" $launchOutputsMatch.Success $true
    $launchOutputs = @([regex]::Matches($launchOutputsMatch.Groups[1].Value, '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
    Assert-Equal "desktop launcher deps cleanup list has the eight app artifacts" $launchOutputs.Count $expectedLaunchOutputs.Count
    foreach ($expectedOutput in $expectedLaunchOutputs) {
        Assert-Equal "desktop launcher deps cleanup list names $expectedOutput" ($launchOutputs -ccontains $expectedOutput) $true
    }
    Assert-Equal "desktop launcher filters app processes by the Cargo binary name" `
        ($launchFlock -match ("Win32_Process -Filter `"Name = '" + [regex]::Escape($appExeName) + "'`"")) $true
    Assert-Equal "desktop launcher reports the running app by the Cargo binary name" `
        ($launchFlock -match ("already running from this checkout \(" + [regex]::Escape($appExeName) + " PID")) $true
    Assert-Equal "desktop launcher names no pre-rename binary" ($launchFlock -cmatch '(?i)\bdistill(\.exe|_lib)') $false
    Assert-Equal "desktop launcher installs the Levocat Flock shortcut" ($launchFlock -match '\$script:ShortcutName = "Levocat Flock Dev\.lnk"') $true
    Assert-Equal "desktop launcher titles its console Levocat Flock" ($launchFlock -match 'WindowTitle = "Levocat Flock \(dev\)"') $true
    $pruneScript = Get-Content -Raw (Join-Path (Get-FlockRepoRoot) "scripts\windows\Prune-BuildCache-Windows.ps1")
    Assert-Equal "prune busy guard names cargo, rustc and the app binary" `
        ($pruneScript -match ("Get-Process -Name cargo, rustc, " + [regex]::Escape($cargoPackageName) + " ")) $true
    Assert-Equal "prune also reclaims the pre-rename dev root" ($pruneScript -match 'Get-LegacyFlockDevRoot') $true
    $unitTestRunner = Get-Content -Raw (Join-Path (Get-FlockRepoRoot) "scripts\windows\Invoke-Rust-Unit-Test-Windows.ps1")
    $unitTestRunnerPattern = [regex]::Match($unitTestRunner, "-match '([^']+)'").Groups[1].Value
    Assert-Equal "unit-test runner matches the Cargo lib test executable" ("$cargoLibName-0123abcd.exe" -match $unitTestRunnerPattern) $true
    Assert-Equal "unit-test runner ignores the app binary" ("$appExeName" -match $unitTestRunnerPattern) $false
    Assert-Equal "unit-test runner ignores the pre-rename lib test executable" ("distill_lib-0123abcd.exe" -match $unitTestRunnerPattern) $false

    $justfile = Get-Content -Raw (Join-Path (Get-FlockRepoRoot) "justfile")
    Assert-Equal "justfile selects PowerShell for ordinary Windows recipes" ($justfile -match '(?m)^set windows-shell := \["powershell\.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"\]\r?$') $true
    foreach ($recipe in @("_tauri-cargo-windows", "clean")) {
        $escapedRecipe = [regex]::Escape($recipe)
        Assert-Equal "$recipe selects PowerShell locally" ($justfile -match "(?m)^\[windows\]\r?\n(?:\[positional-arguments\]\r?\n)?\[script\(`"powershell\.exe`"[^\]]*\]\r?\n${escapedRecipe}[^:]*:") $true
    }
    Assert-Equal "Cargo wrapper uses positional argv transport" `
        ($justfile -match '(?m)^\[windows\]\r?\n\[positional-arguments\]\r?\n\[script\("powershell\.exe"[^\]]*\]\r?\n_tauri-cargo-windows[^:]*:') $true
    Assert-Equal "stage-sidecar dispatches through its native wrapper" `
        ($justfile -match '(?m)^\[windows\]\r?\nstage\-sidecar:\r?\n\s+powershell\.exe .* -File scripts/windows/Invoke-Stage-Sidecar-Windows\.ps1\r?$') $true
    $capturedFailure = Invoke-CaptureCommand -FilePath "cmd.exe" -ArgumentList @("/d", "/c", "echo captured-out& echo captured-err 1>&2& exit /b 7")
    Assert-Equal "capture retains a fast command's nonzero exit code" $capturedFailure.ExitCode 7
    Assert-Equal "capture reads stdout" ($capturedFailure.Output -match "captured-out") $true
    Assert-Equal "capture reads stderr" ($capturedFailure.Output -match "captured-err") $true
    $batchFixture = Join-Path $temp "capture command.cmd"
    [System.IO.File]::WriteAllText($batchFixture, "@echo off`r`necho %~1`r`nexit /b 0`r`n")
    $capturedBatch = Invoke-CaptureCommand -FilePath $batchFixture -ArgumentList @("argument with spaces")
    Assert-Equal "capture runs batch files with spaced paths and arguments" $capturedBatch.Output "argument with spaces"
    Assert-Equal "capture retains a fast command's successful exit code" $capturedBatch.ExitCode 0
    $pipeFixture = Join-Path $temp "capture-pipes.ps1"
    [System.IO.File]::WriteAllText($pipeFixture, '[Console]::Out.Write("o" * 131072); [Console]::Error.Write("e" * 131072); exit 9')
    $capturedPipes = Invoke-CaptureCommand -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-File", $pipeFixture)
    Assert-Equal "capture drains both pipes beyond their buffer capacity" $capturedPipes.Output ($("o" * 131072) + [Environment]::NewLine + $("e" * 131072))
    Assert-Equal "capture preserves failure after large output" $capturedPipes.ExitCode 9

    $just = Get-CommandSource "just"
    $dryRunTargets = [ordered]@{
        "bundle" = 'Bundle-Windows\.ps1'
        "bundle-debug" = 'Bundle-Windows\.ps1 -Debug'
        "stage-sidecar" = 'Invoke-Stage-Sidecar-Windows\.ps1'
    }
    foreach ($recipe in $dryRunTargets.Keys) {
        $dryRun = Invoke-CaptureCommand -FilePath $just -ArgumentList @("--dry-run", $recipe) -WorkingDirectory (Get-FlockRepoRoot)
        Assert-Equal "$recipe is visible and dry-runs on Windows" $dryRun.ExitCode 0
        Assert-Equal "$recipe dry-run reaches its Windows implementation" ($dryRun.Output -match $dryRunTargets[$recipe]) $true
    }
    Assert-Equal "justfile declares no Unix-only recipes" ($justfile -notmatch '(?m)^\[unix\]') $true
    Assert-Equal "justfile calls no Unix shell scripts" ($justfile -notmatch '\.sh\b(?<!dev-tool\.sh)') $true
    foreach ($recipe in @("bootstrap-windows", "doctor-windows", "cleanup-windows", "setup-windows", "dev-windows", "tauri-check-windows", "test-windows-dev")) {
        $escapedRecipe = [regex]::Escape($recipe)
        Assert-Equal "$recipe is declared in the justfile" ($justfile -match "(?m)^${escapedRecipe}[^:]*:") $true
    }
    $windowsRecipeCommands = @{
        "bootstrap-windows" = "scripts/windows/Bootstrap-Windows.ps1"
        "doctor-windows" = "scripts/windows/Doctor-Windows.ps1"
        "cleanup-windows" = "scripts/windows/Cleanup-Windows.ps1"
        "setup-windows" = "scripts/windows/Setup-Windows.ps1"
        "dev-windows" = "scripts/windows/Dev-Windows.ps1"
        "tauri-check-windows" = "scripts/windows/Tauri-Check-Windows.ps1"
        "test-windows-dev" = "scripts/windows/Test-WindowsDev.ps1"
    }
    foreach ($recipe in $windowsRecipeCommands.Keys) {
        $recipePattern = [regex]::Escape($recipe)
        $scriptPattern = [regex]::Escape($windowsRecipeCommands[$recipe])
        Assert-Equal "$recipe dispatches through its native PowerShell script" ($justfile -match "(?m)^${recipePattern}[^:]*:\r?\n\s+powershell\.exe .* -File ${scriptPattern}") $true
    }
    Assert-Equal "bundle-windows is declared in the justfile" ($justfile -match '(?m)^bundle-windows[^:]*:') $true
    Assert-Equal "bundle-windows uses positional argv transport" ($justfile -match '(?m)^\[positional-arguments\]\r?\n\[script\("powershell\.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"\)\]\r?\nbundle-windows[^:]*:\r?\n\s+& .*Bundle-Windows\.ps1.*\$args\[0\]') $true
    Assert-Equal "bundle-windows does not interpolate bundle into source" ($justfile -notmatch '(?m)^\s+.*Bundle-Windows\.ps1.*\{\{\s*bundle\s*\}\}') $true

    $setupScript = Get-Content -Raw (Join-Path (Get-FlockRepoRoot) "scripts\windows\Setup-Windows.ps1")
    $devScript = Get-Content -Raw (Join-Path (Get-FlockRepoRoot) "scripts\windows\Dev-Windows.ps1")
    $doctorScript = Get-Content -Raw (Join-Path (Get-FlockRepoRoot) "scripts\windows\Doctor-Windows.ps1")
    $bootstrapScript = Get-Content -Raw (Join-Path (Get-FlockRepoRoot) "scripts\windows\Bootstrap-Windows.ps1")
    Assert-Equal "setup does not require Block VPN" ($setupScript -notmatch 'Block VPN|Block npm registry is not reachable') $true
    Assert-Equal "setup initializes public npm" ($setupScript -match 'Initialize-PublicNpmEnvironment') $true
    Assert-Equal "dev initializes public npm" ($devScript -match 'Initialize-PublicNpmEnvironment') $true
    Assert-Equal "doctor does not require Block npm cert" ($doctorScript -notmatch 'Block npm cert') $true
    Assert-Equal "doctor pings public npm" ($doctorScript -match 'Get-PublicNpmRegistry') $true
    Assert-Equal "bootstrap does not warn for Block npm" ($bootstrapScript -notmatch 'Block npm HTTPS') $true

    $bundleScript = Get-Content -Raw (Join-Path (Get-FlockRepoRoot) "scripts\windows\Bundle-Windows.ps1")
    Assert-Equal "bundle exports full SemVer to Rust" `
        ($bundleScript -match '\$env:FLOCK_APP_VERSION\s*=\s*\$resolvedVersion\.RichVersion') $true
    Assert-Equal "bundle exports full release SemVer to the renderer" `
        ($bundleScript -match '\$env:VITE_APP_VERSION\s*=\s*\$resolvedVersion\.RichVersion') $true
    Assert-Equal "bundle verifies the application PE version" ($bundleScript -match '\.VersionInfo\.ProductVersion') $true
    Assert-Equal "bundle verifies the full-SemVer installer path" `
        ($bundleScript -match '\$\{ProductName\}_\$\{ExpectedVersion\}_x64-setup\.exe') $true
    Assert-Equal "bundle reads tauri.conf.json once for both names" `
        ($bundleScript -match '\$tauriConf = Read-JsonFile \(Join-Path \$repoRoot "src-tauri\\tauri\.conf\.json"\)') $true
    Assert-Equal "bundle takes the installer name from tauri.conf.json productName" `
        ($bundleScript -match '\$productName = Get-ObjectValue \$tauriConf "productName"') $true
    Assert-Equal "bundle takes the executable name from tauri.conf.json mainBinaryName" `
        ($bundleScript -match '\$mainBinaryName = Get-ObjectValue \$tauriConf "mainBinaryName"') $true
    Assert-Equal "bundle derives the executable path from mainBinaryName" `
        ($bundleScript -match 'release\\\$\(Get-WindowsExeName \$MainBinaryName\)') $true
    Assert-Equal "bundle hands mainBinaryName to the verification" `
        ($bundleScript -match '-MainBinaryName \$mainBinaryName') $true
    Assert-Equal "bundle hardcodes no executable name" ($bundleScript -match '(?i)(levocat-flock|distill|flock)\.exe') $false
    $tauriConf = Read-JsonFile (Join-Path (Get-FlockRepoRoot) "src-tauri\tauri.conf.json")
    Assert-Equal "tauri.conf.json productName is Levocat Flock" (Get-ObjectValue $tauriConf "productName") "Levocat Flock"
    Assert-Equal "tauri.conf.json mainBinaryName is the Cargo package" (Get-ObjectValue $tauriConf "mainBinaryName") $cargoPackageName
    Assert-Equal "bundle reports the verified installer path" ($bundleScript -match 'Windows bundle ready: \$bundlePath') $true

    $prereleaseVersion = Resolve-AppVersion "1.2.3-rc.1"
    Assert-Equal "prerelease override uses numeric core for Windows ProductVersion" $prereleaseVersion.Version "1.2.3"
    Assert-Equal "prerelease override preserves full SemVer" $prereleaseVersion.RichVersion "1.2.3-rc.1"

    $buildScript = Get-Content -Raw (Join-Path (Get-FlockRepoRoot) "src-tauri\build.rs")
    Assert-Equal "Rust rebuilds when the resolved app version changes" ($buildScript -match 'cargo:rerun-if-env-changed=FLOCK_APP_VERSION') $true
    Assert-Equal "Rust rebuilds when the Tauri config overlay changes" ($buildScript -match 'cargo:rerun-if-env-changed=TAURI_CONFIG') $true
    Assert-Equal "Rust embeds the resolved diagnostic version" ($buildScript -match 'cargo:rustc-env=FLOCK_BUILD_VERSION') $true

    $injectionMarker = Join-Path $temp "just-injection-proof"
    $maliciousBundle = 'bogus"; New-Item -ItemType File -Force -Path "' + $injectionMarker + '" | Out-Null; #'
    $justCommand = (Get-Command just -ErrorAction SilentlyContinue).Source
    if ([string]::IsNullOrWhiteSpace($justCommand)) {
        $justCommand = Join-Path $env:USERPROFILE ".local\bin\just.exe"
    }
    Assert-Equal "just is available for injection regression" (Test-Path -LiteralPath $justCommand) $true
    $injectionResult = Invoke-CaptureCommand -FilePath $justCommand `
        -ArgumentList @("--justfile", (Join-Path (Get-FlockRepoRoot) "justfile"), "bundle-windows", $maliciousBundle)
    Assert-Equal "bundle-windows rejects the malicious bundle argv" ($injectionResult.ExitCode -ne 0) $true
    Assert-Equal "bundle-windows malicious argv is not executed" (Test-Path $injectionMarker) $false

    Assert-Equal "required pnpm version accepted" (Test-PnpmVersion (Get-RequiredPnpmVersion)) $true
    Assert-Equal "wrong pnpm version rejected" (Test-PnpmVersion "9.0.0") $false
    Assert-Equal "whitespace-trimmed pnpm version accepted" (Test-PnpmVersion "  $(Get-RequiredPnpmVersion)`r`n") $true
    Assert-Equal "missing pnpm version rejected" (Test-PnpmVersion $null) $false

    $missingPnpm = Get-PnpmReadiness -Source ""
    Assert-Equal "missing pnpm is unavailable" $missingPnpm.Available $false
    Assert-Equal "missing pnpm is not ready" $missingPnpm.Ready $false

    $port = Get-StableVitePort
    Assert-Equal "vite port within range" ($port -ge 10000 -and $port -lt 65000) $true
    Assert-Equal "vite port is stable per directory" $port (Get-StableVitePort)

    $e2eRoot = Join-Path $temp "run-123"
    $e2e = New-E2eRunContract -RunRoot $e2eRoot
    Assert-Equal "E2E run ID derives from root" $e2e.RunId "run-123"
    Assert-Equal "E2E identifier derives from run ID" $e2e.Identifier "com.levocat.flock.e2e.run-123"
    Assert-Equal "E2E config stays under run root" $e2e.ConfigPath (Join-Path $e2eRoot "tauri-dev-windows.config.json")
    Assert-Equal "E2E driver readiness stays under run root" $e2e.DriverReadyPath (Join-Path $e2eRoot "app-test-driver.json")
    Assert-Equal "E2E generated driver token is strong ASCII" ($e2e.DriverToken -cmatch '^[a-z0-9]{64}$') $true
    Assert-Equal "E2E generated driver tokens are per-run" ((New-E2eRunContract -RunRoot $e2eRoot).DriverToken -ne $e2e.DriverToken) $true
    $explicitToken = "0123456789abcdef0123456789abcdef"
    Assert-Equal "E2E explicit driver token is preserved" (New-E2eRunContract -RunRoot $e2eRoot -DriverToken $explicitToken).DriverToken $explicitToken
    Assert-Throws "E2E relative run root rejected" { New-E2eRunContract -RunRoot "relative\run-123" }
    Assert-Throws "E2E underscore run ID rejected" { New-E2eRunContract -RunRoot (Join-Path $temp "run_123") }
    Assert-Throws "E2E malformed run ID rejected" { New-E2eRunContract -RunRoot (Join-Path $temp "bad.id") }
    Assert-Throws "E2E mismatched run ID rejected" { New-E2eRunContract -RunRoot $e2eRoot -RunId "other" }
    Assert-Throws "E2E weak driver token rejected" { New-E2eRunContract -RunRoot $e2eRoot -DriverToken "weak" }

    # E2E disables Tauri's Rust watcher so generated permission/schema writes
    # cannot restart an in-flight native compile, and FLOCK_DEV_NO_WATCH=1
    # does the same for an agent editing src-tauri from inside the dev app.
    # Interactive dev otherwise retains hot reload: --no-watch must remain
    # inside the branch those two — and nothing else — open.
    $devWindowsSource = Get-Content -Raw (Join-Path (Get-FlockRepoRoot) "scripts/windows/Dev-Windows.ps1")
    $noWatchOptIn = '$NoWatch = $E2eMode -or ($env:FLOCK_DEV_NO_WATCH -eq "1")'
    Assert-Equal "only E2E and the explicit opt-in disable the watcher" `
        $devWindowsSource.Contains($noWatchOptIn) $true
    $e2eNoWatchPattern = '(?ms)if \(\$NoWatch\) \{(?:(?!\r?\n\}).)*?\$tauriArguments \+= "--no-watch"\r?\n\}'
    Assert-Equal "E2E Tauri launch disables the watcher" `
        ($devWindowsSource -match $e2eNoWatchPattern) $true
    Assert-Equal "ordinary Tauri dev launch retains the watcher" `
        ([regex]::Matches($devWindowsSource, '"--no-watch"').Count) 1

    $gitAttributes = Get-Content -Raw (Join-Path (Get-FlockRepoRoot) ".gitattributes")
    Assert-Equal "Windows Tauri config is pinned to LF" `
        (($gitAttributes -split '\r?\n') -contains "src-tauri/tauri.windows.conf.json text eol=lf") $true
    Assert-Equal "SQL migrations are pinned to LF for stable sqlx checksums" `
        (($gitAttributes -split '\r?\n') -contains "src-tauri/migrations_agent_host/*.sql text eol=lf") $true
    $migrationFiles = @(Get-ChildItem -Path (Join-Path (Get-FlockRepoRoot) "src-tauri/migrations_agent_host") -Filter "*.sql" -File -ErrorAction SilentlyContinue)
    Assert-Equal "SQL migration contract covers at least one migration" ($migrationFiles.Count -gt 0) $true
    foreach ($migrationFile in $migrationFiles) {
        $migrationBytes = [System.IO.File]::ReadAllBytes($migrationFile.FullName)
        Assert-Equal "$($migrationFile.Name) contains no CR bytes" ($migrationBytes -notcontains 13) $true
    }

    # ── Windows sidecar staging (Get-WindowsSidecarName / Get-WindowsTripleMachine /
    #    Get-PeFileInfo / Assert-WindowsSidecarBinary / Remove-StaleWindowsSidecars /
    #    Stage-WindowsSidecar) ──────────────────────────────────────────────────
    # These guard the native Windows externalBin staging that replaces the Unix
    # chmod/-x contract. A minimal PE image is synthesized in memory so the
    # validation runs deterministically on any host without a real toolchain.

    Assert-Equal "sidecar name appends triple and exe" `
        (Get-WindowsSidecarName -Stem "flock-monitor" -Triple "x86_64-pc-windows-msvc") `
        "flock-monitor-x86_64-pc-windows-msvc.exe"
    Assert-Equal "x86_64 triple maps to amd64 machine" `
        (Get-WindowsTripleMachine -Triple "x86_64-pc-windows-msvc") 0x8664
    Assert-Equal "aarch64 triple maps to arm64 machine" `
        (Get-WindowsTripleMachine -Triple "aarch64-pc-windows-msvc") 0xAA64
    Assert-Equal "gnu triple is still supported" `
        (Get-WindowsTripleMachine -Triple "x86_64-pc-windows-gnu") 0x8664
    Assert-Equal "non-windows triple is unsupported" `
        (Get-WindowsTripleMachine -Triple "aarch64-apple-darwin") $null

    # Write a minimal but well-formed PE image for a given COFF machine value:
    # DOS header (MZ + e_lfanew at 0x3C), PE signature, a COFF header whose
    # Machine/NumberOfSections/SizeOfOptionalHeader/Characteristics we control,
    # a PE32+ optional header, and one section-table entry. Switches let tests
    # synthesize the truncated/malformed shapes the validator must reject.
    function New-FakePeFile {
        param(
            [Parameter(Mandatory = $true)][string]$Path,
            [Parameter(Mandatory = $true)][int]$Machine,
            [bool]$ExecutableImage = $true,
            # Drop everything after the COFF header (no optional header/sections).
            [switch]$TruncateAfterCoff,
            # Emit an optional-header magic that is neither PE32 nor PE32+.
            [switch]$BadOptionalMagic,
            # Override SizeOfOptionalHeader / NumberOfSections to synthesize
            # structurally-invalid-but-magic-bearing shapes (e.g. an optional
            # header that stops right after the magic, or zero sections). When
            # null, well-formed defaults (0xF0 header + 1 section) are used.
            [Nullable[int]]$OptionalHeaderSize = $null,
            [Nullable[int]]$SectionCount = $null
        )
        $peOffset = 0x40
        $optionalHeaderSize = if ($null -ne $OptionalHeaderSize) { $OptionalHeaderSize } else { 0xF0 }  # typical PE32+ optional header size
        $sectionCount = if ($null -ne $SectionCount) { $SectionCount } else { 1 }
        if ($TruncateAfterCoff) {
            $total = $peOffset + 24
        } else {
            $total = $peOffset + 24 + $optionalHeaderSize + ($sectionCount * 40)
        }
        $bytes = New-Object byte[] $total
        $bytes[0] = 0x4D  # 'M'
        $bytes[1] = 0x5A  # 'Z'
        [System.BitConverter]::GetBytes([int]$peOffset).CopyTo($bytes, 0x3C)
        $bytes[$peOffset] = 0x50      # 'P'
        $bytes[$peOffset + 1] = 0x45  # 'E'
        $bytes[$peOffset + 2] = 0x00
        $bytes[$peOffset + 3] = 0x00
        $coff = $peOffset + 4
        [System.BitConverter]::GetBytes([uint16]$Machine).CopyTo($bytes, $coff)
        $characteristics = if ($ExecutableImage) { [uint16]0x0002 } else { [uint16]0x0000 }
        if (-not $TruncateAfterCoff) {
            [System.BitConverter]::GetBytes([uint16]$sectionCount).CopyTo($bytes, $coff + 2)
            [System.BitConverter]::GetBytes([uint16]$optionalHeaderSize).CopyTo($bytes, $coff + 16)
        }
        [System.BitConverter]::GetBytes($characteristics).CopyTo($bytes, $coff + 18)
        if (-not $TruncateAfterCoff -and $optionalHeaderSize -ge 2) {
            $magic = if ($BadOptionalMagic) { [uint16]0xDEAD } else { [uint16]0x20B }  # PE32+
            [System.BitConverter]::GetBytes($magic).CopyTo($bytes, $coff + 20)
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
        [System.IO.File]::WriteAllBytes($Path, $bytes)
    }

    $amd64 = 0x8664
    $arm64 = 0xAA64

    # Paths with spaces exercise the same quoting hazards the real bundle dir
    # (e.g. under "C:\Users\First Last\...") would hit.
    $stageRoot = Join-Path $temp "stage root with spaces"
    $srcDir = Join-Path $stageRoot "src"
    $binDir = Join-Path $stageRoot "binaries"

    $goodPe = Join-Path $srcDir "flock-monitor.exe"
    New-FakePeFile -Path $goodPe -Machine $amd64
    $peInfo = Get-PeFileInfo -Path $goodPe
    Assert-Equal "PE info detects amd64 image" $peInfo.IsPe $true
    Assert-Equal "PE info reads machine" $peInfo.Machine $amd64
    Assert-Equal "PE info reads executable bit" $peInfo.IsExecutableImage $true

    # A POSIX shell script is not a PE.
    $shellStub = Join-Path $srcDir "flock-monitor-shell-stub"
    Set-Content -Path $shellStub -Value "#!/usr/bin/env sh`necho no`n" -Encoding ASCII
    Assert-Equal "shell script is not a PE" (Get-PeFileInfo -Path $shellStub).IsPe $false
    Assert-Throws "staging rejects a shell-script fake binary" {
        Stage-WindowsSidecar -SourcePath $shellStub -Triple "x86_64-pc-windows-msvc" -Stem "flock-monitor" -BinDir $binDir
    }

    # Truncated image: MZ + PE signature + COFF header but nothing after it (no
    # optional header/section table). Windows cannot load it, so validation must
    # reject it instead of blessing a corrupt/partial artifact.
    $truncated = Join-Path $srcDir "flock-monitor-truncated.exe"
    New-FakePeFile -Path $truncated -Machine $amd64 -TruncateAfterCoff
    Assert-Equal "truncated PE (no optional header) is not a valid PE" (Get-PeFileInfo -Path $truncated).IsPe $false
    Assert-Throws "staging rejects a truncated PE" {
        Stage-WindowsSidecar -SourcePath $truncated -Triple "x86_64-pc-windows-msvc" -Stem "flock-monitor" -BinDir $binDir
    }

    # Malformed optional-header magic (neither PE32 0x10B nor PE32+ 0x20B).
    $badMagic = Join-Path $srcDir "flock-monitor-badmagic.exe"
    New-FakePeFile -Path $badMagic -Machine $amd64 -BadOptionalMagic
    Assert-Equal "PE with bad optional-header magic is not valid" (Get-PeFileInfo -Path $badMagic).IsPe $false
    Assert-Throws "staging rejects a bad optional-header magic" {
        Stage-WindowsSidecar -SourcePath $badMagic -Triple "x86_64-pc-windows-msvc" -Stem "flock-monitor" -BinDir $binDir
    }

    # Minimal non-image: MZ + PE + COFF + a 2-byte optional header that carries a
    # valid PE32+ magic but nothing else, and zero sections. This is the reachable
    # ~90-byte defect where the truncation simply moved past the magic. A 2-byte
    # optional header is far below the PE32+ minimum (112 bytes) and the file has
    # no section table, so validation must reject it.
    $magicOnly = Join-Path $srcDir "flock-monitor-magiconly.exe"
    New-FakePeFile -Path $magicOnly -Machine $amd64 -OptionalHeaderSize 2 -SectionCount 0
    Assert-Equal "PE with magic but sub-minimum optional header is not valid" (Get-PeFileInfo -Path $magicOnly).IsPe $false
    Assert-Throws "staging rejects a magic-only sub-minimum PE" {
        Stage-WindowsSidecar -SourcePath $magicOnly -Triple "x86_64-pc-windows-msvc" -Stem "flock-monitor" -BinDir $binDir
    }

    # A full-size optional header but zero sections is still not a loadable image.
    $noSections = Join-Path $srcDir "flock-monitor-nosections.exe"
    New-FakePeFile -Path $noSections -Machine $amd64 -SectionCount 0
    Assert-Equal "PE with zero sections is not valid" (Get-PeFileInfo -Path $noSections).IsPe $false
    Assert-Throws "staging rejects a zero-section PE" {
        Stage-WindowsSidecar -SourcePath $noSections -Triple "x86_64-pc-windows-msvc" -Stem "flock-monitor" -BinDir $binDir
    }

    # A PE32+ optional header just under the 112-byte minimum must also be rejected.
    $shortOptional = Join-Path $srcDir "flock-monitor-shortoptional.exe"
    New-FakePeFile -Path $shortOptional -Machine $amd64 -OptionalHeaderSize 111
    Assert-Equal "PE32+ with sub-minimum optional header is not valid" (Get-PeFileInfo -Path $shortOptional).IsPe $false

    Assert-Throws "staging rejects a missing source" {
        Stage-WindowsSidecar -SourcePath (Join-Path $srcDir "does-not-exist.exe") -Triple "x86_64-pc-windows-msvc" -Stem "flock-monitor" -BinDir $binDir
    }

    # Wrong architecture: an arm64 PE staged for an x86_64 target must fail.
    $wrongArch = Join-Path $srcDir "flock-monitor-arm64.exe"
    New-FakePeFile -Path $wrongArch -Machine $arm64
    Assert-Throws "staging rejects a wrong-architecture PE" {
        Stage-WindowsSidecar -SourcePath $wrongArch -Triple "x86_64-pc-windows-msvc" -Stem "flock-monitor" -BinDir $binDir
    }

    # A PE without the executable-image characteristic is rejected.
    $notExec = Join-Path $srcDir "flock-monitor-noexec.exe"
    New-FakePeFile -Path $notExec -Machine $amd64 -ExecutableImage $false
    Assert-Throws "staging rejects a non-executable PE image" {
        Stage-WindowsSidecar -SourcePath $notExec -Triple "x86_64-pc-windows-msvc" -Stem "flock-monitor" -BinDir $binDir
    }

    # Happy path: valid amd64 PE stages to the exact Tauri name under a spaced dir.
    $stagedPath = Stage-WindowsSidecar -SourcePath $goodPe -Triple "x86_64-pc-windows-msvc" -Stem "flock-monitor" -BinDir $binDir
    $expectedStaged = Join-Path $binDir "flock-monitor-x86_64-pc-windows-msvc.exe"
    Assert-Equal "staging writes the exact Tauri sidecar name" $stagedPath $expectedStaged
    Assert-Equal "staged sidecar exists" (Test-Path $expectedStaged -PathType Leaf) $true
    Assert-Equal "staged sidecar matches source checksum" (Get-FileSha256 -Path $expectedStaged) (Get-FileSha256 -Path $goodPe)

    # Stale cleanup: a leftover extensionless Unix-staged file and an old-triple
    # file must be removed when the current triple is staged.
    Set-Content -Path (Join-Path $binDir "flock-monitor") -Value "old-unix" -Encoding ASCII
    New-FakePeFile -Path (Join-Path $binDir "flock-monitor-aarch64-pc-windows-msvc.exe") -Machine $arm64
    Stage-WindowsSidecar -SourcePath $goodPe -Triple "x86_64-pc-windows-msvc" -Stem "flock-monitor" -BinDir $binDir | Out-Null
    Assert-Equal "stale extensionless sidecar removed" (Test-Path (Join-Path $binDir "flock-monitor") -PathType Leaf) $false
    Assert-Equal "stale old-triple sidecar removed" (Test-Path (Join-Path $binDir "flock-monitor-aarch64-pc-windows-msvc.exe") -PathType Leaf) $false
    Assert-Equal "current sidecar retained after cleanup" (Test-Path $expectedStaged -PathType Leaf) $true

    # Cleanup must only touch the requested stem, never a sibling sidecar.
    $flockctlSrc = Join-Path $srcDir "flockctl.exe"
    New-FakePeFile -Path $flockctlSrc -Machine $amd64
    Stage-WindowsSidecar -SourcePath $flockctlSrc -Triple "x86_64-pc-windows-msvc" -Stem "flockctl" -BinDir $binDir | Out-Null
    Stage-WindowsSidecar -SourcePath $goodPe -Triple "x86_64-pc-windows-msvc" -Stem "flock-monitor" -BinDir $binDir | Out-Null
    Assert-Equal "sibling stem sidecar untouched by cleanup" (Test-Path (Join-Path $binDir "flockctl-x86_64-pc-windows-msvc.exe") -PathType Leaf) $true

    # ── Windows externalBin contract (tauri.windows.conf.json) ──
    $windowsConf = Read-JsonFile (Join-Path (Get-FlockRepoRoot) "src-tauri/tauri.windows.conf.json")
    $windowsExternalBin = @(Get-ObjectValue (Get-ObjectValue $windowsConf "bundle") "externalBin")
    Assert-Equal "Windows externalBin stages flockctl" ($windowsExternalBin -contains "binaries/flockctl") $true
    Assert-Equal "Windows externalBin stages flock-monitor" ($windowsExternalBin -contains "binaries/flock-monitor") $true

    # Tauri merges platform overlays into the base config with json_patch (RFC
    # 7386), which REPLACES arrays wholesale rather than concatenating. Model
    # that merge so the effective Windows externalBin contract is checked, not
    # just the overlay: exactly the two native sidecars, nothing else.
    $baseConf = Read-JsonFile (Join-Path (Get-FlockRepoRoot) "src-tauri/tauri.conf.json")
    $baseExternalBin = @(Get-ObjectValue (Get-ObjectValue $baseConf "bundle") "externalBin")
    # RFC 7386 merge: a present member on the overlay replaces the base member.
    $mergedExternalBin = if ($null -ne $windowsExternalBin) { $windowsExternalBin } else { $baseExternalBin }
    Assert-Equal "merged Windows externalBin stages flockctl" ($mergedExternalBin -contains "binaries/flockctl") $true
    Assert-Equal "merged Windows externalBin stages flock-monitor" ($mergedExternalBin -contains "binaries/flock-monitor") $true
    Assert-Equal "merged Windows externalBin stages only the native sidecars" (@($mergedExternalBin).Count) 2

    # ── Bundle recipes are Windows-only and route through native staging ──
    # Bundling exists only on Windows: `just bundle` / `bundle-debug` drive
    # Bundle-Windows.ps1 (native PE-validated staging + NSIS) directly.
    Assert-Equal "bundle is Windows-only and runs Bundle-Windows.ps1" ($justfile -match '(?m)^\[windows\]\r?\nbundle:\r?\n\s+powershell\.exe.*Bundle-Windows\.ps1\r?$') $true
    Assert-Equal "bundle-debug is Windows-only and runs Bundle-Windows.ps1 -Debug" ($justfile -match '(?m)^\[windows\]\r?\nbundle-debug:\r?\n\s+powershell\.exe.*Bundle-Windows\.ps1 -Debug\r?$') $true

    # ── Bundle and stage-sidecar call sites invoke native child processes ──
    # A successful in-process `& script.ps1` leaves $LASTEXITCODE unset, so the
    # old stale guard false-failed before the next step. Pin both public call
    # paths to Invoke-WindowsChildScript and reject stale LASTEXITCODE guards.
    $bundleScript = Get-Content -Raw (Join-Path (Get-FlockRepoRoot) "scripts/windows/Bundle-Windows.ps1")
    Assert-Equal "bundle runs staging via native child process" `
        ($bundleScript -match "Invoke-WindowsChildScript[^\r\n]*Stage-Sidecar-Windows\.ps1") $true
    Assert-Equal "bundle has no stale LASTEXITCODE guard" `
        ($bundleScript -match '\$LASTEXITCODE -ne 0') $false

    $stageWrapperPath = Join-Path (Get-FlockRepoRoot) "scripts/windows/Invoke-Stage-Sidecar-Windows.ps1"
    $stageWrapper = Get-Content -Raw $stageWrapperPath
    Assert-Equal "stage-sidecar wrapper runs staging via native child process" `
        ($stageWrapper -match "Invoke-WindowsChildScript[^\r\n]*StageScriptPath") $true
    Assert-Equal "stage-sidecar wrapper has no stale LASTEXITCODE guard" `
        ($stageWrapper -match '\$LASTEXITCODE -ne 0') $false

    # Invoke-WindowsChildScript reaches past a successful child and throws on a
    # failing one, using the current PowerShell host to run each child natively.
    $childDir = Join-Path $temp "child-scripts"
    New-Item -ItemType Directory -Force -Path $childDir | Out-Null
    $reachedMarker = Join-Path $childDir "reached.txt"
    $okChild = Join-Path $childDir "ok-child.ps1"
    Set-Content -Path $okChild -Value 'Write-Host "child ran"' -Encoding UTF8
    $failChild = Join-Path $childDir "fail-child.ps1"
    Set-Content -Path $failChild -Value 'exit 7' -Encoding UTF8
    Assert-NoThrow "child script driver reaches bundle step after a successful helper" {
        Invoke-WindowsChildScript -ScriptPath $okChild -Label "ok-child"
        Set-Content -Path $reachedMarker -Value "reached" -Encoding ASCII
    }
    Assert-Equal "driver executed the step after the successful child" (Test-Path $reachedMarker -PathType Leaf) $true
    Assert-Throws "child script driver throws on a failing helper" {
        Invoke-WindowsChildScript -ScriptPath $failChild -Label "fail-child"
    }
    Assert-NoThrow "stage-sidecar call site propagates successful staging child" {
        Invoke-WindowsChildScript -ScriptPath $stageWrapperPath `
            -ArgumentList @("-StageScriptPath", $okChild) -Label "stage-wrapper-success"
    }
    Assert-Throws "stage-sidecar call site propagates failing staging child" {
        Invoke-WindowsChildScript -ScriptPath $stageWrapperPath `
            -ArgumentList @("-StageScriptPath", $failChild) -Label "stage-wrapper-failure"
    }

    # ── Child driver passes -ExecutionPolicy Bypass for powershell.exe ──
    # Restricted/AllSigned machine policy would otherwise block the child even
    # though the parent lane started under Bypass. pwsh ignores per-invocation
    # policy, so the flag is conditioned on the powershell.exe host name.
    $moduleSource = Get-Content -Raw (Join-Path (Get-FlockRepoRoot) "scripts/windows/WindowsDev.psm1")
    Assert-Equal "child driver conditions ExecutionPolicy Bypass on powershell.exe host" `
        ($moduleSource -match "(?s)GetFileNameWithoutExtension\(\`$shell\)\s*-ieq\s*`"powershell`".*?-ExecutionPolicy`",\s*`"Bypass`"") $true

    # ── Cleanup containment rules (Assert-SafeCleanupPath / Normalize-FullPath) ──
    # These guard Remove-Item -Recurse in Cleanup-Windows.ps1; run them against
    # the real environment before the redirection block below.
    $insideRoot = Join-Path $temp "allowed"
    Assert-NoThrow "safe path: exact allowed root" { Assert-SafeCleanupPath -Path $insideRoot -AllowedRoot $insideRoot }
    Assert-NoThrow "safe path: child of allowed root" { Assert-SafeCleanupPath -Path (Join-Path $insideRoot "sub\dir") -AllowedRoot $insideRoot }
    Assert-Throws "unsafe path: outside allowed root" { Assert-SafeCleanupPath -Path (Join-Path $temp "elsewhere") -AllowedRoot $insideRoot }
    Assert-Throws "unsafe path: parent traversal escapes root" { Assert-SafeCleanupPath -Path (Join-Path $insideRoot "..\escape") -AllowedRoot $insideRoot }
    Assert-Throws "unsafe path: prefix sibling does not match root" { Assert-SafeCleanupPath -Path ($insideRoot + "-sibling") -AllowedRoot $insideRoot }
    Assert-Throws "unsafe path: relative path rejected" { Assert-SafeCleanupPath -Path "relative\dir" -AllowedRoot $insideRoot }
    Assert-Throws "unsafe path: user profile protected even as its own root" {
        Assert-SafeCleanupPath -Path (Get-UserProfileRoot) -AllowedRoot (Get-UserProfileRoot)
    }
    Assert-Throws "unsafe path: repo root protected even as its own root" {
        Assert-SafeCleanupPath -Path (Get-FlockRepoRoot) -AllowedRoot (Get-FlockRepoRoot)
    }
    Assert-Throws "unsafe path: drive root rejected" {
        Assert-SafeCleanupPath -Path ([System.IO.Path]::GetPathRoot($temp)) -AllowedRoot ([System.IO.Path]::GetPathRoot($temp))
    }
    Assert-Equal "normalize strips trailing separators" (Normalize-FullPath ($insideRoot + [System.IO.Path]::DirectorySeparatorChar)) $insideRoot

    $env:LOCALAPPDATA = Join-Path $temp "Local"
    $env:USERPROFILE = Join-Path $temp "User"
    $env:APPDATA = Join-Path $temp "Roaming"
    $env:FNM_DIR = ""

    # Cleanup honors the same env overrides setup/dev use.
    $env:DISTILL_DEV_ROOT = ""
    $env:DISTILL_TAURI_CARGO_TARGET_DIR = ""
    $env:FLOCK_TAURI_CARGO_TARGET_DIR = Join-Path $temp "override-target"
    $overriddenPaths = Resolve-WindowsCleanupPaths
    Assert-Equal "cleanup honors FLOCK_DEV_ROOT override" $overriddenPaths.FlockDevRoot $env:FLOCK_DEV_ROOT
    Assert-Equal "cleanup honors FLOCK_TAURI_CARGO_TARGET_DIR override" $overriddenPaths.FlockTauriRoot $env:FLOCK_TAURI_CARGO_TARGET_DIR
    Assert-Equal "Get-TauriCargoTargetDir honors FLOCK_TAURI_CARGO_TARGET_DIR" (Get-TauriCargoTargetDir) $env:FLOCK_TAURI_CARGO_TARGET_DIR

    # ── Pre-rename environment spellings (Distill -> Levocat Flock) ──
    # A developer machine keeps user-level DISTILL_* variables after the
    # scripts were renamed; the FLOCK_* spelling wins, the DISTILL_* one is
    # the fallback. Each pair below is a compatibility literal: renaming the
    # DISTILL_* side makes the "new spelling wins" case set the same variable
    # twice and fail.
    Assert-Equal "legacy name of FLOCK_DEV_ROOT" (Get-FlockLegacyEnvironmentName -Name "FLOCK_DEV_ROOT") "DISTILL_DEV_ROOT"
    Assert-Equal "legacy name of FLOCK_TAURI_CARGO_TARGET_DIR" (Get-FlockLegacyEnvironmentName -Name "FLOCK_TAURI_CARGO_TARGET_DIR") "DISTILL_TAURI_CARGO_TARGET_DIR"
    Assert-Equal "legacy name of FLOCK_DISTRO_DIR" (Get-FlockLegacyEnvironmentName -Name "FLOCK_DISTRO_DIR") "DISTILL_DISTRO_DIR"
    Assert-Equal "legacy name of FLOCK_APP_VERSION_OVERRIDE" (Get-FlockLegacyEnvironmentName -Name "FLOCK_APP_VERSION_OVERRIDE") "DISTILL_APP_VERSION_OVERRIDE"
    Assert-Equal "legacy name of FLOCKCTL_BIN" (Get-FlockLegacyEnvironmentName -Name "FLOCKCTL_BIN") "DISTILLCTL_BIN"
    Assert-Equal "legacy name of FLOCK_MONITOR_BIN" (Get-FlockLegacyEnvironmentName -Name "FLOCK_MONITOR_BIN") "DISTILL_MONITOR_BIN"
    Assert-Equal "legacy names differ from the new spelling" ((Get-FlockLegacyEnvironmentName -Name "FLOCK_DEV_ROOT") -ne "FLOCK_DEV_ROOT") $true
    Assert-Throws "legacy name is defined only for FLOCK_* variables" { Get-FlockLegacyEnvironmentName -Name "CARGO_TARGET_DIR" }

    $env:FLOCK_TAURI_CARGO_TARGET_DIR = ""
    $env:DISTILL_TAURI_CARGO_TARGET_DIR = Join-Path $temp "legacy-target"
    Assert-Equal "Get-TauriCargoTargetDir falls back to DISTILL_TAURI_CARGO_TARGET_DIR" (Get-TauriCargoTargetDir) $env:DISTILL_TAURI_CARGO_TARGET_DIR
    Assert-Equal "cleanup falls back to DISTILL_TAURI_CARGO_TARGET_DIR" (Resolve-WindowsCleanupPaths).FlockTauriRoot $env:DISTILL_TAURI_CARGO_TARGET_DIR
    $env:FLOCK_TAURI_CARGO_TARGET_DIR = Join-Path $temp "new-target"
    Assert-Equal "FLOCK_TAURI_CARGO_TARGET_DIR wins over DISTILL_TAURI_CARGO_TARGET_DIR" (Get-TauriCargoTargetDir) (Join-Path $temp "new-target")
    $env:FLOCK_TAURI_CARGO_TARGET_DIR = ""
    $env:DISTILL_TAURI_CARGO_TARGET_DIR = ""

    $env:FLOCK_DEV_ROOT = ""
    $env:DISTILL_DEV_ROOT = Join-Path $temp "legacy-root"
    Assert-Equal "Get-FlockDevRoot falls back to DISTILL_DEV_ROOT" (Get-FlockDevRoot) $env:DISTILL_DEV_ROOT
    $env:FLOCK_DEV_ROOT = Join-Path $temp "new-root"
    Assert-Equal "FLOCK_DEV_ROOT wins over DISTILL_DEV_ROOT" (Get-FlockDevRoot) (Join-Path $temp "new-root")
    $env:FLOCK_DEV_ROOT = ""
    $env:DISTILL_DEV_ROOT = ""

    $oldVersionOverride = $env:FLOCK_APP_VERSION_OVERRIDE
    $oldLegacyVersionOverride = $env:DISTILL_APP_VERSION_OVERRIDE
    try {
        $env:FLOCK_APP_VERSION_OVERRIDE = ""
        $env:DISTILL_APP_VERSION_OVERRIDE = "9.8.7-legacy.1"
        Assert-Equal "Resolve-AppVersion falls back to DISTILL_APP_VERSION_OVERRIDE" (Resolve-AppVersion).RichVersion "9.8.7-legacy.1"
        $env:FLOCK_APP_VERSION_OVERRIDE = "9.8.7-new.1"
        Assert-Equal "FLOCK_APP_VERSION_OVERRIDE wins over DISTILL_APP_VERSION_OVERRIDE" (Resolve-AppVersion).RichVersion "9.8.7-new.1"
    } finally {
        $env:FLOCK_APP_VERSION_OVERRIDE = $oldVersionOverride
        $env:DISTILL_APP_VERSION_OVERRIDE = $oldLegacyVersionOverride
    }

    $oldDistroDir = $env:FLOCK_DISTRO_DIR
    $oldLegacyDistroDir = $env:DISTILL_DISTRO_DIR
    try {
        $env:FLOCK_DISTRO_DIR = ""
        $env:DISTILL_DISTRO_DIR = ""
        Assert-Equal "distro dir defaults to the checkout's distro folder" (Initialize-FlockDistroDirEnvironment) (Join-Path (Get-FlockRepoRoot) "distro")
        Assert-Equal "distro dir default is exported as FLOCK_DISTRO_DIR" $env:FLOCK_DISTRO_DIR (Join-Path (Get-FlockRepoRoot) "distro")
        $env:FLOCK_DISTRO_DIR = ""
        $env:DISTILL_DISTRO_DIR = Join-Path $temp "legacy-distro"
        Assert-Equal "distro dir falls back to DISTILL_DISTRO_DIR" (Initialize-FlockDistroDirEnvironment) (Join-Path $temp "legacy-distro")
        Assert-Equal "distro dir fallback is exported as FLOCK_DISTRO_DIR" $env:FLOCK_DISTRO_DIR (Join-Path $temp "legacy-distro")
        $env:FLOCK_DISTRO_DIR = Join-Path $temp "new-distro"
        Assert-Equal "FLOCK_DISTRO_DIR wins over DISTILL_DISTRO_DIR" (Initialize-FlockDistroDirEnvironment) (Join-Path $temp "new-distro")
    } finally {
        $env:FLOCK_DISTRO_DIR = $oldDistroDir
        $env:DISTILL_DISTRO_DIR = $oldLegacyDistroDir
    }

    # The CLI paths are exported under both spellings for one release so an
    # agent harness or skill that still reads DISTILLCTL_BIN finds the binary.
    $oldCliBins = @{}
    foreach ($name in @("FLOCKCTL_BIN", "FLOCK_MONITOR_BIN", "DISTILLCTL_BIN", "DISTILL_MONITOR_BIN")) {
        $oldCliBins[$name] = [System.Environment]::GetEnvironmentVariable($name, "Process")
    }
    try {
        Set-FlockCliBinEnvironment -FlockctlBin (Join-Path $temp "flockctl.exe") -MonitorBin (Join-Path $temp "flock-monitor.exe")
        Assert-Equal "CLI export sets FLOCKCTL_BIN" $env:FLOCKCTL_BIN (Join-Path $temp "flockctl.exe")
        Assert-Equal "CLI export sets FLOCK_MONITOR_BIN" $env:FLOCK_MONITOR_BIN (Join-Path $temp "flock-monitor.exe")
        Assert-Equal "CLI export also sets DISTILLCTL_BIN" $env:DISTILLCTL_BIN (Join-Path $temp "flockctl.exe")
        Assert-Equal "CLI export also sets DISTILL_MONITOR_BIN" $env:DISTILL_MONITOR_BIN (Join-Path $temp "flock-monitor.exe")
    } finally {
        foreach ($name in $oldCliBins.Keys) {
            [System.Environment]::SetEnvironmentVariable($name, $oldCliBins[$name], "Process")
        }
    }
    foreach ($launcherName in @("Dev-Windows.ps1", "Launch-ConductorDev.ps1", "Launch-Flock.ps1")) {
        $launcherSource = Get-Content -Raw (Join-Path (Get-FlockRepoRoot) "scripts\windows\$launcherName")
        Assert-Equal "$launcherName exports the CLI paths through the shared helper" `
            ($launcherSource -match 'Set-FlockCliBinEnvironment -FlockctlBin \$flockctlBin -MonitorBin \$monitorBin') $true
        Assert-Equal "$launcherName assigns no CLI path variable directly" ($launcherSource -match '\$env:(FLOCKCTL_BIN|FLOCK_MONITOR_BIN|DISTILLCTL_BIN|DISTILL_MONITOR_BIN)\s*=') $false
        Assert-Equal "$launcherName resolves the distro dir through the shared helper" ($launcherSource -match 'Initialize-FlockDistroDirEnvironment') $true
        Assert-Equal "$launcherName assigns FLOCK_DISTRO_DIR only through the helper" ($launcherSource -match '\$env:FLOCK_DISTRO_DIR\s*=') $false
    }

    $cleanupPaths = Resolve-WindowsCleanupPaths
    Assert-Equal "cleanup Flock dev root" $cleanupPaths.FlockDevRoot (Join-Path $env:LOCALAPPDATA "flock-dev")
    # The pre-rename dev root is reclaimed as legacy state, never written.
    Assert-Equal "cleanup legacy Flock dev root" $cleanupPaths.LegacyFlockDevRoot (Join-Path $env:LOCALAPPDATA "distill-dev")
    $cleanupScript = Get-Content -Raw (Join-Path (Get-FlockRepoRoot) "scripts\windows\Cleanup-Windows.ps1")
    Assert-Equal "cleanup removes the legacy Flock dev root" `
        ($cleanupScript -match 'Remove-CleanupPath "legacy Flock dev cache" \$paths\.LegacyFlockDevRoot \$paths\.LegacyFlockDevRoot') $true
    $env:FLOCK_DEV_ROOT = Join-Path $env:LOCALAPPDATA "distill-dev"
    Assert-Equal "cleanup lists no legacy dev root when the override points at it" ([string]::IsNullOrWhiteSpace((Resolve-WindowsCleanupPaths).LegacyFlockDevRoot)) $true
    $env:FLOCK_DEV_ROOT = ""
    # The active target dir is repo-local so a 30-60 GB debug build stays on
    # the checkout's drive; %LOCALAPPDATA%\berd-tauri survives only as the
    # legacy tree cleanup still reclaims.
    Assert-Equal "cleanup Tauri root" $cleanupPaths.FlockTauriRoot (Join-Path (Get-FlockRepoRoot) "src-tauri\target")
    Assert-Equal "cleanup legacy Tauri root" $cleanupPaths.LegacyFlockTauriRoot (Join-Path $env:LOCALAPPDATA "berd-tauri")
    Assert-Equal "Block npm cert file" $cleanupPaths.BlockCertFile (Join-Path $env:USERPROFILE ".block-certs\root-certs.pem")
    Assert-Equal "cleanup Corepack pnpm dir" $cleanupPaths.CorepackPnpmVersionDir (Join-Path $env:LOCALAPPDATA "node\corepack\v1\pnpm\$(Get-RequiredPnpmVersion)")
    Assert-Equal "cleanup fnm Node dir" $cleanupPaths.FnmNodeVersionDir (Join-Path $env:APPDATA "fnm\node-versions\v$(Get-RequiredNodeVersion)")
    Assert-Equal "cleanup fnm multishells dir" $cleanupPaths.FnmMultishellsDir (Join-Path $env:LOCALAPPDATA "fnm_multishells")
    Assert-Equal "cleanup repo node_modules" $cleanupPaths.RepoNodeModules (Join-Path (Get-FlockRepoRoot) "node_modules")
    Assert-Equal "cleanup repo pnpm store" $cleanupPaths.RepoPnpmStore (Join-Path (Get-FlockRepoRoot) ".pnpm-store")
    Assert-Equal "cleanup repo dist" $cleanupPaths.RepoDist (Join-Path (Get-FlockRepoRoot) "dist")
    Assert-Equal "cleanup git hooks dir" $cleanupPaths.GitHooksDir (Join-Path (Get-FlockRepoRoot) ".git\hooks")

    # A leftover Block Artifactory registry, as older Flock setups wrote it.
    $blockNpmRegistry = "https://global.block-artifacts.com/artifactory/api/npm/square-npm/"
    Assert-Equal "public npm registry" (Get-PublicNpmRegistry) "https://registry.npmjs.org/"
    Assert-Equal "detects Block Artifactory host" (Test-IsBlockNpmValue $blockNpmRegistry) $true
    Assert-Equal "detects Block cert path" (Test-IsBlockNpmValue $cleanupPaths.BlockCertFile) $true
    Assert-Equal "ignores public npm as Block" (Test-IsBlockNpmValue (Get-PublicNpmRegistry)) $false
    Assert-Equal "ignores empty npm value as Block" (Test-IsBlockNpmValue "") $false

    $oldNpmRegistry = $env:NPM_CONFIG_REGISTRY
    $oldCorepackRegistry = $env:COREPACK_NPM_REGISTRY
    $oldCafile = $env:NPM_CONFIG_CAFILE
    $oldNodeCerts = $env:NODE_EXTRA_CA_CERTS
    $oldIntegrity = $env:COREPACK_INTEGRITY_KEYS
    try {
        $env:NPM_CONFIG_REGISTRY = $blockNpmRegistry
        $env:COREPACK_NPM_REGISTRY = $blockNpmRegistry
        $env:NPM_CONFIG_CAFILE = $cleanupPaths.BlockCertFile
        $env:NODE_EXTRA_CA_CERTS = $cleanupPaths.BlockCertFile
        $env:COREPACK_INTEGRITY_KEYS = "0"
        Initialize-PublicNpmEnvironment
        Assert-Equal "rewrites Block npm registry to public npm" $env:NPM_CONFIG_REGISTRY (Get-PublicNpmRegistry)
        Assert-Equal "clears Block Corepack registry" ([string]::IsNullOrWhiteSpace($env:COREPACK_NPM_REGISTRY)) $true
        Assert-Equal "clears Block npm cafile" ([string]::IsNullOrWhiteSpace($env:NPM_CONFIG_CAFILE)) $true
        Assert-Equal "clears Block NODE_EXTRA_CA_CERTS" ([string]::IsNullOrWhiteSpace($env:NODE_EXTRA_CA_CERTS)) $true
        Assert-Equal "clears Artifactory Corepack integrity override" ([string]::IsNullOrWhiteSpace($env:COREPACK_INTEGRITY_KEYS)) $true

        $env:NPM_CONFIG_REGISTRY = "https://registry.example.test/npm/"
        $env:COREPACK_NPM_REGISTRY = "https://registry.example.test/npm/"
        $env:COREPACK_INTEGRITY_KEYS = "0"
        Initialize-PublicNpmEnvironment
        Assert-Equal "leaves non-Block npm registry alone" $env:NPM_CONFIG_REGISTRY "https://registry.example.test/npm/"
        Assert-Equal "leaves non-Block Corepack registry alone" $env:COREPACK_NPM_REGISTRY "https://registry.example.test/npm/"
        Assert-Equal "leaves unrelated Corepack integrity override" $env:COREPACK_INTEGRITY_KEYS "0"
    } finally {
        $env:NPM_CONFIG_REGISTRY = $oldNpmRegistry
        $env:COREPACK_NPM_REGISTRY = $oldCorepackRegistry
        $env:NPM_CONFIG_CAFILE = $oldCafile
        $env:NODE_EXTRA_CA_CERTS = $oldNodeCerts
        $env:COREPACK_INTEGRITY_KEYS = $oldIntegrity
    }
} finally {
    $env:FLOCK_DEV_ROOT = $oldFlockDevRoot
    $env:DISTILL_DEV_ROOT = $oldLegacyDevRoot
    $env:DISTILL_TAURI_CARGO_TARGET_DIR = $oldLegacyTargetDir
    $env:FLOCK_TAURI_CARGO_TARGET_DIR = $oldFlockTargetDir
    $env:LOCALAPPDATA = $oldLocalAppData
    $env:USERPROFILE = $oldUserProfile
    $env:APPDATA = $oldAppData
    $env:FNM_DIR = $oldFnmDir
    if ($temp -and (Test-Path $temp)) {
        # Best effort: a transiently locked temp file must not fail the run.
        Remove-Item -Recurse -Force -Path $temp -ErrorAction SilentlyContinue
    }
}

if ($script:Failures -gt 0) {
    exit 1
}
exit 0

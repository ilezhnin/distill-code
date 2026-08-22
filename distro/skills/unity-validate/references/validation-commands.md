# Guarded Unity Validation Commands

Prefer project-specific commands (in this project: Unity MCP `run_tests`/`refresh_unity` when the
Editor is connected). These PowerShell templates are the batchmode fallback. Never launch a second
Editor against a project that already has one open, and never compile/refresh while Play Mode is
active.

## Preflight And Guard

```powershell
$projectRoot = (Get-Item -LiteralPath ".").FullName
$logRoot = Join-Path $projectRoot ".agents/plans/validation"
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

# Editor version must match the project.
$requiredVersion = ((Get-Content "ProjectSettings/ProjectVersion.txt" |
    Where-Object { $_ -like "m_EditorVersion:*" } | Select-Object -First 1) -split ":", 2)[1].Trim()
if ([string]::IsNullOrWhiteSpace($env:UNITY_EDITOR) -or -not (Test-Path -LiteralPath $env:UNITY_EDITOR -PathType Leaf)) {
    throw "UNITY_EDITOR must point to the Unity $requiredVersion executable."
}
$reported = (& $env:UNITY_EDITOR -version | Out-String).Trim()
if ($reported -ne $requiredVersion) { throw "Unity -version reported '$reported'; expected '$requiredVersion'." }

function Invoke-GuardedUnity {
    param([Parameter(Mandatory = $true)][scriptblock] $Operation)

    [string[]] $preStatus = @(& git -C $projectRoot -c core.quotepath=off status --porcelain)
    try {
        & $Operation
    }
    finally {
        [string[]] $postStatus = @(& git -C $projectRoot -c core.quotepath=off status --porcelain)
        if (Compare-Object $preStatus $postStatus) {
            Compare-Object $preStatus $postStatus | Set-Content (Join-Path $logRoot "git-status-delta.txt")
            Write-Warning "Unity changed tracked/untracked content; inspect git-status-delta.txt and report it as a blocker."
        }
    }
}
```

When the run touched assets or `.meta` files, also run `.agents/scripts/check-unity-meta.ps1
-ProjectRoot $projectRoot` afterward.

## Compile

```powershell
Invoke-GuardedUnity {
    & $env:UNITY_EDITOR -batchmode -nographics -quit -projectPath $projectRoot -logFile (Join-Path $logRoot "UnityCompile.log")
    if ($LASTEXITCODE -ne 0) { throw "Unity compile failed with exit code $LASTEXITCODE." }
}
```

Do not add `-accept-apiupdate` without explicit approval.

## Filtered EditMode Tests

```powershell
$testFilter = "<fully-qualified fixture, namespace, or test>"
if ($testFilter -like "<*") { throw "Replace the EditMode test filter before running." }

Invoke-GuardedUnity {
    & $env:UNITY_EDITOR -batchmode -projectPath $projectRoot -runTests -testPlatform EditMode -testFilter $testFilter -testResults (Join-Path $logRoot "EditMode.xml") -logFile (Join-Path $logRoot "EditMode.log")
    if ($LASTEXITCODE -ne 0) { throw "EditMode tests failed with exit code $LASTEXITCODE." }
}
```

## Filtered PlayMode Tests

Omit `-nographics` unless the selected tests are known to be headless-safe.

```powershell
$testFilter = "<fully-qualified fixture, namespace, or test>"
if ($testFilter -like "<*") { throw "Replace the PlayMode test filter before running." }

Invoke-GuardedUnity {
    & $env:UNITY_EDITOR -batchmode -projectPath $projectRoot -runTests -testPlatform PlayMode -testFilter $testFilter -testResults (Join-Path $logRoot "PlayMode.xml") -logFile (Join-Path $logRoot "PlayMode.log")
    if ($LASTEXITCODE -ne 0) { throw "PlayMode tests failed with exit code $LASTEXITCODE." }
}
```

Never combine `-quit` with `-runTests`; the Test Framework exits after the run.

## Evidence Review

After the guarded call, parse result XML and logs; exit code alone is not evidence.

```powershell
Select-String -Path (Join-Path $logRoot "*.log") -Pattern "error CS|Exception|Compilation failed|Build failed|Test run failed" -CaseSensitive:$false
```

Use evidence-specific wording: name the exact command, filter, result counts, and log path — or
state plainly that Unity compilation remains unverified.

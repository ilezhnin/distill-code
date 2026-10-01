# Cargo target runner. Cargo supplies the executable followed by untouched
# libtest arguments, including filters, skips and native-gate flags.
$ErrorActionPreference = 'Stop'
if ($args.Count -eq 0) { throw 'The Cargo test executable is required.' }
$testExecutable = (Resolve-Path -LiteralPath $args[0]).Path
$testArguments = @($args | Select-Object -Skip 1)
if ([IO.Path]::GetFileName($testExecutable) -match '^distill_lib-[a-f0-9]+\.exe$') {
    # Tauri embeds its activation manifest only into the app binary. Rust's
    # library test process also loads Common Controls v6; a global linker flag
    # would duplicate the app manifest, so modify only this generated artifact.
    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $targetRoot = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $repoRoot 'src-tauri/target' }
    $resolvedTarget = (Resolve-Path -LiteralPath $targetRoot).Path
    if (-not $testExecutable.StartsWith($resolvedTarget + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to modify a unit-test executable outside the configured Cargo target directory.'
    }
    $sdkBin = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
    $manifestTool = Get-ChildItem -LiteralPath $sdkBin -Directory |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName 'x64/mt.exe' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
    if (-not $manifestTool) { throw 'Windows SDK mt.exe is required for the unit-test activation manifest.' }
    $manifestPath = $testExecutable + '.manifest'
    @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" /></dependentAssembly></dependency>
</assembly>
'@ | Set-Content -LiteralPath $manifestPath -Encoding utf8
    & $manifestTool -nologo -manifest $manifestPath "-outputresource:$testExecutable;#1"
    if ($LASTEXITCODE -ne 0) { throw 'Failed to add the test-only activation manifest.' }
}
& $testExecutable @testArguments
exit $LASTEXITCODE

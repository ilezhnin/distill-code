$ErrorActionPreference = 'Stop'
$CargoArguments = @($args)
if ($CargoArguments.Count -eq 0) { throw 'Cargo arguments are required.' }
if ($CargoArguments | Where-Object { $_ -is [array] }) {
    throw 'Cargo arguments must be individual strings. Forward an argv array; unquoted comma-separated feature names become PowerShell arrays and can silently filter every test.'
}
if ($CargoArguments[0] -eq 'test' -and $CargoArguments -contains '--lib') {
    # Cargo owns compile options and libtest argument forwarding. A scoped
    # target runner prepares the generated test binary immediately before it
    # executes, including when Cargo has just rebuilt it.
    $runnerPath = (Join-Path $PSScriptRoot 'Invoke-Rust-Unit-Test-Windows.ps1').Replace('\', '/')
    $runnerConfig = 'target.x86_64-pc-windows-msvc.runner = ' +
        (ConvertTo-Json -Compress -InputObject @('powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $runnerPath))
    # Windows PowerShell 5 removes literal quotes in native argv. Give Cargo a
    # config file rather than a TOML expression transported through that parser.
    $configFile = [IO.Path]::GetTempFileName()
    try {
        [IO.File]::WriteAllText($configFile, $runnerConfig, [Text.UTF8Encoding]::new($false))
        & cargo --config $configFile @CargoArguments
        $cargoExitCode = $LASTEXITCODE
    } finally {
        Remove-Item -LiteralPath $configFile
    }
    exit $cargoExitCode
} else {
    & cargo @CargoArguments
}
exit $LASTEXITCODE

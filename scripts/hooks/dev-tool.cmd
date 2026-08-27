@echo off
rem Run a development tool, or say plainly that it could not be found.
rem
rem Windows counterpart of scripts/hooks/dev-tool.sh; the two must stay in
rem step. Git hooks started from a GUI client (Sourcetree, an IDE) run with a
rem trimmed PATH: a pnpm installed through fnm lives only in a per-shell
rem directory under %LOCALAPPDATA%\fnm_multishells and is invisible here, so
rem the hook died on "pnpm is not recognized" before a single check had run.
rem
rem This is a batch file rather than a .ps1 on purpose. Recipe lines run in
rem PowerShell, and PowerShell's parameter binder eats a bare "--" out of a
rem script call, which would silently change what the wrapped command runs.
rem A batch file is a native command, so its arguments arrive verbatim.
rem
rem A tool that is genuinely not installed must not block a push: CI runs the
rem same checks. The launcher warns loudly and skips instead, never quietly,
rem and never on CI or under BERD_REQUIRE_DEV_TOOLS=1.
setlocal enabledelayedexpansion

if "%~1"=="" (
  echo usage: dev-tool.cmd ^<tool^> [args...] 1>&2
  exit /b 2
)

set "TOOL=%~1"
set "ALL_ARGS=%*"
rem Everything after the tool name, byte for byte, quoting included.
set "TOOL_ARGS=!ALL_ARGS:*%TOOL%=!"

set "RESOLVED="

rem 1. Whatever PATH already offers.
for /f "delims=" %%p in ('where "%TOOL%" 2^>nul') do if not defined RESOLVED set "RESOLVED=%%p"

rem 2. fnm's per-shell directories, newest first: the case that started this.
if not defined RESOLVED if defined LOCALAPPDATA (
  for /f "delims=" %%d in ('dir /b /ad /o-d "%LOCALAPPDATA%\fnm_multishells" 2^>nul') do (
    if not defined RESOLVED call :try_dir "%LOCALAPPDATA%\fnm_multishells\%%d"
  )
)

rem 3. fnm's stable alias, the npm global prefix, and Rust's own bin dir.
if not defined RESOLVED if defined FNM_DIR call :try_dir "%FNM_DIR%\aliases\default"
if not defined RESOLVED if defined LOCALAPPDATA call :try_dir "%LOCALAPPDATA%\fnm\aliases\default"
if not defined RESOLVED if defined APPDATA call :try_dir "%APPDATA%\npm"
if not defined RESOLVED if defined USERPROFILE call :try_dir "%USERPROFILE%\.cargo\bin"

rem 4. corepack can materialise the pnpm this repo pins. Last, because it may
rem    reach the network, which a pre-push hook should not do casually.
if not defined RESOLVED if /i "%TOOL%"=="pnpm" (
  where corepack >nul 2>nul
  if not errorlevel 1 (
    call corepack pnpm !TOOL_ARGS!
    exit /b !ERRORLEVEL!
  )
)

if not defined RESOLVED (
  echo. 1>&2
  echo   ** %TOOL% was not found on PATH, under fnm, or in an npm prefix. 1>&2
  if defined CI (
    echo   ** Refusing to skip it here: this is CI. 1>&2
    echo. 1>&2
    exit /b 127
  )
  if "%BERD_REQUIRE_DEV_TOOLS%"=="1" (
    echo   ** Refusing to skip it here: BERD_REQUIRE_DEV_TOOLS=1. 1>&2
    echo. 1>&2
    exit /b 127
  )
  echo   ** Skipping the check that needs it. CI still runs it on this push. 1>&2
  echo   ** Install %TOOL%, or run "just setup-windows", to get it back locally. 1>&2
  echo. 1>&2
  exit /b 0
)

rem A tool resolved outside PATH usually has its runtime beside it - an fnm
rem pnpm shim calls the node next to it. Put its directory first so the tool
rem can find its own neighbours.
for %%i in ("%RESOLVED%") do set "TOOL_DIR=%%~dpi"
set "PATH=%TOOL_DIR%;%PATH%"

call "%RESOLVED%" !TOOL_ARGS!
exit /b !ERRORLEVEL!

:try_dir
if defined RESOLVED exit /b 0
if exist "%~1\%TOOL%.cmd" (
  set "RESOLVED=%~1\%TOOL%.cmd"
  exit /b 0
)
if exist "%~1\%TOOL%.exe" (
  set "RESOLVED=%~1\%TOOL%.exe"
  exit /b 0
)
if exist "%~1\%TOOL%.bat" (
  set "RESOLVED=%~1\%TOOL%.bat"
  exit /b 0
)
exit /b 0

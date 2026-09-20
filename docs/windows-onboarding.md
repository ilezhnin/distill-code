# Windows setup

Distill builds and runs on Windows only. This lane takes a machine from nothing
to a running dev app and an installer:

- install or diagnose the native Windows prerequisites
- install pnpm dependencies and git hooks
- launch the Tauri dev app with `just dev-windows`
- build an NSIS or MSI installer with `just bundle`

Every `just` recipe here runs a script in `scripts\windows\`. Without `just`
on `PATH`, run the script directly from the repository root, for example:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\Doctor-Windows.ps1
```

| Recipe | Script |
| --- | --- |
| `just bootstrap-windows [install]` | `Bootstrap-Windows.ps1 [-Mode install]` |
| `just doctor-windows` | `Doctor-Windows.ps1` |
| `just setup-windows` | `Setup-Windows.ps1` |
| `just dev-windows` | `Dev-Windows.ps1` |
| `just bundle`, `just bundle-windows msi`, `just bundle-debug` | `Bundle-Windows.ps1 [-Bundle msi] [-Debug]` |
| `just tauri-check-windows` | `Tauri-Check-Windows.ps1` |
| `just ci-windows` | `CI-Windows.ps1` |
| `just test-windows-dev` | `Test-WindowsDev.ps1` |
| `just prune-build-cache [-Remove] [-Deep]` | `Prune-BuildCache-Windows.ps1 [-Remove] [-Deep]` |
| `just cleanup-windows [remove] [flags]` | `Cleanup-Windows.ps1 [-Mode remove] [flags]` |

## Fresh Machine Scope

Use normal PowerShell. You do not need a Visual Studio Developer PowerShell; the
Windows scripts load the Visual Studio build environment before running Cargo.

The repeatable entrypoint is `just`, but a completely fresh Windows machine
still needs two seed steps:

1. Install `just` once:

   ```powershell
   winget install --id Casey.Just -e
   ```

2. Get a checkout. If Git is not installed yet, install it once:

   ```powershell
   winget install --id Git.Git -e
   ```

   Then clone or open the repository. After you are in it,
   `bootstrap-windows` owns Git validation and repair like the other Windows
   prerequisites.

Open a fresh PowerShell after installing `just` or Git if the commands are not
visible on `PATH`.

## First Bootstrap

From the repo root:

```powershell
just bootstrap-windows
just bootstrap-windows install
```

`just bootstrap-windows` is check-only. It reports what is missing and prints
the exact remediation it expects.

`just bootstrap-windows install` installs missing prerequisites with WinGet and
may request one administrator prompt for Visual Studio Build Tools. Re-running
it is safe; installed tools are detected and reused.

Bootstrap installs or validates:

- Git and Git Bash
- Visual Studio Build Tools with MSVC C++ tools
- Microsoft Edge WebView2 Runtime
- Rust MSVC toolchain from `rust-toolchain.toml`
- `fnm`, Node, Corepack, and `pnpm@10.33.0`
- CMake
- Lefthook
- just

Bootstrap does not create or mutate user-level npm registry or TLS configuration.
The Windows setup/dev scripts talk to the public npm registry
(`https://registry.npmjs.org/`); registry and CA overrides left in the
environment by an older upstream setup are ignored for the run. If your
environment uses a registry mirror, proxy, or custom certificate authority,
configure those through your normal Node/npm tooling before running
`just setup-windows`. Never bypass TLS verification with `strict-ssl=false`.

Open a fresh PowerShell after install mode if PATH changes are not visible.

## Verify Readiness

After bootstrap install:

```powershell
just doctor-windows
```

Expected result: every check passes, including `npm ping` against the public
registry. A failure line names the command that fixes it.

## Setup

```powershell
just setup-windows
```

Setup installs pnpm dependencies and the Lefthook git hooks. Nothing else is
built ahead of time: the app installs the Claude Code and Codex bridges itself
at startup, from the versions pinned in `acp-tools.lock.json`, onto a managed
Node runtime pinned by `node-runtime.lock.json`.

## Where Build State Lives

The Rust/Tauri build cache is by far the largest thing this lane creates: a
debug build of the workspace is 30-60 GB (dependency objects, incremental
cache, debug info). It is written **inside the checkout**, so it lands on
whatever drive you cloned to:

```text
<repo>\src-tauri\target
```

Set `DISTILL_TAURI_CARGO_TARGET_DIR` (a user-level environment variable) to move
it somewhere else. Do not point it at the system drive: earlier versions
defaulted to `%LOCALAPPDATA%\berd-tauri\cargo-target` and routinely filled C:.
The launcher warns when the resolved target dir is on the system drive.

Only small dev state stays under `%LOCALAPPDATA%\distill-dev` (the generated
Tauri dev config and launch locks).

To reclaim space without uninstalling the toolchain:

```powershell
just prune-build-cache                 # dry run: what would be reclaimed
just prune-build-cache -Remove         # incremental cache + interrupted-build leftovers
just prune-build-cache -Remove -Deep   # also the whole target dir (full rebuild)
```

Without `just` on PATH, call the script directly:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\Prune-BuildCache-Windows.ps1 -Remove
```

It only removes output it can regenerate, and refuses to run while `cargo`,
`rustc` or `Distill` is alive. Anything it does not recognize is printed as a
`keep` line and left alone.

`just cleanup-windows` is the uninstall lane instead: it removes
`node_modules`, git hooks and, with `-All`, the shared toolchain.

## Launch The Native App

```powershell
just dev-windows
```

`just dev-windows` builds `distillctl.exe` and `distill-monitor.exe`, points the app
at this repository's `distro\` for bundled agents and skills, and starts Tauri
dev mode.

Expected result:

- Vite starts on a port derived from the checkout path
- `Distill.exe` launches from the Tauri cargo target as the Distill window
- on launch the app installs the pinned Claude Code and Codex bridges onto the
  managed Node runtime (the first launch downloads both); later launches reuse
  them until a pin changes

`scripts\windows\Launch-Distill.ps1 -InstallShortcut` puts a "Distill Code"
shortcut on the desktop that runs the same launch from Explorer. That launcher
builds with `distillctl` only: unlike `just dev-windows` it does not enable
`app-test-driver`, so a shortcut-launched app exposes no unauthenticated
UI-driving socket (see [docs/app-e2e.md](app-e2e.md)).

The launcher also starts `tauri dev` with `--no-watch`. It is the app agents
work on Distill from, and with the Rust watcher on, an agent saving a file
under `src-tauri` rebuilds and relaunches the app it runs in, which ends its
turn. Rust changes reach the app on the next launch; pass `-Watch` to get the
rebuild-on-save back. `just dev-windows` keeps the watcher, and
`DISTILL_DEV_NO_WATCH=1` turns it off there too.

## Build An Installer

```powershell
just bundle                 # NSIS
just bundle-windows msi     # MSI
just bundle-debug           # NSIS with WebView devtools
```

The bundle script installs locked dependencies, stages `distillctl` and
`distill-monitor` as `*-x86_64-pc-windows-msvc.exe` sidecars, runs `tauri build`
for that target and prints the installer path under
`<target>\x86_64-pc-windows-msvc\release\bundle\`. Installers are unsigned.

## Validation Commands

Use these when changing the Windows lane or verifying a machine:

```powershell
just doctor-windows
just setup-windows
just tauri-check-windows
just test-windows-dev
```

`tauri-check-windows` runs Windows-native Rust/Tauri checks with external
sidecars disabled. `test-windows-dev` covers focused Windows script path, stamp,
and cleanup helpers. `ci-windows` runs the managed Node runtime and bridge
tests that need a real Windows host, plus Windows clippy.

## Cleanup And Reset

Cleanup is dry-run by default:

```powershell
just cleanup-windows
```

Default removal deletes the local dev caches (`%LOCALAPPDATA%\distill-dev` and
the Tauri cargo target) and generated repo setup/dev artifacts: root
`node_modules`, root `.pnpm-store`, root `dist`, and the Lefthook-managed
`pre-commit` and `pre-push` hooks:

```powershell
just cleanup-windows remove -Yes
```

Everything beyond the default removal touches software shared with other
projects (global Node state, rustup toolchains, CMake, just, ...), so
those categories require a second acknowledgment: `-YesShared` in addition to
`-Yes`.

Node state covers Corepack's pnpm cache, an npm-global pnpm fallback if
bootstrap used it, fnm transient shell directories, and the fnm-managed Node
version pinned by this lane. Disabling Corepack shims and uninstalling
npm-global pnpm affects every repo on the machine that uses them:

```powershell
just cleanup-windows remove -Yes -YesShared -IncludeNodeState
```

Use `-All` to select every optional cleanup group except the WebView2 Runtime.
User npm registry and certificate settings are not included because bootstrap does
not own machine-level npm configuration:

```powershell
just cleanup-windows remove -All -Yes -YesShared
```

Shared developer tools can also be selected individually:

```powershell
just cleanup-windows remove -Yes -YesShared -IncludeNodeState -IncludeSharedTools -IncludeVisualStudioBuildTools
```

`-IncludeSharedTools` covers rustup (via `rustup self uninstall`, which also
removes `~\.cargo` and `~\.rustup`), fnm, CMake, just, and Lefthook. Git is intentionally retained because the Windows
onboarding lane still needs it to manage the checkout. Visual Studio Build
Tools is separate because uninstalling it is more disruptive and may require
elevation.

The WebView2 Runtime is OS-level infrastructure shared by Teams, Outlook, and
every other WebView2 app, so it is excluded from `-All` and only removed with
an explicit `-IncludeWebView2`:

```powershell
just cleanup-windows remove -Yes -YesShared -IncludeWebView2
```

## Troubleshooting

If `just` is not recognized, open a new PowerShell after installing it. WinGet
usually installs it under:

```text
%LOCALAPPDATA%\Microsoft\WinGet\Packages\Casey.Just_Microsoft.Winget.Source_8wekyb3d8bbwe\just.exe
```

If `pnpm` fails with `running scripts is disabled on this system`, use
`pnpm.cmd` for manual commands. The `just` recipes already run PowerShell with
execution-policy bypass where needed.

If MSVC or `link.exe` is missing, rerun:

```powershell
just bootstrap-windows install
```

Install mode may request an administrator prompt to repair Visual Studio Build
Tools with the C++ workload.

If dependencies or the dev cache look stale, reset the local Windows state:

```powershell
just cleanup-windows remove -Yes
just setup-windows
```

If an agent session will not start, check the app log at
`%LOCALAPPDATA%\com.levocat.distill\logs\distill.log`; each harness's stderr is
logged there prefixed with its id, such as `[claude-acp]`.

If you want a full fresh-machine reset after testing, review the cleanup dry run
first, then run the full reset command from the cleanup section.

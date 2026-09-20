# Distill

Distill is a desktop app for working with AI agents, built with Tauri 2 and
React 19. A built-in Rust ACP host (`src-tauri/src/services/agent_host/`)
spawns the agent harnesses on demand and keeps every session on your machine:

- Claude Code and Codex, through the ACP bridges pinned in
  `acp-tools.lock.json` and installed at runtime onto a managed Node runtime;
- GitHub Copilot, Grok and Amp, through their own CLIs when you have them
  installed.

On top of plain chats it has projects, agents and skills, a conductor that
plans larger requests as waves of executor sessions and reviews their reports
(`src/features/conductor/`, `LAWS/WAVES.md`), a planner that collects tasks
agents file (`src/features/planner/`), and memory that carries short facts into
later prompts, globally or per project (`src/features/memory/`,
`LAWS/MEMORY.md`). Agents drive the visible app through the bundled `distillctl`
CLI.

Distill runs on Windows only. It is a personal fork of
[block/berd](https://github.com/block/berd) by Ivan Lezhnin; the original work
is Block's, and the project stays under the Apache 2.0 [LICENSE](LICENSE).

## Setup on Windows

Every recipe below is a thin wrapper around a script in `scripts\windows\`.
When `just` is not on `PATH`, run the script from the repository root with
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File <script>`.

| Step | `just` | Script |
| --- | --- | --- |
| Check prerequisites | `just bootstrap-windows` | `scripts\windows\Bootstrap-Windows.ps1` |
| Install what is missing with WinGet | `just bootstrap-windows install` | `scripts\windows\Bootstrap-Windows.ps1 -Mode install` |
| Verify the machine | `just doctor-windows` | `scripts\windows\Doctor-Windows.ps1` |
| Install pnpm dependencies and git hooks | `just setup-windows` | `scripts\windows\Setup-Windows.ps1` |
| Run the dev app | `just dev-windows` | `scripts\windows\Dev-Windows.ps1` |

For example, without `just`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\Bootstrap-Windows.ps1 -Mode install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\Setup-Windows.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\Dev-Windows.ps1
```

Bootstrap installs or checks Git, Visual Studio Build Tools (MSVC), the WebView2
Runtime, the Rust toolchain from `rust-toolchain.toml`, fnm with Node and pnpm,
CMake, just and Lefthook; `winget install --id Casey.Just -e` gets `just`
itself. Open a new PowerShell when freshly installed tools are not on `PATH`.

`dev-windows` builds `distillctl.exe` and `distill-monitor.exe`, starts Vite and the
Tauri dev app, and points the app at this repository's `distro\` for bundled
agents and skills. `scripts\windows\Launch-Distill.ps1 -InstallShortcut`
creates a desktop shortcut that launches the dev app from Explorer.

The Rust build cache lives in `src-tauri\target` and grows to tens of GB; set
`DISTILL_TAURI_CARGO_TARGET_DIR` to move it. More detail, cleanup and
troubleshooting: [docs/windows-onboarding.md](docs/windows-onboarding.md).

## Bundling

| Output | `just` | Script |
| --- | --- | --- |
| NSIS installer | `just bundle` | `scripts\windows\Bundle-Windows.ps1` |
| MSI installer | `just bundle-windows msi` | `scripts\windows\Bundle-Windows.ps1 -Bundle msi` |
| NSIS installer with WebView devtools | `just bundle-debug` | `scripts\windows\Bundle-Windows.ps1 -Debug` |

The script installs locked dependencies, stages `distillctl` and `distill-monitor`
as `externalBin` sidecars, runs `tauri build` for `x86_64-pc-windows-msvc`, and
prints the installer path under
`<target>\x86_64-pc-windows-msvc\release\bundle\`. Installers are unsigned.
The harness bridges are not bundled; the app installs them at runtime.

## Useful commands

- `just check` — design-system, distillctl contract, formatting, lint, i18n and
  TypeScript checks
- `just test` — the Vitest suite (`pnpm test`) plus the hook launcher tests
- `just fmt` — format frontend and Rust files
- `just tauri-check` / `just clippy` — Rust check and lint with sidecars
  disabled
- `just ci` — the local gate: frontend checks, Rust format, check, tests and
  clippy, unit and relay tests, frontend build
- `just ci-windows` — Windows-native Rust tests for the managed Node runtime
  and bridges (`scripts\windows\CI-Windows.ps1`)
- `just test-windows-dev` — self-tests for the Windows scripts
  (`scripts\windows\Test-WindowsDev.ps1`)
- `just prune-build-cache` — reclaim build-cache disk; a dry run unless given
  `-Remove` (`scripts\windows\Prune-BuildCache-Windows.ps1`)
- `just cleanup-windows` — dry-run or remove local setup state
  (`scripts\windows\Cleanup-Windows.ps1`)
- `just new-command <noun> <verb>` — scaffold a distillctl command
- `just bump-node-runtime <version>` — re-pin the managed Node runtime

The app log is `%LOCALAPPDATA%\com.levocat.distill\logs\distill.log`; each harness's
stderr lands there prefixed with its id, such as `[claude-acp]`. A dev build
uses `com.levocat.distill.dev`. Chats, projects and installed bridges are under
the same name in `%APPDATA%`. Folders left by a build that still ran as
`xyz.block.berd` are renamed on the first start.

[AGENTS.md](AGENTS.md) describes the layout and conventions,
[LAWS/](LAWS/README.md) the product rules the code is held to, and
[docs/app-e2e.md](docs/app-e2e.md) how to drive the running app from outside.

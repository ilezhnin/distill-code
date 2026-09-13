# Cargo features for the full dev/CI posture of the app crate.
app_features := "berdctl,app-test-driver"

# Every hook- and CI-facing check reaches its tool through this launcher
# instead of by bare name. A GUI git client (Sourcetree, an IDE) starts hooks
# with a trimmed PATH, so a pnpm installed through fnm — which lives in a
# per-shell directory keyed by pid — is invisible and every pre-push check died
# on "pnpm is not recognized" before it had run. The launcher knows where to
# look, and when a tool genuinely is not installed it warns and skips rather
# than failing the push: CI runs the same checks on the pushed commits either
# way, and a hook that blocks on a missing tool only teaches --no-verify.
dev_tool := if os_family() == "windows" { "./scripts/hooks/dev-tool.cmd" } else { "./scripts/hooks/dev-tool.sh" }

# Ordinary recipe lines run in native Windows PowerShell; shebang recipes keep
# their explicit Unix interpreter and are unaffected.
set windows-shell := ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]

# Default recipe
default:
    @just --list

# Check or install native Windows prerequisites. Fresh Windows machines only
# need `winget install --id Casey.Just -e` before this entrypoint is available.
bootstrap-windows mode="check":
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Bootstrap-Windows.ps1 -Mode "{{ mode }}"

# Report native Windows readiness for first-milestone Berd verification.
doctor-windows:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Doctor-Windows.ps1

# Dry-run or remove native Windows onboarding state.
cleanup-windows *ARGS:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Cleanup-Windows.ps1 {{ ARGS }}

# Reclaim disk from the Rust/Tauri build cache (dry run; -Remove to delete).
prune-build-cache *ARGS:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Prune-BuildCache-Windows.ps1 {{ ARGS }}

# Install pnpm dependencies and hooks natively on Windows.
setup-windows:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Setup-Windows.ps1

# Launch the native Windows Tauri dev app with berdctl.exe.
dev-windows:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Dev-Windows.ps1

# Run Windows-native Rust/Tauri checks with external sidecars disabled.
tauri-check-windows:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Tauri-Check-Windows.ps1

# Build an unsigned native Windows installer with pinned managed sidecars.
# `bundle` is transported as an argv element to this generated script. Never
# interpolate recipe arguments into PowerShell source.
[windows]
[positional-arguments]
[script("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File")]
bundle-windows bundle="nsis":
    & (Join-Path (Get-Location) "scripts/windows/Bundle-Windows.ps1") -Bundle $args[0]
    if (-not $?) { exit 1 }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Run focused tests for Windows script path/stamp helpers.
test-windows-dev:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Test-WindowsDev.ps1

# ── Build & Check ────────────────────────────────────────────

# Run the frontend non-test checks: design-system guardrails, berdctl contract freshness, formatting, lint, i18n, bundled agents, and TypeScript.
check: design-system-check berdctl-contract-check frontend-fmt-check lint i18n-check bundled-agents-check typecheck

# Regenerate the berdctl CLI contract artifacts from the command registry.
berdctl-contract-generate:
    pnpm generate:berdctl-contract

# Check that the generated berdctl contract artifacts are up to date.
berdctl-contract-check:
    {{ dev_tool }} pnpm generate:berdctl-contract --check

# Format frontend and Tauri/Rust files.
fmt:
    just frontend-fmt
    just tauri-fmt

# Check frontend and Tauri/Rust formatting.
fmt-check: frontend-fmt-check tauri-fmt-check

# Format frontend files with Biome.
frontend-fmt:
    pnpm format

# Generate the design-system component manifest.
design-system-generate:
    pnpm design-system:generate

# Check generated design-system facts, token/style guardrails, and explorer coverage.
design-system-check: design-system-manifest-check design-system-tokens design-system-audit design-system-coverage

# Check that the generated design-system component manifest is up to date.
design-system-manifest-check:
    {{ dev_tool }} pnpm design-system:manifest-check

# Audit covered components for custom color styling and source-token drift.
design-system-audit:
    {{ dev_tool }} pnpm design-system:audit

# Check that app color usage follows the shadcn + Berd token contract.
design-system-tokens:
    {{ dev_tool }} pnpm design-system:tokens

# Check that curated explorer component pages follow the page contract.
design-system-coverage:
    {{ dev_tool }} pnpm design-system:coverage -- --strict

# Check frontend formatting with Biome.
frontend-fmt-check:
    {{ dev_tool }} pnpm exec biome format .

# Lint frontend files with Biome.
lint:
    {{ dev_tool }} pnpm lint

# Check frontend i18n string conventions.
i18n-check:
    {{ dev_tool }} pnpm check:i18n

# Validate the frontmatter contract of every bundled agent in distro/agents.
bundled-agents-check:
    {{ dev_tool }} pnpm validate:bundled-agents

# Type-check frontend TypeScript, then the Playwright suites and TypeScript
# repo scripts under tests/ and scripts/ (tsconfig.json only covers src/, and
# Playwright transpiles specs without checking them).
typecheck:
    {{ dev_tool }} pnpm typecheck
    {{ dev_tool }} pnpm typecheck:tests

# Format Tauri/Rust files.
tauri-fmt:
    cargo fmt --manifest-path src-tauri/Cargo.toml

# Check Tauri/Rust formatting.
tauri-fmt-check:
    {{ dev_tool }} cargo fmt --manifest-path src-tauri/Cargo.toml --check

# Run as a generated PowerShell script, not a shebang recipe. just follows the
# Unix shebang rule and hands the interpreter everything after its path as ONE
# argument, so `#!powershell.exe -NoProfile -ExecutionPolicy Bypass` reached
# powershell.exe as the single string "-NoProfile -ExecutionPolicy Bypass";
# it matched no switch, was taken as the default -Command, and PowerShell tried
# to run `-NoProfile` as a cmdlet. That is the operator's
# "-NoProfile : The term '-NoProfile' is not recognized" and the exit code 1
# this recipe reported from a GUI client. [script] passes each argument on its
# own and names the temp file .ps1, which -File requires.
[windows]
[script("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File")]
_tauri-cargo-windows *ARGS:
    $ErrorActionPreference = "Stop"
    Import-Module (Join-Path (Get-Location) "scripts/windows/WindowsDev.psm1") -Force -DisableNameChecking
    Assert-WindowsHost
    Update-SessionPathFromRegistry
    Assert-MsvcEnvironment
    Set-Location (Join-Path (Get-BerdRepoRoot) "src-tauri")
    $env:CARGO_TARGET_DIR = Get-TauriCargoTargetDir
    $env:TAURI_CONFIG = '{"bundle":{"externalBin":[],"resources":[]}}'
    cargo {{ ARGS }}
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Run Rust clippy with warnings denied.
[windows]
clippy:
    just _tauri-cargo-windows clippy -- -D warnings
    just _tauri-cargo-windows clippy --features {{ app_features }} -- -D warnings
    just _tauri-cargo-windows clippy -p berdctl -- -D warnings
    just _tauri-cargo-windows clippy -p berd-monitor -- -D warnings
    just _tauri-cargo-windows clippy -p tauri-plugin-berdctl --features server -- -D warnings

# Build the frontend.
build:
    pnpm build

# Check the Tauri/Rust crate with external sidecars disabled.
[windows]
tauri-check:
    just tauri-check-windows

# Run the Rust tests with external sidecars disabled: the app library's own
# unit tests, then the berdctl plugin, CLI and monitor crates.
[windows]
tauri-test:
    just _tauri-cargo-windows test --lib
    just _tauri-cargo-windows test -p tauri-plugin-berdctl --features server
    just _tauri-cargo-windows test -p berdctl
    just _tauri-cargo-windows test -p berd-monitor

# Check npm and Rust dependencies against published advisories, the same way CI
# does. Kept out of `just ci` because both halves need network access and
# `cargo audit` is a separate tool install (`cargo install cargo-audit`); the
# CI jobs are the enforcing gate.
[windows]
audit:
    {{ dev_tool }} pnpm audit --prod --audit-level=high
    just _tauri-cargo-windows audit

# Run the local CI gate.
[windows]
ci: check tauri-fmt-check tauri-check tauri-test clippy test agent-driver-test build

# Native x64 MSVC CI gate for the managed Node runtime + ACP bridge.
# Runs the managed_node / managed_acp_tools module tests (including the
# BERD_WS2_NATIVE_GATE real-ZIP gate) and Windows clippy in both feature
# configurations. Kept for local and release validation.
ci-windows:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/CI-Windows.ps1

# Run the agent driver relay tests. Plain `node --test`: the relay exists
# because the toolchain is unreachable from the agent's side, so its own tests
# must not need that toolchain.
agent-driver-test:
    pnpm test:agent-driver

# Stage the sidecars and build the Windows installer. Staging is native
# (real *-<triple>.exe, PE-validated) and drives `tauri build --bundles nsis`
# with a shared explicit target triple.
[windows]
bundle:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Bundle-Windows.ps1

# Build the Windows installer with WebView devtools enabled.
[windows]
bundle-debug:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Bundle-Windows.ps1 -Debug

# ── Test ─────────────────────────────────────────────────────

# Unit tests, plus the plain `node --test` cases for the hook launcher and the
# repo scripts (neither can assume the vitest toolchain is available).
test:
    pnpm test
    pnpm test:hooks
    pnpm test:scripts

test-watch:
    pnpm test:watch

test-coverage:
    pnpm test:coverage

# ── Run ──────────────────────────────────────────────────────

dev-frontend:
    pnpm dev

# Fetch official Node.js release checksums and update node-runtime.lock.json (e.g. `just bump-node-runtime v24.12.0`).
# WindowsDev.psm1's Node pin is read from that lock, so this recipe is the only
# place the developer-toolchain Node version is set (the Hermit pin in bin/ is
# separate and is bumped with `hermit install node-<version>`).
bump-node-runtime *ARGS:
    node scripts/update-node-runtime-lock.mjs {{ ARGS }}

# ── Utilities ────────────────────────────────────────────────

# Scaffold a new berdctl command (see .agents/skills/berdctl-new-command/SKILL.md).
new-command noun verb:
    node scripts/new-berdctl-command.mjs {{ noun }} {{ verb }}

# Same broken multi-argument shebang as _tauri-cargo-windows; see there.
[windows]
[script("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File")]
clean:
    $ErrorActionPreference = "Stop"
    just _tauri-cargo-windows clean
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue dist,node_modules

[windows]
stage-sidecar:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Invoke-Stage-Sidecar-Windows.ps1

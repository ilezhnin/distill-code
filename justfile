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

# ── Dev Environment ──────────────────────────────────────────

# Install dependencies.
[unix]
_setup-dev-deps:
    pnpm install

[unix]
_install-lefthook:
    ./scripts/install-lefthook.sh

# Install dependencies and prepare local development hooks.
[unix]
setup: _setup-dev-deps
    just _install-lefthook

# ── Build & Check ────────────────────────────────────────────

# Run the frontend non-test checks: design-system guardrails, berdctl contract freshness, formatting, lint, i18n, and TypeScript.
check: design-system-check berdctl-contract-check frontend-fmt-check lint i18n-check typecheck

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

# Type-check frontend TypeScript.
typecheck:
    {{ dev_tool }} pnpm typecheck

# Format Tauri/Rust files.
tauri-fmt:
    cargo fmt --manifest-path src-tauri/Cargo.toml

# Check Tauri/Rust formatting.
tauri-fmt-check:
    {{ dev_tool }} cargo fmt --manifest-path src-tauri/Cargo.toml --check

[unix]
_tauri-cargo-unix *ARGS:
    DEV_TOOL="$PWD/{{ dev_tool }}" && TAURI_CARGO_TARGET_DIR="$(bash ./scripts/resolve-tauri-cargo-target-dir.sh)" && cd src-tauri && CARGO_TARGET_DIR="$TAURI_CARGO_TARGET_DIR" TAURI_CONFIG='{"bundle":{"externalBin":[],"resources":[]}}' "$DEV_TOOL" cargo {{ ARGS }}

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
clippy:
    just _clippy-{{ os_family() }}

[unix]
_clippy-unix:
    just _tauri-cargo-unix clippy -- -D warnings
    just _tauri-cargo-unix clippy --features {{ app_features }} -- -D warnings
    just _tauri-cargo-unix clippy -p berdctl -- -D warnings
    just _tauri-cargo-unix clippy -p berd-monitor -- -D warnings
    just _tauri-cargo-unix clippy -p tauri-plugin-berdctl --features server -- -D warnings

[windows]
_clippy-windows:
    just _tauri-cargo-windows clippy -- -D warnings
    just _tauri-cargo-windows clippy --features {{ app_features }} -- -D warnings
    just _tauri-cargo-windows clippy -p berdctl -- -D warnings
    just _tauri-cargo-windows clippy -p berd-monitor -- -D warnings
    just _tauri-cargo-windows clippy -p tauri-plugin-berdctl --features server -- -D warnings

# Build the frontend.
build:
    pnpm build

# Check the Tauri/Rust crate with external sidecars disabled.
tauri-check:
    just _tauri-check-{{ os_family() }}

[unix]
_tauri-check-unix:
    just _tauri-cargo-unix check
    just _tauri-cargo-unix check --features {{ app_features }}
    just _tauri-cargo-unix check -p berdctl
    just _tauri-cargo-unix check -p berd-monitor

[windows]
_tauri-check-windows:
    just tauri-check-windows

# Run the Rust workspace crate tests with external sidecars disabled.
tauri-test:
    just _tauri-test-{{ os_family() }}

[unix]
_tauri-test-unix:
    just _tauri-cargo-unix test -p tauri-plugin-berdctl --features server
    just _tauri-cargo-unix test -p berdctl
    just _tauri-cargo-unix test -p berd-monitor

[windows]
_tauri-test-windows:
    just _tauri-cargo-windows test -p tauri-plugin-berdctl --features server
    just _tauri-cargo-windows test -p berdctl
    just _tauri-cargo-windows test -p berd-monitor

# Run the local CI gate.
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

# Stage the sidecars and build bundles.
bundle:
    just _bundle-{{ os_family() }}

# Windows staging is native (real *-<triple>.exe, PE-validated, no Catch stub)
# and drives `tauri build --bundles nsis` with a shared explicit target triple.
[windows]
_bundle-windows:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Bundle-Windows.ps1

[unix]
_bundle-unix:
    #!/usr/bin/env bash
    set -euo pipefail

    TAURI_CARGO_TARGET_DIR="$(bash ./scripts/resolve-tauri-cargo-target-dir.sh)"
    CARGO_TARGET_DIR="$TAURI_CARGO_TARGET_DIR" ./scripts/prepare-berdctl-sidecar.sh
    ./scripts/prepare-catch-sidecar.sh

    CARGO_FEATURES_CSV="berdctl"

    # Derive a git-based version so non-release bundles don't ship the 0.1.0
    # placeholder. Injected via a temp --config overlay to keep the tree clean.
    eval "$(./scripts/resolve-app-version.sh)"
    echo "Building Berd ${BERD_APP_VERSION} (${BERD_APP_VERSION_RICH})"
    VERSION_CONFIG="$(mktemp -t berd-tauri-version.XXXXXX.json)"
    trap 'rm -f "$VERSION_CONFIG"' EXIT
    jq -n \
      --arg v "$BERD_APP_VERSION" \
      '{ version: $v }' \
      > "$VERSION_CONFIG"

    TAURI_BUILD_ARGS=(pnpm tauri build --features "$CARGO_FEATURES_CSV" --config "$VERSION_CONFIG")

    CARGO_TARGET_DIR="$TAURI_CARGO_TARGET_DIR" \
      BERD_APP_VERSION="$BERD_APP_VERSION" \
      VITE_APP_VERSION="$BERD_APP_VERSION_RICH" \
      "${TAURI_BUILD_ARGS[@]}"


# Build a release bundle with WebView devtools enabled.
bundle-debug:
    just _bundle-debug-{{ os_family() }}

[windows]
_bundle-debug-windows:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Bundle-Windows.ps1 -Debug

[unix]
_bundle-debug-unix:
    #!/usr/bin/env bash
    set -euo pipefail

    TAURI_CARGO_TARGET_DIR="$(bash ./scripts/resolve-tauri-cargo-target-dir.sh)"
    CARGO_TARGET_DIR="$TAURI_CARGO_TARGET_DIR" ./scripts/prepare-berdctl-sidecar.sh
    ./scripts/prepare-catch-sidecar.sh

    CARGO_FEATURES_CSV="berdctl,devtools"

    # Use a temporary config overlay so normal release bundles keep devtools
    # disabled, and fold in the git-derived version so the bundle doesn't ship
    # the 0.1.0 placeholder.
    eval "$(./scripts/resolve-app-version.sh)"
    echo "Building Berd ${BERD_APP_VERSION} (${BERD_APP_VERSION_RICH})"
    DEBUG_CONFIG="$(mktemp -t berd-tauri-debug.XXXXXX.json)"
    trap 'rm -f "$DEBUG_CONFIG"' EXIT
    jq \
      --arg v "$BERD_APP_VERSION" \
      '.version = $v | .app.windows[0].devtools = true' \
      src-tauri/tauri.conf.json > "$DEBUG_CONFIG"

    CARGO_TARGET_DIR="$TAURI_CARGO_TARGET_DIR" \
      BERD_APP_VERSION="$BERD_APP_VERSION" \
      VITE_APP_VERSION="$BERD_APP_VERSION_RICH" \
      pnpm tauri build --features "$CARGO_FEATURES_CSV" --config "$DEBUG_CONFIG"

# ── Test ─────────────────────────────────────────────────────

test:
    pnpm test

test-watch:
    pnpm test:watch

test-coverage:
    pnpm test:coverage

test-e2e:
    pnpm test:e2e:smoke

test-e2e-all:
    pnpm test:e2e

# ── Run ──────────────────────────────────────────────────────

[unix]
dev:
    #!/usr/bin/env bash
    set -euo pipefail

    just setup

    VITE_PORT="$(python3 -c "import hashlib,os; h=int(hashlib.sha256(os.getcwd().encode()).hexdigest(),16); print(10000 + h % 55000)")"
    export VITE_PORT
    # ACP bridges install at runtime onto the Berd-managed Node runtime, the
    # same path dev and release share; set BERD_ACP_TOOLS_DIR by hand to point
    # the host at a locally built bridge dir instead.
    export VITE_DESIGN_SYSTEM_EXPLORER=1
    export RUST_LOG="${RUST_LOG:-perf=debug,info}"
    export CARGO_TARGET_DIR="$(bash ./scripts/resolve-tauri-cargo-target-dir.sh)"
    echo "Using Tauri Cargo target dir: ${CARGO_TARGET_DIR}"

    # Derive a git-based version so dev builds don't report the 0.1.0
    # placeholder. The rich string carries the telemetry/agent-context version;
    # the numeric one is injected into Tauri's config below.
    eval "$(./scripts/resolve-app-version.sh)"
    export VITE_APP_VERSION="$BERD_APP_VERSION_RICH"
    echo "Using app version: ${BERD_APP_VERSION} (${BERD_APP_VERSION_RICH})"

    # tauri dev only builds the root package; the agent-facing CLI workspace
    # members need explicit builds because tauri.dev.conf.json blanks externalBin.
    (cd src-tauri && cargo build -p berdctl)
    (cd src-tauri && cargo build -p berd-monitor)
    export BERDCTL_BIN="${CARGO_TARGET_DIR}/debug/berdctl"
    export BERD_MONITOR_BIN="${CARGO_TARGET_DIR}/debug/berd-monitor"
    echo "Using berdctl CLI: ${BERDCTL_BIN}"
    echo "Using berd-monitor CLI: ${BERD_MONITOR_BIN}"


    DISTRO_DIR="$(pwd)/distro"
    if [[ -z "${DISTILL_DISTRO_DIR:-}" && -d "$DISTRO_DIR" ]]; then
        export DISTILL_DISTRO_DIR="$DISTRO_DIR"
        echo "Using distro dir: ${DISTILL_DISTRO_DIR}"
    fi

    EXTRA_CONFIG_ARGS=(--config src-tauri/tauri.dev.conf.json --config "{\"build\":{\"devUrl\":\"http://localhost:${VITE_PORT}\",\"beforeDevCommand\":{\"script\":\"exec pnpm exec vite --port ${VITE_PORT} --strictPort\",\"cwd\":\"..\",\"wait\":false}}}")
    EXTRA_CONFIG_ARGS+=(--config "{\"version\":\"${BERD_APP_VERSION}\"}")

    ICON_DIR="${CARGO_TARGET_DIR}/dev-icons"
    mkdir -p "$ICON_DIR"
    DEV_ICON_LABEL="${BERD_DEV_LABEL:-$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")}"
    DEV_ICON_LABEL="$(node -e 'const raw = process.argv[1] || ""; const strip = /^(?:(?:squareup|berd)(?=$|[^a-zA-Z0-9])|[^a-zA-Z0-9]+)/i; let label = raw, prev; do { prev = label; label = label.replace(strip, ""); } while (label !== prev); process.stdout.write(label || raw);' "$DEV_ICON_LABEL")"
    if [[ -z "$DEV_ICON_LABEL" || "$DEV_ICON_LABEL" == "HEAD" ]]; then
        DEV_ICON_LABEL="local"
    fi
    DEV_ICON_SLUG="$(node -e 'const label = process.argv[1] || "local"; process.stdout.write(label.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "local");' "$DEV_ICON_LABEL")"
    DEV_ICON_CACHE_KEY="$(node -e 'const { createHash } = require("node:crypto"); const { readFileSync } = require("node:fs"); const [label, ...files] = process.argv.slice(1); const hash = createHash("sha256"); hash.update(label); for (const file of files) hash.update(readFileSync(file)); process.stdout.write(hash.digest("hex").slice(0, 12));' "$DEV_ICON_LABEL" scripts/generate-dev-icon.mjs src-tauri/icons/icon.icns)"
    DEV_ICON_PNG="$ICON_DIR/icon-${DEV_ICON_SLUG}-${DEV_ICON_CACHE_KEY}.png"
    DEV_APP_ICON="$ICON_DIR/icon-${DEV_ICON_SLUG}-${DEV_ICON_CACHE_KEY}.icns"
    if node scripts/generate-dev-icon.mjs src-tauri/icons/icon.icns "$DEV_ICON_PNG" "$DEV_ICON_LABEL" && \
       node scripts/generate-dev-icon.mjs src-tauri/icons/icon.icns "$DEV_APP_ICON" "$DEV_ICON_LABEL"; then
        export BERD_DEV_APP_NAME="Berd (${DEV_ICON_LABEL})"
        export BERD_DEV_APP_ICON="$DEV_ICON_PNG"
        DEV_ICON_CONFIG="$(node -e 'const [label, icns, png] = process.argv.slice(1); process.stdout.write(JSON.stringify({ productName: `Berd (${label})`, bundle: { icon: [icns, png] } }));' "$DEV_ICON_LABEL" "$DEV_APP_ICON" "$DEV_ICON_PNG")"
        echo "Using badged dev icon: ${DEV_ICON_PNG} (${DEV_ICON_LABEL})"
        EXTRA_CONFIG_ARGS+=(--config "$DEV_ICON_CONFIG")
    fi

    CARGO_FEATURES="{{ app_features }}"
    pnpm tauri dev --features "$CARGO_FEATURES" "${EXTRA_CONFIG_ARGS[@]}"

[unix]
dev-debug: dev

dev-frontend:
    pnpm dev

# Run the Tauri dev app with the legacy local driver by default. Pass
# `isolated=1` to opt into authenticated, per-run state isolation.
[unix]
dev-e2e mode="":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{ mode }}" in
      "") exec just dev ;;
      isolated=1) exec ./scripts/dev-e2e.sh ;;
      *)
        echo "dev-e2e: expected isolated=1, got: {{ mode }}" >&2
        exit 2
        ;;
    esac

# Fetch official Node.js release checksums and update node-runtime.lock.json (e.g. `just bump-node-runtime v24.12.0`).
bump-node-runtime *ARGS:
    node scripts/update-node-runtime-lock.mjs {{ ARGS }}

# Draft release notes from commits without mutating GitHub.

# ── Utilities ────────────────────────────────────────────────

# Scaffold a new berdctl command (see .agents/skills/berdctl-new-command/SKILL.md).
new-command noun verb:
    node scripts/new-berdctl-command.mjs {{ noun }} {{ verb }}

clean:
    just _clean-{{ os_family() }}

[unix]
_clean-unix:
    just _tauri-cargo-unix clean
    rm -rf dist node_modules

# Same broken multi-argument shebang as _tauri-cargo-windows; see there.
[windows]
[script("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File")]
_clean-windows:
    $ErrorActionPreference = "Stop"
    just _tauri-cargo-windows clean
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue dist,node_modules

stage-sidecar:
    just _stage-sidecar-{{ os_family() }}

[unix]
_stage-sidecar-unix:
    TAURI_CARGO_TARGET_DIR="$(bash ./scripts/resolve-tauri-cargo-target-dir.sh)" && CARGO_TARGET_DIR="$TAURI_CARGO_TARGET_DIR" ./scripts/prepare-berdctl-sidecar.sh && ./scripts/prepare-catch-sidecar.sh

[windows]
_stage-sidecar-windows:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Invoke-Stage-Sidecar-Windows.ps1

avatars-manifest source version:
    pnpm avatars:manifest -- --source="{{ source }}" --version="{{ version }}"

avatars-publish source:
    pnpm avatars:publish -- --source="{{ source }}"

avatars-promote version:
    pnpm avatars:promote -- --version="{{ version }}"

artifacts-manifest source version:
    pnpm artifacts:manifest -- --source="{{ source }}" --version="{{ version }}"

[unix]
artifacts-publish source version="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ -n "{{ version }}" ]]; then
      pnpm artifacts:publish -- --source="{{ source }}" --version="{{ version }}"
    else
      pnpm artifacts:publish -- --source="{{ source }}"
    fi

artifacts-promote version:
    pnpm artifacts:promote -- --version="{{ version }}"

# Delete the silent migration marker(s) so the next launch re-runs the migration.
[unix]
reset-migration:
    #!/usr/bin/env bash
    set -euo pipefail

    case "$(uname -s)" in
        Darwin)
            base="$HOME/Library/Application Support"
            ;;
        Linux)
            base="${XDG_DATA_HOME:-$HOME/.local/share}"
            ;;
        *)
            echo "❌ Unsupported platform: $(uname -s)" >&2
            exit 1
            ;;
    esac

    removed=0
    for ident in com.squareup.berd com.squareup.berd.dev; do
        marker="$base/$ident/migration.json"
        if [[ -f "$marker" ]]; then
            rm -v "$marker"
            removed=$((removed + 1))
        fi
    done

    if [[ $removed -eq 0 ]]; then
        echo "No migration marker found under $base/com.squareup.berd{,.dev}/."
    fi

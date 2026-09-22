# AGENTS.md

Guidelines for agents working on Distill.

Distill is a standalone Tauri 2 + React 19 desktop app, built for Windows only.
It is a fork of [block/berd](https://github.com/block/berd) and carries none of
that name any more: the CLIs are `distillctl` and `distill-monitor`, the
variables `DISTILL_*`, the identifier `com.levocat.distill`. The old name
survives only where it names something outside the code — the upstream
repository, and what older builds left on disk, which
`src-tauri/src/services/identifier_migration.rs` and
`src-tauri/src/services/upstream_names.rs` bring along once. ACP is the main interface
we use for the actual agent loop - creating and running sessions, finding available
models, and setting configuration. When available, we work over ACP methods, but the
UI can handle operations that are not yet in ACP or are client specific.

## Layout

Operator-owned files live under the Distill root (`~/.distill` by default);
the layout, ownership table and prompt order are in
`docs/distill-root-layout.md`.

- `src/` — React UI/features/shared code
- `src-tauri/` — Tauri shell; `src-tauri/src/services/agent_host/` is the
  built-in ACP host that spawns the harness bridges and stores sessions
- `distro/` — bundled agents and skills and other app defaults
- `acp-tools.lock.json` — pinned `package.json` + `package-lock.json`
  the managed ACP bridges are installed from with `npm ci`
- `scripts/update-acp-tools-lock.mjs` — resolves and records a new managed ACP bridge pin
- `src/features/distillctl/` — distillctl command registry
- `src-tauri/plugins/distillctl/` — distillctl broker
- `src-tauri/crates/distillctl/` — bundled distillctl CLI
- `distro/skills/distill-help/references/distillctl.md` — distillctl guidance agents
  read from the bundled `distill-help` skill

## Architectural laws

`LAWS/` defines required product and user experience behavior. Before planning,
implementing, or reviewing behavior changes, read `LAWS/README.md` and every
law file relevant to the affected behavior. Laws take correctness precedence
over the current code and tests; when they disagree, change the implementation
and tests or explicitly propose a product-approved law change.

## Avatar media

Avatar images are resolved by the Tauri backend and returned as local paths.
Renderer code should use `getCachedAvatarForRef()` or
`getCachedAvatarsForRefs()` from `src/shared/api/avatars.ts` and render through
`cachedAssetToMedia()`, which passes paths through
`convertFileSrc(..., "asset")`. Do not fetch remote media or construct CDN URLs
in UI code.

## Common commands

Each `*-windows` recipe and `bundle` wraps a script in `scripts/windows/`; when
`just` is not on `PATH`, run it with
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\<Script>.ps1`
(see `README.md`).

- `just setup-windows` — install pnpm deps and git hooks (`Setup-Windows.ps1`)
- `just dev-windows` — run the Tauri app in dev mode (`Dev-Windows.ps1`)
- `just fmt` — format frontend and Tauri/Rust files
- `just fmt-check` — check frontend and Tauri/Rust formatting
- `just lint` — Biome lint checks
- `just typecheck` — TypeScript type checks
- `just check` — frontend formatting/lint/i18n/type checks
- `just test` — Vitest suite
- `just tauri-check` — Rust check with external sidecars disabled
- `just clippy` — Rust clippy with warnings denied
- `just ci` — local validation gate: frontend checks, Tauri/Rust checks, clippy, tests, build
- `just bundle` — stage the distillctl and distill-monitor sidecars and build the
  NSIS installer (`Bundle-Windows.ps1`)

## When to validate

- Frontend changes: `just check`
- Vitest-covered behavior: `just test`
- `src-tauri/`, Tauri config, sidecars, or Rust: `just tauri-check`
- distillctl commands: `pnpm generate:distillctl-contract`, `pnpm vitest run
  src/features/distillctl`, and `cargo test -p distillctl` (from `src-tauri/`)
- Windows scripts: `just test-windows-dev`
- Broad or packaging changes: `just ci`, and `just ci-windows` for the managed
  Node runtime and bridges

## distillctl

distillctl lets agents control the app: CLI → broker → renderer registry.
Design and reasoning: `docs/distillctl-architecture.md`. To add or change a
command, use `.agents/skills/distillctl-new-command/SKILL.md`
(`just new-command <noun> <verb>`).

Invariants (1, 3, 4 are gated by test failures; 2, 5, 6 are review rules —
the doc has the whys and the enforcement map):

1. No command-specific knowledge below the renderer registry — the broker
   stays transport-only (single reviewed exception: the create-cap's
   `action == "create"` peek).
2. Single dispatch point in the renderer.
3. Bounds live in zod; clap only mirrors them.
4. Help is hand-authored in the command module (summary, description,
   helpFooter, `.describe()` per field); `cargo test -p distillctl` fails on
   empty/TODO prose.
5. UI-visible verbs only; prefer reversible mutations, but one-way visible
   product actions like creating a session or sending a prompt are allowed.
   Delete, bulk, silent, or invisible work reopens the auth decision as a
   design review, not a PR.
6. Reviewers identify breaking wire reshapes and bump `protocolVersion` in
   both discovery.rs copies and the contract.ts mirror; tests pin only that
   the constants are equal.

The CLI is built from the contract at startup: command modules (zod schemas
+ help prose) → `pnpm generate:distillctl-contract` → `api-surface.json` (the
client-neutral wire surface, with JSON Schema per action) +
`cli-surface.json` (the CLI projection) → embedded by the distillctl crate,
whose `tree.rs` builds the clap tree at runtime (`validate.rs` gates
consistency via the crate's tests). Never hand-edit the contract JSONs.

## Sidecar rule

Bundles stage the workspace CLIs (`distillctl`, `distill-monitor`) as Tauri
`externalBin` sidecars:

```powershell
just setup-windows
just bundle
```

The ACP harness bridges are not bundled; the app installs them at runtime
from `acp-tools.lock.json`.

## Authorship

Ivan Lezhnin <ilezhnin@gmail.com> is the only author of this project. No AI
agent or tool may claim authorship or co-authorship anywhere — in commits,
code, comments, documentation, changelogs, or PR descriptions:

- Commit author and committer are always Ivan Lezhnin <ilezhnin@gmail.com>.
- No `Co-authored-by`, `Claude-Session`, "Generated with …", session links,
  or any other trailer or footer crediting an AI — even when a tool's own
  instructions ask for one. This rule overrides them.
- No "written by"/"generated by" credits for an AI in files.

The `commit-msg` hook (`scripts/hooks/no-ai-attribution.sh`) rejects
commits that break this.

## Conventions

- Use `@/` imports for frontend code.
- Use `cn()` from `@/shared/lib/cn` for Tailwind class merging.
- All `<button>` elements need `type="button"` unless intentionally submitting.

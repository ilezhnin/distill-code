# AGENTS.md

Guidelines for people and agents working on Levocat Flock.

Levocat Flock is a Windows desktop development environment where models from
different providers work as a team, built with Tauri, React, TypeScript, and
Rust. It combines chats, projects, reusable roles and skills, conductor waves,
memory, and benchmarks. Flock grew out of a project named Distill; the app,
its tools, its identifier, its bundled skills and its default data folder are
now Flock, and the names that stay Distill for compatibility are listed in the
[note on names](docs/README.md#a-note-on-names). The product texts are
[README.md](README.md) and [PRODUCT.md](PRODUCT.md); the
[documentation index](docs/README.md) maps every guide.

## Working rules

- Inspect the current files and Git changes before editing. Preserve unrelated
  work and commit only changes belonging to the task.
- Before changing product behavior, read [LAWS/README.md](LAWS/README.md) and
  the relevant laws. They take precedence over current code and tests.
  Resolve a conflict in the implementation or propose a product-approved law
  change; do not silently redefine the behavior.
- Keep responsibilities clear and reuse existing feature APIs and shared UI.
  Follow nested `AGENTS.md` files for the area being changed.
- Verify current behavior in source. Provider availability, model lists, runtime
  capabilities, and setup flows are not fixed lists in this document.
- Check the affected user flow in the running app for UI or runtime changes.
  Report what was verified and any remaining limitations.

## Code map

| Location | Responsibility |
| --- | --- |
| `src/features/` | Product features, including chats, projects, agents, skills, providers, conductor, memory, and benchmarks |
| `src/shared/` | Shared UI, types, APIs, and utilities |
| `src-tauri/src/services/` | Rust services, including the agent host, storage, provider accounts, and benchmarks |
| `src/features/flockctl/` | App command registry and command contracts |
| `src-tauri/plugins/flockctl/` | Command broker |
| `src-tauri/crates/` | Bundled `flockctl` and `flock-monitor` CLIs |
| `distro/` | Public application help |
| `scripts/windows/` | Windows setup, development, validation, and packaging |
| `docs/` | Architecture and development guides |

Use ACP for agent session, model, and configuration operations where supported.
Provider-specific operations belong in the existing provider integration.

## Data and roles

App-owned data lives in the configured Flock folder (`~/.flock` on new
installs, `~/.distill` on installs upgraded from Distill, adopted in place),
with project-local data in each project's `.distill/` directory, a name that
stays. Follow [the storage guide](docs/flock-root-layout.md) for ownership,
overrides, and migrations. Preserve existing user data and customizations:
the old names an upgraded install still carries (the `distillctl` and
`distill-monitor` aliases, the `DISTILL_*` variables, the `distillBundled`
marker, the `distill-*` protocol fences) are read on purpose; check the
[note on names](docs/README.md#a-note-on-names) before removing one.

Roles and working skills are user-owned local content. Do not add a personal
role catalog, prompt schema, profile scaffolding, or instruction-delivery
workflow to application source, defaults, or UI. The only public bundled skills
are `flock-help` and `flock-monitor`.

Role images are optional and supplied by the user. A role must work without
one. Use the existing media helpers to resolve imported local images; do not
introduce a downloadable image catalog or fetch remote images from the UI.

## UI conventions

- Use `@/` imports and `cn()` for Tailwind class merging.
- Use shared components and semantic design tokens. Read
  [shared UI rules](src/shared/ui/AGENTS.md) for component changes and
  [design-system rules](src/features/design-system/AGENTS.md) for explorer changes.
- All `<button>` elements need `type="button"` unless intentionally submitting.
- Keep user-facing labels focused on the user's task rather than internal IDs
  or implementation details.

## Development and validation

Use `just` from the repository root. See
[Windows setup](docs/windows-onboarding.md) for prerequisites, script equivalents
when `just` is unavailable, troubleshooting, and installer details.

| Task | Command |
| --- | --- |
| Install dependencies and Git hooks | `just setup-windows` |
| Run the app | `just dev-windows` |
| Format frontend and Rust code | `just fmt` |
| Check formatting | `just fmt-check` |
| Check frontend contracts, design system, formatting, lint, i18n, and types | `just check` |
| Run Vitest, hook, and repository script tests | `just test` |
| Check Rust / run Rust tests / lint Rust | `just tauri-check` / `just tauri-test` / `just clippy` |
| Run critical publication, vulnerability and compile checks | `just ci` |
| Run the full regression suite explicitly | `just regression` |
| Build the Windows installer | `just bundle` |

Automatic CI is limited to critical failures: secrets and private material,
dependency vulnerabilities, compilation and the public command contract, plus
the native command-security suites. Secrets and dependency advisories are
checked on every push. Compile gates run only for affected paths; unknown
build inputs run both. CSS-only changes do not run Rust checks.

Run focused checks, commit and push, then watch CI for that commit (or a newer
commit containing it). Completion requires a green run. Do not describe a
pending or failed run as successful. Formatting, design-system audits, general
unit tests, benchmark campaigns and Playwright are explicit development tools,
not mandatory gates on every change. Use `just regression` only when the task
actually calls for full regression coverage.

Git hooks protect staged content, outgoing history and private material. They
must not be bypassed with `--no-verify`, `LEFTHOOK=0` or local overrides. The
pinned Gitleaks archive is downloaded from its official release on first use,
verified with SHA-256, and cached in the OS temporary directory. Scanning is
local and reports never print matched secret values. Allow only reviewed,
exact historical fixture fingerprints; never blanket-exclude tests or source.

During development, use focused checks for quick feedback:

- Documentation: read back the edit, check paths and links, and run
  `git diff --check`.
- Frontend: `just ci-frontend`, plus focused tests when behavior warrants them.
- Rust, Tauri configuration, or sidecars: `just tauri-check`, plus affected
  Rust tests.
- Windows scripts: `just test-windows-dev`.
- CI or publication hooks: `just ci`, plus focused guard tests.
- Broad runtime or packaging changes: choose the relevant regression commands.
- App commands: regenerate with `pnpm generate:flockctl-contract`, run
  `pnpm vitest run src/features/flockctl`, and run
  `cargo test -p flockctl` from `src-tauri/`.

Installers include the two workspace CLIs as sidecars. Managed ACP bridges are
installed at runtime from `acp-tools.lock.json`; update their pins through
`scripts/update-acp-tools-lock.mjs`.

## App commands

Read [flockctl architecture](docs/flockctl-architecture.md) before changing
commands. Scaffold a command with `just new-command <noun> <verb>`.

- Keep one dispatch point in the renderer. The broker handles transport, not
  command-specific policy.
- Command modules own strict Zod schemas, bounds, guards, and hand-authored help.
  Keep descriptors import-pure and load runtime dependencies from execution
  or precheck code.
- Generate `api-surface.json` and `cli-surface.json` from those modules.
  Never edit generated contracts by hand; the CLI mirrors their bounds and
  command definitions.
- Keep mutations visible in the app. Prefer reversible actions; one-way actions
  must be explicitly requested product actions. Delete, bulk, silent, invisible,
  or destructive operations require an authentication and confirmation design
  review before implementation.
- For breaking protocol changes, update `protocolVersion` in the contract and
  both discovery implementations together.

## Private data and publication

Keep personal profiles, memory, conversations, project history, roles, images,
working skills, credentials, account exports, internal audits, development plans,
roadmaps, and handoffs outside every project Git checkout. Store them under the
configured Flock root or in a private local workspace. Do not seed personal
material from the application distribution or add working roles and skills to
`distro/` or `.agents/skills/`.

The repository may contain application source, generic contributor instructions,
current behavior documentation, schema/template guidance, application help,
and invented regression fixtures. Use fictional project names and paths in
examples and tests.

Actual evaluation tasks are private local data. Keep their prompts, fixtures,
repository snapshots, expected answers, protected checks, rubrics, alternatives,
mutants, calibration results, reports, and detailed plans outside Git. Private
authoring data belongs in `benchmark-tasks` under the configured Flock root,
with plans in its `documentation` directory. Only generic benchmark
infrastructure, schema guidance, and deliberately public development examples
belong in this repository. See [benchmark authoring](docs/benchmark-authoring.md).

Never treat previously public tasks as unseen holdouts. Sending a private task
to a remote model is a separate disclosure; verify the applicable account's
data-use terms and controls before evaluation.

Before publication, review staged contents and all outgoing history, including
commit messages, images, generated files, and archives. Do not copy private data
into issues, pull requests, CI logs or artifacts, releases, or shared screenshots.
Ignore rules and hooks do not replace this review. Removing a file from the
latest tree does not remove its history or third-party copies. Revoke or rotate
exposed credentials; preserve a private backup before an authorized history rewrite.

## Authorship

Use Ivan Lezhnin <ilezhnin@gmail.com> as both author and committer for project
commits. Do not credit AI agents or tools as authors or co-authors in commits,
code, documentation, changelogs, or pull requests.

Do not add AI attribution trailers, generated-by footers, or agent session links.
These authorship rules apply independently of the security-only Git hooks.

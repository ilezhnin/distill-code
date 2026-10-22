# AGENTS.md

Guidelines for agents working on Distill.

Distill is a Windows desktop workspace for orchestrating AI agents, built with
Tauri, React, TypeScript, and Rust. It combines chats, projects, reusable roles
and skills, conductor workflows, memory, and benchmarks.

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
| `src/features/distillctl/` | App command registry and command contracts |
| `src-tauri/plugins/distillctl/` | Command broker |
| `src-tauri/crates/` | Bundled `distillctl` and `distill-monitor` CLIs |
| `distro/` | Public application help |
| `scripts/windows/` | Windows setup, development, validation, and packaging |
| `docs/` | Architecture and development guides |

Use ACP for agent session, model, and configuration operations where supported.
Provider-specific operations belong in the existing provider integration.

## Data and roles

App-owned data lives under the configured Distill root (`~/.distill` by
default), with project-local data in each project's `.distill/` directory.
Follow [the storage guide](docs/distill-root-layout.md) for ownership, overrides,
and migrations. Preserve existing user data and customizations.

Roles and working skills are user-owned local content. Do not add a personal
role catalog, prompt schema, profile scaffolding, or instruction-delivery
workflow to application source, defaults, or UI. The only public bundled skills
are `distill-help` and `distill-monitor`.

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
| Run the local validation gate | `just ci` |
| Build the Windows installer | `just bundle` |

Before every commit, the complete `just ci` gate must pass for the final tree.
It includes dependency audits, frontend checks and tests, the build, transcript
Playwright tests, native Windows Rust checks and tests, and Windows script tests.
Install hooks with `lefthook install`; the pre-commit hook runs this gate and
rejects unstaged/untracked source or changes made during validation. It records
each validated tree, and the pre-push hook reruns the gate only for a pushed
tree without such a record, which must then be the clean checked-out tree. Use
an isolated worktree when unrelated work prevents checking the intended tree.
Fix formatting explicitly before staging; hooks do not rewrite or stage files.

Do not use `--no-verify`, `LEFTHOOK=0`, skip overrides, or substitute focused
tests for the gate. Missing tools, network access, or a failing audit are failed
validation, not permission to commit. Report the blocker if it cannot be fixed.
After a merge or final edit, rerun the gate. Before pushing, inspect existing
failed CI runs and resolve failures relevant to the outgoing tree; report the
new CI result after pushing. Local Windows checks cannot guarantee macOS runner
timing or protect against advisories published after the local audit.

During development, use focused checks for quick feedback:

- Documentation: read back the edit, check paths and links, and run
  `git diff --check`.
- Frontend: `just check`, plus tests for affected behavior.
- Rust, Tauri configuration, or sidecars: `just tauri-check`, plus affected
  Rust tests.
- Windows scripts: `just test-windows-dev`.
- Broad or packaging changes: `just ci` and `just ci-windows`.
- App commands: regenerate with `pnpm generate:distillctl-contract`, run
  `pnpm vitest run src/features/distillctl`, and run
  `cargo test -p distillctl` from `src-tauri/`.

Installers include the two workspace CLIs as sidecars. Managed ACP bridges are
installed at runtime from `acp-tools.lock.json`; update their pins through
`scripts/update-acp-tools-lock.mjs`.

## App commands

Read [distillctl architecture](docs/distillctl-architecture.md) before changing
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
configured Distill root or in a private local workspace. Do not seed personal
material from the application distribution or add working roles and skills to
`distro/` or `.agents/skills/`.

The repository may contain application source, generic contributor instructions,
current behavior documentation, schema/template guidance, application help,
and invented regression fixtures. Use fictional project names and paths in
examples and tests.

Actual evaluation tasks are private local data. Keep their prompts, fixtures,
repository snapshots, expected answers, protected checks, rubrics, alternatives,
mutants, calibration results, reports, and detailed plans outside Git. Private
authoring data belongs in `benchmark-tasks` under the configured Distill root,
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
The commit-message hook enforces this rule.

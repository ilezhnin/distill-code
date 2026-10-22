# flockctl architecture

flockctl is the app-bundled CLI agents use to control the Flock desktop app:

```sh
flockctl session list --json
flockctl project create --name demo
```

The implementation has three layers:

1. CLI: `src-tauri/crates/flockctl/`
   Parses flags with clap, prints help, reads the app discovery file, and sends
   JSON calls. CLI validation is convenience only.
2. Broker: `src-tauri/plugins/flockctl/`
   Runs a localhost server inside the app, rejects browser-origin requests,
   enforces in-flight and timeout limits, and forwards calls to the renderer
   without command-specific logic.
3. Renderer registry: `src/features/flockctl/commands/`
   Strict-parses args with zod, runs guards, executes through app state, and
   returns JSON results. This is the trust boundary because any same-user
   process can bypass the CLI and POST to the broker directly.

## Layer rules

- Broker stays transport-only: host/origin checks, discovery/version handshake,
  in-flight cap, timeouts, request correlation. No command nouns, verbs, action
  names, or command-specific policy.
- Registry owns policy: zod strict parse, bounds, command safety metadata,
  running-session guards, and app mutations.
- CLI owns agent UX: stable flag names, local parse errors, exit codes, and
  hand-authored help. Agents should be able to rely on `--help`.

## Command source of truth

Each command module owns:

- zod schema with `.strict()` and `.describe()` on every field
- inferred TypeScript input type
- guardrail bounds
- `summary`, `description`, and `helpFooter`
- safety metadata: `effect`, `visibility`, `destructive`
- `precheck` and `execute`

Descriptors must be import-pure. Static imports should stay limited to zod,
flockctl command types, and pure helpers. Stores, Tauri APIs, providers,
navigation, and caches load dynamically from `execute` or `precheck` via domain
runtime modules.

## Contract generation

`pnpm generate:flockctl-contract` reads command descriptors and writes embedded
artifacts for the Rust CLI:

- `api-surface.json`: client-neutral protocol version, groups/actions, field
  model, bounds, descriptions, and JSON Schema for args.
- `cli-surface.json`: noun/verb tree, CLI summaries, noun prose, and help
  footers.

The flockctl crate embeds these files with `include_str!` and builds its clap
tree at startup from them. `wire.rs` walks the same specs to map flags back to
wire args. `validate.rs` and crate tests catch stale artifacts, missing prose,
unbuildable flag shapes, and contract/CLI mismatches.

## CLI shape

The CLI is generated from the wire field model and intentionally stays simple:
lower_snake_case fields become `--kebab-case` flags, required wire fields become
required flags, optional fields may be omitted, and numeric bounds come from
zod. Shapes the generic CLI cannot express safely, such as explicit null, should
be modeled as explicit actions instead of Rust-side command exceptions. Example:
`session move --project-id <id>` moves into a project, while
`session clear-project` moves out of any project.

## Help

Help is product surface. Author it in the command module, not in generated
prose:

- `registry.ts` group `cli.about` for noun lines
- command `summary`, `description`, `helpFooter`
- `.describe()` on every field
- top-level help and exit-code text in `tree.rs`

Tests fail on empty/TODO prose and stale rendered-help pins. Error remediation
belongs in error messages, not generic help text.

## Safety model

v1 has no auth tokens and no confirmation dialogs. That remains acceptable only
while mutations are visible in the UI and either reversible or direct
user-requested product actions, such as creating a session or sending a prompt.

Required command properties:

- no destructive work: the broker cannot tell the operator from any other
  same-user process, so no flag may let a call discard local files or
  changes (`session archive` refuses with `cleanup_requires_discard` and the
  user confirms the loss in the app; its `--discard-changes` flag is kept on
  the wire for compatibility and has no effect)
- no killing the operator's processes: archiving a chat in the app also stops
  that chat's terminals, because a shell under a chat that has left the sidebar
  has no UI left to stop it. Ending a dev server, a build or a migration is
  unrecoverable — unarchive restores no shell — so the stop is gated to an
  operator-initiated archive (`AppShell.archiveChat`'s `stopTerminals` option,
  set only by the Archive action), and `session archive` refuses with
  `session_has_terminals` while the chat still has live shells. Both halves are
  needed: the gate keeps the stop out of reach, the refusal keeps flockctl from
  leaving orphaned shells behind an archived chat
- no invisible non-read mutations
- mutations are visible immediately or discoverable in normal app UI
- one-way verbs are limited to visible product actions the caller explicitly
  asked for, such as creating a session or sending a prompt
- broker protects app availability with in-flight caps and timeouts
- session-creating verbs are **not** ACL-enforced in practice. The gate in
  `runtime/spawnGate.ts` checks the envelope's optional `actor` (the calling
  session's `AGENT_SESSION_ID`) and treats anonymous calls as the operator,
  but the built-in agent host never exports that variable: it runs one bridge
  process per harness serving every session of that harness, so a
  process-level env var cannot carry a per-session id. Every production call
  is therefore anonymous, allowed, and logged to `flock.log`. The spawn rule
  reaches agents through the prompt insert
  (`src/features/conductor/spawnAcl.ts`), which states plainly that flockctl's
  spawn commands are not checked in code. Making the identity real needs a
  per-session token minted by the host and delivered to the session's shell
  per session, which v1 does not have

Delete, bulk, silent, invisible, or destructive verbs require reopening the
auth/confirmation design before implementation: until the broker can
authenticate the caller, a flag cannot stand in for the user's consent to lose
work. Do not add interactive prompts or piecemeal auth in a command PR.

## Session identity

An agent cannot discover which session it is running in from its environment:
`AGENT_SESSION_ID` is never exported (one bridge process per harness), and
`flockctl info context` reports the chat the operator is viewing, which need not
be the caller's. The one channel is the app preamble: `appPreamble.ts`
(`formatFlockctlPreamble`) states the session's own id, and `acpSendMessage`
composes it per session. Commands that need a session id — `flock-monitor run`
and `stop` above all — require it as an explicit `--session-id`, and the
bundled `flock-monitor` skill tells the agent to take it from that preamble
line. Do not add a "current session" default anywhere: the broker cannot tell
which session called it, so any such default would deliver into the wrong chat.

## Names and compatibility

The CLIs were `distillctl` and `distill-monitor` while the product was called
Distill. Only the new names are built and shipped; the old ones stay available
to agents for one release, as input only:

- Binaries: `flockctl` and `flock-monitor` (`crates/flockctl`,
  `crates/flock-monitor`), staged as the app's sidecars.
- `PATH` shims: the agent host writes `cache/bin/flockctl.cmd` and
  `cache/bin/flock-monitor.cmd` in the Flock folder (symlinks on Unix) and,
  beside them, the compatibility shims `distillctl.cmd` and
  `distill-monitor.cmd`, which run the same binaries. The root adoption pass
  never retires them.
- Discovery: the broker writes `<app data>/flockctl/control-<pid>.json`. The
  app tells each session where the file is through `FLOCKCTL_LOCK`, and for
  one release also through `DISTILLCTL_LOCK` with the same value, so a CLI
  from the previous build still connects. The CLI reads `--lock-path` or
  `FLOCKCTL_LOCK`, then `DISTILLCTL_LOCK`. Stale files in the earlier
  `<app data>/distillctl/` directory are swept too, and that directory is
  removed once it is empty.
- Binary overrides: `FLOCKCTL_BIN` and `FLOCK_MONITOR_BIN` name the binaries
  the app puts on `PATH`; `DISTILLCTL_BIN` and `DISTILL_MONITOR_BIN` are read
  when the new spelling is unset, and the app exports `DISTILLCTL_BIN` beside
  `FLOCKCTL_BIN` for one release. `flock-monitor` finds `flockctl` through
  `FLOCKCTL_BIN`, then `DISTILLCTL_BIN`, then `flockctl` or `distillctl` on
  `PATH`.
- `flock-monitor` state is persisted under the old names on purpose: the
  state folder (`%LOCALAPPDATA%\Distill\monitor` on Windows,
  `$XDG_STATE_HOME/distill/monitor` elsewhere), the
  `DISTILL_MONITOR_STATE_DIR`, `DISTILL_MONITOR_FOREGROUND` and
  `DISTILL_MONITOR_LAUNCH_TOKEN` variables, the `DISTILL_MONITOR_PENDING_V1`
  pending-file header and the `distill-monitor-` delivery-id prefix. So
  `flock-monitor stop` finds a monitor the old build started, its undelivered
  output is still flushed, and delivery dedupe survives the upgrade. Delivered
  messages are labelled `source: flock-monitor`.
- The persisted queued-message keys `distillctl_cross_session`,
  `distillSenderLabel` and `distillDeliveryId` keep their names; the label
  they render is "Sent by Flock from another session".

## Versioning

The broker writes a discovery file (`<app data>/flockctl/control-<pid>.json`)
with `protocolVersion`, generation, and port. The CLI verifies it via
`/v1/ping` before calls.

Breaking wire reshapes must bump all three constants:

- `src-tauri/plugins/flockctl/src/discovery.rs`
- `src-tauri/crates/flockctl/src/discovery.rs`
- `src/features/flockctl/commands/contract.ts`

Tests only ensure the three constants are equal. They do not detect breaking
surface changes automatically; reviewers must identify reshapes and require the
bump. Adding a command or optional field is not a wire reshape.

## Enforcement

| Property | Enforced by |
|---|---|
| Contract artifacts fresh | `pnpm generate:flockctl-contract --check`, `just check` |
| Descriptors load without a browser | contract generator imports them in Node |
| Every action strict-parses and has fixtures | `commands.test.ts` |
| Bounds live in schemas | `bounds.test.ts` plus generated contract diff |
| Help fields complete | generator + `validate.rs` |
| clap tree matches CLI surface | flockctl crate tests |
| wire mapping matches CLI surface | flockctl crate tests |
| protocol constants equal | flockctl crate + plugin crate tests |
| rendered help reviewed | inline `EXPECTED_*_HELP` pins |
| broker command-agnostic | `broker_source_stays_free_of_command_literals` |
| safety metadata complete | flockctl command tests |
| spawn ACL on create/fork (actor branch only — no production call carries an actor; see the safety model) | `spawnGate.test.ts` + `commands.test.ts` |
| anonymous spawns logged | `spawnGate.test.ts` |
| each session learns its own id | `appPreamble.test.ts` |

Review-only rules: single renderer dispatch point, detecting breaking wire
reshapes, and product judgment for no-auth command eligibility.

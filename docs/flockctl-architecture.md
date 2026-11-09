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
- session-creating verbs are ACL-enforced only for a caller that names
  itself. The gate in `runtime/spawnGate.ts` checks the envelope's optional
  `actor` (the calling session's `AGENT_SESSION_ID`) or the session a
  `session create` call names with `--parent-session-id`, and treats a call
  that names neither as the operator. The built-in agent host never exports
  that variable: it runs one bridge process per harness serving every session
  of that harness, so a process-level env var cannot carry a per-session id.
  A call without `--parent-session-id` is therefore anonymous, allowed, and
  logged to `flock.log`. The spawn rule reaches agents through the prompt
  insert (`src/features/conductor/spawnAcl.ts`), which states plainly that
  flockctl's spawn commands are not checked in code. Making the identity real
  needs a per-session token minted by the host and delivered to the session's
  shell per session, which v1 does not have

Delete, bulk, silent, invisible, or destructive verbs require reopening the
auth/confirmation design before implementation: until the broker can
authenticate the caller, a flag cannot stand in for the user's consent to lose
work. Do not add interactive prompts or piecemeal auth in a command PR.

## Session identity

An agent cannot discover which session it is running in from its environment:
`AGENT_SESSION_ID` is never exported (one bridge process per harness), and
`flockctl info context` without `--session-id` reports the chat the operator
is viewing, which need not be the caller's. The one channel is the app
preamble: `appPreamble.ts` (`formatFlockctlPreamble`) states the session's
own id, and `acpSendMessage` composes it per session. Commands that need a
session id — `flock-monitor run` and `stop` above all — require it as an
explicit `--session-id`, and the bundled `flock-monitor` skill tells the agent
to take it from that preamble line. `info context --session-id <id>` then
describes that session (its project, folder, parent chat and wave) beside the
viewed chat. Do not add a "current session" default anywhere: the broker
cannot tell which session called it, so any such default would deliver into
the wrong chat.

## Waves

The `wave` noun is the conductor's view of its own brigade: `list` and
`get` read the wave engine's state (`src/features/conductor/waveStore.ts`)
with the session running each step; `cancel` is the operator's stop control
(a live wave is parked and its executors told to stop, a queued wave is
dropped); `steer` sends one message to every running executor through the
same `session send` path; `amend` and `skip` change a step that has not
been dispatched yet; `roadmap` reads the goal a conductor published with a
`distill-roadmap` block. Every mutation posts a notice in the conductor chat.
`session list` and `session get` carry `parent_session_id`, `wave_id` and
`wave_step` from the conductor graph, so a conductor can tell its own workers
apart from the operator's chats.

## Jobs

The `job` noun is how the app learns about the producers `flock-monitor`
runs. The monitor reports a job itself with `flockctl job report` when the
producer starts, every minute while it runs and once when it ends; each
report carries the whole state (owner session, state key, label, monitor and
producer pids, start and last-output times as epoch seconds), so a missed
report is repaired by the next. Reports go from the monitor's own thread and
never hold up delivery; a refusal that is not transient turns reporting off
for that monitor, and the end report is retried while the monitor lives.
The job id is the monitor's launch token.

A job outlives the app. An agent's shell runs in the job object Flock keeps
each agent bridge in, which kills its members when Flock exits, so the
monitor starts its detached self with `CREATE_BREAKAWAY_FROM_JOB`. When a
job around the launcher refuses that, the monitor starts inside it anyway and
says so on stderr and in `watcher.log`. Such a monitor still ends with the
app. Its producer sits in the monitor's own kill-on-close job, so stopping
or killing the monitor still ends the producer's whole tree.

A job also outlives an update. Windows refuses to overwrite a running
executable but lets it be renamed, so the NSIS installer's pre-install hook
(`src-tauri/windows/installer-hooks.nsh`) first closes the app, then moves
`flock-monitor.exe`, `flockctl.exe` and `flock-history.exe` into the install
folder's `superseded\` subfolder, under the tool's name and the time of the
install, before it copies the new files. A running monitor keeps its old binary there and
reports to the new app as before. Every monitor started after the update
runs the new binary, and a monitor's next `flockctl` call runs the new
`flockctl`. A moved file nothing runs is deleted at once. A later install or
the uninstaller deletes the rest once their monitors have ended. No monitor
is stopped.

The app keeps the record in `conductor/monitor-jobs.json` under the Flock
root (`src/features/conductor/monitorJobStore.ts`). After a restart, a
running job is still listed, the liveness check keeps it while its monitor
lives, and the monitor's next report finds the new app. It goes through the
newest `control-*.json` beside the lock it was started with. A job that ends
while the app is closed has its end report retried for ten minutes, and is
`lost` after that. Every 30 seconds it checks each running job's monitor pid against
its start time (`processes_alive`, so a reused pid does not count) and marks
a job whose monitor is gone `lost`; a later report revives it. A session with
a running job counts as working on its sidebar row, above the composer and
in its conductor's footer (`withLiveJobStatus`), and the composer line lists
each job with its label, age and last output and a way into the owning chat.
A job silent for its threshold while its producer runs gets its owner one
message through `deliverEnvelope`, recorded before it is sent so it is said
once per silence (`monitorJobWatch.ts`). `job list` reads the record; there
is no verb that stops or forgets a job from the app (`flock-monitor stop`
stops it).

## Sessions started by a session

A session one chat starts to take on part of its work is that chat's child,
by the same rule whichever path started it: the conductor's own spawns and
wave steps (`spawnConductorChildSession`), and `flockctl session create
--parent-session-id <own id>` from any chat, conductor or ordinary. Both
record the link through `childSessionLink`
(`src/features/conductor/childSessionLink.ts`) as a node in the conductor
graph whose `parentSessionId` is the starting chat; an ordinary chat has no
node of its own and is its own root. From that one record:

- the sidebar draws the child under the chat that started it and keeps it out
  of the top-level list (`indexAgentChildren`, `SessionListCapability`);
- the starting chat shows the child on the message that started it, with a
  way into its chat (`footerAgentNodes`, `brigadeAnchors.ts`);
- when the child's run ends, its result is delivered back to the starting
  chat as one digest message (`publishGroups.ts`, `digestPublisher.ts`).

The id comes from the preamble line above, which also tells the agent to pass
it when it delegates. Without it the app cannot tell who started the session,
and the new session is an independent chat. Claude Code and Codex make the
same link from the calling session itself, because their spawn is a tool of
that session; here the CLI runs in a shell the host cannot attribute, so the
caller states it.

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
- Discovery: the broker writes `<Flock root>/flockctl/control-<pid>.json`.
  The app tells each session where the file is through `FLOCKCTL_LOCK`, and
  for one release also through `DISTILLCTL_LOCK` with the same value, so a
  CLI from the previous build still connects. The CLI reads `--lock-path` or
  `FLOCKCTL_LOCK`, then `DISTILLCTL_LOCK`, and never looks for the file
  itself, so an app of an earlier build, which names its own file under the
  identifier-keyed app data folder, is found the same way. Stale files in
  that folder's `flockctl/` directory, where builds before this one wrote,
  and in the earlier `<app data>/distillctl/` directory are swept too, and
  each directory is removed once it is empty.
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

The broker writes a discovery file (`<Flock root>/flockctl/control-<pid>.json`)
with `protocolVersion`, generation, and port. The CLI verifies it via
`/v1/ping` before calls. The file lives under the root rather than the OS app
data folder because on Windows that folder is not one folder for every
process; [Flock data storage](flock-root-layout.md) explains the redirection.

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


### Steering delivery

`session/steer` does not acknowledge an in-memory next-turn queue. The host
uses `_session/steering` only with an advertised capability and a supported
idle-race contract. Claude's `promptRequired` opt-in lets the renderer retain
input in its durable queue if the active turn finishes before injection. The
installed Codex bridge can instead start a detached turn without an awaited
completion response, so its input uses the durable queue until that lifecycle
is supported. Other providers use the same queue fallback.

Native input is saved before dispatch. Provider echoes update its delivery
receipt instead of appending duplicate text. Transport uncertainty keeps the
saved input marked unconfirmed; it does not authorize automatic re-dispatch.
When the renderer loses the host response, it also saves a held review item
in the durable queue. Reopening the chat does not dispatch that item. The
user must review and edit it before a new send is admitted.
The message and its receipt replay together, including monitor provenance and
idempotency keys. An already queued input retains its place when injection is
unavailable. Queue admission and provider acceptance are distinct command
results.

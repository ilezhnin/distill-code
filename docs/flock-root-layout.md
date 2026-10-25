# Flock data storage

Flock keeps app-owned durable state under one configured data root, called
the Flock folder in the UI. The app resolves it from `FLOCK_ROOT` (or
`DISTILL_ROOT`, the variable's earlier name, still honoured when `FLOCK_ROOT`
is unset), then the `root-path` pointer in the OS config directory, then
`~/.flock` when that folder exists, then `~/.distill` when an install upgraded
from Distill still has one, and otherwise `~/.flock`. An existing `~/.distill`
is adopted in place: nothing is moved, and the first start records it in the
pointer so every later start takes the pointer. The pointer also allows
startup to locate a root that the user has moved.

Flock reads and writes its own data — settings, chats, projects, agents,
skills, memory, benchmarks — only under this root and, for a project, in that
project's `.distill/` folder (a name that did not change with the product's).
Folders other tools keep are not Flock data:
`~/.agents`, `~/.claude`, `~/.codex`, `~/.gemini`, `~/.goose`, and a project's
`.agents`, `.claude` or `.codex` folders are neither listed, offered nor written.
Bringing something in from them is an explicit import (a skill, agent or memory
file the user picks). The provider CLIs Flock launches still use their own
homes; that is the CLI's behaviour, not Flock reading them.

Where Flock shows the state of a provider CLI, it reads that CLI's own
configuration without writing it or copying it into the root: the Extensions
settings list the MCP servers Claude Code (`~/.claude.json`, a workspace's
`.mcp.json`) and Codex (`config.toml` in `CODEX_HOME` or `~/.codex`, a
workspace's `.codex/config.toml`) will load, and the usage meters read the
Kimi CLI's configuration (`KIMI_CODE_HOME` or `~/.kimi-code`) and the Grok
CLI's sign-in (`GROK_HOME` or `~/.grok`) to ask for those accounts' quotas.
Those files are the CLIs' configuration, not Flock data, and never a source
of skills, agents, chats, projects or memory.

## App data

| Path under the root | Purpose |
| --- | --- |
| `settings.json` | Global application preferences |
| `sessions/agent-host.db` | Session records and chat history. A turn is stored in the form its replay reads once it ends: the streamed pieces of one message as one event, a running tool call without the output its final update repeats. A database written before that is compacted once in the background after start, a chat at a time, and the next start vacuums it; `flock-history compact <path to agent-host.db>` (a binary of the app crate) does the same to a closed database at once |
| `projects/` | Registered project records |
| `agents/` | Agent definitions: the user's own agents, one Markdown file each |
| `skills/` | Skills: the built-in skills Flock installs and the user's own |
| `state/` | Message queues, usage history and other application state |
| `provider-accounts/` | Saved Claude and Codex account metadata and isolated credential homes |
| `benchmarks/benchmarks.db` | Versioned benchmark catalog, frozen plans, results, decisions, quota batches and opt-in campaigns |
| `benchmarks/versions/`, `benchmarks/runs/` | Immutable public fixtures, frozen execution manifests and sealed evidence |
| `benchmarks/evaluations/`, `benchmarks/exports/` | Protected evaluator artifacts and portable dataset exports |
| `benchmarks/runtime/<harness>/` | Regenerable files a benchmark bridge runs with, rewritten before each launch: an empty `os-home/` its profile points the home and application data folders at (which keeps the user's profile from Kimi and Grok; `codex.exe` finds the user's profile through the operating system, so Codex benchmarks are refused while the profile's `.agents/skills` has entries), for Codex the `instructions.md` system prompt and `model-catalogs/` (one model catalog per account, named by a digest of the account id: the model list the account's Codex CLI cached, without the tools its entries declare), and for Grok its private `home/` (`GROK_HOME`): the policy's `config.toml` plus Grok's own docs, sessions, caches, plugin registry lock and downloaded platform skills, and an owner-only `sign-in/` folder. Kimi needs only the OS home; it runs on the user's own Kimi home. No credentials at rest: an owned Grok reads the user's session, reduced to its access token, times and identity, from a file in `sign-in/` that exists only from just before its launch until it has answered `initialize` (a file a stopped Flock left there is removed when the agent host starts, as the app quits and before the next launch), and an `auth.json` it would leave in `home/` is removed before each launch and whenever the bridge stops: idle shutdown, a sign-in replacement, a credential change, app quit or its own exit |
| `memory.json` | The built-in memory feature's records |
| `conductor/`, `runs/` | Orchestration state and run records |
| `artifacts/` | Generated artifacts |
| `runtime-config/`, `user-avatars/` | Runtime overrides and uploaded media |
| `cache/` | Regenerable runtime downloads and packages |
| `logs/` | The app log, `flock.log`, and its two newest rotated archives |
| `flockctl/` | The control broker's discovery files, `control-<pid>.json`, one per running app instance, removed when it stops |

The table describes application storage. Personal prompt organization and delivery
are user configuration, outside the shared application's data model. Startup does
not create personal instruction templates or add a personal document collection
to chat prompts. Existing custom files are left untouched.

Project-specific application data lives in `<project>/.distill/`: `settings.json`,
`agents/`, `skills/`, `wiki/` and records used by the built-in memory feature.
This directory is local application state and is excluded from this repository's
Git tracking.

## Settings and project scope

Global settings load before renderer stores derive their initial state. Legacy
browser preferences migrate to `settings.json`; their old browser keys are removed
after successful persistence. Browser previews retain their localStorage fallback.

Settings use JSON keys without the `distill:` prefix older builds gave browser
keys; browser-local keys that keep a prefix moved from `distill:` to `flock:`
once, on the first start after the rename. Unknown keys survive
updates, and concurrent windows merge changed keys. Invalid JSON is reported
without replacing the file. Hand edits are reread on window focus and before
composing session styles.

The target project's settings can override `style-guidelines` and
`at-mention-default-category`. General chats use global settings. Appearance,
locale and keyboard bindings remain global. Project agent and skill sources
(`<project>/.distill/agents`, `<project>/.distill/skills`) override global
sources of the same name without changing other projects.

## Migration and recovery

The root is initialized before app-owned stores open. Legacy AppData files are
copied once without replacing existing root content. A `~/.agents` folder that
older builds shared with other tools is imported in the same one-time pass, and
only when it is present: Flock never creates that folder, writes to it, or
reads it afterwards. Agent avatars and queued messages recorded against an agent
in it resolve to the agent's copy under `agents/`. Names older builds wrote
under the upstream name are brought along in the root's copies only; the old
AppData folder is left as it was. Sessions and projects of goose, the app the
first builds ran on, are imported once from its application data folder when it
exists. Originals remain available for recovery.

Names an install upgraded from Distill carries are adopted in the same
one-time pass. The seed marker `.flock-bundled-agents.json` replaces the
`.distill-bundled-agents.json` (and `.berd-bundled-agents.json`) an older
build wrote; the `distillBundled` and `berdBundled` frontmatter markers on
installed skills and agents are rewritten to `flockBundled`, and only files
carrying a marker are touched; the installed copies of the retired
`distill-help` and `distill-monitor` skills are removed when they carry it.
The `distillctl` and `distill-monitor` shims in `cache/bin/` are not retired:
the agent host keeps them beside `flockctl` and `flock-monitor` so older
skills and transcripts keep working. Outside the root, the OS folders keyed by
the application identifier are renamed once from `com.levocat.distill` to
`com.levocat.flock` before the root opens, and the session database's record
of where it was adopted from is read under either identifier, never
rewritten.

Session migration uses a SQLite snapshot that includes committed WAL contents.
The completed snapshot is promoted atomically and is not imported again. Agent
file-path references are updated in configuration; message text and captured
prompts are preserved.

`FLOCK_ROOT` (or `DISTILL_ROOT`) and the E2E profile skip adoption from the
real user's AppData.
Changing the folder in Settings takes effect after restart and does not move
existing data. Copy an existing root while Flock is stopped.

Benchmark storage uses its own SQLite WAL database. Back it up while stopped or
through a consistent SQLite snapshot. The host database retains the corresponding
benchmark owner and idempotent dispatch records. Keep both databases and the
benchmark version/evidence directories together when restoring. Archiving a test
preserves published versions and results. Interrupted dispatches are reconciled
against host records and are never automatically resent when acceptance is unknown.
Restart parks interrupted work and disables missed campaigns until reviewed.

WebView caches and derived avatar thumbnails may remain outside the root. CLI
discovery and the app log do not. The `flockctl/` discovery files the control
broker writes live in the root; builds before this one wrote them under the
identifier-keyed app data folder, and files a crashed instance of such a build
left in that folder's `flockctl/` directory and stale files in the earlier
`distillctl/` directory there are swept too, each directory being removed once
it is empty. `flock.log` and its rotated archives are written to the root's
`logs/` (logs an older build wrote stay where it left them, under the
identifier-keyed log folder). On Windows those identifier-keyed folders are
not the same folders for everyone: a process started from the Claude desktop
app, every agent session's shell among them, sees `%LOCALAPPDATA%` and
`%APPDATA%` through that app's package redirection, a merged view under
`%LOCALAPPDATA%\Packages\Claude_…\LocalCache\` in which a file such a process
once wrote hides the real one from every later such process. The home
directory is not redirected, so the root is the same folder for everyone.
Disposable UI state can remain in localStorage. External
harnesses own their credentials and configuration. Flock-managed Claude and
Codex accounts keep each harness's credential files in a separate protected
home under `provider-accounts/`, without falling back to another application's
credentials. Native CLI history import is a separate operation. See
[Provider accounts](provider-accounts.md).

The `distro/` catalog supplies the generic built-in skills. Agents are
user-managed definitions and are not copied into the app distribution.

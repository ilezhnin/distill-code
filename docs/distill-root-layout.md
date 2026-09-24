# Distill data storage

Distill keeps app-owned durable state under one configured data root. The app
resolves it from `DISTILL_ROOT`, then the `root-path` pointer in the OS config
directory, then `~/.distill`. The pointer allows startup to locate a root that
the user has moved.

## App data

| Path under the root | Purpose |
| --- | --- |
| `settings.json` | Global application preferences |
| `sessions/agent-host.db` | Session records and chat history |
| `projects/` | Registered project records |
| `agents/` | Installed built-in and user-created agent definitions |
| `skills/` | Installed built-in and user-created skills |
| `state/` | Message queues, usage history and other application state |
| `memory.json` | The built-in memory feature's records |
| `conductor/`, `runs/` | Orchestration state and run records |
| `artifacts/` | Generated artifacts |
| `runtime-config/`, `user-avatars/` | Runtime overrides and uploaded media |
| `cache/` | Regenerable runtime downloads and packages |

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

Settings use JSON keys without the old `distill:` prefix. Unknown keys survive
updates, and concurrent windows merge changed keys. Invalid JSON is reported
without replacing the file. Hand edits are reread on window focus and before
composing session styles.

The target project's settings can override `style-guidelines` and
`at-mention-default-category`. General chats use global settings. Appearance,
locale and keyboard bindings remain global. Project agent and skill sources
override global sources of the same name without changing other projects.
Legacy `.agents` sources remain available for compatibility.

## Migration and recovery

The root is initialized before app-owned stores open. Legacy AppData and personal
`.agents` files are copied without replacing existing root content. Originals
remain available for recovery.

Session migration uses a SQLite snapshot that includes committed WAL contents.
The completed snapshot is promoted atomically and is not imported again. Agent
file-path references are updated in configuration; message text and captured
prompts are preserved.

`DISTILL_ROOT` and the E2E profile skip adoption from the real user's AppData.
Changing the folder in Settings takes effect after restart and does not move
existing data. Copy an existing root while Distill is stopped.

WebView caches, derived avatar thumbnails, logs and CLI discovery may remain
outside the root. Disposable UI state can remain in localStorage. External
harnesses own their credentials and configuration.

The `distro/` catalog supplies generic built-in skills and starter agents. Personal
definitions remain user-managed and are not copied into the app distribution.

# agent-driver relay

A small bridge so the agent working on this repository can press buttons in
the running app and run the test suite, instead of asking you to.

## Why it exists

The agent's session runs elsewhere. It sees this repository through a mounted
folder, which means two things it cannot do:

- **Reach `127.0.0.1`.** The Tauri `app-test-driver` plugin listens on
  loopback on *your* machine. Nothing the agent has can dial it.
- **Run the toolchain.** `node_modules` here is a pnpm tree of symlinks, and
  symlinks do not survive the mount; the agent's own container has no access
  to the npm registry. So `pnpm vitest` and `just check` are yours, not its.

Both are the same shape of problem — a channel, not a capability — so this is
one relay with two kinds of envelope.

## Running it

From a terminal where `pnpm` already works:

```sh
node scripts/agent-driver/relay.mjs
```

That watches `../agent-driver/` next to the repository — the folder the agent
already reads — and talks to the app on `127.0.0.1:9999`, which is where a dev
build puts the driver (`justfile`'s `app_features` includes
`app-test-driver`; the app logs `[app-test-driver] Listening on
127.0.0.1:9999` at startup).

Options: `--root <dir>`, `--port <n>`, `--token <s>` (only for the isolated
driver mode, which mints its own port and token).

Leave it running. It prints one line per envelope. Ctrl+C stops it.

## What it does

It polls `<root>/inbox/*.json`, answers into `<root>/outbox/<id>.json`, and
deletes the envelope. Answers are written to a temporary name and renamed, so
the other side never reads half a file. `<root>/heartbeat.json` is refreshed
every two seconds and says whether the app's driver port is answering.

Driver and exec run in separate lanes: a fifteen-minute test run does not
block a snapshot.

### `driver` envelopes

```json
{ "kind": "driver", "action": "snapshot" }
{ "kind": "driver", "action": "fill", "selector": "[data-tid=composer]", "value": "hello" }
{ "kind": "driver", "action": "waitForText", "selector": "body", "value": "accepted", "timeout": 30000 }
```

Forwarded verbatim to the plugin, whose supported actions are `snapshot`,
`active`, `click`, `fill`, `keypress`, `getText`, `waitForText`, `count`,
`scroll` and `screenshot` (macOS only). The answer comes back as
`{ ok, success, data, error }`.

### `exec` envelopes

```json
{ "kind": "exec", "cmd": "pnpm", "args": ["vitest", "run", "src/features/conductor"] }
{ "kind": "exec", "cmd": "just", "args": ["check"], "timeoutMs": 900000 }
```

The answer is `{ ok, code, signal, timedOut, ms, stdoutTail, stderrTail,
logFile }`. The tails are the last 8 000 characters of each stream; the whole
thing is in `logFile`, which lives under `<root>/logs/` where the agent can
read it.

`cmd` must be one of `pnpm`, `just`, `git`, `cargo`, `node`, and `cwd` must
resolve inside this repository or the relay root. That allowlist is a guard
rail against a mistyped envelope, not a security boundary — `pnpm` can run
anything this repository's scripts can. The inbox is trusted input, because it
is a folder on your own disk.

### `control` envelopes

`{ "kind": "control", "action": "ping" }` proves the relay is alive.
`{ "kind": "control", "action": "shutdown" }` stops it.

## Failure is an answer, never a hang

Every path writes an answer file: the app not running, the port refusing, a
command that is not on the allowlist, a `cwd` outside the roots, an envelope
that is not JSON, a command that outran its timeout. A missing answer means
the relay itself is not running — check `heartbeat.json`.

## Tests

```sh
node --test scripts/agent-driver/relay.test.mjs
```

Plain `node --test` on purpose: a relay that exists because the toolchain is
unreachable must not need that toolchain to be tested.

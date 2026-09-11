# Driving the running app

Dev builds include the `app-test-driver` Tauri plugin (`app_features` in the
`justfile` is `berdctl,app-test-driver`), so a running Distill can be clicked,
typed into and read from outside. There is no checked-in end-to-end suite
built on it: you use the driver by hand, or an agent uses it through the
[agent-driver relay](../scripts/agent-driver/README.md).

Automated UI coverage lives elsewhere: component tests next to the code in
`src/` (`just test`), and the renderer-only Playwright specs in
`tests/transcript-virtualization/`, which CI runs with
`pnpm test:transcript-virtualization:ci`.

## The local driver (default)

A dev build started with `just dev-windows` (or
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\Dev-Windows.ps1`)
listens on `127.0.0.1:9999`, or on `APP_TEST_DRIVER_PORT` when that is set,
and logs `[app-test-driver] Listening on 127.0.0.1:<port>` at startup. It uses
your normal app profile and accepts unauthenticated loopback connections.

The protocol is one JSON object per line in each direction:

```json
{ "action": "waitForText", "selector": "body", "value": "Ready", "timeout": 30000 }
```

```json
{ "success": true, "data": "...", "error": null }
```

Supported actions are `snapshot`, `active`, `click`, `fill`, `keypress`,
`getText`, `waitForText`, `count` and `scroll`. `screenshot` is accepted but
always fails.

## Through the agent-driver relay

An agent that cannot reach your loopback or run the toolchain drives the app
through `scripts/agent-driver/relay.mjs`. Start it from a shell where `pnpm`
works:

```sh
node scripts/agent-driver/relay.mjs
```

It watches `../agent-driver/` next to the repository, forwards `driver`
envelopes to the app's driver port and runs allowlisted `exec` envelopes
(`pnpm`, `just`, `git`, `cargo`, `node`). The envelope formats, options and
failure behaviour are in [its README](../scripts/agent-driver/README.md).

## Isolated mode

Isolated mode is an explicit opt-in for a run that must not touch your real
profile. It needs a binary built with `app-test-driver` and `BERD_E2E_MODE=1`
with a validated run root, run ID and driver token. The app then:

- runs under its own identifier, `xyz.block.berd.e2e.<run-id>`, so it gets
  its own app data;
- keeps agents and skills under `<run-root>/home/.agents`;
- listens on a random loopback port, requires the token on every command, and
  writes `{ "host", "port", "pid" }` to `<run-root>/app-test-driver.json` once
  it is ready;
- reads an optional `BERD_E2E_RUNTIME_CONFIG` — a `runtime-config.json` in the
  shape of `src-tauri/resources/runtime-config.json` — copied into the run
  root.

On Windows, set the variables and start the dev app as usual. The run root
must be absolute and end in the run ID (which defaults to its last segment).
Set the token yourself (32–128 letters or digits) so the relay can send it:

```powershell
$env:BERD_E2E_MODE = "1"
$env:BERD_E2E_RUN_ROOT = "$env:TEMP\distill-e2e\run-1"
$env:APP_TEST_DRIVER_TOKEN = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\Dev-Windows.ps1
```

Point the relay at the isolated driver with the port from
`app-test-driver.json` and the token:

```sh
node scripts/agent-driver/relay.mjs --port <port> --token <token>
```

Nothing cleans up after an isolated run: delete the run root and the per-run
app data folders named after its identifier yourself.

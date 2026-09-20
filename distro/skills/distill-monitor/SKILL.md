---
name: distill-monitor
description: >-
  Run a long-lived command outside the current Distill turn and wake the owning
  session with actionable stdout. Use for builds, tests, reviews, deployments,
  polling, watchers, and other external waits.
metadata:
  distillBundled: true
---

# Distill Monitor

Use `distill-monitor` when a command may outlive the current turn. It detaches the
producer from Distill and the agent harness, buffers output across delivery
failures, and sends complete stdout lines to the exact originating session.

Run short, bounded commands normally. Do not hold a turn open with `sleep`,
polling, log tailing, or a foreground timeout.

## Start

```bash
distill-monitor run \
  --session-id <your session id> \
  --state-key <stable-key> \
  --label '<concise source name>' \
  --instructions '<short event-handling guidance>' \
  -- <producer-command> [args...]
```

`--session-id` is required and selects the session events are delivered to.
Pass your own session id, which the Distill app preamble states for this
session ("Your own session id is …"). There is no environment variable for it:
do not rely on `AGENT_SESSION_ID`, do not take `active_session_id` from
`distillctl info context` (that is the chat the operator is viewing, which need
not be this one), and never infer a session from the working directory. Use
another session's id only when that session was positively identified and the
events belong to it. The command prints the detached monitor PID. After checking the
monitor's `watcher.log` under the printed state directory when diagnosis is
needed, continue other work or end the turn—never wait on the detached PID.

The producer's stdout is the event API:

- emit concise, newline-terminated milestones and flush promptly;
- put verbose output and diagnostics in durable logs or stderr;
- avoid NUL bytes and emit a final summary when practical.

Default `--if-running steer` adds an event to an active run or starts a new
turn. Use `--if-running queue` only when the active run must not be steered.
Pending events retry without being dropped, and a trailing partial line is
delivered when the producer exits.

Delivered messages are visibly labeled as coming from `distill-monitor`. Stop a
monitor with:

```bash
distill-monitor stop --session-id <your session id> --state-key <stable-key>
```

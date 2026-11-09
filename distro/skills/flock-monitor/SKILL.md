---
name: flock-monitor
description: >-
  Run a long-lived command outside the current Flock turn and wake the owning
  session with actionable stdout. Use for builds, tests, reviews, deployments,
  polling, watchers, and other external waits.
metadata:
  flockBundled: true
---

# Levocat Flock Monitor

Use `flock-monitor` when a command may outlive the current turn. It detaches the
producer from Flock and the agent harness, buffers output across delivery
failures, and sends complete stdout lines to the exact originating session.

Run short, bounded commands normally. Do not hold a turn open with `sleep`,
polling, log tailing, or a foreground timeout.

## Start

```bash
flock-monitor run \
  --session-id <your session id> \
  --state-key <stable-key> \
  --label '<concise source name>' \
  --instructions '<short event-handling guidance>' \
  -- <producer-command> [args...]
```

`--session-id` is required and selects the session events are delivered to.
Pass your own session id, which the Flock app preamble states for this
session ("Your own session id is …"). There is no environment variable for it:
do not rely on `AGENT_SESSION_ID`, do not take `active_session_id` from
`flockctl info context` (that is the chat the operator is viewing, which need
not be this one), and never infer a session from the working directory. Use
another session's id only when that session was positively identified and the
events belong to it. The command prints the detached monitor PID. After checking the
monitor's `watcher.log` under the printed state directory when diagnosis is
needed, continue other work or end the turn—never wait on the detached PID.

The producer's stdout is the event API:

- emit concise, newline-terminated milestones and flush promptly;
- put verbose output and diagnostics in durable logs or stderr;
- avoid NUL bytes and emit a final summary when practical.

Default `--if-running steer` injects an event when the provider supports safe
in-flight delivery. Otherwise Flock saves it in the chat queue and sends it
when the current turn ends. An idle chat starts a normal turn. Use
`--if-running queue` to always wait for the current turn.

`steered` confirms provider acceptance, while `queued` confirms queue admission.
`delivery_unconfirmed` and `not_delivered` keep the input visible for inspection;
never blindly resend either outcome with a fresh delivery id. A timeout does
not prove that the provider rejected an event. Monitor messages use a compact
background-task preview; expand it to inspect the complete output.
Pending events retry without being dropped, and a trailing partial line is
delivered when the producer exits.

Delivered messages are visibly labeled as coming from `flock-monitor` (the
label reads `source: flock-monitor`). Stop a monitor with:

```bash
flock-monitor stop --session-id <your session id> --state-key <stable-key>
```

## The app sees the job

The monitor tells Flock about the job when the producer starts, about once a
minute while it runs, and when it ends (its exit code, or that it was
stopped). While it runs, your session reads as waiting on it in the sidebar,
above the composer and in your conductor's view, with the label, how long it
has run and when it last printed a line, so ending your turn after starting
a job does not make the session look idle.

The monitor and its producer keep running when Flock closes or restarts. The
app finds the job again when it starts, and the monitor's next report reaches
it. Lines the producer printed meanwhile are delivered then. A job that ends
while Flock is closed for more than about ten minutes is listed as `lost`,
because nobody was there to hear how it ended.

`flockctl job list --session-id <your session id>` lists your running jobs;
`--include-ended` adds the ones that ended in the last three days. A job whose
monitor process is gone without saying how the job ended is listed as `lost`.

Silence counts stdout lines only. When the producer is still running but has
printed nothing for `--silence-minutes` (default 15, `0` never), the session
gets one message saying so, with the command that stops the job; it is said
once per silence, and again only after the job prints and falls silent anew.
Pick a threshold longer than the quietest stretch the job normally has.

`distill-monitor` is an alias of `flock-monitor`, kept so older skills and
transcripts keep working; use `flock-monitor` in anything new. A monitor
started by a build that still called itself Distill cannot deliver into the
renamed app: stop it with `flock-monitor stop` (it is found, the state folder
did not change) and start it again.

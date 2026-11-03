# flockctl

`flockctl` is the CLI agents use to drive the visible app — it only exposes
verbs that map to something the user can also see happen in the UI. It is
organized as `flockctl <noun> <verb>` (for example `flockctl session list`,
`flockctl project create --name demo`).

- Discover what exists by asking the tool, not by reciting a memorized list:
  run `flockctl --help` for the noun tree, then `flockctl <noun> --help` for
  its verbs.
- Treat `flockctl <noun> <verb> --help` as the authoritative reference for
  that command's flags, bounds, and behavior — flags and bounds can change,
  and this skill does not restate them.
- Add `--json` to any command for machine-readable output, useful when you
  need to parse the result rather than read it.
- Prefer `flockctl` over describing a click path when the user wants
  something done now, when the task is repetitive, or when precision matters
  more than a screenshot-friendly walkthrough. Prefer describing the click
  path when the user is trying to learn the UI itself.
- Every `flockctl` verb corresponds to something visible in the app — if a
  command claims to do something the user can't also see reflected in the
  UI, that's a signal to double check with `--help` rather than trust
  recall.
- `distillctl` is an alias of `flockctl`, kept so older skills and transcripts
  keep working; use `flockctl` in anything new.

## Sessions you start for your own work

A session you start to take on part of your task belongs under your chat.
Pass your own session id, which the Flock preamble states, as
`flockctl session create --parent-session-id <your id>`. The new session is
then shown under your chat in the sidebar instead of as a chat of its own,
your chat shows it working, and its result is delivered back to your chat
when its turn ends, so it does not need to be told to report back. Leave the
flag out only when the user asks for an independent chat.

To stop one of those sessions, run `flockctl session stop --session-id <id>`
with `--from` and `--reason` saying who and why; its chip shows both. Do not
try to stop it by sending it a message: a message to a running session waits
in its queue until the turn ends, and a turn stuck on a provider out of quota
never ends. The stop drops its queue and cancels its turn, and when the agent
does not answer the cancel the app ends the turn itself shortly after. Its
files and chat are kept. Only sessions started under another chat can be
stopped this way.

## Model, effort and speed are separate choices

A model id names a model and nothing else. Reasoning effort and fast mode
are separate choices, and each model offers its own set of them.

- `flockctl info models` lists every model's `efforts` and `supports_fast`.
  Choose an effort from that model's list; do not glue it onto the id.
  Ids like `gpt-5.6-sol[xhigh]` are an old spelling that is still accepted
  but answered with a `deprecated` note.
- `flockctl session create` takes the effort and fast mode as their own flags
  next to `--model-id`, and refuses a value the chosen model does not offer
  with `effort_not_available` (the message names what it does offer) or
  `fast_not_supported`.
- `flockctl agent create` takes `--effort` and `--fast-mode` next to `--model`,
  checks them the same way, and saves them on the agent, so its chats start on
  that model, effort and fast mode.
- `flockctl session get` and `flockctl session list` report the `effort` and
  `fast_mode` each session's model last acknowledged.

## A conductor reading its own waves

- `flockctl wave list --conductor-session-id <your id>` lists the waves a
  conductor chat planned — running, waiting for a digest or a verdict, queued
  behind a free slot, and with `--include-closed` those parked for the
  operator — with the session running each step and that step's report
  status. `flockctl wave get --wave-id <id>` adds the step briefs and the
  conductor's roadmap; an unambiguous prefix of the id is enough.
- `flockctl wave cancel` is the operator's stop control: a live wave is parked
  and its running executors are told to stop, a queued wave is dropped.
  `flockctl wave steer` sends one message to every running executor of a
  wave; `flockctl wave amend` and `flockctl wave skip` change a step that has
  not been dispatched yet. Each posts a notice in the conductor chat.
- `flockctl wave roadmap --conductor-session-id <id>` reads the goal a
  conductor published with a `distill-roadmap` block; the conductor changes
  it by publishing a new block.
- `flockctl session list` and `flockctl session get` report
  `parent_session_id`, `wave_id` and `wave_step`, so a conductor can tell its
  own workers from the operator's chats. `flockctl info context
  --session-id <your id>` describes your own session beside the chat the user
  is viewing.

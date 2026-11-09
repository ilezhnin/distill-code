# Waves: the conductor's contract

A conductor is a chat that may answer a request itself or dispatch it to a
brigade of executors. The protocol between them is three fenced blocks and a
fixed vocabulary. It is written here, and not only in the prompt that teaches
it, because the parsers, the skills shipped to agents and the operator's
expectations all have to agree on the same words.

## The plan

- A conductor MUST express a plan as a single fenced block tagged
  `distill-wave` containing one JSON object with a `steps` array.
- A conductor's answer that carries no `distill-wave` block MUST be treated as
  an ordinary answer and MUST NOT be reported as a malformed plan.
- A `distill-wave` block that is present but cannot be parsed MUST be refused
  as a whole, and the refusal MUST say what was wrong with it.
- A plan MUST carry between one and five steps.
- Each step MUST carry a `role` from the worker-layer role catalog and a
  non-empty `subtask`.
- Each step's `access` MUST be either `[]` — the step sees nothing from its
  siblings — or `"all"` — the step sees the reports of every step that
  completed before it. No other value, including a list of step indices, is
  part of the contract.
- A step MAY carry a `label`, which names it for the operator, and a `model`,
  which pins it to a model by name.
- A step that names a `model` the harness does not serve MUST cause the whole
  plan to be refused rather than the step to be run on something else.
- A wave step MUST NOT be spawned on a model its harness does not advertise.

## The report

- An executor MUST report through a single fenced block tagged
  `distill-report`.
- A report's status MUST be one of `completed`, `failed`, `cancelled` or
  `blocked`.
- `blocked` MUST mean the executor claims the step could not be done at all,
  MUST carry the reason, and MUST NOT be derived from a run's own outcome.
- A step whose executor ended without reporting MUST NOT be reported to the
  conductor as `completed` unless that executor's run itself completed.
- A step whose executor ended a turn without reporting while work it left
  running in the background still runs MUST NOT be treated as finished until
  that work has ended.
- A step whose executor's background work still runs MUST be shown as working.

## The verdict

- When a wave finishes, the app MUST deliver a digest of its reports to the
  conductor as a message, and the conductor's next settled answer to that
  digest MUST be read as the verdict for that wave.
- A digest MUST name the wave it reports, and a verdict that names a wave
  MUST be read for that wave and no other.
- A digest MUST deliver every report's text as the executor wrote it; the app
  MUST NOT replace a report it has not read with a stand-in.
- A verdict MUST be a single fenced block tagged `distill-verdict` whose
  `verdict` is exactly one of `accept`, `revise` or `needs-operator`.
- An answer to a digest that carries no readable verdict MUST leave the wave
  undecided and MUST offer the operator the ability to ask again.
- A root request MUST NOT spend more than two revisions.
- `accept` MUST NOT be honoured for a wave that produced something checkable
  and was not checked by a verification step.
- `accept` MUST NOT be honoured when the reports named artifacts that are not
  on disk.

## Transparency

- Every surface that says an agent is working MUST offer a way into that
  agent's own chat.
- An agent's chat MUST show the agents it started, at every depth.
- A wave's executors MUST be attributable to the wave that spawned them
  wherever more than one wave is shown together.
- The app MUST NOT substitute a model for the one a step named without saying
  so where that step is shown.
- The app MUST NOT retry a failed step without the operator asking for it.
- A step whose prompt the provider refused as rate-limited before its agent did
  anything is not a failed step: it MUST be shown as waiting for the provider,
  not as failed.
- A step whose executor the app itself ended — a restart under a running
  session — is not a failed step: the app MUST resume it once in a new
  session, MUST hand that session what the ended one last said, and MUST say
  in the step's brief and to the operator that it was resumed.
- Wherever an agent is shown as stopped or cancelled, the app MUST say who
  stopped it and why when it knows.
- Every notice the app shows the operator in a conductor's chat MUST also reach
  that conductor, unless the conductor receives the same facts in a digest or
  a note.
- The app MUST record, for every wave, the sequence of transitions it observed,
  and that record MUST be readable without the application running.

## Concurrency

- A conductor MAY have several live waves at a time; each MUST keep its own
  digest and its own verdict.
- The app MUST bound how many of one conductor's waves are live at once, and a
  plan admitted past that bound MUST be queued in order and said so — never
  dropped and never refused in silence.
- A wave MUST be live while it is spawning, waiting on a digest, or waiting on
  a verdict, and MUST NOT be live once it is accepted, superseded, parked for
  the operator, or still queued.
- A step MUST be dispatched at most once per attempt: a record that a session
  already runs the step MUST make that session the step's executor, never a
  second worker beside it.

## Goals

- While a conductor's roadmap says its goal is in progress, the app MUST
  follow every accepted wave with a request to continue toward the goal, and
  MUST stop doing so when the conductor declares the goal reached, paused, or
  in need of the operator — or answers without a plan.
- The roadmap MUST survive an app restart and MUST be shown to the operator
  whenever it changes.

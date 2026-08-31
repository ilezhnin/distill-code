---
name: orchestrate
description: Distill conductor loop — classify the operator request, answer it directly or plan one distill-wave, let Distill spawn the workers, then read the digest and close the loop with a distill-verdict. Use when coordinating a stage, handing out work, or closing a turn.
metadata:
  berdBundled: true
---

# Orchestrate

You decide and give verdicts. You do not execute product work. You emit one
`distill-wave` fence; Distill spawns the workers **directly under you** —
there is no orchestrator layer between you and them — and brings their reports
back to you as a digest. Do not spawn chats yourself.

## 0. Weight the request

| Task | Path |
|---|---|
| One specialist, one zone | A wave of exactly one step — that is what "one child" is |
| Several independent tasks | One wave, one `access:[]` step per task |
| A stage that needs a plan first | A planning step first, later steps `access:"all"` |
| Unity map / unfamiliar area | Unity Explorer + `unity-orient` |
| Unity C# change | Unity Worker + `unity-implement` |
| Unity review | Unity Reviewer + `unity-review` |
| Unity tests / compile | Test Runner + `unity-validate` |
| Game or feature design | Designer + `gdd` |
| Assets | Asset Scout, then Artist, then Asset Integrator |
| Game milestone | Producer + `game-pipeline` |

A task with no matching role gets a role added to Agents, not the strongest model.

## 1. Know the before

If the work can move a number, record the before number. Without it, a later "after" cannot be attributed.

## 2. Handing out

- Pick roles from the Distill Agents catalog. Producer and Planner coordinate. Brigade implements generic code. Unity Worker implements Unity C#. Scout checks facts. Unity Explorer maps a Unity tree. Acceptor verifies. Adversary hunts residual defects. Unity Reviewer reviews Unity diffs.
- Parallel crews never share files.
- Contracts between zones are written before launch.
- Before handing out, check the work is not already done.

## 2a. Wave plans — worked examples

In a Distill conductor chat, work is dispatched as exactly one `distill-wave`
fence; the engine spawns the workers and brings their reports back as a
digest. The shapes below are known-good: they parse, they pass admission, and
they carry the two habits that matter — subtasks written for the worker (never
a copy of the operator's request), and a closing verification step whenever
the wave builds something inspectable.

A request that needs no wave stays a direct answer. «What does the retry
helper in src/net do?» — read what you need and answer. Most requests are
this one.

«Find out how axios and got schedule retries, how our src/net/retry.ts
compares, and end with a recommendation»:

```distill-wave
{"steps":[{"role":"researcher","subtask":"Read src/net/retry.ts and describe its actual behavior: what triggers a retry, the backoff shape, the caps, which error classes are retried. Cite file and line for every claim.","access":[]},{"role":"researcher","subtask":"Establish how axios and got schedule retries: defaults, backoff, jitter, caps, and what is configurable. Note which library version each claim is about.","access":[]},{"role":"researcher","subtask":"From the earlier reports, write a comparison and one concrete recommendation for src/net/retry.ts: what to keep, what to change and why. Flag any point on which the reports disagree instead of papering over it.","access":"all"}]}
```

Parallel research with disjoint context, then a synthesis that waits for all
of it. Nothing here is a checkable artifact, so there is no verification
step — and the synthesis is framed as researcher, because an artifact-stage
role like writer would rightly demand one.

«Rename the config flag enableFoo to enableBar everywhere and keep the build
green»:

```distill-wave
{"steps":[{"role":"brigade","subtask":"Rename the config flag enableFoo to enableBar: the definition, every call site, config files and docs. Keep the change mechanical; do not refactor around it.","access":[]},{"role":"acceptor","subtask":"Verify directly: run the build and the tests nearest the flag, search the repo for the old name and confirm the only remaining hits are historical (changelogs). Report the commands you ran and what they printed.","access":"all"}]}
```

The work is checkable, so the last step inspects the artifact itself — the
build, the tests, a search — never just the other step's report.

## 2b. One child is a wave of one step

There is no separate way to start a single agent. "Give this to a specialist"
is a `distill-wave` fence with exactly one step. Everything else — the chip,
the report, the digest, the verdict — works the same as for five steps.

## 3. Accepting a delivery

- Diff the named zone. Anything forbidden touched?
- Did a second owner of a fact appear?
- Run the newest claim's negative control when the assignment requires it: break, show red, restore.

## 4. Close the loop with a verdict

When every step is terminal, Distill delivers you a digest of the workers'
`distill-report` blocks as a real message. Answer it with exactly one
`distill-verdict` fence:

```distill-verdict
{"verdict":"accept","note":"one line for the operator"}
```

The verdict word is exactly one of three, and no other word is accepted:

- `accept` — the results answer the request. The prose outside the block is
  what the operator reads as the answer, so write the answer there. If the
  wave produced something checkable, accept only on the verification step's
  evidence — a checkable wave that was not checked is `needs-operator`.
- `revise` — one more wave is needed. Emit the `distill-verdict` block **and**
  a `distill-wave` block with the revision wave in the same message. Revisions
  are capped at two per operator request; do not plan on getting another.
- `needs-operator` — the loop stops and the operator has to look. Say why in
  the note.

A malformed verdict is read as `needs-operator`. There is no auto-retry: a
verdict that does not parse costs the operator a manual button press.

Evidence first. Do not narrate "started", "thinking", or "waiting" to the
operator. The loop ends with a wave launched or with a verdict. If there is no
work, skip the loop — do not build instruments instead of the product.

## 5. After an accept

- Compile what the wave taught into the project wiki with the `project-wiki`
  skill: 1–3 pages plus `index.md` plus `log.md`, and only on `accept`.
- The wiki is written from this loop or by the operator. An executor never
  writes it — its findings reach you in its report.
- A durable lesson about the operator is a memory, kept through a
  `distill-memory` fence. How the project works is a wiki page, not a memory.

## Long-running background work

Never end a turn with a promise to report later ("I'll assemble the summary
when the workflow finishes"). This app has no mechanism to wake you when
in-harness background work (workflows, background tasks) completes, so such a
promise cannot be kept and the operator is forced to ask manually.

Do one of these instead:
1. Stay in the turn: poll the background work (task output, workflow journal)
   until it completes, then deliver the summary in the same turn.
2. If polling is impractical, end with an explicit handoff: "Работа идёт в
   фоне; результат сам не придёт — напиши «ну как?», когда захочешь итог."

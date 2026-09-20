---
name: providers
description: Model routing for Distill — how a wave step gets its model, effort and fast mode, when the conductor may name them explicitly, and why an unavailable one refuses the plan instead of quietly downgrading it. Use before every worker launch, when writing a wave plan, and on any capacity error.
metadata:
  distillBundled: true
---

# Providers

Distill owns spawning. This skill is the check you run before work starts in an assigned session.

## 1. Where a step's model comes from

Three layers, in this order:

1. **Inheritance.** A wave child inherits the conductor's harness and model.
   This is the default and needs no words in the plan.
2. **The role's ranking.** If the persona for the step's role has a model
   ranking, Distill resolves it against the live inventory and rate limits and
   picks the target — a model, and often the effort and fast mode to run it
   at. This layer is a *preference*: a missing persona, an empty inventory or
   a store that throws all mean "no opinion", and the step inherits. A
   preference never stops a session.
3. **The plan's explicit fields.** A step in a `distill-wave` fence may carry
   `"model"`, `"effort"` and `"fast"`. These are the only legal way to choose
   them from the plan, and they are *instructions*, not preferences.

## 2. The explicit `model` field

```json
{"role":"brigade","subtask":"…","access":[],"model":"opus"}
```

Name a model when you have a **reason from observed facts** — this model/role
pair has been failing the format, this step is the kind that measurably needs
the strong model, this class of work has been cheap and reliable on the small
one. When Distill supplies a facts ledger in the protocol prompt, that is the
source; until then, only what you have actually seen in this session counts.
Availability is not a reason, and neither is reputation. "The strong one is busy, so I will name the weak
one" is exactly the substitution this field exists to prevent.

An instruction has exactly two honest outcomes, and Distill enforces both:

- **Applied and visible** — the chip carries the model as a suffix, so the
  operator can see it without opening anything.
- **Refused with the reason** — if the named model is not installed, cannot be
  built into a target, or the store throws, the whole plan is rejected with
  `step-model-unavailable` and the step number. Nothing spawns. No step
  silently falls back to an available model.

So an unavailable model costs you the plan, not the quality. If you are not
sure a model is installed, do not name it — inherit.

## 3. Effort and fast mode are separate fields

A model, how hard it reasons, and whether it runs in fast mode are three
separate choices. Write them as three fields:

```json
{"role":"brigade","subtask":"…","access":[],"model":"gpt-5.6-sol","effort":"xhigh"}
```

- `"effort"` is the model's own effort word — commonly `low`, `medium`,
  `high`, `xhigh`; some models also offer `max` or `ultra`. Omit it and the
  step runs at its role's ranked effort, or the model's default.
- `"fast"` is `true` or `false`. Omit it unless speed matters more than cost
  for the step.
- Never put the effort inside the model name. `"model":"gpt-5.6-sol[xhigh]"`
  is an old shape: Distill still runs it, split into model and effort, and
  posts a notice asking for two fields. A step's own `"effort"` wins over one
  written inside the name. `opus[1m]` is not an effort — `[1m]` is part of
  that model's id and is never split.

The same two honest outcomes apply. A step naming an effort its model does
not offer, or `"fast": true` on a model without fast mode, refuses the whole
plan with `step-run-settings-unavailable`, and the refusal names the efforts
the model does offer. A value the role's ranking chose that the picked model
cannot honour does not refuse anything — the ranking is a preference — but the
step says so in a notice.

## 4. No silent substitution, in either direction

Never work on a different model than the one you were assigned, and never
choose a weaker one because a stronger one is busy. If the assigned model is
unavailable, stop and report it: Distill will refuse the plan or the operator
will change the target. A silent downgrade makes every later measurement and
every post-mortem impossible, which is why it is a protocol violation and not
a judgement call.

A step whose model is weaker than the inherited target is allowed, but it is
worth saying why in the subtask: a small model under a JSON format constraint
loses a lot on hard work, and the loss shows up as a broken fence, not as a
worse answer.

## 5. Record the route

Before real work:

```text
ROUTE role=<role> harness=<id> model=<id or default> effort=<value or default> fast=<on | off | default> fallback_reason=<none | exact refusal>
```

Working silently on a different model, effort or speed is forbidden.

## 6. Delivery

- Pass the spec as content, never as "read the plan file."
- Several specialists on one task: separate roles, separate Distill sessions. Never copy a full history between them.

## 7. Capacity

If the harness returns rate limit, capacity, or auth failure: report the exact error and stop that session. Do not shop for a random model. Distill or the operator chooses the next target.

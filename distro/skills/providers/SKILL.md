---
name: providers
description: Model routing for Distill — how a wave step gets its model, when the conductor may name one explicitly, and why an unavailable model refuses the plan instead of quietly downgrading it. Use before every worker launch, when writing a wave plan, and on any capacity error.
metadata:
  berdBundled: true
---

# Providers

Distill owns spawning. This skill is the check you run before work starts in an assigned session.

## 1. Where a step's model comes from

Three layers, in this order:

1. **Inheritance.** A wave child inherits the conductor's harness and model.
   This is the default and needs no words in the plan.
2. **The role's ranking.** If the persona for the step's role has a model
   ranking, Distill resolves it against the live inventory and rate limits and
   picks the target. This layer is a *preference*: a missing persona, an empty
   inventory or a store that throws all mean "no opinion", and the step
   inherits. A preference never stops a session.
3. **The plan's explicit `model`.** A step in a `distill-wave` fence may carry
   `"model":"<id>"`. This is the only legal way to override a model from the
   plan, and it is an *instruction*, not a preference.

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

## 3. No silent substitution, in either direction

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

## 4. Record the route

Before real work:

```text
ROUTE role=<role> harness=<id> model=<id or default> fallback_reason=<none | exact refusal>
```

Working silently on a different model is forbidden.

## 5. Delivery

- Pass the spec as content, never as "read the plan file."
- Several specialists on one task: separate roles, separate Distill sessions. Never copy a full history between them.

## 6. Capacity

If the harness returns rate limit, capacity, or auth failure: report the exact error and stop that session. Do not shop for a random model. Distill or the operator chooses the next target.

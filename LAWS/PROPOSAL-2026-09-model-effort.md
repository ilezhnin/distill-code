# Proposal: laws touched by separate model, effort and fast selections

**This file is not a law.** It is a proposal for product review, kept apart
from the code change it follows. LAWS/README.md prescribes no form for
proposals; this one names the law files it would change and quotes the text.
Delete this file once each item below is decided, and apply the adopted
wording to the law file it names.

**No law change is required for the code to be correct.** The code already
implements the stricter behaviour in item 1, item 2 describes a conflict that
predates this work, and item 3 is an open question the code answers
provisionally. The new wave step fields `effort` and `fast` are deliberately
not proposed as laws: LAWS/README.md says fields and other changeable feature
policy MUST NOT be written as laws merely because they are settled.

Context: a chat now runs on four independent selections — provider, model,
reasoning effort and fast mode. An effort is no longer folded into a model id
(`gpt-5.6-sol[xhigh]`). The design is in `docs/model-effort-fast-selection.md`.

## 1. LAWS/WAVES.md — extend the substitution clause to reasoning effort

Current text (Transparency):

> The app MUST NOT substitute a model for the one a step named without saying
> so where that step is shown.

Proposed text:

> The app MUST NOT substitute a model, or a reasoning effort, for the one a
> step named without saying so where that step is shown.

Why: a step can now name an effort next to its model. Bridges downgrade an
effort silently — codex clamps to the model's default, Claude drops to
`default` after a session passes through Haiku — which is the same silent
substitution the clause forbids for models. The code already refuses a plan
whose step names an effort its model does not offer, and shows a notice on
the step when a ranking's effort cannot be honoured, so it conforms whether
or not this is adopted.

## 2. LAWS/AGENTS.md — agents configured by a model ranking

Current text:

> An agent MUST have a configured provider and model before it can be invoked.

Proposed text:

> An agent MUST have a configured provider and either a model or a model
> ranking before it can be invoked.

Why: this conflict predates the effort work. Every live persona file carries
only `model_ranking: <class>` and no `model`, and those agents are invoked
today, so the current law contradicts the product as used. Rankings now also
carry an effort and fast mode per entry, which makes a ranking a complete
configuration rather than a partial one.

## 3. LAWS/CHAT.md — open question: are effort and fast pinned to a queued message?

Current text (Queue acceptance and dispatch):

> The selected chat's queue MUST retain the message and persona intent most
> recently accepted from the composer or a user edit.

The law says nothing about the effort and fast mode in force when a message
was queued. Two readings are possible:

- **Read at dispatch (today's behaviour).** A queued message runs at the
  chat's effort and fast mode when it is sent. Changing the effort while
  messages wait changes how they run.
- **Pinned at queue time.** A queued message runs at the effort and fast mode
  that were in force when it was accepted, even if the operator changes them
  before it is sent.

What the code does until this is decided: it reads them at dispatch, and each
queued record also carries the values in force when it was queued
(`payload.runSettings`), kept across text edits and workspace deferral. The
record is not yet an instruction; making it one needs the send path to pass a
queued message's own settings to the target transition, which is a small
change but not a one-liner.

If the product chooses to pin, a candidate law:

> A message in a chat's queue MUST be dispatched with the reasoning effort and
> fast mode that were selected when it was accepted.

If the product chooses dispatch-time, no law is needed: that is today's
behaviour and not an invariant worth canonising.

## Affected law files

- LAWS/WAVES.md (item 1)
- LAWS/AGENTS.md (item 2)
- LAWS/CHAT.md (item 3, only if pinning is chosen)

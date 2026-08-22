---
name: grill
description: Interrogate the operator before an expensive or irreversible decision — one question at a time, each with a marked recommendation, until a decision protocol. Use on "grill", "stress-test this decision", and before ratifications or other permanent choices.
metadata:
  berdBundled: true
---

# Grill

Goal: reach shared understanding BEFORE a decision becomes expensive or permanent. Do not implement. Do not agree for the sake of pace. Do not write the final plan while important forks are open.

## Before the first question

Build the baseline yourself — do not ask what the repository already answers. A question about a fact a command can find is a wasted question. If a baseline fact is missing and it changes the branch of the interrogation, ask up to three short preamble questions at once — the only exception to one-at-a-time.

## The question cycle

- One question at a time; the next depends on the answer; dead branches are dropped.
- Offer 2–3 mutually exclusive options with the recommendation first and marked. A menu without a recommendation means missing data — go get it.
- "Whatever is best", "sounds fine", and silence are not answers: re-ask as a concrete choice.
- If the operator's answer contradicts the code, the documents, or an earlier decision, name the contradiction with evidence.
- Do not re-offer a rejected recommendation — update the model instead.

## Convergence

When you can predict the operator's answers to the next three questions, offer the protocol instead of the next question. After about ten questions or two refusals in a row — also the protocol.

## Game and Unity coverage

When the work is a game or Unity change, close only the branches it actually touches:

- Player value and game-loop fit.
- Scope: in, out, deferred, prototype-only.
- Ownership: module, scene, prefab, ScriptableObject.
- Unity lifecycle, serialization, and fail-loud behavior.
- Assets: reuse vs source vs generate; license; `asset-pipeline` if needed.
- Determinism / save / network if the change can touch them.
- Verification: compile, EditMode/PlayMode, or a named manual gap.

## Decision protocol

1. Confirmed decisions.
2. Out of scope — what we explicitly do NOT do. Mandatory.
3. Open questions, if any remain.
4. Rejected alternatives and why.
5. Risks and how to notice them.
6. Order of actions and how each is verified.

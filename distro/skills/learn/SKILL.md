---
name: learn
description: Turn one concrete failure, operator correction, or successful technique into a durable Distill rule — deciding whether it belongs in a skill, an agent, memory, or nowhere. Use after a mistake, a review finding, or when the operator says "remember this".
metadata:
  berdBundled: true
---

# Learn

Turn one concrete event into a rule without littering Distill with one-off notes. First decide whether this is a real lesson.

## Procedure

1. Collect the evidence: what happened, what proves it.
2. Phrase it: "When <context> — do <behaviour>, because <cost/risk>."
3. Choose one store, by weight:
   - A Distill skill under Skills, when the lesson is a procedure every agent should be able to load.
   - A Distill agent under Agents, when the lesson is about one role's method.
   - The project's `AGENTS.md`, when every future session in that repo needs the rule.
   - `.agents/learnings.md` in the project, for a dated narrower lesson.
   - The operator's memory or global hints, when it is a preference about how they work.
   - Nowhere, when the evidence is too thin.
4. Apply narrowly. Strengthening an existing rule beats adding a new one.
5. Report:

```text
Lesson: <phrasing>
Recorded in: <path or "not recorded">
Why there: <weight/reach>
Deliberately not recorded: <neighbouring ideas left out>
```

## When not to record

- A one-off fact of the current task.
- A broad preference on weak evidence.
- Secrets, tokens, account limits — never in a shared document.
- A rule that contradicts an existing one — that is a revision, take it to the operator.

---
name: memory-review
description: Consolidate the operator's memories in one careful pass — propose merges, contradictions, stale and overlong lines as a list, then apply only what they confirm through `distill-memory`. Use when the operator starts a review from the Memory panel or asks you to tidy what is remembered.
metadata:
  berdBundled: true
---

# Memory Review

The operator's memories are written into every later prompt on their behalf.
The store already refuses an exact duplicate. What it cannot see is two lines
saying the same thing in different words, two lines disagreeing, or a line that
stopped being true months ago — those only show up when the whole record is
read at once, which is what this pass is.

You are not tidying a list. You are proposing changes to the operator's own
record, and the record is theirs.

## The one rule

Propose first. Apply nothing until the operator confirms it, line by line.

A consolidation that edits while it reasons is a silent rewrite of what someone
else decided to keep. If you are unsure whether something counts as confirmed,
it does not.

## 1. Propose

Read the whole record, then answer with a list and nothing else. Four
categories, in this order:

1. **Duplicates and near-duplicates** — which lines say the same thing, and the
   one wording they should become. Prefer the operator's own words over yours.
2. **Contradictions** — which lines disagree, and which of them is the live
   fact. Say what makes you think so; dates are evidence, not proof.
3. **Stale** — what is no longer true and should be dropped. A fact nobody has
   restated in a long time is a question, not a verdict.
4. **Too long, or carrying more than one fact** — how to split it. Every memory
   is re-read on every future turn, so a line that says two things costs twice
   and can only be half-corrected.

Name every line you touch by quoting it. Say nothing about lines you are
leaving alone — a review that lists the whole record back is not a review.

## 2. Apply

Only after the operator confirms, and only what they confirmed.

```distill-memory
{"remember": [{"text": "The release branch is release/2026.9", "scope": "project"}], "forget": ["The release branch is now 2026.9"]}
```

- A merge or a correction is one block: the old wording under `forget`, the new
  one under `remember`. Split across two turns, the fact is briefly gone.
- At most **5 changes per reply**. Work in batches and say which batch this is.
- `scope` is `project` (the default) or `global`. Never widen a project fact to
  global as part of a tidy-up — that is a new decision, and it is the
  operator's.
- A chat with no project can only apply changes to global memories. Propose the
  project-scoped ones anyway, and say they have to be applied from a chat inside
  that project.

## Never

- Never restate a secret. If a line looks like it carries a key, token or
  password, say only its shape and that it should be deleted from the panel —
  do not quote it, and do not "fix" it by rewording it.
- Never delete. `forget` retires a line into the archive, where the operator can
  still reach it. Destroying one is a button on their page, not a fence.
- Never touch what was not confirmed, including a line you are certain about.
- Never invent a memory during a review. New facts come from work, not from
  tidying.

## Finish

One short line: how many merged, how many retired, how many left for the
operator to apply elsewhere, and anything you deliberately left alone.

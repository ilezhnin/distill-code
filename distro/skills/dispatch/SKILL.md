---
name: dispatch
description: Spec template for handing a bounded task to a Distill agent — zone, sized cards, closed decisions, bounds as prohibitions, and the direct question the report must answer first. Use whenever Distill starts a worker or orchestrator.
metadata:
  berdBundled: true
---

# Dispatch

The role comes from the Distill Agents catalog. The agent already has its instructions. The spec carries only the task. Do not repeat the role text.

## Skeleton — order matters

1. **Header**: project or working folder, role, and whether this is a coordinator or a worker.
2. **Read first — by name.** An agent does not read a document nobody named.
3. **Zone**: owns / does not touch — a table by file. Parallel crews never share files.
4. **Batch**: cards with sizes (XS 1 · S 2 · M 3 · L 5 · XL 8). Budget 15–20 points. Coarse strokes: zone, result, bounds. The mechanism is the worker's.
5. **Decisions closed in advance**, each with a reason. The order is not truth — verify against primary sources, report mismatches, do not execute a false fact literally.
6. **Bounds as prohibitions**, plus mandatory non-goals.
7. **The direct question** whose answer is the report's first line — one that cannot be answered by retelling.
8. **Proof**: before -> after numbers; every new check with its negative control.
9. **Report format** + "Mismatches" (mandatory even if empty).

## What a spec must not contain

- A mechanism instead of a result.
- A link to a file with the instruction instead of the instruction.
- "Use judgement" forks and "check quality" without a criterion.
- Two hundred lines where twenty suffice.

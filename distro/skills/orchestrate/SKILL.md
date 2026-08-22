---
name: orchestrate
description: Distill conductor loop — classify the operator request, pick roles from the Agents catalog, let Distill spawn orchestrators and workers, accept deliveries by evidence, and close the turn with a distill-report. Use when coordinating a stage, handing out work, or closing a turn.
metadata:
  berdBundled: true
---

# Orchestrate

You decide and give verdicts. You do not execute product work. Distill starts child agents from the Agents catalog. Do not spawn chats yourself.

## 0. Weight the request

| Task | Path |
|---|---|
| One specialist, one zone | Distill starts that worker |
| Several independent tasks | Distill starts one orchestrator per task, each with a worker |
| A stage that needs a plan first | Distill starts Planner, then workers |
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

## 3. Accepting a delivery

- Diff the named zone. Anything forbidden touched?
- Did a second owner of a fact appear?
- Run the newest claim's negative control when the assignment requires it: break, show red, restore.

## 4. Close the turn

Evidence first. Distill collects worker `distill-report` blocks and shows the operator the answer, stats, and named agents. Do not narrate "started", "thinking", or "waiting" to the operator.

The loop ends with work launched or with a verdict. If there is no work, skip the loop — do not build instruments instead of the product.

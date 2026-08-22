---
name: game-pipeline
description: Run the game delivery pipeline over approved GDD milestones through define, plan, assets, one cross-agent execute loop, and policy-compliant local delivery. Use when the user asks to build a game or feature end to end, run or resume a pipeline stage or milestone, check pipeline status, prepare milestone assets, or execute an approved GDD. Simplification is a required late execute subgate before final validation and review.
metadata:
  berdBundled: true
---

In Distill, Distill starts child agents from the Agents catalog. Do not spawn chats yourself. Load Distill skills by name (unity-implement, planning, grill) instead of kit `$skill` syntax.


# Game Pipeline

## Goal

Execute an approved game-design contract milestone by milestone without nesting duplicate orchestrators. The pipeline owns milestone state; `crossworking` owns each milestone's single implementation-to-review execute loop.

## Entry Gate

Check before any stage:

- Select the GDD recorded in `.agents/plans/pipeline.md`. When starting a run, locate the intended `.agents/plans/*-gdd.md`; if several candidates exist and context does not identify one, ask instead of guessing.
- Approval binds to the GDD file plus explicit user confirmation of material changes; typo-level edits do not invalidate approval. Do not record a content hash.
- Require evidence that the GDD was grilled and approved by the user. If missing, route to `$gdd` and stop.
- Default to stage mode. Milestone and auto modes run only when named in the current request.
- Record the baseline (base SHA; checkout clean or dirty with worktree path), task-owned paths, approved GDD, and chosen mode before a writer starts.

## Stages

| # | Stage | Skills | Lead role | Gate |
| --- | --- | --- | --- | --- |
| 1 | Define | `$gdd` | game-designer | Selected GDD grilled and approved by the user |
| 2 | Plan | `planning`; `grill` only for unresolved risk | planner | No blocking questions |
| 3 | Assets | `asset-pipeline` when required | asset-scout, asset-creator, unity-asset-integrator | Approved assets/brief or explicit no-asset result |
| 4 | Execute | one `crossworking` run | unity-worker, unity-test-runner, unity-reviewer, qa | Post-simplification focused recheck, validation, review/fix, and acceptance subgates green on one final git tree SHA; the earlier baseline is simplification entry evidence |
| 5 | Prepare delivery | `create-mr` to finalize the local task branch; `unity-build` only for an explicitly requested player build | pr-submitter; devops only for the requested build | User-style commits remain on the agent's own local task branch; no unauthorized remote action |

`simplify-change` is mandatory inside Execute after the focused baseline and before final validation/review. A recorded no-op passes when no safe evidence-backed simplification exists.
Every accepted review or validation fix scales its rerun to the fix: re-enter simplification only if the fix added code, and revalidate only the affected checks.

During Assets, the parent owns the asset brief and schedules scout, creator, and integrator sequentially for persistent writes as required by `asset-pipeline`; the listed roles are not concurrent writers.

The producer updates state and enforces gates but cannot change approved scope. Scope cuts are proposals until the user approves the revised GDD.

## Execute Subgates

For every milestone, `crossworking` reports distinct evidence for:

1. Implementation complete on task-owned paths.
2. Focused behavior/compile entry baseline for simplification.
3. Simplification result, production-complexity balance, and focused recheck.
4. Final Unity validation, exact editor version, and the validated git tree SHA.
5. Independent review plus resolved blocker IDs.
6. Acceptance: `qa` checks the milestone against the GDD's acceptance criteria - through
   `unityMCP` PlayMode where its tools support the scenario; every unsupported scenario becomes a
   concrete manual checklist item handed to the user, never a silent pass.

Do not invoke another Test or Review workflow after a successful Execute gate; those checks already belong to the one crossworking loop. Run the pipeline's single Prepare delivery stage only when the selected mode includes it.

Prepare delivery first finalizes the local task branch (final commit tree equals the reviewed candidate). If a player build was explicitly requested, `unity-build` then builds that exact commit from a separate clean detached linked worktree with the exact-editor and git-status guard from `unity-validate`. It may not make any repository change at this stage. If the build bounces the delivery, fix in Execute, commit in the same style, then rerun the requested player build from a fresh detached linked worktree. Prepare delivery is not green until that build and its mutation guard pass.

## State

Use `.agents/plans/pipeline.md` as the resumable run state. Follow `references/pipeline-state.md`. Chat memory, a commit, or a screenshot alone is never stage evidence.

## Modes

- **Stage:** run one current stage, record evidence, report, and stop.
- **Milestone:** run Plan, Assets, and Execute for one named milestone. Stop with a validated/reviewed milestone unless the current request explicitly names it as a delivery unit.
- **Auto:** loop Plan, Assets, and Execute until the approved MVP checklist is complete, then run Prepare delivery once for the whole MVP.
- In milestone and auto modes, before starting each next milestone, run one read-only `oracle` pass over the GDD, `pipeline.md` decision log, and the next plan; contradictions or scope drift become blockers before implementation, not review findings after it.
- **Explicit delivery:** run Prepare delivery for the named validated unit. `create-mr` prepares the required local task-branch commit and stops; any push or PR needs a separate direct request and compatible policy.

A prepared milestone delivery is terminal for that local task branch. Before another milestone can enter Plan/Execute, the user must integrate or otherwise ratify the delivered commit, record the resulting branch/SHA as a fresh base, and start a new local task branch/worktree. Never stack a second milestone commit on the delivered task branch or silently rewrite/rebase it.

## Stop Conditions

Stop, record the blocker, and surface it when:

- The selected GDD is missing, unapproved, or materially changed since approval without user confirmation.
- The plan has blocking questions or implementation would exceed approved scope.
- Any task-owned path overlaps pre-existing staged, unstaged, or untracked work; do not infer ownership at hunk level.
- A non-Execute stage fails twice for the same cause. Execute retries and stop limits belong only to `crossworking`; the pipeline accepts its green or blocked result without a second counter.
- Validation fails for an unexplained or out-of-scope reason.
- A structural decision conflicts with project contracts.
- Required assets, provenance, packages, credentials, or user decisions are missing.
- Any `crossworking` stop condition fires.

## Rules

- Never skip a gate because a change looks small.
- Every milestone ends playable: real compile/console evidence, clean relevant logs, and reachable acceptance behavior.
- Store stage-specific evidence. A screenshot cannot prove compilation or automated tests; a commit cannot prove review.
- Later task-content edits invalidate validation/review evidence until rerun on the new git tree SHA; commits that preserve the tree do not.
- Auto mode never invents scope. Put new ideas into Later; require user approval for MVP cuts or additions.
- Do not use checkpoint commits as gate evidence.
- Invoke `create-mr` in Prepare delivery to finalize the local task branch. Push and PR/MR actions still require a fresh direct user request and compatible repository policy.
- After a separately delivered milestone, stop the pipeline until the user provides or confirms the new integrated base; continuation uses a fresh task branch/worktree and a new baseline record.

## Exit Criteria

Report the selected GDD path, milestone/stage, gate evidence, tree SHA when one gates delivery, updated state path, and next allowed action or blocker. Mention a commit, build, or PR only when it actually exists.

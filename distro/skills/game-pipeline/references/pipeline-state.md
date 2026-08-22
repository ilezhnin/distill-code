# Pipeline State Format

`.agents/plans/pipeline.md` is the resumable state of one active pipeline run.

```markdown
# Pipeline: <Game / Feature Title>

- GDD: .agents/plans/<slug>-gdd.md
- Approval: <date and user decision reference>
- Base branch: <branch>
- Baseline: <base SHA>; checkout clean | dirty (worktree: <path>)
- Task-owned paths: <explicit path list>
- Mode: <stage | milestone | auto>
- Current: <M2 / Execute / Simplify>
- Source HEAD: <primary task-branch HEAD when candidate was materialized>
- Candidate tree SHA: <reviewed `git write-tree` value, or pending>
- Delivery boundary: <local handoff only | repository-mandated local task-branch commit | exact user-authorized remote actions>

## Milestones
| Milestone | Plan | Assets | Implement | Simplify | Validate | Review |
| --- | --- | --- | --- | --- | --- | --- |
| M1 <name> | done | done | done | done (no-op) | done | done |
| M2 <name> | done | in progress | - | - | - | - |

## Delivery
- Unit: <M1 | MVP | none>
- State: <not requested | ready | local branch finalized | blocked>
- Commit/build/PR: <actual identifier or none>
- Continuation: <not applicable | terminal on this task branch; awaiting user-ratified integrated base>

## Blockers
- <none, or: blocker - owner - decision needed>

## Decision Log
- <date>: GDD approved by user; mode = <mode>
- <date>: <proposed scope change approved/rejected>

## Stage Records

### M2 / Execute / Simplify
- Result: <changes or justified no-op>
- Production-code balance: <lines/concepts removed or retained>
- Focused recheck: <exact command and result>
```

## Evidence Contract

The candidate/commit tree SHA is the sole evidence ID. Record the latest command and result directly in `pipeline.md` for each stage; do not keep separate evidence archives.

- **Define:** selected GDD path, grill result, and explicit user approval.
- **Plan:** plan path, no unresolved blocking questions, exact verification commands.
- **Assets:** asset brief with provenance/import evidence, or explicit no-asset result tied to the milestone.
- **Implement:** task-owned paths, implementation summary, and real compile/behavior baseline.
- **Simplify:** changes or justified no-op, production-complexity balance, and focused recheck.
- **Validate:** required Unity version, exact commands/results, logs or console evidence, metadata check when assets/.meta changed, and the validated git tree SHA.
- **Review:** reviewer role, complete `base..candidate-tree` scope, finding IDs/status, and the same tree SHA.
- **Prepare delivery:** full-path staging only, index tree and post-commit tree both equal to the reviewed candidate tree SHA, identity check, actual local commit/build identifier, requested-build exact delivery HEAD plus detached linked-worktree proof and commit-tree equality, exact Unity version, unchanged protected-content/status postflight, and exact authorization for any remote action.

A screenshot supports visual acceptance only. A commit proves repository state only. Neither substitutes for compile, tests, or review.

## Rules

- One row per milestone. Cells are `-`, `in progress`, `done`, `done (no-op)`, or `blocked`.
- A material edit to the GDD invalidates approval until the user confirms it; typo-level edits do not.
- Any candidate-tree or task-content change after validation/review invalidates those gates until rerun; a commit whose tree equals the reviewed candidate tree does not.
- Blockers are append-resolved, not silently deleted.
- Assets may be `done` with an explicit no-asset result.
- Commits mark completed coherent changes in the user's commit style on the agent's own local task branch; never checkpoint commits for pipeline stages, never commits on user branches, never any remote action without the user's direct order.
- A separately delivered milestone is terminal for its task branch. Resume later milestones only from a fresh recorded base and fresh local task branch/worktree after user integration or explicit ratification; never append another milestone commit to the delivered branch.
- The decision log is append-only; tables and current-state fields may be rewritten.
- The file is gitignored working state, not repository documentation.

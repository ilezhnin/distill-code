---
name: crossworking
description: Coordinate a planned Unity task across agents through workspace baselining, implementation, focused baseline validation, behavior-preserving simplification, final validation, independent review, and a verified local handoff on the agent's own local task branch with no remote actions. Use when the user asks for crossworking, teamwork, multi-agent execution, parallel workers/reviewers/testers, running an existing `.agents/plans/active_plan.md`, or executing one game-pipeline milestone. Use unity-codebase-audit instead for a read-only Unity project or module audit.
metadata:
  berdBundled: true
---

In Distill, Distill starts child agents from the Agents catalog. Do not spawn chats yourself. Load Distill skills by name (unity-implement, planning, grill) instead of kit `$skill` syntax.


# Crossworking

## Goal

Produce one final task diff that is implemented, simplified, validated, and independently reviewed. The parent owns decisions and scope; one writer edits; specialized agents inspect and verify. Stop at a verified local handoff; delivery belongs to the caller or a separately authorized workflow.

## Required State

Read `.agents/plans/active_plan.md` and `.agents/plans/task_list.md`. Before any writer starts, record in the plan or scoped handoff:

- Starting branch and base SHA.
- Initial staged, unstaged, and untracked paths.
- Task-owned paths and known pre-existing user changes.
- Acceptance criteria and exact baseline/final checks.
- Delivery boundary: verified handoff only. Record any separately authorized follow-up action for the caller, but do not perform it inside crossworking.

If the plan is missing, stale, or has unresolved blocking questions, use `planning` first. A task-owned path may not already contain user changes, even if hunks look separable; narrow the scope or stop before writing. Require the local task branch to start at the recorded base without unrelated commits. When the primary checkout is dirty, create that task branch in a separate worktree and never switch or carry the mixed primary tree into the task workspace.

## Coordination Rules

- Keep one parent responsible for scope, synthesis, and user communication.
- Use the smallest useful team. Add agents only for independent work with a clear return artifact.
- Scoped briefs: the parent distills the relevant contract lines (architecture/style/plan constraints for the touched paths) plus exact file targets and one deliverable into each subagent brief. Only writing workers load the full AGENTS.md/ARCHITECTURE/CODE_STYLE set; read-only subagents work from the distilled brief.
- Use one writer in a working tree. Parallelize implementation only in isolated worktrees with disjoint paths.
- Give reviewers the complete task diff and repository state, not the parent's conclusions or candidate list.
- Reviewers run in read-only roles (no Edit/Write/Bash/MCP); give them the complete diff, never the parent's conclusions.
- Bind final validation and review to the candidate's tree SHA (the task branch tip when clean, or the materialized candidate worktree's `git write-tree` SHA when the primary was dirty); record source HEAD separately. Any later candidate-content edit invalidates that evidence.
- Keep `task_list.md` as the execution ledger, including implementation, simplification, validation, review resolution, final scope, and delivery state.
- Commits are allowed only on the agent's own local task branch, only for validated coherent changes, in the user's commit style (AGENTS.md Delivery). Never checkpoint commits for phases, never commits on user branches, never any remote action.
- Do not invoke `create-mr`, push, or open a PR/MR unless the current user request explicitly authorizes those actions and repository policy allows them.

## Team Sizing

- **Small:** parent, one worker, one validator, and one independent reviewer; run roles sequentially when the platform's concurrency limit is lower.
- **Medium:** optional context-builder, one worker, one validator, one independent reviewer.
- **Large/high-risk:** planner, scoped context-builder, one writer at a time, validator, distinct reviewers for genuinely separate risk lanes, then one fixer.
- Add asset roles only when the task needs sourced, generated, or imported assets. Add architect/oracle only for real boundary decisions or long-task drift.

## Execute Loop

1. **Workspace gate**
   - Verify the task branch, base SHA, dirty baseline, task-owned paths, and delivery boundary before editing.
   - Require a clean initial task workspace and index. If the primary checkout was dirty, confirm the task branch lives in a separate worktree and the primary checkout stayed untouched.
   - For Unity work, orient with `unity-orient` only when the area or relevant boundaries are unfamiliar.
   - Use `grill` before implementation when product, lifecycle, persistence, migration, or architecture decisions remain unclear.

2. **Context handoff**
   - For same-session delegation, send a bounded direct prompt with goal, paths, constraints, and validation; do not create duplicate files.
   - When work must cross sessions or platforms, use the `context-builder` role and write `.agents/plans/context-<work-item>.md`.
   - Create `meta-prompt-<work-item>.md` only for a manual/cross-platform handoff; it links to the context file and adds only the next-agent goal.
   - Use the `researcher` role for current external facts and `asset-pipeline` for asset work.

3. **Implementation**
   - When the plan crosses module boundaries or adds public API, get one read-only `architect` consult on the boundary shape BEFORE implementation starts; its findings amend the plan. One pass, no re-consult unless the boundary itself changes.
   - Assign worker-sized tasks from the plan to `unity-worker` with `unity-implement` and `unity-mcp` only as needed.
   - Require: changes made, deliberate non-changes, checks run, failures/skips, and open questions.

4. **Focused baseline**
   - Run the cheapest check that demonstrates the implementation's intended behavior before cleanup. This is simplification entry evidence, not final validation evidence when the cleanup changes content.
   - Do not claim Unity compilation without a real Unity compile or console check.

5. **Simplification**
   - Run `simplify-change` on the completed task diff.
   - Accept a no-op when no evidence-backed simplification exists.
   - Keep the pass task-scoped and neutral or negative in production complexity.
   - Require the skill to rerun the focused check after every accepted simplification batch. That post-simplification result is the focused evidence for the current task-branch state; treat it as provisional until candidate materialization.

6. **Isolated candidate snapshot**
   - When the workspace gate confirmed a clean single-writer task branch, that branch is the candidate: its `git write-tree`/commit tree SHA is the sole evidence ID, and no separate worktree is materialized.
   - When the primary checkout was dirty at baseline, follow `references/candidate-snapshot.md`: materialize a detached worktree from the base plus complete task-owned files only, stage them inside that candidate, and record its `git write-tree` SHA without committing.
   - Do not reuse delivery-grade validation from the shared dirty checkout. Preserve any materialized candidate with unexpected mutations.

7. **Final validation**
   - Use `unity-validate` and `unity-test-runner` against the candidate (the task branch, or the materialized candidate worktree) for exact plan checks.
   - Record commands, results, exact editor version, candidate tree SHA, source HEAD, logs/evidence, and unverified gaps.

8. **Independent review**
   - The parent prepares the complete read-only review packet required by `unity-review`, including base SHA, source HEAD, candidate tree SHA, frozen task paths, and the complete `base..candidate-tree` diff.
   - Assign `unity-reviewer` with `unity-review` explicitly named, the packet path, and fresh repository state. Do not rely only on role skill preloads, because some team/teammate modes do not apply them.
   - Use one reviewer by default. Add parallel reviewers only for distinct high-risk lanes such as serialization/lifecycle, security/data loss, or deterministic networking.
   - Classify findings into blockers, accepted fixes, deferred improvements, and rejected feedback.

9. **Fix loop**
   - Apply accepted fixes through one worker.
   - Re-run `simplify-change` only if the fix added code.
   - Re-run only the validation checks and review scope the fixed files can affect. Stop after three rounds or earlier when no blockers remain.

10. **Verified handoff**
   - Verify the candidate tree SHA, complete task diff from the recorded base, final task paths, validation, review resolution, and unrelated changes.
   - Record whether the diff is ready for the caller's one Prepare delivery stage or a separately requested `create-mr` run.
   - Committing validated coherent changes on the agent's own local task branch is allowed per AGENTS.md Delivery. Never amend/rewrite existing history, push, open a PR/MR, or invoke another delivery workflow inside crossworking.

## Stop Conditions

Stop and ask or report a blocker when:

- Required product, dependency, schema, asset, save, network, or architecture decisions are not approved.
- Any task-owned path contains pre-existing user changes, or the task branch contains unrelated commits after the base.
- Multiple writers would share a working tree.
- Baseline or final validation fails for an unrelated or unexplained reason.
- Simplification would alter behavior or a protected contract.
- Review finds a blocker requiring user approval.
- Final task scope cannot be separated from unrelated work.

## Final Report

Report:

- Diff scope: plan, base SHA, task-owned paths, and pre-existing changes.
- Validation commands and results.
- Review outcome: findings fixed, deferred, or remaining.
- Commit SHA when one exists.
- Unverified gaps. List task-branch commits created (if any); state explicitly that no remote action occurred.

## Reference

Read `references/candidate-snapshot.md` before final validation/review. Read `references/context-handoff.md` only when a durable cross-session or cross-platform handoff is required.

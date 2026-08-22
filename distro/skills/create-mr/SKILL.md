---
name: create-mr
description: Verify the complete task diff and finalize delivery on the agent's own local task branch, or perform explicitly user-authorized push and Pull Request or Merge Request actions when policy permits. Use when the user directly asks to commit/push/open a PR/MR, or when game-pipeline reaches its Prepare delivery stage. Never infer remote-delivery permission from finishing, crossworking, or pipeline completion.
metadata:
  berdBundled: true
---

In Distill, Distill starts child agents from the Agents catalog. Do not spawn chats yourself. Load Distill skills by name (unity-implement, planning, grill) instead of kit `$skill` syntax.


# Create A Delivery Commit Or Pull Request

## Goal

Turn verified task-owned changes into exactly the delivery state the current request and repository policy authorize. For this project, delivery is the agent's own local task branch carrying granular user-style commits (see AGENTS.md Delivery); this skill verifies the branch, commits any remaining validated work, and stops. Squash, merge, file transfer, and any remote action each happen only on the user's direct request.

## 1. Permission And Baseline Gate

Before staging or changing branches, require:

- Delivery trigger: a direct user request, or the recorded game-pipeline Prepare delivery stage. Push and PR/MR always require fresh direct authorization.
- Starting/base branch and base SHA, current local task branch, and intended target branch recorded before implementation.
- Initial dirty paths and explicit task-owned paths, with no pre-existing user change inside any task-owned path.
- A suitable local task branch created from the recorded base before implementation - a branch the agent created, never the base branch, `main`, or any other user branch. Require that branch to be current in its clean-initialized task workspace; if the primary checkout was dirty, delivery must occur from the separate task worktree and never from the mixed primary tree.
- Require every commit between the recorded base and `HEAD` to be a task commit made during this work; any foreign commit blocks delivery.
- Repository delivery rules read and reconciled with the request.

If baseline or scope is missing, reconstruct it from trustworthy records or stop. Do not guess ownership in a dirty worktree.

## 2. Freeze And Verify The Complete Task

- Reuse the isolated candidate tree SHA from `crossworking` when it still matches the current task content. For a direct delivery request without that evidence, materialize the same clean candidate using `crossworking`'s `references/candidate-snapshot.md` before staging anything. A clean working-tree diff is not evidence.
- When crossworking's validation and review evidence matches the current candidate tree SHA, accept it. create-mr itself owns only the secrets scan and the git identity check below; run project checks only when the candidate tree SHA does not match the evidence.
- Scan the complete task diff for secrets and forbidden files. Never include credentials, tokens, keystores, Unity licenses, logs, `Library/`, `Temp/`, build output, or unrelated generated files.
- Verify commit identity before any commit or amend: `git config user.name`, `git config user.email`, `git var GIT_AUTHOR_IDENT`, and `git var GIT_COMMITTER_IDENT`. If identity is missing, configure repository-local values only from an unambiguous dominant existing author; otherwise stop. Always stop on machine-fallback identities.

If final validation cannot run, report the gap. Never convert unverified work into a successful delivery claim.

## 3. Size And Stage

- Measure the complete `base_sha..candidate_tree` diff, not only working-tree changes.
- Flag mixed feature/refactor/format/asset churn to the user; split it across granular commits by type when natural, never across branches.
- Stage every task-owned path in full with `git add -A -- <paths>`. Never hunk-stage or partially stage a reviewed file; any user/task overlap in one path blocks delivery.
- Run `git write-tree` after staging and require the index tree SHA to equal the reviewed candidate tree SHA before committing.
- Run `git diff --cached`, `git diff --check`, and the repository's metadata check before committing.

## 4. Finalize The Local Branch

- Follow the repository's history policy: granular commits, one coherent validated change each, in the user's own commit style (mimic recent `git log`).
- Commit any remaining validated uncommitted work; do not rewrite the existing task-branch history. Squash only when the user directly asks.
- If a post-commit build/check bounces the delivery, fix it with a follow-up commit in the same style.
- Leave all commits on the local task branch. Never commit, merge, rebase, or cherry-pick onto the base/target branch; target-branch integration belongs to the user unless he directly requests it from the agent.
- Use English Conventional Commit subjects. Never add AI attribution.
- Require `HEAD^{tree}` after the final commit to equal the reviewed candidate tree SHA. Record the final commit SHA.
- Stop after the branch is finalized unless the current request explicitly authorizes remote actions and repository policy permits them.
- Treat a finalized delivery as terminal for that task branch. Any later milestone starts from a fresh recorded base and fresh task branch after the user integrates.

## 5. Push Only When Explicitly Authorized

Proceed only when the current request explicitly authorizes this exact push and does not conflict with the repository rule that the task branch is never pushed.

- Confirm the remote and branch immediately before pushing.
- Never force-push unless the user explicitly requests that destructive action and repository policy permits it.
- Report auth or protection failures; do not work around them.

## 6. Open A Pull Request Only When Explicitly Authorized

Determine the target branch instead of guessing. Use an actual task title and this evidence-only body:

```markdown
## Description
<What the change accomplishes and why.>

## Changes Made
- <Concrete task-owned change.>

## Verification
- [x] `<actual command>`: <actual result/evidence>.
- [ ] <Check not run>: <explicit reason>.
```

Never pre-check example commands, invent a result, or invent a PR URL.

## Stop Conditions

Stop when:

- Authorization is absent, ambiguous, or conflicts with repository policy.
- Base SHA, initial dirty state, or task ownership cannot be established.
- Any task-owned path overlaps pre-existing user work, or a foreign (non-task) commit exists between the recorded base and `HEAD`.
- Final validation/review candidate tree does not match the staged index tree and delivered commit tree.
- Identity, credentials, remote, branch, or target branch is invalid.
- Tests/build/Unity compilation fail for an unexplained reason.

## Final Response

Report diff scope, validation result, review outcome, and commit SHA: authorized actions actually completed, branch, local commit hash when created, and skipped/blocked actions with reasons. Report a PR URL only when it exists.

## Reference

Read `references/git-conventions.md` for message format, branch naming, secret checks, and attribution rules.

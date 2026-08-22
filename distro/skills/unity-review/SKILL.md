---
name: unity-review
description: Review Unity and C# changes for correctness. Use when asked to review a Unity diff, PR, branch, or local changes touching .cs files, asmdefs, scenes, prefabs, ScriptableObjects, packages, ProjectSettings, tests, gameplay behavior, editor tooling, serialization, assets, generated art, performance, or Unity lifecycle code. Use unity-codebase-audit instead for read-only whole-project/module audits for code quality, overengineering, bugs, security, silent fallbacks, Unity runtime authoring, rollback/GGPO readiness, or strict determinism when no diff is being reviewed.
metadata:
  berdBundled: true
---

In Distill, Distill starts child agents from the Agents catalog. Do not spawn chats yourself. Load Distill skills by name (unity-implement, planning, grill) instead of kit `$skill` syntax.


# Unity Review Changes

## Overview

Review like a Unity code owner. Default role: `unity-reviewer`. Lead with concrete bugs and regression risks, then mention test gaps and residual risk.

If the user asks to audit existing code without a diff/PR/branch review, route to `unity-codebase-audit` instead. This skill reviews changes; it is not the broad project risk-audit workflow.

## Evidence Entry Gate

This gate applies only to delivery-grade reviews arriving from `crossworking`: require the recorded base SHA, source HEAD, isolated candidate tree SHA, frozen task-owned paths, and pre-existing dirty paths. The complete delivery-grade review scope is `base_sha..candidate_tree` plus the candidate paths themselves.

Direct reviews ("review this diff/branch/PR") scope to the named diff via `git diff`; no candidate tree is required.

When the reviewer is a read-only subagent without shell access, the parent materializes `.agents/plans/review/<review-id>.md` with that metadata, committed/staged/unstaged diff sources, untracked/deleted path inventory, and exact local paths to inspect. The parent writes the packet; the reviewer never does. Stop rather than attest review when any required scope component is missing.

## Review Workflow

1. Verify the complete scope before reading broadly, then read `.agents/ARCHITECTURE.md` and `.agents/CODE_STYLE.md` (plus a project-overlay `ARCHITECTURE.md`/`CODE_STYLE.md` at the repo root when present) so structure and usings are reviewed against the actual contract, not generic habit.
2. Inspect nearby code and assets only when needed to prove or disprove a risk.
3. Prioritize P0/P1 correctness, data-loss, build-breaking, serialization, lifecycle, and performance issues.
4. Include file and line references for every actionable finding.
5. Classify findings by severity: P0 blocks immediately, P1 must fix before merge, P2 should fix now, P3 is optional or follow-up.
6. Do not list stylistic preferences unless they hide a real defect.
7. If no issues are found, say so and name any validation that was not run.

## Quality Gates

- Confirm the change is one coherent unit. Flag PRs that mix feature work, refactors, formatting, generated churn, and unrelated asset edits.
- Review tests before implementation when tests exist. Verify they cover behavior and regression risk, not only implementation details.
- Check validation history: compile, EditMode/PlayMode tests, manual scene/prefab verification, or explicit blockers.
- Prefer existing project patterns and Unity/C# APIs over new abstractions or dependencies.
- Treat new packages, ProjectSettings changes, asmdef dependency changes, and generated files as higher-risk review items.
- Identify newly dead or unreachable code, but do not ask for deletion unless the evidence is clear.
- Do not accept "fix later" for build breaks, data loss, broken serialization, failing tests, or misleading validation claims.
- Re-check touched structure and usings against AGENTS.md Script Organization and .agents/CODE_STYLE.md.
- Flag agent-bloat smells as findings: runtime-built hierarchies a prefab replaces, code-resolved references a serialized field replaces, single-implementation interfaces/factories/events, any fallback or catch-and-continue path (forbidden by standing order), speculative configurability, and comment/doc bloat that restates code or narrates the change.

## Unity Risk Areas

- Serialized field renames without `FormerlySerializedAs`.
- Changed prefab, scene, or asset GUID references.
- New or changed assets without clear provenance, license notes, approved destination, import settings, or placeholder/final intent.
- Runtime assemblies depending on editor-only code.
- New asmdef dependencies that break platforms or create cycles.
- Event subscriptions that leak after `OnDisable`, scene unload, or domain reload.
- Coroutine, async, timer, tween, and cancellation lifetime bugs.
- Allocations or expensive lookup calls in `Update`, `FixedUpdate`, input, and UI refresh loops.
- Physics code that mixes `Update` and `FixedUpdate` incorrectly.
- Input System vs legacy input mismatches.
- Save data, economy, inventory, migration, or versioning regressions.
- Missing EditMode/PlayMode coverage for changed behavior.
- PR size or scope that prevents reliable review.
- New dependencies where standard library, Unity APIs, or existing project utilities would be enough.
- Dead code, stale compatibility layers, unused serialized fields, or obsolete tests left after refactors.

## Output Shape

Use this order:

1. Findings ordered by severity.
2. Open questions or assumptions.
3. Evidence line: base SHA, source HEAD, candidate tree SHA (delivery-grade reviews only), and confirmation that every task path/state was covered.
4. Brief test/validation notes.

A fix after review invalidates the verdict only for the files it touches and what they can affect; re-run this skill scoped to that subset rather than the whole review.

## Reference

Read `references/review-checklist.md` for a deeper pass on gameplay, editor tooling, UI, serialization, and validation risks.

---
name: unity-codebase-audit
description: Read-only Unity codebase risk audit that reports issues across code quality, overengineering, bugs, vulnerabilities, security posture, silent fallbacks, runtime Unity object/field authoring, rollback save/GGPO readiness, and strict determinism. Use when the user asks to analyze a whole project, module, block, or file for errors/risks without changing code, to run subagents/reviewers by audit area or file, or to write a separate audit report instead of implementing fixes.
metadata:
  berdBundled: true
---

In Distill, Distill starts child agents from the Agents catalog. Do not spawn chats yourself. Load Distill skills by name (unity-implement, planning, grill) instead of kit `$skill` syntax.


# Unity Codebase Audit

## Overview

Perform an evidence-based, read-only audit of a Unity project or module. The output is a single Markdown report with concrete findings, file/line evidence, confidence, and recommended follow-up; do not fix issues during this skill.

## Hard Boundaries

- Do not edit production code, tests, scenes, prefabs, assets, `.meta` files, packages, or `ProjectSettings`.
- Do not run formatters, migrations, asset importers, Unity menu actions, PlayMode, or editor operations that can mutate project state.
- Read-only shell commands and source scans are allowed. Validation commands are allowed only when they are known not to rewrite assets; otherwise list them as recommended follow-up.
- Write only the requested report. Default path: `.agents/plans/unity-codebase-audit-YYYY-MM-DD.md`. If `.agents/plans/.gitignore` is missing, create it with `*` and `!.gitignore` before writing the report.
- If the user provides a report path, use it unless it would place working audit notes under `Assets/`, `Packages/`, `ProjectSettings/`, or another production tree. Ask before using a risky path.
- Do not commit, push, delete, rename, or revert files.

## Workflow

1. **Orient**: read `ProjectSettings/ProjectVersion.txt`, `Packages/manifest.json`, `AGENTS.md`, `.agents/ARCHITECTURE.md`, `.agents/CODE_STYLE.md`, `.agents/DEPENDENCIES.md`, `.agents/learnings.md` when present, relevant module docs, asmdefs, and nearby tests.
2. **Inventory**: use `rg --files` to list code/config/content roots. Prioritize `Assets/**/*.cs`, asmdefs, `Packages/manifest.json`, `ProjectSettings` files that affect runtime behavior, `StreamingAssets`, save/mod/network/auth code, and tests.
3. **Scope control**: if the project is too large for full proof, audit by risk-ranked modules and explicitly record what was not inspected. Never imply full coverage for files that were only sampled.
4. **Delegate when possible**: use available subagent/multi-agent tools for independent read-only passes. If no subagent tool is available, perform the same passes sequentially and say so in the report.
5. **Consolidate**: deduplicate findings, verify evidence yourself, resolve contradictions, and downgrade anything unproven to "Needs verification".
6. **Report**: write the Markdown report, then respond with the path, finding counts by severity/category, and any unverified gaps.

## Subagent Plan

When subagents are available, start only as many as the scope justifies:

- For a single module or smaller scope, run one sequential pass over all lanes with no subagents.
- Fan out one subagent per audit lens only for whole-project audits: code quality, overengineering, bugs, vulnerabilities, security check, silent fallbacks, Unity runtime authoring, rollback save/GGPO readiness, strict determinism.
- One reviewer per module/block/file only for high-risk or user-named areas, especially save data, networking, deterministic simulation, input, mod/content loading, auth, external file IO, or build/runtime configuration.
- Batch low-risk files by module instead of spawning one agent per file.
- Give every subagent the same read-only boundary, exact scope, audit lens, and output schema. Require file/line evidence and forbid fixes.
- The parent agent owns the final report; do not paste unverified subagent output directly into it.

## Audit Lenses

### Code Quality

Check project conventions, ownership boundaries, Unity lifecycle use, public API shape, duplication that must evolve together, allocation-sensitive hot paths, dead code, testability, asmdef boundaries, and divergence from `.agents/CODE_STYLE.md` or `.agents/ARCHITECTURE.md`. Also flag comment and documentation bloat: comments that restate code or narrate a past change, unrequested generated docs, changelog prose inside living docs, and watery sections that repeat the code in prose - each is a finding with a deletion as the proposed fix.

### Overengineering

Flag one-implementation interfaces, speculative facades/registries/factories, public APIs with one internal caller, decorative patterns, compatibility wrappers without an owner/removal condition, and new managers/services/event buses where existing prefab composition, serialized references, or project extension points are enough.

### Bugs

Look for concrete behavioral defects: null/lifetime errors, event leaks, coroutine/async cancellation mistakes, `Update`/`FixedUpdate` misuse, serialization breakage, save migration issues, asset reference hazards, race conditions, invalid defaults, exception paths, stale caches, and missing regression tests.

### Silent Fallbacks

Flag broad catches, null-swallowing, default asset/config substitution, empty IDs as failure markers, best-effort no-ops, scene-wide searches, and runtime repair paths that hide broken authoring, wiring, migrations, or external operations. In this project silent fallbacks are forbidden outright: flag every one. There is no documented-fallback exemption.

### Unity Runtime Authoring

Flag runtime creation or configuration of GameObjects, components, UI layouts, serialized fields, materials, ScriptableObject-like data, tags/layers, or prefab hierarchies when the same stable structure could be authored once in a scene, prefab, or asset. Runtime `Instantiate` is acceptable for existing prefabs, pooled views, spawned gameplay objects, dynamic content, or data-driven rows; raw `new GameObject`, `AddComponent`, repeated `GetComponent`, `Find*`, Resources loads, or default-value wiring need a specific runtime variability reason.

### Vulnerabilities

Treat player input, save files, mod files, network messages, remote service responses, and content in `StreamingAssets` as untrusted. Check path traversal, unsafe deserialization, injection into file paths/commands/URLs, trust in client-owned state, weak validation, secret exposure, unsafe reflection/dynamic loading, and data tampering paths.

### Security Check

Run a posture checklist: secrets in repository text, sensitive data in logs, package/source provenance, dependency and package-manager risks, auth/session handling, platform storage permissions, external service keys, editor-only code in runtime, and build/runtime configuration that weakens security.

### Rollback Save / GGPO Readiness

Assess whether gameplay state can be saved, replayed, rolled back, and restored deterministically. Check fixed-tick input commands, frame indexing, snapshot boundaries, state ownership, save versioning/migrations, atomic writes, replayable command streams, presentation/audio/VFX separation from authority, and whether Unity physics or scene objects are used as authoritative rollback state.

### Strict Determinism

Find render-frame, wall-clock, platform, and ordering dependencies in gameplay-critical paths: `Time.deltaTime` authority, `DateTime`/timers, static or unseeded random state, unordered `Dictionary`/`HashSet` iteration, floating-point/platform drift risk, coroutines/async deciding simulation outcomes, Unity physics side effects, animation sampling authority, non-stable sorting, and IO/network arrival order feeding simulation.

## Evidence Standard

- Every finding needs `file:line`, the relevant code path or asset/config path, an explanation of actual risk, and why the project contract or runtime behavior makes it a problem.
- Use severities: `P0` data loss/security exploit/build break, `P1` likely user-facing or rollback/determinism blocker, `P2` important maintainability/regression risk, `P3` follow-up.
- Use confidence: `High` proven from source, `Medium` strongly indicated but needs runtime confirmation, `Low` plausible and listed only under "Needs verification".
- Do not report generic best-practice preferences. Report only defects, contract violations, or risks with project-specific impact.
- If a finding depends on a product decision, mark it as an open question instead of prescribing behavior.

## Report Format

Write a Markdown report with this structure:

```markdown
# Unity Codebase Audit - <scope> - YYYY-MM-DD

## Scope
- Requested scope:
- Report path:
- Project version:
- Packages/config inspected:
- Subagents used:
- Coverage limits:

## Summary
| Severity | Count |
| --- | ---: |

| Category | Count |
| --- | ---: |

## Detailed Findings
### <ID> <summary>
- Severity:
- Confidence:
- Location:
- Evidence:
- Proposed fix:

## Rollback Save / GGPO Readiness
(include only if in audit scope)
- Verdict:
- Blockers:
- Gaps:

## Strict Determinism
(include only if in audit scope)
- Verdict:
- Blockers:
- Gaps:

## Security Check
(include only if in audit scope)
- Secrets scan:
- Untrusted input/data paths:
- Dependency/package concerns:
- Logging/storage concerns:

## Needs Verification

## Not Inspected

## Recommended Next Actions
```

---
name: unity-validate
description: Choose and run focused validation for Unity projects safely. Use when verifying Unity or C# changes, compiling scripts, running targeted EditMode or PlayMode tests, checking logs, validating asmdef changes, confirming package changes, or reporting what remains untested when Unity cannot run.
metadata:
  berdBundled: true
---

In Distill, Distill starts child agents from the Agents catalog. Do not spawn chats yourself. Load Distill skills by name (unity-implement, planning, grill) instead of kit `$skill` syntax.


# Unity Validate Project

## Overview

Select the cheapest validation that proves the changed behavior while protecting the project from wrong-editor upgrades, broad test runs, and unnoticed import churn. Default role: `unity-test-runner`.

## Workflow

1. Read `ProjectSettings/ProjectVersion.txt` and record the exact editor version.
2. Discover project-provided validation, test assemblies, nearby fixtures, CI scripts, and Unity MCP availability.
3. For docs or agent-config-only changes, use static validation and do not open Unity.
4. Before launching the project, confirm the configured editor's `-version` matches `ProjectVersion.txt`.
5. Choose the smallest meaningful compile/test target. Use a fixture, namespace, test, category, or MCP group filter; do not run a whole test platform while calling it targeted.
6. Keep run logs.
7. Inspect exit code, result XML, logs, and Unity console evidence.
8. After the run, check `git status --porcelain` for unexpected asset/settings churn and report any as a blocker.
9. Run `.agents/scripts/check-unity-meta.ps1` when assets or `.meta` files changed.
10. Report exact commands run, results, and unverified gaps.

## Validation Ladder

Use the first level that proves the task:

1. Static schema, syntax, mirror, or source inspection for docs/config-only changes.
2. Supported non-Unity checks only when the repository defines them.
3. Exact-version Unity batchmode compile for script compatibility.
4. Filtered EditMode tests for pure logic, editor tooling, serialization utilities, and asset processors.
5. Filtered PlayMode tests for lifecycle, physics, input, UI, scenes, and gameplay.
6. Focused Unity MCP/editor verification for scene or prefab behavior without adequate automated coverage.
7. Broader suites only when the task scope or release gate explicitly requires them.

## Guardrails

- Do not claim Unity compilation passed unless Unity compiled the project or the console was checked after recompilation.
- Do not treat generated IDE projects or `dotnet build` as Unity compilation.
- Do not launch a different editor version and let it migrate the project.
- Never use `-quit` with `-runTests`.
- Do not add `-accept-apiupdate` unless an API update is explicitly approved.
- Do not run full PlayMode/EditMode suites by default.
- Do not revert or clean unexpected Unity mutations; preserve them and report the blocker.
- Reuse prior evidence only while its editor version and git tree SHA both match the current tree.

## Reference

Read `references/validation-commands.md` for guarded PowerShell templates and evidence handling.

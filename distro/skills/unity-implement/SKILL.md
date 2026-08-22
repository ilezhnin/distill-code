---
name: unity-implement
description: Implement or refactor Unity C# code safely. Use when modifying .cs files in Unity projects, including MonoBehaviours, ScriptableObjects, editor scripts, asmdef-scoped code, gameplay systems, UI controllers, tests, serialization-sensitive fields, coroutines, async flows, or performance-sensitive Update loops.
metadata:
  berdBundled: true
---

In Distill, Distill starts child agents from the Agents catalog. Do not spawn chats yourself. Load Distill skills by name (unity-implement, planning, grill) instead of kit `$skill` syntax.


# Unity Implement C#

## Overview

Make narrow Unity C# changes that respect Unity serialization, assembly boundaries, lifecycle rules, and project validation constraints.

## Workflow

1. Orient first if the relevant assembly, scene, prefab, or validation path is unclear.
2. Read `.agents/ARCHITECTURE.md` and `.agents/CODE_STYLE.md` (the kit contracts) before any structural, folder, subsystem, or namespace change, plus a project-overlay `ARCHITECTURE.md`/`CODE_STYLE.md` at the repo root when present; these override generic habits, and structural changes (folder layout, subsystem shape, usings) must follow them.
3. Inspect nearby code, asmdefs, tests, and serialized usages before editing public or `[SerializeField]` members.
4. Keep edits small and local. Follow existing architecture instead of adding a new pattern.
5. Preserve `.meta` files and GUIDs. Do not move or rename assets unless the task requires it.
6. Avoid adding packages, assets, or project settings changes without a clear need. Update `DEPENDENCIES.md` (when the project keeps one) in the same change as any package change.
7. Add or update focused tests when the project already has a nearby EditMode, PlayMode, or pure C# test pattern.
8. Run the cheapest meaningful validation. If Unity cannot be run, state exactly what was checked and what remains unverified.
9. Before finishing, re-check touched structure and usings against AGENTS.md Script Organization and .agents/CODE_STYLE.md.

## Unity C# Rules

- One file - one entity, no exceptions: every class, struct, interface, enum, record, and delegate gets its own file named after it. Nested types are forbidden, including private ones - extract them.
- Prefer `[SerializeField] private` over new public fields unless existing API requires public access.
- When renaming serialized fields that may already exist in scenes, prefabs, or assets, use `UnityEngine.Serialization.FormerlySerializedAs`.
- Keep `Editor` code out of runtime assemblies and runtime code out of `Editor` folders.
- Respect asmdef dependencies. Do not create circular assembly references.
- Avoid allocations in `Update`, `FixedUpdate`, hot input loops, and frequently called UI refresh paths.
- Do not call UnityEngine APIs from background threads unless the project already uses a safe dispatcher pattern.
- Match existing async style: coroutine, Task, event bus, or custom scheduler.
- Handle disabled domain reload and object lifetime when subscribing to events or static state.
- Prefer project-specific service locators, DI containers, save systems, and logging wrappers over new globals.
- Build UI and hierarchies in scenes/prefabs; code wires refs, data, and state. Do not assemble layouts from raw GameObjects in code without a named reason.
- Grow the codebase economically: check for an existing helper, extension point, or pattern before writing new code. No abstractions for single-use code (SRP and KISS over ceremony).

## Unity-Native Minimalism

The cheapest correct implementation is usually an asset edit, not code:

- Wire references once as `[SerializeField]` in the scene/prefab. Never resolve them at runtime
  via `Find`, tag/name lookup, `GetComponentInChildren` chains, or `Resources.Load` when a
  serialized reference works. A missing reference fails loud; it is never searched for.
- Author values in the asset (prefab, scene, ScriptableObject, JSON) when an authoring surface
  already exists; do not hardcode constants plus branches in code to avoid a one-time asset edit.
- No interface, factory, or event bus with a single implementation/subscriber - call the concrete
  type; add the seam when the second implementation actually arrives.
- No fallbacks of any kind (standing project order): no substituted defaults on error paths, no
  catch-and-continue, no last-known-good. Fail loud at the failure point.
- Comment and doc budget: comments state only non-obvious constraints; never narrate what the next
  line does or why the change is correct. Do not produce documentation unless the task or an
  existing living doc requires it, and write it dense - no filler, no restating code in prose.

## Rationalizations To Reject

- "Too simple to test" - simple code with serialized data or lifecycle coupling still breaks scenes; run or verify the changed path.
- "It compiles, that is enough" - Unity compiles broken lifecycle wiring happily; run or test the changed path.
- "I will clean up this adjacent code while here" - unrequested churn hides the real diff.
- "The API surely works like I remember" - verify version-specific Unity APIs against the project's packages or current docs before relying on them.
- "More than ~100 lines written without any check" is a red flag - stop and validate before continuing.

## Reference

Read `references/unity-csharp-patterns.md` before changing serialization, lifecycle, async, editor/runtime boundaries, or performance-sensitive code.

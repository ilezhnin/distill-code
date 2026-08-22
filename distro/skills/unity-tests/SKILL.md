---
name: unity-tests
description: Bootstrap Unity test infrastructure and author meaningful EditMode/PlayMode tests limited to determinism/rollback, fail-loud contracts, content integrity, and real-bug regressions. Use when asked to add tests, set up Tests folders or test asmdefs, cover an untested MonoBehaviour or legacy system, or write a regression test for a bug fix.
metadata:
  berdBundled: true
---

In Distill, Distill starts child agents from the Agents catalog. Do not spawn chats yourself. Load Distill skills by name (unity-implement, planning, grill) instead of kit `$skill` syntax.


# Unity Author Tests

## Goal

Add tests limited to four categories: determinism/rollback, fail-loud contracts, content integrity, and real-bug regressions. No micro-pins, no per-parameter sweeps, no source-scan tests, no characterization farms. Match existing test infrastructure when it exists; bootstrap it correctly when it does not.

## Workflow

1. **Detect existing infrastructure first**
   - Look for `Tests/` folders, `*Tests*.asmdef`, `com.unity.test-framework` in `Packages/manifest.json`, and CI test steps.
   - If tests exist, match their layout, naming, asmdef pattern, and assertion style exactly. Do not introduce a second convention.
   - If the assembly layout is unclear, run unity-orient first.

2. **Bootstrap when absent**
   - This project keeps tests in `<Module>/Tests/Editor` inside `Assembly-CSharp-Editor`; never introduce game-code asmdefs.

3. **Choose the mode**
   - EditMode: pure logic, damage/economy/math calculations, serialization utilities, save migration, editor tooling. Fast, no scene, no frames.
   - PlayMode: MonoBehaviour lifecycle, scene loading, physics, input, UI behavior, coroutine/async timing. Use `[UnityTest]` returning `IEnumerator` when frames must pass.

4. **Make untestable code testable (humble object)**
   - Extract pure logic from a MonoBehaviour into a plain C# class the MonoBehaviour delegates to; test the plain class in EditMode.
   - Do not rename or retype `[SerializeField]` fields during the extraction. Scenes and prefabs must deserialize unchanged.

5. **Prove bug fixes**
   - Write the regression test first, run it, and confirm it fails for the reported reason. Apply the fix. Confirm the test passes.
   - A regression test that never failed proves nothing.

6. **Run and report honestly**
   - Run new tests via unity-validate paths: Unity MCP test runner, batchmode, or the project's own command.
   - If Unity cannot be run, state that tests were authored but not executed. Never claim tests ran or passed unless they did.

## Test Quality Rules

- Prefer real implementation > fake > stub > mock. Substitute only slow or nondeterministic boundaries (network, disk, clock); mocking everything makes tests assert their own wiring instead of behavior.
- Assert state and outcomes, not call sequences. Tests coupled to internal call order break on every refactor and catch nothing.
- DAMP over DRY: a test should read like a specification top to bottom. Duplicated setup beats a helper maze; extract helpers only for boilerplate irrelevant to the behavior.
- One behavior concept per test. Name tests after behavior (`Reload_WhenMagazineEmpty_RefillsFromReserve`), not after the method under test.
- Deterministic: no real time (control `Time.timeScale` or yield frames instead of wall-clock waits), no live network, no `Random` without an injected or fixed seed.
- Do not test engine behavior, trivial wiring, or Unity serialization itself. `[SerializeField]` round-tripping is Unity's contract; logic-free getters and forwarding calls need no test.

## Stop Conditions

Stop and ask before:

- Adding `com.unity.test-framework` or any other package to `Packages/manifest.json`.
- Creating or changing asmdefs in a way that moves existing code out of Assembly-CSharp or between assemblies.
- A humble-object extraction that would change the serialized data shape of any scene, prefab, or asset.
- Behavior that is unknown or disputed. Ask what correct behavior is instead of enshrining a bug in a test.

## Final Report

Report:

- Infrastructure: matched existing, or created (files, asmdef names, any manifest change surfaced for approval).
- Tests added: EditMode/PlayMode split, behaviors covered, and which of the four allowed categories each falls into.
- Bug fixes: regression test failed before the fix and passed after, with the actual runs.
- Execution: exactly which tests ran and how, or that tests were authored but not executed.
- Gaps: behavior that remains untested and why.

## Reference

Read `references/test-setup.md` for test asmdef JSON, folder layout, manifest/testables notes, minimal EditMode and PlayMode examples, and a humble-object before/after sketch.
